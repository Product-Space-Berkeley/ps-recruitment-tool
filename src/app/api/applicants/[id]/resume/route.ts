import { NextRequest, NextResponse } from 'next/server'
import { connectDB } from '@/lib/mongodb'
import mongoose from 'mongoose'
import { Applicant, Candidate, GraderAssignment, Round, SessionMember } from '@/lib/models'
import { requireRole } from '@/lib/serverAuth'
import { isObjectId } from '@/lib/apiValidation'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole('grader')
  if (auth instanceof NextResponse) return auth

  await connectDB()
  const { id } = await params
  if (!isObjectId(id)) return NextResponse.json({ error: 'Invalid applicant id.' }, { status: 400 })

  // Graders may access applicants assigned to them during grading or applicants
  // visible in a deliberation session they joined. Leadership can access anyone.
  if (auth.role === 'grader') {
    const assignments = await GraderAssignment.find({ applicant_id: id, grader_email: auth.email }).select('round_id').lean()
    const roundIds = assignments.map(assignment => assignment.round_id)
    const activeRound = roundIds.length
      ? await Round.exists({ _id: mongoose.trusted({ $in: roundIds }), status: 'grading' })
      : null
    if (!activeRound) {
      const sessionIds = await Candidate.find({ applicant_id: id }).distinct('session_id')
      const isMember = sessionIds.length > 0
        && await SessionMember.exists({ session_id: mongoose.trusted({ $in: sessionIds }), user_email: auth.email })
      if (!isMember) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  // Global projection sanitization intentionally prevents Mongoose queries
  // from overriding select:false fields. Use the native collection for this
  // authenticated, server-authored query with a fixed projection so the
  // private resume payload is the only applicant field retrieved.
  const applicant = await Applicant.collection.findOne<{ resume_base64?: string | null }>(
    { _id: new mongoose.Types.ObjectId(id) },
    { projection: { resume_base64: 1 } },
  )
  if (!applicant) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (new URL(req.url).searchParams.get('format') === 'pdf') {
    if (!applicant.resume_base64) return NextResponse.json({ error: 'No resume uploaded.' }, { status: 404 })
    return new NextResponse(Buffer.from(applicant.resume_base64, 'base64'), {
      headers: {
        'Cache-Control': 'private, no-store, max-age=0',
        'Content-Disposition': 'inline; filename="resume.pdf"',
        'Content-Type': 'application/pdf',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  }
  return NextResponse.json(
    { resume_base64: applicant.resume_base64 ?? null },
    { headers: { 'Cache-Control': 'private, no-store, max-age=0' } },
  )
}
