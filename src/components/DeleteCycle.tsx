'use client'
import { useState } from 'react'

export default function DeleteCycle({ id, name, onDeleted }: { id: string; name: string; onDeleted: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function remove() {
    if (typed !== name) return
    setBusy(true); setError('')
    try {
      const res = await fetch(`/api/cycles/${id}`, { method: 'DELETE' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Unable to delete this cycle. Please retry.')
      onDeleted()
    } catch (e) { setError((e as Error).message); setBusy(false) }
  }
  return <section className="border border-[var(--border)] rounded-xl p-4 space-y-3">
    <p>This cycle has ended. Export its data before permanently deleting it.</p>
    {!confirming ? <button className="border border-red-600 rounded-lg px-4 py-2 text-[var(--text-primary)]" onClick={() => setConfirming(true)}>Delete cycle</button> : <>
      <h3 className="font-semibold">Permanently delete {name}?</h3>
      <p className="text-sm">This removes its applicants, essays, rounds, rubrics, reviews, deliberation sessions, votes and notes. This cannot be undone.</p>
      <label className="block text-sm">Type the cycle name to confirm
        <input value={typed} onChange={e => setTyped(e.target.value)} disabled={busy} className="block w-full mt-2 p-2 rounded-lg border border-[var(--border)] bg-[var(--bg-raised)]" />
      </label>
      <div className="flex flex-wrap gap-4">
        <button disabled={busy || typed !== name} onClick={() => void remove()} className="bg-red-700 text-white px-4 py-2 rounded-lg disabled:opacity-50">{busy ? 'Deleting…' : 'Permanently delete cycle'}</button>
        <button disabled={busy} onClick={() => { setConfirming(false); setTyped(''); setError('') }}>Cancel</button>
      </div>
      {error && <p role="alert">{error}</p>}
    </>}
  </section>
}
