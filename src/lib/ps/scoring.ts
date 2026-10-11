import type { AnyRubric } from './rubricCompatibility'
import type { TypedResponse } from './rubricV2'
export type RawReview = { id: string; applicant_id: string; round_id: string; grader_email: string; rubric_version_id: string; schema_version?: number; responses?: TypedResponse[]; ratings?: { criterion_id: string; raw_score: number }[]; submitted_at: string | Date }
export type ScoreResult = { applicant_id: string; round_id: string; status: 'unconfigured' | 'calculated'; score: number | null; engine: string; engine_version: string | null; input_review_ids: string[] }
export interface ScoringEngine {
  id: string
  version: string
  calculate(input: { round_id: string; applicant_ids: string[]; reviews: readonly RawReview[]; rubric: AnyRubric | null; configuration_version: number; configuration: Readonly<Record<string, unknown>> }): Promise<ScoreResult[]>
}
// PS methodology has not been supplied. There is deliberately no fallback or legacy import.
export function unconfiguredScores(roundId: string, applicantIds: string[], reviews: readonly RawReview[]): ScoreResult[] {
  return applicantIds.map(applicant_id => ({ applicant_id, round_id: roundId, status: 'unconfigured', score: null, engine: 'unconfigured', engine_version: null, input_review_ids: reviews.filter(r => r.applicant_id === applicant_id && r.round_id === roundId).map(r => r.id) }))
}
