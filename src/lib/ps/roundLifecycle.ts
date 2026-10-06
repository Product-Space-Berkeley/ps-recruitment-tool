import { createHash } from 'crypto'
import mongoose from 'mongoose'
import { Applicant, GraderAssignment, Round } from '@/lib/models'
import { CandidateRound, CandidateRoundScore, PSEvaluationContribution, PSEvaluationRevision } from './models'
import { WorkflowError, pairLabel, type InterviewerPair } from './domain'
import { lockRound, psRound } from './rounds'
import { firstRoundApplicants, enrollFirstRound } from './enrollment'
import { liveRoundScores } from './scoreService'
import { CANDIDATE_ENGINE } from './candidateScores'
const ACTIVE = ['pending', 'in_review', 'ready_for_deliberation']

// Who still owes work this round: one row per grader (or interviewer pair), plus round totals.
export async function roundProgress(roundId: string) {
  const round = await psRound(roundId)
  const enrollments = await CandidateRound.find({ round_id: roundId }).select('applicant_id state').lean()
  const active = new Set(enrollments.filter(e => ACTIVE.includes(e.state)).map(e => String(e.applicant_id)))
  const assignments = await GraderAssignment.find({ round_id: roundId }).select('applicant_id grader_email panel_id submission_count').lean()
  const contributions = await PSEvaluationContribution.find({ round_id: roundId }).select('applicant_id grader_email evaluation_id').lean()
  const revisions = await PSEvaluationRevision.find({ round_id: roundId }).select('grader_email panel_emails submitted_at').lean()
  const current = revisions.filter(r => contributions.some(c => String(c.evaluation_id) === String(r._id)))
  const pairs = (round.interviewer_pairs ?? []) as InterviewerPair[], paired = round.assignment_mode === 'pair'
  const unitOf = (a: { grader_email: string; panel_id?: string | null }) => paired ? a.panel_id ?? a.grader_email : a.grader_email
  const units = new Map<string, { label: string; members: string[]; assigned: Set<string>; done: Set<string> }>()
  for (const a of assignments) {
    const key = unitOf(a), pair = pairs.find(p => p.id === key)
    const row = units.get(key) ?? { label: pair ? pairLabel(pair) : key, members: pair ? pair.emails : [a.grader_email], assigned: new Set<string>(), done: new Set<string>() }
    row.assigned.add(String(a.applicant_id)); if (a.submission_count) row.done.add(String(a.applicant_id)); units.set(key, row)
  }
  const doneByApplicant = new Map<string, number>()
  for (const c of contributions) doneByApplicant.set(String(c.applicant_id), (doneByApplicant.get(String(c.applicant_id)) ?? 0) + 1)
  const lastActive = (members: string[]) => revisions.filter(r => members.includes(r.grader_email)).reduce<Date | null>((latest, r) => !latest || r.submitted_at > latest ? r.submitted_at : latest, null)
  const needed = active.size * round.reviews_required
  const completed = [...active].reduce((n, id) => n + Math.min(doneByApplicant.get(id) ?? 0, round.reviews_required), 0)
  const incomplete = [...active].filter(id => (doneByApplicant.get(id) ?? 0) < round.reviews_required)
  const names = await Applicant.find({ _id: mongoose.trusted({ $in: incomplete }) }).select('first_name last_name').lean()
  return {
    status: round.status, mode: paired ? 'pair' : 'individual', reviews_required: round.reviews_required,
    candidates: active.size, ready: active.size - incomplete.length, evaluations_done: completed, evaluations_needed: needed,
    incomplete: names.map(a => ({ applicant_id: String(a._id), name: `${a.first_name} ${a.last_name}` })),
    grading_access: round.grading_access === 'open' ? 'open' : 'assigned',
    // Open rounds have no assignments: list every eligible grader with the evaluations they've submitted or co-interviewed.
    graders: round.grading_access === 'open'
      ? round.eligible_grader_emails.map((email: string) => ({ grader: email, assigned: null, done: current.filter(r => r.grader_email === email || r.panel_emails?.includes(email)).length, remaining: null, last_active: lastActive([email]) })).sort((a: { done: number; grader: string }, b: { done: number; grader: string }) => a.done - b.done || a.grader.localeCompare(b.grader))
      : [...units.values()].map(u => {
        const open = [...u.assigned].filter(id => active.has(id) && !u.done.has(id))
        return { grader: u.label, assigned: u.assigned.size as number | null, done: u.done.size, remaining: open.length as number | null, last_active: lastActive(u.members) }
      }).sort((a, b) => (b.remaining ?? 0) - (a.remaining ?? 0) || a.grader.localeCompare(b.grader)),
  }
}

