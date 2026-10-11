import mongoose from 'mongoose'
import { Round, Review } from '@/lib/models'
import { GenericReview, PSEvaluationContribution, RubricVersion } from './models'
import { WorkflowError } from './domain'
import { validateRubric } from './rubrics'
import { lockRound } from './rounds'
import { objectId, serialize } from './records'
export async function publishRubric(roundId: string, body: Record<string, unknown>, actor: string) {
  let result: Record<string, unknown> = {}
  await mongoose.connection.transaction(async tx => {
    const round = await lockRound(roundId, tx)
    if (body.configuration_version !== round.configuration_version) throw new WorkflowError('Round configuration changed. Refresh first.', 409)
    if (await GenericReview.exists({ round_id: roundId }).session(tx) || await Review.exists({ round_id: roundId }).session(tx) || await PSEvaluationContribution.exists({ round_id: roundId }).session(tx)) throw new WorkflowError('Submitted reviews freeze the round rubric. Create a future round to use a different version.', 409)
    let version
    if (body.assign_version_id) {
      objectId(String(body.assign_version_id))
      version = await RubricVersion.findOne({ _id: body.assign_version_id, round_id: roundId }).session(tx).lean()
      if (!version) throw new WorkflowError('Select a rubric version belonging to this round.')
    } else {
      const config = validateRubric(body)
      const last = await RubricVersion.findOne({ round_id: roundId }).sort({ version: -1 }).session(tx).lean()
      const [created] = await RubricVersion.create([{ ...config, round_id: roundId, version: (last?.version ?? 0) + 1, created_by: actor }], { session: tx })
      version = created.toObject()
    }
    await Round.updateOne({ _id: roundId }, { $set: { rubric_version_id: version!._id }, $inc: { configuration_version: 1 } }, { session: tx })
    result = serialize(version!)
  })
  return result
}
