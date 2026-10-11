import { WorkflowError } from './domain'
import { validateStructure, validateResponses, type Structure, type TypedResponse, type Question } from './rubricV2'
export const WEIGHTED_POLICY = 'question_weighted_0_3' as const
export function isWeighted(r: { scoring_policy?: string }) { return r.scoring_policy === WEIGHTED_POLICY }
export function weightSummary(s: Structure) {
  const scored = s.questions.filter(q => q.format === 'number')
  const total = scored.reduce((n, q) => n + (q.weight_bps ?? 0), 0)
  const missing = scored.filter(q => !q.weight_bps).length
  return { total, missing, valid: scored.length > 0 && !missing && total === 10000 }
}
// Explicit, additive conversion of an editable copy. Published records remain untouched.
export function weightedCopy(input: Structure): Structure {
  if (isWeighted(input)) return structuredClone(input)
  const s = structuredClone(input), scored = s.questions.filter(q => q.format === 'number' && q.purpose === 'SCORED_CRITERION')
  const base = scored.length ? Math.floor(10000 / scored.length) : 0
  let remainder = 10000 - base * scored.length
  return { ...s, scoring_policy: WEIGHTED_POLICY, description: s.description ?? '', weighting: 'unconfigured', categories: s.categories.map(c => ({ ...c, kind: 'general', weight_bps: null })), questions: s.questions.map(q => ({ ...q, weight_bps: scored.includes(q) ? base + (remainder-- > 0 ? 1 : 0) : null })) }
}
export function validateWeighted(input: unknown, publishing = false): Structure {
  const s = validateStructure(input, publishing)
  if (!isWeighted(s)) return s
  const fail = (m: string): never => { throw new WorkflowError(m) }
  if (s.categories.length > 20) fail('A rubric can contain at most 20 sections.')
  if (s.weighting !== 'unconfigured' || s.categories.some(c => c.weight_bps !== null)) fail('Weights belong to linear-scale questions, not sections.')
  if (s.questions.some(q => s.categories.some(c => c.id === q.id))) fail('Section and question IDs must be distinct.')
  for (const q of s.questions) {
    if (q.format !== 'number' && q.weight_bps != null) fail('Only linear-scale questions have weights.')
    if (!publishing) continue
    if (!['number', 'short_text', 'long_text', 'single_choice'].includes(String(q.format))) fail('Choose linear scale, short answer, paragraph or multiple choice for each question.')
    if (q.format === 'number') {
      if (q.purpose !== 'SCORED_CRITERION') fail('Linear scales must be explicitly configured as scored criteria. Evidence questions must use an unscored response type.')
      if (!q.scale || !Number.isInteger(q.scale.min) || !Number.isInteger(q.scale.max) || q.scale.min < 0 || q.scale.max > 10 || q.scale.max <= q.scale.min || q.scale.step !== 1) fail('Scales need whole-number bounds between 0 and 10, maximum above minimum, and step 1.')
    } else {
      if (q.purpose === 'SCORED_CRITERION') fail('Written answers and multiple choice are unscored context.')
      if (q.format === 'single_choice' && (q.options.length < 2 || new Set(q.options.map(o => o.label.trim().toLowerCase())).size !== q.options.length)) fail('Multiple choice needs at least two distinct, nonempty options.')
    }
  }
  if (publishing) {
    if (s.categories.some(c => !s.questions.some(q => q.category_id === c.id))) fail('Every section needs at least one question before publication.')
    if (!weightSummary(s).valid) fail('Assign a positive weight to every linear-scale question; weights must total exactly 100%.')
  }
  return s
}
export function scoreEvaluation(s: Structure, input: unknown) {
  validateWeighted(s, true)
  const responses = validateResponses(s.questions, input).filter(r => typeof r.value !== 'string' || !!r.value.trim())
  const results = responses.flatMap(r => {
    const q = s.questions.find(q => q.id === r.question_id)!
    if (q.format !== 'number') return []
    const normalized = (Number(r.value) - q.scale!.min) / (q.scale!.max - q.scale!.min) * 3
    return [{ question_id: q.id, raw_score: Number(r.value), normalized_score: normalized, weight_bps: q.weight_bps! }]
  })
  const answeredWeight = results.reduce((n, r) => n + r.weight_bps, 0)
  if (!answeredWeight) throw new WorkflowError('Answer at least one linear-scale scoring question.')
  return { responses, question_results: results, answered_weight_bps: answeredWeight, score: results.reduce((n, r) => n + r.normalized_score * r.weight_bps, 0) / answeredWeight }
}
export function newScaleQuestion(category_id: string, id: string): Question {
  return { id, category_id, label: '', description: '', order: 0, purpose: 'SCORED_CRITERION', format: 'number', required: true, confirmed: true, scale: { min: 0, max: 3, step: 1 }, options: [], weight_bps: null, min_label: '', max_label: '' }
}
export function duplicateWeighted(s: Structure, id: string, newId: string): Structure {
  const i = s.questions.findIndex(q => q.id === id)
  if (i < 0) return s
  const copy = { ...structuredClone(s.questions[i]), id: newId, weight_bps: null }; delete copy.source
  return { ...s, questions: [...s.questions.slice(0, i + 1), copy, ...s.questions.slice(i + 1)] }
}
// The mock's section JSON is the interchange format; canonical V2 JSON is also accepted.
export function importRubricJSON(input: unknown): Structure {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new WorkflowError('Import a rubric object containing a title and sections.')
  const b = input as Record<string, unknown>
  if (b.schema_version === 2) return validateImported(validateWeighted({ ...b, scoring_policy: WEIGHTED_POLICY }))
  if (!Array.isArray(b.sections)) throw new WorkflowError('Rubric JSON must contain a sections array.')
  const formats: Record<string, Question['format']> = { scale: 'number', short: 'short_text', paragraph: 'long_text', choice: 'single_choice' }
  const categories: Structure['categories'] = [], questions: Question[] = []
  for (const raw of b.sections) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new WorkflowError('Invalid section.')
    const section = raw as Record<string, unknown>
    categories.push({ id: section.id as string, name: section.title as string, description: (section.instructions ?? '') as string, order: categories.length, kind: 'general', weight_bps: null })
    if (!Array.isArray(section.questions)) throw new WorkflowError('Every section needs a questions array.')
    for (const rawQuestion of section.questions) {
      if (!rawQuestion || typeof rawQuestion !== 'object' || Array.isArray(rawQuestion)) throw new WorkflowError('Invalid question.')
      const q = rawQuestion as Record<string, unknown>, format = formats[String(q.type)]
      if (!format) throw new WorkflowError('Unsupported question type in JSON.')
      if (q.weight !== undefined && (typeof q.weight !== 'number' || !Number.isFinite(q.weight) || Math.abs(q.weight * 100 - Math.round(q.weight * 100)) > 1e-8)) throw new WorkflowError('Question weights must be percentages with at most two decimals.')
      if (q.options !== undefined && (!Array.isArray(q.options) || q.options.some(o => typeof o !== 'string'))) throw new WorkflowError('Options must be text.')
      questions.push({ id: q.id as string, category_id: section.id as string, label: q.title as string, description: (q.description ?? '') as string, order: questions.length, required: q.required as boolean, confirmed: true, purpose: format === 'number' ? 'SCORED_CRITERION' : 'QUALITATIVE', format, scale: format === 'number' ? { min: q.min as number, max: q.max as number, step: 1 } : null, options: format === 'single_choice' ? (q.options as string[] ?? []).map((label, i) => ({ value: `option_${i + 1}`, label })) : [], weight_bps: q.weight_bps !== undefined ? q.weight_bps as number : q.weight === undefined ? null : Number(q.weight) * 100, min_label: (q.low ?? '') as string, max_label: (q.high ?? '') as string })
    }
  }
  // Validate structural/type errors on import; missing weights and blank draft titles remain editable.
  const s = validateWeighted({ schema_version: 2, scoring_policy: WEIGHTED_POLICY, name: b.title, description: b.description ?? '', categories, questions, weighting: 'unconfigured' })
  return validateImported(s)
}
function validateImported(s: Structure) {
  if (!s.name.trim() || s.categories.some(c => !c.name.trim() || !s.questions.some(q => q.category_id === c.id)) || s.questions.some(q => !q.label.trim())) throw new WorkflowError('Imported rubrics need a title, titled sections with questions, and question titles.')
  if (!s.questions.some(q => q.format === 'number')) throw new WorkflowError('Imported rubrics need at least one linear-scale scoring question.')
  for (const q of s.questions) {
    if (!['number', 'short_text', 'long_text', 'single_choice'].includes(String(q.format)) || typeof q.required !== 'boolean') throw new WorkflowError('Imported questions need a supported type and Required state.')
    if (q.format === 'number' && (!q.scale || !Number.isInteger(q.scale.min) || !Number.isInteger(q.scale.max) || q.scale.min < 0 || q.scale.max > 10 || q.scale.max <= q.scale.min || q.scale.step !== 1)) throw new WorkflowError('Invalid imported scale bounds.')
    if (q.format === 'single_choice' && (q.options.length < 2 || q.options.some(o => !o.label.trim()) || new Set(q.options.map(o => o.label.trim().toLowerCase())).size !== q.options.length)) throw new WorkflowError('Invalid imported multiple-choice options.')
  }
  return s
}
export function exportRubricJSON(s: Structure) { return structuredClone(s) }
export type Evaluation = { id: string; round_id: string; applicant_id: string; grader_email: string; rubric_version_id: string; revision: number; responses: TypedResponse[]; comments: string; score: number; submitted_at: string; supersedes_id?: string | null; is_current?: boolean }
export function aggregateEvaluations(rows: Evaluation[]) {
  const groups = new Map<string, { applicant_id: string; rubric_version_id: string; scores: number[]; input_review_ids: string[] }>()
  for (const r of rows) {
    const key = `${r.applicant_id}:${r.rubric_version_id}`
    const g = groups.get(key) ?? { applicant_id: r.applicant_id, rubric_version_id: r.rubric_version_id, scores: [], input_review_ids: [] }
    g.scores.push(r.score); g.input_review_ids.push(r.id); groups.set(key, g)
  }
  return [...groups.values()].map(g => ({ applicant_id: g.applicant_id, rubric_version_id: g.rubric_version_id, reviewer_count: g.scores.length, score: g.scores.reduce((a, b) => a + b, 0) / g.scores.length, input_review_ids: g.input_review_ids, engine: WEIGHTED_POLICY, status: 'calculated' }))
}
