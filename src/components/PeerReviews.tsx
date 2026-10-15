'use client'
import { useState } from 'react'
import { requestJson } from '@/lib/ps/client'
type Review = { id: string; applicant_id: string; grader_email: string; score?: number; max_points?: number; comments: string; is_current: boolean }
export default function PeerReviews({ roundId, applicantId }: { roundId: string; applicantId: string }) {
  const [rows, setRows] = useState<Review[] | null>(null), [error, setError] = useState('')
  async function load() {
    try { setRows((await requestJson<Review[]>(`/api/ps/reviews?round_id=${roundId}`)).filter(r => r.applicant_id === applicantId && r.is_current)); setError('') }
    catch (e) { setError((e as Error).message) }
  }
  return <div className="mt-2 text-left text-xs"><button className="underline" onClick={() => rows ? setRows(null) : void load()}>{rows ? 'Hide reviews' : 'View completed reviews'}</button>
    {rows?.map(row => <div className="mt-2 space-y-1 border-t border-[var(--border)] pt-2" key={row.id}><p>{row.grader_email}</p><p>{row.score ?? 'Unscored'}{row.max_points != null ? ` / ${row.max_points}` : ''}</p><p className="whitespace-pre-wrap">{row.comments || 'No comments'}</p></div>)}
    {error && <p role="alert">{error}</p>}
  </div>
}
