'use client'
import Link from 'next/link'
import PSReassignment from '@/components/PSReassignment'
import PSReviewHistory from '@/components/PSReviewHistory'
import PSRubricEditor, { type SavePhase } from '@/components/PSRubricEditor'
import PSProgression from '@/components/PSProgression'
import PSAssignments from '@/components/PSAssignments'
import PSProgressBoard from '@/components/PSProgressBoard'
import { useCallback, useEffect, useRef, useState } from 'react'
import { getCurrentUser } from '@/lib/auth'
import { Round, RecruitmentCycle, AuthorizedUser } from '@/lib/types'
import { EVALUATION_TYPES } from '@/lib/ps/domain'
import { requestJson } from '@/lib/ps/client'

const inputClass = 'w-full rounded-lg border border-[var(--border)] bg-[var(--bg-raised)] px-3 py-2'
const buttonClass = 'rounded-lg border border-[var(--border)] px-3 py-2 hover:bg-[var(--bg-raised)] disabled:opacity-40'
export default function RoundSetupPage() {
  const [allowed, setAllowed] = useState(false)
  const [cycles, setCycles] = useState<RecruitmentCycle[]>([])
  const [cycleId, setCycleId] = useState('')
  const selectedCycle = useRef('')
  const [newCycleName, setNewCycleName] = useState('')
  const [cycle, setCycle] = useState<(RecruitmentCycle & { configuration_version: number }) | null>(null)
  const [rounds, setRounds] = useState<Round[]>([])
  const [users, setUsers] = useState<AuthorizedUser[]>([])
  const [selected, setSelected] = useState<Round | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [panel, setPanel] = useState('rubric')
  const [admin, setAdmin] = useState(false), [visited, setVisited] = useState<Record<string, Round>>({}), [saveStates, setSaveStates] = useState<Record<string, { phase: SavePhase; error: string }>>({})
  const reportSave = useCallback((id: string, phase: SavePhase, error: string) => setSaveStates(p => p[id]?.phase === phase && p[id]?.error === error ? p : { ...p, [id]: { phase, error } }), [])
  function chooseRound(round: Round) { if (selectedCycle.current !== String(round.cycle_id)) { selectedCycle.current = String(round.cycle_id); setCycleId(selectedCycle.current); void action(() => load(selectedCycle.current), '') } setVisited(p => ({ ...p, [round.id]: round })); setSelected(round); setPanel('rubric') }
  const [renamingId, setRenamingId] = useState<string | null>(null), [roundName, setRoundName] = useState(''), [renameError, setRenameError] = useState('')
  const [revision, setRevision] = useState(0)
  const load = useCallback(async (id: string) => {
    const data = await requestJson<{ cycle: RecruitmentCycle & { configuration_version: number }; rounds: Round[] }>(`/api/ps/cycles/${id}/rounds`)
    if (selectedCycle.current !== id) return
    setCycle(data.cycle); setRounds(data.rounds); setVisited(p => Object.fromEntries(Object.entries(p).map(([key, r]) => [key, data.rounds.find(next => next.id === key) ?? r]))); setRevision(previous => previous + 1)
    setSelected(previous => previous ? data.rounds.find(r => r.id === previous.id) ?? null : null)
  }, [])
  useEffect(() => { let active = true
    async function init() {
      try {
        const user = await getCurrentUser()
        if (!user || user.role === 'grader') throw new Error('Leadership or admin access is required.')
        const [cycleRows, userRows] = await Promise.all([requestJson<RecruitmentCycle[]>('/api/cycles'), requestJson<AuthorizedUser[]>('/api/ps/graders')])
        if (active) { setAllowed(true); setAdmin(user.role === 'admin'); setCycles(cycleRows); setUsers(userRows) }
      } catch (e) { if (active) setError((e as Error).message) }
      finally { if (active) setLoading(false) }
    }
    void init(); return () => { active = false }
  }, [])
  async function action(fn: () => Promise<unknown>, refreshCycleId = cycleId) { setBusy(true); setError(''); try { await fn(); if (refreshCycleId) await load(refreshCycleId) } catch (e) { setError((e as Error).message) } finally { setBusy(false) } }
  async function move(index: number, delta: number) {
    const ids = rounds.map(r => r.id); [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]]
    await action(() => requestJson(`/api/ps/cycles/${cycleId}/rounds`, { round_ids: ids, configuration_version: cycle?.configuration_version }, 'PATCH'))
  }
  async function renameRound(round: Round) {
    setBusy(true); setRenameError('')
    try {
      const saved = await requestJson<Round>(`/api/ps/rounds/${round.id}`, { name: roundName.trim(), configuration_version: round.configuration_version }, 'PATCH')
      setRounds(previous => previous.map(r => r.id === saved.id ? { ...r, ...saved } : r))
      setSelected(previous => previous?.id === saved.id ? { ...previous, ...saved } : previous)
      setVisited(p => p[saved.id] ? { ...p, [saved.id]: { ...p[saved.id], ...saved } } : p)
      setRenamingId(null)
    } catch (e) { setRenameError((e as Error).message) }
    finally { setBusy(false) }
  }
  const readOnly = busy || cycle?.status !== 'active'
  const orderLocked = rounds.some(r => r.configuration_locked)
  return <main className="mx-auto w-full min-w-0 max-w-3xl p-5 text-[var(--text-primary)] space-y-5">
    <nav className="flex gap-4 text-sm"><Link href="/dashboard">Dashboard</Link><Link href="/admin">Legacy admin console</Link><Link href="/grade/ps">PS grading</Link><Link href={cycleId ? `/admin/candidates?cycle=${cycleId}` : '/admin/candidates'}>Candidates</Link></nav>
    <h1 className="text-2xl font-semibold">Recruitment rounds</h1>
    <p className="text-[var(--text-muted)]">Choose a round to edit its rubric, manage graders or review progress.</p>
    {error && <p role="alert" className="rounded-lg border border-red-500 p-3">{error}</p>}
    {loading ? <p>Loading configuration…</p> : allowed && <>
      <label className="block">Recruitment cycle<select className={inputClass} value={cycleId} disabled={busy} onChange={e => { const id = e.target.value; selectedCycle.current = id; setCycleId(id); setSelected(null); setCycle(null); setRounds([]); setRenamingId(null); setRenameError(''); if (id) void action(() => load(id), '') }}><option value="">Choose a cycle</option>{cycles.map(c => <option key={c.id} value={c.id}>{c.name} · {c.status}</option>)}</select></label>
      <details className="text-sm"><summary className="cursor-pointer text-[var(--text-muted)]">Manage cycles</summary><div className="space-y-3 mt-3"><form className="flex flex-wrap gap-2 items-end" onSubmit={e => { e.preventDefault(); void action(async () => { const created = await requestJson<RecruitmentCycle>('/api/cycles', { name: newCycleName }); setCycles(previous => [created, ...previous]); selectedCycle.current = created.id; setCycleId(created.id); setSelected(null); setNewCycleName(''); await load(created.id) }, '') }}><label className="flex-1">New cycle name<input className={inputClass} value={newCycleName} required maxLength={100} onChange={e => setNewCycleName(e.target.value)} /></label><button className={buttonClass} disabled={busy || !newCycleName.trim()}>Create cycle</button></form>{cycleId && <button className={buttonClass} disabled={busy} onClick={() => void action(async () => { setCycles(await requestJson<RecruitmentCycle[]>('/api/cycles')) })}>Refresh configuration</button>}<p>Other cycle settings remain in the <Link className="underline" href="/admin">admin console</Link>.</p></div></details>
      {cycle?.status === 'ended' && <p role="status">This cycle is ended. Configuration, grading and progression are read-only; history remains available.</p>}
      {orderLocked && <p className="text-sm">Round ordering is frozen because enrollment or grading has begun.</p>}
      {cycle && <div className="space-y-6">
        <nav aria-label="Recruitment rounds" className="flex flex-wrap gap-2">{rounds.map((r, index) => <div key={r.id} className="max-w-full rounded-lg border border-[var(--border)]">
          {renamingId === r.id ? <form className="flex flex-wrap items-center gap-2 p-2" onSubmit={e => { e.preventDefault(); void renameRound(r) }}>
            <label className="sr-only" htmlFor={`round-name-${r.id}`}>Round name</label><input id={`round-name-${r.id}`} autoFocus required maxLength={200} className={`${inputClass.replace('w-full', 'w-52 max-w-full')} min-w-0 text-sm`} value={roundName} disabled={busy} onChange={e => setRoundName(e.target.value)} onKeyDown={e => { if (e.key === 'Escape' && !busy) { e.preventDefault(); setRenamingId(null); setRenameError('') } }} />
            <button aria-label="Save round name" className={`${buttonClass} text-sm`} disabled={busy || !roundName.trim() || roundName.trim() === r.name}>Save</button><button type="button" aria-label="Cancel rename" className={`${buttonClass} text-sm`} disabled={busy} onClick={() => { setRenamingId(null); setRenameError('') }}>Cancel</button>
            {renameError && <p role="alert" className="w-full text-sm text-red-500">{renameError}</p>}
          </form> : <div className="flex flex-wrap items-center"><button className={`px-3 py-2 text-sm text-left ${selected?.id === r.id ? 'bg-[var(--bg-raised)] font-semibold' : ''}`} disabled={busy} aria-pressed={selected?.id === r.id} onClick={() => chooseRound(r)}>{index + 1}. {r.name}{r.archived ? ' · archived' : ''}{saveStates[r.id] && saveStates[r.id].phase !== 'saved' && <span className="block text-xs">{saveStates[r.id].phase === 'error' ? 'Save failed' : saveStates[r.id].phase === 'saving' ? 'Saving…' : 'Unsaved edits'}</span>}</button>
            <button type="button" aria-label={`Rename ${r.name}`} className="px-2 py-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-30" disabled={readOnly || !!renamingId || r.status === 'ended'} onClick={() => { setRenamingId(r.id); setRoundName(r.name); setRenameError('') }}>Rename</button>
            {!orderLocked && <span className="flex"><button aria-label={`Move ${r.name} up`} className="px-2 py-2 text-xs disabled:opacity-30" disabled={readOnly || !!renamingId || index === 0} onClick={() => void move(index, -1)}>↑</button><button aria-label={`Move ${r.name} down`} className="px-2 py-2 text-xs disabled:opacity-30" disabled={readOnly || !!renamingId || index === rounds.length - 1} onClick={() => void move(index, 1)}>↓</button></span>}
          </div>}
        </div>)}<button className={buttonClass} disabled={busy || !!renamingId || cycle.status !== 'active'} onClick={() => { setSelected(null); setPanel('settings') }}>+ Add round</button></nav>
        {!selected && !rounds.length && cycle.status === 'active' && <StandardSetup key={`standard:${cycleId}`} users={users} disabled={readOnly} onCreate={body => action(async () => { const created = await requestJson<Round[]>(`/api/ps/cycles/${cycleId}/rounds`, { ...body, template: 'ps_standard' }); await load(cycleId); if (created[0]) chooseRound(created[0]) })} />}
        {!selected && <RoundEditor key={`new-round:${cycleId}`} round={null} users={users} disabled={readOnly} onSave={body => action(async () => { const saved = await requestJson<Round>(`/api/ps/cycles/${cycleId}/rounds`, body); chooseRound(saved) })} onArchive={async () => {}} />}
        {selected && <>
          <nav aria-label="Round workspace" className="flex flex-wrap gap-2 border-b border-[var(--border)] pb-3">{[['rubric', 'Rubric'], ['settings', 'Setup & graders'], ['reviews', 'Reviews & progression']].map(([id, label]) => <button key={id} className={buttonClass} aria-pressed={panel === id} disabled={busy} onClick={() => setPanel(id)}>{label}</button>)}</nav>
          <div hidden={panel !== 'settings'} className="space-y-5"><RoundEditor key={`settings:${selected.id}:${selected.configuration_version}`} round={selected} users={users} disabled={readOnly} onSave={body => action(async () => { const saved = await requestJson<Round>(`/api/ps/rounds/${selected.id}`, body, 'PATCH'); setSelected(saved) })} onArchive={() => action(() => requestJson(`/api/ps/rounds/${selected.id}`, { configuration_version: selected.configuration_version, archived: !selected.archived }, 'PATCH'))} /><PSReassignment key={`reassignment:${selected.id}`} roundId={selected.id} readOnly={readOnly || selected.archived === true || selected.status !== 'grading'} /><PSAssignments key={`assignments:${selected.id}:${selected.configuration_version}`} round={selected} readOnly={readOnly} onChange={() => load(cycleId)} /></div>
          <div hidden={panel !== 'reviews'} className="space-y-5"><PSProgressBoard key={`progress:${selected.id}`} round={selected} readOnly={readOnly} revision={revision} onChange={() => load(cycleId)} /><PSProgression key={`progression:${selected.id}`} round={selected} readOnly={readOnly} revision={revision} firstRound={rounds.find(r => !r.archived)?.id === selected.id} onChange={() => load(cycleId)} /><PSReviewHistory key={`history:${selected.id}`} roundId={selected.id} /></div>
        </>}
      </div>}
    </>}
    {Object.entries(saveStates).filter(([id, state]) => state.phase === 'error' && id !== selected?.id).map(([id, state]) => <div key={id} role="alert" className="border border-red-400 rounded-lg p-3 text-sm">{visited[id]?.name}: draft save failed. Edits are retained. {state.error}<button className={`${buttonClass} ml-2`} onClick={() => chooseRound(visited[id])}>Return to rubric</button></div>)}
    {/* Retain each visited editor during round/cycle/tab switches, including in-flight saves. */}
    {Object.values(visited).map(r => <div key={r.id} hidden={selected?.id !== r.id || panel !== 'rubric'}><PSRubricEditor round={r} rounds={rounds} readOnly={!admin || r.status === 'ended' || (String(r.cycle_id) === cycleId && cycle?.status !== 'active')} onStatus={reportSave} onChange={async () => { if (String(r.cycle_id) === selectedCycle.current) await load(selectedCycle.current) }} /></div>)}

  </main>
}
function RoundEditor({ round, users, disabled, onSave, onArchive }: { round: Round | null; users: AuthorizedUser[]; disabled: boolean; onSave: (body: unknown) => Promise<void>; onArchive: () => Promise<void> }) {
  const [name, setName] = useState(round?.name ?? '')
  const [type, setType] = useState(round?.evaluation_type ?? 'rubric')
  const [n, setN] = useState(round?.reviews_required ?? 1)
  const [emails, setEmails] = useState(round?.eligible_grader_emails ?? [])
  const [mode, setMode] = useState(round?.assignment_mode ?? 'individual'), [pairs, setPairs] = useState(round?.interviewer_pairs ?? [])
  const paired = new Set(pairs.flatMap(p => p.emails))
  const [fieldErrors, setFieldErrors] = useState<{ name?: string; graders?: string; reviews?: string }>({})
  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const errors: typeof fieldErrors = {}
    if (!name.trim()) errors.name = 'Enter a name for this round.'
    if (!emails.length) errors.graders = 'Select at least one grader for this round.'
    if (!Number.isInteger(n) || n < 1) errors.reviews = 'Enter a whole number of reviews, starting at 1.'
    else if (mode === 'individual' && emails.length && n > emails.length) errors.reviews = `Select at least ${n} graders, or reduce the reviews required.`
    else if (mode === 'pair' && n > Math.max(pairs.length, 1)) errors.reviews = `Add at least ${n} pairs, or lower the pairs per candidate.`
    if (mode === 'pair' && pairs.some(p => p.emails.length < 2 || p.emails.some(e => !emails.includes(e)))) errors.graders = 'Every pair needs two eligible graders.'
    setFieldErrors(errors)
    if (Object.keys(errors).length) {
      const input = e.currentTarget.querySelector<HTMLInputElement>(errors.name ? 'input[name=roundName]' : errors.graders ? 'input[type=checkbox]:not(:disabled)' : 'input[name=reviewsRequired]')
      input?.focus()
      return
    }
    void onSave({ name: name.trim(), evaluation_type: type, reviews_required: n, eligible_grader_emails: emails, assignment_mode: mode, interviewer_pairs: mode === 'pair' ? pairs : [], configuration_version: round?.configuration_version })
  }
  // Graders, pairs and counts stay editable during grading; the round type and mode freeze once work exists.
  const settingsLocked = disabled || round?.status === 'ended'
  const kindLocked = settingsLocked || round?.configuration_locked
  return <form noValidate className="rounded-xl border border-[var(--border)] p-5 space-y-4" onSubmit={submit}>
    <h2 className="font-semibold">{round ? 'Round settings' : 'New round'}</h2>{!round && <p className="text-sm text-[var(--text-muted)]">Give the round a name and choose its graders. You can edit the rubric after creating it.</p>}
    <label className="block">Name<input name="roundName" className={inputClass} maxLength={200} required autoFocus={!round} placeholder="e.g. Product Design Interview" aria-invalid={!!fieldErrors.name} aria-describedby={fieldErrors.name ? "round-name-error" : undefined} disabled={disabled || round?.status === 'ended'} value={name} onChange={e => { setName(e.target.value); setFieldErrors(previous => ({ ...previous, name: undefined })) }} /></label>{fieldErrors.name && <p id="round-name-error" role="alert" className="text-sm text-red-500">{fieldErrors.name}</p>}
    <label className="block">Evaluation type<select className={inputClass} disabled={kindLocked} value={type} onChange={e => setType(e.target.value as typeof type)}>{EVALUATION_TYPES.map(t => <option key={t} value={t}>{t.replaceAll('_', ' ')}</option>)}</select></label>
    <fieldset disabled={settingsLocked} aria-describedby="round-graders-help"><legend>Eligible graders ({emails.length})</legend><div className="max-h-48 overflow-auto space-y-2 p-2">{users.map(u => <label key={u.email} className="flex gap-2 text-sm"><input type="checkbox" checked={emails.includes(u.email)} onChange={e => { setEmails(e.target.checked ? [...emails, u.email] : emails.filter(email => email !== u.email)); setFieldErrors(previous => ({ ...previous, graders: undefined, reviews: undefined })) }} />{u.email} · {u.role}</label>)}</div></fieldset>
    <p id="round-graders-help" role={fieldErrors.graders ? "alert" : undefined} className={`text-sm ${fieldErrors.graders ? "text-red-500" : "text-[var(--text-muted)]"}`}>{fieldErrors.graders ?? (emails.length ? `${emails.length} grader${emails.length === 1 ? "" : "s"} selected.` : "Choose at least one person who can grade this round.")}</p>
    <fieldset disabled={kindLocked} className="space-y-1"><legend>Who grades each candidate</legend>
      <label className="flex gap-2 items-center text-sm"><input type="radio" checked={mode === 'individual'} onChange={() => setMode('individual')} />Individual graders, each submits their own form</label>
      <label className="flex gap-2 items-center text-sm"><input type="radio" checked={mode === 'pair'} onChange={() => setMode('pair')} />Interviewer pairs, one form per pair</label>
    </fieldset>
    {mode === 'pair' && <fieldset disabled={settingsLocked} className="space-y-2"><legend>Interviewer pairs ({pairs.length})</legend>
      {pairs.map((pair, i) => <div key={pair.id} className="flex flex-wrap gap-2 items-center">{[0, 1].map(slot => <label key={slot} className="flex-1 min-w-40"><span className="sr-only">Pair {i + 1} interviewer {slot + 1}</span><select className={inputClass} value={pair.emails[slot] ?? ''} onChange={e => setPairs(pairs.map(p => p.id === pair.id ? { ...p, emails: Object.assign([...p.emails], { [slot]: e.target.value }).filter(Boolean) } : p))}><option value="">Choose interviewer</option>{emails.filter(email => email === pair.emails[slot] || !paired.has(email)).map(email => <option key={email} value={email}>{email}</option>)}</select></label>)}<button type="button" className={buttonClass} aria-label={`Remove pair ${i + 1}`} onClick={() => setPairs(pairs.filter(p => p.id !== pair.id))}>Remove</button></div>)}
      <button type="button" className={buttonClass} disabled={emails.filter(e => !paired.has(e)).length < 2} onClick={() => setPairs([...pairs, { id: crypto.randomUUID(), emails: [] }])}>+ Add pair</button>
      <p className="text-sm text-[var(--text-muted)]">Pick pairs from the eligible graders above. Each person can be in one pair. Removing a pair releases only its unstarted interviews.</p>
    </fieldset>}
    <label className="block">{mode === 'pair' ? 'Pairs per candidate' : 'Reviews required per applicant'}<input name="reviewsRequired" type="number" min={1} max={mode === 'pair' ? Math.max(pairs.length, 1) : emails.length || 1} disabled={settingsLocked} className={inputClass} aria-invalid={!!fieldErrors.reviews} aria-describedby={fieldErrors.reviews ? "round-reviews-error" : undefined} value={n || ""} onChange={e => { setN(Number(e.target.value)); setFieldErrors(previous => ({ ...previous, reviews: undefined })) }} /></label>
    {round?.configuration_locked && <p role="status" className="text-sm">Grading has begun. You can still change graders, pairs and reviews per candidate; preview and generate assignments again to apply them. The round type and assignment mode are frozen.</p>}
    {emails.filter(email => !users.some(u => u.email === email)).map(email => <p key={email} className="text-sm">{email} is selected in this round but is no longer authorized. Access administration must resolve this before assignment generation.</p>)}
    {fieldErrors.reviews && <p id="round-reviews-error" role="alert" className="text-sm text-red-500">{fieldErrors.reviews}</p>}
    <p className="text-sm text-[var(--text-muted)]">Rubric: {round?.rubric_version_id ? 'Configured' : 'Rubric not configured'}</p>
    <p className="text-sm text-[var(--text-muted)]">Round order and type freeze once enrollment begins. Archive is available only before activity begins. Ending a round closes grading and progression while preserving history.</p>
    <div className="flex gap-3"><button className={buttonClass} disabled={disabled || round?.status === 'ended'}>{round ? "Save round" : "Create round"}</button>{round && <button type="button" className={buttonClass} disabled={settingsLocked} onClick={() => void onArchive()}>{round.archived ? 'Restore round' : 'Archive round'}</button>}{round?.status === 'grading' && <button type="button" className={buttonClass} disabled={disabled} onClick={() => void onSave({ configuration_version: round.configuration_version, status: 'ended' })}>End round (read-only)</button>}</div>
  </form>
}
function StandardSetup({ users, disabled, onCreate }: { users: AuthorizedUser[]; disabled: boolean; onCreate: (body: { eligible_grader_emails: string[]; reviews_required: number }) => Promise<void> }) {
  const [emails, setEmails] = useState<string[]>([]), [n, setN] = useState(2)
  const problem = !emails.length ? 'Choose the members who will grade.' : n > emails.length ? `Choose at least ${n} graders, or lower the reviewers per applicant.` : ''
  return <section className="rounded-xl border border-[var(--ps-accent)] p-5 space-y-4" aria-label="Set up PS standard rounds">
    <h2 className="font-semibold">Set up the PS recruitment rounds</h2>
    <ol className="list-decimal pl-5 text-sm space-y-1"><li>Written App / Resume Screening</li><li>PD Design Interview</li><li>Final Round: Take-home + Social</li></ol>
    <p className="text-sm text-[var(--text-muted)]">Each round starts with last semester’s form as a draft rubric, ready to review and publish. Applicants move through the rounds in this order and can’t skip one. You can change graders for each round afterwards.</p>
    <fieldset disabled={disabled}><legend className="text-sm">Graders ({emails.length})</legend><div className="max-h-48 overflow-auto space-y-2 p-2">{users.map(u => <label key={u.email} className="flex gap-2 text-sm"><input type="checkbox" checked={emails.includes(u.email)} onChange={e => setEmails(e.target.checked ? [...emails, u.email] : emails.filter(x => x !== u.email))} />{u.email} · {u.role}</label>)}</div>
      <button type="button" className="text-sm underline" onClick={() => setEmails(users.map(u => u.email))}>Select everyone</button></fieldset>
    <label className="block text-sm max-w-xs">Reviewers per applicant in the Written App round<input type="number" min={1} className={inputClass} disabled={disabled} value={n || ''} onChange={e => setN(Number(e.target.value))} /></label>
    <p className="text-sm text-[var(--text-muted)]">Interview rounds use one form per interviewer pair.</p>
    {problem && <p className="text-sm">{problem}</p>}
    <button className={buttonClass} disabled={disabled || !!problem} onClick={() => void onCreate({ eligible_grader_emails: emails, reviews_required: n })}>Create the three rounds</button>
  </section>
}
