import { NextRequest, NextResponse } from 'next/server'
import mongoose from 'mongoose'
import { connectDB } from '@/lib/mongodb'
import {
  RecruitmentCycle, Session, Candidate, Vote, CandidateNote,
  SessionMember, SessionBan, Round,
} from '@/lib/models'
import { requireRole } from '@/lib/serverAuth'
import { isNonEmptyString, isNullableObjectId, isSessionId, readJsonObject } from '@/lib/apiValidation'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole('grader')
  if (auth instanceof NextResponse) return auth

  await connectDB()
  const { id } = await params
  if (!isSessionId(id)) return NextResponse.json({ error: 'Invalid session id.' }, { status: 400 })
  const session = await Session.findById(id).lean()
  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Banned users can't open the session at all, and knowing a session code is
  // not enough until the authenticated user has joined it.
  const [banned, isMember] = await Promise.all([
    SessionBan.exists({ session_id: id, email: auth.email }),
    SessionMember.exists({ session_id: id, user_email: auth.email }),
  ])
  if (banned) {
    return NextResponse.json({ error: 'You have been removed from this session.' }, { status: 403 })
  }
  const isCreator = session.created_by?.toLowerCase() === auth.email.toLowerCase()
  if (!isCreator && !isMember) return NextResponse.json({ error: 'Join this session first.' }, { status: 403 })

  return NextResponse.json({ ...session, id: session._id, round_id: session.round_id?.toString() ?? null, _id: undefined })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole('leadership')
  if (auth instanceof NextResponse) return auth

  await connectDB()
  const { id } = await params
  if (!isSessionId(id)) return NextResponse.json({ error: 'Invalid session id.' }, { status: 400 })
  const parsedBody = await readJsonObject(req)
  if (!parsedBody.ok) return parsedBody.response
  const body = parsedBody.data

  const allowed: Record<string, unknown> = {}
  if ('name' in body) {
    if (!isNonEmptyString(body.name, 200)) return NextResponse.json({ error: 'Invalid session name.' }, { status: 400 })
    allowed.name = body.name.trim()
  }
  if ('status' in body) {
    if (body.status !== 'active' && body.status !== 'ended') return NextResponse.json({ error: 'Invalid session status.' }, { status: 400 })
    allowed.status = body.status
  }
  if ('anonymous' in body) {
    if (typeof body.anonymous !== 'boolean') return NextResponse.json({ error: 'anonymous must be a boolean.' }, { status: 400 })
    allowed.anonymous = body.anonymous
  }
  if ('round_id' in body) {
    if (!isNullableObjectId(body.round_id)) return NextResponse.json({ error: 'Invalid round_id.' }, { status: 400 })
    allowed.round_id = body.round_id
  }
  if ('role' in body) {
    if (body.role !== null && body.role !== 'curriculum' && body.role !== 'developer') {
      return NextResponse.json({ error: 'role must be "curriculum", "developer", or null.' }, { status: 400 })
    }
    allowed.role = body.role
  }
  if (Object.keys(allowed).length === 0) return NextResponse.json({ error: 'No valid updates supplied.' }, { status: 400 })

  // Resolve the target hierarchy before the transaction so its writes can be
  // acquired in cycle -> round -> session order. The transaction revalidates
  // every identifier before applying the session update.
  const sessionSnapshot = await Session.findById(id).select('round_id role status created_by').lean()
  if (!sessionSnapshot) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (sessionSnapshot.created_by?.toLowerCase() !== auth.email.toLowerCase() && auth.role !== 'admin') {
    return NextResponse.json({ error: 'Only the session creator can update it.' }, { status: 403 })
  }

  const targetRoundId = 'round_id' in allowed
    ? (allowed.round_id as string | null)
    : sessionSnapshot.round_id?.toString() ?? null
  const snapshotResultingStatus = typeof allowed.status === 'string' ? allowed.status : sessionSnapshot.status
  const snapshotResultingRole = 'role' in allowed ? allowed.role : sessionSnapshot.role
  if (sessionSnapshot.status === 'ended' && snapshotResultingStatus === 'active') {
    return NextResponse.json({ error: 'Ended sessions cannot be reactivated.' }, { status: 409 })
  }
  const snapshotAssociationChanged = (
    String(targetRoundId ?? '') !== String(sessionSnapshot.round_id ?? '')
    || snapshotResultingRole !== sessionSnapshot.role
  )
  if (!targetRoundId && snapshotResultingRole !== null) {
    return NextResponse.json({ error: 'The target round and role are not valid for this session.' }, { status: 409 })
  }
  const needsActiveTarget = Boolean(targetRoundId)
    && (snapshotResultingStatus === 'active' || snapshotAssociationChanged)
  const targetRoundSnapshot = needsActiveTarget
    ? await Round.findById(targetRoundId).select('cycle_id').lean()
    : null
  if (needsActiveTarget && !targetRoundSnapshot) {
    return NextResponse.json({ error: 'The target round and role are not valid for this session.' }, { status: 409 })
  }

  let outcome: 'updated' | 'missing' | 'forbidden' | 'invalid-transition' | 'invalid-round' | 'has-candidates' = 'missing'
  let updatedSession: Record<string, unknown> | null = null
  try {
    await mongoose.connection.transaction(async dbSession => {
      // Read and reject invalid/unauthorized changes before acquiring parent
      // write guards. The actual writes below still follow cycle -> round ->
      // session, matching cycle closure and avoiding inverted write locks.
      const current = await Session.findById(id).session(dbSession).lean()
      if (!current) return
      if (current.created_by?.toLowerCase() !== auth.email.toLowerCase() && auth.role !== 'admin') {
        outcome = 'forbidden'
        return
      }

      const resultingStatus = allowed.status ?? current.status
      const resultingRoundId = 'round_id' in allowed ? allowed.round_id : current.round_id
      const resultingRole = 'role' in allowed ? allowed.role : current.role
      if (String(resultingRoundId ?? '') !== String(targetRoundId ?? '')) {
        // The session association changed after the preflight read. Reject the
        // stale request rather than updating against an unfenced hierarchy.
        outcome = 'invalid-round'
        return
      }
      if (current.status === 'ended' && resultingStatus === 'active') {
        outcome = 'invalid-transition'
        return
      }

      const associationChanged = (
        String(resultingRoundId ?? '') !== String(current.round_id ?? '')
        || resultingRole !== current.role
      )
      if (associationChanged && await Candidate.exists({ session_id: id }).session(dbSession)) {
        outcome = 'has-candidates'
        return
      }

      if (!resultingRoundId && resultingRole !== null) {
        outcome = 'invalid-round'
        return
      }

      // Active sessions, plus every reparent/role-track change (including an
      // ended session being reparented), must attach only beneath an active
      // cycle and non-ended round.
      const requiresActiveTarget = Boolean(resultingRoundId)
        && (resultingStatus === 'active' || associationChanged)
      if (requiresActiveTarget) {
        if (!targetRoundSnapshot) {
          outcome = 'invalid-round'
          return
        }

        const cycle = await RecruitmentCycle.findOneAndUpdate(
          { _id: targetRoundSnapshot.cycle_id, status: 'active' },
          { $inc: { lifecycle_write_count: 1 } },
          { new: true, session: dbSession },
        ).select('_id').lean()
        if (!cycle) {
          outcome = 'invalid-round'
          return
        }

        // Guard the target round only after its active cycle has been fenced.
        const targetRound = await Round.findOneAndUpdate(
          {
            _id: resultingRoundId,
            cycle_id: targetRoundSnapshot.cycle_id,
            status: mongoose.trusted({ $ne: 'ended' }),
          },
          { $inc: { lifecycle_write_count: 1 } },
          { new: true, session: dbSession },
        ).select('role').lean()
        if (!targetRound || (targetRound.role && targetRound.role !== resultingRole)) {
          outcome = 'invalid-round'
          return
        }
      }

      if (current.status !== 'ended' && resultingStatus === 'ended') {
        // Common vote/note writes fence through the writer's membership row.
        // Touch every member before closing so an in-flight write either wins
        // before closure or retries and observes the ended session.
        await SessionMember.updateMany(
          { session_id: id },
          { $inc: { activity_write_count: 1 } },
          { session: dbSession },
        )
      }

      const updated = await Session.findByIdAndUpdate(id, allowed, { new: true, session: dbSession }).lean()
      if (!updated) return
      outcome = 'updated'
      updatedSession = updated as unknown as Record<string, unknown>
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to update session'
    if (msg.includes('duplicate key')) {
      return NextResponse.json(
        { error: 'Another active session already has this role for this round.' },
        { status: 409 },
      )
    }
    console.error('Failed to update session:', err)
    return NextResponse.json({ error: 'Unable to update session.' }, { status: 400 })
  }
  if (outcome === 'missing') return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (outcome === 'forbidden') return NextResponse.json({ error: 'Only the session creator can update it.' }, { status: 403 })
  if (outcome === 'invalid-transition') return NextResponse.json({ error: 'Ended sessions cannot be reactivated.' }, { status: 409 })
  if (outcome === 'invalid-round') return NextResponse.json({ error: 'The target round and role are not valid for this session.' }, { status: 409 })
  if (outcome === 'has-candidates') return NextResponse.json({ error: 'A session with candidates cannot change rounds or role tracks.' }, { status: 409 })
  const session = updatedSession!
  return NextResponse.json({
    ...session,
    id: String(session._id),
    round_id: session.round_id?.toString() ?? null,
    _id: undefined,
  })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole('leadership')
  if (auth instanceof NextResponse) return auth

  await connectDB()
  const { id } = await params
  if (!isSessionId(id)) return NextResponse.json({ error: 'Invalid session id.' }, { status: 400 })

  let outcome: 'deleted' | 'missing' | 'forbidden' = 'missing'
  await mongoose.connection.transaction(async dbSession => {
    const existing = await Session.findById(id).select('created_by').session(dbSession).lean()
    if (!existing) return
    if (existing.created_by?.toLowerCase() !== auth.email.toLowerCase() && auth.role !== 'admin') {
      outcome = 'forbidden'
      return
    }
    outcome = 'deleted'
    const candidates = await Candidate.find({ session_id: id }).select('_id').session(dbSession).lean()
    const candidateIds = candidates.map(candidate => candidate._id)
    if (candidateIds.length) await Vote.deleteMany({ candidate_id: mongoose.trusted({ $in: candidateIds }) }, { session: dbSession })
    if (candidateIds.length) await CandidateNote.deleteMany({ candidate_id: mongoose.trusted({ $in: candidateIds }) }, { session: dbSession })
    await Candidate.deleteMany({ session_id: id }, { session: dbSession })
    await SessionMember.deleteMany({ session_id: id }, { session: dbSession })
    await SessionBan.deleteMany({ session_id: id }, { session: dbSession })
    await Session.findByIdAndDelete(id, { session: dbSession })
  })
  if (outcome === 'missing') return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (outcome === 'forbidden') {
    return NextResponse.json({ error: 'Only the session creator can delete it.' }, { status: 403 })
  }
  return NextResponse.json({ ok: true })
}
