'use client'
import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { Round } from '@/lib/types'
import { AnyRubric, isV2 } from '@/lib/ps/rubricCompatibility'
import { isWeighted, scoreEvaluation, type Evaluation } from '@/lib/ps/weightedRubric'
import { isPoints, scorePoints, sectionVisible } from '@/lib/ps/points'
import type { ResponseValue } from '@/lib/ps/rubricV2'
import PSRubricFields from '@/components/PSRubricFields'
import { requestJson } from '@/lib/ps/client'
type Applicant = { id: string; first_name: string; last_name: string; major: string; year: string; time_commitment: string }
type Application = Applicant & { transfer: boolean; desired_roles: string | null; linkedin: string | null; website: string | null; infosessions_attended: string[] }
type Assignment = { id: string; round_id: string; applicant_id: string; partners?: string[] }
type Saved = Evaluation & { max_points?: number | null; panel_emails?: string[]; knows_candidate?: boolean }
// Points reviews store total points with their maximum; older weighted reviews store a 0–3 score.
function scoreText(e: { score: number; max_points?: number | null }) { return e.max_points != null ? `${e.score} / ${e.max_points} pts` : `${e.score.toFixed(2)} / 3` }
type Rounds = { grader_email: string; rounds: (Round & { cycle_name: string })[]; closed_rounds?: string[] }
type Candidate = { applicant_id: string; name: string; first_name: string; last_name: string; major: string; year: string; time_commitment: string; evaluations: number; required: number; status: 'needs_review' | 'in_progress' | 'reviewed'; can_grade: boolean; mine: Saved | null }
type Roster = { grader_email: string; round: { id: string; name: string; grading_access: 'open' | 'assigned'; assignment_mode: string; reviews_required: number }; co_interviewers: string[]; rubric: AnyRubric | null; rubrics: AnyRubric[]; candidates: Candidate[] }
type Tab = 'all' | 'needs' | 'mine'
const STATUS = { needs_review: ['Needs review', 'bg-[var(--bg-raised)]'], in_progress: ['In progress', 'bg-amber-500/15 text-amber-300'], reviewed: ['Reviewed', 'bg-emerald-500/15 text-emerald-300'] } as const
const field = 'w-full rounded-lg border border-[var(--border)] bg-[var(--bg-raised)] px-3 py-2'

