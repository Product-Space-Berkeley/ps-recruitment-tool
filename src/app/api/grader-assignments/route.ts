import { NextRequest, NextResponse } from 'next/server'
import mongoose from 'mongoose'
import { connectDB } from '@/lib/mongodb'
import { Applicant, AuthorizedUser, GraderAssignment, Round } from '@/lib/models'
import { requireRole } from '@/lib/serverAuth'
import { isEmail, isObjectId, isPlainRecord, readJsonArray } from '@/lib/apiValidation'
import { consumeUserRateLimit } from '@/lib/rateLimit'

class AssignmentRejected extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'AssignmentRejected'
  }
}

export async function GET(req: NextRequest) {
  const auth = await requireRole('grader')
  if (auth instanceof NextResponse) return auth

  await connectDB()
  const { searchParams } = new URL(req.url)
  const round_id = searchParams.get('round_id') ?? undefined
  let grader_email = searchParams.get('grader_email') ?? undefined
  if (round_id && !isObjectId(round_id)) return NextResponse.json({ error: 'Invalid round_id.' }, { status: 400 })
  if (grader_email && !isEmail(grader_email)) return NextResponse.json({ error: 'Invalid grader_email.' }, { status: 400 })

  // Graders can only fetch their own assignments
  if (auth.role === 'grader' && grader_email && grader_email.toLowerCase() !== auth.email.toLowerCase()) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  if (auth.role === 'grader') grader_email = auth.email

  const filter: Record<string, unknown> = {}
  if (round_id) filter.round_id = round_id
  if (grader_email) filter.grader_email = grader_email.toLowerCase()

  if (auth.role === 'grader') {
    if (round_id) {
      const active = await Round.exists({ _id: round_id, status: 'grading' })
      if (!active) return NextResponse.json([])
    } else {
      const activeRounds = await Round.find({ status: 'grading' }).select('_id').lean()
      if (activeRounds.length === 0) return NextResponse.json([])
      filter.round_id = mongoose.trusted({ $in: activeRounds.map(round => round._id) })
    }
  }

  const assignments = await GraderAssignment.find(filter).lean()
  return NextResponse.json(assignments.map(a => ({
    ...a,
    id: a._id.toString(),
    round_id: a.round_id.toString(),
    applicant_id: a.applicant_id.toString(),
    _id: undefined,
  })))
}

export async function POST(req: NextRequest) {
  const auth = await requireRole('leadership')
  if (auth instanceof NextResponse) return auth

  await connectDB()
  if (!await consumeUserRateLimit(auth.email, 'grader-assignment-write', 30, 60_000)) {
    return NextResponse.json({ error: 'Too many assignment changes. Try again shortly.' }, { status: 429 })
  }
  const parsedBody = await readJsonArray(req, 2_000_000)
  if (!parsedBody.ok) return parsedBody.response
  if (parsedBody.data.length === 0 || parsedBody.data.length > 10_000 || parsedBody.data.some(row => !isPlainRecord(row))) {
    return NextResponse.json({ error: 'Expected between 1 and 10,000 assignment objects.' }, { status: 400 })
  }
  const rows = parsedBody.data as Record<string, unknown>[]
  if (rows.some(row => !isObjectId(row.round_id) || !isObjectId(row.applicant_id) || !isEmail(row.grader_email))) {
    return NextResponse.json({ error: 'One or more assignments are invalid.' }, { status: 400 })
  }

  const roundIds = [...new Set(rows.map(row => String(row.round_id)))]
  const applicantIds = [...new Set(rows.map(row => String(row.applicant_id)))]
  const graderEmails = [...new Set(rows.map(row => String(row.grader_email).trim().toLowerCase()))]
  const ops = rows.map(r => ({
    updateOne: {
      filter: { round_id: r.round_id, applicant_id: r.applicant_id, grader_email: String(r.grader_email).trim().toLowerCase() },
      update: { $setOnInsert: { assigned_at: new Date() } },
      upsert: true,
    },
  }))

  try {
    await mongoose.connection.transaction(async dbSession => {
      // Keep every parent check in the same snapshot as the assignment writes.
      // The guarded counter updates create write conflicts with concurrent round
      // closure/deletion and authorized-user mutation/deletion.
      const rounds = await Round.find({
        _id: mongoose.trusted({ $in: roundIds }),
        status: mongoose.trusted({ $in: ['pending', 'grading'] }),
      }).select('_id cycle_id').session(dbSession).lean()
      if (rounds.length !== roundIds.length) {
        throw new AssignmentRejected('Assignments can only be added to pending or active grading rounds.', 409)
      }

      const applicants = await Applicant.find({
        _id: mongoose.trusted({ $in: applicantIds }),
      }).select('_id cycle_id').session(dbSession).lean()
      const authorizedGraders = await AuthorizedUser.find({
        email: mongoose.trusted({ $in: graderEmails }),
      }).select('email').session(dbSession).lean()
      if (applicants.length !== applicantIds.length || authorizedGraders.length !== graderEmails.length) {
        throw new AssignmentRejected('Every assignment must reference an existing applicant and authorized grader.', 400)
      }

      const cycleByRound = new Map(rounds.map(round => [round._id.toString(), round.cycle_id.toString()]))
      const cycleByApplicant = new Map(applicants.map(applicant => [applicant._id.toString(), applicant.cycle_id.toString()]))
      if (rows.some(row => cycleByRound.get(String(row.round_id)) !== cycleByApplicant.get(String(row.applicant_id)))) {
        throw new AssignmentRejected('Applicants must belong to the same cycle as their grading round.', 400)
      }

      const roundGuard = await Round.updateMany(
        {
          _id: mongoose.trusted({ $in: roundIds }),
          status: mongoose.trusted({ $in: ['pending', 'grading'] }),
        },
        {
          $set: { status: 'grading' },
          $inc: { lifecycle_write_count: 1 },
        },
        { session: dbSession },
      )
      if (roundGuard.modifiedCount !== roundIds.length) {
        throw new AssignmentRejected('Assignments can only be added to pending or active grading rounds.', 409)
      }

      const graderGuard = await AuthorizedUser.updateMany(
        { email: mongoose.trusted({ $in: graderEmails }) },
        { $inc: { assignment_write_count: 1 } },
        { session: dbSession },
      )
      if (graderGuard.modifiedCount !== graderEmails.length) {
        throw new AssignmentRejected('Every assignment must reference an existing applicant and authorized grader.', 400)
      }

      await GraderAssignment.bulkWrite(ops, { session: dbSession })
    })
  } catch (error: unknown) {
    if (error instanceof AssignmentRejected) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    throw error
  }
  return NextResponse.json({ ok: true })
}
