'use client'

import { useState, useRef, useEffect } from 'react'
import { Session } from '@/lib/types'
import { parseDelibCSV } from '@/lib/csv'

interface Props {
  session: Session
  sessionId: string
  onRefresh: () => void
  onVouchesReset: () => void
}

export default function AdminPanel({ session, sessionId, onRefresh, onVouchesReset }: Props) {
  const [tab, setTab] = useState<'session' | 'members' | 'emails'>('session')
  const [importing, setImporting] = useState(false)
  const [importStatus, setImportStatus] = useState('')
  const [ending, setEnding] = useState(false)
  const [togglingAnon, setTogglingAnon] = useState(false)
  const [resettingVouches, setResettingVouches] = useState(false)
  const [resetVouchesStatus, setResetVouchesStatus] = useState('')
  const [csvText, setCsvText] = useState('')
  const [showPaste, setShowPaste] = useState(false)
  const [copied, setCopied] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  function copySessionId() {
    navigator.clipboard.writeText(sessionId)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  // Email management state
  const [authorizedEmails, setAuthorizedEmails] = useState<{ id: string; email: string; added_by: string }[]>([])
  const [emailsLoading, setEmailsLoading] = useState(false)
  const [newEmail, setNewEmail] = useState('')
  const [emailError, setEmailError] = useState('')
  const [bulkEmails, setBulkEmails] = useState('')
  const [showBulk, setShowBulk] = useState(false)

  // Session member + ban state
  const [members, setMembers] = useState<{ user_email: string }[]>([])
  const [bans, setBans] = useState<{ id: string; email: string; banned_by: string }[]>([])
  const [membersLoading, setMembersLoading] = useState(false)
  const [banInput, setBanInput] = useState('')
  const [banError, setBanError] = useState('')

  useEffect(() => {
    if (tab === 'emails') loadEmails()
    if (tab === 'members') loadMembersAndBans()
  }, [tab]) // eslint-disable-line react-hooks/exhaustive-deps

  async function loadMembersAndBans() {
    setMembersLoading(true)
    const [mRes, bRes] = await Promise.all([
      fetch(`/api/session-members?session_id=${sessionId}`),
      fetch(`/api/session-bans?session_id=${sessionId}`),
    ])
    setMembers(mRes.ok ? await mRes.json() : [])
    setBans(bRes.ok ? await bRes.json() : [])
    setMembersLoading(false)
  }

  async function banEmail(email: string) {
    const target = email.trim().toLowerCase()
    setBanError('')
    if (!target.includes('@')) { setBanError('Enter a valid email address.'); return }
    const res = await fetch('/api/session-bans', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, email: target }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      setBanError(err?.error ?? 'Failed to ban.')
      return
    }
    setBanInput('')
    await loadMembersAndBans()
    await onRefresh()
  }

  async function unbanEmail(email: string) {
    await fetch('/api/session-bans', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, email }),
    })
    await loadMembersAndBans()
  }

  async function loadEmails() {
    setEmailsLoading(true)
    const res = await fetch('/api/authorized-users')
    const data = res.ok ? await res.json() : []
    setAuthorizedEmails(data)
    setEmailsLoading(false)
  }

  async function addEmail(emailInput: string) {
    const email = emailInput.trim().toLowerCase()
    if (!email || !email.includes('@')) {
      setEmailError('Enter a valid email address.')
      return
    }
    const adminEmail = session.created_by
    const res = await fetch('/api/authorized-users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, added_by: adminEmail }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      const msg: string = body?.error ?? ''
      setEmailError(msg.toLowerCase().includes('duplicate') || msg.toLowerCase().includes('already') ? 'That email is already authorized.' : (msg || 'Failed to add email.'))
    } else {
      setNewEmail('')
      setEmailError('')
      await loadEmails()
    }
  }

  async function handleAddEmail(e: React.FormEvent) {
    e.preventDefault()
    await addEmail(newEmail)
  }

  async function handleBulkAdd(e: React.FormEvent) {
    e.preventDefault()
    const emails = bulkEmails.split(/[\n,]+/).map(e => e.trim()).filter(e => e.includes('@'))
    if (emails.length === 0) { setEmailError('No valid emails found.'); return }
    const adminEmail = session.created_by
    await Promise.all(
      emails.map(email =>
        fetch('/api/authorized-users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email.toLowerCase(), added_by: adminEmail }),
        })
      )
    )
    setBulkEmails('')
    setShowBulk(false)
    setEmailError('')
    await loadEmails()
  }

  async function removeEmail(id: string) {
    await fetch(`/api/authorized-users/${id}`, { method: 'DELETE' })
    await loadEmails()
  }

  async function importFromText(text: string) {
    setImporting(true)
    setImportStatus('Parsing...')
    let candidates: ReturnType<typeof parseDelibCSV>
    try {
      candidates = parseDelibCSV(text)
    } catch {
      setImportStatus('Error parsing CSV.')
      setImporting(false)
      return
    }
    if (candidates.length === 0) {
      setImportStatus('No candidates found.')
      setImporting(false)
      return
    }
    setImportStatus(`Importing ${candidates.length} candidates...`)
    const rows = candidates.map(c => ({ session_id: sessionId, name: c.name, data: c.data, status: 'pending' }))
    const res = await fetch(`/api/sessions/${sessionId}/candidates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rows),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      setImportStatus('Import failed: ' + (body?.error ?? res.statusText))
    } else {
      setImportStatus(`Imported ${candidates.length} candidates.`)
      await onRefresh()
    }
    setImporting(false)
  }

  async function handleCSVImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const text = await file.text()
    await importFromText(text)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  async function handlePasteImport(e: React.FormEvent) {
    e.preventDefault()
    if (!csvText.trim()) return
    await importFromText(csvText)
    setCsvText('')
    setShowPaste(false)
  }

  async function toggleAnonymous() {
    setTogglingAnon(true)
    await fetch(`/api/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ anonymous: !session.anonymous }),
    })
    await onRefresh()
    setTogglingAnon(false)
  }

  async function handleEndSession() {
    if (!confirm('End this session? Members will no longer be able to vote.')) return
    setEnding(true)
    await fetch(`/api/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'ended' }),
    })
    await onRefresh()
    setEnding(false)
  }

  async function handleReactivate() {
    await fetch(`/api/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'active' }),
    })
    await onRefresh()
  }

  // ── Advance to Next Round ─────────────────────────────────
  const [nextRoundName, setNextRoundName] = useState('')
  const [advancing, setAdvancing] = useState(false)
  const [advanceMessage, setAdvanceMessage] = useState('')

  async function handleAdvanceRound() {
    const name = nextRoundName.trim()
    if (!name) { setAdvanceMessage('Enter a name for the new round.'); return }
    if (!session.round_id) { setAdvanceMessage('This session is not linked to a round.'); return }
    setAdvancing(true)
    setAdvanceMessage('')

    try {
      // Look up current round to get cycle_id and order_index
      const roundRes = await fetch(`/api/rounds/${session.round_id}`)
      if (!roundRes.ok) throw new Error('Could not load current round.')
      const currentRound = await roundRes.json()

      // Ensure no later round exists for this cycle on the same role track
      const cycleRoundsRes = await fetch(`/api/cycles/${currentRound.cycle_id}/rounds`)
      const cycleRounds: { order_index: number; role: string | null }[] = cycleRoundsRes.ok ? await cycleRoundsRes.json() : []
      const sourceRole = session.role ?? null
      if (cycleRounds.some(r => r.order_index > currentRound.order_index && (r.role ?? null) === sourceRole)) {
        throw new Error('Candidates have already been advanced to a later round on this track.')
      }

      // Get accepted candidates from current session — verify before creating anything
      const candsRes = await fetch(`/api/sessions/${sessionId}/candidates`)
      const allCands = candsRes.ok ? await candsRes.json() : []
      const accepted = allCands.filter((c: { status: string }) => c.status === 'accepted')
      if (!accepted.length) throw new Error('No accepted candidates to advance.')

      // Create new round — inherit the role from the source session so curriculum and
      // developer tracks advance independently.
      const newRoundRes = await fetch('/api/rounds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cycle_id: currentRound.cycle_id,
          name,
          order_index: currentRound.order_index + 1,
          grading_type: 'interview',
          status: 'pending',
          role: session.role ?? null,
        }),
      })
      if (!newRoundRes.ok) {
        const body = await newRoundRes.json().catch(() => ({}))
        throw new Error('Could not create round: ' + (body?.error ?? newRoundRes.statusText))
      }
      setAdvanceMessage(`Created round "${name}" with ${accepted.length} accepted candidate${accepted.length !== 1 ? 's' : ''}. Set up the interview form in the admin console, then import responses to start deliberation.`)
    } catch (err: unknown) {
      setAdvanceMessage(err instanceof Error ? err.message : 'Unknown error.')
    } finally {
      setAdvancing(false)
    }
  }

  async function handleClearCandidates() {
    if (!confirm('Delete ALL candidates and votes? This cannot be undone.')) return
    const candsRes = await fetch(`/api/sessions/${sessionId}/candidates`)
    const cands = candsRes.ok ? await candsRes.json() : []
    // Delete each candidate (API should cascade votes, or delete individually)
    await Promise.all(
      cands.map((c: { id: string }) =>
        fetch(`/api/candidates/${c.id}`, { method: 'DELETE' })
      )
    )
    await onRefresh()
    setImportStatus('All candidates cleared.')
  }

  async function handleResetVouches() {
    if (resettingVouches) return
    if (!confirm('Reset all vouches and anti-vouches in this session? Red flags will remain. This cannot be undone.')) return
    setResettingVouches(true)
    setResetVouchesStatus('')
    try {
      const response = await fetch('/api/votes/reset', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId }),
        signal: AbortSignal.timeout(30000),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) {
        setResetVouchesStatus(body?.error ?? 'Unable to reset vouches.')
        return
      }
      const deletedCount = Number(body?.deleted_count ?? 0)
      setResetVouchesStatus(`Reset ${deletedCount} vouch${deletedCount === 1 ? '' : 'es'} and anti-vouches. Red flags were kept.`)
      onVouchesReset()
    } catch {
      setResetVouchesStatus('Could not confirm the reset. Check the live counts before trying again.')
    } finally {
      setResettingVouches(false)
    }
  }

  return (
    <div className="flex flex-col border-b border-[var(--border)]">
        {/* Tab bar */}
        <div className="flex border-b border-[var(--border)] shrink-0">
          <button
            onClick={() => setTab('session')}
            className={`flex-1 py-2 text-xs font-medium transition-colors ${tab === 'session' ? 'text-[var(--text-primary)] border-b-2 border-[#FF6B35]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}
          >
            Session
          </button>
          <button
            onClick={() => setTab('members')}
            className={`flex-1 py-2 text-xs font-medium transition-colors ${tab === 'members' ? 'text-[var(--text-primary)] border-b-2 border-[#FF6B35]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}
          >
            Members
          </button>
          <button
            onClick={() => setTab('emails')}
            className={`flex-1 py-2 text-xs font-medium transition-colors ${tab === 'emails' ? 'text-[var(--text-primary)] border-b-2 border-[#FF6B35]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}
          >
            Emails
          </button>
        </div>

        <div className="overflow-y-auto max-h-[50vh]">
          {tab === 'session' ? (
            <div className="p-4 space-y-4">
              {/* Session ID */}
              <button
                onClick={copySessionId}
                className="w-full bg-[var(--bg-raised)] hover:bg-[var(--bg-active)] border border-[var(--border)] rounded-lg p-3 text-sm text-left transition-colors group"
              >
                <p className="text-gray-500 text-xs mb-1 flex items-center justify-between">
                  <span>Session ID — click to copy</span>
                  <span className={`text-xs transition-colors ${copied ? 'text-green-400' : 'text-gray-600 group-hover:text-gray-400'}`}>
                    {copied ? 'Copied!' : 'Copy'}
                  </span>
                </p>
                <p className="font-mono font-bold text-[#FF6B35] text-xl tracking-widest">{sessionId}</p>
              </button>

              {/* Import CSV */}
              <div>
                <label className="block text-sm font-medium text-[var(--text-secondary)] mb-2">Import Candidates</label>
                <div className="flex gap-2">
                  <input ref={fileInputRef} type="file" accept=".csv" onChange={handleCSVImport} disabled={importing || session.status === 'ended'} className="hidden" id="csv-upload" />
                  <label
                    htmlFor="csv-upload"
                    className={`flex-1 text-center px-3 py-2 rounded-lg text-sm font-medium cursor-pointer ${importing || session.status === 'ended' ? 'bg-[var(--bg-raised)] text-gray-600 cursor-not-allowed' : 'plex-gradient text-white'}`}
                  >
                    {importing ? 'Importing...' : 'Upload File'}
                  </label>
                  <button
                    onClick={() => setShowPaste(!showPaste)}
                    disabled={importing || session.status === 'ended'}
                    className="px-3 py-2 rounded-lg text-sm font-medium bg-[var(--bg-raised)] hover:bg-[var(--bg-active)] border border-[var(--border)] text-[var(--text-muted)] transition-colors disabled:opacity-40"
                  >
                    Paste
                  </button>
                </div>
                {showPaste && (
                  <form onSubmit={handlePasteImport} className="mt-2 space-y-2">
                    <textarea
                      value={csvText}
                      onChange={e => setCsvText(e.target.value)}
                      placeholder="Paste CSV data here..."
                      rows={6}
                      className="w-full bg-[var(--bg-raised)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)] placeholder-[var(--text-muted)] text-xs font-mono focus:outline-none focus:border-[#FF6B35] resize-none"
                    />
                    <button type="submit" disabled={importing || !csvText.trim()}
                      className="w-full plex-gradient disabled:opacity-40 text-white text-sm py-2 rounded-lg">
                      Import Pasted CSV
                    </button>
                  </form>
                )}
                {importStatus && (
                  <p className={`text-xs mt-2 ${importStatus.includes('failed') || importStatus.includes('Error') ? 'text-red-400' : 'text-green-400'}`}>
                    {importStatus}
                  </p>
                )}
              </div>

              {/* Anonymous toggle */}
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-[var(--text-secondary)]">Anonymous Mode</p>
                  <p className="text-xs text-[var(--text-muted)]">Hide voter names</p>
                </div>
                <button
                  onClick={toggleAnonymous}
                  disabled={togglingAnon}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors cursor-pointer group ${session.anonymous ? 'plex-gradient hover:opacity-80' : 'bg-[#1e2035] hover:bg-[#252545]'}`}
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-all group-hover:scale-110 shadow-sm ${session.anonymous ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
              </div>

              {/* Clear */}
              <div className="space-y-2">
                <button
                  onClick={handleResetVouches}
                  disabled={resettingVouches || session.status === 'ended'}
                  className="w-full px-4 py-2 rounded-lg text-sm font-medium bg-orange-500/10 text-orange-500 border border-orange-500/30 hover:bg-orange-500/20 transition-colors disabled:opacity-40"
                >
                  {resettingVouches ? 'Resetting…' : 'Reset Vouches'}
                </button>
                <p className="text-xs text-[var(--text-muted)]">Clears all vouches and anti-vouches. Red flags remain.</p>
                {resetVouchesStatus && (
                  <p className={`text-xs ${resetVouchesStatus.startsWith('Reset ') ? 'text-green-500' : 'text-red-400'}`}>
                    {resetVouchesStatus}
                  </p>
                )}
              </div>

              <button
                onClick={handleClearCandidates}
                disabled={session.status === 'ended'}
                className="w-full px-4 py-2 rounded-lg text-sm font-medium bg-red-950/40 text-red-400 border border-red-900/50 hover:bg-red-900/50 transition-colors disabled:opacity-40"
              >
                Clear All Candidates & Votes
              </button>

              {/* End / reactivate */}
              <div className="border-t border-[var(--border)] pt-4">
                {session.status === 'active' ? (
                  <button onClick={handleEndSession} disabled={ending} className="w-full px-4 py-2 rounded-lg text-sm font-medium bg-red-700 hover:bg-red-600 text-white transition-colors disabled:opacity-50">
                    {ending ? 'Ending...' : 'End Session'}
                  </button>
                ) : (
                  <button onClick={handleReactivate} className="w-full px-4 py-2 rounded-lg text-sm font-medium bg-green-700 hover:bg-green-600 text-white transition-colors">
                    Reactivate Session
                  </button>
                )}
              </div>

              {/* Advance to Next Round */}
              {session.round_id && (
                <div className="border-t border-[var(--border)] pt-4 space-y-2">
                  <p className="text-sm font-medium text-[var(--text-secondary)]">Advance to Next Round</p>
                  <p className="text-xs text-[var(--text-muted)]">Creates a new round and session with only the accepted candidates from this session.</p>
                  <input
                    type="text"
                    value={nextRoundName}
                    onChange={e => setNextRoundName(e.target.value)}
                    placeholder="New round name (e.g. Interviews)"
                    className="w-full bg-[var(--bg-raised)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[#FF6B35]"
                  />
                  <button
                    onClick={handleAdvanceRound}
                    disabled={advancing}
                    className="w-full plex-gradient disabled:opacity-50 text-white text-sm font-medium py-2 rounded-lg"
                  >
                    {advancing ? 'Creating…' : 'Advance Accepted Candidates →'}
                  </button>
                  {advanceMessage && (
                    <p className={`text-xs ${advanceMessage.startsWith('Created') ? 'text-green-400' : 'text-red-400'}`}>
                      {advanceMessage}
                    </p>
                  )}
                </div>
              )}

            </div>
          ) : tab === 'members' ? (
            <div className="p-4 space-y-4">
              <p className="text-xs text-gray-500">
                Banning removes someone from this session and blocks them from rejoining. It does not affect their access to other sessions.
              </p>

              {/* Ban by email */}
              <form
                onSubmit={e => { e.preventDefault(); banEmail(banInput) }}
                className="flex gap-2"
              >
                <input
                  type="email"
                  value={banInput}
                  onChange={e => { setBanInput(e.target.value); setBanError('') }}
                  placeholder="email@berkeley.edu"
                  className="flex-1 bg-[var(--bg-raised)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-red-500/60"
                />
                <button
                  type="submit"
                  className="px-3 py-2 rounded-lg text-sm font-medium bg-red-500/15 border border-red-500/40 text-red-300 hover:bg-red-500/25 transition-colors"
                >
                  Ban
                </button>
              </form>
              {banError && <p className="text-xs text-red-400">{banError}</p>}

              {membersLoading ? (
                <p className="text-xs text-[var(--text-muted)]">Loading…</p>
              ) : (
                <>
                  {/* Current members */}
                  <div className="space-y-1">
                    <p className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">
                      In session ({members.length})
                    </p>
                    {members.length === 0 && (
                      <p className="text-xs text-[var(--text-muted)]">No one has joined yet.</p>
                    )}
                    {members.map(m => {
                      const isCreator = m.user_email?.toLowerCase() === session.created_by?.toLowerCase()
                      return (
                        <div key={m.user_email} className="flex items-center justify-between gap-2 bg-[var(--bg-raised)] border border-[var(--border)] rounded-lg px-3 py-2">
                          <span className="text-xs text-[var(--text-primary)] truncate">
                            {m.user_email}
                            {isCreator && <span className="ml-1 text-[var(--text-muted)]">(creator)</span>}
                          </span>
                          {!isCreator && (
                            <button
                              onClick={() => {
                                if (confirm(`Ban ${m.user_email} from this session?`)) banEmail(m.user_email)
                              }}
                              className="text-xs px-2 py-1 rounded text-red-400 hover:bg-red-500/15 transition-colors shrink-0"
                            >
                              Ban
                            </button>
                          )}
                        </div>
                      )
                    })}
                  </div>

                  {/* Banned list */}
                  {bans.length > 0 && (
                    <div className="space-y-1 pt-2 border-t border-[var(--border)]">
                      <p className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">
                        Banned ({bans.length})
                      </p>
                      {bans.map(b => (
                        <div key={b.id} className="flex items-center justify-between gap-2 bg-red-500/5 border border-red-500/25 rounded-lg px-3 py-2">
                          <span className="text-xs text-red-300 truncate">{b.email}</span>
                          <button
                            onClick={() => unbanEmail(b.email)}
                            className="text-xs px-2 py-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-active)] transition-colors shrink-0"
                          >
                            Unban
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          ) : (
            <div className="p-4 space-y-4">
              <p className="text-xs text-gray-500">
                Only these emails can sign in. If the list is empty, anyone with Google can access the tool.
              </p>

              {/* Add single email */}
              <form onSubmit={handleAddEmail} className="flex gap-2">
                <input
                  type="email"
                  value={newEmail}
                  onChange={e => { setNewEmail(e.target.value); setEmailError('') }}
                  placeholder="email@berkeley.edu"
                  className="flex-1 bg-[var(--bg-raised)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)] placeholder-[var(--text-muted)] text-sm focus:outline-none focus:border-[#FF6B35]"
                />
                <button type="submit" className="plex-gradient text-white text-sm px-3 py-2 rounded-lg shrink-0">
                  Add
                </button>
              </form>

              {/* Bulk add */}
              <div>
                <button
                  onClick={() => setShowBulk(!showBulk)}
                  className="text-xs text-[#FF6B35] hover:opacity-80"
                >
                  {showBulk ? 'Hide bulk add' : '+ Bulk add (paste list)'}
                </button>
                {showBulk && (
                  <form onSubmit={handleBulkAdd} className="mt-2 space-y-2">
                    <textarea
                      value={bulkEmails}
                      onChange={e => setBulkEmails(e.target.value)}
                      placeholder="One email per line, or comma-separated"
                      rows={4}
                      className="w-full bg-[var(--bg-raised)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)] placeholder-[var(--text-muted)] text-sm focus:outline-none focus:border-[#FF6B35] resize-none"
                    />
                    <button type="submit" className="w-full plex-gradient text-white text-sm py-2 rounded-lg">
                      Add All
                    </button>
                  </form>
                )}
              </div>

              {emailError && <p className="text-red-400 text-xs">{emailError}</p>}

              {/* Email list */}
              {emailsLoading ? (
                <p className="text-[var(--text-muted)] text-sm text-center py-4">Loading...</p>
              ) : authorizedEmails.length === 0 ? (
                <p className="text-[var(--text-muted)] text-sm text-center py-4">No emails yet — all Google users can access.</p>
              ) : (
                <ul className="space-y-1">
                  {authorizedEmails.map(({ id, email }) => (
                    <li key={id} className="flex items-center justify-between gap-2 bg-[var(--bg-raised)] border border-[var(--border)] rounded-lg px-3 py-2">
                      <span className="text-sm text-[var(--text-secondary)] truncate">{email}</span>
                      <button
                        onClick={() => removeEmail(id)}
                        className="text-red-400 hover:text-red-300 text-xs shrink-0 transition-colors"
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
    </div>
  )
}
