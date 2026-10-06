import mongoose from 'mongoose'
import { AuthorizedUser, RecruitmentCycle, Round, GraderAssignment, Review, Session } from '@/lib/models'
import { WorkflowError, validateConfiguration, validateOrder } from './domain'
import { objectId, serialize } from './records'
import { RubricDraft } from './models'
import { PS_STANDARD_ROUNDS } from './templates'
export async function psRound(id: string, tx?: mongoose.ClientSession) {
  objectId(id)
  const round = await Round.findOne({ _id: id, workflow: 'ps' }).session(tx ?? null).lean()
  if (!round) throw new WorkflowError('Configured PS round not found.', 404)
  return round
}
export async function lockCycle(id: string, tx: mongoose.ClientSession) {
  const cycle = await RecruitmentCycle.findOneAndUpdate({ _id: id, status: 'active' }, { $inc: { lifecycle_write_count: 1 } }, { session: tx, returnDocument: 'after' }).lean()
  if (!cycle) throw new WorkflowError('An active cycle is required.', 409)
}
export async function lockRound(id: string, tx: mongoose.ClientSession) {
  const round = await psRound(id, tx)
  await lockCycle(String(round.cycle_id), tx)
  const locked = await Round.findOneAndUpdate({ _id: id, workflow: 'ps', archived: false, status: mongoose.trusted({ $ne: 'ended' }) }, { $inc: { lifecycle_write_count: 1 } }, { session: tx, returnDocument: 'after' }).lean()
  if (!locked) throw new WorkflowError('This round is archived or ended.', 409)
  return locked
}
export async function hasRoundActivity(id: string, tx: mongoose.ClientSession) {
  // New collections are checked without coupling this shared module to their models.
  for (const model of [GraderAssignment, Review, Session]) if (await model.exists({ round_id: id }).session(tx)) return true
  for (const collection of ['candidaterounds', 'genericreviews', 'candidateroundscores', 'psevaluationcontributions', 'psevaluationrevisions']) if (await mongoose.connection.collection(collection).findOne({ round_id: new mongoose.Types.ObjectId(id) }, { session: tx })) return true
  return false
}
// Batch read state for setup controls. Server mutation checks remain authoritative.
export async function configurationStates(ids: string[]) {
  const filter = { round_id: { $in: ids.map(id => new mongoose.Types.ObjectId(id)) } }
  const collections = ['graderassignments', 'reviews', 'sessions', 'candidaterounds', 'genericreviews', 'candidateroundscores', 'psevaluationcontributions', 'psevaluationrevisions']
  const evidence = await Promise.all(collections.map(collection => mongoose.connection.collection(collection).distinct('round_id', filter)))
  const activity = new Set(evidence.flat().map(String))
  const reviews = new Set([...evidence[1], ...evidence[4], ...evidence[6]].map(String))
  return new Map(ids.map(id => [id, { configuration_locked: activity.has(id), rubric_locked: reviews.has(id) }]))
}
async function validateGraders(emails: string[], tx: mongoose.ClientSession) {
  const users = await AuthorizedUser.find({ email: mongoose.trusted({ $in: emails }) }).session(tx).select('email').lean()
  if (users.length !== emails.length) throw new WorkflowError('Every selected grader must still be an authorized user.')
}
export async function createRound(cycleId: string, body: Record<string, unknown>) {
  objectId(cycleId)
  const config = validateConfiguration(body)
  let result: Record<string, unknown> = {}
  await mongoose.connection.transaction(async tx => {
    await lockCycle(cycleId, tx)
    await validateGraders(config.eligible_grader_emails, tx)
    const last = await Round.findOne({ cycle_id: cycleId }).sort({ order_index: -1 }).session(tx).lean()
    const [round] = await Round.create([{ ...config, cycle_id: cycleId, workflow: 'ps', role: null, order_index: (last?.order_index ?? 0) + 1 }], { session: tx })
    result = serialize(round.toObject())
  })
  return result
}
export async function updateRound(id: string, body: Record<string, unknown>) {
  const allowed = new Set(['name', 'evaluation_type', 'reviews_required', 'eligible_grader_emails', 'assignment_mode', 'interviewer_pairs', 'archived', 'status', 'configuration_version'])
  if (Object.keys(body).some(key => !allowed.has(key))) throw new WorkflowError('Unsupported round setting. Use the ordering or rubric endpoint for those changes; PS scoring is not configured.')
  if (typeof body.configuration_version !== 'number' || !Number.isInteger(body.configuration_version) || body.configuration_version < 0) throw new WorkflowError('A valid round configuration version is required.')
  if (Object.keys(body).every(key => key === 'configuration_version')) throw new WorkflowError('Supply a round setting to change.')
  let result: Record<string, unknown> = {}
  await mongoose.connection.transaction(async tx => {
    const round = await psRound(id, tx)
    await lockCycle(String(round.cycle_id), tx)
    if (body.configuration_version !== round.configuration_version) throw new WorkflowError('Configuration changed. Refresh before saving.', 409)
    if (round.status === 'ended') throw new WorkflowError('Ended rounds are read-only.', 409)
    if ('status' in body && body.status !== 'ended') throw new WorkflowError('Only ending grading is supported here; final decisions stay in the existing workflow.')
    const config = validateConfiguration({ ...round, ...body })
    // Graders, pairs and reviews per candidate stay adjustable during grading; generating again applies them.
    // What kind of round it is cannot change once work exists.
    const graderChange = JSON.stringify(config.eligible_grader_emails) !== JSON.stringify(round.eligible_grader_emails)
    const kindChange = config.evaluation_type !== round.evaluation_type || config.assignment_mode !== (round.assignment_mode ?? 'individual')
    if (graderChange) await validateGraders(config.eligible_grader_emails, tx)
    if ((kindChange || body.archived === true) && await hasRoundActivity(id, tx)) throw new WorkflowError('The round type and assignment mode are frozen after enrollment or grading begins. Create a future round instead.', 409)
    if ('archived' in body && typeof body.archived !== 'boolean') throw new WorkflowError('Archived must be true or false.')
    const updated = await Round.findByIdAndUpdate(id, { $set: { ...config, archived: body.archived ?? round.archived, status: body.status ?? round.status }, $inc: { configuration_version: 1, lifecycle_write_count: 1 } }, { returnDocument: 'after', session: tx }).lean()
    result = serialize(updated!)
  })
  return result
}
export async function reorderRounds(cycleId: string, ids: unknown, version: unknown) {
  objectId(cycleId)
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) throw new WorkflowError('A valid cycle configuration version is required.')
  await mongoose.connection.transaction(async tx => {
    const cycle = await RecruitmentCycle.findOneAndUpdate({ _id: cycleId, status: 'active', configuration_version: version }, { $inc: { configuration_version: 1, lifecycle_write_count: 1 } }, { session: tx, returnDocument: 'after' }).lean()
    if (!cycle) throw new WorkflowError('Cycle configuration changed or is closed. Refresh before reordering.', 409)
    const rounds = await Round.find({ cycle_id: cycleId, workflow: 'ps' }).session(tx).lean()
    const ordered = validateOrder(rounds.map(r => ({ id: String(r._id), order_index: r.order_index })), ids)
    for (const round of rounds) if (await hasRoundActivity(String(round._id), tx)) throw new WorkflowError('Reordering is unavailable once round enrollment or grading begins.', 409)
    const legacy = await Round.find({ cycle_id: cycleId, workflow: mongoose.trusted({ $ne: 'ps' }) }).session(tx).select('order_index').lean()
    const offset = Math.max(0, ...legacy.map(r => r.order_index))
    // Vacate all positions before swaps to respect the existing unique role/order index.
    for (const [i, id] of ordered.entries()) await Round.updateOne({ _id: id }, { $set: { order_index: -i - 1 } }, { session: tx })
    for (const [i, id] of ordered.entries()) await Round.updateOne({ _id: id }, { $set: { order_index: offset + i + 1 }, $inc: { configuration_version: 1, lifecycle_write_count: 1 } }, { session: tx })
  })
}
// Creates PS's fixed sequence (Written App → PD → Final) with each FA26 form as an editable draft.
// Interview rounds use interviewer pairs (one form per pair); leadership picks the pairs before assigning.
export async function createStandardRounds(cycleId: string, body: Record<string, unknown>, actor: string) {
  objectId(cycleId)
  const first = validateConfiguration({ ...body, name: PS_STANDARD_ROUNDS[0].name, evaluation_type: PS_STANDARD_ROUNDS[0].evaluation_type })
  const created: Record<string, unknown>[] = []
  // In development, a model's first use builds its indexes; writing to that collection inside the
  // transaction at the same moment fails with a lock timeout. Finish initialization first.
  await Promise.all([Round.init(), RubricDraft.init()])
  await mongoose.connection.transaction(async tx => {
    await lockCycle(cycleId, tx)
    if (await Round.exists({ cycle_id: cycleId, workflow: 'ps' }).session(tx)) throw new WorkflowError('This cycle already has PS rounds. Add or edit rounds individually instead.', 409)
    await validateGraders(first.eligible_grader_emails, tx)
    const last = await Round.findOne({ cycle_id: cycleId }).sort({ order_index: -1 }).session(tx).lean()
    for (const [i, standard] of PS_STANDARD_ROUNDS.entries()) {
      const config = { ...first, name: standard.name, evaluation_type: standard.evaluation_type, reviews_required: i === 0 ? first.reviews_required : 1, assignment_mode: standard.assignment_mode, interviewer_pairs: [] }
      const [round] = await Round.create([{ ...config, cycle_id: cycleId, workflow: 'ps', role: null, order_index: (last?.order_index ?? 0) + i + 1 }], { session: tx })
      await RubricDraft.create([{ ...standard.template(), round_id: round._id, provenance: { kind: 'template' }, created_by: actor, updated_by: actor }], { session: tx })
      created.push(serialize(round.toObject()))
    }
  })
  return created
}
