import { NextRequest, NextResponse } from 'next/server'
import { readJsonObject } from '@/lib/apiValidation'
import { psApi } from '@/lib/ps/api'
import { startOpenRound } from '@/lib/ps/roundLifecycle'
export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return psApi('leadership', async auth => {
    const parsed = await readJsonObject(req); if (!parsed.ok) return parsed.response
    return NextResponse.json(await startOpenRound((await context.params).id, auth.email))
  })
}
