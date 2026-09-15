const QUALITY_RATING_KEYS = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9'] as const

type QualityRatingKey = typeof QUALITY_RATING_KEYS[number]

export type GraderRatingReview = {
  grader_email: string
} & Partial<Record<QualityRatingKey, number | null>>

export type GraderRatingSummary = {
  averageRating: number | null
  ratingStdDev: number | null
  ratingCount: number
}

export function summarizeGraderRatings(
  reviews: GraderRatingReview[],
): Map<string, GraderRatingSummary> {
  const ratingsByGrader = new Map<string, number[]>()

  for (const review of reviews) {
    const ratings = ratingsByGrader.get(review.grader_email) ?? []
    for (const key of QUALITY_RATING_KEYS) {
      const rating = review[key]
      if (typeof rating === 'number' && Number.isFinite(rating) && rating >= 1 && rating <= 4) {
        ratings.push(rating)
      }
    }
    ratingsByGrader.set(review.grader_email, ratings)
  }

  const summaries = new Map<string, GraderRatingSummary>()
  for (const [email, ratings] of ratingsByGrader) {
    if (ratings.length === 0) {
      summaries.set(email, { averageRating: null, ratingStdDev: null, ratingCount: 0 })
      continue
    }

    const averageRating = ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length
    const variance = ratings.reduce(
      (sum, rating) => sum + (rating - averageRating) ** 2,
      0,
    ) / ratings.length

    summaries.set(email, {
      averageRating,
      ratingStdDev: Math.sqrt(variance),
      ratingCount: ratings.length,
    })
  }
  return summaries
}
