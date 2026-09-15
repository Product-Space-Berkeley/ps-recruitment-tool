import { NextRequest, NextResponse } from 'next/server'
import mongoose from 'mongoose'
import { connectDB } from '@/lib/mongodb'
import { Session, SessionMember, SessionBan, Candidate, Vote } from '@/lib/models'
import { requireRole } from '@/lib/serverAuth'
import { isSessionId } from '@/lib/apiValidation'

// Small, read-only snapshot: no essays, interviewer notes, Sheets or writes.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole('grader')
  if (auth instanceof NextResponse) return auth
  const { id } = await params
  if (!isSessionId(id)) return NextResponse.json({ error: 'Invalid session.' }, { status: 400 })
  await connectDB()
  const [session, member, banned] = await Promise.all([
    Session.findById(id).select('created_by status anonymous one_vouch_per_member show_vouch_counts focused_candidate_id focus_version').lean(),
    SessionMember.exists({ session_id: id, user_email: auth.email }),
    SessionBan.exists({ session_id: id, email: auth.email }),
  ])
  if (!session) return NextResponse.json({ error: 'Session not found.' }, { status: 404 })
  const creator = session.created_by?.toLowerCase() === auth.email
  if (banned || (!creator && !member)) return NextResponse.json({ error: 'Join this session to view updates.' }, { status: 403 })
  const candidates = await Candidate.find({ session_id: id }).select('_id status').lean()
  const votes = await Vote.find({ candidate_id: mongoose.trusted({ $in: candidates.map(c => c._id) }) }).select('_id candidate_id voter_name voter_email vote_type').lean()
  return NextResponse.json({
    session: { status: session.status, anonymous: session.anonymous, one_vouch_per_member: session.one_vouch_per_member, show_vouch_counts: session.show_vouch_counts !== false, focused_candidate_id: session.focused_candidate_id?.toString() ?? null, focus_version: session.focus_version ?? 0 },
    candidates: candidates.map(c => ({ id: c._id.toString(), status: c.status })),
    votes: votes.filter(v => session.show_vouch_counts !== false || v.vote_type === 'red_flag' || v.voter_email?.toLowerCase() === auth.email).map(v => {
      const mine = v.voter_email?.toLowerCase() === auth.email
      return { id: v._id.toString(), candidate_id: v.candidate_id.toString(), vote_type: v.vote_type,
        voter_email: mine ? v.voter_email : null,
        voter_name: !mine && (session.anonymous || (v.vote_type === 'red_flag' && !creator)) ? 'Anonymous' : v.voter_name }
    }),
  }, { headers: { 'Cache-Control': 'private, no-store' } })
}
