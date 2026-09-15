'use client'

import { useEffect, useState, useCallback, useRef, use } from 'react'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { useSession, signOut } from 'next-auth/react'
import { Session, Candidate, Vote, VoteType, CandidateNote, GraderReview, CoffeeChatNote } from '@/lib/types'
import AdminPanel from '@/components/AdminPanel'
import ThemeToggle from '@/components/ThemeToggle'
import BehavioralSyncPanel from '@/components/BehavioralSyncPanel'
import { behavioralNoteLabel } from '@/lib/behavioralDisplay'

const STATUS_COLORS: Record<string, string> = {
  accepted: 'bg-green-500',
  rejected: 'bg-red-500',
  hold: 'bg-yellow-500',
  pending: 'bg-gray-600',
}

const STATUS_BADGE: Record<string, string> = {
  accepted: 'bg-green-500/15 text-green-600 border-green-500/30',
  rejected: 'bg-red-500/15 text-red-600 border-red-500/30',
  hold: 'bg-yellow-500/15 text-yellow-600 border-yellow-500/30',
  pending: 'bg-[var(--bg-raised)] text-[var(--text-muted)] border-[var(--border)]',
}

const STATUS_BTN: Record<string, { active: string; inactive: string }> = {
  accepted: { active: 'bg-green-600 text-white border-transparent', inactive: 'bg-green-500/10 text-green-600 border-green-500/30 hover:bg-green-500/20' },
  rejected: { active: 'bg-red-600 text-white border-transparent', inactive: 'bg-red-500/10 text-red-600 border-red-500/30 hover:bg-red-500/20' },
  hold: { active: 'bg-yellow-600 text-white border-transparent', inactive: 'bg-yellow-500/10 text-yellow-600 border-yellow-500/30 hover:bg-yellow-500/20' },
  pending: { active: 'bg-[var(--bg-active)] text-[var(--text-primary)] border-transparent', inactive: 'bg-[var(--bg-raised)] text-[var(--text-muted)] border-[var(--border)] hover:text-[var(--text-primary)]' },
}


type ApplicantInfo = {
  linkedin: string | null
  website: string | null
  has_resume: boolean
  infosessions_attended: string[]
}

type GenderCategory = 'male' | 'female' | 'other' | 'unknown'

