'use client'
import Link from 'next/link'
import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { requestJson } from '@/lib/ps/client'
import type { RecruitmentCycle } from '@/lib/types'
type Score = { complete: boolean; score: number | null; max_points: number | null; percent: number | null; reviews: number; required: number; frozen: boolean } | null
type Roster = { cycle: { id: string; name: string }; rounds: { id: string; name: string }[]; candidates: { id: string; name: string; email: string; year: string | null; round: string | null; state: string | null; score: Score }[] }
const STATES: Record<string, string> = { pending: 'Not started', in_review: 'In review', ready_for_deliberation: 'Ready to decide', advanced: 'Advanced', hold: 'On hold', rejected: 'Rejected', accepted: 'Accepted' }
function RosterPage() {
  const params = useSearchParams(), router = useRouter(), cycleId = params.get('cycle') ?? ''
  const [cycles, setCycles] = useState<RecruitmentCycle[]>([]), [data, setData] = useState<Roster | null>(null), [error, setError] = useState(''), [query, setQuery] = useState('')
  useEffect(() => { requestJson<RecruitmentCycle[]>('/api/cycles').then(setCycles).catch(e => setError(e.message)) }, [])
  useEffect(() => {
    if (!cycleId) return
    let live = true
    requestJson<Roster>(`/api/ps/cycles/${cycleId}/candidates`).then(d => { if (live) { setData(d); setError('') } }).catch(e => { if (live) setError(e.message) })
    return () => { live = false }
  }, [cycleId])
  const loading = !!cycleId && data?.cycle.id !== cycleId && !error
  const q = query.trim().toLowerCase()
  const rows = (data?.candidates ?? []).filter(c => !q || c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q))
  return <main className="mx-auto w-full min-w-0 max-w-4xl p-5 space-y-5 text-[var(--text-primary)]">
    <nav className="flex gap-4 text-sm"><Link href="/dashboard">Dashboard</Link><Link href="/admin/rounds">Recruitment rounds</Link></nav>
    <h1 className="text-2xl font-semibold">Candidates</h1>
    <label className="block max-w-md">Recruitment cycle<select className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-raised)] px-3 py-2" value={cycleId} onChange={e => { setData(null); router.replace(e.target.value ? `/admin/candidates?cycle=${e.target.value}` : '/admin/candidates') }}><option value="">Choose a cycle</option>{cycles.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
    {error && <p role="alert">{error}</p>}
    {loading && <p role="status">Loading candidates…</p>}
    {data && data.cycle.id === cycleId && <>
      <label className="block max-w-md">Search<input className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-raised)] px-3 py-2" placeholder="Name or email" value={query} onChange={e => setQuery(e.target.value)} /></label>
      <p className="text-sm text-[var(--text-muted)]">{rows.length} of {data.candidates.length} applicants</p>
      {!data.candidates.length ? <p>No applicants in this cycle yet.</p> : <div className="overflow-x-auto"><table className="w-full text-sm tabular-nums"><thead><tr className="text-left text-[var(--text-muted)]"><th className="py-2 pr-3">Candidate</th><th className="pr-3">Grade</th><th className="pr-3">Current round</th><th className="pr-3">Status</th><th>Score</th></tr></thead>
        <tbody>{rows.map(c => <tr key={c.id} className="border-t border-[var(--border)]"><td className="py-2 pr-3"><Link className="underline" href={`/admin/candidates/${c.id}`}>{c.name}</Link><span className="block text-xs text-[var(--text-muted)]">{c.email}</span></td><td className="pr-3">{c.year ?? '—'}</td><td className="pr-3">{c.round ?? 'Not enrolled'}</td><td className="pr-3">{c.state ? STATES[c.state] ?? c.state : '—'}</td><td>{c.score?.complete ? `${c.score.score} / ${c.score.max_points} (${c.score.percent}%)` : c.score ? `${c.score.reviews} / ${c.score.required} evaluations` : '—'}</td></tr>)}</tbody></table></div>}
    </>}
  </main>
}
export default function CandidatesPage() { return <Suspense fallback={<p className="p-5">Loading…</p>}><RosterPage /></Suspense> }
