import { NextRequest, NextResponse } from 'next/server'
import { psApi } from '@/lib/ps/api'
import { candidateProfile } from '@/lib/ps/candidateProfile'
export async function GET(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return psApi('leadership', async () => NextResponse.json(await candidateProfile((await context.params).id), { headers: { 'Cache-Control': 'private, no-store' } }))
}
