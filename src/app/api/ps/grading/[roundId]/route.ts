import { NextRequest, NextResponse } from 'next/server'
import { psApi, objectId } from '@/lib/ps/api'
import { gradingRoster } from '@/lib/ps/gradingRoster'
export async function GET(_req: NextRequest, context: { params: Promise<{ roundId: string }> }) {
  return psApi('grader', async auth => {
    const { roundId } = await context.params; objectId(roundId)
    return NextResponse.json(await gradingRoster(roundId, auth.email), { headers: { 'Cache-Control': 'private, no-store' } })
  })
}
