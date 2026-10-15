import { randomBytes } from 'crypto'
import mongoose from 'mongoose'
import { Applicant, Candidate, Round, Session, SessionMember } from '@/lib/models'
import { CandidateRound } from './models'
import { WorkflowError, nextRound } from './domain'
import { lockRound, psRound } from './rounds'
import { frozenRoundScores } from './scoreService'
import { decideEnrollment } from './enrollment'

export async function decisionBoard(roundId: string) {
  const round = await psRound(roundId)
  const rows = await CandidateRound.find({ round_id: roundId }).lean()
  const applicants = await Applicant.find({ _id: mongoose.trusted({ $in: rows.map(r => r.applicant_id) }) }).select('first_name last_name email year').lean()
  const scores = await frozenRoundScores(roundId)
  const rounds = await Round.find({ cycle_id: round.cycle_id, workflow: 'ps' }).lean()
  const next = nextRound(rounds.map(r => ({ id: String(r._id), order_index: r.order_index, archived: r.archived })), roundId)
  return { final: !next, candidates: rows.map(row => {
    const applicant = applicants.find(a => String(a._id) === String(row.applicant_id))
    const score = scores.find(s => s.applicant_id === String(row.applicant_id))
    return { applicant_id: String(row.applicant_id), name: applicant ? `${applicant.first_name} ${applicant.last_name}` : 'Applicant', email: applicant?.email ?? '', year: applicant?.year ?? '', state: row.state, score: score?.score ?? null, normalization: score?.normalization ?? null, complete: score?.complete ?? false, decision_by: row.decision_by, decision_at: row.decision_at }
  }).sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity) || a.name.localeCompare(b.name)) }
}

// Session, roster and membership commit together; retries reuse the active session.
export async function startDeliberation(roundId: string, actor: string) {
  let id = ''
  await mongoose.connection.transaction(async tx => {
    const round = await lockRound(roundId, tx)
    if (round.status !== 'deliberating') throw new WorkflowError('Close grading before starting deliberation.', 409)
    const existing = await Session.findOne({ round_id: roundId, status: 'active' }).session(tx).lean()
    if (existing) { id = existing._id; return }
    const enrollments = await CandidateRound.find({ round_id: roundId, state: mongoose.trusted({ $in: ['ready_for_deliberation', 'hold'] }) }).session(tx).lean()
    if (!enrollments.length) throw new WorkflowError('No ready or held candidates are available for deliberation.', 409)
    const scores = await frozenRoundScores(roundId)
    const applicants = await Applicant.find({ _id: mongoose.trusted({ $in: enrollments.map(e => e.applicant_id) }) }).select('first_name last_name email year').session(tx).lean()
    id = randomBytes(3).toString('hex').toUpperCase()
    await Session.create([{ _id: id, name: `${round.name} deliberation`, round_id: roundId, created_by: actor }], { session: tx })
    await SessionMember.create([{ session_id: id, user_email: actor }], { session: tx })
    await Candidate.insertMany(enrollments.map(e => {
      const a = applicants.find(a => String(a._id) === String(e.applicant_id))
      if (!a) throw new WorkflowError('An enrolled applicant is missing.', 409)
      const score = scores.find(s => s.applicant_id === String(a._id))
      return { session_id: id, applicant_id: a._id, name: `${a.first_name} ${a.last_name}`, status: e.state === 'hold' ? 'hold' : 'pending', data: { ps_workflow: true, score: score?.score ?? null, Email: a.email, 'Class year': a.year, 'Overall Score': score?.score ?? null, 'Normalized score': score?.normalization?.z ?? null, 'Recommendation': score?.normalization?.recommendation ?? 'yellow', 'Class cohort': score?.normalization?.cohort ?? '', 'Reviews complete': score?.complete ? 'Yes' : 'No', 'Score snapshot': score?.frozen_at ?? '' } }
    }), { session: tx })
  })
  return { id }
}

