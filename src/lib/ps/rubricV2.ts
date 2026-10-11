import { WorkflowError } from './domain'

export const PURPOSES = ['SCORED_CRITERION', 'PENALTY', 'BONUS', 'QUALITATIVE', 'DECISION_SIGNAL', 'RED_FLAG'] as const
export const FORMATS = ['number', 'numeric_choice', 'single_choice', 'multiple_choice', 'boolean', 'short_text', 'long_text', 'url'] as const
export type Purpose = typeof PURPOSES[number]
export type Format = typeof FORMATS[number]
export type ResponseValue = string | number | boolean | string[]
export type Question = {
  id: string; category_id: string; label: string; description: string; order: number
  purpose: Purpose | null; format: Format | null; required: boolean | null; confirmed: boolean
  scale: { min: number; max: number; step: number } | null
  options: { value: string | number; label: string }[]
  weight_bps?: number | null; min_label?: string; max_label?: string
  source?: { sheet: string; column: number; header: string; suggestion: string }
}
export const SECTION_KINDS = ['instructions', 'basic_information', 'interview_guide', 'scoring', 'general'] as const
export type SectionKind = typeof SECTION_KINDS[number]
// Matches the applicant intake's allowed years.
export const YEARS = ['Freshman', 'Sophomore', 'Junior', 'Senior'] as const
export const SCORING_POLICIES = ['question_weighted_0_3', 'points_v1'] as const
export type ScoringPolicy = typeof SCORING_POLICIES[number]
export type Category = { id: string; name: string; order: number; weight_bps: number | null; kind?: SectionKind; description?: string; show_for_years?: string[] }
export type Structure = { schema_version: 2; name: string; categories: Category[]; questions: Question[]; weighting: 'unconfigured' | 'configured'; description?: string; scoring_policy?: ScoringPolicy }
export type RubricV2 = Structure & { id: string; round_id: string; version: number; scoring_configuration_id: string }
export type Draft = Structure & { id: string; round_id: string; revision: number; status: 'editing' | 'published'; published_version_id: string | null; provenance: Record<string, string> }
export type TypedResponse = { question_id: string; format: Format; value: ResponseValue }
function fail(message: string): never { throw new WorkflowError(message) }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Invalid rubric structure.'); return value as Record<string, unknown> }
function text(value: unknown, max: number, field: string, blank = false) { if (typeof value !== 'string' || value.length > max || (!blank && !value.trim())) fail(`${field} must be text of at most ${max} characters.`); return value as string }
function id(value: unknown) { const s = text(value, 100, 'ID'); if (!/^[\w-]+$/.test(s) || ['__proto__', 'prototype', 'constructor'].includes(s)) fail('Invalid stable ID.'); return s }
export function validateStructure(input: unknown, publishing = false): Structure {
  const b = record(input)
  if (b.scoring_policy !== undefined && !SCORING_POLICIES.includes(b.scoring_policy as ScoringPolicy)) fail('Unsupported scoring policy.')
  // Policy-based drafts may keep blank titles and labels until publication.
  const weighted = b.scoring_policy !== undefined
  const name = text(b.name, 200, 'Rubric name', weighted && !publishing)
  if (!Array.isArray(b.categories) || !b.categories.length || b.categories.length > 50) fail('Provide 1–50 categories.')
  if (!Array.isArray(b.questions) || b.questions.length > 200) fail('Provide at most 200 questions.')
  if (publishing && !b.questions.length) fail('Add at least one response question before publishing.')
  const categoryIds = new Set<string>(), questionIds = new Set<string>()
  const categories: Category[] = b.categories.map((raw, order) => {
    const c = record(raw), key = id(c.id)
    if (categoryIds.has(key)) fail('Category IDs must be unique.'); categoryIds.add(key)
    const weight = c.weight_bps
    if (weight !== null && (!Number.isInteger(weight) || Number(weight) < 0 || Number(weight) > 10000)) fail('Category weights must be whole basis points from 0 to 10000, or null.')
    if (c.kind !== undefined && !SECTION_KINDS.includes(c.kind as SectionKind)) fail('Invalid section preset.')
    const years = c.show_for_years
    if (years !== undefined && (!Array.isArray(years) || !years.length || new Set(years).size !== years.length || years.some(y => !YEARS.includes(y)))) fail('Choose at least one grade for a grade-specific section.')
    return { id: key, name: text(c.name, 500, 'Section title', weighted && !publishing), order, weight_bps: weight as number | null, ...(c.kind === undefined ? {} : { kind: c.kind as SectionKind }), description: text(c.description ?? '', 10000, 'Section content', true), ...(years === undefined ? {} : { show_for_years: YEARS.filter(y => (years as string[]).includes(y)) }) }
  })
  const questions: Question[] = b.questions.map((raw, order) => {
    const q = record(raw), key = id(q.id), category_id = id(q.category_id)
    if (questionIds.has(key)) fail('Question IDs must be unique.'); questionIds.add(key)
    if (!categoryIds.has(category_id)) fail('Every question needs an existing category.')
    if (q.purpose !== null && !PURPOSES.includes(q.purpose as Purpose)) fail('Invalid question purpose.')
    if (q.format !== null && !FORMATS.includes(q.format as Format)) fail('Invalid response format.')
    if (q.required !== null && typeof q.required !== 'boolean') fail('Confirm required or optional for every question.')
    if (typeof q.confirmed !== 'boolean') fail('Confirm question configuration.')
    if (publishing && (!q.confirmed || q.purpose === null || q.format === null || q.required === null)) fail('Confirm purpose, format, required status and configuration for every question before publishing.')
    let scale: Question['scale'] = null
    if (q.scale !== null) {
      const s = record(q.scale)
      if (![s.min, s.max, s.step].every(v => typeof v === 'number' && Number.isFinite(v)) || (!(weighted && !publishing) && (Number(s.min) >= Number(s.max) || Number(s.step) <= 0 || Number(s.step) > Number(s.max) - Number(s.min)))) fail('Numeric scales need finite min < max and a positive step within the range.')
      scale = { min: Number(s.min), max: Number(s.max), step: Number(s.step) }
    }
    if (!Array.isArray(q.options) || q.options.length > 100) fail('Provide at most 100 options.')
    const options: Question['options'] = q.options.map(raw => {
      const o = record(raw)
      if (q.format === 'numeric_choice') { if (typeof o.value !== 'number' || !Number.isFinite(o.value)) fail('Numeric options need finite numeric values.') }
      else text(o.value, 500, 'Option value')
      // Numeric choices may leave the label blank; the value is shown instead.
      return { value: o.value as number | string, label: text(o.label, 1000, 'Option label', (weighted && !publishing) || q.format === 'numeric_choice') }
    })
    if (new Set(options.map(o => o.value)).size !== options.length) fail('Option values must be unique.')
    if (publishing && q.format === 'number' && (!scale || options.length)) fail('Number questions need a scale and no options.')
    if (publishing && ['numeric_choice', 'single_choice', 'multiple_choice'].includes(String(q.format)) && (!options.length || scale)) fail('Choice questions need options and no numeric scale.')
    if (publishing && !['number', 'numeric_choice', 'single_choice', 'multiple_choice'].includes(String(q.format)) && (scale || options.length)) fail('Text, URL and boolean formats do not use scales or options.')
    const result: Question = { id: key, category_id, label: text(q.label, 4000, 'Question label', weighted && !publishing), description: text(q.description, 4000, 'Description', true), order, purpose: q.purpose as Purpose | null, format: q.format as Format | null, required: q.required as boolean | null, confirmed: q.confirmed, scale, options }
    if (q.weight_bps !== undefined) {
      if (q.weight_bps !== null && (!Number.isInteger(q.weight_bps) || Number(q.weight_bps) < 0 || Number(q.weight_bps) > 10000)) fail('Question weights must be whole basis points from 0 to 10000, or null.')
      result.weight_bps = q.weight_bps as number | null
    }
    if (q.min_label !== undefined) result.min_label = text(q.min_label, 300, 'Minimum label', true)
    if (q.max_label !== undefined) result.max_label = text(q.max_label, 300, 'Maximum label', true)
    if (q.source) { const s = record(q.source); if (!Number.isInteger(s.column) || Number(s.column) < 1 || Number(s.column) > 200) fail('Invalid source column.'); result.source = { sheet: text(s.sheet, 200, 'Sheet'), column: Number(s.column), header: text(s.header, 4000, 'Source header'), suggestion: text(s.suggestion, 1000, 'Suggestion', true) } }
    return result
  })
  if (!['configured', 'unconfigured'].includes(String(b.weighting))) fail('Invalid weighting configuration.')
  const scored = new Set(questions.filter(q => q.purpose === 'SCORED_CRITERION').map(q => q.category_id))
  for (const c of categories) {
    if (!c.kind) c.kind = scored.has(c.id) ? 'scoring' : 'general'
    if (scored.has(c.id) && ['instructions', 'basic_information', 'interview_guide'].includes(c.kind)) fail('Scored criteria belong in a scoring or general section, not an informational section.')
  }
  for (const c of categories) if (!scored.has(c.id) && c.weight_bps !== null) fail('Only categories containing scored criteria can have numerical weights.')
  if (b.weighting === 'configured') {
    if (publishing && (!scored.size || categories.some(c => scored.has(c.id) && c.weight_bps === null) || categories.reduce((n, c) => n + (c.weight_bps ?? 0), 0) !== 10000)) fail('Configured scored category weights must total exactly 100%.')
  } else if (categories.some(c => c.weight_bps !== null)) fail('Unconfigured weighting requires null weights.')
  return { schema_version: 2, name, categories, questions, weighting: b.weighting as Structure['weighting'], ...(weighted ? { scoring_policy: b.scoring_policy as ScoringPolicy } : {}), ...(b.description === undefined ? {} : { description: text(b.description, 10000, 'Rubric description', true) }) }
}
export function validateResponses(questions: Question[], input: unknown): TypedResponse[] {
  if (!Array.isArray(input) || input.length > questions.length) fail('Invalid typed responses.')
  const seen = new Set<string>()
  const responses: TypedResponse[] = input.map(raw => {
    const r = record(raw), q = questions.find(q => q.id === r.question_id)
    if (!q || seen.has(q.id) || r.format !== q.format) fail('Responses must match unique questions and formats in the published rubric.')
    seen.add(q.id)
    const v = r.value
    switch (q.format) {
      case 'number': {
        if (typeof v !== 'number' || !Number.isFinite(v) || !q.scale || v < q.scale.min || v > q.scale.max || Math.abs((v - q.scale.min) / q.scale.step - Math.round((v - q.scale.min) / q.scale.step)) > 1e-8) fail(`Invalid numeric response: ${q.label}`)
        break
      }
      case 'numeric_choice': case 'single_choice': if (!q.options.some(o => o.value === v)) fail(`Select a configured option: ${q.label}`); break
      case 'multiple_choice': if (!Array.isArray(v) || v.length > q.options.length || new Set(v).size !== v.length || v.some(x => typeof x !== 'string' || !q.options.some(o => o.value === x)) || (q.required && !v.length)) fail(`Invalid multiple choice response: ${q.label}`); break
      case 'boolean': if (typeof v !== 'boolean') fail(`Select yes or no: ${q.label}`); break
      case 'short_text': case 'long_text': case 'url': {
        text(v, q.format === 'short_text' ? 1000 : q.format === 'url' ? 2000 : 10000, q.label, !q.required)
        if (q.format === 'url' && v) { try { const url = new URL(String(v)); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('Use an HTTP(S) URL without credentials.') } catch { fail(`Invalid URL: ${q.label}`) } }
        break
      }
      default: fail('Published question format is not configured.')
    }
    return { question_id: q.id, format: q.format!, value: v as ResponseValue }
  })
  if (questions.some(q => q.required && !seen.has(q.id))) fail('Complete all required questions.')
  return responses
}
