import { NextRequest, NextResponse } from 'next/server'
import mongoose from 'mongoose'
import { connectDB } from '@/lib/mongodb'
import { Vote, Candidate, SessionBan, SessionMember, Session as SessionModel } from '@/lib/models'
import { requireRole } from '@/lib/serverAuth'
import { isNonEmptyString, isObjectId, readJsonObject } from '@/lib/apiValidation'
import { consumeUserRateLimit } from '@/lib/rateLimit'

class VoteMutationRejected extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'VoteMutationRejected'
  }
}

export async function GET(req: NextRequest) {
  const auth = await requireRole('grader')
  if (auth instanceof NextResponse) return auth

  await connectDB()
  const { searchParams } = new URL(req.url)
  const candidate_ids = [...new Set(searchParams.get('candidate_ids')?.split(',').filter(Boolean) ?? [])]
  if (!candidate_ids.length) return NextResponse.json([])
  if (candidate_ids.length > 100 || candidate_ids.some(id => !isObjectId(id))) {
    return NextResponse.json({ error: 'Invalid candidate_ids.' }, { status: 400 })
  }

  const candidates = await Candidate.find({ _id: mongoose.trusted({ $in: candidate_ids }) }).select('session_id').lean()
  if (candidates.length !== candidate_ids.length) {
    return NextResponse.json({ error: 'Candidate not found.' }, { status: 404 })
  }
  const sessionIds = [...new Set(candidates.map(candidate => candidate.session_id))]
  if (sessionIds.length !== 1) {
    return NextResponse.json({ error: 'Candidates must belong to one session.' }, { status: 400 })
  }
  const sessionId = sessionIds[0]
  const session = await SessionModel.findById(sessionId).select('created_by anonymous show_vouch_counts').lean()
  if (!session) return NextResponse.json({ error: 'Session not found.' }, { status: 404 })
  const isCreator = session.created_by?.toLowerCase() === auth.email.toLowerCase()
  const [isMember, banned] = await Promise.all([
    SessionMember.exists({ session_id: sessionId, user_email: auth.email }),
    SessionBan.exists({ session_id: sessionId, email: auth.email }),
  ])
  if (banned) return NextResponse.json({ error: 'You have been removed from this session.' }, { status: 403 })
  if (!isCreator && !isMember) {
    return NextResponse.json({ error: 'Join this session to view votes.' }, { status: 403 })
  }

  const votes = await Vote.find({ candidate_id: mongoose.trusted({ $in: candidate_ids }) }).lean()

  // Red flags are anonymous to everyone but the session creator. Redact on the
  // server so identities aren't recoverable from the network response. A user's
  // own flag is left intact so the UI can still show their toggle state.
  return NextResponse.json(votes.filter(v => session.show_vouch_counts !== false || v.vote_type === 'red_flag' || v.voter_email?.toLowerCase() === auth.email).map(v => {
    const isMine = typeof v.voter_email === 'string' && v.voter_email.toLowerCase() === auth.email.toLowerCase()
    const base = {
      ...v,
      id: v._id.toString(),
      candidate_id: v.candidate_id.toString(),
      voter_email: isMine ? v.voter_email : null,
      _id: undefined,
    }
    if ((session.anonymous || (v.vote_type === 'red_flag' && !isCreator)) && !isMine) {
      return { ...base, voter_name: 'Anonymous', voter_email: null }
    }
    return base
  }))
}

