import { NextRequest, NextResponse } from 'next/server'
import { GraderAssignment, Applicant } from '@/lib/models'
import { GenericReview, CandidateRound } from '@/lib/ps/models'
import { psApi, objectId } from '@/lib/ps/api'
import { psRound } from '@/lib/ps/rounds'
import { readJsonObject } from '@/lib/apiValidation'
import { reassignPending } from '@/lib/ps/assignmentService'
import { pairLabel, type InterviewerPair } from '@/lib/ps/domain'
import mongoose from 'mongoose'
type Context = { params: Promise<{ id: string }> }
export async function GET(_req: NextRequest, context: Context) { return psApi('leadership', async () => {
  const { id } = await context.params; const round = await psRound(id)
  const enrollments = await CandidateRound.find({ round_id: id, state: mongoose.trusted({ $in: ['pending', 'in_review'] }) }).select('applicant_id').lean()
  const assignments = await GraderAssignment.find({ round_id: id, applicant_id: mongoose.trusted({ $in: enrollments.map(e => e.applicant_id) }), submission_count: 0 }).lean()
  const reviews = await GenericReview.find({ round_id: id }).select('applicant_id grader_email').lean()
  const submitted = new Set(reviews.map(r => `${r.applicant_id}:${r.grader_email}`))
  const applicants = await Applicant.find({ _id: mongoose.trusted({ $in: assignments.map(a => a.applicant_id) }) }).select('first_name last_name').lean()
  const names = new Map(applicants.map(a => [String(a._id), `${a.first_name} ${a.last_name}`]))
  const pending = assignments.filter(a => !submitted.has(`${a.applicant_id}:${a.grader_email}`))
  if (round.assignment_mode === 'pair') {
    // One entry per (applicant, pair); transferring moves the whole pair's assignment.
    const pairs = (round.interviewer_pairs ?? []) as InterviewerPair[], label = (id: string | null | undefined) => { const p = pairs.find(p => p.id === id); return p ? pairLabel(p) : 'Unknown pair' }
    const seen = new Set<string>(), rows = pending.filter(a => { const k = `${a.applicant_id}:${a.panel_id}`; if (seen.has(k)) return false; seen.add(k); return true })
    return NextResponse.json({ mode: 'pair', targets: pairs.map(p => ({ id: p.id, label: pairLabel(p) })), assignments: rows.map(a => ({ id: String(a._id), name: names.get(String(a.applicant_id)), grader_email: label(a.panel_id) })) })
  }
  return NextResponse.json({ mode: 'individual', targets: round.eligible_grader_emails.map((email: string) => ({ id: email, label: email })), assignments: pending.map(a => ({ id: String(a._id), name: names.get(String(a.applicant_id)), grader_email: a.grader_email })) })
}) }
export async function POST(req: NextRequest, context: Context) { return psApi('leadership', async auth => { const parsed = await readJsonObject(req); if (!parsed.ok) return parsed.response
  const assignmentId = String(parsed.data.assignment_id ?? ''); objectId(assignmentId)
  return NextResponse.json(await reassignPending((await context.params).id, assignmentId, parsed.data.target_email, auth.email)) }) }
