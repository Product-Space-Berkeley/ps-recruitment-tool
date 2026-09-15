import { NextRequest, NextResponse } from 'next/server'
import { connectDB } from '@/lib/mongodb'
import { Applicant } from '@/lib/models'
import { requireRole } from '@/lib/serverAuth'
import { isObjectId } from '@/lib/apiValidation'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole('leadership')
  if (auth instanceof NextResponse) return auth

  await connectDB()
  const { id } = await params
  if (!isObjectId(id)) return NextResponse.json({ error: 'Invalid cycle id.' }, { status: 400 })
  const applicants = await Applicant.find({ cycle_id: id }, { resume_base64: 0 }).sort({ created_at: 1 }).lean()
  return NextResponse.json(
    applicants.map(a => ({ ...a, id: a._id.toString(), cycle_id: a.cycle_id.toString(), _id: undefined })),
    { headers: { 'Cache-Control': 'private, no-store, max-age=0' } },
  )
}
