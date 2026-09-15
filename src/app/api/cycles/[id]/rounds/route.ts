import { NextRequest, NextResponse } from 'next/server'
import { connectDB } from '@/lib/mongodb'
import { Round } from '@/lib/models'
import { requireRole } from '@/lib/serverAuth'
import { isObjectId } from '@/lib/apiValidation'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole('grader')
  if (auth instanceof NextResponse) return auth

  await connectDB()
  const { id } = await params
  if (!isObjectId(id)) return NextResponse.json({ error: 'Invalid cycle id.' }, { status: 400 })
  const rounds = await Round.find({ cycle_id: id }).sort({ order_index: 1 }).lean()
  return NextResponse.json(rounds.map(r => ({ ...r, id: r._id.toString(), cycle_id: r.cycle_id.toString(), _id: undefined })))
}
