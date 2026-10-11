import { NextRequest, NextResponse } from 'next/server'
import { psApi, serialize } from '@/lib/ps/api'
import { psRound } from '@/lib/ps/rounds'
import { RubricDraft } from '@/lib/ps/models'
import { createDraft } from '@/lib/ps/rubricDraftService'
import { readJsonObject } from '@/lib/apiValidation'
type Context = { params: Promise<{ id: string }> }
export async function GET(_req: NextRequest, context: Context) {
  return psApi('leadership', async () => { const { id } = await context.params; await psRound(id); return NextResponse.json((await RubricDraft.find({ round_id: id }).sort({ updated_at: -1 }).lean()).map(serialize), { headers: { 'Cache-Control': 'private, no-store' } }) })
}
export async function POST(req: NextRequest, context: Context) {
  return psApi('admin', async auth => { const b = await readJsonObject(req); if (!b.ok) return b.response; return NextResponse.json(await createDraft((await context.params).id, b.data, auth.email), { status: 201 }) })
}
