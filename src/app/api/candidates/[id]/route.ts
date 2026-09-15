import { NextRequest, NextResponse } from 'next/server'
import mongoose from 'mongoose'
import { connectDB } from '@/lib/mongodb'
import { Candidate, Vote, CandidateNote, Session, SessionMember } from '@/lib/models'
import { requireRole } from '@/lib/serverAuth'
import { isNonEmptyString, isObjectId, isPlainRecord, readJsonObject } from '@/lib/apiValidation'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole('grader')
  if (auth instanceof NextResponse) return auth

  await connectDB()
  const { id } = await params
  if (!isObjectId(id)) return NextResponse.json({ error: 'Invalid candidate id.' }, { status: 400 })
  const parsedBody = await readJsonObject(req)
  if (!parsedBody.ok) return parsedBody.response
  const body = parsedBody.data

  const allowed: Record<string, unknown> = {}
  const validStatuses = ['pending', 'accepted', 'rejected', 'hold']
  if ('name' in body) {
    if (!isNonEmptyString(body.name, 200)) return NextResponse.json({ error: 'Invalid name.' }, { status: 400 })
    allowed.name = body.name.trim()
  }
  if ('status' in body) {
    if (typeof body.status !== 'string' || !validStatuses.includes(body.status)) {
      return NextResponse.json({ error: 'Invalid candidate status.' }, { status: 400 })
    }
    allowed.status = body.status
  }
  if ('data' in body) {
    if (!isPlainRecord(body.data)) return NextResponse.json({ error: 'Candidate data must be an object.' }, { status: 400 })
    allowed.data = body.data
  }
  if (Object.keys(allowed).length === 0) {
    return NextResponse.json({ error: 'No valid updates supplied.' }, { status: 400 })
  }

  let outcome: 'updated' | 'candidate-missing' | 'session-missing' | 'forbidden' | 'ended' = 'candidate-missing'
  let updatedCandidate: Record<string, unknown> | null = null
  await mongoose.connection.transaction(async dbSession => {
    outcome = 'candidate-missing'
    const existing = await Candidate.findById(id).select('session_id').session(dbSession).lean()
    if (!existing) return

    const sessionFilter: Record<string, unknown> = { _id: existing.session_id, status: 'active' }
    if (auth.role !== 'admin') sessionFilter.created_by = auth.email
    const sessionGuard = await Session.findOneAndUpdate(
      sessionFilter,
      { $inc: { activity_write_count: 1 } },
      { new: true, session: dbSession },
    ).select('_id').lean()
    if (!sessionGuard) {
      const currentSession = await Session.findById(existing.session_id)
        .select('created_by status')
        .session(dbSession)
        .lean()
      if (!currentSession) outcome = 'session-missing'
      else if (currentSession.status !== 'active') outcome = 'ended'
      else outcome = 'forbidden'
      return
    }

    const candidate = await Candidate.findByIdAndUpdate(
      id,
      { $set: allowed, $inc: { activity_write_count: 1 } },
      { new: true, session: dbSession },
    ).lean()
    if (!candidate) return
    outcome = 'updated'
    updatedCandidate = candidate as unknown as Record<string, unknown>
  })
  if (outcome === 'candidate-missing') return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (outcome === 'session-missing') return NextResponse.json({ error: 'Session not found.' }, { status: 404 })
  if (outcome === 'forbidden') {
    return NextResponse.json({ error: 'Only the session creator can update decisions.' }, { status: 403 })
  }
  if (outcome === 'ended') return NextResponse.json({ error: 'This session has ended.' }, { status: 409 })
  const candidate = updatedCandidate!
  return NextResponse.json({ ...candidate, id: String(candidate._id), _id: undefined })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole('leadership')
  if (auth instanceof NextResponse) return auth

  await connectDB()
  const { id } = await params
  if (!isObjectId(id)) return NextResponse.json({ error: 'Invalid candidate id.' }, { status: 400 })
  let outcome: 'deleted' | 'candidate-missing' | 'session-missing' | 'forbidden' | 'ended' = 'candidate-missing'
  await mongoose.connection.transaction(async dbSession => {
    outcome = 'candidate-missing'
    const candidate = await Candidate.findById(id).select('session_id').session(dbSession).lean()
    if (!candidate) return
    const sessionFilter: Record<string, unknown> = { _id: candidate.session_id, status: 'active' }
    if (auth.role !== 'admin') sessionFilter.created_by = auth.email
    const sessionGuard = await Session.findOneAndUpdate(
      sessionFilter,
      { $inc: { activity_write_count: 1 } },
      { new: true, session: dbSession },
    ).select('_id').lean()
    if (!sessionGuard) {
      const sessionDoc = await Session.findById(candidate.session_id)
        .select('created_by status')
        .session(dbSession)
        .lean()
      if (!sessionDoc) outcome = 'session-missing'
      else if (sessionDoc.status !== 'active') outcome = 'ended'
      else outcome = 'forbidden'
      return
    }
    // Vote/note writes fence through their writer's membership row. Touch all
    // session members so deleting one candidate conflicts with every possible
    // in-flight child write without making every normal write contend on the
    // candidate document.
    await SessionMember.updateMany(
      { session_id: candidate.session_id },
      { $inc: { activity_write_count: 1 } },
      { session: dbSession },
    )
    outcome = 'deleted'
    await Vote.deleteMany({ candidate_id: id }, { session: dbSession })
    await CandidateNote.deleteMany({ candidate_id: id }, { session: dbSession })
    await Candidate.findByIdAndDelete(id, { session: dbSession })
  })
  if (outcome === 'candidate-missing') return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (outcome === 'session-missing') return NextResponse.json({ error: 'Session not found.' }, { status: 404 })
  if (outcome === 'forbidden') {
    return NextResponse.json({ error: 'Only the session creator can delete candidates.' }, { status: 403 })
  }
  if (outcome === 'ended') return NextResponse.json({ error: 'This session has ended.' }, { status: 409 })
  return NextResponse.json({ ok: true })
}
