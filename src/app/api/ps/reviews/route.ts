import { NextRequest, NextResponse } from 'next/server'
import { GraderAssignment } from '@/lib/models'
import { GenericReview, PSEvaluationRevision, PSEvaluationContribution } from '@/lib/ps/models'
import { readJsonObject } from '@/lib/apiValidation'
import { objectId, psApi, serialize } from '@/lib/ps/api'
import { submitReview } from '@/lib/ps/reviewService'
import { completedReviewApplicants } from '@/lib/ps/reviewPrivacy'
import { psRound } from '@/lib/ps/rounds'
export async function GET(req: NextRequest) { return psApi('grader', async auth => {
  const roundId = req.nextUrl.searchParams.get('round_id'); if (!roundId) return NextResponse.json({ error: 'round_id required.' }, { status: 400 }); objectId(roundId); const round = await psRound(roundId)
  const filter: Record<string, unknown> = { round_id: roundId };
  const [legacy, revisions, contributions] = await Promise.all([GenericReview.find(filter).lean(), PSEvaluationRevision.find(filter).lean(), PSEvaluationContribution.find(filter).lean()])
  const complete = await completedReviewApplicants(roundId, round.reviews_required)
  const assigned = auth.role === 'grader' ? await GraderAssignment.find({ round_id: roundId, grader_email: auth.email }).select('applicant_id').lean() : []
  const accessible = new Set(assigned.map(a => String(a.applicant_id)))
  if (auth.role === 'grader' && round.grading_access === 'open' && round.eligible_grader_emails.includes(auth.email)) for (const id of complete) accessible.add(id)
  const visible = (r: { applicant_id: unknown; grader_email: string }) => r.grader_email === auth.email || (complete.has(String(r.applicant_id)) && (auth.role !== 'grader' || accessible.has(String(r.applicant_id))))
  const current = new Set(contributions.map(c => String(c.evaluation_id)))
  const replaced = new Set(contributions.map(c => `${c.applicant_id}:${c.grader_email}`))
  return NextResponse.json([...legacy.filter(visible).map(r => ({ ...serialize(r), is_current: !replaced.has(`${r.applicant_id}:${r.grader_email}`) })), ...revisions.filter(visible).map(r => ({ ...serialize(r), is_current: current.has(String(r._id)) }))], { headers: { 'Cache-Control': 'private, no-store' } })
}) }
export async function POST(req: NextRequest) { return psApi('grader', async auth => { const parsed = await readJsonObject(req); if (!parsed.ok) return parsed.response; return NextResponse.json(await submitReview(parsed.data, auth.email), { status: 201 }) }) }
