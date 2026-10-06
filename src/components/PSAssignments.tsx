'use client'
import { useState } from 'react'
import { requestJson } from '@/lib/ps/client'
import { Round } from '@/lib/types'
type Preview = { applicants: number; reviews_required: number; mode: 'individual' | 'pair'; total: number; additions: number; removals: number; spread: number; preview_token: string; workload: { email: string; count: number }[] }
export default function PSAssignments({ round, readOnly = false, onChange }: { round: Round; readOnly?: boolean; onChange: () => Promise<void> }) {
  const [preview, setPreview] = useState<Preview | null>(null), [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  async function run(commit: boolean) {
    setBusy(true); setMessage('')
    try {
      if (commit) { const result = await requestJson<{ added: number; removed: number }>(`/api/ps/rounds/${round.id}/assignments`, { preview_token: preview?.preview_token }); setMessage(`Added ${result.added} and released ${result.removed} unstarted assignments. Started and completed work was kept.`); setPreview(null); await onChange() }
      else setPreview(await requestJson<Preview>(`/api/ps/rounds/${round.id}/assignments`))
    } catch (e) { setMessage((e as Error).message); setPreview(null) } finally { setBusy(false) }
  }
  const disabled = busy || readOnly || round.archived || !['pending', 'grading'].includes(round.status)
  return <section className="rounded-xl border border-[var(--border)] p-5 space-y-3"><h2 className="font-semibold">Grader assignments</h2><p className="text-sm">The first round assigns every cycle applicant; later rounds assign applicants advanced into them. After changing graders, pairs or reviews per candidate, preview and generate again. Started and completed work is never moved.</p><button className="rounded-lg border border-[var(--border)] px-3 py-2 disabled:opacity-40" disabled={disabled} onClick={() => void run(false)}>Preview assignments</button>
    {preview && <><p>{preview.applicants} active applicants × {preview.reviews_required} {preview.mode === 'pair' ? 'pair' : 'review'}{preview.reviews_required === 1 ? '' : 's'} · {preview.total} total · {preview.additions} new{preview.removals ? ` · ${preview.removals} unstarted released` : ''}</p>{preview.spread > 1 && <p>Existing frozen work prevents an even workload. All existing assignments are preserved.</p>}<div className="max-h-48 overflow-auto">{preview.workload.map(w => <p key={w.email} className="text-sm">{w.email}: {w.count}</p>)}</div><button disabled={disabled || !preview.applicants} className="rounded-lg bg-[var(--ps-accent)] px-3 py-2 text-white disabled:opacity-40" onClick={() => void run(true)}>Generate assignments</button></>}
    {message && <p role="status">{message}</p>}
  </section>
}
