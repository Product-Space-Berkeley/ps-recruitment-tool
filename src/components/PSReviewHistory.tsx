'use client'
import { useState } from 'react'
import { requestJson } from '@/lib/ps/client'
import { AnyRubric, isV2 } from '@/lib/ps/rubricCompatibility'
import { PURPOSE_LABELS } from '@/lib/ps/rubricBuilder'
import type { TypedResponse } from '@/lib/ps/rubricV2'
import type { CandidateScore, GraderSummary } from '@/lib/ps/candidateScores'
type Review = { id: string; applicant_id: string; grader_email: string; rubric_version_id: string; schema_version?: number; responses?: TypedResponse[]; ratings: { criterion_id: string; raw_score: number }[]; comments: string; submitted_at: string; score?: number; max_points?: number | null; panel_emails?: string[]; revision?: number; is_current?: boolean }
export default function PSReviewHistory({ roundId }: { roundId: string }) {
  const [reviews, setReviews] = useState<Review[]>([])
  const [names, setNames] = useState<Record<string, string>>({})
  const [rubrics, setRubrics] = useState<AnyRubric[]>([])
  const [aggregates, setAggregates] = useState<{ applicant_id: string; rubric_version_id: string; reviewer_count: number; score: number }[]>([])
  const [candidates, setCandidates] = useState<CandidateScore[]>([]), [graders, setGraders] = useState<GraderSummary[]>([])
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false)
  async function load() {
    setBusy(true); setMessage('')
    try {
      const [rows, enrollment, versions, scores] = await Promise.all([
        requestJson<Review[]>(`/api/ps/reviews?round_id=${roundId}`),
        requestJson<{ enrollments: { applicant_id: string; name: string }[] }>(`/api/ps/rounds/${roundId}/enrollments`),
        requestJson<AnyRubric[]>(`/api/ps/rounds/${roundId}/rubrics`),
        requestJson<{ message: string; version_scores: typeof aggregates; candidates: CandidateScore[]; graders: GraderSummary[] }>(`/api/ps/rounds/${roundId}/scores`),
      ])
      setAggregates(scores.version_scores ?? []); setCandidates(scores.candidates ?? []); setGraders(scores.graders ?? []); setReviews(rows); setNames(Object.fromEntries(enrollment.enrollments.map(e => [e.applicant_id, e.name]))); setRubrics(versions); setMessage(rows.length ? scores.message : 'No reviews submitted yet. PS scoring not configured.')
    } catch (e) { setMessage((e as Error).message) } finally { setBusy(false) }
  }
  return <section className="rounded-xl border border-[var(--border)] p-5 space-y-3">
    <h2 className="font-semibold">Scores and grading history</h2><p className="text-sm">Candidate scores average each grader’s (or pair’s) latest evaluation. A score appears once all of that candidate’s required evaluations are in.</p>
    <button className="rounded-lg border border-[var(--border)] px-3 py-2" disabled={busy} onClick={() => void load()}>{busy ? 'Loading…' : 'Refresh raw reviews'}</button>
    {message && <p role="status">{message}</p>}
    {!!candidates.length && <div className="overflow-x-auto"><table className="w-full text-sm tabular-nums"><caption className="text-left font-semibold py-2">Candidates</caption><thead><tr className="text-left text-[var(--text-muted)]"><th className="py-1 pr-3">Candidate</th><th className="pr-3">Evaluations</th><th className="pr-3">Average</th><th>Range</th></tr></thead><tbody>{[...candidates].sort((a, b) => (b.percent ?? -1) - (a.percent ?? -1)).map(c => <tr key={c.applicant_id} className="border-t border-[var(--border)]"><td className="py-1 pr-3">{names[c.applicant_id] ?? 'Applicant'}</td><td className="pr-3">{c.reviews} / {c.required}</td><td className="pr-3">{c.complete ? `${c.score} / ${c.max_points} (${c.percent}%)` : 'Waiting for evaluations'}</td><td>{c.complete ? `${c.low}–${c.high}` : '—'}</td></tr>)}</tbody></table></div>}
    {!!graders.length && <div className="overflow-x-auto"><table className="w-full text-sm tabular-nums"><caption className="text-left font-semibold py-2">Grader averages</caption><thead><tr className="text-left text-[var(--text-muted)]"><th className="py-1 pr-3">Grader</th><th className="pr-3">Evaluations</th><th className="pr-3">Average</th><th>Spread</th></tr></thead><tbody>{graders.map(g => <tr key={g.grader} className="border-t border-[var(--border)]"><td className="py-1 pr-3">{g.grader}</td><td className="pr-3">{g.reviews}</td><td className="pr-3">{g.average} pts ({g.average_percent}%)</td><td>±{g.spread_percent}%</td></tr>)}</tbody></table><p className="text-xs text-[var(--text-muted)] mt-1">A grader whose average is well above or below the others may be grading more generously or harshly.</p></div>}
    {aggregates.map(g => <p key={`${g.applicant_id}:${g.rubric_version_id}`} className="text-sm">{names[g.applicant_id] ?? 'Applicant'} · rubric v{rubrics.find(r => r.id === g.rubric_version_id)?.version} · {g.reviewer_count} grader(s) · {g.score.toFixed(2)} / 3</p>)}
    {reviews.map(review => { const rubric = rubrics.find(r => r.id === review.rubric_version_id); return <details key={review.id} className="border-t border-[var(--border)] pt-2">
      <summary className="text-sm">{names[review.applicant_id] ?? 'Applicant'} · {review.grader_email}{review.revision && ` · revision ${review.revision}`}{review.is_current === false ? ' · historical' : ' · current'}{review.panel_emails && ` · pair: ${review.panel_emails.join(' & ')}`}{review.score !== undefined && (review.max_points != null ? ` · ${review.score} / ${review.max_points} pts` : ` · ${review.score.toFixed(2)} / 3`)}</summary>
      <p className="text-xs">{rubric?.name ?? 'Rubric'} · version {rubric?.version ?? review.rubric_version_id} · {new Date(review.submitted_at).toLocaleString()}</p>
      {(review.ratings ?? []).map(r => <p key={r.criterion_id} className="text-sm">{(rubric && !isV2(rubric) ? rubric.criteria.find(c => c.id === r.criterion_id)?.name : undefined) ?? r.criterion_id}: {r.raw_score}</p>)}
      {rubric && isV2(rubric) && rubric.categories.map(category => <section key={category.id} className="mt-3"><h3 className="text-sm font-semibold">{category.name}{category.weight_bps !== null && <span className="font-normal"> · {category.weight_bps / 100}%</span>}</h3>{category.description && <p className="text-sm whitespace-pre-wrap text-[var(--text-muted)]">{category.description}</p>}{(review.responses ?? []).filter(r => rubric.questions.some(q => q.id === r.question_id && q.category_id === category.id)).map(r => { const q = rubric.questions.find(q => q.id === r.question_id); return <p key={r.question_id} className="text-sm whitespace-pre-wrap">{q?.label ?? r.question_id}{q?.weight_bps != null && ` (${q.weight_bps / 100}%)`} · {q?.purpose ? PURPOSE_LABELS[q.purpose] : ''}: {Array.isArray(r.value) ? r.value.join(', ') : String(r.value)}</p> })}</section>)}
      <p className="text-sm whitespace-pre-wrap">{review.comments}</p>
    </details> })}
  </section>
}
