import { NextRequest, NextResponse } from 'next/server'
import mongoose from 'mongoose'
import { connectDB } from '@/lib/mongodb'
import { Session, SessionBan, SessionMember } from '@/lib/models'
import { requireRole } from '@/lib/serverAuth'
import { isEmail, isSessionId, readJsonObject } from '@/lib/apiValidation'

type Auth = { email: string; role: 'grader' | 'leadership' | 'admin' }

class SessionBanRejected extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'SessionBanRejected'
  }
}

// Bans are managed by the session's creator, or by a global admin.
async function requireSessionOwner(session_id: string, auth: Auth) {
  if (!isSessionId(session_id)) return NextResponse.json({ error: 'Invalid session id.' }, { status: 400 })
  const session = await Session.findById(session_id).lean()
  if (!session) return NextResponse.json({ error: 'Session not found.' }, { status: 404 })
  const isOwner = session.created_by?.toLowerCase() === auth.email.toLowerCase()
  if (!isOwner && auth.role !== 'admin') {
    return NextResponse.json({ error: 'Only the session creator can manage bans.' }, { status: 403 })
  }
  return session
}

export async function GET(req: NextRequest) {
  const auth = await requireRole('grader')
  if (auth instanceof NextResponse) return auth

  await connectDB()
  const session_id = new URL(req.url).searchParams.get('session_id')
  if (!session_id) return NextResponse.json([])

  const owner = await requireSessionOwner(session_id, auth)
  if (owner instanceof NextResponse) return owner

  const bans = await SessionBan.find({ session_id }).sort({ banned_at: -1 }).lean()
  return NextResponse.json(bans.map(b => ({ ...b, id: b._id.toString(), _id: undefined })))
}

export async function POST(req: NextRequest) {
  const auth = await requireRole('grader')
  if (auth instanceof NextResponse) return auth

  await connectDB()
  const parsedBody = await readJsonObject(req)
  if (!parsedBody.ok) return parsedBody.response
  const { session_id, email } = parsedBody.data
  if (!isSessionId(session_id) || !isEmail(email)) {
    return NextResponse.json({ error: 'session_id and email are required.' }, { status: 400 })
  }

  const target = email.trim().toLowerCase()
  try {
    await mongoose.connection.transaction(async dbSession => {
      const session = await Session.findById(session_id)
        .select('created_by')
        .session(dbSession)
        .lean()
      if (!session) throw new SessionBanRejected('Session not found.', 404)
      const isOwner = session.created_by?.toLowerCase() === auth.email.toLowerCase()
      if (!isOwner && auth.role !== 'admin') {
        throw new SessionBanRejected('Only the session creator can manage bans.', 403)
      }

      // Guard against locking the session's own creator out of it.
      if (target === session.created_by?.toLowerCase()) {
        throw new SessionBanRejected('You cannot ban the session creator.', 400)
      }

      const sessionGuard = await Session.updateOne(
        { _id: session_id },
        { $inc: { activity_write_count: 1 } },
        { session: dbSession },
      )
      if (sessionGuard.modifiedCount !== 1) throw new SessionBanRejected('Session not found.', 404)

      await SessionBan.findOneAndUpdate(
        { session_id, email: target },
        { $setOnInsert: { banned_by: auth.email, banned_at: new Date() } },
        { upsert: true, session: dbSession },
      )
      await SessionMember.deleteOne({ session_id, user_email: target }, { session: dbSession })
    })
  } catch (error: unknown) {
    if (error instanceof SessionBanRejected) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    throw error
  }

  return NextResponse.json({ ok: true, email: target }, { status: 201 })
}

export async function DELETE(req: NextRequest) {
  const auth = await requireRole('grader')
  if (auth instanceof NextResponse) return auth

  await connectDB()
  const parsedBody = await readJsonObject(req)
  if (!parsedBody.ok) return parsedBody.response
  const { session_id, email } = parsedBody.data
  if (!isSessionId(session_id) || !isEmail(email)) {
    return NextResponse.json({ error: 'session_id and email are required.' }, { status: 400 })
  }

  try {
    await mongoose.connection.transaction(async dbSession => {
      const session = await Session.findById(session_id)
        .select('created_by')
        .session(dbSession)
        .lean()
      if (!session) throw new SessionBanRejected('Session not found.', 404)
      const isOwner = session.created_by?.toLowerCase() === auth.email.toLowerCase()
      if (!isOwner && auth.role !== 'admin') {
        throw new SessionBanRejected('Only the session creator can manage bans.', 403)
      }

      const sessionGuard = await Session.updateOne(
        { _id: session_id },
        { $inc: { activity_write_count: 1 } },
        { session: dbSession },
      )
      if (sessionGuard.modifiedCount !== 1) throw new SessionBanRejected('Session not found.', 404)

      await SessionBan.deleteOne(
        { session_id, email: email.trim().toLowerCase() },
        { session: dbSession },
      )
    })
  } catch (error: unknown) {
    if (error instanceof SessionBanRejected) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    throw error
  }
  return NextResponse.json({ ok: true })
}
