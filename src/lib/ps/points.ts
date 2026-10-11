import { WorkflowError } from './domain'
import { validateStructure, validateResponses, YEARS, type Category, type Purpose, type Question, type Structure, type TypedResponse } from './rubricV2'
// PS rubrics score by adding points, as the Google Forms did. A section's importance is the points it holds.
export const POINTS_POLICY = 'points_v1' as const
export const POINT_PURPOSES = ['SCORED_CRITERION', 'BONUS', 'PENALTY', 'RED_FLAG'] as const
export const UNSCORED_FORMATS = ['short_text', 'long_text', 'url', 'single_choice'] as const
const INFORMATIONAL = ['instructions', 'interview_guide', 'basic_information']
export function isPoints(r: { scoring_policy?: string }) { return r.scoring_policy === POINTS_POLICY }
export function isPointsQuestion(q: Question) { return q.format === 'numeric_choice' && POINT_PURPOSES.includes(q.purpose as typeof POINT_PURPOSES[number]) }
const round2 = (n: number) => Math.round(n * 100) / 100
function fail(message: string): never { throw new WorkflowError(message) }

export function validatePoints(input: unknown, publishing = false): Structure {
  const s = validateStructure(input, publishing)
  if (!isPoints(s)) return s
  if (s.categories.length > 30) fail('A rubric can contain at most 30 sections.')
  if (s.weighting !== 'unconfigured' || s.categories.some(c => c.weight_bps !== null) || s.questions.some(q => q.weight_bps != null)) fail('Points rubrics have no percentage weights. A section counts by the points its questions hold.')
  if (!publishing) return s
  for (const q of s.questions) {
    if (q.format === 'numeric_choice') {
      if (!POINT_PURPOSES.includes(q.purpose as typeof POINT_PURPOSES[number])) fail(`Choose criterion, bonus, penalty or red flag for “${q.label}”.`)
      const values = q.options.map(o => Number(o.value))
      if (values.length < 2) fail(`“${q.label}” needs at least two point choices.`)
      if (q.purpose === 'SCORED_CRITERION' && values.some(v => v < 0)) fail(`Criterion “${q.label}” can't have negative points. Make it a penalty or red flag instead.`)
      if (q.purpose === 'BONUS' && (values.some(v => v < 0) || Math.max(...values) <= 0)) fail(`Bonus “${q.label}” needs positive points and no negative choices.`)
      if ((q.purpose === 'PENALTY' || q.purpose === 'RED_FLAG') && (values.some(v => v > 0) || Math.min(...values) >= 0)) fail(`“${q.label}” needs negative points and no positive choices.`)
    } else {
      if (!UNSCORED_FORMATS.includes(q.format as typeof UNSCORED_FORMATS[number])) fail(`Choose points, short answer, paragraph, link or multiple choice for “${q.label}”.`)
      if (POINT_PURPOSES.includes(q.purpose as typeof POINT_PURPOSES[number])) fail(`“${q.label}” is a written or choice answer, so it can't carry points.`)
      if (q.format === 'single_choice' && (q.options.length < 2 || q.options.some(o => !o.label.trim()) || new Set(q.options.map(o => o.label.trim().toLowerCase())).size !== q.options.length)) fail(`Multiple choice “${q.label}” needs at least two distinct options.`)
    }
  }
  for (const c of s.categories) if (!INFORMATIONAL.includes(c.kind ?? '') && !s.questions.some(q => q.category_id === c.id)) fail(`Add a question to “${c.name}” or remove the section.`)
  for (const year of YEARS) if (!visibleQuestions(s, year).some(q => q.purpose === 'SCORED_CRITERION')) fail(`${year} applicants would see no scored criteria. Check the grade settings on each section.`)
  return s
}

export function sectionVisible(c: Category, year: string) { return !c.show_for_years || c.show_for_years.includes(year) }
function requireYear(s: Structure, year: string | null | undefined): string {
  if (year && (YEARS as readonly string[]).includes(year)) return year
  if (s.categories.some(c => c.show_for_years)) fail('This rubric has grade-specific sections, but the applicant has no grade on file. Update the applicant record first.')
  return ''
}
export function visibleQuestions(s: Structure, year: string) {
  const shown = new Set(s.categories.filter(c => sectionVisible(c, year)).map(c => c.id))
  return s.questions.filter(q => shown.has(q.category_id))
}

