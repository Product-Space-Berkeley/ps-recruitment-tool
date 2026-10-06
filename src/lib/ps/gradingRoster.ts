import mongoose from 'mongoose'
import { Applicant, GraderAssignment, RecruitmentCycle } from '@/lib/models'
import { CandidateRound, PSEvaluationContribution, PSEvaluationRevision, RubricVersion } from './models'
import { WorkflowError } from './domain'
import { psRound } from './rounds'
import { serialize } from './records'
const ACTIVE = ['pending', 'in_review', 'ready_for_deliberation']
// Everything a grader needs for one round: every active candidate, how many evaluations each has, and
// the grader's own evaluation. Other graders' scores are never included.
export async function gradingRoster(roundId: string, grader: string) {
  const round = await psRound(roundId)
  if (!round.eligible_grader_emails.includes(grader)) throw new WorkflowError('You are not a grader for this round.', 403)
  if (!await RecruitmentCycle.exists({ _id: round.cycle_id, status: 'active' })) throw new WorkflowError('This recruitment cycle has ended.', 409)
  if (round.status !== 'grading') throw new WorkflowError(round.status === 'pending' ? `${round.name} hasn't opened for grading yet.` : `${round.name} is closed for grading.`, 409)
  const open = round.grading_access === 'open'
  const enrollments = await CandidateRound.find({ round_id: roundId, state: mongoose.trusted({ $in: ACTIVE }) }).select('applicant_id').lean()
  const ids = enrollments.map(e => e.applicant_id)
  const [applicants, contributions, assignments, rubric] = await Promise.all([
    Applicant.find({ _id: mongoose.trusted({ $in: ids }) }).select('first_name last_name major year time_commitment').sort({ first_name: 1, last_name: 1 }).lean(),
    PSEvaluationContribution.find({ round_id: roundId }).lean(),
    open ? Promise.resolve([]) : GraderAssignment.find({ round_id: roundId, grader_email: grader }).select('applicant_id panel_id').lean(),
    round.rubric_version_id ? RubricVersion.findById(round.rubric_version_id).lean() : Promise.resolve(null),
  ])
  const evaluations = await PSEvaluationRevision.find({ _id: mongoose.trusted({ $in: contributions.map(c => c.evaluation_id) }) }).lean()
  const credits = (e: { grader_email: string; panel_emails?: string[] }) => e.grader_email === grader || !!e.panel_emails?.includes(grader)
  const contributionFor = (e: { _id: unknown }) => contributions.find(c => String(c.evaluation_id) === String(e._id))
  const mineByApplicant = new Map(evaluations.filter(e => credits(e) || credits(contributionFor(e)!)).map(e => [String(e.applicant_id), e]))
  // Earlier rubric versions a grader's own evaluation used stay available for updating it.
  const versions = await RubricVersion.find({ _id: mongoose.trusted({ $in: [...new Set([...mineByApplicant.values()].map(e => String(e.rubric_version_id)))] }) }).lean()
  const candidates = applicants.map(a => {
    const id = String(a._id), count = evaluations.filter(e => String(e.applicant_id) === id).length
    const mine = mineByApplicant.get(id) ?? null
    const assigned = open || assignments.some(x => String(x.applicant_id) === id)
    return {
      applicant_id: id, name: `${a.first_name} ${a.last_name}`, first_name: a.first_name, last_name: a.last_name, major: a.major ?? '', year: a.year ?? '', time_commitment: a.time_commitment ?? '',
      evaluations: count, required: round.reviews_required, status: count >= round.reviews_required ? 'reviewed' : count ? 'in_progress' : 'needs_review',
      can_grade: assigned, mine: mine ? serialize(mine) : null,
    }
  })
  return {
    grader_email: grader,
    round: { id: String(round._id), name: round.name, status: round.status, grading_access: open ? 'open' : 'assigned', assignment_mode: round.assignment_mode ?? 'individual', reviews_required: round.reviews_required },
    co_interviewers: round.assignment_mode === 'pair' && open ? round.eligible_grader_emails.filter((e: string) => e !== grader) : [],
    rubric: rubric ? serialize(rubric) : null,
    rubrics: [...(rubric ? [rubric] : []), ...versions.filter(v => String(v._id) !== String(rubric?._id))].map(serialize),
    candidates,
  }
}