// Close grading: freeze each candidate's score as a new snapshot and open the round for deliberation.
export async function closeRound(roundId: string, body: Record<string, unknown>, actor: string) {
  if (body.override !== undefined && typeof body.override !== 'boolean') throw new WorkflowError('Override must be true or false.')
  let result: Record<string, unknown> = {}
  // A collection's first use in development builds indexes; finish that before writing inside the transaction.
  await CandidateRoundScore.init()
  await mongoose.connection.transaction(async tx => {
    const round = await lockRound(roundId, tx)
    if (round.status !== 'grading') throw new WorkflowError('Only a round that is grading can be closed.', 409)
    const enrollments = await CandidateRound.find({ round_id: roundId }).session(tx).lean()
    const waiting = enrollments.filter(e => ['pending', 'in_review'].includes(e.state))
    if (waiting.length && body.override !== true) throw new WorkflowError(`${waiting.length} candidate${waiting.length === 1 ? ' is' : 's are'} still waiting for evaluations. Close anyway to freeze their scores as incomplete.`, 409)
    const live = await liveRoundScores(round, tx)
    const close_id = new mongoose.Types.ObjectId(), now = new Date()
    const rows = enrollments.map(e => {
      const c = live.candidates.find(c => c.applicant_id === String(e.applicant_id))
      const inputs = (c?.input_review_ids ?? []).sort()
      return {
        round_id: round._id, applicant_id: e.applicant_id, rubric_version_id: round.rubric_version_id ?? null,
        engine: live.engine ?? 'unconfigured', engine_version: live.engine ? '1' : null, status: c ? 'calculated' : 'unconfigured',
        input_review_ids: inputs, input_fingerprint: createHash('sha256').update(JSON.stringify([inputs, round.reviews_required])).digest('hex'),
        score: c?.score ?? null, percent: c?.percent ?? null, low: c?.low ?? null, high: c?.high ?? null, max_points: c?.max_points ?? null,
        reviews: c?.reviews ?? 0, required: round.reviews_required, complete: c?.complete ?? false,
        calculated_at: now, created_at: now, close_id, closed_by: actor,
      }
    })
    if (rows.length) await CandidateRoundScore.insertMany(rows, { session: tx })
    await Round.updateOne({ _id: roundId }, { $set: { status: 'deliberating' }, $inc: { configuration_version: 1 } }, { session: tx })
    result = { ok: true, close_id: String(close_id), frozen: rows.length, incomplete: waiting.length, engine: live.engine ?? CANDIDATE_ENGINE }
  })
  return result
}

// Reopen grading (for example, a late evaluation). The earlier snapshot stays; closing again adds a new one.
export async function reopenRound(roundId: string) {
  await mongoose.connection.transaction(async tx => {
    const round = await lockRound(roundId, tx)
    if (round.status !== 'deliberating') throw new WorkflowError('Only a closed round can be reopened for grading.', 409)
    await Round.updateOne({ _id: roundId }, { $set: { status: 'grading' }, $inc: { configuration_version: 1 } }, { session: tx })
  })
  return { ok: true }
}

// Open rounds have no assignment step: starting enrolls the first round's applicants and opens grading.
// Later rounds fill as candidates are advanced into them.
export async function startOpenRound(roundId: string, actor: string) {
  let result: Record<string, unknown> = {}
  await CandidateRound.init()
  await mongoose.connection.transaction(async tx => {
    const round = await lockRound(roundId, tx)
    if (round.grading_access !== 'open') throw new WorkflowError('This round uses assigned grading. Generate assignments instead.', 409)
    if (round.status !== 'pending') throw new WorkflowError('Grading has already started for this round.', 409)
    if (!round.rubric_version_id) throw new WorkflowError('Publish a rubric before starting grading.', 409)
    const enrolled = await firstRoundApplicants(round, tx) ? await enrollFirstRound(roundId, actor, tx) : await CandidateRound.countDocuments({ round_id: roundId }).session(tx)
    await Round.updateOne({ _id: roundId }, { $set: { status: 'grading' }, $inc: { configuration_version: 1 } }, { session: tx })
    result = { ok: true, candidates: enrolled }
  })
  return result
}
