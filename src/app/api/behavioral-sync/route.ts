import { NextRequest, NextResponse } from 'next/server'
import { connectDB } from '@/lib/mongodb'
import { RecruitmentCycle, Round, Session, SessionBan, SessionMember } from '@/lib/models'
import { requireAuth, requireRole } from '@/lib/serverAuth'
import { isObjectId, readJsonObject } from '@/lib/apiValidation'
import { parseGoogleSheetUrl } from '@/lib/coffeeChats'
import { behavioralRoster, previewBehavioral, syncBehavioral, validateResolutions, type BehavioralSource } from '@/lib/behavioralSync'
import { consumeUserRateLimit } from '@/lib/rateLimit'

export async function GET(req: NextRequest) {
  const auth = await requireAuth()
  if (auth instanceof NextResponse) return auth
  await connectDB()
  let cycleId = req.nextUrl.searchParams.get('cycle_id') ?? ''
  const sessionId = req.nextUrl.searchParams.get('session_id')
  if (sessionId) {
    const s = await Session.findById(sessionId).select('round_id').lean()
    const member = await SessionMember.exists({ session_id: sessionId, user_email: auth.email })
    const banned = await SessionBan.exists({ session_id: sessionId, email: auth.email })
    if (!s || !member || banned) return NextResponse.json({ error: 'Join this session to view sync status.' }, { status: 403 })
    const round = s.round_id ? await Round.findById(s.round_id).select('cycle_id').lean() : null
    if (!round) return NextResponse.json({ connected: false })
    cycleId = round.cycle_id.toString()
    const c = await RecruitmentCycle.findById(cycleId).schemaLevelProjections(false).select('behavioral_source').lean()
    const src = c?.behavioral_source as BehavioralSource | null
    if (!src?.rounds.some(r => r.id === s.round_id?.toString())) return NextResponse.json({ connected: false })
  } else if (auth.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  if (!isObjectId(cycleId)) return NextResponse.json({ error: 'Invalid cycle.' }, { status: 400 })
  const cycle = await RecruitmentCycle.findById(cycleId).schemaLevelProjections(false).select('behavioral_source').lean()
  const source = cycle?.behavioral_source as BehavioralSource | null
  return NextResponse.json({ connected: !!source?.sheetId, cycle_id: cycleId,
    last_success: source?.last_success, error: source?.error, source_rows: source?.source_rows,
    incomplete: source?.incomplete, unresolved: source?.unresolved, sessions: source?.sessions,
    ...(auth.role === 'admin' ? { roster: source?.roster, resolutions: source?.resolutions,
      sheet_url: source?.sheetId ? `https://docs.google.com/spreadsheets/d/${source.sheetId}/edit?gid=${source.gid}` : '', round_ids: source?.rounds?.map(r => r.id) } : {}),
  }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest) {
  const auth = await requireRole('admin')
  if (auth instanceof NextResponse) return auth
  await connectDB()
  if (!await consumeUserRateLimit(auth.email, 'behavioral-sync', 30, 60_000)) return NextResponse.json({ error: 'Please wait before syncing again.' }, { status: 429 })
  const parsed = await readJsonObject(req, 100_000)
  if (!parsed.ok) return parsed.response
  const body = parsed.data
  if (typeof body.cycle_id !== 'string' || !isObjectId(body.cycle_id)) return NextResponse.json({ error: 'Invalid cycle.' }, { status: 400 })
  try {
    if (body.action === 'sync') return NextResponse.json(await syncBehavioral(body.cycle_id, { force: true }))
    if (body.action !== 'preview' && body.action !== 'connect') throw new Error('Choose preview, connect, or sync.')
    const url = typeof body.sheet_url === 'string' ? parseGoogleSheetUrl(body.sheet_url) : null
    if (!url) throw new Error('Enter a Google Sheets link.')
    if (!Array.isArray(body.round_ids) || body.round_ids.length !== 2 || body.round_ids.some(id => typeof id !== 'string' || !isObjectId(id))) throw new Error('Select both final rounds.')
    const cycle = await RecruitmentCycle.findOne({ _id: body.cycle_id, status: 'active' }).schemaLevelProjections(false).select('behavioral_source').lean()
    if (!cycle) throw new Error('Cycle is not active.')
    const existing = cycle.behavioral_source as BehavioralSource | null
    if (existing?.rounds && existing.rounds.map(r => r.id).sort().join() !== [...body.round_ids].sort().join()) throw new Error('The cycle is already connected to different rounds.')
    const targets = existing?.roster ? { roster: existing.roster, rounds: existing.rounds } : await behavioralRoster(body.cycle_id, body.round_ids as string[])
    const source: BehavioralSource = { ...existing, ...url, ...targets, resolutions: { ...existing?.resolutions, ...validateResolutions(body.resolutions, targets.roster) }, created_by: existing?.created_by ?? auth.email }
    if (body.action === 'connect') return NextResponse.json(await syncBehavioral(body.cycle_id, { force: true, configuration: source }))
    const preview = await previewBehavioral(source)
    return NextResponse.json({ preview: { roster: source.roster, resolutions: preview.resolutions, unresolved: preview.unresolved, incomplete: preview.incomplete, source_rows: preview.records.length, candidates: preview.candidates.map(p => ({ id: p.id, name: p.name, role: p.role, score: p.overall_score, responses: p.records.length })) } })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Behavioral sync failed.' }, { status: 422 })
  }
}
