import { NextRequest, NextResponse } from 'next/server'
import mongoose from 'mongoose'
import { connectDB } from '@/lib/mongodb'
import { Applicant, EssayPrompt, EssayResponse, RecruitmentCycle } from '@/lib/models'
import { APPLICATIONS_LAUNCHED } from '@/lib/applicationStatus'
import { consumePublicRateLimit, consumeUserRateLimit } from '@/lib/rateLimit'
import { isNonEmptyString, isObjectId, isPlainRecord, readJsonObject } from '@/lib/apiValidation'
import {
  APPLICANT_YEARS, ETHNICITY_OPTIONS, MAX_AVAILABILITY_NOTE_LENGTH, MAX_PHOTO_BYTES, MAX_RACE_OTHER_LENGTH,
  MAX_RESUME_BYTES, MEETING_CONFIRMATION, PHOTO_TYPES, RACE_OPTIONS, RACE_OTHER_PREFIX, RETREAT_CONFIRMATION,
  essayLimitError,
} from '@/lib/applicationFields'
import { normalizeBerkeleyEmail } from '@/lib/emailValidation'
import { requireApplicantAuth } from '@/lib/serverAuth'
import { validateResumePdf } from '@/lib/pdfValidation'

// Resume (3MB) and photo (2MB) arrive base64-encoded, about 4/3 their size.
const MAX_REQUEST_BYTES = 7_500_000

type DecodedFile = { ok: true; bytes: Buffer } | { ok: false; error: string }

function decodeBase64File(value: unknown, label: string, maxBytes: number): DecodedFile {
  const encoded = typeof value === 'string' ? value.trim() : ''
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return { ok: false, error: `Upload your ${label}.` }
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
    return { ok: false, error: `Your ${label} didn't upload correctly. Choose the file again and resubmit.` }
  }
  if (bytes.length === 0 || bytes.length > maxBytes) {
    return { ok: false, error: `Your ${label} is ${(bytes.length / 1024 / 1024).toFixed(1)}MB, but the limit is ${maxBytes / 1024 / 1024}MB. Upload a smaller file.` }
  }
  return { ok: true, bytes }
}

