import { NextRequest, NextResponse } from 'next/server'
import { psApi, serialize } from '@/lib/ps/api'
import { getDraft, updateDraft } from '@/lib/ps/rubricDraftService'
import { readJsonObject } from '@/lib/apiValidation'
type Context = { params: Promise<{ draftId: string }> }
export async function GET(_req: NextRequest, context: Context) { return psApi('leadership', async () => NextResponse.json(serialize(await getDraft((await context.params).draftId)), { headers: { 'Cache-Control': 'private, no-store' } })) }
export async function PATCH(req: NextRequest, context: Context) { return psApi('admin', async auth => { const b = await readJsonObject(req); if (!b.ok) return b.response; return NextResponse.json(await updateDraft((await context.params).draftId, b.data, auth.email)) }) }
