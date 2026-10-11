import { NextRequest, NextResponse } from 'next/server'
import { psApi } from '@/lib/ps/api'
import { publishDraft } from '@/lib/ps/rubricDraftService'
import { readJsonObject } from '@/lib/apiValidation'
export async function POST(req: NextRequest, context: { params: Promise<{ draftId: string }> }) { return psApi('admin', async auth => { const b = await readJsonObject(req); if (!b.ok) return b.response; return NextResponse.json(await publishDraft((await context.params).draftId, b.data, auth.email), { status: 201 }) }) }
