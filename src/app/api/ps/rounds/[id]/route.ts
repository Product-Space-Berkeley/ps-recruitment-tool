import { NextRequest, NextResponse } from 'next/server'
import { readJsonObject } from '@/lib/apiValidation'
import { psApi, serialize } from '@/lib/ps/api'
import { configurationStates, psRound, updateRound } from '@/lib/ps/rounds'
type Context = { params: Promise<{ id: string }> }
export async function GET(_req: NextRequest, context: Context) {
  return psApi('grader', async () => {
    const { id } = await context.params
    const round = await psRound(id), states = await configurationStates([id])
    return NextResponse.json({ ...serialize(round), ...states.get(id) }, { headers: { 'Cache-Control': 'private, no-store' } })
  })
}
export async function PATCH(req: NextRequest, context: Context) {
  return psApi('leadership', async () => {
    const parsed = await readJsonObject(req); if (!parsed.ok) return parsed.response
    return NextResponse.json(await updateRound((await context.params).id, parsed.data))
  })
}
