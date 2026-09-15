import { randomBytes } from 'crypto'
import mongoose from 'mongoose'
import { NextRequest, NextResponse } from 'next/server'
import { connectDB } from '@/lib/mongodb'
import { Applicant, Candidate, RecruitmentCycle, Round, Session, SessionMember } from '@/lib/models'
import { isObjectId, readJsonObject } from '@/lib/apiValidation'
import { consumeUserRateLimit } from '@/lib/rateLimit'
import { requireRole } from '@/lib/serverAuth'
import {
  MAX_INTERVIEW_CSV_BYTES,
  mergeInterviewCandidates,
  normalizeInterviewName,
  parseInterviewCsv,
  type ParsedInterviewCandidate,
} from '@/lib/interviewImport'

type ResolutionValue = string | 'exclude'

type EligibleApplicant = {
  id: string
  name: string
  normalizedNames: string[]
}

class InterviewImportRejected extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'InterviewImportRejected'
  }
}

function parseResolutions(value: unknown) {
  if (value === undefined) return new Map<string, ResolutionValue>()
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InterviewImportRejected('resolutions must be an object.', 400)
  }
  const resolutions = new Map<string, ResolutionValue>()
  for (const [sourceName, resolution] of Object.entries(value)) {
    if (resolution !== 'exclude' && (typeof resolution !== 'string' || !isObjectId(resolution))) {
      throw new InterviewImportRejected(`Invalid resolution for ${sourceName}.`, 400)
    }
    resolutions.set(normalizeInterviewName(sourceName), resolution)
  }
  return resolutions
}

async function getEligibleApplicants(round: { _id: mongoose.Types.ObjectId; cycle_id: mongoose.Types.ObjectId; order_index: number; role: string | null }) {
  if (!round.role) throw new InterviewImportRejected('The interview round must have a Curriculum or Developer role.', 409)
  const priorRound = await Round.findOne({
    cycle_id: round.cycle_id,
    order_index: mongoose.trusted({ $lt: round.order_index }),
    role: mongoose.trusted({ $in: [round.role, null] }),
  }).sort({ order_index: -1 }).select('_id').lean()
  if (!priorRound) throw new InterviewImportRejected('No prior recruitment round was found.', 409)

  const priorSessions = await Session.find({ round_id: priorRound._id, role: round.role }).select('_id').lean()
  const acceptedCandidates = priorSessions.length
    ? await Candidate.find({
        session_id: mongoose.trusted({ $in: priorSessions.map(session => session._id) }),
        status: 'accepted',
        applicant_id: mongoose.trusted({ $ne: null }),
      }).select('applicant_id name').lean()
    : []
  const applicantIds = acceptedCandidates.flatMap(candidate => candidate.applicant_id ? [candidate.applicant_id] : [])
  const applicants = applicantIds.length
    ? await Applicant.find({ _id: mongoose.trusted({ $in: applicantIds }), cycle_id: round.cycle_id })
        .select('first_name last_name')
        .lean()
    : []
  const candidateNames = new Map<string, string[]>()
  for (const candidate of acceptedCandidates) {
    if (!candidate.applicant_id) continue
    const id = candidate.applicant_id.toString()
    candidateNames.set(id, [...(candidateNames.get(id) ?? []), candidate.name])
  }
  return applicants.map(applicant => {
    const id = applicant._id.toString()
    const name = `${applicant.first_name} ${applicant.last_name}`.trim()
    return {
      id,
      name,
      normalizedNames: [...new Set([name, ...(candidateNames.get(id) ?? [])].map(normalizeInterviewName))],
    }
  }) satisfies EligibleApplicant[]
}

