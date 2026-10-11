import mongoose from 'mongoose'
import { Candidate, GraderAssignment, Round, SessionMember, SessionBan } from '@/lib/models'
import { CandidateRound } from '@/lib/ps/models'

// Graders may read an applicant they are assigned to in an actively grading
// round, or one in a deliberation session they joined. Leadership and admins
// can read any applicant.
export async function canReadApplicant(auth: { email: string; role: string }, applicantId: string): Promise<boolean> {
  if (auth.role !== 'grader') return true
  const enrolled = await CandidateRound.find({ applicant_id: applicantId }).select('round_id').lean()
  if (enrolled.length && await Round.exists({ _id: mongoose.trusted({ $in: enrolled.map(e => e.round_id) }), workflow: 'ps', grading_access: 'open', status: 'grading', archived: false, eligible_grader_emails: auth.email })) return true

  const assignments = await GraderAssignment.find({ applicant_id: applicantId, grader_email: auth.email }).select('round_id').lean()
  const roundIds = assignments.map(assignment => assignment.round_id)
  if (roundIds.length && await Round.exists({ _id: mongoose.trusted({ $in: roundIds }), status: 'grading' })) return true

  const sessionIds = await Candidate.find({ applicant_id: applicantId }).distinct('session_id')
  const bans = await SessionBan.find({ email: auth.email }).distinct('session_id')
  const allowed = sessionIds.filter(id => !bans.includes(id))
  return allowed.length > 0 && Boolean(await SessionMember.exists({ session_id: mongoose.trusted({ $in: allowed }), user_email: auth.email }))
}
