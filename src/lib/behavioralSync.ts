import { randomBytes } from 'crypto'
import mongoose from 'mongoose'
import { Applicant, Candidate, RecruitmentCycle, Round, Session, SessionMember } from '@/lib/models'
import { fetchGoogleSheetCsv, type GoogleSheetSource } from '@/lib/coffeeChats'
import { aggregateBehavioral, matchBehavioral, normalizeBehavioralName, parseBehavioralCsv, type BehavioralPerson } from '@/lib/behavioralImport'

export type BehavioralSource = GoogleSheetSource & {
  rounds: { id: string; role: 'curriculum' | 'developer'; name: string }[]
  roster: BehavioralPerson[]; resolutions: Record<string, string>; created_by: string
  last_success?: string; error?: string | null; source_rows?: number
  unresolved?: { name: string; rows: number[] }[]
  incomplete?: { name: string; interviewer: string; row: number }[]
  sessions?: { id: string; role: string }[]
}

export async function behavioralRoster(cycleId: string, roundIds: string[]) {
  const rounds = await Round.find({ _id: mongoose.trusted({ $in: roundIds }), cycle_id: cycleId, grading_type: 'interview', status: mongoose.trusted({ $ne: 'ended' }) }).lean()
  if (rounds.length !== 2 || new Set(rounds.map(r => r.role)).size !== 2 || rounds.some(r => !r.role)) throw new Error('Select one active Curriculum and one Developer interview round.')
  const roster: BehavioralPerson[] = []
  for (const round of rounds) {
    const prior = await Round.findOne({ cycle_id: cycleId, role: mongoose.trusted({ $in: [round.role, null] }), order_index: mongoose.trusted({ $lt: round.order_index }) }).sort({ order_index: -1 }).lean()
    if (!prior) throw new Error(`No prior round for ${round.name}.`)
    const sessions = await Session.find({ round_id: prior._id, role: round.role }).select('_id').lean()
    const accepted = await Candidate.find({ session_id: mongoose.trusted({ $in: sessions.map(s => s._id) }), status: 'accepted' }).select('applicant_id name').lean()
    const applicants = await Applicant.find({ _id: mongoose.trusted({ $in: accepted.map(c => c.applicant_id).filter(Boolean) }), cycle_id: cycleId }).select('first_name last_name').lean()
    if (accepted.length !== applicants.length) throw new Error('Accepted candidates contain duplicate or missing applicant links. Resolve these before connecting.')
    roster.push(...applicants.map(a => ({ id: a._id.toString(), name: `${a.first_name} ${a.last_name}`, role: round.role as BehavioralPerson['role'] })))
  }
  if (new Set(roster.map(p => p.id)).size !== roster.length) throw new Error('An applicant is accepted in both tracks. Resolve the track before connecting.')
  return { roster, rounds: rounds.map(r => ({ id: r._id.toString(), name: r.name, role: r.role as BehavioralPerson['role'] })) }
}

export function validateResolutions(value: unknown, roster: BehavioralPerson[]): Record<string, string> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid name mappings.')
  const result: Record<string, string> = Object.create(null)
  for (const [key, id] of Object.entries(value)) {
    if (typeof id !== 'string' || (id !== 'exclude' && !roster.some(p => p.id === id)) || key.length > 200) throw new Error('Invalid applicant mapping.')
    const normalized = normalizeBehavioralName(key)
    if (['__proto__', 'constructor', 'prototype'].includes(normalized)) throw new Error('Invalid name.')
    result[normalized] = id
  }
  return result
}

export async function previewBehavioral(source: BehavioralSource) {
  const records = parseBehavioralCsv(await fetchGoogleSheetCsv(source))
  const matched = matchBehavioral(records, source.roster, source.resolutions)
  return {
    records, ...matched,
    candidates: source.roster.map(p => ({ ...p, ...aggregateBehavioral(matched.grouped.get(p.id) ?? []) })),
    incomplete: records.filter(r => !r.complete).map(r => ({ name: r.source_name, interviewer: r.interviewer, row: r.source_row })),
  }
}