function isImageOfType(bytes: Buffer, type: string): boolean {
  if (type === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (type === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  return false
}

// Either the exact confirmation text, or the applicant's explanation of a conflict.
function readAvailability(value: unknown, confirmation: string): string | null {
  if (typeof value !== 'string') return null
  const answer = value.trim()
  if (answer === confirmation) return answer
  return answer && answer.length <= MAX_AVAILABILITY_NOTE_LENGTH ? answer : null
}

function isValidRace(value: string): boolean {
  if (RACE_OPTIONS.includes(value)) return true
  const other = value.startsWith(RACE_OTHER_PREFIX) ? value.slice(RACE_OTHER_PREFIX.length).trim() : ''
  return other.length > 0 && other.length <= MAX_RACE_OTHER_LENGTH
}

class SubmissionRejected extends Error {
  constructor(
    readonly message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'SubmissionRejected'
  }
}

export async function POST(req: NextRequest) {
  if (!APPLICATIONS_LAUNCHED) {
    return NextResponse.json({ error: 'Applications are not open yet.' }, { status: 403 })
  }

  const applicantAuth = await requireApplicantAuth()
  if (applicantAuth instanceof NextResponse) return applicantAuth

  await connectDB()
  // Keep a generous IP ceiling for shared campus/NAT networks and a tighter
  // identity-bound ceiling now that every applicant has verified Google auth.
  if (!await consumePublicRateLimit(req, 'application-submit-ip', 200, 60 * 60 * 1000)) {
    return NextResponse.json(
      { error: 'Too many submission attempts. Please try again later.' },
      { status: 429, headers: { 'Retry-After': '3600' } },
    )
  }
  if (!await consumeUserRateLimit(applicantAuth.email, 'application-submit-user', 10, 60 * 60 * 1000)) {
    return NextResponse.json(
      { error: 'Too many submission attempts. Please try again later.' },
      { status: 429, headers: { 'Retry-After': '3600' } },
    )
  }

  const parsedBody = await readJsonObject(req, MAX_REQUEST_BYTES)
  if (!parsedBody.ok) return parsedBody.response
  const body = parsedBody.data
  const { essays } = body

  // Whitelist and validate all applicant fields. The application email is the
  // verified Google account itself, so applicants can't apply as someone else.
  const email = normalizeBerkeleyEmail(applicantAuth.email)
  const first_name = typeof body.first_name === 'string' ? body.first_name.trim() : ''
  const last_name = typeof body.last_name === 'string' ? body.last_name.trim() : ''
  const phone = typeof body.phone === 'string' ? body.phone.trim() : ''
  const year = typeof body.year === 'string' && APPLICANT_YEARS.includes(body.year) ? body.year : ''
  const major = typeof body.major === 'string' ? body.major.trim() : ''
  const previously_applied = typeof body.previously_applied === 'boolean' ? body.previously_applied : null
  const time_commitment = typeof body.time_commitment === 'string' ? body.time_commitment.trim() : ''
  const meeting_availability = readAvailability(body.meeting_availability, MEETING_CONFIRMATION)
  const retreat_availability = readAvailability(body.retreat_availability, RETREAT_CONFIRMATION)
  const additional_context = typeof body.additional_context === 'string' && body.additional_context.trim()
    ? body.additional_context.trim()
    : null
  const cycle_id = String(body.cycle_id ?? '').trim()

  // Self-identification answers are optional.
  const race: string[] = Array.isArray(body.race)
    ? [...new Set(body.race.filter((r: unknown): r is string => typeof r === 'string').map((r: string) => r.trim()))]
    : []
  const ethnicity = typeof body.ethnicity === 'string' && body.ethnicity ? body.ethnicity : null
  const transfer = typeof body.transfer === 'boolean' ? body.transfer : null

  if (!email) {
    return NextResponse.json(
      { error: 'Sign in with your @berkeley.edu Google account to apply. Reload the page to switch accounts.' },
      { status: 403 },
    )
  }
  // First problem wins; each message names the field and what to change.
  const problem = [
    [!isNonEmptyString(first_name, 100), 'Enter your first name (100 characters max).'],
    [!isNonEmptyString(last_name, 100), 'Enter your last name (100 characters max).'],
    [phone.length < 7 || phone.length > 30, 'Enter a valid phone number, including the area code.'],
    [body.undergrad_confirmed !== true, 'Confirm that you are a continuing UC Berkeley undergraduate. Product Space can only accept continuing UC Berkeley undergraduates.'],
    [!isNonEmptyString(major, 200), 'Enter your major(s) and any minor(s) (200 characters max).'],
    [!year, 'Select your year.'],
    [previously_applied === null, "Select whether you've applied to Product Space before."],
    [!isNonEmptyString(time_commitment, 3000), 'List your commitments this semester (3,000 characters max).'],
    [!meeting_availability, `Confirm the Thursday meeting time, or choose "Other" and explain your conflict (${MAX_AVAILABILITY_NOTE_LENGTH} characters max).`],
    [!retreat_availability, `Confirm the retreat dates, or choose "Other" and explain your conflict (${MAX_AVAILABILITY_NOTE_LENGTH} characters max).`],
    [body.hours_confirmed !== true, 'Confirm that you can dedicate at least 15 hours a week.'],
    [Boolean(additional_context && additional_context.length > 3000), 'Shorten your additional context to 3,000 characters or fewer.'],
    [race.some(r => !isValidRace(r)), `Check your race selection. If you chose "Other", describe it in ${MAX_RACE_OTHER_LENGTH} characters or fewer.`],
    [ethnicity !== null && !ETHNICITY_OPTIONS.includes(ethnicity), 'Choose an ethnicity from the list, or leave it blank.'],
    [!isObjectId(cycle_id), 'This application form is out of date. Reload the page and try again.'],
  ].find(([failed]) => failed)
  if (problem) return NextResponse.json({ error: problem[1] }, { status: 400 })

  const resume = decodeBase64File(body.resume_base64, 'resume (PDF)', MAX_RESUME_BYTES)
  if (!resume.ok) return NextResponse.json({ error: resume.error }, { status: 400 })
  const resumeBytes = resume.bytes
  const resume_base64 = resumeBytes.toString('base64')
  const pdfText = resumeBytes.toString('latin1')
  if (!/^%PDF-(?:1\.[0-7]|2\.0)/.test(pdfText) || !/%%EOF[\s\0]*$/.test(pdfText.slice(-2048))) {
    return NextResponse.json({ error: "Your resume file isn't a valid PDF. Export it as a PDF and upload it again." }, { status: 400 })
  }
  const pdfValidation = await validateResumePdf(resumeBytes)
  if (!pdfValidation.ok) return NextResponse.json({ error: pdfValidation.error }, { status: 400 })

  const photo_type = typeof body.photo_type === 'string' && (PHOTO_TYPES as readonly string[]).includes(body.photo_type)
    ? body.photo_type
    : null
  const photo = decodeBase64File(body.photo_base64, 'photo', MAX_PHOTO_BYTES)
  if (!photo.ok) return NextResponse.json({ error: photo.error }, { status: 400 })
  if (!photo_type || !isImageOfType(photo.bytes, photo_type)) {
    return NextResponse.json({ error: "Your photo isn't a valid JPG or PNG. Export it as a JPG and upload it again." }, { status: 400 })
  }
  const photo_base64 = photo.bytes.toString('base64')

  const submittedEssays = Array.isArray(essays) ? essays.filter(isPlainRecord) : []
  const promptIds = submittedEssays.map(e => String(e.prompt_id ?? ''))
  if (
    submittedEssays.length !== (Array.isArray(essays) ? essays.length : 0)
    || promptIds.some(id => !isObjectId(id))
    || promptIds.length !== new Set(promptIds).size
  ) {
    return NextResponse.json({ error: 'Invalid essay prompt data.' }, { status: 400 })
  }
  const essayResponses = submittedEssays.map(essay => typeof essay.response === 'string' ? essay.response.trim() : '')
  if (essayResponses.some(response => response.length === 0)) {
    return NextResponse.json({ error: 'Answer every written question before submitting.' }, { status: 400 })
  }

  let applicantId = ''
  const session = await mongoose.startSession()
  try {
    await session.withTransaction(async () => {
      // Touch the cycle in the same transaction as the application. Closing or
      // deleting the cycle, or changing its prompts, now creates a write
      // conflict instead of allowing a stale validation to commit afterward.
      const cycleGuard = await RecruitmentCycle.updateOne(
        {
          _id: cycle_id,
          status: 'active',
          accepting_applications: true,
          application_deadline: mongoose.trusted({ $gt: new Date() }),
        },
        { $inc: { submission_count: 1 } },
        { session },
      )
      if (cycleGuard.modifiedCount !== 1) {
        throw new SubmissionRejected('This cycle is not accepting applications.', 403)
      }

      const configuredPrompts = await EssayPrompt.find({ cycle_id })
        .select('_id word_limit question_number')
        .session(session)
        .lean()
      const wordLimits = new Map(configuredPrompts.map(prompt => [prompt._id.toString(), prompt.word_limit ?? null]))
      if (
        configuredPrompts.length !== promptIds.length
        || promptIds.some(promptId => !wordLimits.has(promptId))
      ) {
        throw new SubmissionRejected('The essay questions changed. Please reload the application.', 409)
      }
      const questionNumbers = new Map(configuredPrompts.map(prompt => [prompt._id.toString(), prompt.question_number]))
      for (const [index, promptId] of promptIds.entries()) {
        const limitError = essayLimitError(essayResponses[index], wordLimits.get(promptId))
        if (limitError) throw new SubmissionRejected(`Written question ${questionNumbers.get(promptId)}: ${limitError}`, 400)
      }

      const [applicant] = await Applicant.create([{
        cycle_id, first_name, last_name, email, phone, year, transfer, major, race, ethnicity,
        previously_applied, meeting_availability, retreat_availability, additional_context,
        time_commitment, resume_base64, photo_base64, photo_type,
        identity_provider: 'google',
        identity_verified_at: new Date(),
      }], { session })
      applicantId = applicant._id.toString()

      const rows = submittedEssays.map((essay, index) => ({
        applicant_id: applicant._id,
        prompt_id: String(essay.prompt_id),
        response: essayResponses[index],
      }))
      await EssayResponse.insertMany(rows, { session })
    })
  } catch (error: unknown) {
    if (error instanceof SubmissionRejected) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    if (typeof error === 'object' && error && 'code' in error && error.code === 11000) {
      return NextResponse.json({ error: 'An application with this email already exists for this cycle.' }, { status: 409 })
    }
    throw error
  } finally {
    await session.endSession()
  }

  return NextResponse.json({ id: applicantId }, { status: 201 })
}
