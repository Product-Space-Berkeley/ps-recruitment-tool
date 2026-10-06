import mongoose from 'mongoose'
import { Round, Review } from '@/lib/models'
import { GenericReview, PSEvaluationContribution, RubricDraft, RubricVersion, RubricScoringConfiguration } from './models'
import { WorkflowError } from './domain'
import { lockRound, psRound } from './rounds'
import { objectId, serialize } from './records'
import { validateWeighted, isWeighted } from './weightedRubric'
import { validatePoints, isPoints, scoringChanges, POINTS_POLICY } from './points'
import type { Structure } from './rubricV2'
import { AnyRubric, copyStructure } from './rubricCompatibility'
// Drafts created before points scoring keep their per-question weights; new drafts use points.
function validateDraft(input: unknown, publishing = false) {
  return input && typeof input === 'object' && isPoints(input as Structure) ? validatePoints(input, publishing) : validateWeighted(input, publishing)
}

export async function createDraft(roundId: string, body: Record<string, unknown>, actor: string) {
  await psRound(roundId)
  let structure = body.structure
  let provenance: Record<string, string> = { kind: 'manual' }
  if (body.source_version_id) {
    objectId(String(body.source_version_id))
    const source = await RubricVersion.findById(body.source_version_id).lean()
    if (!source) throw new WorkflowError('Source rubric not found.', 404)
    await psRound(String(source.round_id))
    structure = copyStructure(serialize(source) as unknown as AnyRubric)
    provenance = { kind: 'copy', source_version_id: String(source._id) }
  } else if (body.provenance) {
    if (typeof body.provenance !== 'object' || Array.isArray(body.provenance)) throw new WorkflowError('Invalid import provenance.')
    const p = body.provenance as Record<string, unknown>
    if (!['xlsx', 'csv', 'json'].includes(String(p.kind))) throw new WorkflowError('Invalid import source.')
    provenance = { kind: String(p.kind) }
    for (const key of ['fingerprint', 'file_name', 'sheet']) {
      if (typeof p[key] !== 'string' || (p[key] as string).length > 200) throw new WorkflowError('Invalid import provenance.')
      provenance[key] = p[key] as string
    }
  }
  const config = validateDraft(structure)
  let result: Record<string, unknown> = {}
  await mongoose.connection.transaction(async tx => {
    await lockRound(roundId, tx)
    const [draft] = await RubricDraft.create([{ ...config, round_id: roundId, provenance, created_by: actor, updated_by: actor }], { session: tx })
    result = serialize(draft.toObject())
  })
  return result
}
export async function getDraft(id: string) {
  objectId(id)
  const draft = await RubricDraft.findById(id).lean()
  if (!draft) throw new WorkflowError('Rubric draft not found.', 404)
  await psRound(String(draft.round_id))
  return draft
}
export async function updateDraft(id: string, body: Record<string, unknown>, actor: string) {
  const initial = await getDraft(id)
  if (!Number.isInteger(body.revision) || Number(body.revision) < 0) throw new WorkflowError('Draft revision required.')
  const config = validateDraft(body.structure)
  let result: Record<string, unknown> = {}
  await mongoose.connection.transaction(async tx => {
    await lockRound(String(initial.round_id), tx)
    const updated = await RubricDraft.findOneAndUpdate({ _id: id, revision: body.revision, status: 'editing' }, { $set: { ...config, updated_by: actor }, $inc: { revision: 1 } }, { returnDocument: 'after', runValidators: true, session: tx }).lean()
    if (!updated) throw new WorkflowError('Draft changed or was published. Reload before editing.', 409)
    result = serialize(updated)
  })
  return result
}
export async function publishDraft(id: string, body: Record<string, unknown>, actor: string) {
  const initial = await getDraft(id)
  let result: Record<string, unknown> = {}
  await mongoose.connection.transaction(async tx => {
    const roundId = String(initial.round_id), round = await lockRound(roundId, tx)
    const draft = await RubricDraft.findById(id).session(tx).lean()
    if (!draft) throw new WorkflowError('Draft not found.', 404)
    if (draft.status === 'published') {
      result = serialize((await RubricVersion.findById(draft.published_version_id).session(tx).lean())!)
      return
    }
    if (draft.revision !== body.revision || body.configuration_version !== round.configuration_version) throw new WorkflowError('Draft or round changed. Save and refresh before publishing.', 409)
    const graded = await GenericReview.exists({ round_id: roundId }).session(tx) || await Review.exists({ round_id: roundId }).session(tx) || await PSEvaluationContribution.exists({ round_id: roundId }).session(tx)
    if (graded && !isWeighted(draft) && !isPoints(draft)) throw new WorkflowError('Submitted reviews freeze the round rubric. Copy into a future round.', 409)
    const config = validateDraft(draft, true)
    if (graded && isPoints(config)) {
      const active = round.rubric_version_id ? await RubricVersion.findById(round.rubric_version_id).session(tx).lean() : null
      const changes = active && isPoints(active) ? scoringChanges(active as unknown as Structure, config) : ['the scoring format']
      if (changes.length) throw new WorkflowError(`Grading has started, so only wording can change. This draft changes ${changes.join(' and ')}. Undo those changes, or use the rubric in a future round.`, 409)
    }
    const last = await RubricVersion.findOne({ round_id: roundId }).sort({ version: -1 }).session(tx).lean()
    const versionId = new mongoose.Types.ObjectId(), scoringId = new mongoose.Types.ObjectId()
    const [version] = await RubricVersion.create([{ _id: versionId, ...config, round_id: roundId, version: (last?.version ?? 0) + 1, source_draft_id: id, scoring_configuration_id: scoringId, created_by: actor }], { session: tx })
    await RubricScoringConfiguration.create([{ _id: scoringId, rubric_version_id: versionId, engine: isPoints(config) ? POINTS_POLICY : isWeighted(config) ? 'question_weighted_0_3' : 'unconfigured', question_weights: isWeighted(config) ? config.questions.filter(q => q.format === 'number').map(q => ({ question_id: q.id, weight_bps: q.weight_bps })) : undefined, weighting: config.weighting, category_weights: config.categories.map(c => ({ category_id: c.id, weight_bps: c.weight_bps })), created_by: actor }], { session: tx })
    const saved = await RubricDraft.updateOne({ _id: id, revision: body.revision, status: 'editing' }, { $set: { status: 'published', published_version_id: versionId, updated_by: actor }, $inc: { revision: 1 } }, { session: tx })
    if (!saved.modifiedCount) throw new WorkflowError('Draft changed. Reload.', 409)
    await Round.updateOne({ _id: roundId }, { $set: { rubric_version_id: versionId }, $inc: { configuration_version: 1 } }, { session: tx })
    result = serialize(version.toObject())
  })
  return result
}
