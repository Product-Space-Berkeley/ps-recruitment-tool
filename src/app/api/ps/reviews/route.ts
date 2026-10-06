import { NextRequest, NextResponse } from 'next/server'
import { GenericReview, PSEvaluationRevision, PSEvaluationContribution } from '@/lib/ps/models'
import { readJsonObject } from '@/lib/apiValidation'
import { objectId, psApi, serialize } from '@/lib/ps/api'
import { submitReview } from '@/lib/ps/reviewService'
import { psRound } from '@/lib/ps/rounds'
export async function GET(req: NextRequest) { return psApi('grader', async auth => {
  const roundId = req.nextUrl.searchParams.get('round_id'); if (!roundId) return NextResponse.json({ error: 'round_id required.' }, { status: 400 }); objectId(roundId); await psRound(roundId)
  const filter: Record<string, unknown> = { round_id: roundId }; if (auth.role === 'grader') filter.grader_email = auth.email
  const [legacy, revisions, contributions] = await Promise.all([GenericReview.find(filter).lean(), PSEvaluationRevision.find(filter).lean(), PSEvaluationContribution.find(filter).lean()])
  const current = new Set(contributions.map(c => String(c.evaluation_id)))
  const replaced = new Set(contributions.map(c => `${c.applicant_id}:${c.grader_email}`))
  return NextResponse.json([...legacy.map(r => ({ ...serialize(r), is_current: !replaced.has(`${r.applicant_id}:${r.grader_email}`) })), ...revisions.map(r => ({ ...serialize(r), is_current: current.has(String(r._id)) }))], { headers: { 'Cache-Control': 'private, no-store' } })
}) }
export async function POST(req: NextRequest) { return psApi('grader', async auth => { const parsed = await readJsonObject(req); if (!parsed.ok) return parsed.response; return NextResponse.json(await submitReview(parsed.data, auth.email), { status: 201 }) }) }
