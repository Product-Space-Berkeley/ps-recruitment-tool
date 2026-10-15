import mongoose from 'mongoose'
import { Applicant, AuthorizedUser, GraderAssignment } from '@/lib/models'
import { CandidateRound, GenericReview, PSEvaluationContribution, ReviewConflict } from './models'
import { lockRound } from './rounds'
import { objectId } from './records'
import { InterviewBooking, InterviewSlot, allocate } from './scheduling'
import { WorkflowError } from './domain'

// The round lock serializes conflict declarations with submissions and assignment changes.
export async function declareConflict(roundId: string, applicantId: string, email: string, excludeSubmittedBy?: string) {
  objectId(roundId); objectId(applicantId)
  await ReviewConflict.init()
  let result = { resolved: false, message: '' }
  await mongoose.connection.transaction(async tx => {
    const round = await lockRound(roundId, tx)
    if (!['pending', 'grading'].includes(round.status)) throw new WorkflowError('Conflicts can only be declared before grading closes.', 409)
    if (!round.eligible_grader_emails.includes(email)) throw new WorkflowError('You are not a reviewer for this round.', 403)
    if (round.assignment_mode === 'pair') throw new WorkflowError('This older shared-pair round needs leadership to reconfigure its assignments.', 409)
    const enrollment = await CandidateRound.findOne({ round_id: roundId, applicant_id: applicantId }).session(tx).lean()
    if (!enrollment || !['pending', 'in_review', 'ready_for_deliberation'].includes(enrollment.state)) throw new WorkflowError('This candidate is not available for review.', 409)
    const existing = await ReviewConflict.findOne({ round_id: roundId, applicant_id: applicantId, grader_email: email }).session(tx).lean()
    if (existing?.resolved) { result = { resolved: true, message: 'Your conflict has already been recorded and covered.' }; return }
    const conflict = await ReviewConflict.findOneAndUpdate({ round_id: roundId, applicant_id: applicantId, grader_email: email }, { $setOnInsert: { declared_at: new Date() } }, { upsert: true, returnDocument: 'after', session: tx }).lean()
    const submitted = await PSEvaluationContribution.exists({ round_id: roundId, applicant_id: applicantId, grader_email: email }).session(tx) || await GenericReview.exists({ round_id: roundId, applicant_id: applicantId, grader_email: email }).session(tx)
    if (submitted && excludeSubmittedBy) {
      if (await GenericReview.exists({ round_id: roundId, applicant_id: applicantId, grader_email: email }).session(tx)) throw new WorkflowError('This older review format needs a separate migration; it has not been removed.', 409)
      const contribution = await PSEvaluationContribution.findOne({ round_id: roundId, applicant_id: applicantId, grader_email: email }).session(tx).lean()
      if (contribution) {
        await ReviewConflict.updateOne({ _id: conflict!._id }, { $addToSet: { excluded_review_ids: contribution.evaluation_id }, $set: { resolved_by: excludeSubmittedBy } }, { session: tx })
        await PSEvaluationContribution.deleteOne({ _id: contribution._id }, { session: tx })
        await GraderAssignment.deleteMany({ round_id: roundId, applicant_id: applicantId, grader_email: email }, { session: tx })
        await CandidateRound.updateOne({ _id: enrollment._id }, { $set: { state: 'in_review' }, $push: { events: { action: `conflicted-review-excluded:${email}`, actor: excludeSubmittedBy, at: new Date() } } }, { session: tx })
      }
    }
    if (submitted && !excludeSubmittedBy) {
      await ReviewConflict.updateOne({ _id: conflict!._id }, { $set: { reason: 'submitted_review', resolved: false } }, { session: tx })
      result = { resolved: false, message: 'Conflict recorded. Your submitted review is preserved; leadership must resolve it before closing grading.' }; return
    }
    const booking = await InterviewBooking.findOne({ round_id: roundId, applicant_id: applicantId, slot_id: mongoose.trusted({ $ne: null }) }).session(tx).lean()
    if (booking) {
      await AuthorizedUser.updateMany({ email: mongoose.trusted({ $in: round.eligible_grader_emails }) }, { $inc: { assignment_write_count: 1 } }, { session: tx })
      await GraderAssignment.deleteMany({ round_id: roundId, applicant_id: applicantId, grader_email: email }, { session: tx })
      await InterviewBooking.updateOne({ _id: booking._id }, { $pull: { interviewers: email } }, { session: tx })
      const slot = await InterviewSlot.findById(booking.slot_id).session(tx).lean()
      const resolved = slot ? await allocate(String(booking._id), round, slot, tx) : false
      await ReviewConflict.updateOne({ _id: conflict!._id }, { $set: { resolved, reason: resolved ? 'reassigned' : 'no_replacement' } }, { session: tx })
      result = { resolved, message: resolved ? 'Conflict recorded and an available interviewer assigned.' : 'Conflict recorded. Leadership must fill this interview slot.' }
      return
    }
    const assignments = await GraderAssignment.find({ round_id: roundId }).session(tx).lean()
    const blocked = await ReviewConflict.find({ round_id: roundId, applicant_id: applicantId }).session(tx).lean()
    const contributors = await PSEvaluationContribution.find({ round_id: roundId, applicant_id: applicantId }).session(tx).lean()
    const occupied = new Set([...assignments.filter(a => String(a.applicant_id) === applicantId && a.grader_email !== email).map(a => a.grader_email), ...contributors.map(c => c.grader_email)])
    await GraderAssignment.deleteMany({ round_id: roundId, applicant_id: applicantId, grader_email: email, submission_count: 0 }, { session: tx })
    const eligible = await AuthorizedUser.find({ email: mongoose.trusted({ $in: round.eligible_grader_emails }), role: mongoose.trusted({ $in: ['admin', 'leadership'] }) }).session(tx).lean()
    const choices = eligible.map(u => u.email).filter(e => !occupied.has(e) && !blocked.some(c => c.grader_email === e))
    choices.sort((a, b) => assignments.filter(x => x.grader_email === a).length - assignments.filter(x => x.grader_email === b).length || a.localeCompare(b))
    while (occupied.size < round.reviews_required && choices.length) {
      const replacement = choices.shift()!
      await AuthorizedUser.updateOne({ email: replacement }, { $inc: { assignment_write_count: 1 } }, { session: tx })
      await GraderAssignment.create([{ round_id: roundId, applicant_id: applicantId, grader_email: replacement, submission_count: 0 }], { session: tx })
      occupied.add(replacement)
    }
    const resolved = occupied.size >= round.reviews_required
    await ReviewConflict.updateOne({ _id: conflict!._id }, { $set: { resolved, reason: resolved ? 'reassigned' : 'no_replacement' } }, { session: tx })
    await CandidateRound.updateOne({ _id: enrollment._id }, { $push: { events: { action: `conflict:${email}`, actor: email, at: new Date() } } }, { session: tx })
    result = { resolved, message: resolved ? 'Conflict recorded. Your assignment was reassigned.' : 'Conflict recorded. Leadership has an unresolved coverage alert; no eligible replacement is available.' }
  })
  return result
}
export async function conflictInbox(roundId: string) {
  objectId(roundId)
  const conflicts = await ReviewConflict.find({ round_id: roundId, resolved: false }).lean()
  const applicants = await Applicant.find({ _id: mongoose.trusted({ $in: conflicts.map(c => c.applicant_id) }) }).select('first_name last_name').lean()
  return conflicts.map(c => ({ applicant_id: String(c.applicant_id), grader_email: c.grader_email, reason: c.reason, name: applicants.filter(a => String(a._id) === String(c.applicant_id)).map(a => `${a.first_name} ${a.last_name}`)[0] ?? 'Applicant' }))
}
