 'use client'
import { useState } from 'react'
import { requestJson } from '@/lib/ps/client'
export default function FinishDecisions({ sessionId }: { sessionId: string }) {
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  return <div><button disabled={busy} className="btn-primary px-4 py-2 rounded-lg disabled:opacity-50" onClick={async () => {
    if (!confirm('Finalize all green/red decisions and close this room? Green applicants advance or receive final acceptance. No emails will be sent.')) return
    setBusy(true); setMessage('')
    try { await requestJson(`/api/ps/sessions/${sessionId}/finish`, {}); window.location.reload() } catch (e) { setMessage((e as Error).message); setBusy(false) }
  }}>{busy ? 'Finishing…' : 'Finish decisions'}</button>{message && <p role="alert">{message}</p>}</div>
}
