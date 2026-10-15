'use client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { requestJson } from '@/lib/ps/client'
import { Round } from '@/lib/types'
type Enrollment = { id: string; applicant_id: string; name: string; state: string; completed_reviews: number; score: number | null; events: { action: string; actor: string; at: string }[] }
type Data = { next_round: Round | null; reviews_required: number; enrollments: Enrollment[] }
export default function PSProgression({ round, readOnly = false, firstRound = false, revision = 0, onChange }: { round: Round; readOnly?: boolean; firstRound?: boolean; revision?: number; onChange: () => Promise<void> }) {
  const router = useRouter()
  async function openRoom() {
    setBusy(true); setMessage('')
    try { const room = await requestJson<{ id: string }>(`/api/ps/rounds/${round.id}/deliberation`, {}); router.push(`/session/${room.id}`) }
    catch (e) { setMessage((e as Error).message) } finally { setBusy(false) }
  }
  const [data, setData] = useState<Data | null>(null), [message, setMessage] = useState(''), [busy, setBusy] = useState(false)
  useEffect(() => { let active = true; requestJson<Data>(`/api/ps/rounds/${round.id}/enrollments`).then(d => { if (active) setData(d) }).catch(e => { if (active) setMessage(e.message) }); return () => { active = false } }, [round.id, round.status, revision])
  async function act(action: string, applicant_id?: string) {
    if (readOnly) return
    setBusy(true); setMessage('')
    try { await requestJson(`/api/ps/rounds/${round.id}/enrollments`, { action, applicant_id }); setData(await requestJson<Data>(`/api/ps/rounds/${round.id}/enrollments`)); await onChange(); setMessage(action === 'enroll' ? 'Cycle applicants enrolled. Existing history retained.' : 'Round decision saved.') } catch (e) { setMessage((e as Error).message) } finally { setBusy(false) }
  }
  return <section className="rounded-xl border border-[var(--border)] p-5 space-y-3"><h2 className="font-semibold">Deliberation and decisions</h2><p className="text-sm">Close grading to freeze scores before deciding. In the live room, green and red are provisional. Only the host can finish decisions after every yellow is resolved. Finishing advances green candidates, or admits them in the final round.</p><button disabled={busy || readOnly || !firstRound || round.archived || !['pending', 'grading'].includes(round.status)} className="border border-[var(--border)] rounded-lg px-3 py-2 disabled:opacity-40" onClick={() => void act('enroll')}>Enroll cycle applicants (first round)</button>
    <button disabled={busy} className="border border-[var(--border)] rounded-lg px-3 py-2" onClick={() => { setBusy(true); requestJson<Data>(`/api/ps/rounds/${round.id}/enrollments`).then(setData).catch(e => setMessage(e.message)).finally(() => setBusy(false)) }}>Refresh enrollment</button>
    <div className="flex flex-wrap gap-3">
      <button className="border border-[var(--border)] rounded-lg px-3 py-2 disabled:opacity-40" disabled={busy || readOnly || round.archived || round.status !== 'deliberating'} onClick={() => void openRoom()}>Open live deliberation</button>
      <a className="underline py-2" href={`/api/ps/rounds/${round.id}/deliberation?format=csv`}>Export decisions CSV</a>
    </div>
    {data && <><p className="text-sm">{data.next_round ? `Advance to: ${data.next_round.name}${data.next_round.status === 'ended' ? ' (ended; enrollment is closed)' : ''}` : 'Final round: Accept records admission to Product Space.'}</p>{!data.enrollments.length && <p>No applicants enrolled yet.</p>}<div className="max-h-96 overflow-auto space-y-3">{data.enrollments.map(row => <div key={row.id} className="border-t border-[var(--border)] py-3"><p><Link className="underline" href={`/admin/candidates/${row.applicant_id}`}>{row.name}</Link> · {row.state === 'ready_for_deliberation' ? 'Ready for human review' : row.state.replaceAll('_', ' ')}</p><p className="text-sm">{row.completed_reviews} / {data.reviews_required} reviews submitted · Frozen score: {row.score ?? 'Unavailable'}</p><details className="text-xs mt-2"><summary>Round history ({row.events.length})</summary>{row.events.map((event, i) => <p key={i}>{event.action} · {event.actor} · {new Date(event.at).toLocaleString()}</p>)}</details></div>)}</div></>}
    {message && <p role="status">{message}</p>}
  </section>
}
