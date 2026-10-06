import { WorkflowError } from './domain'
export type Criterion = { id: string; name: string; description: string; order: number; weight: number | null; scale: { min: number; max: number; step: number } | null; options: { value: number; label: string }[] }
export type Rubric = { id: string; round_id: string; name: string; version: number; criteria: Criterion[] }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) }
export function validateRubric(body: Record<string, unknown>): { name: string; criteria: Criterion[] } {
  if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 200) throw new WorkflowError('A rubric name of 1–200 characters is required.')
  if (!Array.isArray(body.criteria) || body.criteria.length < 1 || body.criteria.length > 100) throw new WorkflowError('A rubric needs between 1 and 100 criteria.')
  const ids = new Set<string>()
  const criteria = body.criteria.map((raw, order): Criterion => {
    if (!record(raw) || typeof raw.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(raw.id) || ids.has(raw.id) || Object.hasOwn(Object.prototype, raw.id) || raw.id === 'prototype') throw new WorkflowError('Criterion IDs must be unique and stable.')
    ids.add(raw.id)
    if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 200 || typeof raw.description !== 'string' || raw.description.length > 2000) throw new WorkflowError('Each criterion needs a name and a description of at most 2,000 characters.')
    const weight = raw.weight ?? null
    if (weight !== null && (!finite(weight) || weight < 0)) throw new WorkflowError('Weight metadata must be a nonnegative finite number.')
    if ('options' in raw && !Array.isArray(raw.options)) throw new WorkflowError('Rating options must be an array.')
    let scale: Criterion['scale'] = null
    const options: Criterion['options'] = []
    if (Array.isArray(raw.options) && raw.options.length) {
      if (raw.options.length > 100 || (raw.scale !== null && raw.scale !== undefined)) throw new WorkflowError('Choose either a numeric scale or rating options.')
      for (const option of raw.options) {
        if (!record(option) || !finite(option.value) || typeof option.label !== 'string' || !option.label.trim() || option.label.length > 200 || options.some(o => o.value === option.value)) throw new WorkflowError('Rating options need unique finite values and labels.')
        options.push({ value: option.value, label: option.label.trim() })
      }
    } else {
      if (!record(raw.scale) || !finite(raw.scale.min) || !finite(raw.scale.max) || !finite(raw.scale.step) || raw.scale.max <= raw.scale.min || raw.scale.step <= 0 || raw.scale.step > raw.scale.max - raw.scale.min) throw new WorkflowError('Numeric scales require min < max and a positive step no larger than the range.')
      scale = { min: raw.scale.min, max: raw.scale.max, step: raw.scale.step }
    }
    return { id: raw.id, name: raw.name.trim(), description: raw.description.trim(), order, weight: weight as number | null, scale, options }
  })
  return { name: body.name.trim(), criteria }
}
export function validateRatings(criteria: Criterion[], ratings: unknown) {
  if (!Array.isArray(ratings) || ratings.length !== criteria.length) throw new WorkflowError('Rate every configured criterion exactly once.')
  const seen = new Set<string>()
  return ratings.map(raw => {
    if (!record(raw) || typeof raw.criterion_id !== 'string' || seen.has(raw.criterion_id) || !finite(raw.raw_score)) throw new WorkflowError('Ratings need distinct criterion IDs and finite raw scores.')
    seen.add(raw.criterion_id)
    const criterion = criteria.find(c => c.id === raw.criterion_id)
    if (!criterion) throw new WorkflowError('Unknown criterion ID.')
    const value = raw.raw_score
    if (criterion.options.length) { if (!criterion.options.some(o => o.value === value)) throw new WorkflowError(`Invalid rating for ${criterion.name}.`) }
    else {
      const scale = criterion.scale!
      const position = (value - scale.min) / scale.step
      if (value < scale.min || value > scale.max || Math.abs(position - Math.round(position)) > 1e-8) throw new WorkflowError(`Rating for ${criterion.name} does not match its configured scale.`)
    }
    return { criterion_id: raw.criterion_id, raw_score: value }
  })
}
export function validateReviewAccess(input: { actor: string; assignedTo: string | null; state: string; rubricId: string; submittedRubricId: unknown }) {
  if (!input.assignedTo || input.actor !== input.assignedTo) throw new WorkflowError('You must own the assignment to submit a review.', 403)
  if (!['pending', 'in_review', 'ready_for_deliberation'].includes(input.state)) throw new WorkflowError('This applicant is not accepting reviews in this round.', 409)
  if (input.submittedRubricId !== input.rubricId) throw new WorkflowError('Rubric version changed. Reload the grading form.', 409)
}
// No permanent PS import format is assumed. Register a reviewed parser here once supplied.
export interface RubricImportParser { format: string; parse: (data: string) => { name: string; criteria: Criterion[] } }
export function parseRubricImport(format: string, data: string): never { void format; void data; throw new WorkflowError('Rubric template import is not configured. Add criteria on the website until the PS template is supplied.', 409) }
