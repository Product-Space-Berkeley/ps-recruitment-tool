'use client'
import { useEffect, useState } from 'react'
import { requestJson } from '@/lib/ps/client'
type Conflict = { applicant_id: string; grader_email: string; reason: string; name: string }
export default function PSConflictInbox({ roundId }: { roundId: string }) {
  const [rows, setRows] = useState<Conflict[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  useEffect(() => {
    let active = true
    const load = () => requestJson<Conflict[]>(`/api/ps/rounds/${roundId}/conflicts`).then(data => { if (active) setRows(data) }).catch(e => { if (active) setError(e.message) })
    void load(); const timer = setInterval(load, 15000)
    return () => { active = false; clearInterval(timer) }
  }, [roundId])
  async function retry(row: Conflict) {
    if (row.reason === 'submitted_review' && !confirm('Exclude this conflicted review from scoring and assign a replacement? The original review will remain in history. Admin access is required.')) return
    setBusy(true); setError('')
    try {
      const result = await requestJson<{ resolved: boolean; message: string }>(`/api/ps/rounds/${roundId}/conflicts`, { applicant_id: row.applicant_id, grader_email: row.grader_email, exclude_submitted: row.reason === 'submitted_review' })
      if (!result.resolved) setError(result.message)
      setRows(await requestJson<Conflict[]>(`/api/ps/rounds/${roundId}/conflicts`))
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return <section className="border border-[var(--border)] rounded-xl p-5 space-y-3"><h2 className="font-semibold">Review conflicts · {rows.length} unresolved</h2>
    <p className="text-sm text-[var(--text-muted)]">Unresolved conflicts block closing grading. Add eligible reviewers in Setup &amp; graders, then retry coverage.</p>
    {rows.map(row => <div key={`${row.applicant_id}:${row.grader_email}`} className="border-t border-[var(--border)] pt-3 text-sm space-y-2"><p>{row.name} · {row.grader_email}</p><p>{row.reason === 'submitted_review' ? 'A review was already submitted. Evidence is preserved; administrative resolution is required.' : 'No eligible replacement available.'}</p><button disabled={busy} onClick={() => void retry(row)} className="underline">{row.reason === 'submitted_review' ? 'Exclude review & reassign (admin)' : 'Retry reassignment'}</button></div>)}
    {error && <p role="alert">{error}</p>}
  </section>
}