const GENDER_BADGE: Record<GenderCategory, { label: string; shortLabel: string; className: string }> = {
  male: { label: 'Male', shortLabel: 'M', className: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-600' },
  female: { label: 'Female', shortLabel: 'F', className: 'border-pink-500/30 bg-pink-500/10 text-pink-600' },
  other: { label: 'Other gender', shortLabel: 'Other', className: 'border-purple-500/30 bg-purple-500/10 text-purple-600' },
  unknown: { label: 'Gender not provided', shortLabel: '—', className: 'border-[var(--border)] bg-[var(--bg-raised)] text-[var(--text-muted)]' },
}

function categorizeGender(value: unknown): GenderCategory {
  if (typeof value !== 'string') return 'unknown'
  const normalized = value.trim().toLowerCase()
  if (['male', 'man', 'm'].includes(normalized)) return 'male'
  if (['female', 'woman', 'f'].includes(normalized)) return 'female'
  return normalized ? 'other' : 'unknown'
}

function GenderBadge({ gender }: { gender: unknown }) {
  const badge = GENDER_BADGE[categorizeGender(gender)]
  return (
    <span
      title={badge.label}
      aria-label={badge.label}
      className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold leading-none ${badge.className}`}
    >
      {badge.shortLabel}
    </span>
  )
}

function GenderBreakdown({ counts, total }: { counts: Record<GenderCategory, number>; total: number }) {
  const percentage = (count: number) => total > 0 ? `${((count / total) * 100).toFixed(1)}%` : '0.0%'
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      <span className="text-cyan-600">Male <strong>{counts.male}</strong> ({percentage(counts.male)})</span>
      <span className="text-pink-600">Female <strong>{counts.female}</strong> ({percentage(counts.female)})</span>
      {counts.other > 0 && <span className="text-purple-600">Other <strong>{counts.other}</strong> ({percentage(counts.other)})</span>}
      {counts.unknown > 0 && <span className="text-[var(--text-muted)]">Not provided <strong>{counts.unknown}</strong> ({percentage(counts.unknown)})</span>}
    </div>
  )
}

function GenderRatio({ candidates }: { candidates: Candidate[] }) {
  const summarize = (rows: Candidate[]) => rows.reduce<Record<GenderCategory, number>>((totals, candidate) => {
    totals[categorizeGender(candidate.data?.gender)] += 1
    return totals
  }, { male: 0, female: 0, other: 0, unknown: 0 })

  const groups = [
    { label: 'All applicants', rows: candidates, labelClass: 'text-[var(--text-primary)]' },
    { label: 'Not rejected', rows: candidates.filter(candidate => candidate.status !== 'rejected'), labelClass: 'text-purple-600' },
    { label: 'Pending', rows: candidates.filter(candidate => candidate.status === 'pending'), labelClass: 'text-[var(--text-primary)]' },
    { label: 'Accepted / Greened', rows: candidates.filter(candidate => candidate.status === 'accepted'), labelClass: 'text-green-600' },
    { label: 'Hold', rows: candidates.filter(candidate => candidate.status === 'hold'), labelClass: 'text-yellow-600' },
    { label: 'Rejected', rows: candidates.filter(candidate => candidate.status === 'rejected'), labelClass: 'text-red-600' },
  ]

  return (
    <div className="shrink-0 border-b border-[var(--border)] bg-[var(--bg-surface)] px-4 py-2 text-xs">
      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
        {groups.map(group => (
          <div key={group.label} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-[var(--border)] bg-[var(--bg-raised)]/60 px-3 py-1.5">
            <span className={`w-36 shrink-0 font-semibold ${group.labelClass}`}>
              {group.label} ({group.rows.length})
            </span>
            <GenderBreakdown counts={summarize(group.rows)} total={group.rows.length} />
          </div>
        ))}
      </div>
    </div>
  )
}

function safeExternalUrl(value: string | null | undefined) {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
  } catch {
    return null
  }
}

function compareCandidatesByScore(a: Candidate, b: Candidate) {
  const aScore = Number(a.data?.score ?? a.data?.Scores)
  const bScore = Number(b.data?.score ?? b.data?.Scores)
  const aHasScore = Number.isFinite(aScore)
  const bHasScore = Number.isFinite(bScore)

  if (aHasScore && bHasScore && aScore !== bScore) return bScore - aScore
  if (aHasScore !== bHasScore) return aHasScore ? -1 : 1
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
}

export default function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: sessionId } = use(params)
  const router = useRouter()
  const { data: authSession, status: authStatus } = useSession()

  const [session, setSession] = useState<Session | null>(null)
  const [banned, setBanned] = useState(false)
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [votes, setVotes] = useState<Vote[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const refreshInFlight = useRef(false)
  const voteReadInFlight = useRef(false)
  const voteWriteInFlight = useRef(false)
  const voteRevision = useRef(0)
  const decisionRevision = useRef(0)
  const liveRevision = useRef(0)
  const pendingDecisions = useRef(new Set<string>())
  const voteCandidateIds = useRef<string[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const seenFocus = useRef({ session: '', version: -1 })
  const [controlBusy, setControlBusy] = useState(false)
  const [controlError, setControlError] = useState('')
  const [filterStatus, setFilterStatus] = useState<string>('all')
  const [showAdminPanel, setShowAdminPanel] = useState(false)
  const [memberCount, setMemberCount] = useState(0)
  const [search, setSearch] = useState('')
  const [idCopied, setIdCopied] = useState(false)
  const [viewMode, setViewMode] = useState<'candidate' | 'list'>('candidate')
  const [sidebarExpanded, setSidebarExpanded] = useState(false)
  const [bulkMode, setBulkMode] = useState(false)
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<Set<string>>(new Set())
  const [bulkUpdating, setBulkUpdating] = useState(false)

  function copySessionId() {
    navigator.clipboard.writeText(sessionId)
    setIdCopied(true)
    setTimeout(() => setIdCopied(false), 1500)
  }

  const userEmail = authSession?.user?.email ?? ''
  const userName = authSession?.user?.name ?? userEmail

  const isAdmin = !!userEmail && !!session && userEmail === session.created_by

  const loadVotes = useCallback(async () => {
    if (voteReadInFlight.current || voteWriteInFlight.current) return
    const ids = voteCandidateIds.current
    if (!ids.length) return
    voteReadInFlight.current = true
    const revision = voteRevision.current
    const decisions = decisionRevision.current
    try {
      const response = await fetch(`/api/sessions/${sessionId}/live`, { signal: AbortSignal.timeout(10000), cache: 'no-store' })
      if (response.status === 403) { setBanned(true); return }
      if (!response.ok) throw new Error('Live refresh failed')
      const snapshot: { votes: Vote[]; candidates: Pick<Candidate, 'id' | 'status'>[]; session: Partial<Session> } = await response.json()
      liveRevision.current++
      // A read started before a successful mutation must not undo its UI update.
      if (revision === voteRevision.current && !voteWriteInFlight.current) setVotes(snapshot.votes)
      if (decisions === decisionRevision.current) {
        const statuses = new Map(snapshot.candidates.map(c => [c.id, c.status]))
        setCandidates(current => current.map(c => !pendingDecisions.current.has(c.id) && statuses.has(c.id) ? { ...c, status: statuses.get(c.id)! } : c))
      }
      setSession(current => current ? { ...current, ...snapshot.session } : current)
      if ((snapshot.session.focus_version ?? 0) > seenFocus.current.version) {
        seenFocus.current = { session: sessionId, version: snapshot.session.focus_version ?? 0 }
        if (snapshot.session.focused_candidate_id && ids.includes(snapshot.session.focused_candidate_id)) {
          setSelectedId(snapshot.session.focused_candidate_id); setViewMode('candidate'); setFilterStatus('all'); setSearch(''); setBulkMode(false)
        }
      }
    } catch { /* Retain the previous votes; retry on the next lightweight poll. */ }
    finally { voteReadInFlight.current = false }
  }, [sessionId])

  const loadData = useCallback(async () => {
    if (refreshInFlight.current) return
    refreshInFlight.current = true
    const liveAtStart = liveRevision.current
    const decisionsAtStart = decisionRevision.current
    try {
    const read = (url: string) => fetch(url, { signal: AbortSignal.timeout(15000) })
    const [sessionRes, candidatesRes, membersRes] = await Promise.all([
      read(`/api/sessions/${sessionId}`),
      read(`/api/sessions/${sessionId}/candidates`),
      read(`/api/session-members?session_id=${sessionId}`),
    ])

    // 403 from the session endpoint means this user has been banned.
    if (sessionRes.status === 403) { setBanned(true); return }
    if (!sessionRes.ok || !candidatesRes.ok || !membersRes.ok) throw new Error('Unable to refresh session data. Please retry.')
    const sessionData = sessionRes.ok ? await sessionRes.json() : null
    const rawCands: Candidate[] = candidatesRes.ok ? await candidatesRes.json() : []
    const membersData = membersRes.ok ? await membersRes.json() : []

    let cands = rawCands.map((c: Candidate) => ({
      ...c,
      data: typeof c.data === 'string' ? JSON.parse(c.data) : c.data,
    }))

    // Merge grader review scores if this session is linked to a round
    if (sessionData?.round_id && cands.some(c => c.applicant_id && !c.data?.interview)) {
      const statsRes = await read(`/api/admin/grading-stats?round_id=${sessionData.round_id}`)
      if (statsRes.ok) {
        const stats = await statsRes.json()
        type StatRow = {
          applicant_id: string; total: number
          r0: number; r1: number; r2: number; r3: number; r4: number; r5: number; r6: number; r7: number; r8: number; r9: number
          reviews?: GraderReview[]
        }
        const scoreMap = new Map<string, Record<string, number>>(
          (stats.applicants ?? []).map((a: StatRow) => [
            a.applicant_id,
            { score: a.total, r0: a.r0, r1: a.r1, r2: a.r2, r3: a.r3, r4: a.r4, r5: a.r5, r6: a.r6, r7: a.r7, r8: a.r8, r9: a.r9 },
          ])
        )
        const reviewMap = new Map<string, GraderReview[]>(
          (stats.applicants ?? []).map((a: StatRow) => [a.applicant_id, a.reviews ?? []])
        )
        cands = cands.map(c => {
          if (!c.applicant_id || c.data?.interview) return c
          const scores = scoreMap.get(c.applicant_id)
          if (!scores) return c
          return { ...c, data: { ...c.data, ...scores }, grader_reviews: reviewMap.get(c.applicant_id) ?? [] }
        })
      }
    }

    if (sessionData) setSession(current => current && liveAtStart !== liveRevision.current ? { ...sessionData, status: current.status, anonymous: current.anonymous, show_vouch_counts: current.show_vouch_counts, one_vouch_per_member: current.one_vouch_per_member, focused_candidate_id: current.focused_candidate_id, focus_version: current.focus_version } : sessionData)
    if (sessionData && (seenFocus.current.session !== sessionId || (sessionData.focus_version ?? 0) > seenFocus.current.version)) {
      seenFocus.current = { session: sessionId, version: sessionData.focus_version ?? 0 }
      if (sessionData.focused_candidate_id && cands.some(c => c.id === sessionData.focused_candidate_id)) {
        setSelectedId(sessionData.focused_candidate_id)
        setViewMode('candidate')
        setFilterStatus('all')
        setSearch('')
        setBulkMode(false)
      }
    }
    setCandidates(current => {
      const previous = new Map(current.map(c => [c.id, c.status]))
      return cands.map(c => previous.has(c.id) && (liveAtStart !== liveRevision.current || decisionsAtStart !== decisionRevision.current || pendingDecisions.current.has(c.id)) ? { ...c, status: previous.get(c.id)! } : c)
    })
    voteCandidateIds.current = cands.map(c => c.id)
    setMemberCount(Array.isArray(membersData) ? membersData.length : 0)
    setLoading(false)
    setLoadError(null)

    if (cands.length) void loadVotes()
    else setVotes([])
    } catch {
      setLoadError('Loading is taking longer than expected. Your saved data is unchanged. Please retry.')
    } finally {
      refreshInFlight.current = false
      setLoading(false)
    }
  }, [sessionId, loadVotes])

  useEffect(() => {
    if (authStatus === 'loading') return
    if (authStatus === 'unauthenticated') { router.replace('/'); return }

    let cancelled = false
    let interval: ReturnType<typeof setInterval> | undefined
    let voteInterval: ReturnType<typeof setInterval> | undefined

    // Join before the first protected read. Previously these ran concurrently,
    // causing intermittent 403s on a user's first visit.
    async function bootstrap() {
      const joinResponse = await fetch('/api/session-members', {
        signal: AbortSignal.timeout(15000),
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId }),
      }).catch(() => null)
      if (cancelled) return
      if (joinResponse?.status === 403) {
        setBanned(true)
        setLoading(false)
        return
      }
      if (!joinResponse?.ok) {
        setLoadError('Unable to join the session. Please retry.')
        setLoading(false)
        return
      }

      await loadData()
      if (cancelled) return
      setLoading(false)
      // Heavy data refreshes are slower; votes have their own lightweight poll.
      // Jitter spreads viewers' requests instead of synchronized bursts.
      interval = setInterval(() => {
        if (document.visibilityState === 'visible') void loadData()
      }, 30000 + Math.random() * 5000)
      voteInterval = setInterval(() => {
        if (document.visibilityState === 'visible') void loadVotes()
      }, 2000 + Math.random() * 1000)
    }

    void bootstrap()
    return () => {
      cancelled = true
      if (interval) clearInterval(interval)
      if (voteInterval) clearInterval(voteInterval)
    }
  }, [authStatus, sessionId, router, loadData, loadVotes])

  const selected = candidates.find(candidate => candidate.id === selectedId) ?? null
  const focused = candidates.find(candidate => candidate.id === session?.focused_candidate_id)

  async function updateControl(body: Record<string, unknown>) {
    setControlBusy(true); setControlError('')
    try {
      const response = await fetch(`/api/sessions/${sessionId}/controls`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Unable to update controls.')
      await loadVotes()
    } catch (e) { setControlError(e instanceof Error ? e.message : 'Unable to update controls.') }
    finally { setControlBusy(false) }
  }

  // Match by email when the vote has one (server dedupes by email); fall back
  // to display name for votes cast before email tracking existed.
  const isMyVote = (v: Vote) =>
    v.voter_email ? v.voter_email === userEmail.toLowerCase() : v.voter_name === userName

  async function handleVote(candidateId: string, voteType: VoteType) {
    if (!userEmail || voteWriteInFlight.current) return
    voteWriteInFlight.current = true
    voteRevision.current++
    try {
    const voterName = userName
    const existing = votes.find(v => v.candidate_id === candidateId && isMyVote(v) && v.vote_type === voteType)
    if (existing) {
      const res = await fetch('/api/votes', {
        method: 'DELETE',
        signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: existing.id }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        alert(`Could not remove vote: ${err?.error ?? res.statusText}`)
      } else setVotes(current => current.filter(v => v.id !== existing.id))
    } else {
      if (voteType === 'vouch' && session?.one_vouch_per_member && votes.some(v => v.vote_type === 'vouch' && isMyVote(v))) {
        alert('One vouch per member is enabled. Remove your current vouch before choosing another applicant.')
        return
      }
      // Remove the opposite vote first (can't vouch and anti-vouch simultaneously)
      const opposite = voteType === 'vouch' ? 'anti_vouch' : voteType === 'anti_vouch' ? 'vouch' : null
      if (opposite) {
        const oppositeVote = votes.find(v => v.candidate_id === candidateId && isMyVote(v) && v.vote_type === opposite)
        if (oppositeVote) {
          const removed = await fetch('/api/votes', {
            method: 'DELETE',
            signal: AbortSignal.timeout(15000),
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: oppositeVote.id }),
          })
          if (!removed.ok) throw new Error('Could not remove your previous vote. Please retry.')
          setVotes(current => current.filter(v => v.id !== oppositeVote.id))
        }
      }
      const res = await fetch('/api/votes', {
        method: 'POST',
        signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidate_id: candidateId, voter_name: voterName, vote_type: voteType }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        alert(`Could not vote: ${err?.error ?? res.statusText}`)
      } else {
        const created = await res.json()
        setVotes(current => [...current.filter(v => v.id !== created.id), { id: created.id, candidate_id: candidateId, voter_name: voterName, voter_email: userEmail.toLowerCase(), vote_type: voteType }])
      }
    }
    } catch { alert('Unable to update your vote. Please retry.') }
    finally {
      voteRevision.current++
      voteWriteInFlight.current = false
      void loadVotes()
    }
  }

  async function handleStatusChange(candidateId: string, status: string) {
    if (pendingDecisions.current.has(candidateId)) return
    pendingDecisions.current.add(candidateId)
    decisionRevision.current++
    const nextStatus = status as Candidate['status']
    const previousStatus = candidates.find(candidate => candidate.id === candidateId)?.status
    setCandidates(current => current.map(candidate => (
      candidate.id === candidateId ? { ...candidate, status: nextStatus } : candidate
    )))

    try {
      const res = await fetch(`/api/candidates/${candidateId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err?.error ?? res.statusText)
      }
      void loadVotes()
    } catch (error) {
      if (previousStatus) {
        setCandidates(current => current.map(candidate => (
          candidate.id === candidateId && candidate.status === nextStatus
            ? { ...candidate, status: previousStatus }
            : candidate
        )))
      }
      alert(`Could not update status: ${error instanceof Error ? error.message : 'Check your connection and try again.'}`)
    } finally {
      pendingDecisions.current.delete(candidateId)
      decisionRevision.current++
      void loadVotes()
    }
  }

  function toggleCandidateSelection(candidateId: string) {
    setSelectedCandidateIds(current => {
      const next = new Set(current)
      if (next.has(candidateId)) next.delete(candidateId)
      else next.add(candidateId)
      return next
    })
  }

  function exitBulkMode() {
    setBulkMode(false)
    setSelectedCandidateIds(new Set())
  }

  async function handleBulkStatusChange(status: string) {
    const candidateIds = [...selectedCandidateIds]
    if (candidateIds.length === 0 || bulkUpdating) return
    const label = status.charAt(0).toUpperCase() + status.slice(1)
    if (!confirm(`Set ${candidateIds.length} selected candidate${candidateIds.length === 1 ? '' : 's'} to ${label}?`)) return
    if (candidateIds.some(id => pendingDecisions.current.has(id))) return
    candidateIds.forEach(id => pendingDecisions.current.add(id))
    decisionRevision.current++

    const nextStatus = status as Candidate['status']
    const selectedIdSet = new Set(candidateIds)
    const previousStatuses = new Map(
      candidates
        .filter(candidate => selectedIdSet.has(candidate.id))
        .map(candidate => [candidate.id, candidate.status]),
    )

    setCandidates(current => current.map(candidate => (
      selectedIdSet.has(candidate.id) ? { ...candidate, status: nextStatus } : candidate
    )))
    setBulkUpdating(true)
    try {
      const res = await fetch('/api/candidates/bulk-status', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, candidate_ids: candidateIds, status }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err?.error ?? res.statusText)
      }
      exitBulkMode()
      void loadVotes()
    } catch (error) {
      setCandidates(current => current.map(candidate => {
        const previousStatus = previousStatuses.get(candidate.id)
        return previousStatus && candidate.status === nextStatus
          ? { ...candidate, status: previousStatus }
          : candidate
      }))
      alert(`Could not update selected candidates: ${error instanceof Error ? error.message : 'Check your connection and try again.'}`)
    } finally {
      setBulkUpdating(false)
      candidateIds.forEach(id => pendingDecisions.current.delete(id))
      decisionRevision.current++
      void loadVotes()
    }
  }

  async function handleLeaveSession() {
    const msg = isAdmin
      ? 'Leave this session? The session will remain active but you will lose admin controls.'
      : 'Leave this session?'
    if (!confirm(msg)) return
    await fetch('/api/session-members', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, user_email: userEmail }),
    })
    router.push('/dashboard')
  }

  if (authStatus === 'loading' || loading) {
    return <div className="min-h-screen bg-[var(--bg-base)] flex items-center justify-center"><div className="text-gray-500 text-sm">Loading...</div></div>
  }
  if (banned) {
    return (
      <div className="min-h-screen bg-[var(--bg-base)] flex items-center justify-center px-6">
        <div className="text-center space-y-3 max-w-sm">
          <p className="text-red-400 font-semibold">You have been removed from this session.</p>
          <p className="text-sm text-[var(--text-muted)]">Contact the session creator if you think this is a mistake.</p>
          <button
            onClick={() => router.push('/dashboard')}
            className="text-sm px-4 py-2 rounded-lg bg-[var(--bg-raised)] border border-[var(--border)] text-[var(--text-primary)] hover:bg-[var(--bg-active)] transition-colors"
          >
            ← Back to Dashboard
          </button>
        </div>
      </div>
    )
  }
  if (!session) {
    return <div className="min-h-screen bg-[var(--bg-base)] flex flex-col gap-3 items-center justify-center"><div className="text-red-400">{loadError ?? 'Session not found.'}</div><button className="rounded border px-4 py-2" onClick={() => window.location.reload()}>Retry loading</button></div>
  }

  const myName = userName

  const filteredCandidates = candidates
    .filter(c => {
      const matchesStatus = filterStatus === 'all' || c.status === filterStatus
      const matchesSearch = c.name.toLowerCase().includes(search.toLowerCase())
      return matchesStatus && matchesSearch
    })
    .sort(compareCandidatesByScore)

  const votesFor = (id: string) => votes.filter(v => v.candidate_id === id)
  const myVote = (id: string, type: VoteType) =>
    votes.some(v => v.candidate_id === id && isMyVote(v) && v.vote_type === type)

  const statusCounts = {
    all: candidates.length,
    pending: candidates.filter(c => c.status === 'pending').length,
    accepted: candidates.filter(c => c.status === 'accepted').length,
    rejected: candidates.filter(c => c.status === 'rejected').length,
    hold: candidates.filter(c => c.status === 'hold').length,
  }

  return (
    <div className="deliberation-portal h-screen bg-[var(--bg-base)] flex flex-col overflow-hidden">
      {/* Header */}
      {loadError && <div role="alert" className="shrink-0 px-4 py-2 text-sm text-amber-600">{loadError} <button className="underline" onClick={() => void loadData()}>Retry</button></div>}
      <header className="bg-[var(--bg-surface)] border-b border-[var(--border)] px-4 py-3 flex flex-wrap gap-3 items-center justify-between shrink-0">
        <div className="min-w-0 flex items-center gap-3">
          <Image
            src="/PlexTechLogo.png"
            alt="PlexTech"
            width={23}
            height={34}
            className="h-8 w-auto shrink-0"
            priority
          />
          <span className="h-6 w-px bg-[var(--border)]" aria-hidden="true" />
          <div className="min-w-0">
            <h1 className="font-bold text-[var(--text-primary)] truncate">{session.name}</h1>
            <p className="text-xs text-gray-500">
              ID: <button onClick={copySessionId} className="font-mono font-bold text-[#FF6B35] hover:opacity-70 transition-opacity cursor-pointer" title="Click to copy">{idCopied ? 'Copied!' : sessionId}</button>
              {' · '}{memberCount} members
              {' · '}
              <span className={session.status === 'active' ? 'text-green-600' : 'text-red-500'}>{session.status}</span>
              {session.anonymous && <span className="ml-1 text-yellow-400">· anon</span>}
              {session.role && (
                <span className={`ml-1 ${session.role === 'curriculum' ? 'text-purple-400' : 'text-cyan-400'}`}>· {session.role}</span>
              )}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {isAdmin && (
            <button
              onClick={() => bulkMode ? exitBulkMode() : setBulkMode(true)}
              className={`text-xs border px-2.5 py-1.5 rounded-lg transition-colors ${
                bulkMode
                  ? 'bg-[#FF6B35]/15 text-[#FF6B35] border-[#FF6B35]/40'
                  : 'text-[var(--text-muted)] border-[var(--border)] hover:text-[var(--text-primary)]'
              }`}
            >
              {bulkMode ? 'Exit selection' : 'Select multiple'}
            </button>
          )}
          {/* View toggle */}
          <div className="flex items-center bg-[var(--bg-raised)] border border-[var(--border)] rounded-lg p-0.5 gap-0.5">
            <button
              onClick={() => setViewMode('candidate')}
              title="Candidate view"
              className={`px-2 py-1 rounded text-xs font-medium transition-colors ${viewMode === 'candidate' ? 'bg-[var(--bg-active)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="18"/><rect x="14" y="3" width="7" height="18"/></svg>
            </button>
            <button
              onClick={() => setViewMode('list')}
              title="List view"
              className={`px-2 py-1 rounded text-xs font-medium transition-colors ${viewMode === 'list' ? 'bg-[var(--bg-active)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
            </button>
          </div>
          <ThemeToggle />
          <details className="relative">
            <summary className="cursor-pointer rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--text-muted)]">Account</summary>
            <div className="absolute right-0 top-full z-50 mt-2 w-56 space-y-2 rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] p-3 shadow-lg">
              <p className="break-words text-xs text-[var(--text-muted)]">{myName}</p>
          <button onClick={handleLeaveSession}
            className="text-xs text-[var(--text-muted)] hover:text-red-400 border border-[var(--border)] hover:border-red-900/60 px-2 py-1.5 rounded-lg transition-colors">
            Leave
          </button>
          <button onClick={() => signOut({ callbackUrl: '/' })}
            className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] border border-[var(--border)] px-2 py-1.5 rounded-lg transition-colors">
            Sign out
          </button>
            </div>
          </details>
        </div>
      </header>

      {focused && <div className="shrink-0 flex flex-wrap items-center gap-3 border-b border-[var(--border)] bg-[var(--bg-surface)] px-4 py-2 text-sm">
        <button className="text-[#FF6B35] hover:underline" onClick={() => { setSelectedId(focused.id); setViewMode('candidate'); setFilterStatus('all'); setSearch('') }}>Currently discussing: {focused.name} — return to focus</button>
        {authSession?.user?.role === 'admin' && session.status === 'active' && <button className="ml-auto text-xs text-[var(--text-muted)]" disabled={controlBusy} onClick={() => void updateControl({ action: 'focus', candidate_id: null })}>Clear focus</button>}
      </div>}
      <div className="shrink-0 max-h-[40vh] overflow-y-auto border-b border-[var(--border)] bg-[var(--bg-surface)]">
      <details>
        <summary className="cursor-pointer px-4 py-2 text-xs font-medium text-[var(--text-secondary)]">Session controls · {session.one_vouch_per_member ? '1 vouch per member' : 'Unlimited vouches'}</summary>
        <BehavioralSyncPanel sessionId={sessionId} admin={authSession?.user?.role === 'admin'} />
      <div className="px-4 py-2 text-sm space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <span>{session.one_vouch_per_member ? 'One vouch per member · remove it to choose someone else' : 'Vouches: no session-wide limit'}</span>
          {authSession?.user?.role === 'admin' && session.status === 'active' && <>
            <label className="flex items-center gap-2"><input type="checkbox" checked={!!session.one_vouch_per_member} disabled={controlBusy} onChange={e => void updateControl({ action: 'vouch-limit', enabled: e.target.checked })} />Limit to 1 vouch per member</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={session.show_vouch_counts !== false} disabled={controlBusy} onChange={e => void updateControl({ action: 'vouch-visibility', enabled: e.target.checked })} />Show vouch and anti-vouch counts</label>
          </>}
        </div>
      </div>
      </details>
      <details>
        <summary className="cursor-pointer px-4 py-2 text-xs font-medium text-[var(--text-secondary)]">Stats · {candidates.length} applicants · {candidates.filter(c => c.status === 'accepted').length} accepted</summary>
        <GenderRatio candidates={candidates} />
      </details>
      </div>
      {controlError && <p role="alert" className="shrink-0 px-4 py-2 text-sm text-red-600">{controlError}</p>}
      {isAdmin && bulkMode && (
        <div className="shrink-0 flex flex-wrap items-center gap-2 border-b border-[var(--border)] bg-[var(--bg-surface)] px-4 py-2">
          <span className="mr-1 text-sm font-medium text-[var(--text-primary)]">
            {selectedCandidateIds.size} selected
          </span>
          {(['accepted', 'rejected', 'hold', 'pending'] as const).map(status => (
            <button
              key={status}
              type="button"
              disabled={selectedCandidateIds.size === 0 || bulkUpdating}
              onClick={() => handleBulkStatusChange(status)}
              className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-opacity disabled:cursor-not-allowed disabled:opacity-40 ${STATUS_BTN[status].inactive}`}
            >
              {status.charAt(0).toUpperCase() + status.slice(1)}
            </button>
          ))}
          <button
            type="button"
            disabled={selectedCandidateIds.size === 0 || bulkUpdating}
            onClick={() => setSelectedCandidateIds(new Set())}
            className="ml-auto rounded-md border border-[var(--border)] px-2.5 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-40"
          >
            Clear
          </button>
          {bulkUpdating && <span className="text-xs text-[var(--text-muted)]">Updating…</span>}
        </div>
      )}


      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
      {viewMode === 'list' ? (
        <ListView
          candidates={candidates}
          votes={votes}
          showVouchCounts={session.show_vouch_counts !== false}
          bulkMode={isAdmin && bulkMode}
          selectedIds={selectedCandidateIds}
          onToggleSelection={toggleCandidateSelection}
          onSelect={(candidate) => { setSelectedId(candidate.id); setViewMode('candidate') }}
        />
      ) : (<>

        {/* Left panel — candidate list */}
        <div
          className={`relative shrink-0 border-r border-[var(--border)] flex flex-col bg-[var(--bg-surface)] transition-[width] duration-200 ease-out ${
            sidebarExpanded ? 'w-[min(28rem,55vw)]' : 'w-72'
          }`}
        >
          <button
            type="button"
            onClick={() => setSidebarExpanded(expanded => !expanded)}
            title={sidebarExpanded ? 'Use compact sidebar' : 'Expand sidebar'}
            aria-label={sidebarExpanded ? 'Use compact sidebar' : 'Expand sidebar'}
            aria-pressed={sidebarExpanded}
            className="absolute -right-3 top-3 z-20 flex h-7 w-7 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--bg-raised)] text-[var(--text-muted)] shadow-sm transition-colors hover:border-[#FF6B35]/50 hover:text-[#FF6B35]"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {sidebarExpanded ? (
                <>
                  <polyline points="11 17 6 12 11 7" />
                  <polyline points="18 17 13 12 18 7" />
                </>
              ) : (
                <>
                  <polyline points="6 17 11 12 6 7" />
                  <polyline points="13 17 18 12 13 7" />
                </>
              )}
            </svg>
          </button>
          {/* Admin toggle */}
          {isAdmin && (
            <div className="shrink-0">
              <button
                onClick={() => setShowAdminPanel(!showAdminPanel)}
                className="w-full flex items-center justify-between px-3 py-2.5 text-xs font-semibold transition-colors border-b border-[var(--border)] plex-gradient-text hover:opacity-80"
              >
                <span className="uppercase tracking-widest">Admin</span>
                <span className="text-gray-600 text-[10px]">{showAdminPanel ? '▲' : '▼'}</span>
              </button>
              {showAdminPanel && (
                <AdminPanel session={session} sessionId={sessionId} onRefresh={loadData} onVouchesReset={() => {
                  voteRevision.current++
                  setVotes(current => current.filter(v => v.vote_type !== 'vouch' && v.vote_type !== 'anti_vouch'))
                  void loadVotes()
                }} />
              )}
            </div>
          )}

          {/* Search */}
          <div className="p-3 border-b border-[var(--border)]">
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search candidates..."
              className="w-full bg-[var(--bg-raised)] border border-[var(--border)] rounded-lg px-3 py-1.5 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[#FF6B35]"
            />
          </div>

          {/* Status filters */}
          <div className="flex gap-1 p-2 border-b border-[var(--border)] overflow-x-auto">
            {(['all', 'pending', 'accepted', 'rejected', 'hold'] as const).map(s => (
              <button key={s} onClick={() => setFilterStatus(s)}
                className={`shrink-0 px-2 py-1 rounded text-xs font-medium transition-colors ${
                  filterStatus === s ? 'plex-gradient text-white' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                }`}>
                {s === 'all' ? `All (${statusCounts.all})` : `${s.charAt(0).toUpperCase() + s.slice(1)} (${statusCounts[s]})`}
              </button>
            ))}
          </div>

          {/* List */}
          <div className="flex-1 overflow-y-auto">
            {filteredCandidates.length === 0 ? (
              <div className="text-center text-gray-600 text-sm py-12 px-4">
                {candidates.length === 0 ? 'No candidates yet.\nAdmin can import a CSV.' : 'No matches.'}
              </div>
            ) : (
              filteredCandidates.map(c => {
                const cv = votesFor(c.id)
                const vouches = cv.filter(v => v.vote_type === 'vouch').length
                const antis = cv.filter(v => v.vote_type === 'anti_vouch').length
                const flags = cv.filter(v => v.vote_type === 'red_flag').length
                const isSelected = selected?.id === c.id

                const isChecked = selectedCandidateIds.has(c.id)

                return (
                  <div
                    key={c.id}
                    className={`flex items-center border-b border-[var(--border)]/50 transition-colors hover:bg-[var(--bg-raised)]${
                      isSelected ? ' bg-[var(--bg-raised)] border-l-2 border-l-[#FF6B35]' : ''
                    }${isChecked ? ' bg-[#FF6B35]/10' : ''}`}
                  >
                    {isAdmin && bulkMode && (
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleCandidateSelection(c.id)}
                        aria-label={`Select ${c.name}`}
                        className="ml-3 h-4 w-4 shrink-0 accent-[#FF6B35]"
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => bulkMode && isAdmin ? toggleCandidateSelection(c.id) : setSelectedId(c.id)}
                      className="min-w-0 flex-1 px-3 py-2.5 text-left"
                    >
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_COLORS[c.status]}`} />
                        <span className="text-sm text-[var(--text-primary)] font-medium truncate flex-1">{c.name}</span>
                        <GenderBadge gender={c.data?.gender} />
                      </div>
                      <div className="flex items-center gap-2 mt-1 ml-4">
                        {c.data.score != null && (
                          <span className="text-xs text-[var(--text-muted)]">{Number(c.data.score).toFixed(2)}</span>
                        )}
                        {c.data.Scores != null && c.data.score == null && (
                          <span className="text-xs text-[var(--text-muted)]">{Number(c.data.Scores).toFixed(1)}</span>
                        )}
                        {session.show_vouch_counts !== false && vouches > 0 && <span className="text-xs text-green-500">+{vouches}</span>}
                        {session.show_vouch_counts !== false && antis > 0 && <span className="text-xs text-orange-500">-{antis}</span>}
                        {flags > 0 && <span className="text-xs text-red-500">⚑{flags}</span>}
                      </div>
                    </button>
                  </div>
                )
              })
            )}
          </div>
        </div>

        {/* Right panel — detail */}
        <div className="flex-1 overflow-y-auto bg-[var(--bg-base)]">
          {!selected ? (
            <div className="h-full flex items-center justify-center text-[var(--text-muted)] text-sm">
              Select a candidate to view their details
            </div>
          ) : (
            <CandidateDetail
              key={selected.id}
              candidate={selected}
              role={session.role}
              onFocus={authSession?.user?.role === 'admin' && session.status === 'active' ? () => void updateControl({ action: 'focus', candidate_id: selected.id }) : undefined}
              focusBusy={controlBusy}
              votes={votesFor(selected.id)}
              myName={myName}
              isAdmin={isAdmin}
              anonymous={session.anonymous}
              showVouchCounts={session.show_vouch_counts !== false}
              sessionActive={session.status === 'active'}
              myVote={myVote}
              onVote={handleVote}
              onStatusChange={handleStatusChange}
            />
          )}
        </div>
      </>)}
      </div>
    </div>
  )
}

