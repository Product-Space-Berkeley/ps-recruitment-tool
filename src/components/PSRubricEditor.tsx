'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Round, RecruitmentCycle } from '@/lib/types'
import { requestJson } from '@/lib/ps/client'
import { AnyRubric, copyStructure } from '@/lib/ps/rubricCompatibility'
import { Category, Draft, Question, ResponseValue, Structure, YEARS } from '@/lib/ps/rubricV2'
import { reorder, removeSection, duplicateQuestion } from '@/lib/ps/rubricBuilder'
import { exportRubricJSON } from '@/lib/ps/weightedRubric'
import { isPoints, newPointsQuestion, pointsCopy, rubricRange, validatePoints, POINTS_POLICY } from '@/lib/ps/points'
import { RUBRIC_TEMPLATES } from '@/lib/ps/templates'
import type { ImportPreview } from '@/lib/ps/rubricImport'
import PSRubricFields from './PSRubricFields'
const control = 'w-full rounded-lg border border-[var(--border)] bg-[var(--bg-raised)] px-3 py-2.5 text-sm'
const button = 'rounded-lg border border-[var(--border)] px-3 py-2 text-sm hover:bg-[var(--bg-raised)] disabled:opacity-40'
const primary = 'rounded-lg bg-[var(--ps-accent)] text-[var(--bg-surface)] px-4 py-2 text-sm disabled:opacity-40'
const card = 'rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-5 sm:p-6'
export type SavePhase = 'saved' | 'unsaved' | 'saving' | 'error'
function blank(round: Round): Structure { return { schema_version: 2, name: `${round.name} rubric`, description: '', scoring_policy: POINTS_POLICY, weighting: 'unconfigured', categories: [{ id: crypto.randomUUID(), name: 'Section 1', description: '', kind: 'general', order: 0, weight_bps: null }], questions: [] } }
function pointsLine(s: Structure) {
  const r = rubricRange(s)
  const max = r.differs_by_grade ? `${r.max_low}–${r.max_high} (depends on grade)` : String(r.max)
  return `Max ${max} points${r.bonus ? ` · includes up to ${r.bonus} bonus` : ''}${r.penalty ? ` · penalties down to ${r.penalty}` : ''}`
}
export default function PSRubricEditor({ round, rounds, readOnly = false, onChange, onStatus }: { round: Round; rounds: Round[]; readOnly?: boolean; onChange: () => Promise<void>; onStatus?: (id: string, phase: SavePhase, error: string) => void }) {
  const [versions, setVersions] = useState<AnyRubric[]>([]), [drafts, setDrafts] = useState<Draft[]>([])
  const [working, setWorking] = useState<Structure | null>(null), [saved, setSaved] = useState<Draft | null>(null)
  const [editing, setEditing] = useState(false), [tab, setTab] = useState('questions'), [phase, setPhase] = useState<SavePhase>('saved')
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('')
  const [values, setValues] = useState<Record<string, ResponseValue>>({}), [imported, setImported] = useState<Structure | null>(null), [importNote, setImportNote] = useState(''), [sheet, setSheet] = useState('')
  const [cycles, setCycles] = useState<RecruitmentCycle[]>([]), [copyRounds, setCopyRounds] = useState<Round[]>(rounds), [copyVersions, setCopyVersions] = useState<AnyRubric[]>([]), [copyCycle, setCopyCycle] = useState(''), [copyRound, setCopyRound] = useState(''), [copyId, setCopyId] = useState('')
  const [deleting, setDeleting] = useState<string | null>(null), [previewYear, setPreviewYear] = useState('')
  const current = useRef<Structure | null>(null), base = useRef<Draft | null>(null), generation = useRef(0), persisted = useRef(0), inflight = useRef<Promise<Draft | null> | null>(null), blocked = useRef(false)
  const locked = readOnly || !!round.archived || round.status === 'ended'
  const active = versions.find(v => v.id === round.rubric_version_id)
  const displayed = working ?? (active ? copyStructure(active) : null)
  const lists = useCallback(async () => {
    const [v, d] = await Promise.all([requestJson<AnyRubric[]>(`/api/ps/rounds/${round.id}/rubrics`), requestJson<Draft[]>(`/api/ps/rounds/${round.id}/rubric-drafts`)])
    setVersions(v); setDrafts(d); return { v, d }
  }, [round.id])
  function select(structure: Structure | null, draft: Draft | null, edit: boolean, dirty = false) {
    current.current = structure; base.current = draft; generation.current++; persisted.current = dirty ? generation.current - 1 : generation.current; blocked.current = false
    setWorking(structure); setSaved(draft); setEditing(edit); setPhase(dirty ? 'unsaved' : 'saved'); setValues({}); setError(''); setMessage(''); setTab('questions')
  }
  useEffect(() => {
    let live = true
    lists().then(({ d }) => { if (live && generation.current === 0) { const latest = d.find(d => d.status === 'editing') ?? null; current.current = latest; base.current = latest; setSaved(latest); setWorking(latest) } }).catch(e => { if (live) { setError(e.message); blocked.current = true } }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [lists])
  useEffect(() => { onStatus?.(round.id, phase, phase === 'error' ? error : '') }, [round.id, phase, error, onStatus])
  useEffect(() => {
    const prevent = (e: BeforeUnloadEvent) => { if (generation.current !== persisted.current) { e.preventDefault(); e.returnValue = '' } }
    window.addEventListener('beforeunload', prevent); return () => window.removeEventListener('beforeunload', prevent)
  }, [])
  const save = useCallback(async (): Promise<Draft | null> => {
    while (inflight.current) { await inflight.current; if (blocked.current) return null }
    if (!current.current || generation.current === persisted.current) return base.current
    const snapshot = structuredClone(current.current), sent = generation.current, previous = base.current
    blocked.current = false; setPhase('saving'); setError('')
    const request = (async () => {
      try {
        const structure = validatePoints(snapshot)
        const d = previous ? await requestJson<Draft>(`/api/ps/rubric-drafts/${previous.id}`, { revision: previous.revision, structure }, 'PATCH') : await requestJson<Draft>(`/api/ps/rounds/${round.id}/rubric-drafts`, { structure })
        base.current = d; persisted.current = sent; setSaved(d); setDrafts(p => [d, ...p.filter(old => old.id !== d.id)])
        // A save response must never replace text typed while that request was in flight.
        setPhase(generation.current === sent ? 'saved' : 'unsaved'); return d
      } catch (e) { blocked.current = true; setPhase('error'); setError((e as Error).message); return null }
      finally { inflight.current = null }
    })()
    inflight.current = request
    return request
  }, [round.id])
  useEffect(() => {
    if (!editing || locked || busy || blocked.current || phase !== 'unsaved') return
    const timer = setTimeout(() => { void save() }, 800)
    return () => clearTimeout(timer)
  }, [working, editing, locked, busy, phase, save])
  function change(s: Structure) { current.current = s; generation.current++; setWorking(s); setValues({}); setMessage(''); if (!blocked.current && !inflight.current) setPhase('unsaved') }
  function updateSection(id: string, patch: Partial<Category>) { if (working) change({ ...working, categories: working.categories.map(c => c.id === id ? { ...c, ...patch } : c) }) }
  function updateQuestion(id: string, patch: Partial<Question>) { if (working) change({ ...working, questions: working.questions.map(q => q.id === id ? { ...q, ...patch, confirmed: true } : q) }) }
  async function action(fn: () => Promise<void>) { setBusy(true); setError(''); setMessage(''); try { await fn() } catch (e) { setError((e as Error).message) } finally { setBusy(false) } }
  async function publish() {
    const d = await save()
    if (!d || generation.current !== persisted.current) return
    validatePoints(current.current, true)
    // Read the current round configuration without discarding the draft or pending text.
    const latestRound = await requestJson<Round>(`/api/ps/rounds/${round.id}`)
    const v = await requestJson<AnyRubric>(`/api/ps/rubric-drafts/${d.id}/publish`, { revision: d.revision, configuration_version: latestRound.configuration_version })
    const published = await requestJson<Draft>(`/api/ps/rubric-drafts/${d.id}`)
    select(copyStructure(v), published, false); await lists(); await onChange(); setMessage(`Rubric version ${v.version} published.`)
  }
  function exportJSON() {
    if (!displayed) return
    // Canonical JSON preserves option values, evidence purposes and all configuration.
    const link = document.createElement('a'), url = URL.createObjectURL(new Blob([JSON.stringify(exportRubricJSON(displayed), null, 2)], { type: 'application/json' }))
    link.href = url; link.download = `ps-rubric-${round.id}.json`; link.click(); URL.revokeObjectURL(url)
  }
  async function upload(file: File) {
    setImported(null); setImportNote('')
    if (/\.json$/i.test(file.name)) {
      if (file.size > 1024 * 1024) throw new Error('JSON uploads must be at most 1 MB.')
      let data: unknown
      try { data = JSON.parse(await file.text()) } catch { throw new Error('The file is not valid JSON. Your draft has not changed.') }
      const result = await requestJson<{ structure: Structure }>(`/api/ps/rounds/${round.id}/rubric-json`, data)
      setImported(pointsCopy(result.structure)); setImportNote('JSON structure validated. Scales were converted to point choices; any old weights were dropped. Review before replacing this draft.')
    } else {
      const form = new FormData(); form.set('file', file); if (sheet.trim()) form.set('sheet', sheet.trim())
      const p = await requestJson<ImportPreview>(`/api/ps/rounds/${round.id}/rubric-imports`, form)
      setImported(pointsCopy(p.structure)); setImportNote(`${p.warnings.join(' ')} ${p.excluded.length} identity/output columns excluded. Inferred formats require confirmation.`)
    }
  }
  const invalid = (() => { if (!displayed || !isPoints(displayed)) return ''; try { validatePoints(displayed, true); return '' } catch (e) { return (e as Error).message } })()
  return <section aria-label={`Rubric builder: ${round.name}`} data-round-id={round.id} className="space-y-5">
    <header className={`${card} border-t-4 border-t-[var(--ps-accent)] space-y-4`}>
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-semibold">Scoring rubric</h2><p className="text-sm text-[var(--text-muted)]">{round.name} · {active ? `Published v${active.version}` : 'Not published'}{saved?.status === 'editing' ? ' · Draft' : ''}</p></div><div className="flex flex-wrap gap-2">
        {!editing && <button className={primary} disabled={locked || busy || loading || !!error} onClick={() => { const s = pointsCopy(saved?.status === 'editing' ? saved : displayed ?? blank(round)); select(s, saved?.status === 'editing' ? saved : null, true, true) }}>Edit Rubric</button>}
        {editing && <button className={button} disabled={busy || locked || phase === 'saving'} onClick={() => { blocked.current = false; void save() }}>Save Draft</button>}
        <button className={button} disabled={!displayed} onClick={exportJSON}>Export rubric JSON</button>
        {editing && <button className={primary} disabled={locked || busy || phase === 'saving' || !!invalid} onClick={() => void action(publish)}>Publish rubric</button>}
      </div></div>
      {displayed && <nav aria-label="Rubric editor tabs" className="flex flex-wrap gap-2"><button className={button} aria-pressed={tab === 'questions'} onClick={() => setTab('questions')}>Questions</button><button className={button} aria-pressed={tab === 'preview'} onClick={() => setTab('preview')}>Preview grading form</button></nav>}
      {editing && <p role="status" className="text-sm">{phase === 'saved' ? 'All changes saved' : phase === 'saving' ? 'Saving draft…' : phase === 'error' ? 'Draft not saved · edits are retained' : 'Unsaved changes · saving shortly'}</p>}
      {displayed && isPoints(displayed) && <p role="status" className="text-sm text-[var(--text-muted)] tabular-nums">{pointsLine(displayed)}</p>}
      {editing && invalid && <p className="text-sm text-[var(--text-muted)]">Before publishing: {invalid}</p>}
      {(!editing || tab === 'preview') && displayed && <><h3 className="text-lg font-semibold">{displayed.name}</h3></>}
    </header>
    {loading && <p role="status">Loading rubric…</p>}{error && <div role="alert" className="rounded-lg border border-red-400 p-3 text-sm space-y-2"><p>{error}</p>{phase === 'error' ? <><p>Your edits remain here. A conflict requires reviewing the server draft before retrying.</p><button className={button} disabled={busy || locked} onClick={() => { blocked.current = false; void save() }}>Retry save</button><button className={`${button} ml-2`} disabled={busy} onClick={() => { if (window.confirm('Reload the saved draft and discard this editor’s unsaved changes? Export your JSON first to keep a copy.')) void action(async () => { const d = base.current ? await requestJson<Draft>(`/api/ps/rubric-drafts/${base.current.id}`) : null; select(d, d, false) }) }}>Reload saved draft</button></> : <button className={button} disabled={busy} onClick={() => void action(async () => { await lists(); setLoading(false) })}>Refresh rubric data</button>}</div>}{message && <p role="status">{message}</p>}
    {tab === 'preview' && displayed && <><p className="text-sm text-[var(--text-muted)]">Interactive draft preview · Answers here are never submitted as evaluations.</p>{displayed.categories.some(c => c.show_for_years) && <label className="block text-sm max-w-xs">Preview as applicant grade<select className={`${control} mt-1`} value={previewYear} onChange={e => setPreviewYear(e.target.value)}><option value="">Show every section</option>{YEARS.map(y => <option key={y} value={y}>{y}</option>)}</select></label>}<PSRubricFields rubric={displayed} values={values} context={{ candidate: 'Current candidate', interviewer: 'Signed-in interviewer', year: previewYear || undefined }} onChange={(id, value) => setValues(p => { const next = { ...p }; if (value === undefined) delete next[id]; else next[id] = value; return next })} /></>}
    {tab === 'questions' && editing && working && <fieldset disabled={busy || locked} className="space-y-5">
      <div className={`${card} space-y-4`}><label className="block text-sm">Rubric title<input className={`${control} mt-1 text-lg font-semibold`} maxLength={200} value={working.name} onChange={e => change({ ...working, name: e.target.value })} /></label><label className="block text-sm">Rubric description<textarea aria-label="Rubric description" className={`${control} mt-1`} rows={3} maxLength={10000} value={working.description ?? ''} onChange={e => change({ ...working, description: e.target.value })} /></label></div>
      {working.categories.map((c, sectionIndex) => {
        const questions = working.questions.filter(q => q.category_id === c.id)
        return <section key={c.id} aria-label={`Edit section ${sectionIndex + 1}`} className="space-y-4">
          <header className={`${card} space-y-4`}><p className="text-xs text-[var(--text-muted)]">Section {sectionIndex + 1} of {working.categories.length}</p><label className="block text-sm">Section title<input className={`${control} mt-1 font-semibold`} maxLength={500} value={c.name} onChange={e => updateSection(c.id, { name: e.target.value })} /></label><label className="block text-sm">Section instructions<textarea aria-label="Section instructions" className={`${control} mt-1`} rows={3} maxLength={10000} value={c.description ?? ''} onChange={e => updateSection(c.id, { description: e.target.value })} /></label>
            <GradeVisibility section={c} onChange={years => updateSection(c.id, { show_for_years: years })} />
            <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={!sectionIndex} onClick={() => change({ ...working, categories: reorder(working.categories, sectionIndex, sectionIndex - 1) })}>Move section up</button><button type="button" className={button} disabled={sectionIndex === working.categories.length - 1} onClick={() => change({ ...working, categories: reorder(working.categories, sectionIndex, sectionIndex + 1) })}>Move section down</button><button type="button" className={button} disabled={working.categories.length === 1} onClick={() => setDeleting(c.id)}>Delete section</button></div>
            {deleting === c.id && <div role="alertdialog" aria-label="Delete section?" className="border border-[var(--ps-accent)] rounded-lg p-4 space-y-3"><p>Delete “{c.name}” and all {questions.length} questions? Published evaluations stay unchanged.</p><button type="button" className={button} onClick={() => setDeleting(null)}>Cancel deletion</button><button type="button" className={`${button} ml-2`} onClick={() => { change(removeSection(working, c.id)); setDeleting(null) }}>Confirm delete section</button></div>}
          </header>
          {questions.map((q, i) => <QuestionCard key={q.id} q={q} sections={working.categories} update={patch => updateQuestion(q.id, patch)} duplicate={() => change({ ...working, questions: duplicateQuestion(working.questions, q.id, crypto.randomUUID()) })} remove={() => change({ ...working, questions: working.questions.filter(x => x.id !== q.id) })} canDuplicate={working.questions.length < 200} first={!i} last={i === questions.length - 1} move={delta => { const from = working.questions.findIndex(x => x.id === q.id), to = working.questions.findIndex(x => x.id === questions[i + delta].id); change({ ...working, questions: reorder(working.questions, from, to) }) }} />)}
          {!questions.length && <p className="text-sm text-[var(--text-muted)] px-5">Add a question to this section before publishing.</p>}
          <button type="button" className={button} disabled={working.questions.length >= 200} onClick={() => change({ ...working, questions: [...working.questions, newPointsQuestion(c.id, crypto.randomUUID())] })}>+ Add question to this section</button>
        </section>
      })}
      <button type="button" className={button} disabled={working.categories.length >= 20} onClick={() => change({ ...working, categories: [...working.categories, { id: crypto.randomUUID(), name: `Section ${working.categories.length + 1}`, description: '', kind: 'general', order: working.categories.length, weight_bps: null }] })}>+ Add section</button>
      <p className="text-xs text-[var(--text-muted)]">Points questions add to the total; bonuses add and penalties or red flags subtract. Written, link and multiple-choice answers are unscored. Changes reach graders after you publish.</p>
    </fieldset>}
    {tab === 'questions' && !editing && displayed && <PSRubricFields rubric={displayed} values={{}} disabled onChange={() => {}} />}
    {!displayed && !loading && !locked && <div className={`${card} space-y-3`}><p className="text-sm">Start from one of last semester’s PS forms, or build from scratch.</p><TemplatePicker disabled={busy} onPick={s => select(s, null, true, true)} /><button className={button} disabled={busy} onClick={() => select(blank(round), null, true, true)}>Start from scratch</button></div>}
    {!displayed && !loading && locked && <p className={`${card} text-sm`}>No rubric has been published for this round.</p>}
    {!locked && <details className="text-sm"><summary className="cursor-pointer text-[var(--text-muted)]">Import rubric or duplicate a previous rubric</summary><div className={`${card} mt-3 space-y-4`}>
      <p>Start over from a PS template:</p><TemplatePicker disabled={busy || phase === 'saving'} onPick={s => { if (working && !window.confirm('Replace this draft with the template? Export it first to keep a copy.')) return; select(s, saved?.status === 'editing' ? saved : null, true, true) }} />
      <p>JSON imports preserve structure. XLSX/CSV imports suggest structure only; review every inferred field. Scales become point choices.</p>
      <label className="block">Worksheet name (XLSX, optional)<input className={`${control} mt-1`} value={sheet} onChange={e => setSheet(e.target.value)} /></label><label className="block">Upload rubric<input className="block mt-2 max-w-full" type="file" accept=".json,.xlsx,.csv" disabled={busy || phase === 'saving'} onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void action(() => upload(f)) }} /></label>
      {imported && <div className="space-y-3"><p>{importNote}</p><p>{imported.name} · {imported.categories.length} sections · {imported.questions.length} questions · {pointsLine(imported)}</p><PSRubricFields rubric={imported} values={{}} disabled onChange={() => {}} /><button className={primary} disabled={busy || phase === 'saving'} onClick={() => { if (working && !window.confirm('Replace this draft with the imported rubric? Export it first to keep a copy.')) return; select(imported, saved?.status === 'editing' ? saved : null, true, true); setImported(null) }}>Use imported draft</button><button className={`${button} ml-2`} onClick={() => setImported(null)}>Cancel import</button></div>}
      <button className={button} disabled={busy || phase === 'saving'} onClick={() => void action(async () => setCycles(await requestJson<RecruitmentCycle[]>('/api/cycles')))}>Choose a previous cycle</button>
      <label className="block">Previous cycle<select className={`${control} mt-1`} value={copyCycle} onChange={e => { const id = e.target.value; setCopyCycle(id); setCopyRound(''); setCopyId(''); setCopyVersions([]); if (!id) setCopyRounds(rounds); else void action(async () => setCopyRounds((await requestJson<{ rounds: Round[] }>(`/api/ps/cycles/${id}/rounds`)).rounds)) }}><option value="">Current cycle</option>{cycles.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <label className="block">Previous round<select className={`${control} mt-1`} value={copyRound} onChange={e => { const id = e.target.value; setCopyRound(id); setCopyId(''); setCopyVersions([]); if (id) void action(async () => setCopyVersions(await requestJson<AnyRubric[]>(`/api/ps/rounds/${id}/rubrics`))) }}><option value="">Choose a round</option>{(copyCycle ? copyRounds : rounds).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
      <label className="block">Previous rubric<select className={`${control} mt-1`} value={copyId} onChange={e => setCopyId(e.target.value)}><option value="">Choose a published rubric</option>{copyVersions.map(v => <option key={v.id} value={v.id}>{v.name} · v{v.version}</option>)}</select></label><button className={button} disabled={!copyId || busy || phase === 'saving'} onClick={() => { const v = copyVersions.find(v => v.id === copyId)!; if (working && !window.confirm('Replace this draft with a copy of the selected rubric?')) return; select(pointsCopy(copyStructure(v)), null, true, true) }}>Duplicate Previous Rubric</button>
      <button className={button} disabled={busy || phase === 'saving'} onClick={() => { if (working && !window.confirm('Start a new draft? Existing saved drafts remain available. Export unsaved edits first.')) return; select(blank(round), null, true, true) }}>Start another draft</button>
      {!!drafts.length && <label className="block">Saved draft<select className={`${control} mt-1`} value={saved?.id ?? ''} disabled={busy || phase === 'saving'} onChange={e => { const d = drafts.find(d => d.id === e.target.value); if (d && (generation.current === persisted.current || window.confirm('Switch saved drafts and discard unsaved edits?'))) select(d, d.status === 'editing' ? d : null, false) }}><option value="">Choose a saved draft</option>{drafts.map(d => <option key={d.id} value={d.id}>{d.name || 'Untitled'} · {d.status}</option>)}</select></label>}
    </div></details>}
  </section>
}
function TemplatePicker({ disabled, onPick }: { disabled: boolean; onPick: (s: Structure) => void }) {
  return <div className="flex flex-wrap gap-2">{RUBRIC_TEMPLATES.map(t => <button key={t.key} type="button" className={button} disabled={disabled} onClick={() => onPick(t.build())}>{t.name}</button>)}</div>
}
function GradeVisibility({ section, onChange }: { section: Category; onChange: (years: string[] | undefined) => void }) {
  const years = section.show_for_years
  return <fieldset className="text-sm space-y-2"><legend>Who sees this section</legend>
    <label className="flex gap-2 items-center"><input type="radio" name={`visibility-${section.id}`} checked={!years} onChange={() => onChange(undefined)} />All applicants</label>
    <label className="flex gap-2 items-center"><input type="radio" name={`visibility-${section.id}`} checked={!!years} onChange={() => onChange(years ?? ['Freshman'])} />Only applicants in certain grades</label>
    {years && <div className="flex flex-wrap gap-3 pl-6">{YEARS.map(y => <label key={y} className="flex gap-2 items-center"><input type="checkbox" checked={years.includes(y)} disabled={years.length === 1 && years.includes(y)} onChange={e => onChange(YEARS.filter(x => x === y ? e.target.checked : years.includes(x)))} />{y}</label>)}</div>}
  </fieldset>
}
const KINDS = { SCORED_CRITERION: 'Criterion', BONUS: 'Bonus (adds points)', PENALTY: 'Penalty (subtracts points)', RED_FLAG: 'Red flag (subtracts points)' } as const
const KIND_DEFAULTS: Record<keyof typeof KINDS, number[]> = { SCORED_CRITERION: [0, 1, 2, 3], BONUS: [1, 0], PENALTY: [-1, 0], RED_FLAG: [-1, 0] }
const PRESETS: [string, number[]][] = [['0–3', [0, 1, 2, 3]], ['0 / 0.5 / 1', [0, 0.5, 1]], ['0 / 1', [0, 1]], ['0 / 1 / 2', [0, 1, 2]], ['−1 / 0', [-1, 0]]]
const options = (values: number[]) => values.map(value => ({ value, label: '' }))
function QuestionCard({ q, sections, update, duplicate, remove, canDuplicate, first, last, move }: { q: Question; sections: Category[]; update: (patch: Partial<Question>) => void; duplicate: () => void; remove: () => void; canDuplicate: boolean; first: boolean; last: boolean; move: (delta: number) => void }) {
  const types = { numeric_choice: 'Points', short_text: 'Short answer', long_text: 'Paragraph', url: 'Link', single_choice: 'Multiple choice' }
  const scored = q.format === 'numeric_choice'
  const values = q.options.map(o => Number(o.value))
  const duplicateValues = scored && new Set(values).size !== values.length
  function setType(format: Question['format']) {
    if (format === 'numeric_choice') update({ format, purpose: 'SCORED_CRITERION', scale: null, options: options(KIND_DEFAULTS.SCORED_CRITERION), required: true })
    else update({ format, purpose: q.purpose === 'DECISION_SIGNAL' ? q.purpose : 'QUALITATIVE', scale: null, options: format === 'single_choice' ? [{ value: crypto.randomUUID(), label: 'Option 1' }, { value: crypto.randomUUID(), label: 'Option 2' }] : [], min_label: undefined, max_label: undefined, required: q.required ?? true })
  }
  return <fieldset data-question-id={q.id} aria-label={`Question: ${q.label || 'Untitled'}`} className={`${card} space-y-4`}>
    <div className="grid sm:grid-cols-[1fr_180px] gap-3 items-start"><label className="block text-sm">Question title<textarea aria-label="Question title" className={`${control} mt-1 font-medium`} rows={2} maxLength={4000} placeholder="Question" value={q.label} onChange={e => update({ label: e.target.value })} /></label><label className="text-sm">Question type<select className={`${control} mt-1`} value={q.format ?? ''} onChange={e => setType(e.target.value as Question['format'])}><option value="">Choose question type</option>{!Object.keys(types).includes(q.format ?? '') && q.format && <option value={q.format}>Unsupported: {q.format} · choose a type</option>}{Object.entries(types).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
    <label className="block text-sm">Question instructions<textarea aria-label="Question instructions" className={`${control} mt-1`} rows={2} maxLength={4000} placeholder="Instructions or description (optional)" value={q.description} onChange={e => update({ description: e.target.value })} /></label>
    {q.source?.suggestion && <p className="text-xs text-[var(--text-muted)]">Inferred suggestion: {q.source.suggestion}</p>}
    {scored && <div className="space-y-3">
      <label className="block text-sm max-w-xs">Counts as<select className={`${control} mt-1`} value={q.purpose ?? 'SCORED_CRITERION'} onChange={e => { const purpose = e.target.value as keyof typeof KINDS; update({ purpose, options: options(KIND_DEFAULTS[purpose]) }) }}>{Object.entries(KINDS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <div className="flex flex-wrap items-center gap-2 text-sm"><span className="text-[var(--text-muted)]">Quick choices:</span>{PRESETS.map(([label, preset]) => <button key={label} type="button" className={button} onClick={() => update({ options: options(preset) })}>{label}</button>)}</div>
      <div className="space-y-2">{q.options.map((o, i) => <div key={i} className="flex gap-2 items-center"><label className="w-24 shrink-0"><span className="sr-only">Points for choice {i + 1}</span><input type="number" step={0.5} className={`${control} tabular-nums`} value={String(o.value)} onChange={e => { const n = Number(e.target.value); if (e.target.value !== '' && Number.isFinite(n)) update({ options: q.options.map((x, j) => j === i ? { ...x, value: n } : x) }) }} /></label><label className="flex-1 min-w-0"><span className="sr-only">Description for choice {i + 1}</span><input className={control} maxLength={1000} placeholder="Description (optional)" value={o.label} onChange={e => update({ options: q.options.map((x, j) => j === i ? { ...x, label: e.target.value } : x) })} /></label><button type="button" aria-label={`Remove choice ${i + 1}`} className={button} disabled={q.options.length <= 2} onClick={() => update({ options: q.options.filter((_, j) => j !== i) })}>×</button></div>)}
        <button type="button" className={button} disabled={q.options.length >= 21} onClick={() => update({ options: [...q.options, { value: Math.max(...values, 0) + 1, label: '' }] })}>+ Add choice</button>
        {duplicateValues && <p role="alert" className="text-sm text-[var(--ps-accent)]">Each choice needs a different point value.</p>}
      </div>
      {q.purpose === 'SCORED_CRITERION' && <div className="grid sm:grid-cols-2 gap-3"><label className="text-sm">Label under the lowest choice<input className={`${control} mt-1`} maxLength={300} value={q.min_label ?? ''} onChange={e => update({ min_label: e.target.value })} /></label><label className="text-sm">Label under the highest choice<input className={`${control} mt-1`} maxLength={300} value={q.max_label ?? ''} onChange={e => update({ max_label: e.target.value })} /></label></div>}
    </div>}
    {q.format === 'single_choice' && <div className="space-y-2">{q.options.map((o, i) => <div key={o.value} className="flex gap-2 items-center"><span aria-hidden="true">○</span><label className="flex-1 min-w-0"><span className="sr-only">Option {i + 1}</span><input className={control} maxLength={1000} value={o.label} onChange={e => update({ options: q.options.map(x => x.value === o.value ? { ...x, label: e.target.value } : x) })} /></label><button type="button" aria-label={`Remove option ${i + 1}`} className={button} onClick={() => update({ options: q.options.filter(x => x.value !== o.value) })}>×</button></div>)}<button type="button" className={button} disabled={q.options.length >= 100} onClick={() => update({ options: [...q.options, { value: crypto.randomUUID(), label: '' }] })}>+ Add option</button></div>}
    <div className="flex flex-wrap gap-3 justify-between items-center"><span className="text-xs text-[var(--text-muted)]">{scored ? 'Adds to the score' : 'Context only · not scored'}</span><label className="flex gap-2 items-center text-sm"><input type="checkbox" checked={q.required === true} onChange={e => update({ required: e.target.checked })} />Required</label><div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={first} onClick={() => move(-1)}>Move question up</button><button type="button" className={button} disabled={last} onClick={() => move(1)}>Move question down</button><button type="button" className={button} disabled={!canDuplicate} onClick={duplicate}>Duplicate question</button><button type="button" className={button} onClick={remove}>Delete question</button></div></div>
    <details className="text-sm"><summary className="cursor-pointer text-[var(--text-muted)]">Move to another section{!scored && ' / mark as decision signal'}</summary><label className="block mt-2">Destination section<select className={`${control} mt-1`} value={q.category_id} onChange={e => update({ category_id: e.target.value })}>{sections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>{!scored && <label className="flex gap-2 items-center mt-2"><input type="checkbox" checked={q.purpose === 'DECISION_SIGNAL'} onChange={e => update({ purpose: e.target.checked ? 'DECISION_SIGNAL' : 'QUALITATIVE' })} />Decision signal (e.g. tech bar). Highlighted in deliberation; never scored.</label>}</details>
  </fieldset>
}
