import { NextRequest, NextResponse } from 'next/server'
import { psApi } from '@/lib/ps/api'
import { psRound } from '@/lib/ps/rounds'
import { readStructureUpload } from '@/lib/ps/rubricImport'
export const runtime = 'nodejs'
export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return psApi('admin', async () => {
    await psRound((await context.params).id)
    return NextResponse.json(await readStructureUpload(req), { headers: { 'Cache-Control': 'private, no-store' } })
  })
}
