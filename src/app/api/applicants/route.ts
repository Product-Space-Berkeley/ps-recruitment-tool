import { NextRequest, NextResponse } from 'next/server'
import mongoose from 'mongoose'
import { connectDB } from '@/lib/mongodb'
import { Applicant, EssayPrompt, EssayResponse, RecruitmentCycle } from '@/lib/models'
import { APPLICATIONS_LAUNCHED } from '@/lib/applicationStatus'
import { consumePublicRateLimit, consumeUserRateLimit } from '@/lib/rateLimit'
import { isNonEmptyString, isObjectId, isPlainRecord, normalizeHttpUrl, readJsonObject } from '@/lib/apiValidation'
import { normalizeBerkeleyEmail } from '@/lib/emailValidation'
import { requireApplicantAuth } from '@/lib/serverAuth'
import { validateResumePdf } from '@/lib/pdfValidation'

const MAX_REQUEST_BYTES = 4_300_000
const MAX_RESUME_BYTES = 3 * 1024 * 1024

const VALID_RACES = [
  'American Indian or Alaska Native',
  'Asian (including Indian subcontinent and Philippines origin)',
  'Black or African American',
  'White',
  'Hispanic or Latino',
  'Middle Eastern',
  'Native American or Other Pacific Islander',
  'Prefer not to answer',
]
const VALID_ROLES = ['Curriculum Student', 'Industry Developer']

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

  // Whitelist and validate all applicant fields
  const email = normalizeBerkeleyEmail(body.email)
  const first_name = typeof body.first_name === 'string' ? body.first_name.trim() : ''
  const last_name = typeof body.last_name === 'string' ? body.last_name.trim() : ''
  const phone = typeof body.phone === 'string' ? body.phone.trim() : ''
  const VALID_YEARS = ['Freshman', 'Sophomore', 'Junior', 'Senior']
  const year = typeof body.year === 'string' && VALID_YEARS.includes(body.year) ? body.year : ''
  const transfer = body.transfer === true
  const major = typeof body.major === 'string' ? body.major.trim() : ''
  const gender = typeof body.gender === 'string' ? body.gender.trim() : ''
  const race: string[] = Array.isArray(body.race)
    ? body.race.filter((r: unknown) => typeof r === 'string' && VALID_RACES.includes(r))
    : []
  const desired_roles = typeof body.desired_roles === 'string' ? body.desired_roles.trim() : ''
  const linkedin = normalizeHttpUrl(body.linkedin)
  const website = normalizeHttpUrl(body.website)
  const time_commitment = typeof body.time_commitment === 'string' ? body.time_commitment.trim() : ''
  const resume_base64 = typeof body.resume_base64 === 'string' ? body.resume_base64.trim() : null
  const cycle_id = String(body.cycle_id ?? '').trim()

  if (!email) {
    return NextResponse.json({ error: 'Email must be a @berkeley.edu address.' }, { status: 400 })
  }
  if (
    !isNonEmptyString(first_name, 100)
    || !isNonEmptyString(last_name, 100)
    || phone.length < 7
    || phone.length > 30
    || !year
    || !isNonEmptyString(major, 200)
    || race.length === 0
    || !isNonEmptyString(time_commitment, 3000)
    || !cycle_id
  ) {
    return NextResponse.json({ error: 'Missing required fields.' }, { status: 400 })
  }
  if (gender.length > 100) return NextResponse.json({ error: 'Gender response is too long.' }, { status: 400 })
  if (!VALID_ROLES.includes(desired_roles)) {
    return NextResponse.json({ error: 'Invalid role.' }, { status: 400 })
  }
  if ((body.linkedin && !linkedin) || (body.website && !website)) {
    return NextResponse.json({ error: 'LinkedIn and website links must be valid HTTP or HTTPS URLs.' }, { status: 400 })
  }
  if (!isObjectId(cycle_id)) {
    return NextResponse.json({ error: 'Invalid cycle.' }, { status: 400 })
  }
  if (!resume_base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(resume_base64)) {
    return NextResponse.json({ error: 'A valid PDF resume is required.' }, { status: 400 })
  }
  const resumeBytes = Buffer.from(resume_base64, 'base64')
  const canonicalBase64 = resumeBytes.toString('base64').replace(/=+$/, '')
  if (canonicalBase64 !== resume_base64.replace(/=+$/, '')) {
    return NextResponse.json({ error: 'The uploaded resume is not valid base64 data.' }, { status: 400 })
  }
  if (resumeBytes.length === 0 || resumeBytes.length > MAX_RESUME_BYTES) {
    return NextResponse.json({ error: 'Resume PDFs must be 3MB or smaller.' }, { status: 413 })
  }
  const pdfText = resumeBytes.toString('latin1')
  if (!/^%PDF-(?:1\.[0-7]|2\.0)/.test(pdfText) || !/%%EOF[\s\0]*$/.test(pdfText.slice(-2048))) {
    return NextResponse.json({ error: 'The uploaded resume must be a PDF.' }, { status: 400 })
  }
  const pdfValidation = await validateResumePdf(resumeBytes)
  if (!pdfValidation.ok) return NextResponse.json({ error: pdfValidation.error }, { status: 400 })

  const submittedEssays = Array.isArray(essays) ? essays.filter(isPlainRecord) : []
  const promptIds = submittedEssays.map(e => String(e.prompt_id ?? ''))
  if (submittedEssays.length !== (Array.isArray(essays) ? essays.length : 0) || promptIds.some(id => !isObjectId(id))) {
    return NextResponse.json({ error: 'Invalid essay prompt data.' }, { status: 400 })
  }
  const essayResponses = submittedEssays.map(essay => typeof essay.response === 'string' ? essay.response.trim() : '')
  if (essayResponses.some(response => response.length === 0 || response.length > 1500)) {
    return NextResponse.json({ error: 'Each essay response is required and must be 1,500 characters or fewer.' }, { status: 400 })
  }
  if (promptIds.length !== 3 || promptIds.length !== new Set(promptIds).size) {
    return NextResponse.json({ error: 'Invalid essay prompt data.' }, { status: 400 })
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
        .select('_id criterion1 criterion2')
        .session(session)
        .lean()
      const configuredPromptIds = new Set(configuredPrompts.map(prompt => prompt._id.toString()))
      if (
        configuredPrompts.length !== 3
        || configuredPrompts.some(prompt => !prompt.criterion1?.trim() || !prompt.criterion2?.trim())
        || promptIds.some(promptId => !configuredPromptIds.has(promptId))
      ) {
        throw new SubmissionRejected('Invalid essay prompt data.', 409)
      }

      const [applicant] = await Applicant.create([{
        cycle_id, first_name, last_name, email, phone, year, transfer, major, gender,
        race, desired_roles, linkedin, website, time_commitment, resume_base64,
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
