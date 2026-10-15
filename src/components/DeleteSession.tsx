'use client'
import { useState } from 'react'
export default function DeleteSession({ id, name, onDeleted }: { id: string; name: string; onDeleted: () => void }) {
  const [confirming, setConfirming] = useState(false), [typed, setTyped] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  async function remove() {
    if (typed !== id) return
    setBusy(true); setError('')
    try {
      const response = await fetch(`/api/sessions/${id}`, { method: 'DELETE' })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Unable to delete. Please retry.')
      onDeleted()
    } catch (error) { setError((error as Error).message); setBusy(false) }
  }
  return <div className="px-4 pb-3 text-sm">
    {!confirming ? <button className="underline underline-offset-4 text-[var(--text-muted)]" onClick={() => setConfirming(true)}>Delete session</button> : <div className="space-y-3 border-t border-[var(--border)] pt-3">
      <p className="font-semibold">Permanently delete {name}?</p>
      <p>This removes this meeting’s roster, votes, notes and memberships. Applications, round scores and progression decisions remain. This cannot be undone.</p>
      <label className="block">Type session code <strong>{id}</strong> to confirm<input className="block mt-2 w-full border border-[var(--border)] rounded-lg p-2 bg-[var(--bg-raised)]" value={typed} disabled={busy} onChange={event => setTyped(event.target.value)} /></label>
      <div className="flex gap-4"><button disabled={busy || typed !== id} onClick={() => void remove()} className="rounded-lg px-3 py-2 bg-red-700 text-white disabled:opacity-50">{busy ? 'Deleting…' : 'Permanently delete session'}</button><button disabled={busy} onClick={() => { setConfirming(false); setTyped(''); setError('') }}>Cancel</button></div>
      {error && <p role="alert">{error}</p>}
    </div>}
  </div>
}
