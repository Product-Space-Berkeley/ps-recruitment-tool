'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { getCurrentUser, canAccessAdmin, CurrentUser } from '@/lib/auth'
import { RecruitmentCycle, EssayPrompt, Applicant } from '@/lib/types'
import { MAX_PROMPTS, MAX_WORD_LIMIT, MIN_PROMPTS } from '@/lib/applicationFields'
import ApplicationWordingEditor from '@/components/ApplicationWordingEditor'
import DeleteCycle from '@/components/DeleteCycle'
import RecruitmentNav from '@/components/RecruitmentNav'

// ─── tiny shared UI ──────────────────────────────────────────
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-[var(--bg-surface)] border border-[var(--border)] rounded-xl p-5 space-y-4">
      <h2 className="font-semibold text-[var(--text-primary)]">{title}</h2>
      {children}
    </div>
  )
}

function Badge({ label, color }: { label: string; color: string }) {
  return <span className={`text-xs px-2 py-0.5 rounded-full font-medium border ${color}`}>{label}</span>
}

function formatDeadlineInput(deadline: string | null | undefined) {
  if (!deadline) return ''
  const date = new Date(deadline)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// ─── main page ───────────────────────────────────────────────
export default function AdminPage() {
  const router = useRouter()
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null)
  const [loading, setLoading] = useState(true)

  // Cycles
  const [cycles, setCycles] = useState<RecruitmentCycle[]>([])
  const [selectedCycle, setSelectedCycle] = useState<RecruitmentCycle | null>(null)
  const [newCycleName, setNewCycleName] = useState('')
  const [cycleError, setCycleError] = useState('')
  const [cycleLoading, setCycleLoading] = useState(false)

  // Essay prompts
  const [prompts, setPrompts] = useState<EssayPrompt[]>([blankPrompt('', 1)])
  const [promptSaving, setPromptSaving] = useState(false)
  const [promptMessage, setPromptMessage] = useState('')

  // Analytics
  const [analytics, setAnalytics] = useState<Record<string, number> | null>(null)

  // Deadline
  const [deadlineInput, setDeadlineInput] = useState<string>('')
  const [deadlineSaving, setDeadlineSaving] = useState(false)
  const selectCycle = useCallback((cycle: RecruitmentCycle | null) => {
    setSelectedCycle(cycle)
    setDeadlineInput(formatDeadlineInput(cycle?.application_deadline))
    setPromptMessage('')
  }, [])

  // ── auth ─────────────────────────────────────────────────
  useEffect(() => {
    getCurrentUser().then(user => {
      if (!user) { router.replace('/'); return }
      if (!canAccessAdmin(user.role)) { router.replace('/dashboard'); return }
      setCurrentUser(user)
      setLoading(false)
    })
  }, [router])

  // ── cycles ───────────────────────────────────────────────
  const loadCycles = useCallback(async () => {
    const data: RecruitmentCycle[] = await fetch('/api/cycles').then(r => r.json())
    setCycles(data ?? [])
  }, [])

  // Restore previously selected cycle from sessionStorage once cycles load.
  // Gate the persist effect on this ref so the initial null state doesn't
  // wipe the saved id before we get a chance to read it.
  const cycleRestoredRef = useRef(false)
  useEffect(() => {
    if (loading) return
    let cancelled = false

    async function initializeCycles() {
      const data: RecruitmentCycle[] = await fetch('/api/cycles').then(r => r.json())
      if (cancelled) return
      setCycles(data ?? [])
      if (cycleRestoredRef.current) return

      cycleRestoredRef.current = true
      const savedId = sessionStorage.getItem('admin:selectedCycleId')
      const match = savedId ? data.find(cycle => cycle.id === savedId) : null
      if (match) selectCycle(match)
    }

    void initializeCycles()
    return () => { cancelled = true }
  }, [loading, selectCycle])

  useEffect(() => {
    if (!cycleRestoredRef.current) return
    if (selectedCycle) sessionStorage.setItem('admin:selectedCycleId', selectedCycle.id)
    else sessionStorage.removeItem('admin:selectedCycleId')
  }, [selectedCycle])

  async function createCycle() {
    setCycleError('')
    const name = newCycleName.trim()
    if (!name) { setCycleError('Enter a cycle name.'); return }
    setCycleLoading(true)
    const res = await fetch('/api/cycles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, status: 'active', accepting_applications: false }),
    })
    if (!res.ok) {
      const err = await res.json()
      setCycleError(err.error ?? 'Failed to create cycle.')
      setCycleLoading(false)
      return
    }
    const data: RecruitmentCycle = await res.json()
    setNewCycleName('')
    await loadCycles()
    selectCycle(data)
    setCycleLoading(false)
  }

  async function toggleAccepting(cycle: RecruitmentCycle) {
    const updated = { ...cycle, accepting_applications: !cycle.accepting_applications }
    const res = await fetch(`/api/cycles/${cycle.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accepting_applications: updated.accepting_applications }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => null)
      alert(`Couldn't ${updated.accepting_applications ? 'open' : 'close'} applications: ${err?.error ?? res.statusText}`)
      return
    }
    setCycles(prev => prev.map(c => c.id === cycle.id ? updated : c))
    if (selectedCycle?.id === cycle.id) setSelectedCycle(updated)
  }

  async function endCycle(cycle: RecruitmentCycle) {
    if (!confirm(`End cycle "${cycle.name}"? This closes applications and marks the cycle as ended.`)) return
    await fetch(`/api/cycles/${cycle.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'ended', accepting_applications: false }),
    })
    await loadCycles()
    if (selectedCycle?.id === cycle.id) selectCycle(null)
  }

  // ── prompts ──────────────────────────────────────────────
  const loadPrompts = useCallback(async (cycleId: string) => {
    const existing: EssayPrompt[] = await fetch(`/api/cycles/${cycleId}/prompts`).then(r => r.json())
    setPrompts(Array.isArray(existing) && existing.length ? existing : [blankPrompt(cycleId, 1)])
  }, [])

  // ── analytics ────────────────────────────────────────────
  const loadAnalytics = useCallback(async (cycleId: string) => {
    const data: Applicant[] = await fetch(`/api/cycles/${cycleId}/applicants`).then(r => r.json())
    if (!data) return
    const counts: Record<string, number> = {
      total: data.length,
      freshman: 0,
      sophomore: 0,
      junior: 0,
      senior: 0,
      transfer: 0,
      previouslyApplied: 0,
    }
    // Legacy applicants stored a graduation year instead of a class-year label
    const legacyYearMap: Record<string, string> = { [String(new Date().getFullYear())]: 'senior', [String(new Date().getFullYear()+1)]: 'junior', [String(new Date().getFullYear()+2)]: 'sophomore', [String(new Date().getFullYear()+3)]: 'freshman' }
    for (const app of data) {
      const raw = app.year ?? ''
      // "Junior (transfer)" and "Junior (non-transfer)" both count as juniors.
      const label = raw.split(' (')[0]
      const yr = ['Freshman', 'Sophomore', 'Junior', 'Senior'].includes(label)
        ? label.toLowerCase()
        : legacyYearMap[raw]
      if (yr) counts[yr]++
      if (app.transfer || raw === 'Junior (transfer)') counts.transfer++
      if (app.previously_applied) counts.previouslyApplied++
    }
    setAnalytics(counts)
  }, [])

  useEffect(() => {
    const cycleId = selectedCycle?.id
    if (!cycleId) return
    let cancelled = false

    async function loadCycleDetails() {
      await Promise.all([
        loadPrompts(cycleId!),
        loadAnalytics(cycleId!),
      ])
      if (cancelled) return
    }

    void loadCycleDetails()
    return () => { cancelled = true }
  }, [selectedCycle, loadPrompts, loadAnalytics])

  async function savePrompts() {
    if (!selectedCycle) return
    setPromptSaving(true)
    setPromptMessage('')
    const res = await fetch(`/api/cycles/${selectedCycle.id}/prompts`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prompts.map((p, i) => ({
        ...(p.id ? { id: p.id } : {}),
        cycle_id: selectedCycle.id,
        question_number: i + 1,
        prompt: p.prompt,
        description: p.description,
        word_limit: p.word_limit,
        criterion1: p.criterion1,
        criterion2: p.criterion2,
      }))),
    })
    setPromptSaving(false)
    if (!res.ok) {
      const err = await res.json().catch(() => null)
      setPromptMessage(`Error: ${err?.error ?? res.statusText}`)
      return
    }
    await loadPrompts(selectedCycle.id)
    setPromptMessage('Saved.')
  }

  // ── deadline ─────────────────────────────────────────────
  const [exportingCsv, setExportingCsv] = useState(false)
  async function exportApplications() {
    if (!selectedCycle) return
    setExportingCsv(true)
    try {
      const res = await fetch(`/api/cycles/${selectedCycle.id}/applicants/export`)
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        alert(`Export failed: ${err?.error ?? res.statusText}`)
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `applications-${selectedCycle.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.csv`
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    } catch {
      alert('Export failed. Please try again.')
    } finally {
      setExportingCsv(false)
    }
  }

  async function saveDeadline() {
    if (!selectedCycle) return
    setDeadlineSaving(true)
    const deadline = deadlineInput ? new Date(deadlineInput).toISOString() : null
    await fetch(`/api/cycles/${selectedCycle.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ application_deadline: deadline }),
    })
    // Update local state directly without going through the selectedCycle useEffect
    const updatedCycle = { ...selectedCycle, application_deadline: deadline }
    setCycles(prev => prev.map(c => c.id === selectedCycle.id ? updatedCycle : c))
    setSelectedCycle(updatedCycle)
    setDeadlineSaving(false)
  }

  if (loading) return (
    <main className="min-h-screen bg-[var(--bg-base)] flex items-center justify-center">
      <div className="text-[var(--text-muted)] text-sm">Loading...</div>
    </main>
  )

  const pct = (n: number) => analytics?.total ? `${((n / analytics.total) * 100).toFixed(1)}%` : '—'

  return (
    <main className="min-h-screen bg-[var(--bg-base)] flex flex-col">
      <RecruitmentNav role={currentUser?.role} />

      <div className="flex-1 flex flex-col md:flex-row gap-0 overflow-hidden">

        {/* Left column — cycles */}
        <div className="w-full md:w-72 shrink-0 border-r border-[var(--border)] bg-[var(--bg-surface)] overflow-y-auto p-4 space-y-4">
          <div>
            <p className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-3">Recruitment Cycles</p>
            <div className="space-y-2">
              {cycles.map(cycle => (
                <button
                  key={cycle.id}
                  onClick={() => selectCycle(cycle)}
                  className={`w-full text-left px-3 py-2.5 rounded-lg border transition-colors ${
                    selectedCycle?.id === cycle.id
                      ? 'bg-[var(--bg-active)] border-[var(--ps-accent)]/40'
                      : 'bg-[var(--bg-raised)] border-[var(--border)] hover:bg-[var(--bg-active)]'
                  }`}
                >
                  <p className="font-medium text-sm text-[var(--text-primary)]">{cycle.name}</p>
                  <div className="flex gap-1.5 mt-1">
                    <Badge label={cycle.status} color={cycle.status === 'active' ? 'bg-green-500/15 text-green-600 border-green-500/30' : 'bg-[var(--bg-raised)] text-[var(--text-muted)] border-[var(--border)]'} />
                    {cycle.accepting_applications && <Badge label="open" color="bg-blue-500/15 text-blue-400 border-blue-500/30" />}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* New cycle form */}
          <div className="space-y-2 pt-2 border-t border-[var(--border)]">
            <p className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">New Cycle</p>
            <input
              type="text"
              value={newCycleName}
              onChange={e => setNewCycleName(e.target.value)}
              placeholder="e.g. FA2026"
              className="w-full bg-[var(--bg-raised)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--ps-accent)]"
              onKeyDown={e => e.key === 'Enter' && createCycle()}
            />
            {cycleError && <p className="text-red-400 text-xs">{cycleError}</p>}
            <button
              onClick={createCycle}
              disabled={cycleLoading}
              className="w-full ps-gradient disabled:opacity-50 text-white text-sm font-medium py-2 rounded-lg"
            >
              {cycleLoading ? 'Creating...' : 'Create Cycle'}
            </button>
          </div>
        </div>

        {/* Right column — cycle detail */}
        {!selectedCycle ? (
          <div className="flex-1 flex items-center justify-center text-[var(--text-muted)] text-sm">
            Select or create a cycle to get started
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-6 space-y-6">

            {/* Cycle header */}
            <div className="space-y-3">
              <div className="flex flex-wrap gap-3 items-center justify-between">
                <div>
                  <h2 className="text-xl font-bold text-[var(--text-primary)]">{selectedCycle.name}</h2>
                  <p className="text-sm text-[var(--text-muted)]">{selectedCycle.status}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={exportApplications}
                    disabled={exportingCsv}
                    title="Export applicant data to CSV"
                    className="text-sm px-4 py-2 rounded-lg border font-medium bg-[var(--bg-raised)] text-[var(--text-muted)] border-[var(--border)] hover:text-[var(--ps-accent)] hover:border-[var(--ps-accent)]/50 transition-colors cursor-pointer disabled:opacity-50"
                  >
                    {exportingCsv ? 'Exporting…' : 'Export applicant data to CSV'}
                  </button>
                  <button
                    disabled={selectedCycle.status === 'ended'}
                    onClick={() => toggleAccepting(selectedCycle)}
                    className={`text-sm px-4 py-2 rounded-lg border font-medium transition-colors cursor-pointer ${
                      selectedCycle.accepting_applications
                        ? 'bg-blue-500/15 text-blue-400 border-blue-500/30 hover:bg-blue-500/25'
                        : 'bg-[var(--bg-raised)] text-[var(--text-muted)] border-[var(--border)] hover:text-[var(--text-primary)]'
                    }`}
                  >
                    {selectedCycle.accepting_applications ? 'Close Applications' : 'Open Applications'}
                  </button>
                  {selectedCycle.status === 'active' && (
                    <button
                      onClick={() => endCycle(selectedCycle)}
                      className="text-sm px-4 py-2 rounded-lg border bg-red-500/10 text-red-400 border-red-500/30 hover:bg-red-500/20 font-medium transition-colors cursor-pointer"
                    >
                      End Cycle
                    </button>
                  )}
                </div>
              </div>

              <p className="text-sm text-[var(--text-muted)]">A cycle is one recruitment season. Configure its application here, then set up rounds and scoring rubrics.</p>
              {selectedCycle.accepting_applications && selectedCycle.status === 'active' ? <a className="inline-block rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] px-4 py-2 text-sm font-medium" href={`/apply/form?cycle=${selectedCycle.id}`} target="_blank" rel="noreferrer">View application form (new tab)</a> : <p className="text-sm text-[var(--text-muted)]">Open applications to view this cycle’s applicant form.</p>}
              <button className="underline text-sm" onClick={() => router.push('/admin/rounds')}>Set up rounds &amp; rubrics</button>
              {selectedCycle.status === 'ended' && currentUser?.role === 'admin' && <DeleteCycle key={selectedCycle.id} id={selectedCycle.id} name={selectedCycle.name} onDeleted={() => { setCycles(previous => previous.filter(c => c.id !== selectedCycle.id)); selectCycle(null) }} />}
              {/* Application deadline */}
              <div className="bg-[var(--bg-surface)] border border-[var(--border)] rounded-xl p-4 space-y-2">
                <p className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">Application Deadline</p>
                {(() => {
                  const dl = selectedCycle.application_deadline ? new Date(selectedCycle.application_deadline) : null
                  const passed = dl && dl <= new Date()
                  return (
                    <>
                      {dl && (
                        <p className={`text-sm font-medium ${passed ? 'text-amber-400' : 'text-green-400'}`}>
                          {passed ? '⏰ Deadline passed — ' : '🕐 Closes '}{dl.toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short', timeZone: 'America/Los_Angeles' })} PT
                        </p>
                      )}
                      <div className="flex gap-2 items-center">
                        <input
                          type="datetime-local"
                          value={deadlineInput}
                          disabled={selectedCycle.status === 'ended'}
                          onChange={e => setDeadlineInput(e.target.value)}
                          className="bg-[var(--bg-raised)] border border-[var(--border)] rounded-lg px-3 py-1.5 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--ps-accent)]"
                        />
                        <button
                          onClick={saveDeadline}
                          disabled={deadlineSaving || selectedCycle.status === 'ended'}
                          className="ps-gradient disabled:opacity-50 text-white text-sm font-medium px-3 py-1.5 rounded-lg cursor-pointer"
                        >
                          {deadlineSaving ? 'Saving...' : 'Set Deadline'}
                        </button>
                        {deadlineInput && selectedCycle.status !== 'ended' && (
                          <button
                            onClick={() => { setDeadlineInput(''); saveDeadline() }}
                            className="text-xs text-[var(--text-muted)] hover:text-red-400 transition-colors cursor-pointer"
                          >
                            Clear
                          </button>
                        )}
                      </div>
                    </>
                  )
                })()}
              </div>
            </div>

            {/* Analytics */}
            {analytics && (
              <Section title="Analytics">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {[
                    { label: 'Total', value: analytics.total },
                    { label: 'Freshman', value: `${analytics.freshman} (${pct(analytics.freshman)})` },
                    { label: 'Sophomore', value: `${analytics.sophomore} (${pct(analytics.sophomore)})` },
                    { label: 'Junior', value: `${analytics.junior} (${pct(analytics.junior)})` },
                    { label: 'Senior', value: `${analytics.senior} (${pct(analytics.senior)})` },
                    { label: 'Transfer', value: `${analytics.transfer} (${pct(analytics.transfer)})` },
                    { label: 'Applied Before', value: `${analytics.previouslyApplied} (${pct(analytics.previouslyApplied)})` },
                  ].map(({ label, value }) => (
                    <div key={label} className="bg-[var(--bg-raised)] rounded-lg p-3">
                      <p className="text-xs text-[var(--text-muted)]">{label}</p>
                      <p className="text-sm font-semibold text-[var(--text-primary)] mt-0.5">{value}</p>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {/* Essay prompts */}
            <ApplicationWordingEditor key={selectedCycle.id} cycle={selectedCycle} onSaved={updated => { setSelectedCycle(updated); setCycles(previous => previous.map(c => c.id === updated.id ? updated : c)) }} />
            <Section title="Essay Prompts"><fieldset disabled={selectedCycle.status === 'ended'}>
              <p className="text-xs text-[var(--text-muted)]">
                {MIN_PROMPTS}–{MAX_PROMPTS} questions, each with its own word limit and two grading criteria.
                Prompts can only be edited while applications are closed and before anyone has applied.
              </p>
              <div className="space-y-4">
                {prompts.map((p, i) => {
                  const update = (patch: Partial<EssayPrompt>) => setPrompts(prev => prev.map((x, j) => j === i ? { ...x, ...patch } : x))
                  return (
                    <div key={i} className="space-y-1.5 pb-3 border-b border-[var(--border)] last:border-0">
                      <div className="flex items-center justify-between">
                        <p className="text-xs font-medium text-[var(--text-muted)]">Question {i + 1}</p>
                        {prompts.length > MIN_PROMPTS && (
                          <button
                            onClick={() => setPrompts(prev => prev.filter((_, j) => j !== i))}
                            className="text-xs text-red-400 hover:text-red-300"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                      <input
                        type="text"
                        value={p.prompt}
                        onChange={e => update({ prompt: e.target.value })}
                        placeholder="Question text..."
                        className="w-full bg-[var(--bg-raised)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--ps-accent)]"
                      />
                      <input
                        type="text"
                        value={p.description ?? ''}
                        onChange={e => update({ description: e.target.value })}
                        placeholder="Description / clarification (optional)..."
                        className="w-full bg-[var(--bg-raised)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--ps-accent)]"
                      />
                      <label className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                        Word limit
                        <input
                          type="number"
                          min={1}
                          max={MAX_WORD_LIMIT}
                          value={p.word_limit ?? ''}
                          onChange={e => update({ word_limit: e.target.value ? Number(e.target.value) : null })}
                          placeholder="e.g. 250"
                          className="w-28 bg-[var(--bg-raised)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--ps-accent)]"
                        />
                      </label>
                      <input
                        type="text"
                        value={p.criterion1 ?? ''}
                        onChange={e => update({ criterion1: e.target.value })}
                        placeholder="Grading criterion 1 (e.g. To what degree does the applicant demonstrate passion?)"
                        className="w-full bg-[var(--bg-raised)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--ps-accent)]"
                      />
                      <input
                        type="text"
                        value={p.criterion2 ?? ''}
                        onChange={e => update({ criterion2: e.target.value })}
                        placeholder="Grading criterion 2 (e.g. To what extent does the applicant exhibit knowledge?)"
                        className="w-full bg-[var(--bg-raised)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--ps-accent)]"
                      />
                    </div>
                  )
                })}
              </div>
              <div className="flex items-center gap-3">
                {prompts.length < MAX_PROMPTS && (
                  <button
                    onClick={() => setPrompts(prev => [...prev, blankPrompt(selectedCycle.id, prev.length + 1)])}
                    className="text-sm px-4 py-2 rounded-lg border border-[var(--border)] bg-[var(--bg-raised)] text-[var(--text-primary)] hover:border-[var(--ps-accent)]/40"
                  >
                    + Add Question
                  </button>
                )}
                <button
                  onClick={savePrompts}
                  disabled={promptSaving}
                  className="ps-gradient disabled:opacity-50 text-white text-sm font-medium px-4 py-2 rounded-lg"
                >
                  {promptSaving ? 'Saving...' : 'Save Prompts'}
                </button>
                {promptMessage && (
                  <p className={`text-sm ${promptMessage.startsWith('Error') ? 'text-red-400' : 'text-green-400'}`}>{promptMessage}</p>
                )}
              </div>
            </fieldset></Section>

            {/* Rounds */}

          </div>
        )}
      </div>
    </main>
  )
}

function blankPrompt(cycleId: string, questionNumber: number): EssayPrompt {
  return { id: '', cycle_id: cycleId, question_number: questionNumber, prompt: '', description: null, word_limit: null, criterion1: null, criterion2: null }
}
