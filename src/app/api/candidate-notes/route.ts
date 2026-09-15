import { NextRequest, NextResponse } from 'next/server'
import mongoose from 'mongoose'
import { connectDB } from '@/lib/mongodb'
import { CandidateNote, Candidate, SessionBan, SessionMember, Session as SessionModel } from '@/lib/models'
import { requireRole } from '@/lib/serverAuth'
import { isNonEmptyString, isObjectId, readJsonObject } from '@/lib/apiValidation'
import { consumeUserRateLimit } from '@/lib/rateLimit'

class NoteMutationRejected extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'NoteMutationRejected'
  }
}

export async function GET(req: NextRequest) {
  const auth = await requireRole('grader')
  if (auth instanceof NextResponse) return auth

  await connectDB()
  const { searchParams } = new URL(req.url)
  const candidate_id = searchParams.get('candidate_id')
  if (!candidate_id) return NextResponse.json([])
  if (!isObjectId(candidate_id)) return NextResponse.json({ error: 'Invalid candidate_id.' }, { status: 400 })

  const candidate = await Candidate.findById(candidate_id).select('session_id').lean()
  if (!candidate) return NextResponse.json({ error: 'Candidate not found.' }, { status: 404 })
  const session = await SessionModel.findById(candidate.session_id).select('created_by').lean()
  if (!session) return NextResponse.json({ error: 'Session not found.' }, { status: 404 })

  const isCreator = session.created_by?.toLowerCase() === auth.email.toLowerCase()
  const [isMember, banned] = await Promise.all([
    SessionMember.exists({ session_id: candidate.session_id, user_email: auth.email }),
    SessionBan.exists({ session_id: candidate.session_id, email: auth.email }),
  ])
  if (banned) return NextResponse.json({ error: 'You have been removed from this session.' }, { status: 403 })
  if (!isCreator && !isMember) {
    return NextResponse.json({ error: 'Join this session to view notes.' }, { status: 403 })
  }

  // Red-flag notes are anonymous to everyone but the session creator; authors
  // still see their own. Redacted server-side so the name never reaches the client.
  const notes = await CandidateNote.find({ candidate_id }).sort({ created_at: 1 }).lean()

  return NextResponse.json(notes.map(n => {
    const base = { ...n, id: n._id.toString(), candidate_id: n.candidate_id.toString(), _id: undefined }
    const isMine = typeof n.author_email === 'string' && n.author_email.toLowerCase() === auth.email.toLowerCase()
    if (n.type === 'red_flag' && !isCreator && !isMine) {
      return { ...base, author: 'Anonymous', author_email: null }
    }
    return base
  }))
}

