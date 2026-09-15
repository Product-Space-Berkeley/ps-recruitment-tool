import { NextRequest, NextResponse } from 'next/server'
import mongoose from 'mongoose'
import { connectDB } from '@/lib/mongodb'
import {
  RecruitmentCycle, Round, GraderAssignment, Review, Session, Candidate,
  Vote, CandidateNote, SessionMember, SessionBan,
} from '@/lib/models'
import { requireRole } from '@/lib/serverAuth'
import { isNonEmptyString, isObjectId, normalizeHttpUrl, readJsonObject } from '@/lib/apiValidation'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole('grader')
  if (auth instanceof NextResponse) return auth

  await connectDB()
  const { id } = await params
  if (!isObjectId(id)) return NextResponse.json({ error: 'Invalid round id.' }, { status: 400 })
  const round = await Round.findById(id).lean()
  if (!round) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ ...round, id: round._id.toString(), cycle_id: round.cycle_id.toString(), _id: undefined })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole('leadership')
  if (auth instanceof NextResponse) return auth

  await connectDB()
  const { id } = await params
  if (!isObjectId(id)) return NextResponse.json({ error: 'Invalid round id.' }, { status: 400 })
  const parsedBody = await readJsonObject(req)
  if (!parsedBody.ok) return parsedBody.response
  const body = parsedBody.data

  const allowed: Record<string, unknown> = {}
  if ('name' in body) {
    if (!isNonEmptyString(body.name, 200)) return NextResponse.json({ error: 'Invalid round name.' }, { status: 400 })
    allowed.name = body.name.trim()
  }
  if ('status' in body) {
    if (body.status !== 'pending' && body.status !== 'grading' && body.status !== 'deliberating' && body.status !== 'ended') {
      return NextResponse.json({ error: 'Invalid round status.' }, { status: 400 })
    }
    allowed.status = body.status
  }
  if ('grading_type' in body) {
    if (body.grading_type !== null && body.grading_type !== 'rubric' && body.grading_type !== 'interview') {
      return NextResponse.json({ error: 'Invalid grading type.' }, { status: 400 })
    }
    allowed.grading_type = body.grading_type
  }
  if ('order_index' in body) {
    if (!Number.isInteger(body.order_index) || Number(body.order_index) < 1 || Number(body.order_index) > 100) {
      return NextResponse.json({ error: 'Invalid round order.' }, { status: 400 })
    }
    allowed.order_index = Number(body.order_index)
  }
  if ('interview_form_url' in body) {
    if (body.interview_form_url === null || body.interview_form_url === '') {
      allowed.interview_form_url = null
    } else {
      const url = normalizeHttpUrl(body.interview_form_url)
      if (!url) return NextResponse.json({ error: 'Interview form must be a valid HTTP or HTTPS URL.' }, { status: 400 })
      allowed.interview_form_url = url
    }
  }
  if (Object.keys(allowed).length === 0) return NextResponse.json({ error: 'No valid updates supplied.' }, { status: 400 })

  const roundSnapshot = await Round.findById(id).select('cycle_id status').lean()
  if (!roundSnapshot) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const resultingStatus = typeof allowed.status === 'string' ? allowed.status : roundSnapshot.status
  if (roundSnapshot.status === 'ended' && resultingStatus !== 'ended') {
    return NextResponse.json({ error: 'Ended rounds cannot be reactivated.' }, { status: 409 })
  }

  const state: { outcome: 'updated' | 'missing' | 'invalid-transition' | 'inactive-cycle' } = {
    outcome: 'missing',
  }
  try {
    await mongoose.connection.transaction(async dbSession => {
      // Any non-terminal result must be fenced by its active parent. Acquiring
      // this write before the round write preserves the hierarchy lock order
      // used by cycle closure (cycle -> round -> session).
      if (resultingStatus !== 'ended') {
        const cycle = await RecruitmentCycle.findOneAndUpdate(
          { _id: roundSnapshot.cycle_id, status: 'active' },
          { $inc: { lifecycle_write_count: 1 } },
          { new: true, session: dbSession },
        ).select('_id').lean()
        if (!cycle) {
          state.outcome = 'inactive-cycle'
          return
        }
      }

      const roundFilter: Record<string, unknown> = {
        _id: id,
        cycle_id: roundSnapshot.cycle_id,
      }
      if (resultingStatus !== 'ended') {
        // Once a round reaches ended, no request may move it back to a
        // non-terminal state, even if this request raced with its closure.
        roundFilter.status = mongoose.trusted({ $ne: 'ended' })
      }
      const round = await Round.findOneAndUpdate(
        roundFilter,
        allowed,
        { new: true, session: dbSession },
      ).lean()
      if (!round) {
        const existing = await Round.findById(id).select('status').session(dbSession).lean()
        state.outcome = existing?.status === 'ended' && resultingStatus !== 'ended'
          ? 'invalid-transition'
          : 'missing'
        return
      }
      state.outcome = 'updated'
      if (resultingStatus === 'ended') {
        const sessions = await Session.find({ round_id: id })
          .select('_id')
          .session(dbSession)
          .lean()
        const sessionIds = sessions.map(deliberation => deliberation._id)
        if (sessionIds.length) {
          // Common vote/note writes fence through per-user membership rows.
          // Touch all affected rows before closing the round's sessions.
          await SessionMember.updateMany(
            { session_id: mongoose.trusted({ $in: sessionIds }) },
            { $inc: { activity_write_count: 1 } },
            { session: dbSession },
          )
        }
        await Session.updateMany({ round_id: id }, { $set: { status: 'ended' } }, { session: dbSession })
      }
    })
  } catch (error: unknown) {
    if (typeof error === 'object' && error && 'code' in error && error.code === 11000) {
      return NextResponse.json({ error: 'A round at this position already exists for this role track.' }, { status: 409 })
    }
    throw error
  }
  if (state.outcome === 'inactive-cycle') {
    return NextResponse.json({ error: 'A non-ended round requires an active parent cycle.' }, { status: 409 })
  }
  if (state.outcome === 'invalid-transition') {
    return NextResponse.json({ error: 'Ended rounds cannot be reactivated.' }, { status: 409 })
  }
  if (state.outcome === 'missing') return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const round = await Round.findById(id).lean()
  if (!round) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ ...round, id: round._id.toString(), cycle_id: round.cycle_id.toString(), _id: undefined })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole('leadership')
  if (auth instanceof NextResponse) return auth

  await connectDB()
  const { id } = await params
  if (!isObjectId(id)) return NextResponse.json({ error: 'Invalid round id.' }, { status: 400 })

  let existed = false
  await mongoose.connection.transaction(async dbSession => {
    const round = await Round.findById(id).select('_id').session(dbSession).lean()
    if (!round) return
    existed = true
    const sessions = await Session.find({ round_id: id }).select('_id').session(dbSession).lean()
    const sessionIds = sessions.map(deliberation => deliberation._id)
    const candidates = sessionIds.length
      ? await Candidate.find({ session_id: mongoose.trusted({ $in: sessionIds }) }).select('_id').session(dbSession).lean()
      : []
    const candidateIds = candidates.map(candidate => candidate._id)

    if (candidateIds.length) await Vote.deleteMany({ candidate_id: mongoose.trusted({ $in: candidateIds }) }, { session: dbSession })
    if (candidateIds.length) await CandidateNote.deleteMany({ candidate_id: mongoose.trusted({ $in: candidateIds }) }, { session: dbSession })
    if (sessionIds.length) await Candidate.deleteMany({ session_id: mongoose.trusted({ $in: sessionIds }) }, { session: dbSession })
    if (sessionIds.length) await SessionMember.deleteMany({ session_id: mongoose.trusted({ $in: sessionIds }) }, { session: dbSession })
    if (sessionIds.length) await SessionBan.deleteMany({ session_id: mongoose.trusted({ $in: sessionIds }) }, { session: dbSession })
    if (sessionIds.length) await Session.deleteMany({ _id: mongoose.trusted({ $in: sessionIds }) }, { session: dbSession })
    await GraderAssignment.deleteMany({ round_id: id }, { session: dbSession })
    await Review.deleteMany({ round_id: id }, { session: dbSession })
    await Round.findByIdAndDelete(id, { session: dbSession })
  })
  if (!existed) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