// Consensus colors are provisional until the host explicitly finishes the room.
export async function decideSessionCandidates(sessionId: string, ids: string[], status: string, actor: { email: string; role: string }) {
  if (!['accepted', 'rejected', 'hold', 'pending'].includes(status)) throw new WorkflowError('Choose green, red or yellow.')
  await mongoose.connection.transaction(async tx => {
    const session = await Session.findById(sessionId).session(tx).lean()
    if (!session || session.status !== 'active' || session.decisions_finalized_at) throw new WorkflowError('This session is closed.', 409)
    if (session.created_by !== actor.email) throw new WorkflowError('Only the session host can save consensus.', 403)
    await lockRound(String(session.round_id), tx)
    await Session.updateOne({ _id: sessionId }, { $inc: { activity_write_count: 1 } }, { session: tx })
    const candidates = await Candidate.find({ _id: mongoose.trusted({ $in: ids }), session_id: sessionId }).session(tx).lean()
    if (candidates.length !== ids.length || candidates.some(c => !c.applicant_id)) throw new WorkflowError('Select candidates belonging to this session.', 409)
    await Candidate.updateMany({ _id: mongoose.trusted({ $in: ids }), session_id: sessionId }, { $set: { status } }, { session: tx })
  })
}

export async function finishDecisions(sessionId: string, actor: string) {
  await mongoose.connection.transaction(async tx => {
    const session = await Session.findById(sessionId).session(tx).lean()
    if (!session) throw new WorkflowError('Session not found.', 404)
    if (session.created_by !== actor) throw new WorkflowError('Only the session host can finish decisions.', 403)
    if (session.decisions_finalized_at) return
    if (session.status !== 'active' || !session.round_id) throw new WorkflowError('This room is not an active round deliberation.', 409)
    const round = await lockRound(String(session.round_id), tx)
    if (round.status !== 'deliberating') throw new WorkflowError('Close grading before finishing decisions.', 409)
    await Session.updateOne({ _id: sessionId }, { $inc: { activity_write_count: 1 } }, { session: tx })
    const candidates = await Candidate.find({ session_id: sessionId }).session(tx).lean()
    const pending = await CandidateRound.find({ round_id: round._id, state: mongoose.trusted({ $in: ['ready_for_deliberation', 'hold'] }) }).session(tx).lean()
    if (!candidates.length || candidates.length !== pending.length || candidates.some(c => !['accepted', 'rejected'].includes(c.status) || !pending.some(e => String(e.applicant_id) === String(c.applicant_id)))) throw new WorkflowError('Every candidate must be green or red. Resolve yellow candidates first.', 409)
    const rounds = await Round.find({ cycle_id: round.cycle_id, workflow: 'ps' }).session(tx).lean()
    const next = nextRound(rounds.map(r => ({ id: String(r._id), order_index: r.order_index, archived: r.archived })), String(round._id))
    for (const c of candidates) await decideEnrollment(String(round._id), String(c.applicant_id), c.status === 'rejected' ? 'reject' : next ? 'advance' : 'accept', actor, tx)
    await Session.updateOne({ _id: sessionId }, { $set: { status: 'ended', decisions_finalized_at: new Date(), decisions_finalized_by: actor } }, { session: tx })
  })
  return { ok: true }
}

export function decisionCsv(rows: Awaited<ReturnType<typeof decisionBoard>>['candidates']) {
  const cell = (value: unknown) => {
    let text = String(value ?? '')
    if (/^[\s]*[=+\-@\t\r\n]/.test(text)) text = `'${text}`
    return `"${text.replaceAll('"', '""')}"`
  }
  return [['Name', 'Email', 'Class year', 'Decision', 'Score', 'Cohort', 'Normalized score', 'Advisory color', 'Reviews complete', 'Decided by', 'Decided at'], ...rows.map(r => [r.name, r.email, r.year, r.state, r.score, r.normalization?.cohort, r.normalization?.z, r.normalization?.recommendation, r.complete, r.decision_by, r.decision_at?.toISOString()])].map(row => row.map(cell).join(',')).join('\r\n')
}