function resolveCandidates(
  parsedCandidates: ParsedInterviewCandidate[],
  eligibleApplicants: EligibleApplicant[],
  resolutions: Map<string, ResolutionValue>,
) {
  const byName = new Map<string, EligibleApplicant[]>()
  const byId = new Map(eligibleApplicants.map(applicant => [applicant.id, applicant]))
  for (const applicant of eligibleApplicants) {
    for (const name of applicant.normalizedNames) {
      byName.set(name, [...(byName.get(name) ?? []), applicant])
    }
  }

  const rows = parsedCandidates.map(candidate => {
    const key = normalizeInterviewName(candidate.source_name)
    const explicit = resolutions.get(key)
    if (explicit === 'exclude') return { candidate, status: 'excluded' as const, applicant: null }
    if (explicit) {
      const applicant = byId.get(explicit)
      if (!applicant) throw new InterviewImportRejected(`${candidate.source_name} was mapped to an ineligible applicant.`, 409)
      return { candidate, status: 'matched' as const, applicant }
    }
    const matches = [...new Map((byName.get(key) ?? []).map(applicant => [applicant.id, applicant])).values()]
    if (matches.length === 1) return { candidate, status: 'matched' as const, applicant: matches[0] }
    return { candidate, status: 'unresolved' as const, applicant: null }
  })

  return rows
}

function previewPayload(
  format: string,
  sourceRows: number,
  rows: ReturnType<typeof resolveCandidates>,
  eligibleApplicants: EligibleApplicant[],
) {
  return {
    format,
    source_rows: sourceRows,
    candidates: rows.map(row => ({
      source_name: row.candidate.source_name,
      interviewers: row.candidate.interviewers,
      overall_score: row.candidate.overall_score,
      records: row.candidate.records.length,
      status: row.status,
      applicant_id: row.applicant?.id ?? null,
      applicant_name: row.applicant?.name ?? null,
    })),
    eligible_applicants: eligibleApplicants.map(({ id, name }) => ({ id, name })),
  }
}

async function uniqueSessionId(dbSession: mongoose.ClientSession) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const id = randomBytes(4).toString('base64url').slice(0, 6).toUpperCase()
    if (!await Session.exists({ _id: id }).session(dbSession)) return id
  }
  throw new InterviewImportRejected('Unable to allocate a session ID. Try again.', 503)
}

