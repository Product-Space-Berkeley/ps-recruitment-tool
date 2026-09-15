'use client'

import { useEffect, useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { getCurrentUser, CurrentUser } from '@/lib/auth'
import { Applicant, EssayPrompt, Round } from '@/lib/types'

// r-keys tied to each essay question (index 0→Q1, 1→Q2, 2→Q3)
const ESSAY_RATING_KEYS = [
  { commentKey: 'comment1', rKeys: ['r4', 'r5'] },
  { commentKey: 'comment2', rKeys: ['r8', 'r9'] },
  { commentKey: 'comment3', rKeys: ['r6', 'r7'] },
] as const

type RKey = 'r0' | 'r1' | 'r2' | 'r3' | 'r4' | 'r5' | 'r6' | 'r7' | 'r8' | 'r9'
type CKey = 'comment0' | 'comment1' | 'comment2' | 'comment3' | 'comment4'

interface ApplicantFull extends Applicant {
  essays: { prompt: EssayPrompt; response: string }[]
  resumeBase64: string | null
  resumeLoaded: boolean
}

interface RoundSummary {
  round: Round
  cycleName: string | null
  total: number
  completed: number
}

function defaultRatings(): Record<RKey, string> {
  return { r0: '', r1: '', r2: '', r3: '', r4: '', r5: '', r6: '', r7: '', r8: '', r9: '' }
}

function defaultComments(): Record<CKey, string> {
  return { comment0: '', comment1: '', comment2: '', comment3: '', comment4: '' }
}

export default function GradePage() {
  const router = useRouter()
  const [user, setUser] = useState<CurrentUser | null>(null)
  const [roundSummaries, setRoundSummaries] = useState<RoundSummary[]>([])
  const [selectedRoundId, setSelectedRoundId] = useState<string | null>(null)
  const [queue, setQueue] = useState<ApplicantFull[]>([])
  const [queueIndex, setQueueIndex] = useState(0)
  const [totalAssigned, setTotalAssigned] = useState(0)
  const [completedCount, setCompletedCount] = useState(0)
  const [ratings, setRatings] = useState<Record<RKey, string>>(defaultRatings())
  const [comments, setComments] = useState<Record<CKey, string>>(defaultComments())
  const [essayConfirmed, setEssayConfirmed] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [loadingRounds, setLoadingRounds] = useState(true)
  const [loadingQueue, setLoadingQueue] = useState(false)
  const [refreshingAssignments, setRefreshingAssignments] = useState(false)
  const [refreshMessage, setRefreshMessage] = useState('')
  const resumeRef = useRef<HTMLDivElement>(null)

  // Scroll to resume section when essay confirmed
  useEffect(() => {
    if (essayConfirmed) resumeRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [essayConfirmed])

  // Resumes can be several megabytes each. Load only the current applicant's
  // file, and only after the grader finishes the essay section, instead of
  // downloading every pending resume when the queue opens.
  useEffect(() => {
    const current = queue[queueIndex]
    if (!essayConfirmed || !current || current.resumeLoaded) return

    let cancelled = false
    fetch(`/api/applicants/${current.id}/resume`, { cache: 'no-store' })
      .then(response => response.ok ? response.json() : { resume_base64: null })
      .then(data => {
        if (cancelled) return
        setQueue(previous => previous.map((item, index) => index === queueIndex
          ? { ...item, resumeBase64: data.resume_base64 ?? null, resumeLoaded: true }
          : item))
      })

    return () => { cancelled = true }
  }, [essayConfirmed, queue, queueIndex])

  async function loadRoundSummaries(graderEmail: string): Promise<string | null> {
    setLoadingRounds(true)

    // All assignments for this grader
    const assignments: { round_id: string; applicant_id: string }[] = await fetch(
      `/api/grader-assignments?grader_email=${encodeURIComponent(graderEmail)}`
    ).then(r => r.json())

    if (!assignments?.length) {
      setRoundSummaries([])
      setLoadingRounds(false)
      return null
    }

    // All reviews already submitted by this grader
    const reviews: { round_id: string; applicant_id: string }[] = await fetch(
      `/api/reviews?grader_email=${encodeURIComponent(graderEmail)}`
    ).then(r => r.json())

    const reviewedSet = new Set(
      (reviews ?? []).map(r => `${r.round_id}::${r.applicant_id}`)
    )

    // Group by round
    const roundMap = new Map<string, { total: number; completed: number }>()
    for (const a of assignments) {
      if (!roundMap.has(a.round_id)) roundMap.set(a.round_id, { total: 0, completed: 0 })
      const entry = roundMap.get(a.round_id)!
      entry.total++
      if (reviewedSet.has(`${a.round_id}::${a.applicant_id}`)) entry.completed++
    }

    // Load round details individually
    const roundIds = [...roundMap.keys()]
    const roundResults = await Promise.all(
      roundIds.map(id => fetch(`/api/rounds/${id}`).then(r => r.ok ? r.json() : null))
    )
    const rounds = (roundResults.filter(Boolean) as Round[])
      .filter(round => round.status === 'grading')
      .sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0))

    // Fetch the cycle name for each unique cycle_id touched by these rounds
    const cycleIds = [...new Set(rounds.map(r => r.cycle_id).filter(Boolean))]
    const cycleResults = await Promise.all(
      cycleIds.map(id => fetch(`/api/cycles/${id}`).then(r => r.ok ? r.json() : null))
    )
    const cycleNameById = new Map<string, string>()
    for (const c of cycleResults) if (c?.id && c?.name) cycleNameById.set(c.id, c.name)

    const summaries: RoundSummary[] = rounds.map(r => ({
      round: r,
      cycleName: cycleNameById.get(r.cycle_id) ?? null,
      total: roundMap.get(r.id)!.total,
      completed: roundMap.get(r.id)!.completed,
    }))

    setRoundSummaries(summaries)

    // Closed and deliberating rounds stay out of the grading queue. Auto-select
    // only an active grading round when it is the sole pending one.
    const pending = summaries.filter(s => s.completed < s.total)
    const solePendingRoundId = pending.length === 1 ? pending[0].round.id : null
    setSelectedRoundId(solePendingRoundId)

    setLoadingRounds(false)
    return solePendingRoundId
  }

  async function loadQueue(roundId: string, graderEmail: string): Promise<number> {
    setLoadingQueue(true)
    setQueueIndex(0)
    setEssayConfirmed(false)
    setRatings(defaultRatings())
    setComments(defaultComments())

    // Get assigned applicant IDs for this round
    const assignments: { applicant_id: string }[] = await fetch(
      `/api/grader-assignments?round_id=${roundId}&grader_email=${encodeURIComponent(graderEmail)}`
    ).then(r => r.json())

    const assignedIds = (assignments ?? []).map(a => a.applicant_id)
    setTotalAssigned(assignedIds.length)

    // Get already-reviewed applicant IDs
    const reviews: { applicant_id: string }[] = await fetch(
      `/api/reviews?round_id=${roundId}&grader_email=${encodeURIComponent(graderEmail)}`
    ).then(r => r.json())

    const reviewedIds = new Set((reviews ?? []).map(r => r.applicant_id))
    setCompletedCount(reviewedIds.size)

    const pendingIds = assignedIds.filter(id => !reviewedIds.has(id))

    if (pendingIds.length === 0) {
      setQueue([])
      setLoadingQueue(false)
      return 0
    }

    // Load the relatively small essay payloads for the queue. Resume files are
    // deliberately fetched one at a time after essay confirmation.
    const fullQueue: ApplicantFull[] = await Promise.all(
      pendingIds.map(async (applicantId) => {
        const essayData = await fetch(`/api/applicants/${applicantId}/essays`, { cache: 'no-store' })
          .then(r => r.ok ? r.json() : null)

        // essayData shape: { applicant: Applicant, essays: { prompt: EssayPrompt, response: string }[] }
        const applicant: Applicant = essayData?.applicant ?? { id: applicantId }
        const essays: { prompt: EssayPrompt; response: string }[] = essayData?.essays ?? []
        return { ...applicant, essays, resumeBase64: null, resumeLoaded: false }
      })
    )

    setQueue(fullQueue)
    setLoadingQueue(false)
    return fullQueue.length
  }

  // Resolve auth and then load the initial queue from the asynchronous auth
  // callback. Round changes after this point are explicit user actions.
  useEffect(() => {
    let cancelled = false
    getCurrentUser().then(async currentUser => {
      if (cancelled) return
      if (!currentUser) { router.replace('/'); return }
      setUser(currentUser)
      const solePendingRoundId = await loadRoundSummaries(currentUser.email)
      if (!cancelled && solePendingRoundId) {
        await loadQueue(solePendingRoundId, currentUser.email)
      }
    })
    return () => { cancelled = true }
  }, [router])

  function setRating(key: RKey, value: string) {
    setRatings(prev => ({ ...prev, [key]: value }))
  }

  function setComment(key: CKey, value: string) {
    setComments(prev => ({ ...prev, [key]: value }))
  }

  async function checkForNewAssignments() {
    if (!user || !selectedRoundId) return
    setRefreshingAssignments(true)
    setRefreshMessage('')
    try {
      const pendingCount = await loadQueue(selectedRoundId, user.email)
      if (pendingCount === 0) {
        setRefreshMessage('No new assignments yet.')
      }
    } catch {
      setLoadingQueue(false)
      setRefreshMessage('Unable to check for new assignments. Please try again.')
    } finally {
      setRefreshingAssignments(false)
    }
  }

  async function handleSubmit() {
    if (!user || !selectedRoundId) return
    const applicant = queue[queueIndex]
    if (!applicant) return

    setSubmitting(true)
    const res = await fetch('/api/reviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        round_id: selectedRoundId,
        applicant_id: applicant.id,
        grader_email: user.email,
        r0: Number(ratings.r0),
        r1: Number(ratings.r1),
        r2: Number(ratings.r2),
        r3: Number(ratings.r3),
        r4: Number(ratings.r4),
        r5: Number(ratings.r5),
        r6: Number(ratings.r6),
        r7: Number(ratings.r7),
        r8: Number(ratings.r8),
        r9: Number(ratings.r9),
        comment0: comments.comment0 || null,
        comment1: comments.comment1 || null,
        comment2: comments.comment2 || null,
        comment3: comments.comment3 || null,
        comment4: comments.comment4 || null,
      }),
    })

    setSubmitting(false)
    if (!res.ok) {
      const err = await res.json()
      alert('Submission failed: ' + (err.error ?? res.statusText))
      return
    }

    setCompletedCount(c => c + 1)
    setEssayConfirmed(false)
    setRatings(defaultRatings())
    setComments(defaultComments())
    window.scrollTo(0, 0)

    if (queueIndex + 1 >= queue.length) {
      setQueue([])
    } else {
      setQueueIndex(i => i + 1)
    }
  }

  const applicant = queue[queueIndex] ?? null
  const progress = totalAssigned > 0 ? Math.round((completedCount / totalAssigned) * 100) : 0

  // ─── Render states ───────────────────────────────────────────

  if (!user) return null

  // Round selection screen
  if (!selectedRoundId) {
    return (
      <main className="min-h-screen bg-[var(--bg-base)] p-8">
        <div className="max-w-2xl mx-auto">
          <div className="flex items-center justify-between mb-8">
            <h1 className="text-2xl font-bold text-[var(--text-primary)]">Grading Queue</h1>
            <button
              className="text-sm text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
              onClick={() => router.push('/dashboard')}
            >
              ← Dashboard
            </button>
          </div>

          {loadingRounds ? (
            <p className="text-[var(--text-muted)]">Loading your assignments…</p>
          ) : roundSummaries.length === 0 ? (
            <div className="bg-[var(--bg-surface)] border border-[var(--border)] rounded-xl p-8 text-center">
              <p className="text-[var(--text-muted)]">You have no applicants assigned yet.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {roundSummaries.map(({ round, cycleName, total, completed }) => {
                const pending = total - completed
                const isInterview = round.grading_type === 'interview'
                return (
                  <div key={round.id} className="space-y-2">
                    {isInterview && round.interview_form_url ? (
                      <div className="bg-[var(--bg-surface)] border border-[#ff8a00]/40 rounded-xl p-5 space-y-3">
                        <div className="flex items-center justify-between">
                          <div>
                            {cycleName && <p className="text-xs text-[var(--text-muted)] uppercase tracking-wider">{cycleName}</p>}
                            <p className="font-semibold text-[var(--text-primary)]">{round.name}</p>
                            <p className="text-sm text-[var(--text-muted)] mt-0.5">Interview round — fill out the form below while interviewing</p>
                          </div>
                          <span className="text-xs px-2 py-0.5 rounded-full border bg-[#ff8a00]/15 text-[#ff8a00] border-[#ff8a00]/30 font-medium">interview</span>
                        </div>
                        <a
                          href={round.interview_form_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center justify-center gap-2 w-full py-3 rounded-lg bg-[#ff8a00] text-white font-semibold hover:opacity-90 transition-opacity"
                        >
                          Open Interview Form ↗
                        </a>
                      </div>
                    ) : (
                      <button
                        onClick={() => {
                          setSelectedRoundId(round.id)
                          void loadQueue(round.id, user.email)
                        }}
                        disabled={pending === 0}
                        className="w-full text-left bg-[var(--bg-surface)] border border-[var(--border)] rounded-xl p-5 hover:bg-[var(--bg-raised)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            {cycleName && <p className="text-xs text-[var(--text-muted)] uppercase tracking-wider">{cycleName}</p>}
                            <p className="font-semibold text-[var(--text-primary)]">{round.name}</p>
                            <p className="text-sm text-[var(--text-muted)] mt-0.5">
                              {pending > 0 ? `${pending} applicant${pending !== 1 ? 's' : ''} remaining` : 'All done!'}
                            </p>
                          </div>
                          <div className="text-right">
                            <p className="text-2xl font-bold text-[#ff8a00]">{completed}/{total}</p>
                            <p className="text-xs text-[var(--text-muted)]">completed</p>
                          </div>
                        </div>
                        {total > 0 && (
                          <div className="mt-3 h-1.5 bg-[var(--border)] rounded-full overflow-hidden">
                            <div
                              className="h-full bg-[#ff8a00] rounded-full transition-all"
                              style={{ width: `${Math.round((completed / total) * 100)}%` }}
                            />
                          </div>
                        )}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </main>
    )
  }

  // Loading queue
  if (loadingQueue) {
    return (
      <main className="min-h-screen bg-[var(--bg-base)] flex items-center justify-center">
        <p className="text-[var(--text-muted)]">Loading applicants…</p>
      </main>
    )
  }

  // All done for this round
  if (!applicant) {
    return (
      <main className="min-h-screen bg-[var(--bg-base)] flex items-center justify-center">
        <div className="text-center space-y-4">
          <p className="text-3xl font-bold text-[var(--text-primary)]">All done!</p>
          <p className="text-[var(--text-muted)]">You have reviewed all {totalAssigned} assigned applicants for this round.</p>
          {refreshMessage && <p className="text-sm text-[var(--text-muted)]">{refreshMessage}</p>}
          <div className="flex flex-wrap justify-center gap-2 pt-2">
            <button
              className="px-4 py-2 rounded-lg bg-[#ff8a00] text-white font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
              onClick={checkForNewAssignments}
              disabled={refreshingAssignments}
            >
              {refreshingAssignments ? 'Checking…' : 'Check for new assignments'}
            </button>
            <button
              className="px-4 py-2 rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] text-[var(--text-secondary)] font-medium hover:bg-[var(--bg-raised)] transition-colors"
              onClick={() => { setSelectedRoundId(null); void loadRoundSummaries(user.email) }}
            >
              Back to Rounds
            </button>
          </div>
        </div>
      </main>
    )
  }

  // ─── Grading form ─────────────────────────────────────────────

  return (
    <main className="min-h-screen bg-[var(--bg-base)] py-8 px-4">
      <div className="max-w-3xl mx-auto">

        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-bold text-[var(--text-primary)]">PlexTech Grader Portal</h1>
          <button
            className="text-sm text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
            onClick={() => router.push('/dashboard')}
          >
            ← Dashboard
          </button>
        </div>

        {/* Progress bar */}
        <div className="mb-6">
          <div className="flex items-center justify-between mb-1">
            <p className="text-sm text-[var(--text-muted)]">Reviews completed: {completedCount} / {totalAssigned}</p>
            <p className="text-sm text-[var(--text-muted)]">{progress}%</p>
          </div>
          <div className="h-2 bg-[var(--border)] rounded-full overflow-hidden">
            <div
              className="h-full bg-[#ff8a00] rounded-full transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="text-xs text-[var(--text-muted)] mt-1">
            For each applicant, refer to the rubric for assigning ratings and leave concise comments for every response.
          </p>
          <p className="text-xs font-medium text-[#ec6f34] mt-1">
            Rating scale: 1 is the lowest rating and 4 is the highest rating.
          </p>
        </div>

        <div className="space-y-5">

          {/* Applicant metadata */}
          <div className="bg-[var(--bg-surface)] border border-[var(--border)] rounded-xl p-5 space-y-3">
            <Field label="Year" value={`${applicant.year ?? 'N/A'}${applicant.transfer ? ' (Transfer)' : ''}`} />
            <Field label="Major" value={applicant.major ?? 'N/A'} />
            <Field label="Desired Role" value={applicant.desired_roles ?? 'Not specified'} />
            <Field
              label="Attended Infosession?"
              value={applicant.infosessions_attended?.length
                ? `Yes — ${applicant.infosessions_attended.join(', ')}`
                : 'No'}
            />
            {essayConfirmed && (
              <>
                {applicant.linkedin && <Field label="LinkedIn" value={applicant.linkedin} />}
                {applicant.website && <Field label="Personal Website" value={applicant.website} />}
              </>
            )}
          </div>

          {/* Essay stage */}
          {!essayConfirmed && (
            <>
              {applicant.essays.slice(0, 3).map((e, i) => {
                const keys = ESSAY_RATING_KEYS[i]
                if (!keys) return null
                const criteria = [e.prompt.criterion1, e.prompt.criterion2]
                return (
                  <Section key={e.prompt.id} label={`Question ${i + 1}`}>
                    <p className="text-sm font-medium text-[#ff8a00] mb-1">{e.prompt.prompt}</p>
                    <div className="bg-[var(--bg-raised)] rounded-lg p-3 mb-4 text-sm text-[var(--text-secondary)] whitespace-pre-wrap">
                      {e.response || <span className="text-[var(--text-muted)] italic">No response</span>}
                    </div>
                    <CommentField
                      label="Comment"
                      value={comments[keys.commentKey as CKey]}
                      onChange={v => setComment(keys.commentKey as CKey, v)}
                    />
                    {keys.rKeys.map((rKey, ci) => (
                      <RatingSelect
                        key={rKey}
                        question={criteria[ci] ?? `Criterion ${ci + 1}`}
                        value={ratings[rKey as RKey]}
                        onChange={v => setRating(rKey as RKey, v)}
                        options={[1, 2, 3, 4]}
                      />
                    ))}
                  </Section>
                )
              })}

              {/* Time commitments */}
              <Section label="Time Commitments">
                <div className="bg-[var(--bg-raised)] rounded-lg p-3 mb-4 text-sm text-[var(--text-secondary)] whitespace-pre-wrap">
                  {applicant.time_commitment || <span className="text-[var(--text-muted)] italic">None provided</span>}
                </div>
                <CommentField
                  label="Comment"
                  value={comments.comment4}
                  onChange={v => setComment('comment4', v)}
                />
                <RatingSelect
                  question="Do the applicant's time commitments seem concerning (WAY too many clubs, insane unit count, etc.)?"
                  value={ratings.r0}
                  onChange={v => setRating('r0', v)}
                  options={[
                    { value: '3', label: 'Not at all' },
                    { value: '2', label: 'Could be a problem' },
                    { value: '1', label: 'RED FLAG' },
                  ]}
                />
              </Section>

              {/* Confirm essay reviews */}
              {(() => {
                const activeEssayKeys = ESSAY_RATING_KEYS.slice(0, applicant.essays.slice(0, 3).length)
                const emptyComments = activeEssayKeys.map((r, i) => ({
                  label: `Question ${i + 1}`,
                  empty: !comments[r.commentKey as CKey].trim(),
                })).concat([{ label: 'Time Commitments', empty: !comments.comment4.trim() }]).filter(c => c.empty)
                const essayRatingKeys: RKey[] = [...activeEssayKeys.flatMap(k => [...k.rKeys] as RKey[]), 'r0']
                const emptyRatings = essayRatingKeys.filter(k => !ratings[k])
                const canConfirm = emptyComments.length === 0 && emptyRatings.length === 0
                return (
                  <div className="bg-[var(--bg-surface)] border border-[var(--border)] rounded-xl p-5">
                    <p className="text-sm text-[var(--text-muted)] mb-3">
                      Please confirm your essay reviews before moving on. You cannot edit your current responses beyond this point.
                    </p>
                    {emptyComments.length > 0 && (
                      <p className="text-xs text-amber-500 mb-2">
                        Missing comments for: {emptyComments.map(c => c.label).join(', ')}
                      </p>
                    )}
                    {emptyRatings.length > 0 && (
                      <p className="text-xs text-amber-500 mb-3">
                        Please select a rating for all questions
                      </p>
                    )}
                    <button
                      className="px-4 py-2 rounded-lg bg-[var(--bg-raised)] border border-[var(--border)] text-[var(--text-primary)] font-medium hover:bg-[var(--bg-active)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      onClick={() => setEssayConfirmed(true)}
                      disabled={!canConfirm}
                    >
                      Confirm Essay Reviews →
                    </button>
                  </div>
                )
              })()}
            </>
          )}

          {/* Resume stage */}
          <div ref={resumeRef} />
          {essayConfirmed && (
            <>
              <Section label="Resume / CV">
                {!applicant.resumeLoaded ? (
                  <p className="text-sm text-[var(--text-muted)] italic">Loading resume...</p>
                ) : applicant.resumeBase64 ? (
                  <iframe
                    src={`data:application/pdf;base64,${applicant.resumeBase64}`}
                    className="w-full rounded-lg border border-[var(--border)]"
                    style={{ height: '70vh' }}
                    title={`${applicant.first_name ?? ''} ${applicant.last_name ?? ''} resume`}
                  />
                ) : (
                  <p className="text-sm text-[var(--text-muted)] italic">No resume uploaded.</p>
                )}
                <div className="mt-4 space-y-4">
                  <CommentField
                    label="Comment"
                    value={comments.comment0}
                    onChange={v => setComment('comment0', v)}
                  />
                  <RatingSelect
                    question="How thoughtful and expressive are the explanations in their resume?"
                    value={ratings.r1}
                    onChange={v => setRating('r1', v)}
                    options={[1, 2, 3, 4]}
                  />
                  <RatingSelect
                    question="What is the technical depth demonstrated in the resume?"
                    value={ratings.r2}
                    onChange={v => setRating('r2', v)}
                    options={[1, 2, 3, 4]}
                  />
                  <RatingSelect
                    question="To what degree is the applicant's passion for learning and building shown in their resume?"
                    value={ratings.r3}
                    onChange={v => setRating('r3', v)}
                    options={[1, 2, 3, 4]}
                  />
                </div>
              </Section>

              {(() => {
                const resumeRatingKeys: RKey[] = ['r1', 'r2', 'r3']
                const missingResumeRatings = resumeRatingKeys.some(k => !ratings[k])
                const missingResumeComment = !comments.comment0.trim()
                const canSubmit = !missingResumeComment && !missingResumeRatings
                return (
                  <div className="pb-12 space-y-2">
                    {missingResumeComment && (
                      <p className="text-xs text-amber-500">Missing comment for Resume / CV</p>
                    )}
                    {missingResumeRatings && (
                      <p className="text-xs text-amber-500">Please select a rating for all resume questions</p>
                    )}
                    <button
                      className="w-full py-3 rounded-lg bg-[#ff8a00] text-white font-semibold hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
                      onClick={handleSubmit}
                      disabled={submitting || !canSubmit}
                    >
                      {submitting ? 'Submitting…' : 'Submit Review'}
                    </button>
                  </div>
                )
              })()}
            </>
          )}
        </div>
      </div>
    </main>
  )
}

// ─── Small reusable sub-components ───────────────────────────────

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-4 items-start">
      <span className="text-sm text-[var(--text-muted)] w-36 shrink-0">{label}</span>
      <span className="text-sm text-[var(--text-secondary)]">{value}</span>
    </div>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-[var(--bg-surface)] border border-[var(--border)] rounded-xl p-5 space-y-4">
      <h3 className="font-semibold text-[#ff8a00]">{label}</h3>
      {children}
    </div>
  )
}

function CommentField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1">
      <label className="text-xs text-[var(--text-muted)]">{label}</label>
      <textarea
        className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-raised)] text-[var(--text-secondary)] text-sm p-2 resize-y focus:outline-none focus:border-[#ff8a00] transition-colors"
        rows={3}
        value={value}
        onChange={e => onChange(e.target.value)}
      />
    </div>
  )
}

type RatingOption = number | { value: string; label: string }

const DEFAULT_RATING_DESCRIPTIONS: Record<number, string> = {
  1: 'Not demonstrated in the response',
  2: 'Some evidence, but vague or underdeveloped',
  3: 'Clearly demonstrated with specific evidence',
  4: 'Exceptional depth, specificity, and insight',
}

function getRatingDescriptions(question: string): Record<number, string> {
  const normalized = question.toLowerCase()

  if (normalized.includes('informed understanding of plextech')) {
    return {
      1: 'No meaningful research; generic or copied website language',
      2: 'Mentions PlexTech details, but understanding is surface-level',
      3: 'Shows clear research using specific, accurate PlexTech details',
      4: 'Shows deep research through projects, events, or member conversations',
    }
  }

  if (normalized.includes('connect plextech to their goals')) {
    return {
      1: 'Does not connect PlexTech to personal goals or contributions',
      2: 'Makes a broad connection with little personal detail',
      3: 'Clearly connects PlexTech to specific goals and contributions',
      4: 'Presents a compelling, highly personal two-way fit with PlexTech',
    }
  }

  if (normalized.includes('contribution to their community')) {
    return {
      1: 'Provides no concrete contribution or meaningful action',
      2: 'Describes limited or one-time involvement with little impact',
      3: 'Shows meaningful, sustained contribution with specific examples',
      4: 'Shows exceptional ownership and lasting, measurable community impact',
    }
  }

  if (normalized.includes('why the community matters')) {
    return {
      1: 'Offers no reflection on the community or their role',
      2: 'Gives a surface-level explanation with limited personal insight',
      3: 'Thoughtfully explains the community, their role, and their growth',
      4: 'Shows deep self-awareness and insight into their mutual impact',
    }
  }

  if (normalized.includes('decal concept')) {
    return {
      1: 'Generic idea with little thought or development',
      2: 'Reasonable idea, but details or originality are limited',
      3: 'Original, coherent concept supported by thoughtful details',
      4: 'Distinctive, exceptionally developed concept that would engage students',
    }
  }

  if (normalized.includes('genuine interests, curiosity, and personality')) {
    return {
      1: 'Generic response that reveals little about the applicant',
      2: 'Shows some interest, but the personal connection is limited',
      3: 'Clearly reveals genuine curiosity and personality through specifics',
      4: 'Feels memorable and authentic with a distinctive personal voice',
    }
  }

  if (normalized.includes('thoughtful and expressive')) {
    return {
      1: 'Bullets are vague, unclear, or mostly list responsibilities',
      2: 'Some useful explanation, but impact and context are inconsistent',
      3: 'Clear, thoughtful bullets that explain actions and impact',
      4: 'Exceptionally precise and compelling explanations throughout',
    }
  }

  if (normalized.includes('technical depth')) {
    return {
      1: 'Shows little evidence of technical experience or understanding',
      2: 'Shows basic technical exposure with limited depth',
      3: 'Shows solid technical depth through specific work and decisions',
      4: 'Shows exceptional depth, ownership, and technical sophistication',
    }
  }

  if (normalized.includes('passion for learning and building')) {
    return {
      1: 'Shows little evidence of curiosity, learning, or building',
      2: 'Shows some interest, but initiative or follow-through is limited',
      3: 'Shows clear initiative and sustained passion through specific work',
      4: 'Shows exceptional curiosity, self-direction, and drive to build',
    }
  }

  return DEFAULT_RATING_DESCRIPTIONS
}

function RatingSelect({
  question, value, onChange, options,
}: {
  question: string
  value: string
  onChange: (v: string) => void
  options: RatingOption[]
}) {
  const isNumericScale = options.every(opt => typeof opt === 'number')

  if (isNumericScale) {
    const descriptions = getRatingDescriptions(question)

    return (
      <fieldset className="space-y-2">
        <legend className="text-xs text-[var(--text-secondary)]">{question}</legend>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {options.map(opt => {
            const rating = opt as number
            const ratingValue = String(rating)
            const selected = value === ratingValue

            return (
              <button
                key={ratingValue}
                type="button"
                aria-pressed={selected}
                onClick={() => onChange(ratingValue)}
                className={`min-h-24 rounded-lg border p-3 text-center transition-colors ${selected
                  ? 'border-[#ff8a00] bg-[#ff8a00] text-white'
                  : 'border-[var(--border)] bg-[var(--bg-raised)] text-[var(--text-secondary)] hover:border-[#ff8a00]'
                }`}
              >
                <span className="block text-xl font-bold">{rating}</span>
                <span className="mt-1 block text-xs leading-snug">{descriptions[rating]}</span>
              </button>
            )
          })}
        </div>
      </fieldset>
    )
  }

  return (
    <div className="space-y-1">
      <label className="text-xs text-[var(--text-secondary)]">{question}</label>
      <select
        className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-raised)] text-[var(--text-secondary)] text-sm p-2 focus:outline-none focus:border-[#ff8a00] transition-colors"
        value={value}
        onChange={e => onChange(e.target.value)}
      >
        <option value="" disabled>Select an option</option>
        {options.map(opt => {
          const v = typeof opt === 'number' ? String(opt) : opt.value
          const l = typeof opt === 'number' ? String(opt) : opt.label
          return <option key={v} value={v}>{l}</option>
        })}
      </select>
    </div>
  )
}