function ListView({
  showVouchCounts,
  candidates,
  votes,
  bulkMode,
  selectedIds,
  onToggleSelection,
  onSelect,
}: {
  candidates: Candidate[]
  showVouchCounts: boolean
  votes: Vote[]
  bulkMode: boolean
  selectedIds: Set<string>
  onToggleSelection: (id: string) => void
  onSelect: (c: Candidate) => void
}) {
  const [search, setSearch] = useState('')

  const filtered = candidates
    .filter(c => c.name.toLowerCase().includes(search.toLowerCase()))
    .sort(compareCandidatesByScore)

  function cvotes(id: string) { return votes.filter(v => v.candidate_id === id) }

  const allVisibleSelected = filtered.length > 0 && filtered.every(candidate => selectedIds.has(candidate.id))

  function toggleAllVisible() {
    const shouldSelect = !allVisibleSelected
    for (const candidate of filtered) {
      if (selectedIds.has(candidate.id) !== shouldSelect) onToggleSelection(candidate.id)
    }
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Search */}
      <div className="px-4 py-3 border-b border-[var(--border)] bg-[var(--bg-surface)]">
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search candidates..."
          className="w-full max-w-sm bg-[var(--bg-raised)] border border-[var(--border)] rounded-lg px-3 py-1.5 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[#FF6B35]"
        />
      </div>

      {/* Table */}
      <div className="flex-1 overflow-y-auto">
        <table className="w-full text-sm border-collapse">
          <thead className="sticky top-0 bg-[var(--bg-surface)] z-10">
            <tr className="border-b border-[var(--border)]">
              {bulkMode && (
                <th className="w-10 px-3 py-2.5 text-center">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleAllVisible}
                    aria-label="Select all visible candidates"
                    className="h-4 w-4 accent-[#FF6B35]"
                  />
                </th>
              )}
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider w-full">Name</th>
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider whitespace-nowrap">Status</th>
              <th className="text-right px-4 py-2.5 text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider whitespace-nowrap">Score</th>
              <th className="text-center px-4 py-2.5 text-xs font-semibold text-green-500 uppercase tracking-wider">+</th>
              <th className="text-center px-4 py-2.5 text-xs font-semibold text-orange-500 uppercase tracking-wider">−</th>
              <th className="text-center px-4 py-2.5 text-xs font-semibold text-red-500 uppercase tracking-wider">⚑</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(c => {
              const cv = cvotes(c.id)
              const vouches = cv.filter(v => v.vote_type === 'vouch').length
              const antis   = cv.filter(v => v.vote_type === 'anti_vouch').length
              const flags   = cv.filter(v => v.vote_type === 'red_flag').length
              const score   = c.data?.score ?? c.data?.Scores

              return (
                <tr
                  key={c.id}
                  onClick={() => bulkMode ? onToggleSelection(c.id) : onSelect(c)}
                  className={`border-b border-[var(--border)]/50 hover:bg-[var(--bg-raised)] cursor-pointer transition-colors ${selectedIds.has(c.id) ? 'bg-[#FF6B35]/10' : ''}`}
                >
                  {bulkMode && (
                    <td className="px-3 py-3 text-center" onClick={event => event.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selectedIds.has(c.id)}
                        onChange={() => onToggleSelection(c.id)}
                        aria-label={`Select ${c.name}`}
                        className="h-4 w-4 accent-[#FF6B35]"
                      />
                    </td>
                  )}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_COLORS[c.status]}`} />
                      <span className="font-medium text-[var(--text-primary)]">{c.name}</span>
                      <GenderBadge gender={c.data?.gender} />
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium border ${STATUS_BADGE[c.status]}`}>
                      {c.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-[var(--text-muted)] font-mono">
                    {score != null ? Number(score).toFixed(2) : '—'}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {!showVouchCounts ? 'Hidden' : vouches > 0 ? <span className="text-green-500 font-medium">{vouches}</span> : <span className="text-[var(--text-muted)]">—</span>}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {!showVouchCounts ? 'Hidden' : antis > 0 ? <span className="text-orange-500 font-medium">{antis}</span> : <span className="text-[var(--text-muted)]">—</span>}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {flags > 0 ? <span className="text-red-500 font-medium">{flags}</span> : <span className="text-[var(--text-muted)]">—</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <div className="text-center text-[var(--text-muted)] py-16">No candidates found.</div>
        )}
      </div>
    </div>
  )
}

