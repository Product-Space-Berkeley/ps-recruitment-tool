import { NextRequest, NextResponse } from 'next/server'
import { psApi, serialize } from '@/lib/ps/api'
import { psRound } from '@/lib/ps/rounds'
import { RubricVersion } from '@/lib/ps/models'
import { publishRubric } from '@/lib/ps/rubricService'
import { parseRubricImport } from '@/lib/ps/rubrics'
import { readJsonObject } from '@/lib/apiValidation'
type Context = { params: Promise<{ id: string }> }
export async function GET(_req: NextRequest, context: Context) { return psApi('leadership', async () => { const { id } = await context.params; await psRound(id); return NextResponse.json((await RubricVersion.find({ round_id: id }).sort({ version: -1 }).lean()).map(serialize)) }) }
export async function POST(req: NextRequest, context: Context) { return psApi('admin', async auth => { const parsed = await readJsonObject(req); if (!parsed.ok) return parsed.response
  if (parsed.data.import_format) parseRubricImport(String(parsed.data.import_format), String(parsed.data.data ?? ''))
  return NextResponse.json(await publishRubric((await context.params).id, parsed.data, auth.email), { status: 201 }) }) }
