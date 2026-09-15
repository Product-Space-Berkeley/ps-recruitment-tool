import { NextRequest, NextResponse } from 'next/server'
import mongoose from 'mongoose'
import { connectDB } from '@/lib/mongodb'
import { Applicant, Candidate, CoffeeChatNote, RecruitmentCycle, Round, Session, SessionBan, SessionMember } from '@/lib/models'
import { fetchGoogleSheetCsv, normalizePersonName, parseAndMatchCoffeeChatCsv } from '@/lib/coffeeChats'
import { requireRole } from '@/lib/serverAuth'

export async function GET(req: NextRequest) {
  const auth = await requireRole('grader')
  if (auth instanceof NextResponse) return auth

  const candidateId = new URL(req.url).searchParams.get('candidate_id') ?? ''
  if (!mongoose.isValidObjectId(candidateId)) {
    return NextResponse.json({ error: 'A valid candidate_id is required.' }, { status: 400 })
  }

  await connectDB()
  const candidate = await Candidate.findById(candidateId).select('applicant_id session_id name').lean()
  if (!candidate) return NextResponse.json({ error: 'Candidate not found.' }, { status: 404 })

  const session = await Session.findById(candidate.session_id).select('round_id').lean()
  if (!session) return NextResponse.json({ error: 'Session not found.' }, { status: 404 })
  const round = session.round_id
    ? await Round.findById(session.round_id).select('cycle_id').lean()
    : null

  const [isMember, banned] = await Promise.all([
    SessionMember.exists({ session_id: candidate.session_id, user_email: auth.email }),
    SessionBan.exists({ session_id: candidate.session_id, email: auth.email }),
  ])
  if (banned) return NextResponse.json({ error: 'You have been removed from this session.' }, { status: 403 })
  if (!isMember) return NextResponse.json({ error: 'Join this session to view coffee-chat notes.' }, { status: 403 })

  let applicantId = candidate.applicant_id?.toString() ?? null
  if (applicantId && round) {
    const belongsToCycle = await Applicant.exists({ _id: applicantId, cycle_id: round.cycle_id })
    if (!belongsToCycle) return NextResponse.json({ error: 'Candidate does not belong to this cycle.' }, { status: 403 })
  }
  if (!applicantId && round) {
      const applicants = await Applicant.find({ cycle_id: round.cycle_id }).select('first_name last_name').lean()
      const candidateName = normalizePersonName(candidate.name)
      const matches = applicants.filter(applicant =>
        normalizePersonName(`${applicant.first_name} ${applicant.last_name}`) === candidateName,
      )
      if (matches.length === 1) applicantId = matches[0]._id.toString()
  }
  if (!applicantId) return NextResponse.json([])

  if (round) {
    const cycle = await RecruitmentCycle.findById(round.cycle_id)
      .schemaLevelProjections(false).select('coffee_chat_sheet_id coffee_chat_sheet_gid')
      .lean()
    if (cycle?.coffee_chat_sheet_id) {
      try {
        const [csvText, applicants] = await Promise.all([
          fetchGoogleSheetCsv({
            sheetId: cycle.coffee_chat_sheet_id,
            gid: cycle.coffee_chat_sheet_gid ?? '0',
          }),
          Applicant.find({ cycle_id: round.cycle_id }).select('first_name last_name').lean(),
        ])
        const preview = parseAndMatchCoffeeChatCsv(csvText, applicants.map(applicant => ({
          id: applicant._id.toString(),
          first_name: applicant.first_name,
          last_name: applicant.last_name,
        })))
        const liveNotes = preview.matched_rows
          .filter(note => note.applicant_id === applicantId)
          .sort((left, right) => {
            if (!left.chat_date && right.chat_date) return 1
            if (left.chat_date && !right.chat_date) return -1
            return String(left.chat_date ?? '').localeCompare(String(right.chat_date ?? '')) || left.source_row - right.source_row
          })
          .map(note => ({
            id: `live-${note.source_row}`,
            cycle_id: round.cycle_id.toString(),
            applicant_id: note.applicant_id,
            applicant_name: note.applicant_name,
            chatter_name: note.chatter_name,
            notes: note.notes,
            is_coffee_chat: note.is_coffee_chat,
            recommended_overall: note.recommended_overall,
            chat_date: note.chat_date,
            other_notes: note.other_notes,
            imported_by: 'Live Google Sheet',
            imported_at: new Date().toISOString(),
          }))
        return NextResponse.json(liveNotes, {
          headers: { 'Cache-Control': 'no-store, max-age=0', 'X-Coffee-Chat-Source': 'live' },
        })
      } catch {
        // Keep deliberations usable during a temporary Google Sheets outage by
        // falling back to the last successfully imported database snapshot.
      }
    }
  }

  const notes = await CoffeeChatNote.find({ applicant_id: applicantId }).lean()
  notes.sort((a, b) => {
    if (!a.chat_date && b.chat_date) return 1
    if (a.chat_date && !b.chat_date) return -1
    return String(a.chat_date ?? '').localeCompare(String(b.chat_date ?? '')) ||
      a.imported_at.getTime() - b.imported_at.getTime()
  })

  return NextResponse.json(notes.map(note => ({
    ...note,
    id: note._id.toString(),
    cycle_id: note.cycle_id.toString(),
    applicant_id: note.applicant_id.toString(),
    _id: undefined,
  })), { headers: { 'Cache-Control': 'no-store, max-age=0', 'X-Coffee-Chat-Source': 'database' } })
}
