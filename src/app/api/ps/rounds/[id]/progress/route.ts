import { NextRequest, NextResponse } from 'next/server'
import { psApi } from '@/lib/ps/api'
import { roundProgress } from '@/lib/ps/roundLifecycle'
export async function GET(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return psApi('leadership', async () => NextResponse.json(await roundProgress((await context.params).id), { headers: { 'Cache-Control': 'private, no-store' } }))
}
