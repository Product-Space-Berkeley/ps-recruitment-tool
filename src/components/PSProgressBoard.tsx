'use client'
import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { requestJson } from '@/lib/ps/client'
import type { Round } from '@/lib/types'
type Progress = { status: string; mode: 'individual' | 'pair'; reviews_required: number; candidates: number; ready: number; evaluations_done: number; evaluations_needed: number; incomplete: { applicant_id: string; name: string }[]; grading_access: 'open' | 'assigned'; graders: { grader: string; assigned: number | null; done: number; remaining: number | null; last_active: string | null }[] }
const button = 'rounded-lg border border-[var(--border)] px-3 py-2 text-sm disabled:opacity-40'
function ago(iso: string | null) {
  if (!iso) return 'No evaluations yet'
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)
  return days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : `${days} days ago`
}
// Round progress for leadership: who still owes evaluations, and the Close / Reopen controls.
export default function PSProgressBoard({ round, readOnly = false, revision = 0, onChange }: { round: Round; readOnly?: boolean; revision?: number; onChange: () => Promise<void> }) {
  const [data, setData] = useState<Progress | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [confirming, setConfirming] = useState(false), [message, setMessage] = useState('')
  const load = useCallback(async () => { try { setData(await requestJson<Progress>(`/api/ps/rounds/${round.id}/progress`)); setError('') } catch (e) { setError((e as Error).message) } }, [round.id])
  useEffect(() => { void load() }, [load, round.status, revision])
  async function act(path: 'close' | 'reopen' | 'start', body: Record<string, unknown> = {}) {
    setBusy(true); setMessage(''); setError('')
    try {
      const result = await requestJson<{ frozen?: number; incomplete?: number; candidates?: number }>(`/api/ps/rounds/${round.id}/${path}`, body)
      setConfirming(false)
      setMessage(path === 'start' ? `Grading is open. ${result.candidates} candidate${result.candidates === 1 ? '' : 's'} can now be graded from the grading page.` : path === 'close' ? `Grading closed. Scores frozen for ${result.frozen} candidate${result.frozen === 1 ? '' : 's'}${result.incomplete ? `, ${result.incomplete} incomplete` : ''}.` : 'Grading reopened. Close the round again to freeze updated scores.')
      await onChange(); await load()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const unit = data?.mode === 'pair' ? 'Pair' : 'Grader'
  const pct = data && data.evaluations_needed ? Math.round(data.evaluations_done / data.evaluations_needed * 100) : 0
  return <section aria-label="Round progress" className="rounded-xl border border-[var(--border)] p-5 space-y-4">
    <div className="flex flex-wrap justify-between gap-3 items-start"><div><h2 className="font-semibold">Round progress</h2><p className="text-sm text-[var(--text-muted)]">{round.status === 'grading' ? 'Grading is open.' : round.status === 'deliberating' ? 'Grading is closed and scores are frozen for deliberation.' : round.status === 'ended' ? 'This round has ended.' : round.grading_access === 'open' ? (round.rubric_version_id ? 'Ready to start. Graders will see every candidate once grading starts.' : 'Publish a rubric, then start grading.') : 'Grading starts when you generate assignments.'}</p></div>
      <div className="flex gap-2"><button className={button} disabled={busy} onClick={() => void load()}>Refresh</button>
        {round.status === 'pending' && round.grading_access === 'open' && <button className="rounded-lg bg-[var(--ps-accent)] px-3 py-2 text-sm text-white disabled:opacity-40" disabled={busy || readOnly || !round.rubric_version_id} title={round.rubric_version_id ? undefined : 'Publish a rubric first'} onClick={() => void act('start')}>Start grading</button>}
        {round.status === 'grading' && <button className="rounded-lg bg-[var(--ps-accent)] px-3 py-2 text-sm text-white disabled:opacity-40" disabled={busy || readOnly || !data} onClick={() => data?.incomplete.length ? setConfirming(true) : void act('close')}>Close grading</button>}
        {round.status === 'deliberating' && <button className={button} disabled={busy || readOnly} onClick={() => void act('reopen')}>Reopen grading</button>}</div></div>
    {error && <p role="alert" className="text-sm">{error}</p>}{message && <p role="status" className="text-sm">{message}</p>}
    {confirming && data && <div role="alertdialog" aria-label="Close grading with incomplete candidates?" className="rounded-lg border border-[var(--ps-accent)] p-4 space-y-3 text-sm">
      <p>{data.incomplete.length} candidate{data.incomplete.length === 1 ? ' is' : 's are'} still missing evaluations. Their scores will be frozen as incomplete, with no average shown:</p>
      <ul className="list-disc pl-5 max-h-32 overflow-auto">{data.incomplete.map(c => <li key={c.applicant_id}><Link className="underline" href={`/admin/candidates/${c.applicant_id}`}>{c.name}</Link></li>)}</ul>
      <div className="flex gap-2"><button className={button} onClick={() => setConfirming(false)}>Keep grading open</button><button className={button} disabled={busy} onClick={() => void act('close', { override: true })}>Close anyway</button></div>
    </div>}
    {data && <>
      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm tabular-nums">
        <div><dt className="text-[var(--text-muted)]">Evaluations</dt><dd className="text-lg font-semibold">{data.evaluations_done} / {data.evaluations_needed} <span className="text-sm font-normal">({pct}%)</span></dd></div>
        <div><dt className="text-[var(--text-muted)]">Candidates ready</dt><dd className="text-lg font-semibold">{data.ready} / {data.candidates}</dd></div>
        <div><dt className="text-[var(--text-muted)]">{data.mode === 'pair' ? 'Pairs per candidate' : 'Reviews per candidate'}</dt><dd className="text-lg font-semibold">{data.reviews_required}</dd></div>
      </dl>
      <div className="h-2 rounded-full bg-[var(--bg-raised)] overflow-hidden" aria-hidden="true"><div className="h-full bg-[var(--ps-accent)]" style={{ width: `${pct}%` }} /></div>
      {data.graders.length ? <div className="overflow-x-auto"><table className="w-full text-sm tabular-nums"><thead><tr className="text-left text-[var(--text-muted)]"><th className="py-1 pr-3">{unit}</th><th className="pr-3">Done</th><th className="pr-3">Remaining</th><th>Last evaluation</th></tr></thead>
        <tbody>{data.graders.map(g => <tr key={g.grader} className="border-t border-[var(--border)]"><td className="py-1 pr-3 break-all">{g.grader}</td><td className="pr-3">{g.assigned === null ? g.done : `${g.done} / ${g.assigned}`}</td><td className="pr-3">{g.remaining === null ? '—' : g.remaining ? <span className="font-semibold">{g.remaining}</span> : 'Done'}</td><td>{ago(g.last_active)}</td></tr>)}</tbody></table></div>
        : <p className="text-sm text-[var(--text-muted)]">{data.grading_access === 'open' ? 'No eligible graders yet. Add them under Setup & graders.' : 'No assignments yet. Generate them under Setup & graders.'}</p>}
      {data.grading_access === 'open' && <p className="text-xs text-[var(--text-muted)]">Open grading: graders choose candidates from the grading page. Candidates with the fewest evaluations are listed first under Needs review.</p>}
    </>}
  </section>
}
