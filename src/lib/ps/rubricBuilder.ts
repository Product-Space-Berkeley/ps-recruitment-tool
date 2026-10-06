import type { Category, Question, SectionKind, Structure } from './rubricV2'
export const SECTION_LABELS: Record<SectionKind, string> = { instructions: 'Instructions', basic_information: 'Basic information', interview_guide: 'Interview / question guide', scoring: 'Scoring section', general: 'General section' }
export const PURPOSE_LABELS = { SCORED_CRITERION: 'Scored criterion', PENALTY: 'Penalty', BONUS: 'Bonus', QUALITATIVE: 'Qualitative response', DECISION_SIGNAL: 'Decision signal', RED_FLAG: 'Red flag evidence' }
export const FORMAT_LABELS = { number: 'Numeric scale', numeric_choice: 'Numeric choices', single_choice: 'Single choice', multiple_choice: 'Multiple choice', boolean: 'Yes / No', short_text: 'Short text', long_text: 'Long text', url: 'URL' }
export function sectionKind(c: Category, questions: Question[]): SectionKind { return c.kind ?? (questions.some(q => q.category_id === c.id && q.purpose === 'SCORED_CRITERION') ? 'scoring' : 'general') }
export function isScoringSection(c: Category, questions: Question[]) { return sectionKind(c, questions) === 'scoring' || (sectionKind(c, questions) === 'general' && questions.some(q => q.category_id === c.id && q.purpose === 'SCORED_CRITERION')) }
export function newSection(kind: SectionKind, id: string): Category { return { id, name: SECTION_LABELS[kind], kind, description: '', order: 0, weight_bps: null } }
export function newQuestion(section: Category, id: string): Question {
  const scored = section.kind === 'scoring'
  return { id, category_id: section.id, label: 'Untitled question', description: '', order: 0, purpose: scored ? 'SCORED_CRITERION' : 'QUALITATIVE', format: scored ? 'number' : 'short_text', required: false, confirmed: true, scale: scored ? { min: 0, max: 3, step: 1 } : null, options: [] }
}
export function reorder<T>(rows: T[], from: number, to: number): T[] {
  if (from < 0 || to < 0 || from >= rows.length || to >= rows.length) return rows
  const next = [...rows]; const [row] = next.splice(from, 1); next.splice(to, 0, row); return next
}
export function duplicateQuestion(questions: Question[], id: string, newId: string): Question[] {
  const index = questions.findIndex(q => q.id === id)
  if (index < 0) return questions
  const copy = structuredClone(questions[index]); copy.id = newId; copy.label = `${copy.label.slice(0, 3993)} (copy)`; delete copy.source
  return [...questions.slice(0, index + 1), copy, ...questions.slice(index + 1)]
}
export function removeSection(s: Structure, id: string): Structure { return { ...s, categories: s.categories.filter(c => c.id !== id), questions: s.questions.filter(q => q.category_id !== id) } }
export function normalizeWeights(s: Structure): Structure {
  const categories = s.categories.map(c => ({ ...c, weight_bps: s.questions.some(q => q.category_id === c.id && q.purpose === 'SCORED_CRITERION') && isScoringSection(c, s.questions) ? c.weight_bps : null }))
  return { ...s, categories, weighting: categories.some(c => c.weight_bps !== null) ? 'configured' : 'unconfigured' }
}
