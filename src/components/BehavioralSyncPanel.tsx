'use client'

import { useCallback, useEffect, useState } from 'react'

type Person = { id: string; name: string; role: string }
type Preview = { roster: Person[]; resolutions: Record<string, string>; unresolved: { name: string; rows: number[] }[]; incomplete: { name: string; interviewer: string; row: number }[]; source_rows: number; candidates: (Person & { score: number | null; responses: number })[] }
type Status = { connected: boolean; cycle_id?: string; last_success?: string; error?: string; source_rows?: number; incomplete?: Preview['incomplete']; unresolved?: Preview['unresolved']; sessions?: { id: string; role: string }[]; sheet_url?: string; round_ids?: string[]; resolutions?: Record<string, string>; roster?: Person[] }

export default function BehavioralSyncPanel({ cycleId, sessionId, rounds = [], admin = false }: { cycleId?: string; sessionId?: string; rounds?: { id: string; name: string; role: string | null; grading_type: string | null; order_index: number }[]; admin?: boolean }) {
  const [status, setStatus] = useState<Status | null>(null)
  const [url, setUrl] = useState('https://docs.google.com/spreadsheets/d/1KcWZ5zL76xbbxf10qJ91Wu63kdXWgGR3_wGh81Po_Iw/edit?gid=1607991340')
  const [selected, setSelected] = useState<Record<string, string>>({})
  const [resolutions, setResolutions] = useState<Record<string, string>>({})
  const [preview, setPreview] = useState<Preview | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const load = useCallback(async () => {
    const response = await fetch(`/api/behavioral-sync?${sessionId ? `session_id=${sessionId}` : `cycle_id=${cycleId}`}`)
    if (!response.ok) return
    const result: Status = await response.json()
    setStatus(result)
  }, [cycleId, sessionId])
  useEffect(() => {
    const refresh = () => { void load().catch(() => {}) }
    const initial = setTimeout(refresh, 0)
    const timer = setInterval(() => { if (document.visibilityState === 'visible') refresh() }, 30000)
    return () => { clearTimeout(initial); clearInterval(timer) }
  }, [load])

  async function act(action: string) {
    setBusy(true); setMessage('')
    try {
      const roundIds = status?.round_ids ?? ['curriculum', 'developer'].map(role => selected[role] || [...rounds].filter(r => r.role === role && r.grading_type === 'interview').sort((a, b) => b.order_index - a.order_index)[0]?.id)
      const response = await fetch('/api/behavioral-sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, cycle_id: cycleId ?? status?.cycle_id, sheet_url: status?.sheet_url || url, round_ids: roundIds, resolutions: { ...status?.resolutions, ...resolutions } }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Unable to sync.')
      if (result.preview) { setPreview(result.preview); setResolutions(result.preview.resolutions) }
      else { setMessage(result.busy ? 'A sync is already running. Please wait.' : 'Synced both final sessions.'); setPreview(null); await load() }
    } catch (e) { setMessage(e instanceof Error ? e.message : 'Unable to sync.') }
    finally { setBusy(false) }
  }

  if (sessionId && !status?.connected) return null
  return <section className="shrink-0 border border-[var(--border)] rounded-lg bg-[var(--bg-surface)] p-3 text-sm space-y-2">
    <div className="flex flex-wrap items-center gap-3"><strong>Behavioral interview live sync</strong>
      {status?.connected && <span className="text-[var(--text-muted)]">Last synced: {status.last_success ? new Date(status.last_success).toLocaleTimeString() : 'Not yet'} · {status.source_rows ?? 0} responses</span>}
      {status?.connected && admin && <button disabled={busy} onClick={() => void act('sync')} className="border rounded px-3 py-1">{busy ? 'Syncing…' : 'Sync now'}</button>}
    </div>
    {status?.error && <p role="alert" className="text-amber-600">{status.error}</p>}
    {!!status?.incomplete?.length && <details><summary>{status.incomplete.length} incomplete responses (excluded from average)</summary>{status.incomplete.map(r => <p key={r.row}>Row {r.row}: {r.name} — {r.interviewer}</p>)}</details>}
    {!!status?.unresolved?.length && <p className="text-amber-600">Needs matching: {status.unresolved.map(r => r.name).join(', ')}. Open the admin round controls to resolve.</p>}
    {!sessionId && admin && <>
      {!status?.connected && <>
        <label className="block">Behavioral Google Sheet<input aria-label="Behavioral Google Sheet" value={url} onChange={e => { setUrl(e.target.value); setPreview(null) }} className="block w-full border rounded p-2 bg-[var(--bg-raised)]" /></label>
        <div className="flex gap-3">{['curriculum', 'developer'].map(role => <label key={role}>{role} round<select aria-label={`${role} behavioral round`} className="block border rounded p-2 bg-[var(--bg-raised)]" value={selected[role] || [...rounds].filter(r => r.role === role && r.grading_type === 'interview').sort((a, b) => b.order_index - a.order_index)[0]?.id || ''} onChange={e => { setSelected({ ...selected, [role]: e.target.value }); setPreview(null) }}>{rounds.filter(r => r.role === role && r.grading_type === 'interview').map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>)}</div>
      </>}
      <button disabled={busy} onClick={() => void act('preview')} className="border rounded px-3 py-1">Preview / resolve names</button>
      {preview && <div className="space-y-2">
        <p>{preview.source_rows} responses · {preview.roster.filter(p => p.role === 'curriculum').length} Curriculum · {preview.roster.filter(p => p.role === 'developer').length} Developers</p>
        {preview.unresolved.map(row => <label className="block" key={row.name}>{row.name} (rows {row.rows.join(', ')})<select className="ml-2 border rounded bg-[var(--bg-raised)]" value={resolutions[row.name.toLowerCase().trim()] ?? ''} onChange={e => setResolutions({ ...resolutions, [row.name.toLowerCase().trim()]: e.target.value })}><option value="">Choose applicant</option>{preview.roster.map(p => <option key={p.id} value={p.id}>{p.name} — {p.role}</option>)}<option value="exclude">Exclude this name</option></select></label>)}
        <details><summary>Applicant score preview</summary>{preview.candidates.map(p => <p key={p.id}>{p.name} · {p.role}: {p.score === null ? 'Awaiting behavioral scores' : p.score.toFixed(2)} ({p.responses} responses)</p>)}</details>
        {!!preview.incomplete.length && <p>{preview.incomplete.length} incomplete responses will be visible but not scored.</p>}
        <button disabled={busy || preview.unresolved.some(r => !resolutions[r.name.toLowerCase().trim()])} onClick={() => void act('connect')} className="bg-[#FF6B35] text-white rounded px-3 py-2">Connect and sync both final rounds</button>
      </div>}
      {status?.sessions?.map(s => <a key={s.id} href={`/session/${s.id}`} className="inline-block mr-4 underline">Open {s.role} final session</a>)}
    </>}
    {message && <p role="status">{message}</p>}
  </section>
}
