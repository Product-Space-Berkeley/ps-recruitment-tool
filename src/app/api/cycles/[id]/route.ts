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
import { MAX_PROMPTS, MIN_PROMPTS } from '@/lib/applicationFields'

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
  if ('application_wording' in body) {
    if (auth.role !== 'admin') return NextResponse.json({ error: 'Only admins can edit application wording.' }, { status: 403 })
    const raw = body.application_wording
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return NextResponse.json({ error: 'Invalid application wording.' }, { status: 400 })
    const value = raw as Record<string, unknown>
    const fields = ['meeting_prompt', 'retreat_prompt', 'availability_hint']
    if (fields.some(key => typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 2000)
      || typeof value.weekly_hours !== 'number' || !Number.isInteger(value.weekly_hours) || value.weekly_hours < 1 || value.weekly_hours > 168) {
      return NextResponse.json({ error: 'Enter each prompt (up to 2,000 characters) and weekly hours between 1 and 168.' }, { status: 400 })
    }
    allowed.application_wording = Object.fromEntries([...fields.map(key => [key, (value[key] as string).trim()]), ['weekly_hours', value.weekly_hours]])
  }
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
      if (allowed.application_wording && (current.status !== 'active' || current.accepting_applications || current.submission_count > 0 || await Applicant.exists({ cycle_id: id }).session(session))) {
        conflict = 'wording-locked'; return
      }

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
        const completePrompts = prompts.length >= MIN_PROMPTS
          && prompts.length <= MAX_PROMPTS
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

  if (conflict === 'wording-locked') return NextResponse.json({ error: 'Close applications before editing wording. Wording is locked once someone has applied or the cycle has ended.' }, { status: 409 })
  if (conflict === 'missing') return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (conflict === 'requirements') {
    return NextResponse.json(
      { error: `Applications require an active cycle, ${MIN_PROMPTS}–${MAX_PROMPTS} essay prompts that each have two grading criteria, and a future deadline.` },
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
  const auth = await requireRole('admin')
  if (auth instanceof NextResponse) return auth

  await connectDB()
  const { id } = await params
  if (!isObjectId(id)) return NextResponse.json({ error: 'Invalid cycle id.' }, { status: 400 })

  let existed = false
  let activeCycle = false
  await mongoose.connection.transaction(async session => {
    activeCycle = false
    existed = false
    const cycle = await RecruitmentCycle.findOneAndUpdate({ _id: id }, { $inc: { lifecycle_write_count: 1 } }, { session, returnDocument: 'after' }).select('_id status').lean()
    if (!cycle) return
    if (cycle.status !== 'ended') { activeCycle = true; return }
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
    if (sessionIds.length) await mongoose.connection.collection('socialcards').deleteMany({ session_id: { $in: sessionIds } }, { session })
    if (sessionIds.length) await SessionMember.deleteMany({ session_id: mongoose.trusted({ $in: sessionIds }) }, { session })
    if (sessionIds.length) await SessionBan.deleteMany({ session_id: mongoose.trusted({ $in: sessionIds }) }, { session })
    if (sessionIds.length) await DeliberationSession.deleteMany({ _id: mongoose.trusted({ $in: sessionIds }) }, { session })
    // Permanent cycle deletion is the explicit exception to append-only grading
    // records. Native collection operations remain scoped to this ended cycle
    // and participate in the same transaction as the rest of the cascade.
    if (roundIds.length) {
      const filter = { round_id: { $in: roundIds } }
      const versions = await mongoose.connection.collection('rubricversions').find(filter, { session, projection: { _id: 1 } }).toArray()
      await mongoose.connection.collection('rubricscoringconfigurations').deleteMany({ rubric_version_id: { $in: versions.map(v => v._id) } }, { session })
      for (const collection of ['outboxes', 'interviewslots', 'interviewbookings', 'reviewconflicts', 'candidaterounds', 'rubricdrafts', 'rubricversions', 'genericreviews', 'psevaluationrevisions', 'psevaluationcontributions', 'candidateroundscores']) {
        await mongoose.connection.collection(collection).deleteMany(filter, { session })
      }
    }
    await Round.deleteMany({ cycle_id: id }, { session })
    await Applicant.deleteMany({ cycle_id: id }, { session })
    await EssayPrompt.deleteMany({ cycle_id: id }, { session })
    await CoffeeChatNote.deleteMany({ cycle_id: id }, { session })
    await RecruitmentCycle.deleteOne({ _id: id }, { session })
  })
  if (activeCycle) return NextResponse.json({ error: 'End the cycle before deleting it.' }, { status: 409 })
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
