import { NextRequest, NextResponse } from 'next/server'
import { psApi } from '@/lib/ps/api'
import { decisionBoard, decisionCsv, startDeliberation } from '@/lib/ps/deliberation'
type Context = { params: Promise<{ id: string }> }
export async function GET(req: NextRequest, { params }: Context) {
  return psApi('leadership', async () => {
    const { id } = await params
    const board = await decisionBoard(id)
    if (req.nextUrl.searchParams.get('format') === 'csv') return new NextResponse(decisionCsv(board.candidates), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="decisions-${id}.csv"`, 'Cache-Control': 'private, no-store' } })
    return NextResponse.json(board, { headers: { 'Cache-Control': 'private, no-store' } })
  })
}
export async function POST(_req: NextRequest, { params }: Context) {
  return psApi('leadership', async auth => NextResponse.json(await startDeliberation((await params).id, auth.email)))
}