export async function POST(req: NextRequest) {
  const auth = await requireRole('admin')
  if (auth instanceof NextResponse) return auth

  await connectDB()
  if (!await consumeUserRateLimit(auth.email, 'interview-import', 20, 60 * 60 * 1000)) {
    return NextResponse.json({ error: 'Too many import attempts. Try again later.' }, { status: 429 })
  }
  const parsedBody = await readJsonObject(req, MAX_INTERVIEW_CSV_BYTES + 100_000)
  if (!parsedBody.ok) return parsedBody.response
  const body = parsedBody.data
  const cycleId = typeof body.cycle_id === 'string' ? body.cycle_id : ''
  const roundId = typeof body.round_id === 'string' ? body.round_id : ''
  const csvText = typeof body.csv_text === 'string' ? body.csv_text : ''
  const action = body.action
  if (!isObjectId(cycleId) || !isObjectId(roundId)) {
    return NextResponse.json({ error: 'Valid cycle_id and round_id values are required.' }, { status: 400 })
  }
  if (action !== 'preview' && action !== 'commit') {
    return NextResponse.json({ error: 'action must be preview or commit.' }, { status: 400 })
  }
  if (!csvText.trim()) return NextResponse.json({ error: 'CSV text is required.' }, { status: 400 })
  if (Buffer.byteLength(csvText, 'utf8') > MAX_INTERVIEW_CSV_BYTES) {
    return NextResponse.json({ error: 'CSV exceeds the 2 MB limit.' }, { status: 413 })
  }

  try {
    const parsed = parseInterviewCsv(csvText)
    const round = await Round.findOne({ _id: roundId, cycle_id: cycleId, grading_type: 'interview' })
      .select('_id cycle_id order_index role status name')
      .lean()
    if (!round) throw new InterviewImportRejected('Interview round not found.', 404)
    const expectedRole = parsed.format === 'developer_fa26' ? 'developer' : 'curriculum'
    if (round.role !== expectedRole) {
      throw new InterviewImportRejected(`This CSV belongs to the ${expectedRole} interview round.`, 409)
    }
    const eligibleApplicants = await getEligibleApplicants(round)
    if (!eligibleApplicants.length) throw new InterviewImportRejected('No accepted applicants are available for this track.', 409)
    const resolutions = parseResolutions(body.resolutions)
    const resolved = resolveCandidates(parsed.candidates, eligibleApplicants, resolutions)
    const preview = previewPayload(parsed.format, parsed.source_rows, resolved, eligibleApplicants)
    if (action === 'preview') return NextResponse.json({ preview })

    const unresolved = resolved.filter(row => row.status === 'unresolved')
    if (unresolved.length) {
      return NextResponse.json({ error: 'Map or exclude every unresolved interviewee before importing.', preview }, { status: 422 })
    }
    const included = resolved.filter(row => row.status === 'matched' && row.applicant)
    if (!included.length) throw new InterviewImportRejected('At least one interviewee must be included.', 422)

    let createdSessionId = ''
    await mongoose.connection.transaction(async dbSession => {
      const cycle = await RecruitmentCycle.findOneAndUpdate(
        { _id: cycleId, status: 'active' },
        { $inc: { lifecycle_write_count: 1 } },
        { new: true, session: dbSession },
      ).select('_id').lean()
      if (!cycle) throw new InterviewImportRejected('The recruitment cycle is no longer active.', 409)
      const guardedRound = await Round.findOneAndUpdate(
        { _id: roundId, cycle_id: cycleId, grading_type: 'interview', role: expectedRole, status: mongoose.trusted({ $ne: 'ended' }) },
        { $set: { status: 'deliberating' }, $inc: { lifecycle_write_count: 1 } },
        { new: true, session: dbSession },
      ).select('_id name').lean()
      if (!guardedRound) throw new InterviewImportRejected('The interview round can no longer be imported.', 409)
      if (await Session.exists({ round_id: roundId, role: expectedRole, status: 'active' }).session(dbSession)) {
        throw new InterviewImportRejected('An active deliberation session already exists for this round.', 409)
      }

      createdSessionId = await uniqueSessionId(dbSession)
      await Session.create([{
        _id: createdSessionId,
        round_id: roundId,
        name: `${guardedRound.name} Deliberation`,
        status: 'active',
        created_by: auth.email,
        anonymous: false,
        role: expectedRole,
      }], { session: dbSession })
      await SessionMember.create([{
        session_id: createdSessionId,
        user_email: auth.email,
      }], { session: dbSession })

      const grouped = new Map<string, { applicant: EligibleApplicant; parsed: ParsedInterviewCandidate[] }>()
      for (const row of included) {
        const applicant = row.applicant!
        const group = grouped.get(applicant.id) ?? { applicant, parsed: [] }
        group.parsed.push(row.candidate)
        grouped.set(applicant.id, group)
      }
      let candidateNumber = 0
      await Candidate.insertMany([...grouped.values()].map(group => {
        const interview = mergeInterviewCandidates(group.parsed)
        candidateNumber++
        return {
          session_id: createdSessionId,
          applicant_id: group.applicant.id,
          name: group.applicant.name,
          status: 'pending',
          data: {
            score: interview.overall_score,
            candidate_number: candidateNumber,
            interview: {
              format: interview.format,
              interviewers: interview.interviewers,
              criterion_averages: interview.criterion_averages,
              overall_score: interview.overall_score,
              records: interview.records,
              source_names: interview.source_names,
            },
          },
        }
      }), { session: dbSession })
    })

    return NextResponse.json({ ok: true, session_id: createdSessionId, imported: included.length })
  } catch (error: unknown) {
    if (error instanceof InterviewImportRejected) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    const message = error instanceof Error ? error.message : 'Unable to import interview responses.'
    return NextResponse.json({ error: message }, { status: 422 })
  }
}