export async function POST(req: NextRequest) {
  const auth = await requireRole('grader')
  if (auth instanceof NextResponse) return auth

  await connectDB()
  if (!await consumeUserRateLimit(auth.email, 'candidate-note-write', 120, 60_000)) {
    return NextResponse.json({ error: 'Too many note changes. Try again shortly.' }, { status: 429 })
  }
  const parsedBody = await readJsonObject(req)
  if (!parsedBody.ok) return parsedBody.response
  const body = parsedBody.data
  const validTypes = ['note', 'red_flag']
  if (!isObjectId(body.candidate_id) || !isNonEmptyString(body.content, 2000) || typeof body.type !== 'string' || !validTypes.includes(body.type)) {
    return NextResponse.json({ error: 'Invalid note data' }, { status: 400 })
  }
  const noteContent = body.content.trim()
  const noteType = body.type

  try {
    let notePayload: Record<string, unknown> | null = null
    await mongoose.connection.transaction(async dbSession => {
      const candidate = await Candidate.findById(body.candidate_id)
        .select('session_id')
        .session(dbSession)
        .lean()
      if (!candidate) throw new NoteMutationRejected('Candidate not found.', 404)

      const session = await SessionModel.findById(candidate.session_id)
        .select('status')
        .session(dbSession)
        .lean()
      if (!session) throw new NoteMutationRejected('Session not found.', 404)
      if (session.status !== 'active') throw new NoteMutationRejected('This session has ended.', 409)

      const memberGuard = await SessionMember.updateOne(
        { session_id: candidate.session_id, user_email: auth.email },
        { $inc: { activity_write_count: 1 } },
        { session: dbSession },
      )
      if (memberGuard.matchedCount !== 1) {
        throw new NoteMutationRejected('You are not a member of this deliberation session.', 403)
      }
      if (await SessionBan.exists({ session_id: candidate.session_id, email: auth.email }).session(dbSession)) {
        throw new NoteMutationRejected('You have been removed from this session.', 403)
      }

      const [note] = await CandidateNote.create([{
        candidate_id: body.candidate_id,
        author: isNonEmptyString(body.author, 200) ? body.author.trim() : auth.email,
        author_email: auth.email,
        content: noteContent,
        type: noteType,
      }], { session: dbSession })
      notePayload = note.toObject() as Record<string, unknown>
    })
    const note = notePayload!
    return NextResponse.json({ ...note, id: String(note._id), _id: undefined }, { status: 201 })
  } catch (error: unknown) {
    if (error instanceof NoteMutationRejected) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    console.error('Failed to create candidate note:', error)
    return NextResponse.json({ error: 'Unable to add note.' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  const auth = await requireRole('grader')
  if (auth instanceof NextResponse) return auth

  await connectDB()
  if (!await consumeUserRateLimit(auth.email, 'candidate-note-write', 120, 60_000)) {
    return NextResponse.json({ error: 'Too many note changes. Try again shortly.' }, { status: 429 })
  }
  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })
  if (!isObjectId(id)) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 })

  try {
    await mongoose.connection.transaction(async dbSession => {
      // Ownership is keyed on author_email — `author` is display text only.
      const note = await CandidateNote.findById(id).session(dbSession).lean()
      if (!note) throw new NoteMutationRejected('Not found', 404)
      const candidate = await Candidate.findById(note.candidate_id)
        .select('session_id')
        .session(dbSession)
        .lean()
      if (!candidate) throw new NoteMutationRejected('Note session not found.', 404)
      const session = await SessionModel.findById(candidate.session_id)
        .select('status')
        .session(dbSession)
        .lean()
      if (!session) throw new NoteMutationRejected('Note session not found.', 404)
      if (session.status !== 'active') throw new NoteMutationRejected('This session has ended.', 409)
      if (await SessionBan.exists({ session_id: candidate.session_id, email: auth.email }).session(dbSession)) {
        throw new NoteMutationRejected('You have been removed from this session.', 403)
      }

      const isAuthor = typeof note.author_email === 'string'
        && note.author_email.toLowerCase() === auth.email.toLowerCase()
      const isPrivileged = auth.role === 'leadership' || auth.role === 'admin'
      if (!isAuthor && !isPrivileged) throw new NoteMutationRejected('Forbidden', 403)
      let fencedByMember = false
      if (isAuthor) {
        // Prefer the narrow per-member fence for an author's own note, even
        // when the author is leadership/admin. The shared session fence is
        // reserved for actual privileged moderation.
        const memberGuard = await SessionMember.updateOne(
          { session_id: candidate.session_id, user_email: auth.email },
          { $inc: { activity_write_count: 1 } },
          { session: dbSession },
        )
        fencedByMember = memberGuard.matchedCount === 1
        if (!fencedByMember && !isPrivileged) {
          throw new NoteMutationRejected('You are not a member of this deliberation session.', 403)
        }
      }
      if (!fencedByMember && isPrivileged) {
        // Leadership/admin may moderate another user's note, or remove their
        // own legacy note after membership removal. Without a usable member
        // row, the session document remains the lifecycle fence.
        const sessionGuard = await SessionModel.updateOne(
          { _id: candidate.session_id, status: 'active' },
          { $inc: { activity_write_count: 1 } },
          { session: dbSession },
        )
        if (sessionGuard.matchedCount !== 1) {
          throw new NoteMutationRejected('This session has ended.', 409)
        }
      }
      await CandidateNote.deleteOne({ _id: id }, { session: dbSession })
    })
    return NextResponse.json({ ok: true })
  } catch (error: unknown) {
    if (error instanceof NoteMutationRejected) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    throw error
  }
}
