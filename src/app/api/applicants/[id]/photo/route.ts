import { NextRequest, NextResponse } from 'next/server'
import mongoose from 'mongoose'
import { connectDB } from '@/lib/mongodb'
import { Applicant } from '@/lib/models'
import { canReadApplicant } from '@/lib/applicantAccess'
import { requireRole } from '@/lib/serverAuth'
import { isObjectId } from '@/lib/apiValidation'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole('grader')
  if (auth instanceof NextResponse) return auth

  await connectDB()
  const { id } = await params
  if (!isObjectId(id)) return NextResponse.json({ error: 'Invalid applicant id.' }, { status: 400 })
  if (!await canReadApplicant(auth, id)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  // Native collection read with a fixed projection, as in the resume route,
  // because photo_base64 is select:false.
  const applicant = await Applicant.collection.findOne<{ photo_base64?: string | null; photo_type?: string | null }>(
    { _id: new mongoose.Types.ObjectId(id) },
    { projection: { photo_base64: 1, photo_type: 1 } },
  )
  if (!applicant?.photo_base64 || (applicant.photo_type !== 'image/jpeg' && applicant.photo_type !== 'image/png')) {
    return NextResponse.json({ error: 'No photo uploaded.' }, { status: 404 })
  }
  return new NextResponse(Buffer.from(applicant.photo_base64, 'base64'), {
    headers: {
      'Cache-Control': 'private, no-store, max-age=0',
      'Content-Type': applicant.photo_type,
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
