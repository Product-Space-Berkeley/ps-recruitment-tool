import mongoose from 'mongoose'
import { Applicant, RecruitmentCycle, Round } from '@/lib/models'
import { CandidateRound, PSEvaluationContribution, PSEvaluationRevision, RubricVersion } from './models'
import { WorkflowError } from './domain'
import { objectId, serialize } from './records'
import { frozenRoundScores, liveRoundScores } from './scoreService'
import type { CandidateScore } from './candidateScores'
type ScoreView = (CandidateScore & { frozen: boolean; frozen_at?: string }) | null
// A closed round shows its frozen snapshot; a grading round shows the live score (still hidden until complete).
async function scoresFor(round: { _id: unknown; status: string; reviews_required: number }) {
  const frozen = ['deliberating', 'ended'].includes(round.status) ? await frozenRoundScores(round._id) : []
  if (frozen.length) return new Map<string, ScoreView>(frozen.map(f => [f.applicant_id, { ...f, frozen: true }]))
  const live = await liveRoundScores(round)
  return new Map<string, ScoreView>(live.candidates.map(c => [c.applicant_id, { ...c, frozen: false }]))
}

// Everything about one applicant across every PS round of their cycle.
export async function candidateProfile(applicantId: string) {
  objectId(applicantId)
  const applicant = await Applicant.findById(applicantId).select('cycle_id first_name last_name email year transfer major created_at').lean()
  if (!applicant) throw new WorkflowError('Applicant not found.', 404)
  const cycle = await RecruitmentCycle.findById(applicant.cycle_id).select('name status').lean()
  const rounds = await Round.find({ cycle_id: applicant.cycle_id, workflow: 'ps', archived: false }).sort({ order_index: 1 }).lean()
  const enrollments = await CandidateRound.find({ applicant_id: applicantId, round_id: mongoose.trusted({ $in: rounds.map(r => r._id) }) }).lean()
  const contributions = await PSEvaluationContribution.find({ applicant_id: applicantId, round_id: mongoose.trusted({ $in: rounds.map(r => r._id) }) }).lean()
  const current = await PSEvaluationRevision.find({ _id: mongoose.trusted({ $in: contributions.map(c => c.evaluation_id) }) }).lean()
  const revisionCounts = await PSEvaluationRevision.aggregate<{ _id: unknown; count: number }>([{ $match: { applicant_id: new mongoose.Types.ObjectId(applicantId) } }, { $group: { _id: '$round_id', count: { $sum: 1 } } }])
  const rubrics = await RubricVersion.find({ _id: mongoose.trusted({ $in: [...new Set(current.map(e => String(e.rubric_version_id)))] }) }).lean()
  const timeline = []
  for (const round of rounds) {
    const enrollment = enrollments.find(e => String(e.round_id) === String(round._id))
    const score = enrollment ? (await scoresFor(round)).get(applicantId) ?? null : null
    const evaluations = current.filter(e => String(e.round_id) === String(round._id)).map(e => ({
      id: String(e._id), submitted_by: e.grader_email, panel_emails: e.panel_emails ?? null, revision: e.revision, submitted_at: e.submitted_at,
      score: e.score, max_points: e.max_points ?? null, percent: e.percent ?? null, bonus_points: e.bonus_points ?? null, penalty_points: e.penalty_points ?? null,
      section_totals: e.section_totals ?? [], responses: e.responses, comments: e.comments, rubric_version_id: String(e.rubric_version_id),
    }))
    timeline.push({
      round: { id: String(round._id), name: round.name, status: round.status, order_index: round.order_index, assignment_mode: round.assignment_mode ?? 'individual', reviews_required: round.reviews_required },
      enrolled: !!enrollment,
      state: enrollment?.state ?? null, decision_by: enrollment?.decision_by ?? null, decision_at: enrollment?.decision_at ?? null, events: enrollment?.events ?? [],
      score, evaluations,
      revisions: revisionCounts.find(r => String(r._id) === String(round._id))?.count ?? 0,
    })
  }
  return {
    applicant: { id: String(applicant._id), name: `${applicant.first_name} ${applicant.last_name}`, email: applicant.email, year: applicant.year ?? null, transfer: !!applicant.transfer, major: applicant.major ?? null, applied_at: applicant.created_at ?? null },
    cycle: cycle ? { id: String(cycle._id), name: cycle.name, status: cycle.status } : null,
    current_round: timeline.filter(t => t.enrolled).at(-1)?.round.name ?? null,
    timeline,
    rubrics: rubrics.map(serialize),
  }
}

// Every applicant in a cycle with where they are now and their latest score.
export async function cycleRoster(cycleId: string) {
  objectId(cycleId)
  const cycle = await RecruitmentCycle.findById(cycleId).select('name status').lean()
  if (!cycle) throw new WorkflowError('Cycle not found.', 404)
  const applicants = await Applicant.find({ cycle_id: cycleId }).select('first_name last_name email year').sort({ last_name: 1, first_name: 1 }).lean()
  const rounds = await Round.find({ cycle_id: cycleId, workflow: 'ps', archived: false }).sort({ order_index: 1 }).lean()
  const enrollments = await CandidateRound.find({ round_id: mongoose.trusted({ $in: rounds.map(r => r._id) }) }).select('round_id applicant_id state').lean()
  const scores = new Map<string, Map<string, ScoreView>>()
  for (const round of rounds) scores.set(String(round._id), await scoresFor(round))
  const order = new Map(rounds.map((r, i) => [String(r._id), i]))
  return {
    cycle: { id: String(cycle._id), name: cycle.name, status: cycle.status },
    rounds: rounds.map(r => ({ id: String(r._id), name: r.name })),
    candidates: applicants.map(a => {
      const latest = enrollments.filter(e => String(e.applicant_id) === String(a._id)).sort((x, y) => order.get(String(y.round_id))! - order.get(String(x.round_id))!)[0]
      const round = latest ? rounds.find(r => String(r._id) === String(latest.round_id)) : null
      return { id: String(a._id), name: `${a.first_name} ${a.last_name}`, email: a.email, year: a.year ?? null, round_id: round ? String(round._id) : null, round: round?.name ?? null, state: latest?.state ?? null, score: round ? scores.get(String(round._id))?.get(String(a._id)) ?? null : null }
    }),
  }
}
