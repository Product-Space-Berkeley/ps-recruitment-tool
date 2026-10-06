import { NextRequest, NextResponse } from 'next/server'
import { readJsonObject } from '@/lib/apiValidation'
import { psApi } from '@/lib/ps/api'
import { generateAssignments, previewAssignments } from '@/lib/ps/assignmentService'
type Context = { params: Promise<{ id: string }> }
export async function GET(_req: NextRequest, context: Context) { return psApi('leadership', async () => NextResponse.json(await previewAssignments((await context.params).id))) }
export async function POST(req: NextRequest, context: Context) {
  return psApi('leadership', async auth => { const parsed = await readJsonObject(req); if (!parsed.ok) return parsed.response
    return NextResponse.json(await generateAssignments((await context.params).id, parsed.data.preview_token, auth.email)) })
}
