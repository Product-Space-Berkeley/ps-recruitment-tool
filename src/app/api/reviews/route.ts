import { NextRequest, NextResponse } from 'next/server'
import mongoose from 'mongoose'
import { connectDB } from '@/lib/mongodb'
import { Review, GraderAssignment, Round } from '@/lib/models'
import { requireRole } from '@/lib/serverAuth'
import { isEmail, isObjectId, readJsonObject } from '@/lib/apiValidation'
import { consumeUserRateLimit } from '@/lib/rateLimit'

class ReviewRejected extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'ReviewRejected'
  }
}

export async function GET(req: NextRequest) {
  const auth = await requireRole('grader')
  if (auth instanceof NextResponse) return auth

  await connectDB()
  const { searchParams } = new URL(req.url)
  const round_id = searchParams.get('round_id') ?? undefined
  let grader_email = searchParams.get('grader_email') ?? undefined

  if (round_id && !isObjectId(round_id)) {
    return NextResponse.json({ error: 'Invalid round_id.' }, { status: 400 })
  }
  if (grader_email && !isEmail(grader_email)) {
    return NextResponse.json({ error: 'Invalid grader_email.' }, { status: 400 })
  }

  // Graders can only fetch their own reviews
  if (auth.role === 'grader' && grader_email && grader_email.toLowerCase() !== auth.email.toLowerCase()) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  if (auth.role === 'grader') grader_email = auth.email

  const filter: Record<string, unknown> = {}
  if (round_id) filter.round_id = round_id
  if (grader_email) filter.grader_email = grader_email.toLowerCase()

  if (auth.role === 'grader') {
    if (round_id) {
      const active = await Round.exists({ _id: round_id, status: 'grading' })
      if (!active) return NextResponse.json([])
    } else {
      const activeRounds = await Round.find({ status: 'grading' }).select('_id').lean()
      if (activeRounds.length === 0) return NextResponse.json([])
      filter.round_id = mongoose.trusted({ $in: activeRounds.map(round => round._id) })
    }
  }

  const reviews = await Review.find(filter).lean()
  return NextResponse.json(reviews.map(r => ({
    ...r,
    id: r._id.toString(),
    round_id: r.round_id.toString(),
    applicant_id: r.applicant_id.toString(),
    _id: undefined,
  })), { headers: { 'Cache-Control': 'private, no-store, max-age=0' } })
}

export async function POST(req: NextRequest) {
  const auth = await requireRole('grader')
  if (auth instanceof NextResponse) return auth

  await connectDB()
  if (!await consumeUserRateLimit(auth.email, 'review-submit', 100, 60 * 60 * 1000)) {
    return NextResponse.json({ error: 'Too many review submissions. Try again later.' }, { status: 429 })
  }
  const parsedBody = await readJsonObject(req)
  if (!parsedBody.ok) return parsedBody.response
  const body = parsedBody.data

  // Enforce that graders can only submit reviews under their own email
  if (
    'grader_email' in body
    && (typeof body.grader_email !== 'string' || body.grader_email.toLowerCase() !== auth.email.toLowerCase())
  ) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  if (!isObjectId(body.round_id) || !isObjectId(body.applicant_id)) {
    return NextResponse.json({ error: 'round_id and applicant_id are required.' }, { status: 400 })
  }

  const ratings = Array.from({ length: 10 }, (_, i) => body[`r${i}`])
  const validRatings = ratings.every((rating, i) => (
    typeof rating === 'number'
    && Number.isInteger(rating)
    && rating >= 1
    && rating <= (i === 0 ? 3 : 4)
  ))
  if (!validRatings) {
    return NextResponse.json({ error: 'All ratings must be valid rubric scores.' }, { status: 400 })
  }

  const rawComments = Array.from({ length: 5 }, (_, i) => body[`comment${i}`])
  if (rawComments.some(comment => typeof comment !== 'string')) {
    return NextResponse.json({ error: 'All comments must be text.' }, { status: 400 })
  }
  const comments = rawComments.map(comment => (comment as string).trim())
  if (comments.some(comment => comment.length === 0 || comment.length > 2000)) {
    return NextResponse.json({ error: 'All comments are required and must be 2,000 characters or fewer.' }, { status: 400 })
  }

  try {
    let reviewId = ''
    await mongoose.connection.transaction(async dbSession => {
      // These guarded writes make round closure/assignment removal conflict
      // with this transaction instead of permitting a stale review to commit.
      const roundGuard = await Round.updateOne(
        { _id: body.round_id, status: 'grading' },
        { $inc: { review_submission_count: 1 } },
        { session: dbSession },
      )
      if (roundGuard.modifiedCount !== 1) {
        const roundExists = await Round.exists({ _id: body.round_id }).session(dbSession)
        throw new ReviewRejected(
          roundExists ? 'This grading round is closed.' : 'Round not found.',
          roundExists ? 409 : 404,
        )
      }

      const assignmentGuard = await GraderAssignment.updateOne(
        {
          round_id: body.round_id,
          applicant_id: body.applicant_id,
          grader_email: auth.email,
        },
        { $inc: { submission_count: 1 } },
        { session: dbSession },
      )
      if (assignmentGuard.modifiedCount !== 1) {
        throw new ReviewRejected('You are not assigned to grade this applicant in this round.', 403)
      }

      const [review] = await Review.create([{
        round_id: body.round_id,
        applicant_id: body.applicant_id,
        grader_email: auth.email,
        r0: ratings[0], r1: ratings[1], r2: ratings[2], r3: ratings[3],
        r4: ratings[4], r5: ratings[5], r6: ratings[6], r7: ratings[7],
        r8: ratings[8], r9: ratings[9],
        comment0: comments[0], comment1: comments[1],
        comment2: comments[2], comment3: comments[3], comment4: comments[4],
      }], { session: dbSession })
      reviewId = review._id.toString()
    })
    return NextResponse.json({ id: reviewId }, { status: 201 })
  } catch (e: unknown) {
    if (e instanceof ReviewRejected) {
      return NextResponse.json({ error: e.message }, { status: e.status })
    }
    const msg = e instanceof Error ? e.message : 'Unknown error'
    if ((typeof e === 'object' && e && 'code' in e && e.code === 11000) || msg.includes('duplicate')) {
      return NextResponse.json({ error: 'Review already submitted.' }, { status: 409 })
    }
    console.error('Failed to create review:', e)
    return NextResponse.json({ error: 'Unable to submit review.' }, { status: 500 })
  }
}
