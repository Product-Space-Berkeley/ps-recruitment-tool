import { NextRequest, NextResponse } from 'next/server'
import mongoose from 'mongoose'
import { connectDB } from '@/lib/mongodb'
import { Session, SessionMember, SessionBan } from '@/lib/models'
import { requireRole } from '@/lib/serverAuth'
import { isEmail, isSessionId, readJsonObject } from '@/lib/apiValidation'
import { consumeUserRateLimit } from '@/lib/rateLimit'

class MembershipRejected extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'MembershipRejected'
  }
}

export async function GET(req: NextRequest) {
  const auth = await requireRole('grader')
  if (auth instanceof NextResponse) return auth

  await connectDB()
  const { searchParams } = new URL(req.url)
  const session_id = searchParams.get('session_id')
  if (!session_id) return NextResponse.json([])
  if (!isSessionId(session_id)) return NextResponse.json({ error: 'Invalid session id.' }, { status: 400 })
  const session = await Session.findById(session_id).select('created_by').lean()
  if (!session) return NextResponse.json({ error: 'Session not found.' }, { status: 404 })
  const isCreator = session.created_by?.toLowerCase() === auth.email.toLowerCase()
  const [isMember, banned] = await Promise.all([
    SessionMember.exists({ session_id, user_email: auth.email }),
    SessionBan.exists({ session_id, email: auth.email }),
  ])
  if (banned) return NextResponse.json({ error: 'You have been removed from this session.' }, { status: 403 })
  if (!isCreator && !isMember) return NextResponse.json({ error: 'Join this session to view members.' }, { status: 403 })
  const members = await SessionMember.find({ session_id }).lean()
  return NextResponse.json(members.map(m => ({ ...m, id: m._id.toString(), _id: undefined })))
}

export async function POST(req: NextRequest) {
  const auth = await requireRole('grader')
  if (auth instanceof NextResponse) return auth

  await connectDB()
  if (!await consumeUserRateLimit(auth.email, 'session-membership-write', 60, 60_000)) {
    return NextResponse.json({ error: 'Too many membership changes. Try again shortly.' }, { status: 429 })
  }
  const parsedBody = await readJsonObject(req)
  if (!parsedBody.ok) return parsedBody.response
  const body = parsedBody.data
  const { session_id, user_email } = body
  if (!isSessionId(session_id)) return NextResponse.json({ error: 'A valid session_id is required.' }, { status: 400 })

  const requestedEmail = typeof user_email === 'string' && user_email.trim() !== ''
    ? user_email.trim().toLowerCase()
    : auth.email
  if (!isEmail(requestedEmail)) return NextResponse.json({ error: 'A valid email is required.' }, { status: 400 })

  const emailToAdd = requestedEmail
  try {
    await mongoose.connection.transaction(async dbSession => {
      const session = await Session.findById(session_id)
        .select('created_by status')
        .session(dbSession)
        .lean()
      if (!session) throw new MembershipRejected('Session not found.', 404)
      if (session.status !== 'active') throw new MembershipRejected('This session has ended.', 409)

      const isCreator = session.created_by?.toLowerCase() === auth.email.toLowerCase()
      if (emailToAdd !== auth.email && !isCreator && auth.role !== 'admin') {
        throw new MembershipRejected('Only the session creator can add another member.', 403)
      }

      const sessionGuard = await Session.updateOne(
        { _id: session_id, status: 'active' },
        { $inc: { activity_write_count: 1 } },
        { session: dbSession },
      )
      if (sessionGuard.modifiedCount !== 1) {
        throw new MembershipRejected('This session has ended.', 409)
      }

      // Banned emails cannot (re)join, no matter who is adding them. Ban writes
      // touch the same parent session, so concurrent ban/join operations retry
      // against a fresh snapshot and cannot leave a banned member behind.
      if (await SessionBan.exists({ session_id, email: emailToAdd }).session(dbSession)) {
        throw new MembershipRejected('This email is banned from the session.', 403)
      }

      await SessionMember.findOneAndUpdate(
        { session_id, user_email: emailToAdd },
        { $setOnInsert: { joined_at: new Date() } },
        { upsert: true, session: dbSession },
      )
    })
  } catch (error: unknown) {
    if (error instanceof MembershipRejected) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    throw error
  }
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest) {
  const auth = await requireRole('grader')
  if (auth instanceof NextResponse) return auth

  await connectDB()
  if (!await consumeUserRateLimit(auth.email, 'session-membership-write', 60, 60_000)) {
    return NextResponse.json({ error: 'Too many membership changes. Try again shortly.' }, { status: 429 })
  }
  const parsedBody = await readJsonObject(req)
  if (!parsedBody.ok) return parsedBody.response
  const { session_id, user_email } = parsedBody.data
  if (!isSessionId(session_id) || !isEmail(user_email)) {
    return NextResponse.json({ error: 'A valid session_id and user_email are required.' }, { status: 400 })
  }

  const emailToRemove = user_email.trim().toLowerCase()
  try {
    await mongoose.connection.transaction(async dbSession => {
      const session = await Session.findById(session_id)
        .select('created_by')
        .session(dbSession)
        .lean()
      if (!session) throw new MembershipRejected('Session not found.', 404)

      const isCreator = session.created_by?.toLowerCase() === auth.email.toLowerCase()
      if (emailToRemove !== auth.email && !isCreator && auth.role !== 'admin') {
        throw new MembershipRejected('Forbidden', 403)
      }
      if (emailToRemove === session.created_by?.toLowerCase()) {
        throw new MembershipRejected('The session creator cannot be removed.', 400)
      }

      const sessionGuard = await Session.updateOne(
        { _id: session_id },
        { $inc: { activity_write_count: 1 } },
        { session: dbSession },
      )
      if (sessionGuard.modifiedCount !== 1) throw new MembershipRejected('Session not found.', 404)

      await SessionMember.deleteOne(
        { session_id, user_email: emailToRemove },
        { session: dbSession },
      )
    })
  } catch (error: unknown) {
    if (error instanceof MembershipRejected) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    throw error
  }
  return NextResponse.json({ ok: true })
}
