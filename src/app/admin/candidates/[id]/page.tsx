'use client'
import Link from 'next/link'
import { use, useEffect, useState } from 'react'
import { requestJson } from '@/lib/ps/client'
import type { Category, Question, ResponseValue } from '@/lib/ps/rubricV2'
type Score = { complete: boolean; score: number | null; percent: number | null; low: number | null; high: number | null; max_points: number | null; reviews: number; required: number; frozen: boolean; frozen_at?: string } | null
type Evaluation = { id: string; submitted_by: string; panel_emails: string[] | null; revision: number; submitted_at: string; score: number; max_points: number | null; percent: number | null; section_totals: { category_id: string; points: number; max: number }[]; responses: { question_id: string; value: ResponseValue }[]; comments: string; rubric_version_id: string; knows_candidate?: boolean }
type Stage = { round: { id: string; name: string; status: string; assignment_mode: string; reviews_required: number }; enrolled: boolean; state: string | null; decision_by: string | null; decision_at: string | null; events: { action: string; actor: string; at: string }[]; score: Score; evaluations: Evaluation[]; revisions: number }
type Profile = { applicant: { id: string; name: string; email: string; year: string | null; transfer: boolean; major: string | null; applied_at: string | null }; cycle: { id: string; name: string } | null; current_round: string | null; timeline: Stage[]; rubrics: { id: string; name: string; version: number; categories: Category[]; questions: Question[] }[] }
const STATES: Record<string, string> = { pending: 'Not started', in_review: 'In review', ready_for_deliberation: 'Ready to decide', advanced: 'Advanced', hold: 'On hold', rejected: 'Rejected', accepted: 'Accepted' }
const date = (iso: string | null) => iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''
function answer(q: Question | undefined, value: ResponseValue) {
  if (!q) return String(value)
  if (q.format === 'numeric_choice') { const o = q.options.find(o => o.value === value); return o?.label ? `${value} · ${o.label}` : String(value) }
  if (q.format === 'single_choice') return q.options.find(o => o.value === value)?.label ?? String(value)
  if (Array.isArray(value)) return value.map(v => q.options.find(o => o.value === v)?.label ?? v).join(', ')
  return String(value)
}
function EvaluationCard({ e, rubric }: { e: Evaluation; rubric?: Profile['rubrics'][number] }) {
  const by = e.panel_emails ? e.panel_emails.join(' & ') : e.submitted_by
  return <details className="rounded-lg border border-[var(--border)] p-3">
    <summary className="cursor-pointer text-sm flex flex-wrap justify-between gap-2"><span>{by}{e.knows_candidate && <span className="ml-2 rounded-full border border-amber-400 px-2 text-xs text-amber-300">Knows candidate</span>}</span><span className="tabular-nums">{e.max_points != null ? `${e.score} / ${e.max_points} pts` : `${e.score.toFixed(2)} / 3`}</span></summary>
    <p className="text-xs text-[var(--text-muted)] mt-2">{rubric ? `${rubric.name} v${rubric.version}` : 'Rubric'} · submitted {new Date(e.submitted_at).toLocaleString()}{e.revision > 1 ? ` · revision ${e.revision}` : ''}</p>
    {rubric?.categories.map(c => {
      const answers = e.responses.filter(r => rubric.questions.find(q => q.id === r.question_id)?.category_id === c.id)
      if (!answers.length) return null
      const total = e.section_totals.find(t => t.category_id === c.id)
      return <section key={c.id} className="mt-3"><h4 className="text-sm font-semibold flex justify-between gap-2"><span>{c.name}</span>{total && <span className="font-normal tabular-nums">{total.points} / {total.max}</span>}</h4>
        <dl className="text-sm space-y-1 mt-1">{answers.map(r => { const q = rubric.questions.find(q => q.id === r.question_id); return <div key={r.question_id} className="flex flex-col sm:flex-row sm:justify-between gap-x-4"><dt className="text-[var(--text-muted)] min-w-0 sm:flex-1">{q?.label ?? r.question_id}</dt><dd className="whitespace-pre-wrap break-words min-w-0 sm:max-w-[55%] sm:text-right">{q?.format === 'url' ? <a className="underline break-all" href={String(r.value)} target="_blank" rel="noreferrer">Open link</a> : answer(q, r.value)}</dd></div> })}</dl></section>
    })}
    {e.comments && <p className="text-sm whitespace-pre-wrap mt-3">{e.comments}</p>}
  </details>
}
export default function CandidateProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const [data, setData] = useState<Profile | null>(null), [error, setError] = useState('')
  useEffect(() => { let live = true; requestJson<Profile>(`/api/ps/candidates/${id}`).then(d => { if (live) setData(d) }).catch(e => { if (live) setError(e.message) }); return () => { live = false } }, [id])
  if (error) return <main className="mx-auto max-w-3xl p-5"><p role="alert">{error}</p><Link className="underline" href="/admin/candidates">Back to candidates</Link></main>
  if (!data) return <main className="mx-auto max-w-3xl p-5"><p role="status">Loading candidate…</p></main>
  const a = data.applicant
  return <main className="mx-auto w-full min-w-0 max-w-3xl p-5 space-y-5 text-[var(--text-primary)]">
    <nav className="flex gap-4 text-sm"><Link href={data.cycle ? `/admin/candidates?cycle=${data.cycle.id}` : '/admin/candidates'}>All candidates</Link><Link href="/admin/rounds">Recruitment rounds</Link></nav>
    <header className="space-y-1"><h1 className="text-2xl font-semibold">{a.name}</h1>
      <p className="text-sm text-[var(--text-muted)] break-all">{a.email}</p>
      <p className="text-sm">{[a.year && `${a.year}${a.transfer ? ' (transfer)' : ''}`, a.major, data.cycle?.name, a.applied_at && `Applied ${date(a.applied_at)}`].filter(Boolean).join(' · ')}</p>
      <p className="text-sm">Current round: <span className="font-semibold">{data.current_round ?? 'Not enrolled yet'}</span></p></header>
    <ol className="space-y-4">{data.timeline.map(stage => {
      const s = stage.score
      return <li key={stage.round.id} className={`rounded-xl border border-[var(--border)] p-5 space-y-3 ${stage.enrolled ? '' : 'opacity-60'}`}>
        <div className="flex flex-wrap justify-between gap-2 items-start"><h2 className="font-semibold">{stage.round.name}</h2>{stage.state && <span className="text-sm rounded-full border border-[var(--border)] px-3 py-0.5">{STATES[stage.state] ?? stage.state}</span>}</div>
        {!stage.enrolled ? <p className="text-sm">Not reached yet.</p> : <>
          <p className="text-sm tabular-nums">{s?.complete ? <><span className="font-semibold">{s.score} / {s.max_points} pts ({s.percent}%)</span>{stage.round.reviews_required > 1 && ` · range ${s.low}–${s.high}`}</> : `${s?.reviews ?? stage.evaluations.length} / ${stage.round.reviews_required} evaluations in · score shown once all are in`}{s?.frozen && ` · frozen ${date(s.frozen_at ?? null)}`}</p>
          {stage.decision_by && <p className="text-sm">Decision by {stage.decision_by} on {date(stage.decision_at)}</p>}
          {stage.evaluations.length ? <div className="space-y-2">{stage.evaluations.map(e => <EvaluationCard key={e.id} e={e} rubric={data.rubrics.find(r => r.id === e.rubric_version_id)} />)}</div> : <p className="text-sm text-[var(--text-muted)]">No evaluations submitted yet.</p>}
          {stage.events.length > 0 && <details className="text-xs"><summary className="cursor-pointer">History ({stage.events.length})</summary>{stage.events.map((ev, i) => <p key={i}>{ev.action} · {ev.actor} · {new Date(ev.at).toLocaleString()}</p>)}</details>}
        </>}
      </li>
    })}</ol>
    {!data.timeline.length && <p>No PS rounds are set up for this cycle yet.</p>}
  </main>
}
