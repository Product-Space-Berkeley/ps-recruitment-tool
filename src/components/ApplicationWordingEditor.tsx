'use client'
import { useState } from 'react'
import { applicationWording } from '@/lib/applicationWording'
import type { RecruitmentCycle } from '@/lib/types'

export default function ApplicationWordingEditor({ cycle, onSaved }: { cycle: RecruitmentCycle; onSaved: (cycle: RecruitmentCycle) => void }) {
  const [value, setValue] = useState(() => applicationWording(cycle.application_wording))
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  const locked = cycle.status === 'ended' || cycle.accepting_applications || (cycle.submission_count ?? 0) > 0
  async function save() {
    setBusy(true); setMessage('')
    try {
      const response = await fetch(`/api/cycles/${cycle.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ application_wording: value }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Unable to save. Please retry.')
      onSaved(data); setMessage('Application wording saved.')
    } catch (error) { setMessage((error as Error).message) } finally { setBusy(false) }
  }
  return <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-5 space-y-4">
    <h2 className="font-semibold">Application commitments</h2>
    <p className="text-sm text-[var(--text-muted)]">Edit the meeting, retreat and time commitments shown on this cycle’s application. Close applications to edit. Changes lock after the first submission.</p>
    <fieldset disabled={locked || busy} className="space-y-4 disabled:opacity-60">
      {([['meeting_prompt', 'General meeting prompt'], ['retreat_prompt', 'Retreat prompt'], ['availability_hint', 'Scheduling conflict explanation']] as const).map(([key, label]) => <label key={key} className="block text-sm">{label}<textarea rows={3} maxLength={2000} value={value[key]} onChange={event => setValue(previous => ({ ...previous, [key]: event.target.value }))} className="block w-full mt-2 rounded-lg border border-[var(--border)] bg-[var(--bg-raised)] p-3" /></label>)}
      <label className="block text-sm">Required hours per week<input type="number" min={1} max={168} step={1} value={value.weekly_hours} onChange={event => setValue(previous => ({ ...previous, weekly_hours: Number(event.target.value) }))} className="block mt-2 w-28 rounded-lg border border-[var(--border)] bg-[var(--bg-raised)] p-3" /></label>
      <button onClick={() => void save()} className="ps-gradient text-white rounded-lg px-4 py-2">{busy ? 'Saving…' : 'Save application wording'}</button>
    </fieldset>
    {locked && <p className="text-sm">{cycle.accepting_applications ? 'Close applications above to edit these settings.' : 'These settings are locked for this cycle.'}</p>}
    {message && <p role="status" className="text-sm">{message}</p>}
  </section>
}
