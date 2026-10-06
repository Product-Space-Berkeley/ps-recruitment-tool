import mongoose from 'mongoose'
import { NextResponse } from 'next/server'
import { Applicant, GraderAssignment, RecruitmentCycle, Round } from '@/lib/models'
import { CandidateRound, GenericReview, RubricVersion, PSEvaluationContribution, PSEvaluationRevision } from '@/lib/ps/models'
import { psApi, serialize } from '@/lib/ps/api'
export async function GET() { return psApi('grader', async auth => {
  const cycles = await RecruitmentCycle.find({ status: 'active' }).select('_id name').lean()
  const rounds = await Round.find({ workflow: 'ps', cycle_id: mongoose.trusted({ $in: cycles.map(c => c._id) }), status: 'grading', archived: false, eligible_grader_emails: auth.email }).sort({ cycle_id: 1, order_index: 1 }).lean()
  const ids = rounds.map(r => r._id)
  const assignments = await GraderAssignment.find({ round_id: mongoose.trusted({ $in: ids }), grader_email: auth.email }).lean()
  const reviews = await GenericReview.find({ round_id: mongoose.trusted({ $in: ids }), grader_email: auth.email }).select('round_id applicant_id').lean()
  // In pair rounds a partner's submission completes the candidate for the whole pair.
  const paired = assignments.filter(a => a.panel_id)
  const partnerRows = paired.length ? await GraderAssignment.find({ round_id: mongoose.trusted({ $in: paired.map(a => a.round_id) }), applicant_id: mongoose.trusted({ $in: paired.map(a => a.applicant_id) }), panel_id: mongoose.trusted({ $in: paired.map(a => a.panel_id) }) }).select('round_id applicant_id panel_id grader_email').lean() : []
  const panelOf = (roundId: unknown, applicantId: unknown) => paired.find(a => String(a.round_id) === String(roundId) && String(a.applicant_id) === String(applicantId))?.panel_id
  const partnersOf = (roundId: unknown, applicantId: unknown) => partnerRows.filter(r => String(r.round_id) === String(roundId) && String(r.applicant_id) === String(applicantId) && r.panel_id === panelOf(roundId, applicantId)).map(r => r.grader_email)
  const contributions = await PSEvaluationContribution.find({ round_id: mongoose.trusted({ $in: ids }), $or: [{ grader_email: auth.email }, ...(paired.length ? [{ applicant_id: mongoose.trusted({ $in: paired.map(a => a.applicant_id) }), grader_email: mongoose.trusted({ $in: [...new Set(partnerRows.map(r => r.grader_email))] }) }] : [])] }).lean()
    .then(rows => rows.filter(c => c.grader_email === auth.email || partnersOf(c.round_id, c.applicant_id).includes(c.grader_email)))
  const completedRows = [...reviews, ...contributions].filter((r, i, all) => all.findIndex(x => String(x.round_id) === String(r.round_id) && String(x.applicant_id) === String(r.applicant_id)) === i)
  const reviewed = new Set(completedRows.map(r => `${r.round_id}:${r.applicant_id}`))
  const enrolled = await CandidateRound.find({ round_id: mongoose.trusted({ $in: ids }), state: mongoose.trusted({ $in: ['pending', 'in_review', 'ready_for_deliberation'] }) }).select('round_id applicant_id').lean()
  const active = new Set(enrolled.map(r => `${r.round_id}:${r.applicant_id}`))
  const pending = assignments.filter(a => !reviewed.has(`${a.round_id}:${a.applicant_id}`) && active.has(`${a.round_id}:${a.applicant_id}`))
  const editable = contributions.filter(c => active.has(`${c.round_id}:${c.applicant_id}`) && assignments.some(a => String(a.round_id) === String(c.round_id) && String(a.applicant_id) === String(c.applicant_id)))
  const evaluations = await PSEvaluationRevision.find({ _id: mongoose.trusted({ $in: editable.map(c => c.evaluation_id) }) }).lean()
  const applicants = await Applicant.find({ _id: mongoose.trusted({ $in: [...pending, ...editable].map(a => a.applicant_id) }) }).select('first_name last_name major year time_commitment').lean()
  const rubrics = await RubricVersion.find({ _id: mongoose.trusted({ $in: [...rounds.map(r => r.rubric_version_id), ...evaluations.map(e => e.rubric_version_id)].filter(Boolean) }) }).lean()
  const assignedRounds = rounds.filter(r => assignments.some(a => String(a.round_id) === String(r._id)))
  const progress = assignedRounds.map(round => ({ round_id: String(round._id), total: assignments.filter(a => String(a.round_id) === String(round._id)).length, completed: completedRows.filter(r => String(r.round_id) === String(round._id)).length, pending: pending.filter(a => String(a.round_id) === String(round._id)).length }))
  return NextResponse.json({ grader_email: auth.email, rounds: assignedRounds.map(round => ({ ...serialize(round), cycle_name: cycles.find(cycle => String(cycle._id) === String(round.cycle_id))?.name ?? 'Recruitment cycle' })), assignments: pending.map(a => ({ ...serialize(a), partners: a.panel_id ? partnersOf(a.round_id, a.applicant_id).filter(e => e !== auth.email) : [] })), applicants: applicants.map(serialize), rubrics: rubrics.map(serialize), completed: completedRows.length, evaluations: evaluations.map(serialize), progress }, { headers: { 'Cache-Control': 'private, no-store' } })
}) }
