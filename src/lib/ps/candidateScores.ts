// Candidate and grader summaries for points rounds (engine points_v1). Pure, so a later engine
// (for example Z-score normalization) can be added beside it over the same raw evaluations.
export const CANDIDATE_ENGINE = 'points_average_v1'
export type ScoredEvaluation = { id: string; applicant_id: string; grader: string; score: number; max_points: number; percent: number }
export type CandidateScore = { applicant_id: string; reviews: number; required: number; complete: boolean; score: number | null; percent: number | null; low: number | null; high: number | null; max_points: number | null; input_review_ids: string[] }
export type GraderSummary = { grader: string; reviews: number; average: number; average_percent: number; spread_percent: number }
const round2 = (n: number) => Math.round(n * 100) / 100
const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length
// Scores stay hidden until every required evaluation is in, so one early review can't anchor the room.
export function candidateScores(applicantIds: string[], evaluations: ScoredEvaluation[], required: number): CandidateScore[] {
  return applicantIds.map(applicant_id => {
    const mine = evaluations.filter(e => e.applicant_id === applicant_id)
    const complete = mine.length >= required && mine.length > 0
    const totals = mine.map(e => e.score)
    return {
      applicant_id, reviews: mine.length, required, complete,
      score: complete ? round2(mean(totals)) : null,
      percent: complete ? round2(mean(mine.map(e => e.percent))) : null,
      low: complete ? Math.min(...totals) : null, high: complete ? Math.max(...totals) : null,
      max_points: mine.length ? Math.max(...mine.map(e => e.max_points)) : null,
      input_review_ids: mine.map(e => e.id),
    }
  })
}
// Each grader's (or pair's) habits across the round, so harsh and generous graders are visible.
export function graderSummaries(evaluations: ScoredEvaluation[]): GraderSummary[] {
  const byGrader = new Map<string, ScoredEvaluation[]>()
  for (const e of evaluations) byGrader.set(e.grader, [...(byGrader.get(e.grader) ?? []), e])
  return [...byGrader].map(([grader, rows]) => {
    const percents = rows.map(r => r.percent), avg = mean(percents)
    return { grader, reviews: rows.length, average: round2(mean(rows.map(r => r.score))), average_percent: round2(avg), spread_percent: round2(Math.sqrt(mean(percents.map(p => (p - avg) ** 2)))) }
  }).sort((a, b) => a.grader.localeCompare(b.grader))
}
