import mongoose from 'mongoose'
import { Applicant, GraderAssignment, Round } from '@/lib/models'
import { CandidateRound, GenericReview, RubricVersion, PSEvaluationRevision, PSEvaluationContribution } from './models'
import { lockRound } from './rounds'
import { WorkflowError } from './domain'
import { Criterion, validateRatings, validateReviewAccess } from './rubrics'
import { objectId, serialize } from './records'
import { validateResponses, Question } from './rubricV2'
import { isWeighted, scoreEvaluation } from './weightedRubric'
import { isPoints, scorePoints } from './points'
import type { Structure } from './rubricV2'
export async function submitReview(body: Record<string, unknown>, actor: string) {
  const roundId = String(body.round_id ?? ''), applicantId = String(body.applicant_id ?? '')
  objectId(roundId); objectId(applicantId)
  if (typeof body.comments !== 'string' || body.comments.length > 10000) throw new WorkflowError('Comments must be text of at most 10,000 characters.')
  const comments = body.schema_version === 2 ? body.comments : body.comments.trim()
  let result: Record<string, unknown> = {}
  await mongoose.connection.transaction(async tx => {
    const round = await lockRound(roundId, tx)
    if (round.status !== 'grading') throw new WorkflowError('This round is not open for grading.', 409)
    if (!round.rubric_version_id) throw new WorkflowError('Rubric not configured.', 409)
    const open = round.grading_access === 'open'
    type Row = { _id: unknown; grader_email: string; panel_id?: string | null }
    let mine: Row | null = null, panel: Row[] | null = null, panelEmails: string[] | null = null
    let contribution: { _id: unknown; grader_email: string; evaluation_id: unknown; revision: number } | null = null
    let prior: { _id: unknown; rubric_version_id: unknown; panel_emails?: string[] } | null = null
    if (open) {
      // Open rounds: whoever graded (or co-interviewed) owns the evaluation; no assignment is needed.
      const co = coInterviewer(body.co_interviewer, round, actor)
      const existing = await PSEvaluationContribution.find({ round_id: roundId, applicant_id: applicantId }).session(tx).lean()
      const currents = await PSEvaluationRevision.find({ _id: mongoose.trusted({ $in: existing.map(c => c.evaluation_id) }) }).select('grader_email panel_emails').session(tx).lean()
      const credits = (c: { grader_email: string; evaluation_id: unknown }, email: string) => c.grader_email === email || !!currents.find(e => String(e._id) === String(c.evaluation_id))?.panel_emails?.includes(email)
      contribution = existing.find(c => credits(c, actor)) ?? null
      if (co && existing.some(c => c !== contribution && credits(c, co))) throw new WorkflowError(`${co} already has an evaluation for this candidate. Open theirs to update it, or choose a different co-interviewer.`, 409)
      prior = contribution ? await PSEvaluationRevision.findById(contribution.evaluation_id).session(tx).lean() : null
      panelEmails = co ? [actor, co].sort() : prior?.panel_emails?.length ? prior.panel_emails : null
    } else {
      // Assigned pair rounds share one evaluation per pair: either interviewer may submit or revise it.
      mine = await GraderAssignment.findOne({ round_id: roundId, applicant_id: applicantId, grader_email: actor }).session(tx).lean()
      panel = round.assignment_mode === 'pair' && mine?.panel_id ? (await GraderAssignment.find({ round_id: roundId, applicant_id: applicantId, panel_id: mine.panel_id }).session(tx).lean()) : null
      panelEmails = panel ? panel.map(a => a.grader_email).sort() : null
      contribution = await PSEvaluationContribution.findOne({ round_id: roundId, applicant_id: applicantId, grader_email: panelEmails ? mongoose.trusted({ $in: panelEmails }) : actor }).session(tx).lean()
      prior = contribution ? await PSEvaluationRevision.findById(contribution.evaluation_id).session(tx).lean() : null
    }
    const requested = String(body.rubric_version_id ?? '')
    if (requested !== String(round.rubric_version_id) && requested !== String(prior?.rubric_version_id)) throw new WorkflowError('Published rubric changed. Reload the grading form.', 409)
    const rubric = await RubricVersion.findOne({ _id: requested, round_id: roundId }).session(tx).lean()
    if (!rubric) throw new WorkflowError('Rubric not configured.', 409)
    const enrollment = await CandidateRound.findOne({ round_id: roundId, applicant_id: applicantId }).session(tx).lean()
    if (!enrollment) throw new WorkflowError('Applicant is not enrolled.', 409)
    const assignment = mine
    if (!round.eligible_grader_emails.includes(actor)) throw new WorkflowError('You are not eligible to grade this round.', 403)
    validateReviewAccess({ actor, assignedTo: open ? actor : assignment?.grader_email ?? null, state: enrollment.state, rubricId: String(rubric._id), submittedRubricId: body.rubric_version_id })
    if ((round.assignment_mode === 'pair' || open) && !isPoints(rubric)) throw new WorkflowError('This round needs a points rubric. Publish one before grading.', 409)
    if (body.knows_candidate !== undefined && typeof body.knows_candidate !== 'boolean') throw new WorkflowError('Choose whether you know this candidate.')
    if (isWeighted(rubric) || isPoints(rubric)) {
      if (body.schema_version !== 2) throw new WorkflowError('Review schema must match the published rubric.')
      const expected = body.revision ?? 0
      if (!Number.isInteger(expected) || expected !== (contribution?.revision ?? 0)) throw new WorkflowError('Your evaluation changed. Reload it before updating.', 409)
      const calculated = isPoints(rubric) ? await pointsFields(rubric as unknown as Structure, body.responses, applicantId, tx) : scoreEvaluation(rubric as unknown as Structure, body.responses)
      const legacy = await GenericReview.exists({ round_id: roundId, applicant_id: applicantId, grader_email: actor }).session(tx)
      const [evaluation] = await PSEvaluationRevision.create([{ round_id: roundId, applicant_id: applicantId, grader_email: actor, rubric_version_id: rubric._id, scoring_configuration_id: rubric.scoring_configuration_id, schema_version: 2, revision: Number(expected) + 1, supersedes_id: prior?._id ?? null, rubric_snapshot: serialize(rubric), ...calculated, ...(panelEmails ? { panel_emails: panelEmails } : {}), knows_candidate: body.knows_candidate === true, comments: body.comments }], { session: tx })
      if (contribution) {
        const updated = await PSEvaluationContribution.updateOne({ _id: contribution._id, revision: expected }, { $set: { evaluation_id: evaluation._id, revision: Number(expected) + 1 } }, { session: tx })
        if (!updated.modifiedCount) throw new WorkflowError('Your evaluation changed. Reload it before updating.', 409)
      } else {
        await PSEvaluationContribution.create([{ round_id: roundId, applicant_id: applicantId, grader_email: actor, evaluation_id: evaluation._id, revision: 1 }], { session: tx })
        if (open) await Round.updateOne({ _id: roundId }, { $inc: { review_submission_count: 1 } }, { session: tx })
        else if (!legacy) {
          // In pair rounds every member's row is marked complete so neither is asked again.
          const rows = panel ? panel.map(a => a._id) : [assignment!._id]
          const guard = await GraderAssignment.updateMany({ _id: mongoose.trusted({ $in: rows }) }, { $inc: { submission_count: 1 } }, { session: tx })
          if (guard.modifiedCount !== rows.length) throw new WorkflowError('Assignment changed. Reload.', 409)
          await Round.updateOne({ _id: roundId }, { $inc: { review_submission_count: 1 } }, { session: tx })
        }
      }
      const [oldRows, newRows] = await Promise.all([GenericReview.find({ round_id: roundId, applicant_id: applicantId }).select('grader_email').session(tx).lean(), PSEvaluationContribution.find({ round_id: roundId, applicant_id: applicantId }).select('grader_email').session(tx).lean()])
      const count = new Set([...oldRows, ...newRows].map(r => r.grader_email)).size
      await CandidateRound.updateOne({ _id: enrollment._id }, { $set: { state: count >= round.reviews_required ? 'ready_for_deliberation' : 'in_review' } }, { session: tx })
      result = serialize(evaluation.toObject()); return
    }
    if (contribution) throw new WorkflowError('Update this evaluation using its exact weighted rubric version.', 409)
    if (await GenericReview.exists({ round_id: roundId, applicant_id: applicantId, grader_email: actor }).session(tx)) throw new WorkflowError('This assignment already has a submitted review.', 409)
    const raw = rubric.schema_version === 2 ? { schema_version: 2, responses: validateResponses(rubric.questions as Question[], body.responses) } : { ratings: validateRatings(rubric.criteria as Criterion[], body.ratings) }
    if ((rubric.schema_version === 2 && body.schema_version !== 2) || (rubric.schema_version !== 2 && body.schema_version === 2)) throw new WorkflowError('Review schema must match the published rubric.')
    const guard = await GraderAssignment.updateOne({ _id: assignment!._id }, { $inc: { submission_count: 1 } }, { session: tx })
    if (!guard.modifiedCount) throw new WorkflowError('Assignment changed. Reload.', 409)
    const [review] = await GenericReview.create([{ round_id: roundId, applicant_id: applicantId, grader_email: actor, rubric_version_id: rubric._id, ...raw, comments }], { session: tx })
    await Round.updateOne({ _id: roundId }, { $inc: { review_submission_count: 1 } }, { session: tx })
    const count = await GenericReview.countDocuments({ round_id: roundId, applicant_id: applicantId }).session(tx)
    await CandidateRound.updateOne({ _id: enrollment._id }, { $set: { state: count >= round.reviews_required ? 'ready_for_deliberation' : 'in_review' } }, { session: tx })
    result = serialize(review.toObject())
  })
  return result
}
// Grade-specific sections are chosen from the applicant's record, never from the submitted form.
async function pointsFields(rubric: Structure, responses: unknown, applicantId: string, tx: mongoose.ClientSession) {
  const applicant = await Applicant.findById(applicantId).select('year').session(tx).lean()
  const year = applicant?.year ?? null
  const result = scorePoints(rubric, responses, year)
  return { responses: result.responses, question_results: result.question_results.map(r => ({ ...r, raw_score: r.points })), score: result.total, max_points: result.max, percent: result.percent, criteria_points: result.criteria, bonus_points: result.bonus, penalty_points: result.penalty, section_totals: result.section_totals, applicant_year: year }
}
// Open interview rounds: the grader names who interviewed with them. Individual rounds take no co-interviewer.
function coInterviewer(input: unknown, round: { assignment_mode?: string; eligible_grader_emails: string[] }, actor: string) {
  if (input === undefined || input === null || input === '') return null
  if (round.assignment_mode !== 'pair') throw new WorkflowError('This round is graded individually; remove the co-interviewer.')
  if (typeof input !== 'string') throw new WorkflowError('Choose a co-interviewer from the list.')
  const email = input.trim().toLowerCase()
  if (email === actor) throw new WorkflowError('Choose someone other than yourself as co-interviewer.')
  if (!round.eligible_grader_emails.includes(email)) throw new WorkflowError('Your co-interviewer must be an eligible grader for this round.')
  return email
}
