import { createHash } from 'crypto'
import mongoose from 'mongoose'
import { AuthorizedUser, GraderAssignment, RecruitmentCycle, Review } from '@/lib/models'
import { CandidateRound } from './models'
import { WorkflowError, pairLabel, type InterviewerPair } from './domain'
import { planAssignments, AssignmentPair } from './assignments'
import { firstRoundApplicants, enrollFirstRound } from './enrollment'
import { lockRound, psRound } from './rounds'
type AssignmentRow = { _id: unknown; applicant_id: unknown; grader_email: string; panel_id?: string | null; submission_count?: number }
// Pair rounds plan over pairs instead of people; each planned (applicant, pair) becomes one row per member.
function units(round: { assignment_mode?: string; interviewer_pairs?: InterviewerPair[]; eligible_grader_emails: string[] }) {
  const pairs = round.assignment_mode === 'pair' ? round.interviewer_pairs ?? [] : null
  return { pairs, ids: pairs ? pairs.map(p => p.id) : round.eligible_grader_emails }
}
const unitOf = (row: AssignmentRow, pairs: InterviewerPair[] | null) => pairs ? row.panel_id ?? `unpaired:${row.grader_email}` : row.grader_email
async function snapshot(roundId: string, tx?: mongoose.ClientSession) {
  const round = await psRound(roundId, tx)
  if (round.archived || !['pending', 'grading'].includes(round.status)) throw new WorkflowError('Assignments require a pending or active grading round.', 409)
  if (round.grading_access === 'open') throw new WorkflowError('This round uses open grading, so there is nothing to assign. Use Start grading instead.', 409)
  if (!await RecruitmentCycle.exists({ _id: round.cycle_id, status: 'active' }).session(tx ?? null)) throw new WorkflowError('An active cycle is required.', 409)
  const users = await AuthorizedUser.find({ email: mongoose.trusted({ $in: round.eligible_grader_emails }) }).session(tx ?? null).select('email').lean()
  if (users.length !== round.eligible_grader_emails.length) throw new WorkflowError('A selected grader is no longer authorized. Resolve this before generation.', 409)
  const { pairs, ids } = units(round)
  if (pairs && pairs.length < round.reviews_required) throw new WorkflowError(pairs.length ? `This round needs at least ${round.reviews_required} interviewer pairs. Add pairs in Setup & graders.` : 'Add interviewer pairs in Setup & graders before generating assignments.', 409)
  const first = await firstRoundApplicants(round, tx)
  const enrollments = await CandidateRound.find({ round_id: roundId }).session(tx ?? null).lean()
  // Terminal decisions are frozen; generation never adds or removes work for them.
  const eligible = new Set(first ? first.map(a => String(a._id)) : enrollments.map(e => String(e.applicant_id)))
  const inactive = new Set(enrollments.filter(e => ['advanced', 'hold', 'rejected', 'accepted'].includes(e.state)).map(e => String(e.applicant_id)))
  const assignments = await GraderAssignment.find({ round_id: roundId }).session(tx ?? null).lean() as AssignmentRow[]
  const reviews = await Review.find({ round_id: roundId }).session(tx ?? null).select('applicant_id grader_email').lean()
  if (reviews.length) throw new WorkflowError('This PS round contains legacy reviews. Resolve the format conflict before generation.', 409)
  const genericReviews = await mongoose.connection.collection('genericreviews').find({ round_id: new mongoose.Types.ObjectId(roundId) }, { session: tx }).toArray()
  const contributions = await mongoose.connection.collection('psevaluationcontributions').find({ round_id: new mongoose.Types.ObjectId(roundId) }, { session: tx }).toArray()
  const unitFor = (applicantId: string, email: string) => {
    const row = assignments.find(a => String(a.applicant_id) === applicantId && a.grader_email === email)
    return row ? unitOf(row, pairs) : pairs ? `unpaired:${email}` : email
  }
  const pair = (applicant_id: string, unit: string): AssignmentPair => ({ applicant_id, grader_email: unit })
  const existing = [...new Map(assignments.map(a => { const p = pair(String(a.applicant_id), unitOf(a, pairs)); return [`${p.applicant_id}:${p.grader_email}`, p] })).values()]
  const completedRows = [...genericReviews, ...contributions].map(r => pair(String(r.applicant_id), unitFor(String(r.applicant_id), String(r.grader_email))))
  const completed = [...new Map(completedRows.map(p => [`${p.applicant_id}:${p.grader_email}`, p])).values()]
  const activeIds = [...eligible].filter(id => !inactive.has(id))
  const plan = planAssignments({ applicantIds: [...eligible], eligibleEmails: ids, reviewsRequired: round.reviews_required, existing, completed, frozenApplicantIds: [...inactive], seed: roundId })
  const label = (unit: string) => pairs?.find(p => p.id === unit) ? pairLabel(pairs.find(p => p.id === unit)!) : unit
  const token = createHash('sha256').update(JSON.stringify({ version: round.configuration_version, eligible: [...eligible].sort(), states: enrollments.map(e => [String(e.applicant_id), e.state]).sort(), assignments: existing.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), completed, rows: plan.rows, removals: plan.removals })).digest('hex')
  return { ...plan, round, pairs, assignments, workload: plan.workload.map(w => ({ ...w, email: label(w.email) })), applicants: activeIds.length, reviews_required: round.reviews_required, mode: pairs ? 'pair' : 'individual', preview_token: token, configuration_version: round.configuration_version }
}
export async function previewAssignments(roundId: string) {
  const plan = await snapshot(roundId)
  return { applicants: plan.applicants, reviews_required: plan.reviews_required, mode: plan.mode, total: plan.total, additions: plan.additions.length, removals: plan.removals.length, spread: plan.spread, workload: plan.workload, preview_token: plan.preview_token, configuration_version: plan.configuration_version }
}
export async function generateAssignments(roundId: string, token: unknown, actor: string) {
  if (typeof token !== 'string' || token.length !== 64) throw new WorkflowError('Preview assignments before generating.')
  let added = 0, removed = 0
  await mongoose.connection.transaction(async tx => {
    const round = await lockRound(roundId, tx)
    const plan = await snapshot(roundId, tx)
    if (plan.preview_token !== token) throw new WorkflowError('The preview is stale. Preview again before generating.', 409)
    if (!plan.applicants) throw new WorkflowError('No active applicants to assign. Enroll or advance applicants first.', 409)
    if (await firstRoundApplicants(round, tx)) await enrollFirstRound(roundId, actor, tx)
    const users = await AuthorizedUser.updateMany({ email: mongoose.trusted({ $in: round.eligible_grader_emails }) }, { $inc: { assignment_write_count: 1 } }, { session: tx })
    if (users.modifiedCount !== round.eligible_grader_emails.length) throw new WorkflowError('Eligible graders changed. Refresh.', 409)
    // Removals only ever touch unstarted rows; the submission_count guard rejects anything else.
    const removeIds = plan.removals.flatMap(r => plan.assignments.filter(a => String(a.applicant_id) === r.applicant_id && unitOf(a, plan.pairs) === r.grader_email).map(a => a._id))
    if (removeIds.length) {
      const result = await GraderAssignment.deleteMany({ _id: mongoose.trusted({ $in: removeIds }), round_id: roundId, submission_count: 0 }, { session: tx })
      if (result.deletedCount !== removeIds.length) throw new WorkflowError('An assignment was started while you were previewing. Preview again.', 409)
    }
    const rows: { applicant_id: string; grader_email: string; panel_id: string | null }[] = plan.additions.flatMap(a => plan.pairs ? plan.pairs.find(p => p.id === a.grader_email)!.emails.map(email => ({ applicant_id: a.applicant_id, grader_email: email, panel_id: a.grader_email })) : [{ ...a, panel_id: null as string | null }])
    if (rows.length) await GraderAssignment.bulkWrite(rows.map(({ panel_id, ...row }) => ({ updateOne: { filter: { round_id: roundId, ...row }, update: { $setOnInsert: { assigned_at: new Date(), panel_id } }, upsert: true } })), { session: tx })
    await syncReviewStates(roundId, round.reviews_required, tx)
    await mongoose.model('Round').updateOne({ _id: roundId }, { $set: { status: 'grading' } }, { session: tx })
    added = plan.additions.length; removed = plan.removals.length
  })
  return { ok: true, added, removed }
}
// After N changes, candidates move between "in review" and "ready" based on completed evaluations.
async function syncReviewStates(roundId: string, required: number, tx: mongoose.ClientSession) {
  const id = new mongoose.Types.ObjectId(roundId)
  const done = new Map<string, Set<string>>()
  for (const collection of ['genericreviews', 'psevaluationcontributions']) for (const r of await mongoose.connection.collection(collection).find({ round_id: id }, { session: tx }).toArray()) {
    const key = String(r.applicant_id); done.set(key, (done.get(key) ?? new Set()).add(String(r.grader_email)))
  }
  const active = await CandidateRound.find({ round_id: roundId, state: mongoose.trusted({ $in: ['pending', 'in_review', 'ready_for_deliberation'] }) }).session(tx).lean()
  for (const e of active) {
    const state = (done.get(String(e.applicant_id))?.size ?? 0) >= required ? 'ready_for_deliberation' : 'in_review'
    if (state !== e.state) await CandidateRound.updateOne({ _id: e._id, state: e.state }, { $set: { state } }, { session: tx })
  }
}
export async function reassignPending(roundId: string, assignmentId: string, target: unknown, actor: string) {
  if (typeof target !== 'string' || !target.trim()) throw new WorkflowError('Select who should receive this assignment.')
  let result: Record<string, unknown> = {}
  await mongoose.connection.transaction(async tx => {
    const round = await lockRound(roundId, tx)
    if (round.status !== 'grading') throw new WorkflowError('Reassignment requires an active grading round.', 409)
    if (round.grading_access === 'open') throw new WorkflowError('Open rounds have no assignments to transfer.', 409)
    const assignment = await GraderAssignment.findOne({ _id: assignmentId, round_id: roundId }).session(tx).lean()
    if (!assignment) throw new WorkflowError('Assignment not found.', 404)
    const enrolled = await CandidateRound.findOne({ round_id: roundId, applicant_id: assignment.applicant_id }).session(tx).lean()
    if (!enrolled || !['pending', 'in_review'].includes(enrolled.state)) throw new WorkflowError('This applicant is not accepting reassignment.', 409)
    const generic = mongoose.connection.collection('genericreviews')
    if (round.assignment_mode === 'pair') {
      // Pair rounds move the whole pair's assignment to another pair.
      const pairs = (round.interviewer_pairs ?? []) as InterviewerPair[], to = pairs.find(p => p.id === target)
      if (!to) throw new WorkflowError('Select a configured interviewer pair.', 409)
      if (assignment.panel_id === to.id) throw new WorkflowError('Choose a different pair.')
      const rows = await GraderAssignment.find({ round_id: roundId, applicant_id: assignment.applicant_id, panel_id: assignment.panel_id }).session(tx).lean()
      if (rows.some(r => r.submission_count)) throw new WorkflowError('Completed evaluations cannot be reassigned.', 409)
      if (await GraderAssignment.exists({ round_id: roundId, applicant_id: assignment.applicant_id, grader_email: mongoose.trusted({ $in: to.emails }) }).session(tx)) throw new WorkflowError('Someone in that pair already has this applicant.', 409)
      const users = await AuthorizedUser.updateMany({ email: mongoose.trusted({ $in: to.emails }) }, { $inc: { assignment_write_count: 1 } }, { session: tx })
      if (users.modifiedCount !== to.emails.length) throw new WorkflowError('Someone in the receiving pair is no longer authorized.', 409)
      const removed = await GraderAssignment.deleteMany({ _id: mongoose.trusted({ $in: rows.map(r => r._id) }), submission_count: 0 }, { session: tx })
      if (removed.deletedCount !== rows.length) throw new WorkflowError('Assignment changed. Refresh before transferring.', 409)
      await GraderAssignment.insertMany(to.emails.map(email => ({ round_id: roundId, applicant_id: assignment.applicant_id, grader_email: email, panel_id: to.id })), { session: tx })
      await CandidateRound.updateOne({ _id: enrolled._id }, { $push: { events: { action: `reassigned:${assignment.panel_id}:${to.id}`, actor, at: new Date() } } }, { session: tx })
      result = { ok: true }; return
    }
    const email = target.trim().toLowerCase()
    if (!round.eligible_grader_emails.includes(email)) throw new WorkflowError('Select an eligible receiving grader.', 409)
    if (assignment.grader_email === email) throw new WorkflowError('Choose a different grader.')
    if (assignment.submission_count || await generic.findOne({ round_id: round._id, applicant_id: assignment.applicant_id, grader_email: assignment.grader_email }, { session: tx })) throw new WorkflowError('Completed reviews cannot be reassigned.', 409)
    if (await GraderAssignment.exists({ round_id: roundId, applicant_id: assignment.applicant_id, grader_email: email }).session(tx) || await generic.findOne({ round_id: round._id, applicant_id: assignment.applicant_id, grader_email: email }, { session: tx })) throw new WorkflowError('The receiving grader already has an assignment or review for this applicant.', 409)
    const user = await AuthorizedUser.updateOne({ email }, { $inc: { assignment_write_count: 1 } }, { session: tx })
    if (user.modifiedCount !== 1) throw new WorkflowError('The receiving grader is no longer authorized.', 409)
    const updated = await GraderAssignment.findOneAndUpdate({ _id: assignmentId, round_id: roundId, submission_count: 0 }, { $set: { grader_email: email, assigned_at: new Date() } }, { returnDocument: 'after', session: tx }).lean()
    if (!updated) throw new WorkflowError('Assignment changed. Refresh before transferring.', 409)
    await CandidateRound.updateOne({ _id: enrolled._id }, { $push: { events: { action: `reassigned:${assignment.grader_email}:${email}`, actor, at: new Date() } } }, { session: tx })
    result = { ok: true }
  })
  return result
}