function CandidateDetail({
  showVouchCounts,
  candidate, role, onFocus, focusBusy, votes, myName, isAdmin, anonymous, sessionActive, myVote, onVote, onStatusChange,
}: {
  candidate: Candidate
  showVouchCounts: boolean
  role: Session['role']
  onFocus?: () => void
  focusBusy: boolean
  votes: Vote[]
  myName: string
  isAdmin: boolean
  anonymous: boolean
  sessionActive: boolean
  myVote: (id: string, type: VoteType) => boolean
  onVote: (id: string, type: VoteType) => void
  onStatusChange: (id: string, status: string) => void
}) {
  const vouches = votes.filter(v => v.vote_type === 'vouch')
  const antis = votes.filter(v => v.vote_type === 'anti_vouch')
  const flags = votes.filter(v => v.vote_type === 'red_flag')

  const [notes, setNotes] = useState<CandidateNote[]>([])
  const [coffeeChats, setCoffeeChats] = useState<CoffeeChatNote[]>([])
  const [coffeeChatsOpen, setCoffeeChatsOpen] = useState(false)
  const [coffeeChatsLoading, setCoffeeChatsLoading] = useState(false)
  const [coffeeChatsMessage, setCoffeeChatsMessage] = useState<string | null>(null)
  const [noteText, setNoteText] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const [essays, setEssays] = useState<{ prompt: { question_number: number; prompt: string }; response: string }[] | null>(null)
  const [applicantInfo, setApplicantInfo] = useState<ApplicantInfo | null>(null)
  const [essaysLoading, setEssaysLoading] = useState(!!candidate.applicant_id)
  const [resumeOpen, setResumeOpen] = useState(false)
  const [resumeObjectUrl, setResumeObjectUrl] = useState<string | null>(null)
  const [resumeLoading, setResumeLoading] = useState(false)
  const [resumeError, setResumeError] = useState<string | null>(null)

  const loadCoffeeChats = useCallback(async (manual = false) => {
    setCoffeeChatsLoading(true)
    setCoffeeChatsMessage(null)
    try {
      const response = await fetch(`/api/coffee-chat-notes?candidate_id=${candidate.id}`, {
        cache: 'no-store',
      })
      if (!response.ok) throw new Error('Unable to refresh coffee chat notes.')
      const data = await response.json()
      const nextNotes = Array.isArray(data) ? data : []
      setCoffeeChats(nextNotes)
      if (manual) {
        setCoffeeChatsMessage(
          nextNotes.length === 1
            ? 'Synced 1 note from the connected sheet.'
            : `Synced ${nextNotes.length} notes from the connected sheet.`,
        )
      }
    } catch {
      if (manual) setCoffeeChatsMessage('Could not refresh notes. Please try again.')
    } finally {
      setCoffeeChatsLoading(false)
    }
  }, [candidate.id])

  useEffect(() => {
    fetch(`/api/candidate-notes?candidate_id=${candidate.id}`)
      .then(res => res.ok ? res.json() : [])
      .then(data => setNotes(data))
    fetch(`/api/coffee-chat-notes?candidate_id=${candidate.id}`, { cache: 'no-store' })
      .then(res => res.ok ? res.json() : [])
      .then(data => setCoffeeChats(Array.isArray(data) ? data : []))
  }, [candidate.id])

  // Lazily load the applicant's essay responses when this candidate is opened.
  useEffect(() => {
    if (!candidate.applicant_id) return
    fetch(`/api/applicants/${candidate.applicant_id}/essays`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        setApplicantInfo(data?.applicant ?? null)
        setEssays(data?.essays ?? [])
      })
      .finally(() => setEssaysLoading(false))
  }, [candidate.id, candidate.applicant_id])

  useEffect(() => () => {
    if (resumeObjectUrl) URL.revokeObjectURL(resumeObjectUrl)
  }, [resumeObjectUrl])

  async function toggleResumeViewer() {
    if (resumeOpen) {
      setResumeOpen(false)
      return
    }

    setResumeOpen(true)
    if (!candidate.applicant_id || resumeObjectUrl || resumeLoading) return

    setResumeLoading(true)
    setResumeError(null)
    try {
      const response = await fetch(`/api/applicants/${candidate.applicant_id}/resume?format=pdf`)
      if (!response.ok) {
        const error = await response.json().catch(() => ({}))
        throw new Error(error?.error ?? 'Unable to load this résumé.')
      }
      const blob = await response.blob()
      setResumeObjectUrl(URL.createObjectURL(blob))
    } catch (error) {
      setResumeError(error instanceof Error ? error.message : 'Unable to load this résumé.')
    } finally {
      setResumeLoading(false)
    }
  }

  async function deleteNote(noteId: string) {
    await fetch(`/api/candidate-notes?id=${noteId}`, { method: 'DELETE' })
    setNotes(prev => prev.filter(n => n.id !== noteId))
  }

  async function submitNote(type: 'note' | 'red_flag') {
    const content = noteText.trim()
    if (!content) return
    setSubmitting(true)
    await fetch('/api/candidate-notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidate_id: candidate.id, author: myName, content, type }),
    })
    setNoteText('')
    const res = await fetch(`/api/candidate-notes?candidate_id=${candidate.id}`)
    const data = res.ok ? await res.json() : []
    setNotes(data)
    setSubmitting(false)
  }

  return (
    <div className="p-6 max-w-2xl">
      {/* Name + status */}
      <div className="flex items-start justify-between gap-4 mb-6">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h2 className="truncate text-2xl font-bold text-[var(--text-primary)]">{candidate.name}</h2>
          <GenderBadge gender={candidate.data?.gender} />
          {onFocus && <button onClick={onFocus} disabled={focusBusy} className="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs text-[#FF6B35] disabled:opacity-40" title="Show this applicant to everyone in the session">Focus everyone</button>}
        </div>
        <span className={`shrink-0 text-xs px-2.5 py-1 rounded-full font-medium border ${STATUS_BADGE[candidate.status]}`}>
          {candidate.status}
        </span>
      </div>

      {/* Dynamic fields from data JSON */}
      <DataFields data={candidate.data} />
      <InterviewDetails value={candidate.data?.interview} role={role} />

      {candidate.applicant_id && applicantInfo && (
        <div className="mb-6 rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-4">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-[#FF6B35]">Applicant materials</p>
          <div className="mb-3 rounded-lg border border-[var(--border)] bg-[var(--bg-raised)] px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-[var(--text-primary)]">Attended infosession?</span>
              <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${
                applicantInfo.infosessions_attended.length > 0
                  ? 'border-green-500/30 bg-green-500/10 text-green-600'
                  : 'border-[var(--border)] bg-[var(--bg-surface)] text-[var(--text-muted)]'
              }`}>
                {applicantInfo.infosessions_attended.length > 0 ? 'Yes' : 'No'}
              </span>
            </div>
            {applicantInfo.infosessions_attended.length > 0 && (
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                {applicantInfo.infosessions_attended.join(' · ')}
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {safeExternalUrl(applicantInfo.linkedin) && (
              <a
                href={safeExternalUrl(applicantInfo.linkedin)!}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-lg border border-[var(--border)] bg-[var(--bg-raised)] px-3 py-1.5 text-sm font-medium text-[var(--text-primary)] hover:border-[#FF6B35]/50"
              >
                Open LinkedIn ↗
              </a>
            )}
            {safeExternalUrl(applicantInfo.website) && (
              <a
                href={safeExternalUrl(applicantInfo.website)!}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-lg border border-[var(--border)] bg-[var(--bg-raised)] px-3 py-1.5 text-sm font-medium text-[var(--text-primary)] hover:border-[#FF6B35]/50"
              >
                Open website ↗
              </a>
            )}
            {applicantInfo.has_resume ? (
              <a
                href={`/api/applicants/${candidate.applicant_id}/resume?format=pdf`}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-lg border border-[var(--border)] bg-[var(--bg-raised)] px-3 py-1.5 text-sm font-medium text-[var(--text-primary)] hover:border-[#FF6B35]/50"
              >
                Open résumé ↗
              </a>
            ) : (
              <span className="px-1 py-1.5 text-sm italic text-[var(--text-muted)]">No résumé uploaded</span>
            )}
          </div>
          {applicantInfo.has_resume && (
            <div className="mt-3 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-raised)]/60">
              <button
                type="button"
                onClick={toggleResumeViewer}
                aria-expanded={resumeOpen}
                className="w-full cursor-pointer px-3 py-2 text-left text-sm font-medium text-[var(--text-primary)] hover:bg-[var(--bg-active)]"
              >
                {resumeOpen ? 'Hide résumé' : 'View résumé here'}
              </button>
              {resumeOpen && (
                <div className="border-t border-[var(--border)]">
                  {resumeLoading && <p className="p-4 text-sm text-[var(--text-muted)]">Loading résumé…</p>}
                  {resumeError && <p className="p-4 text-sm text-red-500">{resumeError}</p>}
                  {resumeObjectUrl && !resumeLoading && !resumeError && (
                    <iframe
                      src={resumeObjectUrl}
                      className="h-[70vh] w-full bg-white"
                      title={`${candidate.name} résumé`}
                    />
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Application essays */}
      {candidate.applicant_id && (essaysLoading || (essays && essays.length > 0)) && (
        <details className="mb-6 bg-[var(--bg-raised)]/60 border border-[var(--border)] rounded-lg">
          <summary className="cursor-pointer px-4 py-2.5 text-sm font-medium text-[var(--text-primary)]">
            Application Essays
            {essays && <span className="text-[var(--text-muted)] font-normal"> · {essays.length}</span>}
          </summary>
          <div className="px-4 pb-4 space-y-4">
            {essaysLoading && <p className="text-xs text-[var(--text-muted)]">Loading…</p>}
            {essays && essays.map((e, i) => (
              <div key={i}>
                <p className="text-xs font-semibold text-[#ff8a00] uppercase tracking-wider mb-1">
                  Question {e.prompt.question_number}
                </p>
                <p className="text-xs text-[var(--text-muted)] mb-1.5">{e.prompt.prompt}</p>
                <p className="text-sm text-[var(--text-secondary)] whitespace-pre-wrap">
                  {e.response || <span className="italic text-[var(--text-muted)]">No response</span>}
                </p>
              </div>
            ))}
          </div>
        </details>
      )}

      {/* Grader essay comments (rubric rounds) */}
      <GraderComments reviews={candidate.grader_reviews} />

      <div className="mb-6 rounded-xl border border-[#FF6B35]/30 bg-[#FF6B35]/5 overflow-hidden">
        <div className="px-4 py-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-[#FF6B35]">Coffee chats</p>
              {coffeeChats.length > 0 ? (
                <p className="text-sm text-[var(--text-secondary)] mt-1">
                  <span className="font-medium text-[var(--text-primary)]">Coffee chatters:</span>{' '}
                  {[...new Set(coffeeChats.map(chat => chat.chatter_name))].join(', ')}
                </p>
              ) : (
                <p className="mt-1 text-sm text-[var(--text-muted)]">
                  {coffeeChatsLoading ? 'Checking the connected sheet…' : 'No matching notes currently.'}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() => void loadCoffeeChats(true)}
              disabled={coffeeChatsLoading}
              className="rounded-lg border border-[#FF6B35]/30 bg-[var(--bg-raised)] px-3 py-1.5 text-xs font-semibold text-[#FF6B35] transition-opacity hover:opacity-80 disabled:cursor-wait disabled:opacity-50"
            >
              {coffeeChatsLoading ? 'Resyncing…' : 'Resync coffee chat notes'}
            </button>
          </div>
          {coffeeChatsMessage && (
            <p className="mt-2 text-xs text-[var(--text-muted)]" role="status">{coffeeChatsMessage}</p>
          )}
          {coffeeChats.length > 0 && (
            <button
              type="button"
              onClick={() => setCoffeeChatsOpen(open => !open)}
              className="mt-2 text-sm font-medium text-[#FF6B35] hover:opacity-80 transition-opacity cursor-pointer"
              aria-expanded={coffeeChatsOpen}
            >
              {coffeeChatsOpen ? 'Hide coffee chat notes' : `View coffee chat notes (${coffeeChats.length})`}
            </button>
          )}
        </div>

        {coffeeChats.length > 0 && coffeeChatsOpen && (
            <div className="border-t border-[#FF6B35]/20 px-4 py-3 space-y-3">
              {coffeeChats.map(chat => (
                <div key={chat.id} className="rounded-lg border border-[var(--border)] bg-[var(--bg-raised)]/80 p-3">
                  <div className="flex items-center justify-between gap-3 mb-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <p className="truncate text-sm font-semibold text-[var(--text-primary)]">{chat.chatter_name}</p>
                      <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                        chat.is_coffee_chat === false
                          ? 'border-[var(--border)] bg-[var(--bg-surface)] text-[var(--text-muted)]'
                          : 'border-[#FF6B35]/30 bg-[#FF6B35]/10 text-[#FF6B35]'
                      }`}>
                        {chat.is_coffee_chat === false ? 'Not marked as coffee chat' : 'Coffee chat'}
                      </span>
                    </div>
                    {chat.chat_date && <span className="text-xs text-[var(--text-muted)] shrink-0">
                      {new Date(`${chat.chat_date}T00:00:00`).toLocaleDateString('en-US', {
                        month: 'short', day: 'numeric', year: 'numeric',
                      })}
                    </span>}
                  </div>
                  {chat.recommended_overall !== null && (
                    <p className={`mb-2 text-xs font-semibold ${chat.recommended_overall ? 'text-green-500' : 'text-orange-500'}`}>
                      Recommended overall: {chat.recommended_overall ? 'Yes' : 'No'}
                    </p>
                  )}
                  {chat.notes && (
                    <p className="text-sm leading-relaxed text-[var(--text-secondary)] whitespace-pre-wrap break-words">
                      {chat.notes}
                    </p>
                  )}
                  {chat.other_notes && (
                    <div className="mt-2 pt-2 border-t border-[var(--border)]">
                      <p className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1">Other notes</p>
                      <p className="text-sm text-[var(--text-secondary)] whitespace-pre-wrap break-words">{chat.other_notes}</p>
                    </div>
                  )}
                </div>
              ))}
            </div>
        )}
      </div>

      {/* Vote actions */}
      {sessionActive && (
        <div className="mb-6">
          <p className="text-xs text-[var(--text-muted)] mb-2">Your vote</p>
          <div className="flex gap-2">
            {(['vouch', 'anti_vouch'] as VoteType[]).map(type => {
              const active = myVote(candidate.id, type)
              const cfgMap: Record<string, { label: string; active: string; inactive: string }> = {
                vouch: { label: 'Vouch', active: 'bg-green-600 text-white border-transparent', inactive: 'bg-green-950/30 text-green-400 border-green-800 hover:bg-green-900/40' },
                anti_vouch: { label: 'Anti-Vouch', active: 'bg-orange-600 text-white border-transparent', inactive: 'bg-orange-950/30 text-orange-400 border-orange-800 hover:bg-orange-900/40' },
              }
              const cfg = cfgMap[type]
              if (!cfg) return null
              return (
                <button key={type} onClick={() => onVote(candidate.id, type)}
                  className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors cursor-pointer ${active ? cfg.active : cfg.inactive}`}>
                  {cfg.label}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Votes summary */}
      {votes.length > 0 && (
        <div className="mb-6 space-y-3">
          {!showVouchCounts && <p className="text-xs text-[var(--text-muted)]">Vouch totals are hidden until the admin reveals them. Your vote still counts.</p>}
          {showVouchCounts && vouches.length > 0 && (
            <div>
              <p className="text-xs font-medium text-green-400 mb-1">Vouches ({vouches.length})</p>
              <p className="text-sm text-[var(--text-secondary)]">{anonymous ? `${vouches.length} member(s)` : vouches.map(v => v.voter_name).join(', ')}</p>
            </div>
          )}
          {showVouchCounts && antis.length > 0 && (
            <div>
              <p className="text-xs font-medium text-orange-400 mb-1">Anti-Vouches ({antis.length})</p>
              <p className="text-sm text-[var(--text-secondary)]">{anonymous ? `${antis.length} member(s)` : antis.map(v => v.voter_name).join(', ')}</p>
            </div>
          )}
          {flags.length > 0 && (
            <div>
              <p className="text-xs font-medium text-red-400 mb-1">Red Flags ({flags.length})</p>
              {/* Red flags stay anonymous to everyone but the session creator. */}
              <p className="text-sm text-[var(--text-secondary)]">
                {anonymous || !isAdmin
                  ? `${flags.length} member(s)`
                  : flags.map(v => v.voter_name).join(', ')}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Admin status controls */}
      {isAdmin && sessionActive && (
        <div className="mb-6">
          <p className="text-xs text-[var(--text-muted)] mb-2">Set status</p>
          <div className="flex gap-2 flex-wrap">
            {(['accepted', 'rejected', 'hold', 'pending'] as const).map(s => (
              <button key={s} onClick={() => onStatusChange(candidate.id, s)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors cursor-pointer ${
                  candidate.status === s ? STATUS_BTN[s].active : STATUS_BTN[s].inactive
                }`}>
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Notes */}
      <div className="border-t border-[var(--border)] pt-5">
        <p className="text-xs text-[var(--text-muted)] font-medium uppercase tracking-wider mb-3">Notes</p>

        {notes.length > 0 && (
          <div className="space-y-2 mb-4">
            {notes.map(note => (
              <div key={note.id} className={`rounded-lg p-3 text-sm border ${
                note.type === 'red_flag'
                  ? 'bg-red-950/20 border-red-900/50'
                  : 'bg-[var(--bg-raised)] border-[var(--border)]'
              }`}>
                <div className="flex items-center gap-2 mb-1">
                  {note.type === 'red_flag' && (
                    <span className="text-red-400 text-xs font-bold tracking-wide">⚑ RED FLAG</span>
                  )}
                  <span className="text-[var(--text-muted)] text-xs">{note.author}</span>
                  <span className="text-[var(--text-muted)] text-xs">
                    {new Date(note.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' })}
                  </span>
                  {(note.author === myName || isAdmin) && (
                    <button
                      onClick={() => deleteNote(note.id)}
                      className="ml-auto text-[var(--text-muted)] hover:text-red-400 transition-colors text-xs cursor-pointer"
                      title="Delete note"
                    >
                      ✕
                    </button>
                  )}
                </div>
                <p className={`text-sm leading-snug ${note.type === 'red_flag' ? 'text-red-400' : 'text-[var(--text-secondary)]'}`}>
                  {note.content}
                </p>
              </div>
            ))}
          </div>
        )}

        {sessionActive ? (
          <div className="space-y-2">
            <textarea
              value={noteText}
              onChange={e => setNoteText(e.target.value)}
              placeholder="Write a note..."
              rows={2}
              className="w-full bg-[var(--bg-raised)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)] placeholder-[var(--text-muted)] text-sm focus:outline-none focus:border-[#FF6B35] resize-none"
            />
            <div className="flex gap-2">
              <button
                onClick={() => submitNote('note')}
                disabled={submitting || !noteText.trim()}
                className="flex-1 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium py-2 rounded-lg transition-colors disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
              >
                Add Note
              </button>
              <button
                onClick={() => submitNote('red_flag')}
                disabled={submitting || !noteText.trim()}
                className="flex-1 bg-red-600 hover:bg-red-500 text-white text-sm font-medium py-2 rounded-lg transition-colors disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
              >
                ⚑ Red Flag
              </button>
            </div>
          </div>
        ) : (
          <p className="text-xs text-[var(--text-muted)] italic">Session ended — notes are read-only.</p>
        )}
      </div>
    </div>
  )
}

function isUrl(val: string) {
  return val.startsWith('http://') || val.startsWith('https://')
}

function formatValue(val: unknown): string {
  if (typeof val === 'number') {
    return Number.isInteger(val) ? String(val) : val.toFixed(4).replace(/\.?0+$/, '')
  }
  return String(val)
}

// Rubric criteria from the grading form, grouped for display. Values r1–r9 are
// per-grader z-scores (0 = cohort average); r0 is a raw 1–3 concern rating / 15.
const RUBRIC_GROUPS: { title: string; keys: [string, string][] }[] = [
  { title: 'Essay 1', keys: [['r4', 'Criterion 1'], ['r5', 'Criterion 2']] },
  { title: 'Essay 2', keys: [['r8', 'Criterion 1'], ['r9', 'Criterion 2']] },
  { title: 'Essay 3', keys: [['r6', 'Criterion 1'], ['r7', 'Criterion 2']] },
  { title: 'Resume', keys: [['r1', 'Expressiveness'], ['r2', 'Technical depth'], ['r3', 'Passion for building']] },
]
const RUBRIC_KEYS = new Set(['r0', ...RUBRIC_GROUPS.flatMap(g => g.keys.map(([k]) => k))])

// Diverging bar for a z-score: center = cohort average, right/green = above, left/red = below.
function ZBar({ label, value }: { label: string; value: number }) {
  const clamped = Math.max(-2, Math.min(2, value))
  const halfWidth = Math.abs(clamped) / 2 * 50 // percent of half-track
  const positive = clamped >= 0
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-36 shrink-0 text-[var(--text-muted)] truncate" title={label}>{label}</span>
      <div className="relative flex-1 h-2 rounded-full bg-[var(--bg-raised)] overflow-hidden">
        <div className="absolute left-1/2 top-0 bottom-0 w-px bg-[var(--border)]" />
        <div
          className={`absolute top-0 bottom-0 rounded-full ${positive ? 'bg-green-500/70' : 'bg-red-500/70'}`}
          style={positive
            ? { left: '50%', width: `${halfWidth}%` }
            : { right: '50%', width: `${halfWidth}%` }}
        />
      </div>
      <span className={`w-12 shrink-0 text-right font-mono ${positive ? 'text-green-400' : 'text-red-400'}`}>
        {value > 0 ? '+' : ''}{value.toFixed(2)}
      </span>
    </div>
  )
}

function RubricStats({ data }: { data: Record<string, unknown> }) {
  const num = (k: string) => (typeof data[k] === 'number' ? data[k] as number : null)
  const groups = RUBRIC_GROUPS
    .map(g => ({ ...g, rows: g.keys.map(([k, label]) => ({ label, value: num(k) })).filter(r => r.value !== null) }))
    .filter(g => g.rows.length > 0)

  // r0 is stored as (1–3 rating)/15 averaged across graders — recover the 1–3 scale.
  const r0 = num('r0')
  const concern = r0 === null ? null : Math.round(r0 * 15 * 10) / 10
  const concernDisplay = concern === null ? null
    : concern >= 2.5 ? { text: `No concerns (${concern}/3)`, cls: 'bg-green-500/15 text-green-400 border-green-500/30' }
    : concern >= 1.5 ? { text: `Could be a problem (${concern}/3)`, cls: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30' }
    : { text: `RED FLAG (${concern}/3)`, cls: 'bg-red-500/15 text-red-400 border-red-500/30' }

  if (!groups.length && !concernDisplay) return null

  return (
    <div className="bg-[var(--bg-raised)]/60 border border-[var(--border)] rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">Rubric scores vs. cohort average</p>
        {concernDisplay && (
          <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${concernDisplay.cls}`} title="Time commitment assessment from graders">
            Time commitments: {concernDisplay.text}
          </span>
        )}
      </div>
      <div className="grid sm:grid-cols-2 gap-x-8 gap-y-3">
        {groups.map(g => (
          <div key={g.title} className="space-y-1.5">
            <p className="text-xs font-medium text-[var(--text-secondary)]">{g.title}</p>
            {g.rows.map(r => <ZBar key={r.label} label={r.label} value={r.value!} />)}
          </div>
        ))}
      </div>
      <p className="text-[10px] text-[var(--text-muted)]">Bars show how this candidate compares to other applicants: right of center = above average, left = below. Scores are normalized per grader.</p>
    </div>
  )
}

const COMMENT_SECTIONS: { key: 'comment1' | 'comment2' | 'comment3' | 'comment4' | 'comment0'; label: string }[] = [
  { key: 'comment1', label: 'Essay Question 1' },
  { key: 'comment2', label: 'Essay Question 2' },
  { key: 'comment3', label: 'Essay Question 3' },
  { key: 'comment4', label: 'Time Commitments' },
  { key: 'comment0', label: 'Resume / CV' },
]

function GraderComments({ reviews }: { reviews?: GraderReview[] }) {
  if (!reviews || reviews.length === 0) return null

  // Only render sections that at least one grader actually wrote something for.
  const sections = COMMENT_SECTIONS
    .map(sec => ({
      label: sec.label,
      entries: reviews
        .map(r => ({ grader: r.grader_email, text: (r[sec.key] ?? '').trim() }))
        .filter(e => e.text.length > 0),
    }))
    .filter(sec => sec.entries.length > 0)

  if (sections.length === 0) return null

  const graderLabel = new Map<string, string>()
  reviews.forEach((r, i) => graderLabel.set(r.grader_email, `Grader ${i + 1}`))

  return (
    <details className="mb-6 bg-[var(--bg-raised)]/60 border border-[var(--border)] rounded-lg" open>
      <summary className="cursor-pointer px-4 py-2.5 text-sm font-medium text-[var(--text-primary)]">
        Grader Comments
        <span className="text-[var(--text-muted)] font-normal"> · {reviews.length} reviewer{reviews.length !== 1 ? 's' : ''}</span>
      </summary>
      <div className="px-4 pb-4 space-y-4">
        {sections.map(sec => (
          <div key={sec.label}>
            <p className="text-xs font-semibold text-[#ff8a00] uppercase tracking-wider mb-1.5">{sec.label}</p>
            <div className="space-y-1.5">
              {sec.entries.map((e, i) => (
                <div key={i} className="text-sm text-[var(--text-secondary)]">
                  <span className="text-[var(--text-muted)] text-xs mr-2">{graderLabel.get(e.grader)}</span>
                  <span className="whitespace-pre-wrap">{e.text}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </details>
  )
}

type InterviewData = {
  format: 'developer_fa26' | 'curriculum_fa26' | 'behavioral_fa26'
  interviewers: string[]
  criterion_averages: { key: string; label: string; value: number }[]
  overall_score: number | null
  records: {
    source_row: number
    interviewer: string
    timestamp?: string
    complete?: boolean
    counted?: boolean
    scores: { key: string; label: string; value: number; raw: string }[]
    responses: { label: string; value: string }[]
  }[]
}

function isInterviewData(value: unknown): value is InterviewData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (record.format === 'developer_fa26' || record.format === 'curriculum_fa26' || record.format === 'behavioral_fa26')
    && Array.isArray(record.interviewers)
    && Array.isArray(record.criterion_averages)
    && Array.isArray(record.records)
}

function InterviewDetails({ value, role }: { value: unknown; role: Session['role'] }) {
  if (!isInterviewData(value)) return null
  const behavioral = value.format === 'behavioral_fa26'
  return (
    <div className="mb-6 overflow-hidden rounded-xl border border-[#FF6B35]/30 bg-[#FF6B35]/5">
      <div className="space-y-3 px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-[#FF6B35]">Interview results</p>
            <p className="mt-1 text-sm text-[var(--text-secondary)]">
              <span className="font-medium text-[var(--text-primary)]">Interviewers:</span>{' '}
              {value.interviewers.join(', ') || 'Not listed'}
            </p>
          </div>
          <div className="rounded-lg border border-[#FF6B35]/25 bg-[var(--bg-raised)] px-3 py-2 text-right">
            <p className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{behavioral ? 'Behavioral average' : 'Overall score'}</p>
            <p className="font-mono text-lg font-semibold text-[#FF6B35]">
              {value.overall_score === null ? (behavioral ? 'Awaiting behavioral scores' : '—') : value.overall_score.toFixed(2)}
            </p>
          </div>
        </div>
        {behavioral && <p className="text-xs text-[var(--text-muted)]">Behavioral average is out of 4.14: (13 × 4 + 6) ÷ 14 ≈ 4.14. Each interviewer’s 14 ratings are averaged, then interviewers are averaged equally.</p>}
        {value.criterion_averages.length > 0 && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {value.criterion_averages.map(score => (
              <div key={score.key} className="rounded-lg border border-[var(--border)] bg-[var(--bg-raised)]/80 p-2.5">
                <p className="truncate text-[10px] text-[var(--text-muted)]" title={score.label}>{score.label}</p>
                <p className="font-mono text-sm font-semibold text-[var(--text-primary)]">{score.value.toFixed(2)}</p>
              </div>
            ))}
          </div>
        )}
      </div>
      <details className="border-t border-[#FF6B35]/20">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-[#FF6B35]">
          View interviewer responses and comments ({value.records.length})
        </summary>
        <div className="space-y-3 px-4 pb-4">
          {value.records.map(record => (
            <details key={`${record.source_row}-${record.interviewer}`} className="rounded-lg border border-[var(--border)] bg-[var(--bg-raised)]/80 p-3">
              <summary className="mb-3 cursor-pointer">
                <p className="text-sm font-semibold text-[var(--text-primary)]">{record.interviewer}</p>
                {behavioral && <p className="text-xs text-[var(--text-muted)]">{record.timestamp} · {record.counted ? 'Included in average' : record.complete ? 'Reference only (not counted)' : 'Incomplete (not counted)'}</p>}
              </summary>
              {record.scores.length > 0 && (
                <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {record.scores.map(score => (
                    <div key={score.key} className="rounded-md border border-[var(--border)] bg-[var(--bg-surface)] px-2.5 py-2">
                      <p className="text-[10px] text-[var(--text-muted)]">{score.label}</p>
                      <p className="text-sm font-medium text-[var(--text-primary)]">{score.raw}</p>
                    </div>
                  ))}
                </div>
              )}
              {record.responses.length > 0 && (
                <div className="space-y-2">
                  {record.responses.map((response, index) => (
                    <details key={`${response.label}-${index}`} className="rounded-md border border-[var(--border)] bg-[var(--bg-surface)]">
                      <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-[var(--text-secondary)]">{behavioral ? behavioralNoteLabel(response.label, role) : response.label}</summary>
                      <p className="whitespace-pre-wrap break-words px-3 pb-3 text-sm text-[var(--text-primary)]">{response.value}</p>
                    </details>
                  ))}
                </div>
              )}
            </details>
          ))}
        </div>
      </details>
    </div>
  )
}

function DataFields({ data }: { data: Record<string, unknown> }) {
  const hasInterview = isInterviewData(data.interview)
  const entries = Object.entries(data).filter(([k, v]) =>
    v !== null && v !== undefined && v !== '' && !RUBRIC_KEYS.has(k)
    && k !== 'interview' && k !== 'candidate_number' && !(hasInterview && k === 'score'),
  )

  const urls = entries.filter(([, v]) => typeof v === 'string' && isUrl(v as string))
  const nonUrl = entries.filter(([, v]) => !(typeof v === 'string' && isUrl(v as string)))

  // Numbers (scores) and short metadata strings render as compact cards; any
  // longer free text (interview answers, notes) goes into collapsible blocks so
  // it doesn't clutter the grid.
  const isCompact = (v: unknown) =>
    typeof v === 'number' || (typeof v === 'string' && v.length <= 24 && !v.includes('\n'))
  const compact = nonUrl.filter(([, v]) => isCompact(v))
  const longText = nonUrl.filter(([, v]) => !isCompact(v))

  return (
    <div className="mb-6 space-y-4">
      {compact.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {compact.map(([key, val]) => (
            <div key={key} className="bg-[var(--bg-raised)]/80 border border-[var(--border)] rounded-lg p-3">
              <p className="text-xs text-[var(--text-muted)] mb-0.5 truncate">{key}</p>
              <p className="text-[var(--text-primary)] font-medium text-sm break-words">{formatValue(val)}</p>
            </div>
          ))}
        </div>
      )}

      <RubricStats data={data} />

      {longText.length > 0 && (
        <div className="space-y-2">
          {longText.map(([key, val]) => (
            <details key={key} className="bg-[var(--bg-raised)]/80 border border-[var(--border)] rounded-lg">
              <summary className="cursor-pointer px-3 py-2 text-xs text-[var(--text-muted)] font-medium hover:text-[var(--text-primary)]">
                {key}
              </summary>
              <p className="px-3 pb-3 text-sm text-[var(--text-primary)] whitespace-pre-wrap break-words">
                {String(val)}
              </p>
            </details>
          ))}
        </div>
      )}

      {urls.length > 0 && (
        <div className="flex flex-wrap gap-3">
          {urls.map(([key, val]) => (
            <a key={key} href={val as string} target="_blank" rel="noopener noreferrer"
              className="text-sm text-blue-400 hover:text-blue-300 underline">
              {key} ↗
            </a>
          ))}
        </div>
      )}
    </div>
  )
}
