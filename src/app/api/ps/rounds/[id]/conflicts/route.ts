import { NextRequest, NextResponse } from 'next/server'
import { psApi } from '@/lib/ps/api'
import { readJsonObject } from '@/lib/apiValidation'
import { ReviewConflict } from '@/lib/ps/models'
import { objectId } from '@/lib/ps/records'
import { declareConflict, conflictInbox } from '@/lib/ps/conflicts'
type Context = { params: Promise<{ id: string }> }
export async function GET(_req: NextRequest, context: Context) { return psApi('leadership', async () => NextResponse.json(await conflictInbox((await context.params).id))) }
export async function POST(req: NextRequest, context: Context) { return psApi('grader', async auth => {
  const body = await readJsonObject(req); if (!body.ok) return body.response
  const email = typeof body.data.grader_email === 'string' ? body.data.grader_email : auth.email
  if (email !== auth.email && auth.role === 'grader') return NextResponse.json({ error: 'Only leadership can retry another reviewer’s conflict.' }, { status: 403 })
  const roundId = (await context.params).id, applicantId = String(body.data.applicant_id ?? '')
  objectId(roundId); objectId(applicantId)
  if (email !== auth.email && !await ReviewConflict.exists({ round_id: roundId, applicant_id: applicantId, grader_email: email })) return NextResponse.json({ error: 'The reviewer must declare their own conflict before leadership can retry it.' }, { status: 409 })
  if (body.data.exclude_submitted === true && auth.role !== 'admin') return NextResponse.json({ error: 'Only admins can exclude a submitted review.' }, { status: 403 })
  return NextResponse.json(await declareConflict(roundId, applicantId, email, body.data.exclude_submitted === true ? auth.email : undefined))
}) }
