import mongoose from 'mongoose'
import { Candidate, GraderAssignment, Round, SessionMember } from '@/lib/models'

// Graders may read an applicant they are assigned to in an actively grading
// round, or one in a deliberation session they joined. Leadership and admins
// can read any applicant.
export async function canReadApplicant(auth: { email: string; role: string }, applicantId: string): Promise<boolean> {
  if (auth.role !== 'grader') return true

  const assignments = await GraderAssignment.find({ applicant_id: applicantId, grader_email: auth.email }).select('round_id').lean()
  const roundIds = assignments.map(assignment => assignment.round_id)
  if (roundIds.length && await Round.exists({ _id: mongoose.trusted({ $in: roundIds }), status: 'grading' })) return true

  const sessionIds = await Candidate.find({ applicant_id: applicantId }).distinct('session_id')
  return sessionIds.length > 0
    && Boolean(await SessionMember.exists({ session_id: mongoose.trusted({ $in: sessionIds }), user_email: auth.email }))
}
