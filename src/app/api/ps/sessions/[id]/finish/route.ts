import { NextResponse } from 'next/server'
import { readJsonObject } from '@/lib/apiValidation'
import { psApi } from '@/lib/ps/api'
import { finishDecisions } from '@/lib/ps/deliberation'
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return psApi('leadership', async auth => { const body = await readJsonObject(_req); if (!body.ok) return body.response; return NextResponse.json(await finishDecisions((await params).id, auth.email)) })
}
