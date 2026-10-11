import mongoose from 'mongoose'
import { GraderAssignment } from '@/lib/models'
import { CandidateRound, CandidateRoundScore, GenericReview, PSEvaluationContribution, PSEvaluationRevision } from './models'
import { aggregateEvaluations, type Evaluation } from './weightedRubric'
import { unconfiguredScores, type RawReview } from './scoring'
import { candidateScores, graderSummaries, CANDIDATE_ENGINE, type CandidateScore, type ScoredEvaluation } from './candidateScores'
import { pairLabel, type InterviewerPair } from './domain'
import { serialize } from './records'
type RoundLike = { _id: unknown; reviews_required: number; assignment_mode?: string; interviewer_pairs?: InterviewerPair[] }
// Live scores from each grader's (or pair's) current evaluation. Close round freezes these as snapshots.
export async function liveRoundScores(round: RoundLike, tx?: mongoose.ClientSession) {
  const id = round._id, s = tx ?? null
  const enrollments = await CandidateRound.find({ round_id: id }).select('applicant_id').session(s).lean()
  const reviews = await GenericReview.find({ round_id: id }).session(s).lean()
  const contributions = await PSEvaluationContribution.find({ round_id: id }).session(s).lean()
  const latest = await PSEvaluationRevision.find({ _id: mongoose.trusted({ $in: contributions.map(c => c.evaluation_id) }) }).session(s).lean()
  // Points evaluations carry max_points; older weighted evaluations keep their 0–3 version grouping.
  const points = latest.filter(e => e.max_points != null), weighted = latest.filter(e => e.max_points == null)
  const pairs = round.interviewer_pairs ?? []
  const panels = round.assignment_mode === 'pair' ? await GraderAssignment.find({ round_id: id, panel_id: mongoose.trusted({ $ne: null }) }).select('applicant_id grader_email panel_id').session(s).lean() : []
  const graderOf = (c: { applicant_id: unknown; grader_email: string }) => {
    const panel = panels.find(p => String(p.applicant_id) === String(c.applicant_id) && p.grader_email === c.grader_email)?.panel_id
    const pair = pairs.find(p => p.id === panel)
    return pair ? pairLabel(pair) : panel ?? c.grader_email
  }
  const scored: ScoredEvaluation[] = points.map(e => ({ id: String(e._id), applicant_id: String(e.applicant_id), grader: graderOf(contributions.find(c => String(c.evaluation_id) === String(e._id))!), score: e.score, max_points: e.max_points!, percent: e.percent ?? 0 }))
  const applicantIds = enrollments.map(e => String(e.applicant_id))
  return {
    status: points.length || weighted.length ? 'calculated' : 'unconfigured',
    engine: points.length ? CANDIDATE_ENGINE : null,
    candidates: points.length ? candidateScores(applicantIds, scored, round.reviews_required) : [],
    graders: graderSummaries(scored),
    version_scores: aggregateEvaluations(weighted.map(serialize) as Evaluation[]),
    scores: unconfiguredScores(String(id), applicantIds, reviews.map(serialize) as RawReview[]),
  }
}
export type FrozenScore = CandidateScore & { frozen_at: string; close_id: string }
// The most recent close of a round; earlier snapshots stay in history.
export async function frozenRoundScores(roundId: unknown): Promise<FrozenScore[]> {
  const last = await CandidateRoundScore.findOne({ round_id: roundId, close_id: mongoose.trusted({ $ne: null }) }).sort({ created_at: -1 }).lean()
  if (!last) return []
  const rows = await CandidateRoundScore.find({ round_id: roundId, close_id: last.close_id }).lean()
  return rows.map(r => ({ applicant_id: String(r.applicant_id), reviews: r.reviews, required: r.required, complete: r.complete, score: r.score, percent: r.percent, low: r.low, high: r.high, max_points: r.max_points, input_review_ids: r.input_review_ids.map(String), frozen_at: new Date(r.created_at).toISOString(), close_id: String(r.close_id) }))
}