// A Mongo lease coordinates all viewers and both sessions across Vercel instances.
// Only the lease holder fetches Google and writes the imported snapshot.
export async function syncBehavioral(cycleId: string, options: { force?: boolean; configuration?: BehavioralSource } = {}) {
  const now = new Date()
  const token = randomBytes(16).toString('hex')
  const lease = await RecruitmentCycle.findOneAndUpdate({
    _id: cycleId, status: 'active',
    $and: [
      { $or: [{ behavioral_sync_lock_until: null }, { behavioral_sync_lock_until: mongoose.trusted({ $lte: now }) }] },
      ...(options.force ? [] : [{ $or: [{ behavioral_sync_next_at: null }, { behavioral_sync_next_at: mongoose.trusted({ $lte: now }) }] }]),
    ],
  }, { $set: { behavioral_sync_token: token, behavioral_sync_lock_until: new Date(now.getTime() + 60_000), behavioral_sync_next_at: new Date(now.getTime() + 30_000) } }, { returnDocument: 'after' }).schemaLevelProjections(false).select('behavioral_source').lean()
  if (!lease) return { busy: true }
  const source = (options.configuration ?? lease.behavioral_source) as BehavioralSource | null
  try {
    if (!source) throw new Error('Behavioral sheet is not connected.')
    const preview = await previewBehavioral(source)
    // An unresolved name could be an alias of an existing applicant: do not
    // silently remove that person's prior score while awaiting a resolution.
    if (preview.unresolved.length) {
      if (lease.behavioral_source) await RecruitmentCycle.updateOne({ _id: cycleId, behavioral_sync_token: token }, { $set: {
        'behavioral_source.unresolved': preview.unresolved,
        'behavioral_source.error': 'Resolve unmatched names before the next sync. Previous scores are retained.',
      } })
      throw new Error('Resolve unmatched names before syncing.')
    }
    const sessions: { id: string; role: string }[] = []
    await mongoose.connection.transaction(async tx => {
      sessions.length = 0
      const guarded = await RecruitmentCycle.updateOne({ _id: cycleId, status: 'active', behavioral_sync_token: token, behavioral_sync_lock_until: mongoose.trusted({ $gt: new Date() }) }, { $inc: { lifecycle_write_count: 1 } }, { session: tx })
      if (!guarded.matchedCount) throw new Error('Sync lease expired. Please retry.')
      for (const target of source.rounds) {
        const round = await Round.findOneAndUpdate({ _id: target.id, cycle_id: cycleId, role: target.role, grading_type: 'interview', status: mongoose.trusted({ $ne: 'ended' }) }, { $set: { status: 'deliberating' }, $inc: { lifecycle_write_count: 1 } }, { session: tx, returnDocument: 'after' }).lean()
        if (!round) throw new Error('A final round has ended or changed. Sync stopped.')
        let session = await Session.findOne({ round_id: round._id, role: target.role, status: 'active' }).session(tx).lean()
        if (!session) {
          // Never recreate an ended final session automatically.
          if (!options.configuration || await Session.exists({ round_id: round._id, role: target.role }).session(tx)) throw new Error('Final session is not active. Sync stopped.')
          const id = randomBytes(6).toString('hex').slice(0, 6).toUpperCase()
          const created = await Session.create([{ _id: id, round_id: round._id, role: target.role, name: `${round.name} Deliberation`, status: 'active', created_by: source.created_by }], { session: tx })
          session = created[0].toObject()
          await SessionMember.create([{ session_id: id, user_email: source.created_by }], { session: tx })
        }
        await Session.updateOne({ _id: session!._id, status: 'active' }, { $inc: { activity_write_count: 1 } }, { session: tx })
        sessions.push({ id: session!._id, role: target.role })
        for (const p of preview.candidates.filter(p => p.role === target.role)) {
          const { format, interviewers, criterion_averages, overall_score, records, source_names } = p
          await Candidate.updateOne({ session_id: session!._id, applicant_id: p.id }, {
            $set: { 'data.score': overall_score, 'data.interview': { format, interviewers, criterion_averages, overall_score, records, source_names } },
            $setOnInsert: { session_id: session!._id, applicant_id: p.id, name: p.name, status: 'pending' },
          }, { session: tx, upsert: true })
        }
      }
      await RecruitmentCycle.updateOne({ _id: cycleId, behavioral_sync_token: token }, { $set: {
        behavioral_source: { ...source, resolutions: preview.resolutions, sessions, last_success: new Date().toISOString(), error: null, source_rows: preview.records.length, incomplete: preview.incomplete, unresolved: [] },
      } }, { session: tx })
    })
    return { ok: true, sessions, applicants: preview.candidates.length }
  } catch (error) {
    if (lease.behavioral_source) await RecruitmentCycle.updateOne({ _id: cycleId, behavioral_sync_token: token }, { $set: { 'behavioral_source.error': error instanceof Error ? error.message : 'Sync failed.' } })
    throw error
  } finally {
    await RecruitmentCycle.updateOne({ _id: cycleId, behavioral_sync_token: token }, { $set: { behavioral_sync_lock_until: null, behavioral_sync_token: null } })
  }
}
