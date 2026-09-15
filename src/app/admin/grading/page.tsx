'use client'

import React, { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { getCurrentUser, canAccessAdmin } from '@/lib/auth'
import { RecruitmentCycle, Round } from '@/lib/types'

interface GraderStat {
  email: string
  assigned: number
  completed: number
  average_rating: number | null
  rating_stddev: number | null
  transferable_count: number
}

interface ReassignmentSource {
  email: string
  applicants: { id: string; name: string }[]
}

interface ReassignmentSourceOption {
  email: string
  available: number
  pool: 'regular' | 'leadership'
}

interface ReassignmentPreview {
  target_grader_email: string
  count: number
  available: number
  total_available: number
  target_pool: 'regular' | 'leadership'
  selected_source_grader_email: string | null
  eligible_sources: ReassignmentSourceOption[]
  transfers: {
    assignment_id: string
    applicant_id: string
    applicant_name: string
    from_grader_email: string
  }[]
  source_summary: ReassignmentSource[]
}

interface ApplicantRow {
  applicant_id: string
  first_name: string
  last_name: string
  desired_roles: string | null
  r0: number
  r1: number
  r2: number
  r3: number
  r4: number
  r5: number
  r6: number
  r7: number
  r8: number
  r9: number
  total: number
  review_count: number
  assigned_count: number
  reviews: { grader_email: string; r0: number; r1: number; r2: number; r3: number; r4: number; r5: number; r6: number; r7: number; r8: number; r9: number }[]
}

type RatingKey = 'r0' | 'r1' | 'r2' | 'r3' | 'r4' | 'r5' | 'r6' | 'r7' | 'r8' | 'r9'
type ApplicantSortKey = 'total' | 'name' | 'reviews' | RatingKey
type GraderSortKey = 'email' | 'completed' | 'assigned' | 'average_rating' | 'rating_stddev' | 'progress'

const APPLICANT_SORT_OPTIONS: { value: ApplicantSortKey; label: string }[] = [
  { value: 'total', label: 'Overall score' },
  { value: 'name', label: 'Applicant name' },
  { value: 'reviews', label: 'Reviews completed' },
  { value: 'r0', label: 'R0 — Time commitments concern' },
  { value: 'r1', label: 'R1 — Resume thoughtfulness' },
  { value: 'r2', label: 'R2 — Technical depth' },
  { value: 'r3', label: 'R3 — Passion (resume)' },
  { value: 'r4', label: 'R4 — Passion for club' },
  { value: 'r5', label: 'R5 — Club knowledge' },
  { value: 'r6', label: 'R6 — Creativity' },
  { value: 'r7', label: 'R7 — Eagerness to learn' },
  { value: 'r8', label: 'R8 — Leadership' },
  { value: 'r9', label: 'R9 — Commitment to community' },
]

function SortIcon({ active, direction }: { active: boolean; direction: 'asc' | 'desc' }) {
  return active ? <span className="ml-1">{direction === 'desc' ? '↓' : '↑'}</span> : null
}

export default function GradingConsolePage() {
  const router = useRouter()
  const [authed, setAuthed] = useState(false)
  const [cycles, setCycles] = useState<RecruitmentCycle[]>([])
  const [selectedCycleId, setSelectedCycleId] = useState<string>('')
  const [rounds, setRounds] = useState<Round[]>([])
  const [selectedRoundId, setSelectedRoundId] = useState<string>('')
  const [graders, setGraders] = useState<GraderStat[]>([])
  const [applicants, setApplicants] = useState<ApplicantRow[]>([])
  const [loading, setLoading] = useState(false)
  const [expandedApplicant, setExpandedApplicant] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<ApplicantSortKey>('total')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [graderSortKey, setGraderSortKey] = useState<GraderSortKey>('completed')
  const [graderSortDir, setGraderSortDir] = useState<'asc' | 'desc'>('desc')
  const [reassignTarget, setReassignTarget] = useState<GraderStat | null>(null)
  const [reassignCount, setReassignCount] = useState(5)
  const [reassignSourceEmail, setReassignSourceEmail] = useState('')
  const [reassignPreview, setReassignPreview] = useState<ReassignmentPreview | null>(null)
  const [reassignLoading, setReassignLoading] = useState(false)
  const [reassignError, setReassignError] = useState('')
  const [reassignMessage, setReassignMessage] = useState('')

  const loadStats = useCallback(async (roundId: string) => {
    setLoading(true)
    const res = await fetch(`/api/admin/grading-stats?round_id=${roundId}`)
    const data = await res.json()
    setGraders(data.graders ?? [])
    setApplicants(data.applicants ?? [])
    setLoading(false)
  }, [])

  const selectRound = useCallback((roundId: string) => {
    setSelectedRoundId(roundId)
    setGraders([])
    setApplicants([])
    if (roundId) void loadStats(roundId)
  }, [loadStats])

  const selectCycle = useCallback(async (cycleId: string) => {
    setSelectedCycleId(cycleId)
    setSelectedRoundId('')
    setRounds([])
    setGraders([])
    setApplicants([])
    if (!cycleId) return

    const response = await fetch(`/api/cycles/${cycleId}/rounds`)
    const data: Round[] = await response.json()
    const sorted = (data ?? []).sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0))
    setRounds(sorted)
    selectRound(sorted[0]?.id ?? '')
  }, [selectRound])

  useEffect(() => {
    getCurrentUser().then(u => {
      if (!u || !canAccessAdmin(u.role)) { router.replace('/dashboard'); return }
      setAuthed(true)
    })
  }, [router])

  useEffect(() => {
    if (!authed) return
    fetch('/api/cycles').then(r => r.json()).then((data: RecruitmentCycle[]) => {
      setCycles(data ?? [])
      if (data?.length) void selectCycle(data[0].id)
    })
  }, [authed, selectCycle])

  function toggleSort(key: ApplicantSortKey) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('desc') }
  }

  function toggleGraderSort(key: GraderSortKey) {
    if (graderSortKey === key) setGraderSortDir(direction => direction === 'asc' ? 'desc' : 'asc')
    else { setGraderSortKey(key); setGraderSortDir(key === 'email' ? 'asc' : 'desc') }
  }

  function openReassignment(grader: GraderStat) {
    setReassignTarget(grader)
    setReassignCount(Math.min(5, grader.transferable_count))
    setReassignSourceEmail('')
    setReassignPreview(null)
    setReassignError('')
  }

  function closeReassignment() {
    if (reassignLoading) return
    setReassignTarget(null)
    setReassignSourceEmail('')
    setReassignPreview(null)
    setReassignError('')
  }

  async function previewReassignment() {
    if (!reassignTarget || !selectedRoundId) return
    setReassignLoading(true)
    setReassignError('')
    try {
      const response = await fetch('/api/grader-assignments/reassign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'preview',
          round_id: selectedRoundId,
          target_grader_email: reassignTarget.email,
          count: reassignCount,
          source_grader_email: reassignSourceEmail || undefined,
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        setReassignError(data.error ?? 'Unable to preview assignment transfers.')
        return
      }
      setReassignPreview(data as ReassignmentPreview)
    } catch {
      setReassignError('Unable to reach the server. Please try again.')
    } finally {
      setReassignLoading(false)
    }
  }

  async function commitReassignment() {
    if (!reassignTarget || !selectedRoundId || !reassignPreview) return
    setReassignLoading(true)
    setReassignError('')
    try {
      const response = await fetch('/api/grader-assignments/reassign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'commit',
          round_id: selectedRoundId,
          target_grader_email: reassignTarget.email,
          assignment_ids: reassignPreview.transfers.map(transfer => transfer.assignment_id),
          source_grader_email: reassignPreview.selected_source_grader_email ?? undefined,
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        setReassignPreview(null)
        setReassignError(data.error ?? 'Unable to transfer assignments.')
        return
      }
      setReassignMessage(
        `Transferred ${data.moved} application${data.moved === 1 ? '' : 's'} to ${data.target_grader_email}.`,
      )
      setReassignTarget(null)
      setReassignPreview(null)
      await loadStats(selectedRoundId)
    } catch {
      setReassignPreview(null)
      setReassignError('Unable to reach the server. Please preview the transfers again.')
    } finally {
      setReassignLoading(false)
    }
  }

  const sortedApplicants = [...applicants].sort((a, b) => {
    if (a.review_count === 0 && b.review_count > 0) return 1
    if (b.review_count === 0 && a.review_count > 0) return -1
    let diff = 0
    if (sortKey === 'total') diff = a.total - b.total
    else if (sortKey === 'name') diff = `${a.last_name}${a.first_name}`.localeCompare(`${b.last_name}${b.first_name}`)
    else if (sortKey === 'reviews') diff = a.review_count - b.review_count
    else diff = a[sortKey] - b[sortKey]
    if (diff === 0) diff = `${a.last_name}${a.first_name}`.localeCompare(`${b.last_name}${b.first_name}`)
    return sortDir === 'asc' ? diff : -diff
  })

  const sortedGraders = [...graders].sort((a, b) => {
    const aProgress = a.assigned > 0 ? a.completed / a.assigned : 0
    const bProgress = b.assigned > 0 ? b.completed / b.assigned : 0
    let diff = 0
    if (graderSortKey === 'email') diff = a.email.localeCompare(b.email)
    else if (graderSortKey === 'progress') diff = aProgress - bProgress
    else if (graderSortKey === 'average_rating' || graderSortKey === 'rating_stddev') {
      const aValue = a[graderSortKey]
      const bValue = b[graderSortKey]
      if (aValue === null && bValue !== null) return 1
      if (bValue === null && aValue !== null) return -1
      diff = (aValue ?? 0) - (bValue ?? 0)
    } else diff = a[graderSortKey] - b[graderSortKey]
    if (diff === 0) diff = a.email.localeCompare(b.email)
    return graderSortDir === 'asc' ? diff : -diff
  })
  const selectedRatingKey = sortKey.startsWith('r') && sortKey !== 'reviews'
    ? sortKey as RatingKey
    : null

  const selectedSourceAvailable = reassignPreview
    ? reassignSourceEmail
      ? reassignPreview.eligible_sources.find(source => source.email === reassignSourceEmail)?.available ?? 0
      : reassignPreview.total_available
    : reassignTarget?.transferable_count ?? 0
  const reassignmentPreviewIsCurrent = Boolean(
    reassignPreview
    && reassignPreview.count === reassignCount
    && (reassignPreview.selected_source_grader_email ?? '') === reassignSourceEmail,
  )
  const fullyGradedApplications = applicants.filter(applicant => (
    applicant.assigned_count > 0 && applicant.review_count >= applicant.assigned_count
  )).length
  const submittedReviews = applicants.reduce((total, applicant) => total + applicant.review_count, 0)
  const assignedReviews = applicants.reduce((total, applicant) => total + applicant.assigned_count, 0)
  const overallProgress = applicants.length > 0
    ? Math.round((fullyGradedApplications / applicants.length) * 100)
    : 0

  if (!authed) return null

  return (
    <main className="min-h-screen bg-[var(--bg-base)] flex flex-col">
      {/* Header */}
      <header className="bg-[var(--bg-surface)] border-b border-[var(--border)] px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-1">
          <button onClick={() => router.push('/dashboard')} className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors px-3 py-1.5 rounded-lg">
            ← Dashboard
          </button>
          <span className="text-[var(--border)] px-1">|</span>
          <button onClick={() => router.push('/admin')} className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors px-3 py-1.5 rounded-lg">
            Admin Console
          </button>
          <button className="text-xs font-semibold text-[var(--text-primary)] bg-[var(--bg-active)] px-3 py-1.5 rounded-lg">
            Grading Console
          </button>
        </div>
      </header>
      <div className="max-w-5xl mx-auto w-full py-8 px-4 space-y-6">

        {/* Cycle + Round selectors */}
        <div className="flex gap-4 flex-wrap items-end">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-[var(--text-muted)] font-medium">Cycle</label>
            <select
              value={selectedCycleId}
              onChange={e => void selectCycle(e.target.value)}
              className="w-fit bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg pl-3 pr-2 py-2 text-[var(--text-primary)] text-sm focus:outline-none focus:border-[#FF6B35]"
            >
              {cycles.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-[var(--text-muted)] font-medium">Round</label>
            <select
              value={selectedRoundId}
              onChange={e => selectRound(e.target.value)}
              className="w-fit bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg pl-3 pr-2 py-2 text-[var(--text-primary)] text-sm focus:outline-none focus:border-[#FF6B35]"
              disabled={rounds.length === 0}
            >
              {rounds.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
          <button
            onClick={() => selectedRoundId && loadStats(selectedRoundId)}
            className="bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)] text-sm hover:bg-[var(--bg-raised)] transition-colors"
          >
            Refresh
          </button>
        </div>

        {reassignMessage && (
          <div className="rounded-lg border border-green-500/30 bg-green-500/10 px-4 py-3 text-sm text-green-600">
            {reassignMessage}
          </div>
        )}

        {loading ? (
          <p className="text-[var(--text-muted)] text-sm">Loading…</p>
        ) : !selectedRoundId ? (
          <p className="text-[var(--text-muted)] text-sm">Select a round to view grading stats.</p>
        ) : (
          <>
            {/* Overall Progress */}
            <div className="bg-[var(--bg-surface)] border border-[var(--border)] rounded-xl p-5">
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                  <h2 className="font-semibold text-[var(--text-primary)]">Overall Grading Progress</h2>
                  <p className="mt-2 text-2xl font-semibold text-[var(--text-primary)]">
                    {fullyGradedApplications} / {applicants.length}
                  </p>
                  <p className="text-sm text-[var(--text-muted)]">applications fully graded</p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-medium text-[var(--text-secondary)]">
                    {submittedReviews} / {assignedReviews} reviews submitted
                  </p>
                  <p className="mt-1 text-xs text-[var(--text-muted)]">
                    An application is complete after all assigned reviewers submit.
                  </p>
                </div>
              </div>
              <div className="mt-4 h-2.5 overflow-hidden rounded-full bg-[var(--border)]">
                <div
                  role="progressbar"
                  aria-label="Applications fully graded"
                  aria-valuemin={0}
                  aria-valuemax={applicants.length}
                  aria-valuenow={fullyGradedApplications}
                  className="h-full rounded-full bg-gradient-to-r from-[#FF6B35] to-[#C026D3] transition-all"
                  style={{ width: `${overallProgress}%` }}
                />
              </div>
              <p className="mt-2 text-right text-xs font-medium text-[var(--text-muted)]">{overallProgress}% complete</p>
            </div>

            {/* Grader Progress */}
            <div className="bg-[var(--bg-surface)] border border-[var(--border)] rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-[var(--border)]">
                <h2 className="font-semibold text-[var(--text-primary)]">Grader Progress</h2>
                <p className="text-xs text-[var(--text-muted)] mt-0.5">{graders.length} graders assigned</p>
                <p className="text-xs text-[var(--text-muted)] mt-1">
                  Lower average ratings generally indicate stricter grading; higher standard deviation indicates more variable ratings. Based on submitted 1–4 rubric ratings.
                </p>
              </div>
              {graders.length === 0 ? (
                <p className="px-5 py-4 text-sm text-[var(--text-muted)]">No graders assigned yet.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-[var(--bg-raised)]">
                    <tr>
                      <th
                        className="text-left px-5 py-2 text-xs text-[var(--text-muted)] font-medium cursor-pointer hover:text-[var(--text-primary)] select-none"
                        onClick={() => toggleGraderSort('email')}
                      >
                        Grader <SortIcon active={graderSortKey === 'email'} direction={graderSortDir} />
                      </th>
                      <th
                        className="text-right px-5 py-2 text-xs text-[var(--text-muted)] font-medium cursor-pointer hover:text-[var(--text-primary)] select-none"
                        onClick={() => toggleGraderSort('completed')}
                      >
                        Completed <SortIcon active={graderSortKey === 'completed'} direction={graderSortDir} />
                      </th>
                      <th
                        className="text-right px-5 py-2 text-xs text-[var(--text-muted)] font-medium cursor-pointer hover:text-[var(--text-primary)] select-none"
                        onClick={() => toggleGraderSort('assigned')}
                      >
                        Assigned <SortIcon active={graderSortKey === 'assigned'} direction={graderSortDir} />
                      </th>
                      <th
                        className="text-right px-5 py-2 text-xs text-[var(--text-muted)] font-medium cursor-pointer hover:text-[var(--text-primary)] select-none"
                        title="Average across all submitted 1–4 rubric ratings (R1–R9). Lower generally means stricter grading."
                        onClick={() => toggleGraderSort('average_rating')}
                      >
                        Avg rating <SortIcon active={graderSortKey === 'average_rating'} direction={graderSortDir} />
                      </th>
                      <th
                        className="text-right px-5 py-2 text-xs text-[var(--text-muted)] font-medium cursor-pointer hover:text-[var(--text-primary)] select-none"
                        title="Population standard deviation across all submitted 1–4 rubric ratings (R1–R9). Higher means more variable scoring."
                        onClick={() => toggleGraderSort('rating_stddev')}
                      >
                        Std dev <SortIcon active={graderSortKey === 'rating_stddev'} direction={graderSortDir} />
                      </th>
                      <th
                        className="px-5 py-2 text-xs text-[var(--text-muted)] font-medium w-40 cursor-pointer hover:text-[var(--text-primary)] select-none"
                        onClick={() => toggleGraderSort('progress')}
                      >
                        Progress <SortIcon active={graderSortKey === 'progress'} direction={graderSortDir} />
                      </th>
                      <th className="text-right px-5 py-2 text-xs text-[var(--text-muted)] font-medium">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border)]">
                    {sortedGraders.map(g => {
                      const pct = g.assigned > 0 ? Math.round((g.completed / g.assigned) * 100) : 0
                      const done = g.completed === g.assigned
                      return (
                        <tr key={g.email} className="hover:bg-[var(--bg-raised)] transition-colors">
                          <td className="px-5 py-3 text-[var(--text-secondary)]">{g.email}</td>
                          <td className="px-5 py-3 text-right font-medium text-[var(--text-primary)]">{g.completed}</td>
                          <td className="px-5 py-3 text-right text-[var(--text-muted)]">{g.assigned}</td>
                          <td className="px-5 py-3 text-right font-mono text-[var(--text-primary)]">
                            {g.average_rating === null ? '—' : g.average_rating.toFixed(2)}
                          </td>
                          <td className="px-5 py-3 text-right font-mono text-[var(--text-muted)]">
                            {g.rating_stddev === null ? '—' : g.rating_stddev.toFixed(2)}
                          </td>
                          <td className="px-5 py-3">
                            <div className="flex items-center gap-2">
                              <div className="flex-1 h-1.5 bg-[var(--border)] rounded-full overflow-hidden">
                                <div
                                  className={`h-full rounded-full transition-all ${done ? 'bg-green-500' : 'bg-[#FF6B35]'}`}
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                              <span className={`text-xs w-8 text-right ${done ? 'text-green-500' : 'text-[var(--text-muted)]'}`}>{pct}%</span>
                            </div>
                          </td>
                          <td className="px-5 py-3 text-right">
                            <button
                              type="button"
                              onClick={() => openReassignment(g)}
                              disabled={g.transferable_count === 0}
                              title={g.transferable_count === 0
                                ? 'No eligible pending assignments can be transferred.'
                                : `${g.transferable_count} pending assignments are eligible for transfer.`}
                              className="whitespace-nowrap rounded-lg border border-[#FF6B35]/40 bg-[#FF6B35]/10 px-3 py-1.5 text-xs font-medium text-[#FF6B35] transition-colors hover:bg-[#FF6B35]/20 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              Assign more
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {/* Applicant Scores */}
            <div className="bg-[var(--bg-surface)] border border-[var(--border)] rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-[var(--border)] flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h2 className="font-semibold text-[var(--text-primary)]">Applicant Scores</h2>
                  <p className="text-xs text-[var(--text-muted)] mt-0.5">{applicants.length} applicants — click a row to see per-reviewer ratings</p>
                </div>
                <div className="flex items-end gap-2">
                  <label className="text-xs text-[var(--text-muted)]">
                    <span className="mb-1 block">Sort by</span>
                    <select
                      value={sortKey}
                      onChange={event => {
                        setSortKey(event.target.value as ApplicantSortKey)
                        setSortDir('desc')
                      }}
                      className="rounded-lg border border-[var(--border)] bg-[var(--bg-raised)] px-3 py-2 text-xs text-[var(--text-primary)]"
                    >
                      {APPLICANT_SORT_OPTIONS.map(option => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    onClick={() => setSortDir(direction => direction === 'asc' ? 'desc' : 'asc')}
                    className="rounded-lg border border-[var(--border)] bg-[var(--bg-raised)] px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-active)]"
                    aria-label={`Sort ${sortDir === 'desc' ? 'ascending' : 'descending'}`}
                  >
                    {sortDir === 'desc' ? 'Highest first ↓' : 'Lowest first ↑'}
                  </button>
                </div>
              </div>
              {applicants.length === 0 ? (
                <p className="px-5 py-4 text-sm text-[var(--text-muted)]">No applicants assigned yet.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-[var(--bg-raised)]">
                    <tr>
                      <th
                        className="text-left px-5 py-2 text-xs text-[var(--text-muted)] font-medium cursor-pointer hover:text-[var(--text-primary)] select-none"
                        onClick={() => toggleSort('name')}
                      >
                        Name <SortIcon active={sortKey === 'name'} direction={sortDir} />
                      </th>
                      <th className="text-left px-5 py-2 text-xs text-[var(--text-muted)] font-medium">Role</th>
                      <th
                        className="text-right px-5 py-2 text-xs text-[var(--text-muted)] font-medium cursor-pointer hover:text-[var(--text-primary)] select-none"
                        onClick={() => toggleSort('reviews')}
                      >
                        Reviews <SortIcon active={sortKey === 'reviews'} direction={sortDir} />
                      </th>
                      <th
                        className="text-right px-5 py-2 text-xs text-[var(--text-muted)] font-medium cursor-pointer hover:text-[var(--text-primary)] select-none"
                        onClick={() => toggleSort('total')}
                      >
                        Score <SortIcon active={sortKey === 'total'} direction={sortDir} />
                      </th>
                      {selectedRatingKey && (
                        <th className="text-right px-5 py-2 text-xs text-[var(--text-muted)] font-medium uppercase">
                          {selectedRatingKey} value <SortIcon active direction={sortDir} />
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border)]">
                    {sortedApplicants.map(a => {
                      const expanded = expandedApplicant === a.applicant_id
                      const hasScore = a.review_count > 0
                      return (
                        <React.Fragment key={a.applicant_id}>
                          <tr
                            className="hover:bg-[var(--bg-raised)] transition-colors cursor-pointer"
                            onClick={() => setExpandedApplicant(expanded ? null : a.applicant_id)}
                          >
                            <td className="px-5 py-3 font-medium text-[var(--text-primary)]">
                              {a.last_name}, {a.first_name}
                              <span className="ml-2 text-[var(--text-muted)]">{expanded ? '▲' : '▼'}</span>
                            </td>
                            <td className="px-5 py-3 text-[var(--text-muted)] text-xs">{a.desired_roles ?? '—'}</td>
                            <td className="px-5 py-3 text-right text-[var(--text-muted)]">
                              {a.review_count}/{a.assigned_count}
                            </td>
                            <td className="px-5 py-3 text-right font-mono font-semibold">
                              {hasScore ? (
                                <span className="text-[#FF6B35]">{a.total.toFixed(2)}</span>
                              ) : (
                                <span className="text-[var(--text-muted)]">—</span>
                              )}
                            </td>
                            {selectedRatingKey && (
                              <td className="px-5 py-3 text-right font-mono font-semibold text-[#C026D3]">
                                {hasScore ? a[selectedRatingKey].toFixed(2) : '—'}
                              </td>
                            )}
                          </tr>
                          {expanded && (
                            <tr className="bg-[var(--bg-raised)]">
                              <td colSpan={selectedRatingKey ? 5 : 4} className="px-5 py-4">
                                {a.reviews.length === 0 ? (
                                  <p className="text-xs text-[var(--text-muted)]">No reviews submitted yet.</p>
                                ) : (
                                  <table className="w-full text-xs">
                                    <thead>
                                      <tr className="text-[var(--text-muted)]">
                                        <th className="text-left py-1 pr-4 font-medium">Grader</th>
                                        <th className="text-center px-2 font-medium" title="Time commitments concern">R0</th>
                                        <th className="text-center px-2 font-medium" title="Resume thoughtfulness">R1</th>
                                        <th className="text-center px-2 font-medium" title="Technical depth">R2</th>
                                        <th className="text-center px-2 font-medium" title="Passion (resume)">R3</th>
                                        <th className="text-center px-2 font-medium" title="Passion for club">R4</th>
                                        <th className="text-center px-2 font-medium" title="Club knowledge">R5</th>
                                        <th className="text-center px-2 font-medium" title="Creativity">R6</th>
                                        <th className="text-center px-2 font-medium" title="Eagerness to learn">R7</th>
                                        <th className="text-center px-2 font-medium" title="Leadership">R8</th>
                                        <th className="text-center px-2 font-medium" title="Commitment to community">R9</th>
                                      </tr>
                                    </thead>
                                    <tbody className="divide-y divide-[var(--border)]">
                                      {a.reviews.map(r => (
                                        <tr key={r.grader_email} className="text-[var(--text-secondary)]">
                                          <td className="py-1.5 pr-4">{r.grader_email}</td>
                                          {([r.r0, r.r1, r.r2, r.r3, r.r4, r.r5, r.r6, r.r7, r.r8, r.r9] as number[]).map((v, i) => (
                                            <td key={i} className="text-center px-2 font-mono">{v}</td>
                                          ))}
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                )}
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </div>

      {reassignTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          role="presentation"
          onMouseDown={event => {
            if (event.target === event.currentTarget) closeReassignment()
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="reassignment-title"
            className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-6 shadow-2xl"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id="reassignment-title" className="text-lg font-semibold text-[var(--text-primary)]">
                  Assign more to {reassignTarget.email}
                </h2>
                <p className="mt-1 text-sm text-[var(--text-muted)]">
                  Automatic suggestions stay in the same reviewer pool. Leadership/admin graders can also manually take pending work from regular graders. Every applicant keeps exactly two reviewers.
                </p>
              </div>
              <button
                type="button"
                onClick={closeReassignment}
                disabled={reassignLoading}
                aria-label="Close"
                className="text-xl text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-40"
              >
                ×
              </button>
            </div>

            {!reassignPreview ? (
              <div className="mt-5 space-y-4">
                <label className="block text-sm text-[var(--text-secondary)]">
                  Applications to transfer
                  <input
                    type="number"
                    min={1}
                    max={Math.min(20, reassignTarget.transferable_count)}
                    value={reassignCount}
                    onChange={event => {
                      setReassignCount(Number(event.target.value))
                      setReassignError('')
                    }}
                    className="mt-1 block w-28 rounded-lg border border-[var(--border)] bg-[var(--bg-raised)] px-3 py-2 text-[var(--text-primary)] focus:border-[#FF6B35] focus:outline-none"
                  />
                </label>
                <p className="text-xs text-[var(--text-muted)]">
                  {reassignTarget.transferable_count} eligible pending assignment{reassignTarget.transferable_count === 1 ? '' : 's'} available.
                </p>
                {reassignError && <p className="text-sm text-red-500">{reassignError}</p>}
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={closeReassignment}
                    disabled={reassignLoading}
                    className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-raised)] disabled:opacity-40"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={previewReassignment}
                    disabled={
                      reassignLoading
                      || !Number.isInteger(reassignCount)
                      || reassignCount < 1
                      || reassignCount > 20
                      || reassignCount > reassignTarget.transferable_count
                    }
                    className="rounded-lg bg-[#FF6B35] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {reassignLoading ? 'Preparing…' : 'Preview transfers'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-5 space-y-4">
                <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-raised)] p-4">
                  <h3 className="text-sm font-medium text-[var(--text-primary)]">Adjust this proposal</h3>
                  <p className="mt-1 text-xs text-[var(--text-muted)]">
                    Keep automatic selection, or take pending applications from one specific grader instead.
                  </p>
                  <div className="mt-3 flex flex-wrap items-end gap-3">
                    <label className="min-w-64 flex-1 text-sm text-[var(--text-secondary)]">
                      Take applications from
                      <select
                        value={reassignSourceEmail}
                        onChange={event => {
                          const nextSource = event.target.value
                          const available = nextSource
                            ? reassignPreview.eligible_sources.find(source => source.email === nextSource)?.available ?? 0
                            : reassignPreview.total_available
                          setReassignSourceEmail(nextSource)
                          setReassignCount(current => Math.min(current, 20, available))
                          setReassignError('')
                        }}
                        className="mt-1 block w-full rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] px-3 py-2 text-[var(--text-primary)] focus:border-[#FF6B35] focus:outline-none"
                      >
                        <option value="">Automatic (recommended)</option>
                        {reassignPreview.eligible_sources.map(source => (
                          <option key={source.email} value={source.email}>
                            {source.email} ({source.pool === 'regular' ? 'regular' : 'leadership'}, {source.available} available)
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="text-sm text-[var(--text-secondary)]">
                      Number to transfer
                      <input
                        type="number"
                        min={1}
                        max={Math.min(20, selectedSourceAvailable)}
                        value={reassignCount}
                        onChange={event => {
                          setReassignCount(Number(event.target.value))
                          setReassignError('')
                        }}
                        className="mt-1 block w-28 rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] px-3 py-2 text-[var(--text-primary)] focus:border-[#FF6B35] focus:outline-none"
                      />
                    </label>
                    <button
                      type="button"
                      onClick={previewReassignment}
                      disabled={
                        reassignLoading
                        || !Number.isInteger(reassignCount)
                        || reassignCount < 1
                        || reassignCount > 20
                        || reassignCount > selectedSourceAvailable
                        || reassignmentPreviewIsCurrent
                      }
                      className="rounded-lg border border-[#FF6B35] px-4 py-2 text-sm font-medium text-[#FF6B35] hover:bg-[#FF6B35]/10 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {reassignLoading ? 'Updating…' : 'Update preview'}
                    </button>
                  </div>
                  <p className="mt-2 text-xs text-[var(--text-muted)]">
                    {selectedSourceAvailable} eligible pending assignment{selectedSourceAvailable === 1 ? '' : 's'} available for this selection.
                  </p>
                  {!reassignmentPreviewIsCurrent && (
                    <p className="mt-2 text-xs font-medium text-amber-600">Update the preview before confirming your changes.</p>
                  )}
                  {reassignSourceEmail
                    && reassignPreview.target_pool === 'leadership'
                    && reassignPreview.eligible_sources.find(source => source.email === reassignSourceEmail)?.pool === 'regular'
                    && (
                      <p className="mt-2 text-xs font-medium text-amber-600">
                        Manual override: these applications will have two leadership/admin reviewers instead of one regular and one leadership reviewer.
                      </p>
                    )}
                </div>

                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3">
                  <p className="font-medium text-[var(--text-primary)]">
                    Transfer {reassignPreview.count} application{reassignPreview.count === 1 ? '' : 's'} to {reassignPreview.target_grader_email}
                  </p>
                  <p className="mt-1 text-xs text-[var(--text-muted)]">
                    Review the source graders and applicants below before confirming.
                  </p>
                  <p className="mt-2 text-xs text-amber-600">
                    The system can detect submitted reviews, but not work currently open in another grader&apos;s browser. Confirm these graders are not actively reviewing the listed applicants.
                  </p>
                </div>

                <div className="space-y-3">
                  {reassignPreview.source_summary.map(source => (
                    <div key={source.email} className="rounded-lg border border-[var(--border)] bg-[var(--bg-raised)] p-4">
                      <p className="text-sm font-medium text-[var(--text-primary)]">
                        {source.applicants.length} from {source.email}
                      </p>
                      <ul className="mt-2 space-y-1 text-sm text-[var(--text-secondary)]">
                        {source.applicants.map(applicant => <li key={applicant.id}>• {applicant.name}</li>)}
                      </ul>
                    </div>
                  ))}
                </div>

                {reassignError && <p className="text-sm text-red-500">{reassignError}</p>}
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setReassignPreview(null)
                      setReassignSourceEmail('')
                      setReassignError('')
                    }}
                    disabled={reassignLoading}
                    className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-raised)] disabled:opacity-40"
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    onClick={commitReassignment}
                    disabled={reassignLoading || !reassignmentPreviewIsCurrent}
                    className="rounded-lg bg-[#FF6B35] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {reassignLoading ? 'Transferring…' : `Confirm ${reassignPreview.count} transfers`}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  )
}