export async function POST(req: NextRequest) {
  const auth = await requireRole('grader')
  if (auth instanceof NextResponse) return auth

  await connectDB()
  if (!await consumeUserRateLimit(auth.email, 'vote-write', 300, 60_000)) {
    return NextResponse.json({ error: 'Too many vote changes. Try again shortly.' }, { status: 429 })
  }
  const parsedBody = await readJsonObject(req)
  if (!parsedBody.ok) return parsedBody.response
  const body = parsedBody.data
  const validTypes = ['vouch', 'anti_vouch', 'red_flag']
  if (!isObjectId(body.candidate_id) || typeof body.vote_type !== 'string' || !validTypes.includes(body.vote_type)) {
    return NextResponse.json({ error: 'Invalid vote data' }, { status: 400 })
  }

  try {
    let voteId = ''
    await mongoose.connection.transaction(async dbSession => {
      const candidate = await Candidate.findById(body.candidate_id)
        .select('session_id')
        .session(dbSession)
        .lean()
      if (!candidate) throw new VoteMutationRejected('Candidate not found.', 404)

      const session = await SessionModel.findById(candidate.session_id)
        .select('status one_vouch_per_member')
        .session(dbSession)
        .lean()
      if (!session) throw new VoteMutationRejected('Session not found.', 404)
      if (session.status !== 'active') throw new VoteMutationRejected('This session has ended.', 409)

      const memberGuard = await SessionMember.updateOne(
        { session_id: candidate.session_id, user_email: auth.email },
        { $inc: { activity_write_count: 1 } },
        { session: dbSession },
      )
      if (memberGuard.matchedCount !== 1) {
        throw new VoteMutationRejected('You are not a member of this deliberation session.', 403)
      }
      if (await SessionBan.exists({ session_id: candidate.session_id, email: auth.email }).session(dbSession)) {
        throw new VoteMutationRejected('You have been removed from this session.', 403)
      }

      if (body.vote_type === 'vouch' && session.one_vouch_per_member) {
        const candidates = await Candidate.find({ session_id: candidate.session_id }).select('_id').session(dbSession).lean()
        const existing = await Vote.exists({ candidate_id: mongoose.trusted({ $in: candidates.map(c => c._id) }), voter_email: auth.email, vote_type: 'vouch' }).session(dbSession)
        if (existing) throw new VoteMutationRejected('This session allows one vouch per member. Remove your current vouch before choosing another applicant.', 409)
      }

      const [vote] = await Vote.create([{
        candidate_id: body.candidate_id,
        vote_type: body.vote_type,
        voter_name: isNonEmptyString(body.voter_name, 200) ? body.voter_name.trim() : auth.email,
        voter_email: auth.email,
      }], { session: dbSession })
      voteId = vote._id.toString()
    })
    return NextResponse.json({ id: voteId }, { status: 201 })
  } catch (e: unknown) {
    if (e instanceof VoteMutationRejected) {
      return NextResponse.json({ error: e.message }, { status: e.status })
    }
    const msg = e instanceof Error ? e.message : 'Unknown error'
    if (msg.includes('duplicate')) return NextResponse.json({ error: 'You already cast this vote.' }, { status: 409 })
    console.error('Failed to create vote:', e)
    return NextResponse.json({ error: 'Unable to cast vote.' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  const auth = await requireRole('grader')
  if (auth instanceof NextResponse) return auth

  await connectDB()
  if (!await consumeUserRateLimit(auth.email, 'vote-write', 300, 60_000)) {
    return NextResponse.json({ error: 'Too many vote changes. Try again shortly.' }, { status: 429 })
  }
  const parsedBody = await readJsonObject(req)
  if (!parsedBody.ok) return parsedBody.response
  const { id } = parsedBody.data
  if (!isObjectId(id)) return NextResponse.json({ error: 'A valid id is required.' }, { status: 400 })

  try {
    await mongoose.connection.transaction(async dbSession => {
      const vote = await Vote.findById(id).session(dbSession).lean()
      if (!vote) return

      const candidate = await Candidate.findById(vote.candidate_id)
        .select('session_id')
        .session(dbSession)
        .lean()
      if (!candidate) throw new VoteMutationRejected('Vote session not found.', 404)
      const session = await SessionModel.findById(candidate.session_id)
        .select('status')
        .session(dbSession)
        .lean()
      if (!session) throw new VoteMutationRejected('Vote session not found.', 404)
      if (session.status !== 'active') throw new VoteMutationRejected('This session has ended.', 409)
      if (await SessionBan.exists({ session_id: candidate.session_id, email: auth.email }).session(dbSession)) {
        throw new VoteMutationRejected('You have been removed from this session.', 403)
      }

      const isOwner = typeof vote.voter_email === 'string'
        && vote.voter_email.toLowerCase() === auth.email.toLowerCase()
      const isPrivileged = auth.role === 'leadership' || auth.role === 'admin'
      if (!isOwner && !isPrivileged) {
        throw new VoteMutationRejected('You can only delete your own vote.', 403)
      }
      let fencedByMember = false
      if (isOwner) {
        // Even leadership/admin should use the narrow per-member fence when
        // deleting their own vote. Reserving the shared session fence for
        // true moderation avoids serializing unrelated owner toggles.
        const memberGuard = await SessionMember.updateOne(
          { session_id: candidate.session_id, user_email: auth.email },
          { $inc: { activity_write_count: 1 } },
          { session: dbSession },
        )
        fencedByMember = memberGuard.matchedCount === 1
        if (!fencedByMember && !isPrivileged) {
          throw new VoteMutationRejected('You are not a member of this deliberation session.', 403)
        }
      }
      if (!fencedByMember && isPrivileged) {
        // Leadership/admin may moderate another user's vote, or remove their
        // own legacy vote after membership removal. Those operations fence on
        // the session because no usable member row is guaranteed to exist.
        const sessionGuard = await SessionModel.updateOne(
          { _id: candidate.session_id, status: 'active' },
          { $inc: { activity_write_count: 1 } },
          { session: dbSession },
        )
        if (sessionGuard.matchedCount !== 1) {
          throw new VoteMutationRejected('This session has ended.', 409)
        }
      }
      await Vote.deleteOne({ _id: id }, { session: dbSession })
    })
    return NextResponse.json({ ok: true })
  } catch (error: unknown) {
    if (error instanceof VoteMutationRejected) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    throw error
  }
}
