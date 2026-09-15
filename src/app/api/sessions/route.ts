import { NextRequest, NextResponse } from 'next/server'
import { connectDB } from '@/lib/mongodb'
import mongoose from 'mongoose'
import { RecruitmentCycle, Round, Session, SessionMember } from '@/lib/models'
import { requireRole } from '@/lib/serverAuth'
import { isNonEmptyString, isNullableObjectId, isObjectId, isSessionId, readJsonObject } from '@/lib/apiValidation'

class SessionCreateRejected extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'SessionCreateRejected'
  }
}

export async function GET(req: NextRequest) {
  const auth = await requireRole('grader')
  if (auth instanceof NextResponse) return auth

  await connectDB()
  const { searchParams } = new URL(req.url)
  const round_id = searchParams.get('round_id')
  const role = searchParams.get('role')
  if (round_id && !isObjectId(round_id)) return NextResponse.json({ error: 'Invalid round_id.' }, { status: 400 })
  if (role && role !== 'curriculum' && role !== 'developer') return NextResponse.json({ error: 'Invalid role.' }, { status: 400 })
  const filter: Record<string, string> = {}
  if (round_id) filter.round_id = round_id
  if (role) filter.role = role
  let sessions
  if (auth.role === 'grader') {
    // A session code is the invitation boundary. Graders only see sessions
    // they created or already joined; leadership can administer all sessions.
    const memberships = await SessionMember.find({ user_email: auth.email }).select('session_id').lean()
    const joinedIds = memberships.map(membership => membership.session_id)
    const [createdSessions, joinedSessions] = await Promise.all([
      Session.find({ ...filter, created_by: auth.email }).lean(),
      joinedIds.length
        ? Session.find({ ...filter, _id: mongoose.trusted({ $in: joinedIds }) }).lean()
        : Promise.resolve([]),
    ])
    sessions = [...new Map([...createdSessions, ...joinedSessions].map(session => [session._id, session])).values()]
      .sort((left, right) => right.created_at.getTime() - left.created_at.getTime())
  } else {
    sessions = await Session.find(filter).sort({ created_at: -1 }).lean()
  }
  return NextResponse.json(sessions.map(s => ({ ...s, id: s._id, _id: undefined })))
}

export async function POST(req: NextRequest) {
  const auth = await requireRole('leadership')
  if (auth instanceof NextResponse) return auth

  await connectDB()
  const parsedBody = await readJsonObject(req)
  if (!parsedBody.ok) return parsedBody.response
  const body = parsedBody.data
  const { id, name, round_id = null, anonymous = false, role = null } = body
  if (!isSessionId(id) || !isNonEmptyString(name, 200) || !isNullableObjectId(round_id)) {
    return NextResponse.json({ error: 'A valid session id, name, and round are required.' }, { status: 400 })
  }
  if (typeof anonymous !== 'boolean') return NextResponse.json({ error: 'anonymous must be a boolean.' }, { status: 400 })
  if (role !== null && role !== 'curriculum' && role !== 'developer') {
    return NextResponse.json({ error: 'Invalid role.' }, { status: 400 })
  }
  if (!round_id && role !== null) {
    return NextResponse.json({ error: 'Standalone sessions cannot have a recruitment role track.' }, { status: 400 })
  }

  const parentRound = round_id
    ? await Round.findById(round_id).select('cycle_id').lean()
    : null
  if (round_id && !parentRound) {
    return NextResponse.json({ error: 'An active recruitment round is required.' }, { status: 409 })
  }

  try {
    let payload: Record<string, unknown> | null = null
    await mongoose.connection.transaction(async dbSession => {
      if (round_id) {
        // Guard the full active hierarchy in parent-to-child order. The cycle
        // write conflicts with concurrent cycle closure/deletion; the round
        // write then conflicts with concurrent round closure/deletion.
        const cycle = await RecruitmentCycle.findOneAndUpdate(
          { _id: parentRound!.cycle_id, status: 'active' },
          { $inc: { lifecycle_write_count: 1 } },
          { new: true, session: dbSession },
        ).select('_id').lean()
        if (!cycle) {
          throw new SessionCreateRejected('An active recruitment round is required.', 409)
        }

        const round = await Round.findOneAndUpdate(
          {
            _id: round_id,
            cycle_id: parentRound!.cycle_id,
            status: mongoose.trusted({ $ne: 'ended' }),
          },
          { $inc: { lifecycle_write_count: 1 } },
          { new: true, session: dbSession },
        ).select('status role').lean()
        if (!round || (round.role && round.role !== role)) {
          throw new SessionCreateRejected('An active recruitment round is required.', 409)
        }
        const existing = await Session.findOne({ round_id, role: role ?? null, status: 'active' })
          .session(dbSession)
          .lean()
        if (existing) {
          throw new SessionCreateRejected(
            'A deliberation session has already been started for this round and role.',
            409,
          )
        }
      }

      const [session] = await Session.create([{
        _id: id,
        name: name.trim(),
        round_id,
        anonymous,
        created_by: auth.email,
        role,
      }], { session: dbSession })
      payload = {
        ...session.toObject(),
        id: session._id,
        _id: undefined,
      }
    })
    return NextResponse.json(payload, { status: 201 })
  } catch (err: unknown) {
    if (err instanceof SessionCreateRejected) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    const message = err instanceof Error ? err.message : 'Failed to create session'
    if (message.includes('duplicate key')) {
      return NextResponse.json(
        { error: 'A deliberation session has already been started for this round and role.' },
        { status: 409 },
      )
    }
    console.error('Failed to create session:', err)
    return NextResponse.json({ error: 'Unable to create session.' }, { status: 400 })
  }
}
