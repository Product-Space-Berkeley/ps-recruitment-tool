import { NextRequest, NextResponse } from 'next/server'
import { RecruitmentCycle, Round } from '@/lib/models'
import { readJsonObject } from '@/lib/apiValidation'
import { objectId, psApi, serialize } from '@/lib/ps/api'
import { configurationStates, createRound, createStandardRounds, reorderRounds } from '@/lib/ps/rounds'
import { WorkflowError } from '@/lib/ps/domain'
type Context = { params: Promise<{ id: string }> }
export async function GET(_req: NextRequest, context: Context) {
  return psApi('leadership', async () => {
    const { id } = await context.params; objectId(id)
    const cycle = await RecruitmentCycle.findById(id).lean()
    if (!cycle) throw new WorkflowError('Cycle not found.', 404)
    const rounds = await Round.find({ cycle_id: id, workflow: 'ps' }).sort({ order_index: 1 }).lean()
    const states = await configurationStates(rounds.map(r => String(r._id)))
    return NextResponse.json({ cycle: serialize(cycle), rounds: rounds.map(r => ({ ...serialize(r), ...states.get(String(r._id)) })) }, { headers: { 'Cache-Control': 'private, no-store' } })
  })
}
export async function POST(req: NextRequest, context: Context) {
  return psApi('leadership', async auth => {
    const parsed = await readJsonObject(req); if (!parsed.ok) return parsed.response
    const { id } = await context.params
    if (parsed.data.template === 'ps_standard') return NextResponse.json(await createStandardRounds(id, parsed.data, auth.email), { status: 201 })
    return NextResponse.json(await createRound(id, parsed.data), { status: 201 })
  })
}
export async function PATCH(req: NextRequest, context: Context) {
  return psApi('leadership', async () => {
    const parsed = await readJsonObject(req); if (!parsed.ok) return parsed.response
    await reorderRounds((await context.params).id, parsed.data.round_ids, parsed.data.configuration_version)
    return NextResponse.json({ ok: true })
  })
}
