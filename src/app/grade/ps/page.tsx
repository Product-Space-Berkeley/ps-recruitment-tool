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
type Saved = Evaluation & { max_points?: number | null }
// Points reviews store total points with their maximum; older weighted reviews store a 0–3 score.
function scoreText(e: { score: number; max_points?: number | null }) { return e.max_points != null ? `${e.score} / ${e.max_points} pts` : `${e.score.toFixed(2)} / 3` }
type Queue = { grader_email: string; rounds: (Round & { cycle_name: string })[]; assignments: Assignment[]; applicants: Applicant[]; rubrics: AnyRubric[]; completed: number; evaluations: Saved[]; progress: { round_id: string; completed: number; total: number; pending: number }[] }
export default function PSGradePage() {
  const [data, setData] = useState<Queue | null>(null), [roundId, setRoundId] = useState(''), [error, setError] = useState(''), [loading, setLoading] = useState(true), [editingId, setEditingId] = useState(''), [notice, setNotice] = useState('')
  const acceptQueue = useCallback((queue: Queue) => {
    setData(queue)
    setRoundId(previous => queue.rounds.some(r => r.id === previous) ? previous : queue.assignments[0]?.round_id ?? queue.rounds[0]?.id ?? '')
  }, [])
  async function refreshQueue() {
    setError(''); setLoading(true)
    try { acceptQueue(await requestJson<Queue>('/api/ps/grading')) } catch (e) { setError((e as Error).message) } finally { setLoading(false) }
  }
  useEffect(() => { let active = true; requestJson<Queue>('/api/ps/grading').then(d => { if (active) { acceptQueue(d) } }).catch(e => { if (active) setError(e.message) }).finally(() => { if (active) setLoading(false) }); return () => { active = false } }, [acceptQueue])
  const prior = data?.evaluations?.find(e => e.id === editingId && e.round_id === roundId)
  const round = data?.rounds.find(r => r.id === roundId), assignment = prior ? { id: prior.id, round_id: prior.round_id, applicant_id: prior.applicant_id } : data?.assignments.find(a => a.round_id === roundId)
  const applicant = data?.applicants.find(a => a.id === assignment?.applicant_id), rubric = data?.rubrics.find(r => r.id === (prior?.rubric_version_id ?? round?.rubric_version_id))
  const progress = data?.progress.find(row => row.round_id === roundId)
  const closed = progress ? Math.max(0, progress.total - progress.completed - progress.pending) : 0
  return <main className="mx-auto w-full min-w-0 max-w-3xl p-5 space-y-5 text-[var(--text-primary)]">
    <nav className="flex gap-4 text-sm"><Link href="/dashboard">Dashboard</Link><Link href="/grade">Legacy grading queue</Link></nav><h1 className="text-2xl font-semibold">PS grading</h1><p className="text-sm text-[var(--text-muted)]">Review one candidate at a time. Your points total updates as you answer. You can update a submitted evaluation until the round ends.</p>
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}<button type="button" disabled={loading} className="border border-[var(--border)] rounded-lg px-3 py-2 disabled:opacity-40" onClick={() => void refreshQueue()}>Refresh grading queue</button>
    {loading && !data ? <p role="status">Loading assignments…</p> : data && <>
      {!data.rounds.length ? <p role="status">No active PS grading assignments. Check back when leadership opens a round.</p> : <label className="block">Current round<select className="w-full border border-[var(--border)] rounded-lg bg-[var(--bg-raised)] px-3 py-2" value={roundId} onChange={e => { setEditingId(''); setRoundId(e.target.value) }}>{data.rounds.map(r => <option key={r.id} value={r.id}>{r.name} · {r.cycle_name}</option>)}</select></label>}
      {round && <section aria-label="Round progress" className="rounded-lg border border-[var(--border)] p-3"><h2 className="font-semibold">{round.name}</h2><p className="text-sm text-[var(--text-muted)]">{round.cycle_name}</p>{progress && <p role="status">{progress.completed} / {progress.total} completed · {progress.pending} remaining</p>}{closed > 0 && <p className="text-sm">{closed} assignment(s) closed by a round decision.</p>}</section>}
      {round && !rubric && <p role="status" className="rounded-xl border border-[var(--border)] p-5">Rubric not configured. Ask leadership to configure a rubric for this round.</p>}
      {rubric && applicant && assignment && <ReviewForm key={`${assignment.id}:${rubric.id}:${prior?.revision ?? 0}`} assignment={assignment} applicant={applicant} rubric={rubric} interviewer={data.grader_email} prior={prior} onComplete={async saved => { const next = await requestJson<Queue>('/api/ps/grading'); acceptQueue(next); setEditingId(''); if (saved?.score !== undefined) setNotice(`Evaluation saved · ${scoreText(saved)}`) }} />}
      {round && rubric && !assignment && <p role="status" className="rounded-xl border border-[var(--border)] p-5">No assignments remaining in {round.name}. Your submitted reviews are saved. {data.assignments.length > 0 ? 'Select another round to continue.' : 'You’re caught up with all available PS assignments.'}</p>}
      {!!data.evaluations?.filter(e => e.round_id === roundId).length && <section aria-label="Your submitted evaluations" className="rounded-xl border border-[var(--border)] p-5 space-y-3"><h2 className="font-semibold">Your submitted evaluations</h2>{data.evaluations.filter(e => e.round_id === roundId).map(e => { const a = data.applicants.find(a => a.id === e.applicant_id), v = data.rubrics.find(r => r.id === e.rubric_version_id); return <div key={e.id} className="flex flex-wrap justify-between gap-2 text-sm"><span>{a?.first_name} {a?.last_name} · v{v?.version} · revision {e.revision} · {scoreText(e)}</span><button type="button" className="underline" onClick={() => { setEditingId(e.id); setNotice('') }}>Edit evaluation</button></div> })}{prior && <button className="underline text-sm" onClick={() => setEditingId('')}>Return to pending assignments</button>}</section>}
    </>}
  </main>
}
function ReviewForm({ assignment, applicant, rubric, interviewer, prior, onComplete }: { assignment: Assignment; applicant: Applicant; rubric: AnyRubric; interviewer: string; prior?: Saved; onComplete: (saved?: { score: number; max_points?: number | null }) => Promise<void> }) {
  const [responses, setResponses] = useState<Record<string, ResponseValue>>(Object.fromEntries((prior?.responses ?? []).map(r => [r.question_id, r.value])))
  const [application, setApplication] = useState<Application | null>(null)
  const [ratings, setRatings] = useState<Record<string, string>>({}), [comments, setComments] = useState(prior?.comments ?? ''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [resume, setResume] = useState<string | null>(null), [resumeLoading, setResumeLoading] = useState(false), [essays, setEssays] = useState<{ prompt: { id: string; prompt: string }; response: string }[] | null>(null), [essaysLoading, setEssaysLoading] = useState(false), [submitted, setSubmitted] = useState(false)
  const control = 'w-full border border-[var(--border)] rounded-lg bg-[var(--bg-raised)] px-3 py-2'
  async function loadResume() { setResumeLoading(true); setError(''); try { const data = await requestJson<{ resume_base64: string | null }>(`/api/applicants/${applicant.id}/resume`); if (!data.resume_base64) throw new Error('No resume uploaded.'); setResume(data.resume_base64) } catch (e) { setError((e as Error).message) } finally { setResumeLoading(false) } }
  async function loadEssays() { setEssaysLoading(true); setError(''); try { const result = await requestJson<{ applicant: Application; essays: { prompt: { id: string; prompt: string }; response: string }[] }>(`/api/applicants/${applicant.id}/essays`); setApplication(result.applicant); setEssays(result.essays) } catch (e) { setError((e as Error).message) } finally { setEssaysLoading(false) } }
  async function submit(e: React.FormEvent) { e.preventDefault(); setBusy(true); setError(''); try { const evaluation = await requestJson<{ score?: number; max_points?: number | null }>('/api/ps/reviews', { round_id: assignment.round_id, applicant_id: assignment.applicant_id, rubric_version_id: rubric.id, revision: prior?.revision ?? 0, ...(isV2(rubric) ? { schema_version: 2, responses: rubric.questions.filter(q => responses[q.id] !== undefined).map(q => ({ question_id: q.id, format: q.format, value: responses[q.id] })) } : { ratings: rubric.criteria.map(c => ({ criterion_id: c.id, raw_score: Number(ratings[c.id]) })) }), comments }); setSubmitted(true); await onComplete(evaluation.score === undefined ? undefined : { score: evaluation.score, max_points: evaluation.max_points }) } catch (e) { setError((e as Error).message) } finally { setBusy(false) } }
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
    <fieldset disabled={busy || submitted} className="space-y-5">{isV2(rubric) ? <PSRubricFields rubric={rubric} context={{ candidate: `${applicant.first_name} ${applicant.last_name}`, interviewer, year: applicant.year }} values={responses} onChange={(id, value) => setResponses(previous => { const next = { ...previous }; if (value === undefined) delete next[id]; else next[id] = value; return next })} /> : [...rubric.criteria].sort((a, b) => a.order - b.order).map(c => <label key={c.id} className="block space-y-2"><span className="font-medium">{c.name}</span>{c.description && <span className="block text-sm text-[var(--text-muted)]">{c.description}</span>}{c.options.length ? <select required className={control} value={ratings[c.id] ?? ''} onChange={e => setRatings(previous => ({ ...previous, [c.id]: e.target.value }))}><option value="">Select rating</option>{c.options.map(o => <option key={o.value} value={o.value}>{o.label} ({o.value})</option>)}</select> : <input required type="number" className={control} min={c.scale?.min} max={c.scale?.max} step={c.scale?.step} value={ratings[c.id] ?? ''} onChange={e => setRatings(previous => ({ ...previous, [c.id]: e.target.value }))} />}<span className="block text-xs text-[var(--text-muted)]">{c.scale && `${c.scale.min}–${c.scale.max}, step ${c.scale.step}`}{c.weight !== null && ` · Weight: ${c.weight} (scoring not configured)`}</span></label>)}<label className="block">Comments<textarea className={control} maxLength={10000} value={comments} onChange={e => setComments(e.target.value)} /></label></fieldset>
    {error && <p role="alert">{error}</p>}{submitted && <button type="button" className="underline" onClick={() => { setError(''); void onComplete().catch(e => setError(e.message)) }}>Review saved · refresh queue</button>}
    {isV2(rubric) && isWeighted(rubric) && <p role="status" className="text-sm">Weighted round score: {score === null ? '—' : score.toFixed(2)} / 3{incomplete && ` · ${incomplete}`}</p>}
    {running && <p role="status" className="sticky bottom-0 rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] px-4 py-3 text-sm tabular-nums"><span className="font-semibold">{running.total} / {running.max} points</span> so far</p>}
    {isV2(rubric) && isPoints(rubric) && incomplete && <p role="alert" className="text-sm">{incomplete}</p>}
    <button disabled={busy || submitted || !!incomplete || (isV2(rubric) ? (isPoints(rubric) ? rubric.categories.filter(c => sectionVisible(c, applicant.year)).flatMap(c => rubric.questions.filter(q => q.category_id === c.id)) : rubric.questions).some(q => q.required && (responses[q.id] === undefined || (typeof responses[q.id] === 'string' && !String(responses[q.id]).trim()) || (Array.isArray(responses[q.id]) && !(responses[q.id] as string[]).length))) : rubric.criteria.some(c => ratings[c.id] === undefined || ratings[c.id] === ''))} className="rounded-lg bg-[var(--ps-accent)] text-[var(--bg-surface)] px-4 py-2 disabled:opacity-40">{busy ? 'Submitting…' : submitted ? 'Review saved' : prior ? 'Update evaluation' : 'Submit & Next'}</button>
  </form>
}
