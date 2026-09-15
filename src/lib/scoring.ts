import { Review, EvaluatedApplicant, Applicant } from './types'

const QUALITIES = ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9'] as const
type Quality = typeof QUALITIES[number]

const CURRICULUM_WEIGHTS: Record<Quality, number> = {
  r1: 0.2, r2: 0.175, r3: 0.15, r4: 0.2, r5: 0.05,
  r6: 0.05, r7: 0.025, r8: 0.1, r9: 0.0, r0: 0.05,
}

const DEV_WEIGHTS: Record<Quality, number> = {
  r1: 0.1, r2: 0.2, r3: 0.1, r4: 0.10588, r5: 0.070588,
  r6: 0.070588, r7: 0.10588, r8: 0.070588, r9: 0.070588, r0: 0.05,
}

function mean(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length
}

function stddev(arr: number[], avg: number): number {
  const variance = arr.reduce((sum, x) => sum + (x - avg) ** 2, 0) / arr.length
  return Math.sqrt(variance)
}

function zscore(arr: number[]): number[] {
  if (arr.length < 2) return arr.map(() => 0)
  const avg = mean(arr)
  const sd = stddev(arr, avg)
  if (sd === 0) return arr.map(() => 0)
  return arr.map(x => (x - avg) / sd)
}

export function evaluateResults(
  reviews: Review[],
  applicants: Applicant[]
): EvaluatedApplicant[] {
  // judgments[graderEmail][quality] = [(score, applicant_id), ...]
  const judgments: Record<string, Record<Quality, [number, string][]>> = {}

  for (const review of reviews) {
    if (!judgments[review.grader_email]) {
      judgments[review.grader_email] = Object.fromEntries(
        QUALITIES.map(q => [q, []])
      ) as unknown as Record<Quality, [number, string][]>
    }
    for (const q of QUALITIES) {
      const score = review[q]
      if (score !== null && score !== undefined) {
        judgments[review.grader_email][q].push([score, review.applicant_id])
      }
    }
  }

  // Normalize each grader's scores per quality via z-score (r0 divided linearly)
  for (const grader of Object.keys(judgments)) {
    for (const q of QUALITIES) {
      const pairs = judgments[grader][q]
      if (pairs.length === 0) continue
      const rawScores = pairs.map(p => p[0])
      const normalized =
        q === 'r0'
          ? rawScores.map(s => s / 15)
          : zscore(rawScores)
      judgments[grader][q] = normalized.map((z, i) => [z, pairs[i][1]])
    }
  }

  // evaluations[applicant_id][quality] = [z-scores from all graders]
  const evaluations: Record<string, Record<Quality, number[]>> = {}

  for (const grader of Object.keys(judgments)) {
    for (const q of QUALITIES) {
      for (const [z, applicantId] of judgments[grader][q]) {
        if (!evaluations[applicantId]) {
          evaluations[applicantId] = Object.fromEntries(
            QUALITIES.map(q => [q, []])
          ) as unknown as Record<Quality, number[]>
        }
        evaluations[applicantId][q].push(z)
      }
    }
  }

  const results: EvaluatedApplicant[] = []

  for (const [applicantId, scores] of Object.entries(evaluations)) {
    const applicant = applicants.find(a => a.id === applicantId)
    if (!applicant) continue

    const avgScores = Object.fromEntries(
      QUALITIES.map(q => [q, scores[q].length > 0 ? mean(scores[q]) : 0])
    ) as Record<Quality, number>

    const weights =
      applicant.desired_roles === 'Industry Developer' ? DEV_WEIGHTS : CURRICULUM_WEIGHTS

    let total = 0
    for (const q of QUALITIES) {
      const contribution = avgScores[q] * weights[q]
      total += isNaN(contribution) ? 0.02 : contribution
    }

    total = Math.round(total * 100 * 100) / 100

    results.push({
      applicant_id: applicantId,
      first_name: applicant.first_name,
      last_name: applicant.last_name,
      desired_roles: applicant.desired_roles,
      ...avgScores,
      total,
    })
  }

  return results.sort((a, b) => b.total - a.total)
}
