import { NextRequest, NextResponse } from 'next/server'
import mongoose, { ClientSession } from 'mongoose'
import { connectDB } from '@/lib/mongodb'
import { Applicant, AuthorizedUser, GraderAssignment, Review, Round } from '@/lib/models'
import { requireRole } from '@/lib/serverAuth'
import { isEmail, isObjectId, readJsonObject } from '@/lib/apiValidation'
import { consumeUserRateLimit } from '@/lib/rateLimit'
import {
  filterReassignmentCandidatesBySource,
  rankReassignmentCandidates,
  reassignmentSourceOptions,
  ReassignmentCandidate,
  reviewerPoolForRole,
} from '@/lib/graderAssignments'

const MAX_TRANSFER_COUNT = 20
const MAX_BODY_BYTES = 20_000

class ReassignmentRejected extends Error {
  constructor(message: string, readonly status: number, readonly available?: number) {
    super(message)
    this.name = 'ReassignmentRejected'
  }
}

type TransferRow = {
  assignment_id: string
  applicant_id: string
  applicant_name: string
  from_grader_email: string
}

function sourceSummary(transfers: TransferRow[]) {
  const grouped = new Map<string, { email: string; applicants: { id: string; name: string }[] }>()
  for (const transfer of transfers) {
    const current = grouped.get(transfer.from_grader_email) ?? {
      email: transfer.from_grader_email,
      applicants: [],
    }
    current.applicants.push({ id: transfer.applicant_id, name: transfer.applicant_name })
    grouped.set(transfer.from_grader_email, current)
  }
  return [...grouped.values()].sort((a, b) => a.email.localeCompare(b.email))
}

async function requireActiveRubricRound(roundId: string, session?: ClientSession) {
  const query = Round.findOne({ _id: roundId, status: 'grading', grading_type: 'rubric' })
    .select('_id cycle_id')
  if (session) query.session(session)
  const round = await query.lean()
  if (!round) {
    throw new ReassignmentRejected('Assignments can only be transferred during an active rubric grading round.', 409)
  }
  return round
}

function getTargetAssignments(
  targetEmail: string,
  assignments: { applicant_id: unknown; grader_email: string }[],
) {
  const targetAssignments = assignments.filter(assignment => assignment.grader_email === targetEmail)
  if (targetAssignments.length === 0) {
    throw new ReassignmentRejected('The receiving grader has no assignments in this round.', 409)
  }
  return targetAssignments
}

