import { NextRequest, NextResponse } from 'next/server'
import mongoose from 'mongoose'
import { connectDB } from '@/lib/mongodb'
import { Candidate, Session, SessionMember, Vote } from '@/lib/models'
import { requireRole } from '@/lib/serverAuth'
import { isSessionId, readJsonObject } from '@/lib/apiValidation'
import { consumeUserRateLimit } from '@/lib/rateLimit'

type ResetOutcome = 'reset' | 'missing' | 'forbidden' | 'ended'

export async function DELETE(req: NextRequest) {
  const auth = await requireRole('grader')
  if (auth instanceof NextResponse) return auth

  await connectDB()
  if (!await consumeUserRateLimit(auth.email, 'vote-reset', 10, 60_000)) {
    return NextResponse.json({ error: 'Too many reset attempts. Try again shortly.' }, { status: 429 })
  }

  const parsedBody = await readJsonObject(req)
  if (!parsedBody.ok) return parsedBody.response
  const { session_id } = parsedBody.data
  if (!isSessionId(session_id)) {
    return NextResponse.json({ error: 'A valid session_id is required.' }, { status: 400 })
  }

  let outcome: ResetOutcome = 'missing'
  let deletedCount = 0
  await mongoose.connection.transaction(async dbSession => {
    const sessionFilter: Record<string, unknown> = { _id: session_id, status: 'active' }
    if (auth.role !== 'admin') sessionFilter.created_by = auth.email

    const sessionGuard = await Session.findOneAndUpdate(
      sessionFilter,
      { $inc: { activity_write_count: 1 } },
      { new: true, session: dbSession },
    ).select('_id').lean()

    if (!sessionGuard) {
      const current = await Session.findById(session_id)
        .select('created_by status')
        .session(dbSession)
        .lean()
      if (!current) outcome = 'missing'
      else if (current.status !== 'active') outcome = 'ended'
      else outcome = 'forbidden'
      return
    }

    // Vote creation fences on the member row. Touching every member here
    // ensures a vote either lands before this reset and is deleted, or lands
    // afterward and remains as a new deliberate action.
    await SessionMember.updateMany(
      { session_id },
      { $inc: { activity_write_count: 1 } },
      { session: dbSession },
    )

    const candidates = await Candidate.find({ session_id }).select('_id').session(dbSession).lean()
    const candidateIds = candidates.map(candidate => candidate._id)
    if (candidateIds.length > 0) {
      const result = await Vote.deleteMany({
        candidate_id: mongoose.trusted({ $in: candidateIds }),
        vote_type: mongoose.trusted({ $in: ['vouch', 'anti_vouch'] }),
      }, { session: dbSession })
      deletedCount = result.deletedCount
    }
    outcome = 'reset'
  })

  if (outcome === 'missing') return NextResponse.json({ error: 'Session not found.' }, { status: 404 })
  if (outcome === 'forbidden') {
    return NextResponse.json({ error: 'Only the session creator or an admin can reset vouches.' }, { status: 403 })
  }
  if (outcome === 'ended') return NextResponse.json({ error: 'This session has ended.' }, { status: 409 })

  return NextResponse.json({ ok: true, deleted_count: deletedCount })
}