// Every candidate in the round. Graders find the person they read or interviewed and grade them.
export default function PSGradePage() {
  const [rounds, setRounds] = useState<Rounds | null>(null), [roundId, setRoundId] = useState(''), [roster, setRoster] = useState<Roster | null>(null)
  const [tab, setTab] = useState<Tab>('all'), [query, setQuery] = useState(''), [open, setOpen] = useState<Candidate | null>(null)
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [loading, setLoading] = useState(true)
  const loadRoster = useCallback(async (id: string) => { try { setRoster(await requestJson<Roster>(`/api/ps/grading/${id}`)); setError('') } catch (e) { setRoster(null); setError((e as Error).message) } }, [])
  const loadRounds = useCallback(async () => {
    try {
      const data = await requestJson<Rounds>('/api/ps/grading'); setRounds(data)
      const next = data.rounds.find(r => r.id === roundId)?.id ?? data.rounds[0]?.id ?? ''
      setRoundId(next); if (next) await loadRoster(next); else setRoster(null)
    } catch (e) { setError((e as Error).message) } finally { setLoading(false) }
  }, [roundId, loadRoster])
  useEffect(() => { void loadRounds() }, []) // eslint-disable-line react-hooks/exhaustive-deps -- load once; later loads are explicit
  const q = query.trim().toLowerCase()
  const candidates = (roster?.candidates ?? []).filter(c => !q || c.name.toLowerCase().includes(q) || c.major.toLowerCase().includes(q))
  const shown = tab === 'mine' ? candidates.filter(c => c.mine) : tab === 'needs' ? candidates.filter(c => c.status !== 'reviewed').sort((a, b) => a.evaluations - b.evaluations || a.name.localeCompare(b.name)) : candidates
  const all = roster?.candidates ?? [], reviewed = all.filter(c => c.status === 'reviewed').length, todo = all.filter(c => c.can_grade && !c.mine && c.status !== 'reviewed').length
  const rubric = open && roster ? roster.rubrics.find(r => r.id === (open.mine?.rubric_version_id ?? roster.rubric?.id)) : undefined
  return <main className="mx-auto w-full min-w-0 max-w-5xl p-5 space-y-5 text-[var(--text-primary)]">
    <nav className="flex gap-4 text-sm"><Link href="/dashboard">Dashboard</Link></nav>
    {loading && <p role="status">Loading…</p>}
    {error && !open && <p role="alert" className="rounded-lg border border-red-400 p-3">{error}</p>}
    {!loading && rounds && !rounds.rounds.length && <section className="rounded-xl border border-[var(--border)] p-6 space-y-2"><h1 className="text-xl font-semibold">Nothing to grade right now</h1>
      <p className="text-sm text-[var(--text-muted)]">{rounds.closed_rounds?.length ? `${rounds.closed_rounds.join(', ')} ${rounds.closed_rounds.length === 1 ? 'is' : 'are'} closed for grading while leadership deliberates.` : 'No round is open for grading yet, or you aren’t a grader for the open round.'} This page will list candidates as soon as leadership opens a round.</p>
      <button className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm" onClick={() => { setLoading(true); void loadRounds() }}>Check again</button></section>}
    {roster && !open && <>
      <header className="flex flex-wrap justify-between gap-3 items-end"><div><p className="text-xs uppercase tracking-wider text-[var(--text-muted)]">{rounds?.rounds.find(r => r.id === roundId)?.cycle_name}</p><h1 className="text-2xl font-semibold">{roster.round.name}</h1></div>
        {(rounds?.rounds.length ?? 0) > 1 && <label className="text-sm">Round<select className={field} value={roundId} onChange={e => { setRoundId(e.target.value); setTab('all'); void loadRoster(e.target.value) }}>{rounds!.rounds.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>}</header>
      {notice && <p role="status" className="rounded-lg border border-[var(--border)] p-3 text-sm">{notice}</p>}
      <dl className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[['Candidates', all.length, 'In this round'], ['Fully reviewed', reviewed, `${all.length ? Math.round(reviewed / all.length * 100) : 0}% have ${roster.round.reviews_required} evaluation${roster.round.reviews_required === 1 ? '' : 's'}`], ['Needs your review', todo, roster.round.grading_access === 'open' ? 'Not yet graded by you' : 'Assigned to you']].map(([label, value, hint]) => <div key={label} className="rounded-xl border border-[var(--border)] p-4"><dt className="text-sm text-[var(--text-muted)]">{label}</dt><dd className="text-3xl font-semibold tabular-nums">{value}</dd><dd className="text-xs text-[var(--text-muted)]">{hint}</dd></div>)}
      </dl>
      <section className="rounded-xl border border-[var(--border)]">
        <div className="flex flex-wrap gap-2 items-center justify-between p-3 border-b border-[var(--border)]">
          <div role="tablist" className="flex flex-wrap gap-1">{([['all', 'All candidates'], ['needs', 'Needs review'], ['mine', 'Reviewed by me']] as [Tab, string][]).map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} className={`rounded-lg px-3 py-2 text-sm ${tab === id ? 'bg-[var(--bg-raised)] font-semibold' : 'text-[var(--text-muted)]'}`} onClick={() => setTab(id)}>{label}</button>)}</div>
          <label className="w-full sm:w-64"><span className="sr-only">Search candidates</span><input className={field} placeholder="Search by name or major" value={query} onChange={e => setQuery(e.target.value)} /></label>
        </div>
        {!shown.length ? <p className="p-5 text-sm text-[var(--text-muted)]">{q ? 'No candidates match your search.' : tab === 'mine' ? 'You haven’t graded anyone in this round yet.' : tab === 'needs' ? 'Every candidate has all their evaluations.' : 'No candidates are in this round yet.'}</p> :
        <div className="relative overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-left text-xs uppercase tracking-wider text-[var(--text-muted)]"><th className="p-3">Candidate</th><th className="p-3">Status</th><th className="p-3">Evaluations</th><th className="p-3">You</th><th className="p-3"><span className="sr-only">Action</span></th></tr></thead>
          <tbody>{shown.map(c => <tr key={c.applicant_id} className="border-t border-[var(--border)]">
            <td className="p-3"><span className="font-medium">{c.name}</span><span className="block text-xs text-[var(--text-muted)]">{[c.major, c.year].filter(Boolean).join(' · ')}</span></td>
            <td className="p-3"><span className={`rounded-full px-2 py-1 text-xs whitespace-nowrap ${STATUS[c.status][1]}`}>{STATUS[c.status][0]}</span></td>
            <td className="p-3 tabular-nums">{c.evaluations} / {c.required}</td>
            <td className="p-3 text-xs">{c.mine ? <>Submitted{c.mine.panel_emails && c.mine.panel_emails.length > 1 ? ` with ${c.mine.panel_emails.filter(e => e !== roster.grader_email).join(', ')}` : ''}</> : '—'}</td>
            <td className="p-3 text-right"><button className="rounded-lg border border-[var(--border)] px-3 py-1.5 whitespace-nowrap disabled:opacity-40" disabled={!c.can_grade || !roster.rubric} title={c.can_grade ? undefined : 'Not assigned to you'} onClick={() => { setOpen(c); setNotice(''); setError('') }}>{c.mine ? 'Update' : 'Review'}</button></td>
          </tr>)}</tbody></table></div>}
      </section>
      {!roster.rubric && <p role="status" className="text-sm">This round has no published rubric yet, so grading isn’t available.</p>}
    </>}
    {roster && open && rubric && <>
      <button className="text-sm underline" onClick={() => { setOpen(null); setError('') }}>← All candidates</button>
      <ReviewForm key={`${open.applicant_id}:${rubric.id}:${open.mine?.revision ?? 0}`} assignment={{ id: open.applicant_id, round_id: roster.round.id, applicant_id: open.applicant_id }} applicant={{ id: open.applicant_id, first_name: open.first_name, last_name: open.last_name, major: open.major, year: open.year, time_commitment: open.time_commitment }} rubric={rubric} interviewer={roster.grader_email} prior={open.mine ?? undefined} coInterviewers={roster.round.grading_access === 'open' ? roster.co_interviewers : undefined} askConflict={roster.round.grading_access === 'open'}
        onComplete={async saved => { await loadRoster(roster.round.id); setOpen(null); if (saved?.score !== undefined) setNotice(`Saved your evaluation of ${open.name} · ${scoreText(saved)}`) }} />
    </>}
  </main>
}
function ReviewForm({ assignment, applicant, rubric, interviewer, prior, coInterviewers, askConflict = false, onComplete }: { assignment: Assignment; applicant: Applicant; rubric: AnyRubric; interviewer: string; prior?: Saved; coInterviewers?: string[]; askConflict?: boolean; onComplete: (saved?: { score: number; max_points?: number | null }) => Promise<void> }) {
  const [co, setCo] = useState(prior?.panel_emails?.find(e => e !== interviewer) ?? ''), [knows, setKnows] = useState(prior?.knows_candidate ?? false)
  const [responses, setResponses] = useState<Record<string, ResponseValue>>(Object.fromEntries((prior?.responses ?? []).map(r => [r.question_id, r.value])))
  const [application, setApplication] = useState<Application | null>(null)
  const [ratings, setRatings] = useState<Record<string, string>>({}), [comments, setComments] = useState(prior?.comments ?? ''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [resume, setResume] = useState<string | null>(null), [resumeLoading, setResumeLoading] = useState(false), [essays, setEssays] = useState<{ prompt: { id: string; prompt: string }; response: string }[] | null>(null), [essaysLoading, setEssaysLoading] = useState(false), [submitted, setSubmitted] = useState(false)
  const control = 'w-full border border-[var(--border)] rounded-lg bg-[var(--bg-raised)] px-3 py-2'
  async function loadResume() { setResumeLoading(true); setError(''); try { const data = await requestJson<{ resume_base64: string | null }>(`/api/applicants/${applicant.id}/resume`); if (!data.resume_base64) throw new Error('No resume uploaded.'); setResume(data.resume_base64) } catch (e) { setError((e as Error).message) } finally { setResumeLoading(false) } }
  async function loadEssays() { setEssaysLoading(true); setError(''); try { const result = await requestJson<{ applicant: Application; essays: { prompt: { id: string; prompt: string }; response: string }[] }>(`/api/applicants/${applicant.id}/essays`); setApplication(result.applicant); setEssays(result.essays) } catch (e) { setError((e as Error).message) } finally { setEssaysLoading(false) } }
  async function submit(e: React.FormEvent) { e.preventDefault(); setBusy(true); setError(''); try { const evaluation = await requestJson<{ score?: number; max_points?: number | null }>('/api/ps/reviews', { round_id: assignment.round_id, applicant_id: assignment.applicant_id, rubric_version_id: rubric.id, revision: prior?.revision ?? 0, ...(coInterviewers?.length ? { co_interviewer: co || null } : {}), ...(askConflict ? { knows_candidate: knows } : {}), ...(isV2(rubric) ? { schema_version: 2, responses: rubric.questions.filter(q => responses[q.id] !== undefined).map(q => ({ question_id: q.id, format: q.format, value: responses[q.id] })) } : { ratings: rubric.criteria.map(c => ({ criterion_id: c.id, raw_score: Number(ratings[c.id]) })) }), comments }); setSubmitted(true); await onComplete(evaluation.score === undefined ? undefined : { score: evaluation.score, max_points: evaluation.max_points }) } catch (e) { setError((e as Error).message) } finally { setBusy(false) } }
  let score: number | null = null, incomplete = '', running: { total: number; max: number; answered: number } | null = null
  const answered = isV2(rubric) ? rubric.questions.filter(q => responses[q.id] !== undefined).map(q => ({ question_id: q.id, format: q.format, value: responses[q.id] })) : []
  if (isV2(rubric) && isWeighted(rubric)) {
    try { score = scoreEvaluation(rubric, answered).score } catch (e) { incomplete = (e as Error).message }
  }
  if (isV2(rubric) && isPoints(rubric)) {
    // Running total from answered point questions; required-field checks happen on submit.
    try { const r = scorePoints({ ...rubric, questions: rubric.questions.map(q => ({ ...q, required: false })) }, answered, applicant.year); running = { total: r.total, max: r.max, answered: r.question_results.length } } catch (e) { incomplete = (e as Error).message }
  }
  return <form onSubmit={e => void submit(e)} className="space-y-5">
    <h2 className="text-xl font-semibold">{applicant.first_name} {applicant.last_name}</h2>{!!assignment.partners?.length && <p className="text-sm">Interviewing with {assignment.partners.join(' & ')}. Either of you can submit; the other can update it afterwards.</p>}<p>{applicant.major} · {applicant.year}</p>{applicant.time_commitment && <p>Time commitments: {applicant.time_commitment}</p>}
    <button type="button" disabled={resumeLoading} className="border border-[var(--border)] rounded-lg px-3 py-2" onClick={() => void loadResume()}>{resumeLoading ? 'Loading resume…' : 'View resume'}</button>
    {resume && <div className="rounded-lg border border-[var(--border)] p-3 space-y-2"><p className="text-sm">Resume available. Open the PDF in a new tab to read alongside this grading form.</p><a className="underline text-sm" href={`/api/applicants/${applicant.id}/resume?format=pdf`} target="_blank" rel="noreferrer">Open resume PDF in a new tab</a></div>}
    <button type="button" disabled={essaysLoading} className="border border-[var(--border)] rounded-lg px-3 py-2" onClick={() => void loadEssays()}>{essaysLoading ? 'Loading application responses…' : 'View application responses'}</button>
    {application && <section aria-label="Application details" className="space-y-2 text-sm"><h3 className="font-semibold">Application details</h3>{application.desired_roles && <p>Applied role: {application.desired_roles}</p>}<p>Transfer student: {application.transfer ? 'Yes' : 'No'}</p>{application.linkedin && <p><a className="underline" href={application.linkedin} target="_blank" rel="noreferrer">LinkedIn</a></p>}{application.website && <p><a className="underline" href={application.website} target="_blank" rel="noreferrer">Website / portfolio</a></p>}{application.infosessions_attended.length > 0 && <p>Information sessions: {application.infosessions_attended.join(', ')}</p>}</section>}
    {essays && <section>{!essays.length && <p>No application responses available.</p>}{essays.map(essay => <details key={essay.prompt.id} className="py-2"><summary>{essay.prompt.prompt}</summary><p className="whitespace-pre-wrap text-sm mt-2">{essay.response}</p></details>)}</section>}
    {prior && <p className="text-sm text-[var(--text-muted)]">Updating revision {prior.revision} using its original rubric version. Previous answers and scores stay in history.</p>}
    <p className="text-sm">{rubric.name} · version {rubric.version}</p>
    {!!coInterviewers?.length && <label className="block max-w-md">Co-interviewer<select className={control} value={co} disabled={busy || submitted} onChange={e => setCo(e.target.value)}><option value="">No co-interviewer</option>{coInterviewers.map(email => <option key={email} value={email}>{email}</option>)}</select><span className="block text-xs text-[var(--text-muted)] mt-1">One form per interview. Your co-interviewer is credited and can update it.</span></label>}
    {askConflict && <label className="flex gap-2 items-start text-sm"><input type="checkbox" className="mt-1" checked={knows} disabled={busy || submitted} onChange={e => setKnows(e.target.checked)} />I know this candidate personally. Leadership sees this flag; it doesn’t change the score.</label>}
    <fieldset disabled={busy || submitted} className="space-y-5">{isV2(rubric) ? <PSRubricFields rubric={rubric} context={{ candidate: `${applicant.first_name} ${applicant.last_name}`, interviewer, year: applicant.year }} values={responses} onChange={(id, value) => setResponses(previous => { const next = { ...previous }; if (value === undefined) delete next[id]; else next[id] = value; return next })} /> : [...rubric.criteria].sort((a, b) => a.order - b.order).map(c => <label key={c.id} className="block space-y-2"><span className="font-medium">{c.name}</span>{c.description && <span className="block text-sm text-[var(--text-muted)]">{c.description}</span>}{c.options.length ? <select required className={control} value={ratings[c.id] ?? ''} onChange={e => setRatings(previous => ({ ...previous, [c.id]: e.target.value }))}><option value="">Select rating</option>{c.options.map(o => <option key={o.value} value={o.value}>{o.label} ({o.value})</option>)}</select> : <input required type="number" className={control} min={c.scale?.min} max={c.scale?.max} step={c.scale?.step} value={ratings[c.id] ?? ''} onChange={e => setRatings(previous => ({ ...previous, [c.id]: e.target.value }))} />}<span className="block text-xs text-[var(--text-muted)]">{c.scale && `${c.scale.min}–${c.scale.max}, step ${c.scale.step}`}{c.weight !== null && ` · Weight: ${c.weight} (scoring not configured)`}</span></label>)}<label className="block">Comments<textarea className={control} maxLength={10000} value={comments} onChange={e => setComments(e.target.value)} /></label></fieldset>
    {error && <p role="alert">{error}</p>}{submitted && <button type="button" className="underline" onClick={() => { setError(''); void onComplete().catch(e => setError(e.message)) }}>Review saved · refresh queue</button>}
    {isV2(rubric) && isWeighted(rubric) && <p role="status" className="text-sm">Weighted round score: {score === null ? '—' : score.toFixed(2)} / 3{incomplete && ` · ${incomplete}`}</p>}
    {running && <p role="status" className="sticky bottom-0 rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] px-4 py-3 text-sm tabular-nums"><span className="font-semibold">{running.total} / {running.max} points</span> so far</p>}
    {isV2(rubric) && isPoints(rubric) && incomplete && <p role="alert" className="text-sm">{incomplete}</p>}
    <button disabled={busy || submitted || !!incomplete || (isV2(rubric) ? (isPoints(rubric) ? rubric.categories.filter(c => sectionVisible(c, applicant.year)).flatMap(c => rubric.questions.filter(q => q.category_id === c.id)) : rubric.questions).some(q => q.required && (responses[q.id] === undefined || (typeof responses[q.id] === 'string' && !String(responses[q.id]).trim()) || (Array.isArray(responses[q.id]) && !(responses[q.id] as string[]).length))) : rubric.criteria.some(c => ratings[c.id] === undefined || ratings[c.id] === ''))} className="rounded-lg bg-[var(--ps-accent)] text-[var(--bg-surface)] px-4 py-2 disabled:opacity-40">{busy ? 'Submitting…' : submitted ? 'Review saved' : prior ? 'Update evaluation' : 'Submit evaluation'}</button>
  </form>
}