export async function POST(req: NextRequest) {
  const auth = await requireRole('admin')
  if (auth instanceof NextResponse) return auth

  if (!await consumeUserRateLimit(auth.email, 'grader-reassignment', 60, 60_000)) {
    return NextResponse.json({ error: 'Too many reassignment requests. Try again shortly.' }, { status: 429 })
  }

  const parsedBody = await readJsonObject(req, MAX_BODY_BYTES)
  if (!parsedBody.ok) return parsedBody.response
  const body = parsedBody.data
  const action = body.action
  const roundId = body.round_id
  const targetEmail = typeof body.target_grader_email === 'string'
    ? body.target_grader_email.trim().toLowerCase()
    : ''
  const sourceEmail = typeof body.source_grader_email === 'string'
    ? body.source_grader_email.trim().toLowerCase()
    : ''

  if (
    (action !== 'preview' && action !== 'commit')
    || !isObjectId(roundId)
    || !isEmail(targetEmail)
    || (sourceEmail && !isEmail(sourceEmail))
  ) {
    return NextResponse.json({ error: 'A valid action, round_id, and target_grader_email are required.' }, { status: 400 })
  }

  await connectDB()

  try {
    if (action === 'preview') {
      const count = body.count
      if (!Number.isInteger(count) || Number(count) < 1 || Number(count) > MAX_TRANSFER_COUNT) {
        return NextResponse.json({ error: `Count must be an integer between 1 and ${MAX_TRANSFER_COUNT}.` }, { status: 400 })
      }

      const round = await requireActiveRubricRound(roundId)
      const target = await AuthorizedUser.findOne({ email: targetEmail }).select('email role').lean()
      const targetPool = target ? reviewerPoolForRole(target.role) : null
      if (!target || !targetPool) {
        throw new ReassignmentRejected('The receiving grader is not authorized.', 400)
      }

      const [assignments, reviews] = await Promise.all([
        GraderAssignment.find({ round_id: roundId }).select('_id applicant_id grader_email').lean(),
        Review.find({ round_id: roundId }).select('applicant_id grader_email').lean(),
      ])
      const targetAssignments = getTargetAssignments(targetEmail, assignments)
      const targetApplicantIds = [
        ...targetAssignments.map(assignment => String(assignment.applicant_id)),
        ...reviews
          .filter(review => review.grader_email === targetEmail)
          .map(review => String(review.applicant_id)),
      ]
      const reviewedPairs = new Set(reviews.map(review => `${review.grader_email}::${review.applicant_id.toString()}`))
      const reviewersByApplicant = new Map<string, Set<string>>()
      for (const assignment of assignments) {
        const applicantId = assignment.applicant_id.toString()
        const reviewers = reviewersByApplicant.get(applicantId) ?? new Set<string>()
        reviewers.add(assignment.grader_email)
        reviewersByApplicant.set(applicantId, reviewers)
      }

      const sourceEmails = [...new Set(assignments.map(assignment => assignment.grader_email))]
      const users = await AuthorizedUser.find({
        email: mongoose.trusted({ $in: sourceEmails }),
      }).select('email role').lean()
      const poolByEmail = new Map(users.map(user => [user.email, reviewerPoolForRole(user.role)]))

      const sourcePendingCount = new Map<string, number>()
      const applicantCompletedReviews = new Map<string, number>()
      for (const review of reviews) {
        const applicantId = review.applicant_id.toString()
        applicantCompletedReviews.set(applicantId, (applicantCompletedReviews.get(applicantId) ?? 0) + 1)
      }
      for (const assignment of assignments) {
        const pair = `${assignment.grader_email}::${assignment.applicant_id.toString()}`
        if (!reviewedPairs.has(pair)) {
          sourcePendingCount.set(assignment.grader_email, (sourcePendingCount.get(assignment.grader_email) ?? 0) + 1)
        }
      }

      const applicantIds = [...new Set(assignments.map(assignment => assignment.applicant_id.toString()))]
      const applicants = await Applicant.find({
        _id: mongoose.trusted({ $in: applicantIds }),
        cycle_id: round.cycle_id,
      }).select('_id first_name last_name').lean()
      const nameByApplicant = new Map(applicants.map(applicant => [
        applicant._id.toString(),
        `${applicant.first_name} ${applicant.last_name}`.trim(),
      ]))

      const candidates: ReassignmentCandidate[] = assignments.flatMap(assignment => {
        const applicantId = assignment.applicant_id.toString()
        const pair = `${assignment.grader_email}::${applicantId}`
        const sourcePool = poolByEmail.get(assignment.grader_email)
        const applicantName = nameByApplicant.get(applicantId)
        if (
          reviewedPairs.has(pair)
          || reviewersByApplicant.get(applicantId)?.size !== 2
          || !sourcePool
          || !applicantName
        ) return []
        return [{
          assignmentId: assignment._id.toString(),
          applicantId,
          applicantName,
          sourceEmail: assignment.grader_email,
          sourcePool,
          applicantCompletedReviews: applicantCompletedReviews.get(applicantId) ?? 0,
          sourcePendingCount: sourcePendingCount.get(assignment.grader_email) ?? 0,
        }]
      })

      const rankedAutomatic = rankReassignmentCandidates({
        candidates,
        targetEmail,
        targetPool,
        targetApplicantIds,
      })
      const rankedManual = rankReassignmentCandidates({
        candidates,
        targetEmail,
        targetPool,
        targetApplicantIds,
        allowedSourcePools: targetPool === 'leadership' ? ['leadership', 'regular'] : ['regular'],
      })
      const eligibleSources = reassignmentSourceOptions(rankedManual)
      const ranked = sourceEmail
        ? filterReassignmentCandidatesBySource(rankedManual, sourceEmail)
        : rankedAutomatic
      if (sourceEmail && ranked.length === 0) {
        throw new ReassignmentRejected(
          `${sourceEmail} has no eligible pending assignments that can be transferred to this grader.`,
          409,
          0,
        )
      }
      const requestedCount = Number(count)
      if (ranked.length < requestedCount) {
        throw new ReassignmentRejected(
          `Only ${ranked.length} eligible pending assignment${ranked.length === 1 ? '' : 's'} can be transferred.`,
          409,
          ranked.length,
        )
      }

      const transfers: TransferRow[] = ranked.slice(0, requestedCount).map(candidate => ({
        assignment_id: candidate.assignmentId,
        applicant_id: candidate.applicantId,
        applicant_name: candidate.applicantName,
        from_grader_email: candidate.sourceEmail,
      }))
      return NextResponse.json({
        target_grader_email: targetEmail,
        count: transfers.length,
        available: ranked.length,
        total_available: rankedAutomatic.length,
        target_pool: targetPool,
        selected_source_grader_email: sourceEmail || null,
        eligible_sources: eligibleSources,
        transfers,
        source_summary: sourceSummary(transfers),
      })
    }

    const assignmentIds = Array.isArray(body.assignment_ids) ? body.assignment_ids : []
    if (
      assignmentIds.length < 1
      || assignmentIds.length > MAX_TRANSFER_COUNT
      || assignmentIds.some(id => !isObjectId(id))
      || new Set(assignmentIds).size !== assignmentIds.length
    ) {
      return NextResponse.json({ error: `assignment_ids must contain 1–${MAX_TRANSFER_COUNT} unique IDs.` }, { status: 400 })
    }

    let result: {
      target_grader_email: string
      moved: number
      new_assigned_total: number
      source_summary: ReturnType<typeof sourceSummary>
    } | null = null

    await mongoose.connection.transaction(async dbSession => {
      const round = await requireActiveRubricRound(roundId, dbSession)
      const selectedAssignments = await GraderAssignment.find({
        _id: mongoose.trusted({ $in: assignmentIds }),
        round_id: roundId,
      }).select('_id applicant_id grader_email submission_count').session(dbSession).lean()
      if (selectedAssignments.length !== assignmentIds.length) {
        throw new ReassignmentRejected('The preview is stale. Refresh it before transferring assignments.', 409)
      }

      const target = await AuthorizedUser.findOne({ email: targetEmail }).select('_id email role').session(dbSession).lean()
      const sourceEmails = [...new Set(selectedAssignments.map(assignment => assignment.grader_email))]
      const users = await AuthorizedUser.find({
        email: mongoose.trusted({ $in: [...sourceEmails, targetEmail] }),
      }).select('_id email role').session(dbSession).lean()
      const targetPool = target ? reviewerPoolForRole(target.role) : null
      const poolByEmail = new Map(users.map(user => [user.email, reviewerPoolForRole(user.role)]))
      if (!target || !targetPool || users.length !== new Set([...sourceEmails, targetEmail]).size) {
        throw new ReassignmentRejected('One or more graders are no longer authorized.', 409)
      }
      const sourcePoolsAreAllowed = sourceEmails.every(email => {
        const sourcePool = poolByEmail.get(email)
        if (!sourcePool || email === targetEmail) return false
        if (!sourceEmail) return sourcePool === targetPool
        return email === sourceEmail && (
          sourcePool === targetPool
          || (targetPool === 'leadership' && sourcePool === 'regular')
        )
      })
      if (!sourcePoolsAreAllowed || (sourceEmail && sourceEmails.length !== 1)) {
        throw new ReassignmentRejected('The selected source grader is no longer eligible for this transfer.', 409)
      }

      const allAssignments = await GraderAssignment.find({ round_id: roundId })
        .select('_id applicant_id grader_email submission_count').session(dbSession).lean()
      const allReviews = await Review.find({ round_id: roundId })
        .select('applicant_id grader_email').session(dbSession).lean()
      const targetAssignments = getTargetAssignments(targetEmail, allAssignments)
      const targetApplicantIds = new Set([
        ...targetAssignments.map(assignment => String(assignment.applicant_id)),
        ...allReviews
          .filter(review => review.grader_email === targetEmail)
          .map(review => String(review.applicant_id)),
      ])
      const reviewedPairs = new Set(allReviews.map(review => `${review.grader_email}::${review.applicant_id.toString()}`))
      const selectedApplicantIds = selectedAssignments.map(assignment => assignment.applicant_id.toString())
      const reviewersByApplicant = new Map<string, Set<string>>()
      for (const assignment of allAssignments) {
        const applicantId = assignment.applicant_id.toString()
        const reviewers = reviewersByApplicant.get(applicantId) ?? new Set<string>()
        reviewers.add(assignment.grader_email)
        reviewersByApplicant.set(applicantId, reviewers)
      }
      if (
        new Set(selectedApplicantIds).size !== selectedApplicantIds.length
        || selectedAssignments.some(assignment => (
          Number(assignment.submission_count ?? 0) !== 0
          || targetApplicantIds.has(assignment.applicant_id.toString())
          || reviewersByApplicant.get(assignment.applicant_id.toString())?.size !== 2
          || reviewedPairs.has(`${assignment.grader_email}::${assignment.applicant_id.toString()}`)
        ))
      ) {
        throw new ReassignmentRejected('The preview is stale. Refresh it before transferring assignments.', 409)
      }

      const applicants = await Applicant.find({
        _id: mongoose.trusted({ $in: selectedApplicantIds }),
        cycle_id: round.cycle_id,
      }).select('_id first_name last_name').session(dbSession).lean()
      if (applicants.length !== selectedAssignments.length) {
        throw new ReassignmentRejected('One or more applicants no longer belong to this cycle.', 409)
      }
      const nameByApplicant = new Map(applicants.map(applicant => [
        applicant._id.toString(),
        `${applicant.first_name} ${applicant.last_name}`.trim(),
      ]))
      const transfers: TransferRow[] = selectedAssignments.map(assignment => ({
        assignment_id: assignment._id.toString(),
        applicant_id: assignment.applicant_id.toString(),
        applicant_name: nameByApplicant.get(assignment.applicant_id.toString()) ?? 'Unknown applicant',
        from_grader_email: assignment.grader_email,
      }))

      const roundGuard = await Round.updateOne(
        { _id: roundId, status: 'grading', grading_type: 'rubric' },
        { $inc: { lifecycle_write_count: 1 } },
        { session: dbSession },
      )
      if (roundGuard.modifiedCount !== 1) {
        throw new ReassignmentRejected('This grading round changed. Refresh and try again.', 409)
      }
      const userGuard = await AuthorizedUser.updateMany(
        { _id: mongoose.trusted({ $in: users.map(user => user._id) }) },
        { $inc: { assignment_write_count: 1 } },
        { session: dbSession },
      )
      if (userGuard.modifiedCount !== users.length) {
        throw new ReassignmentRejected('One or more graders changed. Refresh and try again.', 409)
      }

      const deletion = await GraderAssignment.deleteMany({
        _id: mongoose.trusted({ $in: assignmentIds }),
        round_id: roundId,
        submission_count: 0,
      }, { session: dbSession })
      if (deletion.deletedCount !== assignmentIds.length) {
        throw new ReassignmentRejected('The preview is stale. Refresh it before transferring assignments.', 409)
      }
      await GraderAssignment.insertMany(transfers.map(transfer => ({
        round_id: roundId,
        applicant_id: transfer.applicant_id,
        grader_email: targetEmail,
        assigned_at: new Date(),
      })), { session: dbSession })

      result = {
        target_grader_email: targetEmail,
        moved: transfers.length,
        new_assigned_total: targetAssignments.length + transfers.length,
        source_summary: sourceSummary(transfers),
      }
    })

    return NextResponse.json(result)
  } catch (error: unknown) {
    if (error instanceof ReassignmentRejected) {
      return NextResponse.json(
        { error: error.message, ...(error.available === undefined ? {} : { available: error.available }) },
        { status: error.status },
      )
    }
    const message = error instanceof Error ? error.message : ''
    if ((typeof error === 'object' && error && 'code' in error && error.code === 11000) || message.includes('duplicate')) {
      return NextResponse.json({ error: 'The preview is stale. Refresh it before transferring assignments.' }, { status: 409 })
    }
    console.error('Failed to reassign grader work:', error)
    return NextResponse.json({ error: 'Unable to transfer assignments.' }, { status: 500 })
  }
}
