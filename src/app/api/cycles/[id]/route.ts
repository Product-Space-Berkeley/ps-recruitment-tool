import { NextRequest, NextResponse } from 'next/server'
import mongoose from 'mongoose'
import { connectDB } from '@/lib/mongodb'
import {
  RecruitmentCycle, EssayPrompt, CoffeeChatNote, Applicant, EssayResponse,
  Round, GraderAssignment, Review, Session as DeliberationSession, SessionMember,
  SessionBan, Candidate, Vote, CandidateNote,
} from '@/lib/models'
import { requireRole } from '@/lib/serverAuth'
import { isNonEmptyString, isObjectId, readJsonObject } from '@/lib/apiValidation'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole('leadership')
  if (auth instanceof NextResponse) return auth

  await connectDB()
  const { id } = await params
  if (!isObjectId(id)) return NextResponse.json({ error: 'Invalid cycle id.' }, { status: 400 })
  const parsedBody = await readJsonObject(req)
  if (!parsedBody.ok) return parsedBody.response
  const body = parsedBody.data

  // Whitelist only patchable fields
  const allowed: Record<string, unknown> = {}
  if ('name' in body) {
    if (!isNonEmptyString(body.name, 100)) return NextResponse.json({ error: 'Invalid cycle name.' }, { status: 400 })
    allowed.name = body.name.trim()
  }
  if ('status' in body) {
    if (body.status !== 'active' && body.status !== 'ended') return NextResponse.json({ error: 'Invalid cycle status.' }, { status: 400 })
    allowed.status = body.status
    if (body.status === 'ended') allowed.accepting_applications = false
  }
  if ('accepting_applications' in body) {
    if (typeof body.accepting_applications !== 'boolean') {
      return NextResponse.json({ error: 'accepting_applications must be a boolean.' }, { status: 400 })
    }
    allowed.accepting_applications = body.accepting_applications
  }
  if ('application_deadline' in body) {
    if (body.application_deadline === null) {
      allowed.application_deadline = null
    } else if (typeof body.application_deadline === 'string' || typeof body.application_deadline === 'number') {
      const deadline = new Date(body.application_deadline)
      if (Number.isNaN(deadline.getTime())) return NextResponse.json({ error: 'Invalid application deadline.' }, { status: 400 })
      allowed.application_deadline = deadline
    } else {
      return NextResponse.json({ error: 'Invalid application deadline.' }, { status: 400 })
    }
  }
  if (Object.keys(allowed).length === 0) {
    return NextResponse.json({ error: 'No valid updates supplied.' }, { status: 400 })
  }

  await RecruitmentCycle.updateOne(
    { _id: id, configuration_version: mongoose.trusted({ $exists: false }) },
    { $set: { configuration_version: 0 } },
  )

  let conflict: string | null = null
  try {
    await mongoose.connection.transaction(async session => {
      const current = await RecruitmentCycle.findById(id).session(session).lean()
      if (!current) { conflict = 'missing'; return }

      const resultingStatus = allowed.status ?? current.status
      const resultingAccepting = typeof allowed.accepting_applications === 'boolean'
        ? allowed.accepting_applications
        : resultingStatus === 'ended'
          ? false
          : current.accepting_applications
      const resultingDeadline = 'application_deadline' in allowed
        ? allowed.application_deadline
        : current.application_deadline

      // Validate the resulting open state, not only explicit open requests. An
      // already-open cycle must not retain its accepting flag with a past/null
      // deadline, an ended status, or an incomplete prompt set.
      if (resultingAccepting) {
        await RecruitmentCycle.updateMany(
          {
            accepting_applications: true,
            application_deadline: mongoose.trusted({ $lte: new Date() }),
          },
          { $set: { accepting_applications: false }, $inc: { configuration_version: 1 } },
          { session },
        )
        const prompts = await EssayPrompt.find({ cycle_id: id })
          .select('criterion1 criterion2')
          .session(session)
          .lean()
        const completePrompts = prompts.length === 3
          && prompts.every(prompt => prompt.criterion1?.trim() && prompt.criterion2?.trim())
        if (
          resultingStatus !== 'active'
          || !completePrompts
          || !(resultingDeadline instanceof Date)
          || resultingDeadline.getTime() <= Date.now()
        ) {
          conflict = 'requirements'
          return
        }

        const otherOpenCycle = await RecruitmentCycle.findOne({ accepting_applications: true })
          .select('_id')
          .session(session)
          .lean()
        if (otherOpenCycle && otherOpenCycle._id.toString() !== id) {
          conflict = 'already-open'
          return
        }
      }

      const updated = await RecruitmentCycle.findOneAndUpdate(
        { _id: id, configuration_version: current.configuration_version },
        { $set: allowed, $inc: { configuration_version: 1 } },
        { new: true, session },
      )
      if (!updated) {
        conflict = 'changed'
        return
      }

      if (current.status === 'active' && resultingStatus === 'ended') {
        const rounds = await Round.find({ cycle_id: id })
          .select('_id')
          .session(session)
          .lean()
        const roundIds = rounds.map(round => round._id)
        const sessions = roundIds.length
          ? await DeliberationSession.find({ round_id: mongoose.trusted({ $in: roundIds }) })
              .select('_id')
              .session(session)
              .lean()
          : []
        const sessionIds = sessions.map(deliberation => deliberation._id)

        // Common vote/note writes fence through the writer's member row. Touch
        // every descendant member before closing the hierarchy so each write
        // linearizes either wholly before cycle closure or retries and observes
        // an ended session.
        if (sessionIds.length) {
          await SessionMember.updateMany(
            { session_id: mongoose.trusted({ $in: sessionIds }) },
            { $inc: { activity_write_count: 1 } },
            { session },
          )
          // Session writes fence privileged activity deletion, membership and
          // ban changes, candidate imports, and direct candidate deletion.
          await DeliberationSession.updateMany(
            { _id: mongoose.trusted({ $in: sessionIds }) },
            { $set: { status: 'ended' }, $inc: { activity_write_count: 1 } },
            { session },
          )
        }
        if (roundIds.length) {
          // Ending every descendant round also conflicts with concurrent child
          // session creation/reparenting through the round lifecycle guard.
          await Round.updateMany(
            { _id: mongoose.trusted({ $in: roundIds }) },
            { $set: { status: 'ended' }, $inc: { lifecycle_write_count: 1 } },
            { session },
          )
        }
      }
    })
  } catch (error: unknown) {
    if (typeof error === 'object' && error && 'code' in error && error.code === 11000) {
      conflict = 'already-open'
    } else {
      throw error
    }
  }

  if (conflict === 'missing') return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (conflict === 'requirements') {
    return NextResponse.json(
      { error: 'Applications require an active cycle, exactly three complete prompts with rubrics, and a future deadline.' },
      { status: 409 },
    )
  }
  if (conflict === 'already-open') {
    return NextResponse.json({ error: 'Another recruitment cycle is already accepting applications.' }, { status: 409 })
  }
  if (conflict === 'changed') {
    return NextResponse.json({ error: 'Cycle configuration changed. Reload and try again.' }, { status: 409 })
  }

  const cycle = await RecruitmentCycle.findById(id).lean()
  if (!cycle) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ ...cycle, id: cycle._id.toString(), _id: undefined })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole('leadership')
  if (auth instanceof NextResponse) return auth

  await connectDB()
  const { id } = await params
  if (!isObjectId(id)) return NextResponse.json({ error: 'Invalid cycle id.' }, { status: 400 })
  let existed = false
  await mongoose.connection.transaction(async session => {
    const cycle = await RecruitmentCycle.findById(id).select('_id').session(session).lean()
    if (!cycle) return
    existed = true

    // MongoDB transaction operations must be serialized; Promise.all inside a
    // transaction is unsupported by Mongoose and can produce undefined results.
    const applicants = await Applicant.find({ cycle_id: id }).select('_id').session(session).lean()
    const prompts = await EssayPrompt.find({ cycle_id: id }).select('_id').session(session).lean()
    const rounds = await Round.find({ cycle_id: id }).select('_id').session(session).lean()
    const applicantIds = applicants.map(applicant => applicant._id)
    const promptIds = prompts.map(prompt => prompt._id)
    const roundIds = rounds.map(round => round._id)
    const sessions = roundIds.length
      ? await DeliberationSession.find({ round_id: mongoose.trusted({ $in: roundIds }) }).select('_id').session(session).lean()
      : []
    const sessionIds = sessions.map(deliberation => deliberation._id)

    const sessionCandidates = sessionIds.length
      ? await Candidate.find({ session_id: mongoose.trusted({ $in: sessionIds }) }).select('_id').session(session).lean()
      : []
    const applicantCandidates = applicantIds.length
      ? await Candidate.find({ applicant_id: mongoose.trusted({ $in: applicantIds }) }).select('_id').session(session).lean()
      : []
    const candidateById = new Map(
      [...sessionCandidates, ...applicantCandidates].map(candidate => [candidate._id.toString(), candidate._id]),
    )
    const candidateIds = [...candidateById.values()]

    if (applicantIds.length) await EssayResponse.deleteMany({ applicant_id: mongoose.trusted({ $in: applicantIds }) }, { session })
    if (promptIds.length) await EssayResponse.deleteMany({ prompt_id: mongoose.trusted({ $in: promptIds }) }, { session })
    if (roundIds.length) await GraderAssignment.deleteMany({ round_id: mongoose.trusted({ $in: roundIds }) }, { session })
    if (applicantIds.length) await GraderAssignment.deleteMany({ applicant_id: mongoose.trusted({ $in: applicantIds }) }, { session })
    if (roundIds.length) await Review.deleteMany({ round_id: mongoose.trusted({ $in: roundIds }) }, { session })
    if (applicantIds.length) await Review.deleteMany({ applicant_id: mongoose.trusted({ $in: applicantIds }) }, { session })
    if (candidateIds.length) await Vote.deleteMany({ candidate_id: mongoose.trusted({ $in: candidateIds }) }, { session })
    if (candidateIds.length) await CandidateNote.deleteMany({ candidate_id: mongoose.trusted({ $in: candidateIds }) }, { session })
    if (candidateIds.length) await Candidate.deleteMany({ _id: mongoose.trusted({ $in: candidateIds }) }, { session })
    if (sessionIds.length) await SessionMember.deleteMany({ session_id: mongoose.trusted({ $in: sessionIds }) }, { session })
    if (sessionIds.length) await SessionBan.deleteMany({ session_id: mongoose.trusted({ $in: sessionIds }) }, { session })
    if (sessionIds.length) await DeliberationSession.deleteMany({ _id: mongoose.trusted({ $in: sessionIds }) }, { session })
    await Round.deleteMany({ cycle_id: id }, { session })
    await Applicant.deleteMany({ cycle_id: id }, { session })
    await EssayPrompt.deleteMany({ cycle_id: id }, { session })
    await CoffeeChatNote.deleteMany({ cycle_id: id }, { session })
    await RecruitmentCycle.deleteOne({ _id: id }, { session })
  })
  if (!existed) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole('grader')
  if (auth instanceof NextResponse) return auth

  await connectDB()
  const { id } = await params
  if (!isObjectId(id)) return NextResponse.json({ error: 'Invalid cycle id.' }, { status: 400 })
  const cycle = await RecruitmentCycle.findById(id).lean()
  if (!cycle) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ ...cycle, id: cycle._id.toString(), _id: undefined })
}
