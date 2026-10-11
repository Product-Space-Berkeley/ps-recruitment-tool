import mongoose from 'mongoose'
import { Applicant, Round, Candidate, Session } from '@/lib/models'
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
  if (!['pending', 'grading'].includes(round.status)) throw new WorkflowError('Reopen grading before enrolling more applicants.', 409)
  const applicants = await firstRoundApplicants(round, tx)
  if (!applicants) throw new WorkflowError('Only the first configured round can enroll cycle applicants. Advance applicants into later rounds.', 409)
  if (applicants.length) await CandidateRound.bulkWrite(applicants.map(a => ({ updateOne: {
    filter: { round_id: roundId, applicant_id: a._id },
    update: { $setOnInsert: { cycle_id: round.cycle_id, state: 'pending', events: [{ action: 'enrolled', actor, at: new Date() }] } }, upsert: true,
  } })), { session: tx })
  return applicants.length
}
export async function decideEnrollment(roundId: string, applicantId: string, action: string, actor: string, transaction?: mongoose.ClientSession) {
  let result: Record<string, unknown> = {}
  const decide = async (tx: mongoose.ClientSession) => {
    const round = await lockRound(roundId, tx)
    if (round.status !== 'deliberating') throw new WorkflowError('Close grading before making decisions.', 409)
    const enrollment = await CandidateRound.findOne({ round_id: roundId, applicant_id: applicantId }).session(tx).lean()
    if (!enrollment) throw new WorkflowError('Applicant is not enrolled in this round.', 404)
    const rounds = await Round.find({ cycle_id: round.cycle_id, workflow: 'ps' }).session(tx).lean()
    const target = nextRound(rounds.map(r => ({ id: String(r._id), order_index: r.order_index, archived: r.archived })), roundId)
    if (action === 'reopen' && enrollment.state === 'advanced') throw new WorkflowError('Advanced candidates cannot be reopened because they have entered the next round.', 409)
    const state = action === 'reopen' ? 'hold' : transition(enrollment.state, action, !!target)
    if (enrollment.state === state) { result = serialize(enrollment); return }
    let nextId = null
    if (state === 'advanced') {
      const next = await lockRound(target!.id, tx)
      if (!['pending', 'grading'].includes(next.status)) throw new WorkflowError('Reopen the next round for grading before advancing candidates.', 409)
      const created = await CandidateRound.findOneAndUpdate({ round_id: next._id, applicant_id: applicantId }, { $setOnInsert: { cycle_id: round.cycle_id, state: 'pending', source_enrollment: enrollment._id, events: [{ action: 'enrolled', actor, at: new Date() }] } }, { upsert: true, returnDocument: 'after', session: tx }).lean()
      nextId = created!._id
    }
    const updated = await CandidateRound.findByIdAndUpdate(enrollment._id, { $set: { state, next_enrollment: nextId, decision_by: actor, decision_at: new Date() }, $push: { events: { action, actor, at: new Date(), target_round_id: state === 'advanced' ? target!.id : null } } }, { returnDocument: 'after', session: tx }).lean()
    const sessions = await Session.find({ round_id: roundId, status: 'active' }).select('_id').session(tx).lean()
    await Candidate.updateMany({ session_id: mongoose.trusted({ $in: sessions.map(s => s._id) }), applicant_id: applicantId }, { $set: { status: state === 'advanced' || state === 'accepted' ? 'accepted' : state === 'rejected' ? 'rejected' : 'hold' } }, { session: tx })
    result = serialize(updated!)
  }
  if (transaction) await decide(transaction)
  else await mongoose.connection.transaction(decide)
  return result
}
