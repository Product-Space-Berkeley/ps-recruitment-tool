import { NextRequest, NextResponse } from 'next/server'
import mongoose from 'mongoose'
import { connectDB } from '@/lib/mongodb'
import { Candidate, Session, SessionBan, SessionMember, Vote } from '@/lib/models'
import { requireRole } from '@/lib/serverAuth'
import { isObjectId, isSessionId, readJsonObject } from '@/lib/apiValidation'

class ControlError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole('admin')
  if (auth instanceof NextResponse) return auth
  const { id } = await params
  if (!isSessionId(id)) return NextResponse.json({ error: 'Invalid session.' }, { status: 400 })
  const parsed = await readJsonObject(req)
  if (!parsed.ok) return parsed.response
  const body = parsed.data
  if (body.action !== 'focus' && body.action !== 'vouch-limit' && body.action !== 'vouch-visibility') return NextResponse.json({ error: 'Invalid action.' }, { status: 400 })
  if (body.action === 'focus' && body.candidate_id !== null && !isObjectId(body.candidate_id)) return NextResponse.json({ error: 'Invalid candidate.' }, { status: 400 })
  if (body.action !== 'focus' && typeof body.enabled !== 'boolean') return NextResponse.json({ error: 'Invalid setting.' }, { status: 400 })
  await connectDB()
  try {
    await mongoose.connection.transaction(async tx => {
      const session = await Session.findOneAndUpdate({ _id: id, status: 'active' }, { $inc: { activity_write_count: 1 } }, { session: tx, returnDocument: 'after' }).lean()
      if (!session) throw new ControlError('Session is not active.', 409)
      if (!await SessionMember.exists({ session_id: id, user_email: auth.email }).session(tx) || await SessionBan.exists({ session_id: id, email: auth.email }).session(tx)) throw new ControlError('Join this session first.', 403)
      if (body.action === 'focus') {
        if (body.candidate_id !== null && !await Candidate.exists({ _id: body.candidate_id, session_id: id }).session(tx)) throw new ControlError('Candidate does not belong to this session.', 400)
        await Session.updateOne({ _id: id }, { $set: { focused_candidate_id: body.candidate_id }, $inc: { focus_version: 1 } }, { session: tx })
      } else if (body.action === 'vouch-visibility') {
        await Session.updateOne({ _id: id }, { $set: { show_vouch_counts: body.enabled } }, { session: tx })
      } else {
        // Votes fence on their membership row. Touch all members so a vote
        // racing this setting change retries with the new rule.
        await SessionMember.updateMany({ session_id: id }, { $inc: { activity_write_count: 1 } }, { session: tx })
        if (body.enabled) {
          const candidates = await Candidate.find({ session_id: id }).select('_id').session(tx).lean()
          const legacy = await Vote.exists({ candidate_id: mongoose.trusted({ $in: candidates.map(c => c._id) }), vote_type: 'vouch', $or: [{ voter_email: null }, { voter_email: '' }] }).session(tx)
          if (legacy) throw new ControlError('Some older vouches have no member identity. Reset those vouches before enabling this limit. No votes were changed.', 409)
          const duplicates = await Vote.aggregate([
            { $match: { candidate_id: { $in: candidates.map(c => c._id) }, vote_type: 'vouch' } },
            { $group: { _id: { $toLower: { $ifNull: ['$voter_email', '$voter_name'] } }, count: { $sum: 1 } } },
            { $match: { count: { $gt: 1 } } }, { $limit: 1 },
          ]).session(tx)
          if (duplicates.length) throw new ControlError('Some members already have multiple vouches. Remove extra vouches or use Reset Vouches before enabling this limit. No votes were changed.', 409)
        }
        await Session.updateOne({ _id: id }, { $set: { one_vouch_per_member: body.enabled } }, { session: tx })
      }
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof ControlError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('Session control update failed', e)
    return NextResponse.json({ error: 'Unable to update session controls.' }, { status: 500 })
  }
}
