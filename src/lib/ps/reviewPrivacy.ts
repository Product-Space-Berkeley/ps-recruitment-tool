import { GenericReview, PSEvaluationContribution } from './models'
// Count distinct current reviewers, not revisions. No privileged-role bypass.
export async function completedReviewApplicants(roundId: string, required: number) {
  const [raw, current] = await Promise.all([
    GenericReview.find({ round_id: roundId }).select('applicant_id grader_email').lean(),
    PSEvaluationContribution.find({ round_id: roundId }).select('applicant_id grader_email').lean(),
  ])
  const reviewers = new Map<string, Set<string>>()
  for (const row of [...raw, ...current]) {
    const id = String(row.applicant_id)
    reviewers.set(id, (reviewers.get(id) ?? new Set()).add(row.grader_email))
  }
  return new Set([...reviewers].filter(([, people]) => people.size >= required).map(([id]) => id))
}
