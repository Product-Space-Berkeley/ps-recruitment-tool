import { after, NextRequest, NextResponse } from 'next/server'
import mongoose from 'mongoose'
import { connectDB } from '@/lib/mongodb'
import { Applicant, Candidate, RecruitmentCycle, Round, Session, SessionBan, SessionMember } from '@/lib/models'
import { syncBehavioral, type BehavioralSource } from '@/lib/behavioralSync'
import { requireRole } from '@/lib/serverAuth'
import { isNonEmptyString, isNullableObjectId, isPlainRecord, isSessionId, readJsonBody } from '@/lib/apiValidation'
import { consumeUserRateLimit } from '@/lib/rateLimit'

class CandidateImportRejected extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'CandidateImportRejected'
  }
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole('grader')
  if (auth instanceof NextResponse) return auth

  await connectDB()
  const { id } = await params
  if (!isSessionId(id)) return NextResponse.json({ error: 'Invalid session id.' }, { status: 400 })
  const session = await Session.findById(id).select('created_by round_id status').lean()
  if (!session) return NextResponse.json({ error: 'Session not found.' }, { status: 404 })
  const isCreator = session.created_by?.toLowerCase() === auth.email.toLowerCase()
  const [isMember, banned] = await Promise.all([
    SessionMember.exists({ session_id: id, user_email: auth.email }),
    SessionBan.exists({ session_id: id, email: auth.email }),
  ])
  if (banned) return NextResponse.json({ error: 'You have been removed from this session.' }, { status: 403 })
  if (!isCreator && !isMember) {
    return NextResponse.json({ error: 'Join this session to view candidates.' }, { status: 403 })
  }
  if (session.round_id && session.status === 'active') {
    // Return the saved snapshot first; Sheets must never block candidate reads.
    // syncBehavioral retains its shared database lease and 30-second throttle.
    after(async () => { try {
    const round = await Round.findById(session.round_id).select('cycle_id').lean()
    const cycle = round ? await RecruitmentCycle.findById(round.cycle_id).schemaLevelProjections(false).select('behavioral_source').lean() : null
    const source = cycle?.behavioral_source as BehavioralSource | null
    if (cycle && source?.rounds?.some(r => r.id === session.round_id?.toString())) {
      await syncBehavioral(cycle._id.toString()).catch(() => undefined)
    }
    } catch { /* Keep the last successful snapshot during upstream outages. */ } })
  }
  const candidates = await Candidate.find({ session_id: id }).sort({ created_at: 1 }).lean()
  const applicantIds = candidates
    .map(candidate => candidate.applicant_id)
    .filter((applicantId): applicantId is mongoose.Types.ObjectId => applicantId instanceof mongoose.Types.ObjectId)
  const applicants = applicantIds.length > 0
    ? await Applicant.find({ _id: mongoose.trusted({ $in: applicantIds }) }).select('_id gender year').lean()
    : []
  const genderByApplicantId = new Map(
    applicants.map(applicant => [applicant._id.toString(), applicant.gender ?? null]),
  )

  return NextResponse.json(candidates.map(c => ({
    ...c,
    id: c._id.toString(),
    applicant_id: c.applicant_id?.toString() ?? null,
    data: {
      ...(isPlainRecord(c.data) ? c.data : {}),
      'Class year': c.applicant_id
        ? applicants.find(a => a._id.toString() === c.applicant_id?.toString())?.year ?? 'Not provided'
        : (isPlainRecord(c.data) ? c.data['Class year'] : null) ?? 'Not provided',
      gender: c.applicant_id
        ? genderByApplicantId.get(c.applicant_id.toString()) ?? null
        : isPlainRecord(c.data) ? c.data.gender ?? null : null,
    },
    _id: undefined,
  })))
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole('leadership')
  if (auth instanceof NextResponse) return auth

  await connectDB()
  if (!await consumeUserRateLimit(auth.email, 'candidate-bulk-write', 30, 60_000)) {
    return NextResponse.json({ error: 'Too many candidate imports. Try again shortly.' }, { status: 429 })
  }
  const { id } = await params
  if (!isSessionId(id)) return NextResponse.json({ error: 'Invalid session id.' }, { status: 400 })
  const session = await Session.findById(id).select('created_by status round_id').lean()
  if (!session) return NextResponse.json({ error: 'Session not found.' }, { status: 404 })
  const isCreator = session.created_by?.toLowerCase() === auth.email.toLowerCase()
  if (!isCreator && auth.role !== 'admin') {
    return NextResponse.json({ error: 'Only the session creator can add candidates.' }, { status: 403 })
  }
  if (session.status !== 'active') {
    return NextResponse.json({ error: 'This session has ended.' }, { status: 409 })
  }

  const parsedBody = await readJsonBody(req, 5_000_000)
  if (!parsedBody.ok) return parsedBody.response
  const body = parsedBody.data
  const rows = Array.isArray(body) ? body : [body]
  if (rows.length === 0 || rows.length > 500 || rows.some(row => !isPlainRecord(row))) {
    return NextResponse.json({ error: 'Expected between 1 and 500 candidate objects.' }, { status: 400 })
  }

  const validStatuses = ['pending', 'accepted', 'rejected', 'hold']
  const candidates = rows.map(row => {
    const record = row as Record<string, unknown>
    const applicantId = record.applicant_id ?? null
    if (
      !isNonEmptyString(record.name, 200)
      || !isNullableObjectId(applicantId)
      || (record.status !== undefined && (typeof record.status !== 'string' || !validStatuses.includes(record.status)))
      || (record.data !== undefined && !isPlainRecord(record.data))
    ) {
      return null
    }
    return {
      session_id: id,
      applicant_id: applicantId,
      name: record.name.trim(),
      status: typeof record.status === 'string' ? record.status : 'pending',
      data: isPlainRecord(record.data) ? record.data : {},
    }
  })
  if (candidates.some(candidate => candidate === null)) {
    return NextResponse.json({ error: 'One or more candidate rows are invalid.' }, { status: 400 })
  }

  const validatedCandidates = candidates.filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
  const applicantIds = [...new Set(validatedCandidates
    .map(candidate => candidate.applicant_id)
    .filter((applicantId): applicantId is string => typeof applicantId === 'string'))]
  try {
    let responseRows: Array<Record<string, unknown>> = []
    await mongoose.connection.transaction(async dbSession => {
      const sessionFilter: Record<string, unknown> = { _id: id, status: 'active' }
      if (auth.role !== 'admin') sessionFilter.created_by = auth.email

      // Touch the session so ending, deleting, or moving it to another round
      // conflicts with this import instead of allowing stale candidates in.
      const guardedSession = await Session.findOneAndUpdate(
        sessionFilter,
        { $inc: { candidate_import_count: 1 } },
        { new: true, session: dbSession },
      ).select('created_by status round_id').lean()

      if (!guardedSession) {
        const current = await Session.findById(id).select('created_by status').session(dbSession).lean()
        if (!current) throw new CandidateImportRejected('Session not found.', 404)
        if (current.status !== 'active') throw new CandidateImportRejected('This session has ended.', 409)
        throw new CandidateImportRejected('Only the session creator can add candidates.', 403)
      }

      if (applicantIds.length > 0) {
        if (!guardedSession.round_id) {
          throw new CandidateImportRejected('Applicant-linked candidates require a cycle-scoped round.', 409)
        }
        const round = await Round.findById(guardedSession.round_id)
          .select('cycle_id')
          .session(dbSession)
          .lean()
        const applicants = await Applicant.find({ _id: mongoose.trusted({ $in: applicantIds }) })
          .select('_id cycle_id')
          .session(dbSession)
          .lean()
        if (!round || applicants.length !== applicantIds.length
          || applicants.some(applicant => applicant.cycle_id.toString() !== round.cycle_id.toString())) {
          throw new CandidateImportRejected('Every applicant must exist in this session’s recruitment cycle.', 400)
        }
      }

      const created = await Candidate.insertMany(validatedCandidates, { session: dbSession })
      responseRows = created.map(candidate => ({
        ...candidate.toObject(),
        id: candidate._id.toString(),
        _id: undefined,
      }))
    })
    return NextResponse.json(responseRows, { status: 201 })
  } catch (error: unknown) {
    if (error instanceof CandidateImportRejected) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    if (typeof error === 'object' && error && 'code' in error && error.code === 11000) {
      return NextResponse.json({ error: 'One or more applicants are already in this session.' }, { status: 409 })
    }
    console.error('Failed to import candidates:', error)
    return NextResponse.json({ error: 'Unable to import candidates.' }, { status: 500 })
  }
}
