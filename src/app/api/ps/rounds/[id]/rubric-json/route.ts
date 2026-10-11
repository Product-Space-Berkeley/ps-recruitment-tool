import { NextRequest, NextResponse } from 'next/server'
import { psApi } from '@/lib/ps/api'
import { psRound } from '@/lib/ps/rounds'
import { readJsonObject } from '@/lib/apiValidation'
import { importRubricJSON, weightSummary } from '@/lib/ps/weightedRubric'
export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return psApi('admin', async () => {
    await psRound((await context.params).id)
    const parsed = await readJsonObject(req); if (!parsed.ok) return parsed.response
    const structure = importRubricJSON(parsed.data)
    return NextResponse.json({ structure, weights: weightSummary(structure) }, { headers: { 'Cache-Control': 'private, no-store' } })
  })
}
