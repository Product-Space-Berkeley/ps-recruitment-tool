import mongoose from 'mongoose'
import { Applicant, Round } from '@/lib/models'
import { CandidateRound } from './models'
import { WorkflowError, nextRound, transition } from './domain'
import { lockRound } from './rounds'
import { serialize } from './records'
export async function firstRoundApplicants(round: { _id: unknown; cycle_id: unknown }, tx?: mongoose.ClientSession) {
  const first = await Round.findOne({ cycle_id: round.cycle_id, workflow: 'ps', archived: false }).sort({ order_index: 1 }).session(tx ?? null).lean()
  if (String(first?._id) !== String(round._id)) return null
  return Applicant.find({ cycle_id: round.cycle_id }).select('_id').sort({ _id: 1 }).session(tx ?? null).lean()
}
export async function enrollFirstRound(roundId: string, actor: string, tx: mongoose.ClientSession) {
  const round = await lockRound(roundId, tx)
  const applicants = await firstRoundApplicants(round, tx)
  if (!applicants) throw new WorkflowError('Only the first configured round can enroll cycle applicants. Advance applicants into later rounds.', 409)
  if (applicants.length) await CandidateRound.bulkWrite(applicants.map(a => ({ updateOne: {
    filter: { round_id: roundId, applicant_id: a._id },
    update: { $setOnInsert: { cycle_id: round.cycle_id, state: 'pending', events: [{ action: 'enrolled', actor, at: new Date() }] } }, upsert: true,
  } })), { session: tx })
  return applicants.length
}
export async function decideEnrollment(roundId: string, applicantId: string, action: string, actor: string) {
  let result: Record<string, unknown> = {}
  await mongoose.connection.transaction(async tx => {
    const round = await lockRound(roundId, tx)
    const enrollment = await CandidateRound.findOne({ round_id: roundId, applicant_id: applicantId }).session(tx).lean()
    if (!enrollment) throw new WorkflowError('Applicant is not enrolled in this round.', 404)
    const rounds = await Round.find({ cycle_id: round.cycle_id, workflow: 'ps' }).session(tx).lean()
    const target = nextRound(rounds.map(r => ({ id: String(r._id), order_index: r.order_index, archived: r.archived })), roundId)
    const state = transition(enrollment.state, action, !!target)
    if (!target) throw new WorkflowError('Final-round decisions are handled by the existing decision workflow.', 409)
    if (enrollment.state === state) { result = serialize(enrollment); return }
    let nextId = null
    if (state === 'advanced') {
      const next = await lockRound(target.id, tx)
      const created = await CandidateRound.findOneAndUpdate({ round_id: next._id, applicant_id: applicantId }, { $setOnInsert: { cycle_id: round.cycle_id, state: 'pending', source_enrollment: enrollment._id, events: [{ action: 'enrolled', actor, at: new Date() }] } }, { upsert: true, returnDocument: 'after', session: tx }).lean()
      nextId = created!._id
    }
    const updated = await CandidateRound.findByIdAndUpdate(enrollment._id, { $set: { state, next_enrollment: nextId, decision_by: actor, decision_at: new Date() }, $push: { events: { action, actor, at: new Date(), target_round_id: state === 'advanced' ? target.id : null } } }, { returnDocument: 'after', session: tx }).lean()
    result = serialize(updated!)
  })
  return result
}
