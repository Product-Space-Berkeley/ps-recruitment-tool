import mongoose from 'mongoose'
import { aggregateEvaluations, type Evaluation } from '@/lib/ps/weightedRubric'
import { NextRequest, NextResponse } from 'next/server'
import { GraderAssignment } from '@/lib/models'
import { CandidateRound, GenericReview, PSEvaluationContribution, PSEvaluationRevision } from '@/lib/ps/models'
import { psApi, serialize } from '@/lib/ps/api'
import { psRound } from '@/lib/ps/rounds'
import { unconfiguredScores, RawReview } from '@/lib/ps/scoring'
import { candidateScores, graderSummaries, CANDIDATE_ENGINE, type ScoredEvaluation } from '@/lib/ps/candidateScores'
import { pairLabel, type InterviewerPair } from '@/lib/ps/domain'
export async function GET(_req: NextRequest, context: { params: Promise<{ id: string }> }) { return psApi('leadership', async () => {
  const { id } = await context.params; const round = await psRound(id)
  const enrollments = await CandidateRound.find({ round_id: id }).select('applicant_id').lean()
  const reviews = await GenericReview.find({ round_id: id }).lean()
  const contributions = await PSEvaluationContribution.find({ round_id: id }).lean()
  const latest = await PSEvaluationRevision.find({ _id: mongoose.trusted({ $in: contributions.map(c => c.evaluation_id) }) }).lean()
  // Points evaluations carry max_points; older weighted evaluations keep their 0–3 version grouping.
  const points = latest.filter(e => e.max_points != null), weighted = latest.filter(e => e.max_points == null)
  const pairs = (round.interviewer_pairs ?? []) as InterviewerPair[]
  const panels = round.assignment_mode === 'pair' ? await GraderAssignment.find({ round_id: id, panel_id: mongoose.trusted({ $ne: null }) }).select('applicant_id grader_email panel_id').lean() : []
  const graderOf = (c: { applicant_id: unknown; grader_email: string }) => {
    const panel = panels.find(p => String(p.applicant_id) === String(c.applicant_id) && p.grader_email === c.grader_email)?.panel_id
    const pair = pairs.find(p => p.id === panel)
    return pair ? pairLabel(pair) : panel ?? c.grader_email
  }
  const scored: ScoredEvaluation[] = points.map(e => ({ id: String(e._id), applicant_id: String(e.applicant_id), grader: graderOf(contributions.find(c => String(c.evaluation_id) === String(e._id))!), score: e.score, max_points: e.max_points!, percent: e.percent ?? 0 }))
  const applicantIds = enrollments.map(e => String(e.applicant_id))
  return NextResponse.json({
    status: points.length ? 'calculated' : weighted.length ? 'calculated' : 'unconfigured',
    engine: points.length ? CANDIDATE_ENGINE : null,
    message: points.length ? 'Average points per candidate. Scores appear once every required evaluation is in.' : weighted.length ? 'Weighted scores out of 3, grouped by rubric version.' : 'No points evaluations yet.',
    candidates: points.length ? candidateScores(applicantIds, scored, round.reviews_required) : [],
    graders: graderSummaries(scored),
    version_scores: aggregateEvaluations(weighted.map(serialize) as Evaluation[]),
    scores: unconfiguredScores(id, applicantIds, reviews.map(serialize) as RawReview[]),
  }, { headers: { 'Cache-Control': 'private, no-store' } })
}) }
