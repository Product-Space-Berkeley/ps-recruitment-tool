import { NextRequest, NextResponse } from 'next/server'
import mongoose from 'mongoose'
import { connectDB } from '@/lib/mongodb'
import { Candidate, Session } from '@/lib/models'
import { requireRole } from '@/lib/serverAuth'
import { isObjectId, isSessionId, readJsonObject } from '@/lib/apiValidation'

const VALID_STATUSES = ['pending', 'accepted', 'rejected', 'hold'] as const
const MAX_BULK_CANDIDATES = 500

export async function PATCH(req: NextRequest) {
  const auth = await requireRole('grader')
  if (auth instanceof NextResponse) return auth

  const parsedBody = await readJsonObject(req)
  if (!parsedBody.ok) return parsedBody.response

  const { session_id, candidate_ids, status } = parsedBody.data
  if (!isSessionId(session_id)) {
    return NextResponse.json({ error: 'A valid session_id is required.' }, { status: 400 })
  }
  if (typeof status !== 'string' || !VALID_STATUSES.includes(status as typeof VALID_STATUSES[number])) {
    return NextResponse.json({ error: 'Invalid candidate status.' }, { status: 400 })
  }
  if (!Array.isArray(candidate_ids) || candidate_ids.length < 1 || candidate_ids.length > MAX_BULK_CANDIDATES) {
    return NextResponse.json(
      { error: `Select between 1 and ${MAX_BULK_CANDIDATES} candidates.` },
      { status: 400 },
    )
  }

  const uniqueIds = [...new Set(candidate_ids)]
  if (uniqueIds.length !== candidate_ids.length || uniqueIds.some(id => typeof id !== 'string' || !isObjectId(id))) {
    return NextResponse.json({ error: 'candidate_ids must contain unique valid IDs.' }, { status: 400 })
  }

  await connectDB()

  let outcome: 'updated' | 'session-missing' | 'forbidden' | 'ended' | 'candidate-mismatch' = 'session-missing'
  await mongoose.connection.transaction(async dbSession => {
    outcome = 'session-missing'
    const sessionFilter: Record<string, unknown> = { _id: session_id, status: 'active' }
    if (auth.role !== 'admin') sessionFilter.created_by = auth.email

    const sessionGuard = await Session.findOneAndUpdate(
      sessionFilter,
      { $inc: { activity_write_count: 1 } },
      { new: true, session: dbSession },
    ).select('_id').lean()

    if (!sessionGuard) {
      const currentSession = await Session.findById(session_id)
        .select('created_by status')
        .session(dbSession)
        .lean()
      if (!currentSession) outcome = 'session-missing'
      else if (currentSession.status !== 'active') outcome = 'ended'
      else outcome = 'forbidden'
      return
    }

    const candidates = await Candidate.find({
      _id: mongoose.trusted({ $in: uniqueIds }),
      session_id,
    }).select('_id').session(dbSession).lean()

    if (candidates.length !== uniqueIds.length) {
      outcome = 'candidate-mismatch'
      return
    }

    await Candidate.updateMany(
      { _id: mongoose.trusted({ $in: uniqueIds }), session_id },
      { $set: { status }, $inc: { activity_write_count: 1 } },
      { session: dbSession },
    )
    outcome = 'updated'
  })

  if (outcome === 'session-missing') return NextResponse.json({ error: 'Session not found.' }, { status: 404 })
  if (outcome === 'forbidden') {
    return NextResponse.json({ error: 'Only the session creator can update decisions.' }, { status: 403 })
  }
  if (outcome === 'ended') return NextResponse.json({ error: 'This session has ended.' }, { status: 409 })
  if (outcome === 'candidate-mismatch') {
    return NextResponse.json({ error: 'One or more selected candidates are not in this session.' }, { status: 409 })
  }

  return NextResponse.json({ ok: true, updated_count: uniqueIds.length, status })
}
