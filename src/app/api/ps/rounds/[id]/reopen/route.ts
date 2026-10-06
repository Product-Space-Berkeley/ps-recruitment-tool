import { NextRequest, NextResponse } from 'next/server'
import { readJsonObject } from '@/lib/apiValidation'
import { psApi } from '@/lib/ps/api'
import { reopenRound } from '@/lib/ps/roundLifecycle'
export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return psApi('leadership', async () => {
    const parsed = await readJsonObject(req); if (!parsed.ok) return parsed.response
    return NextResponse.json(await reopenRound((await context.params).id))
  })
}
