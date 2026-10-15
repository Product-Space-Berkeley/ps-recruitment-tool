import mongoose from 'mongoose'
import { NextRequest, NextResponse } from 'next/server'
import { Applicant, Round } from '@/lib/models'
import { CandidateRound, GenericReview, PSEvaluationContribution } from '@/lib/ps/models'
import { objectId, psApi, serialize } from '@/lib/ps/api'
import { psRound } from '@/lib/ps/rounds'
import { enrollFirstRound } from '@/lib/ps/enrollment'
import { frozenRoundScores } from '@/lib/ps/scoreService'
import { nextRound, WorkflowError } from '@/lib/ps/domain'
import { readJsonObject } from '@/lib/apiValidation'
type Context = { params: Promise<{ id: string }> }
export async function GET(_req: NextRequest, context: Context) {
  return psApi('leadership', async () => {
    const { id } = await context.params; const round = await psRound(id)
    const scores = await frozenRoundScores(id)
    const rows = await CandidateRound.find({ round_id: id }).sort({ created_at: 1 }).lean()
    const scoreOf = (id: unknown) => scores.find(s => s.applicant_id === String(id))?.score ?? null
    rows.sort((a, b) => (scoreOf(b.applicant_id) ?? -Infinity) - (scoreOf(a.applicant_id) ?? -Infinity))
    const reviews = await GenericReview.find({ round_id: id }).select('applicant_id grader_email').lean()
    const contributions = await PSEvaluationContribution.find({ round_id: id }).select('applicant_id grader_email').lean()
    const completed = [...reviews, ...contributions].filter((r, i, all) => all.findIndex(x => String(x.applicant_id) === String(r.applicant_id) && x.grader_email === r.grader_email) === i)
    const applicants = await Applicant.find({ _id: mongoose.trusted({ $in: rows.map(r => r.applicant_id) }) }).select('first_name last_name').lean()
    const names = new Map(applicants.map(a => [String(a._id), `${a.first_name} ${a.last_name}`]))
    const rounds = await Round.find({ cycle_id: round.cycle_id, workflow: 'ps' }).lean()
    const next = nextRound(rounds.map(r => ({ id: String(r._id), order_index: r.order_index, archived: r.archived })), id)
    return NextResponse.json({ next_round: next ? serialize(rounds.find(r => String(r._id) === next.id)!) : null, reviews_required: round.reviews_required, enrollments: rows.map(r => ({ ...serialize(r), score: scoreOf(r.applicant_id), name: names.get(String(r.applicant_id)) ?? 'Applicant', completed_reviews: completed.filter(review => String(review.applicant_id) === String(r.applicant_id)).length })) })
  })
}
export async function POST(req: NextRequest, context: Context) {
  return psApi('leadership', async auth => {
    const { id } = await context.params; objectId(id)
    const parsed = await readJsonObject(req); if (!parsed.ok) return parsed.response
    if (parsed.data.action === 'enroll') {
      let count = 0; await mongoose.connection.transaction(async tx => { count = await enrollFirstRound(id, auth.email, tx) })
      return NextResponse.json({ ok: true, count })
    }
    throw new WorkflowError('Record consensus and finish decisions in the live deliberation room.', 409)
  })
}