const extreme = (q: Question, pick: (...n: number[]) => number) => pick(...q.options.map(o => Number(o.value)))
// Points available to one applicant. "max" includes bonuses so a perfect review reads 100%.
export function pointsRange(questions: Question[]) {
  let criteria = 0, bonus = 0, penalty = 0
  for (const q of questions) {
    if (!isPointsQuestion(q) || !q.options.length) continue
    if (q.purpose === 'SCORED_CRITERION') criteria += extreme(q, Math.max)
    else if (q.purpose === 'BONUS') bonus += extreme(q, Math.max)
    else penalty += extreme(q, Math.min)
  }
  return { criteria: round2(criteria), bonus: round2(bonus), penalty: round2(penalty), max: round2(criteria + bonus) }
}
export function sectionRange(s: Structure, categoryId: string) { return pointsRange(s.questions.filter(q => q.category_id === categoryId)) }
// Editor summary across grades; conditional sections can make the maximum differ by grade.
export function rubricRange(s: Structure) {
  const ranges = YEARS.map(year => pointsRange(visibleQuestions(s, year)))
  const maxes = ranges.map(r => r.max)
  return { ...ranges[0], max_low: Math.min(...maxes), max_high: Math.max(...maxes), differs_by_grade: new Set(maxes).size > 1 }
}

export type PointsResult = { question_id: string; purpose: Purpose; points: number }
export type PointsScore = { responses: TypedResponse[]; question_results: PointsResult[]; criteria: number; bonus: number; penalty: number; total: number; max: number; percent: number; section_totals: { category_id: string; points: number; max: number }[] }
export function scorePoints(s: Structure, input: unknown, year: string | null | undefined): PointsScore {
  const questions = visibleQuestions(s, requireYear(s, year))
  const responses = validateResponses(questions, input).filter(r => typeof r.value !== 'string' || !!r.value.trim())
  const question_results: PointsResult[] = responses.flatMap(r => {
    const q = questions.find(q => q.id === r.question_id)!
    return isPointsQuestion(q) ? [{ question_id: q.id, purpose: q.purpose!, points: Number(r.value) }] : []
  })
  const sum = (purposes: Purpose[]) => round2(question_results.filter(r => purposes.includes(r.purpose)).reduce((n, r) => n + r.points, 0))
  const criteria = sum(['SCORED_CRITERION']), bonus = sum(['BONUS']), penalty = sum(['PENALTY', 'RED_FLAG'])
  const total = round2(criteria + bonus + penalty), { max } = pointsRange(questions)
  const shown = s.categories.filter(c => questions.some(q => q.category_id === c.id))
  const section_totals = shown.map(c => ({ category_id: c.id, points: round2(question_results.filter(r => questions.find(q => q.id === r.question_id)!.category_id === c.id).reduce((n, r) => n + r.points, 0)), max: sectionRange({ ...s, questions }, c.id).max })).filter(t => t.max || t.points)
  return { responses, question_results, criteria, bonus, penalty, total, max, percent: max ? round2(total / max * 100) : 0, section_totals }
}

// After grading starts, a new version may reword text but must keep what reviewers answered and how it scores.
export function scoringChanges(before: Structure, after: Structure): string[] {
  const changes: string[] = []
  const sections = (s: Structure) => new Map(s.categories.map(c => [c.id, JSON.stringify(c.show_for_years ?? null)]))
  const a = sections(before), b = sections(after)
  if (a.size !== b.size || [...a].some(([id, years]) => b.get(id) !== years)) changes.push('sections or their grade settings')
  const shape = (q: Question) => JSON.stringify([q.category_id, q.format, q.purpose, q.required, q.options.map(o => o.value), q.scale])
  const qa = new Map(before.questions.map(q => [q.id, shape(q)])), qb = new Map(after.questions.map(q => [q.id, shape(q)]))
  if (qa.size !== qb.size || [...qa].some(([id, s]) => qb.get(id) !== s)) changes.push('questions, answer types or point values')
  return changes
}
// Explicit conversion of an editable copy (older weighted or imported rubrics). Published records are untouched.
export function pointsCopy(input: Structure): Structure {
  const s = structuredClone(input)
  if (isPoints(s)) return s
  const questions = s.questions.map(q => {
    const next: Question = { ...q }
    delete next.weight_bps; delete next.source
    if (q.format === 'number' && q.scale) {
      const count = Math.floor((q.scale.max - q.scale.min) / q.scale.step + 1e-8) + 1
      next.format = 'numeric_choice'; next.scale = null
      next.options = Array.from({ length: Math.min(count, 21) }, (_, i) => ({ value: round2(q.scale!.min + i * q.scale!.step), label: '' }))
      if (q.purpose === null || q.purpose === 'QUALITATIVE') next.purpose = 'SCORED_CRITERION'
    } else if (q.format === 'boolean') {
      next.format = 'single_choice'; next.options = [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]
    }
    return next
  })
  return { ...s, scoring_policy: POINTS_POLICY, weighting: 'unconfigured', description: s.description ?? '', categories: s.categories.map(c => ({ ...c, weight_bps: null })), questions }
}
export function newPointsQuestion(category_id: string, id: string): Question {
  return { id, category_id, label: '', description: '', order: 0, purpose: 'SCORED_CRITERION', format: 'numeric_choice', required: true, confirmed: true, scale: null, options: [0, 1, 2, 3].map(value => ({ value, label: '' })), min_label: '', max_label: '' }
}
export function choiceLabel(o: { value: string | number; label: string }) { return o.label.trim() || String(o.value) }
