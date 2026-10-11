import { NextRequest, NextResponse } from 'next/server'
import { psApi } from '@/lib/ps/api'
import { psRound } from '@/lib/ps/rounds'
import { frozenRoundScores, liveRoundScores } from '@/lib/ps/scoreService'
// While grading, scores are live. Once a round is closed, candidates show the frozen snapshot the room deliberates on.
export async function GET(_req: NextRequest, context: { params: Promise<{ id: string }> }) { return psApi('leadership', async () => {
  const round = await psRound((await context.params).id)
  const live = await liveRoundScores(round)
  const frozen = ['deliberating', 'ended'].includes(round.status) ? await frozenRoundScores(round._id) : []
  const points = live.engine !== null
  return NextResponse.json({
    ...live,
    frozen: frozen.length > 0,
    frozen_at: frozen[0]?.frozen_at ?? null,
    candidates: frozen.length ? frozen : live.candidates,
    message: frozen.length ? 'Scores frozen when grading closed.' : points ? 'Average points per candidate. Scores appear once every required evaluation is in.' : live.version_scores.length ? 'Weighted scores out of 3, grouped by rubric version.' : 'No points evaluations yet.',
  }, { headers: { 'Cache-Control': 'private, no-store' } })
}) }
