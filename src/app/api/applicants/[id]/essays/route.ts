import { NextRequest, NextResponse } from 'next/server'
import mongoose from 'mongoose'
import { connectDB } from '@/lib/mongodb'
import { Applicant, EssayResponse, EssayPrompt, GraderAssignment, Round, Candidate, SessionMember } from '@/lib/models'
import { requireRole } from '@/lib/serverAuth'
import { isObjectId } from '@/lib/apiValidation'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole('grader')
  if (auth instanceof NextResponse) return auth

  await connectDB()
  const { id } = await params
  if (!isObjectId(id)) return NextResponse.json({ error: 'Invalid applicant id.' }, { status: 400 })

  // A grader may read an applicant if they are assigned to an actively-grading
  // round for that applicant, OR if they are a member of a deliberation session
  // that includes this applicant (so deliberators can read essays). Leadership+
  // can access anyone.
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

  const [applicantDoc, resumeDoc, responses] = await Promise.all([
    Applicant.findById(id)
      .select('cycle_id first_name last_name year transfer major desired_roles linkedin website time_commitment infosessions_attended')
      .lean(),
    Applicant.collection.findOne(
      { _id: new mongoose.Types.ObjectId(id), resume_base64: { $type: 'string' } },
      { projection: { _id: 1 } },
    ),
    EssayResponse.find({ applicant_id: id }).lean(),
  ])

  if (!applicantDoc) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const applicant = {
    id: applicantDoc._id.toString(),
    cycle_id: applicantDoc.cycle_id.toString(),
    first_name: applicantDoc.first_name,
    last_name: applicantDoc.last_name,
    year: applicantDoc.year,
    transfer: applicantDoc.transfer,
    major: applicantDoc.major,
    desired_roles: applicantDoc.desired_roles,
    linkedin: applicantDoc.linkedin,
    website: applicantDoc.website,
    time_commitment: applicantDoc.time_commitment,
    infosessions_attended: Array.isArray(applicantDoc.infosessions_attended)
      ? applicantDoc.infosessions_attended
      : [],
    has_resume: Boolean(resumeDoc),
  }

  const promptIds = responses.map(r => r.prompt_id)
  const prompts = await EssayPrompt.find({ _id: mongoose.trusted({ $in: promptIds }) }).sort({ question_number: 1 }).lean()

  const essays = prompts.map(p => {
    const r = responses.find(r => r.prompt_id.toString() === p._id.toString())
    return {
      prompt: { id: p._id.toString(), cycle_id: p.cycle_id.toString(), question_number: p.question_number, prompt: p.prompt, description: p.description, criterion1: p.criterion1 ?? null, criterion2: p.criterion2 ?? null },
      response: r?.response ?? '',
    }
  })

  return NextResponse.json(
    { applicant, essays },
    { headers: { 'Cache-Control': 'private, no-store, max-age=0' } },
  )
}
