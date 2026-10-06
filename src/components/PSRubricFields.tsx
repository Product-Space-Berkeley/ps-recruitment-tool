'use client'
import type { Question, ResponseValue, Structure } from '@/lib/ps/rubricV2'
import { sectionKind } from '@/lib/ps/rubricBuilder'
import { choiceLabel, isPoints, isPointsQuestion, sectionRange, sectionVisible } from '@/lib/ps/points'
const control = 'w-full rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] px-3 py-2.5'
// year: the applicant's grade. Without it (editor preview), grade-specific sections are all shown and labeled.
export type ReviewContext = { candidate: string; interviewer: string; year?: string }
const PURPOSE_TAGS: Partial<Record<NonNullable<Question['purpose']>, string>> = { BONUS: 'Bonus', PENALTY: 'Penalty', RED_FLAG: 'Red flag' }
function signed(n: number) { return n > 0 ? `+${n}` : String(n) }
export default function PSRubricFields({ rubric, values, onChange, disabled = false, context }: { rubric: Structure; values: Record<string, ResponseValue>; onChange: (id: string, value: ResponseValue | undefined) => void; disabled?: boolean; context?: ReviewContext }) {
  const points = isPoints(rubric)
  const categories = rubric.categories.filter(c => !context?.year || sectionVisible(c, context.year))
  return <fieldset disabled={disabled} className="space-y-6">{rubric.description && <SectionContent text={rubric.description} />}{categories.map(category => {
    const range = points ? sectionRange(rubric, category.id) : null
    return <section key={category.id} aria-label={category.name} className="rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-5 sm:p-6 space-y-5">
      <header className="flex gap-4 justify-between items-start"><div className="min-w-0"><h3 className="text-lg font-semibold break-words">{category.name}</h3>{category.show_for_years && !context?.year && <p className="text-xs text-[var(--text-muted)]">Shown only for {category.show_for_years.join(', ')} applicants</p>}</div>
        {category.weight_bps !== null && <span className="shrink-0 rounded-full bg-[var(--bg-raised)] px-3 py-1 text-sm">{category.weight_bps / 100}%</span>}
        {range && (range.criteria > 0 || range.bonus > 0 || range.penalty < 0) && <span className="shrink-0 rounded-full bg-[var(--bg-raised)] px-3 py-1 text-sm tabular-nums">{[range.criteria > 0 && `${range.criteria} pts`, range.bonus > 0 && `+${range.bonus} bonus`, range.penalty < 0 && `${range.penalty}`].filter(Boolean).join(' · ')}</span>}
      </header>
      {category.description && <SectionContent text={category.description} />}
      {sectionKind(category, rubric.questions) === 'basic_information' && context && <dl className="grid sm:grid-cols-2 gap-3 text-sm"><div><dt className="text-[var(--text-muted)]">Candidate</dt><dd>{context.candidate}</dd></div><div><dt className="text-[var(--text-muted)]">Interviewer</dt><dd>{context.interviewer}</dd></div></dl>}
      {rubric.questions.filter(q => q.category_id === category.id).map(q => <div key={q.id} className="rounded-lg border border-[var(--border)] p-4 space-y-3">
        <div className="flex gap-3 justify-between items-start"><label htmlFor={`question-${q.id}`} className="block font-medium min-w-0 break-words">{q.label}{q.required && <span aria-label="required" className="text-[var(--ps-accent)]"> *</span>}</label>{points && q.purpose && PURPOSE_TAGS[q.purpose] && <span className="shrink-0 text-xs rounded-full border border-[var(--border)] px-2 py-0.5">{PURPOSE_TAGS[q.purpose]}</span>}</div>
        {q.description && <SectionContent text={q.description} muted />}
        {rubric.scoring_policy === 'question_weighted_0_3' && q.format === 'number' && <p className="text-xs text-[var(--text-muted)]">Weight: {q.weight_bps == null ? 'not set' : `${q.weight_bps / 100}%`}</p>}
        <Field q={q} value={values[q.id]} change={v => onChange(q.id, v)} />
      </div>)}
    </section>
  })}</fieldset>
}
function SectionContent({ text, muted = false }: { text: string; muted?: boolean }) {
  // Plain text with paragraph/bullet support. Links are limited to safe HTTP(S) URLs.
  function links(line: string) { return line.split(/(https?:\/\/[^\s<>]+)/g).map((part, i) => { if (!/^https?:\/\//.test(part)) return part; try { const url = new URL(part); if (url.username || url.password) return part; return <a key={i} href={url.href} target="_blank" rel="noreferrer" className="underline break-all">{part}</a> } catch { return part } }) }
  return <div className={`text-sm leading-relaxed space-y-2 ${muted ? 'text-[var(--text-muted)]' : 'text-[var(--text-secondary)]'}`}>{text.split(/\n\s*\n/).map((paragraph, i) => {
    const lines = paragraph.split('\n')
    return lines.every(line => /^\s*[-•*]\s+/.test(line)) ? <ul key={i} className="list-disc pl-5 space-y-1">{lines.map((line, j) => <li key={j}>{links(line.replace(/^\s*[-•*]\s+/, ''))}</li>)}</ul> : <p key={i} className="whitespace-pre-wrap">{links(paragraph)}</p>
  })}</div>
}
function ChoiceRadios({ q, value, change, options }: { q: Question; value: ResponseValue | undefined; change: (v: ResponseValue | undefined) => void; options: { value: string | number; text: string; hint?: string }[] }) {
  // Short choices sit in one row like a Google Forms linear scale; described choices stack.
  const stacked = options.some(o => o.hint)
  return <div className="space-y-2"><fieldset id={`question-${q.id}`} aria-label={q.label} className={stacked ? 'space-y-2' : 'flex flex-wrap gap-2'}><legend className="sr-only">{q.label}</legend>
    {options.map(o => <label key={String(o.value)} className={`flex gap-2 ${stacked ? 'items-start' : 'items-center'} rounded-lg border border-[var(--border)] px-3 py-2 cursor-pointer has-[:checked]:border-[var(--ps-accent)] has-[:checked]:bg-[var(--bg-raised)]`}><input type="radio" className={stacked ? 'mt-1' : ''} name={`response-${q.id}`} required={q.required === true} checked={value === o.value} onChange={() => change(o.value)} value={String(o.value)} /><span className="tabular-nums">{o.text}{o.hint && <span className="block text-sm text-[var(--text-muted)]">{o.hint}</span>}</span></label>)}
    {!q.required && value !== undefined && <button type="button" className="text-sm underline" onClick={() => change(undefined)}>Clear</button>}
  </fieldset>{!stacked && (q.min_label || q.max_label) && <div className="flex justify-between gap-3 text-xs text-[var(--text-muted)]"><span>{q.min_label}</span><span>{q.max_label}</span></div>}</div>
}
function Field({ q, value, change }: { q: Question; value: ResponseValue | undefined; change: (v: ResponseValue | undefined) => void }) {
  const common = { 'aria-label': q.label, id: `question-${q.id}`, className: control, required: q.required === true }
  if (q.format === 'numeric_choice') {
    const scored = isPointsQuestion(q)
    return <ChoiceRadios q={q} value={value} change={change} options={q.options.map(o => ({ value: o.value, text: scored ? (q.purpose === 'BONUS' ? signed(Number(o.value)) : String(o.value)) : choiceLabel(o), hint: scored && o.label.trim() ? o.label : undefined }))} />
  }
  if (q.format === 'number' && q.scale && (q.scale.max - q.scale.min) / q.scale.step <= 10) {
    const options = Array.from({ length: Math.floor((q.scale.max - q.scale.min) / q.scale.step + 1e-8) + 1 }, (_, i) => Number((q.scale!.min + i * q.scale!.step).toPrecision(12)))
    return <ChoiceRadios q={q} value={value} change={change} options={options.map(n => ({ value: n, text: String(n) }))} />
  }
  if (q.format === 'single_choice') return <ChoiceRadios q={q} value={value} change={change} options={q.options.map(o => ({ value: o.value, text: o.label, hint: undefined }))} />
  if (q.format === 'multiple_choice') return <fieldset id={common.id} aria-label={q.label} className="space-y-2"><legend className="sr-only">{q.label}{q.required && ' (choose at least one)'}</legend>{q.options.map(o => <label key={o.value} className="flex gap-2"><input type="checkbox" checked={Array.isArray(value) && value.includes(String(o.value))} onChange={e => { const current = Array.isArray(value) ? value : []; change(e.target.checked ? [...current, String(o.value)] : current.filter(v => v !== String(o.value))) }} />{o.label}</label>)}</fieldset>
  if (q.format === 'boolean') return <select {...common} value={value === undefined ? '' : String(value)} onChange={e => change(e.target.value === '' ? undefined : e.target.value === 'true')}><option value="">Select response</option><option value="true">Yes</option><option value="false">No</option></select>
  if (q.format === 'long_text') return <textarea {...common} rows={3} maxLength={10000} value={String(value ?? '')} onChange={e => change(e.target.value || undefined)} />
  if (!q.format) return <p role="status" className="text-sm text-[var(--text-muted)]">Choose a response format to preview this question.</p>
  return <input {...common} type={q.format === 'number' ? 'number' : q.format === 'url' ? 'url' : 'text'} min={q.scale?.min} max={q.scale?.max} step={q.scale?.step} maxLength={q.format === 'url' ? 2000 : 1000} placeholder={q.format === 'url' ? 'https://' : undefined} value={String(value ?? '')} onChange={e => change(e.target.value === '' ? undefined : q.format === 'number' ? Number(e.target.value) : e.target.value)} />
}
