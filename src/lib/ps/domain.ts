export const EVALUATION_TYPES = ['rubric', 'interview', 'social_feedback', 'submission_rubric'] as const
export type EvaluationType = typeof EVALUATION_TYPES[number]
export class WorkflowError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}
export type OrderedRound = { id: string; order_index: number; archived?: boolean }
export function nextRound(rounds: OrderedRound[], currentId: string) {
  const current = rounds.find(r => r.id === currentId)
  if (!current) throw new WorkflowError('Round not found.', 404)
  return rounds.filter(r => !r.archived && r.order_index > current.order_index)
    .sort((a, b) => a.order_index - b.order_index)[0] ?? null
}
export function validateOrder(rounds: OrderedRound[], ids: unknown): string[] {
  if (!Array.isArray(ids) || ids.length !== rounds.length || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !rounds.some(r => r.id === id))) {
    throw new WorkflowError('Supply every configured round ID exactly once.')
  }
  return ids as string[]
}
export function validateConfiguration(body: Record<string, unknown>) {
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name || name.length > 200) throw new WorkflowError('Round name must contain 1–200 characters.')
  if (!EVALUATION_TYPES.includes(body.evaluation_type as EvaluationType)) throw new WorkflowError('Choose a supported evaluation type.')
  if (!Array.isArray(body.eligible_grader_emails) || body.eligible_grader_emails.length > 500 || body.eligible_grader_emails.some(e => typeof e !== 'string' || e.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))) throw new WorkflowError('Select valid eligible graders.')
  const emails = [...new Set((body.eligible_grader_emails as string[]).map(e => e.trim().toLowerCase()))].sort()
  const mode = body.assignment_mode ?? 'individual'
  if (!ASSIGNMENT_MODES.includes(mode as AssignmentMode)) throw new WorkflowError('Choose individual graders or interviewer pairs.')
  const pairs = mode === 'pair' ? validatePairs(body.interviewer_pairs ?? [], emails) : []
  const n = body.reviews_required
  // Pair rounds may be created before pairs are chosen; generation waits until enough pairs exist.
  const units = mode === 'pair' ? Math.max(pairs.length, 1) : emails.length
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > units) throw new WorkflowError(mode === 'pair' ? 'Pairs per candidate must be at least 1 and no more than the number of pairs.' : 'Reviews required must be at least 1 and no greater than the eligible grader count.')
  return { name, evaluation_type: body.evaluation_type as EvaluationType, eligible_grader_emails: emails, reviews_required: n, assignment_mode: mode as AssignmentMode, interviewer_pairs: pairs }
}
export const ASSIGNMENT_MODES = ['individual', 'pair'] as const
export type AssignmentMode = typeof ASSIGNMENT_MODES[number]
export type InterviewerPair = { id: string; emails: string[] }
// Each pair is 2–3 eligible interviewers; a person belongs to at most one pair so workloads stay even.
export function validatePairs(input: unknown, eligible: string[]): InterviewerPair[] {
  if (!Array.isArray(input) || input.length > 100) throw new WorkflowError('Provide at most 100 interviewer pairs.')
  const ids = new Set<string>(), seen = new Set<string>()
  return input.map(raw => {
    const p = raw as Record<string, unknown>
    if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !/^[\w-]{1,100}$/.test(p.id) || ids.has(p.id)) throw new WorkflowError('Interviewer pairs need unique IDs.')
    ids.add(p.id)
    if (!Array.isArray(p.emails) || p.emails.length < 2 || p.emails.length > 3 || p.emails.some(e => typeof e !== 'string')) throw new WorkflowError('Each interviewer pair needs two or three people.')
    const emails = [...new Set((p.emails as string[]).map(e => e.trim().toLowerCase()))]
    if (emails.length !== p.emails.length) throw new WorkflowError('A pair cannot list the same person twice.')
    for (const email of emails) {
      if (!eligible.includes(email)) throw new WorkflowError(`${email} must be an eligible grader for this round before joining a pair.`)
      if (seen.has(email)) throw new WorkflowError(`${email} is in more than one pair.`)
      seen.add(email)
    }
    return { id: p.id, emails: emails.sort() }
  })
}
export function pairLabel(pair: InterviewerPair) { return pair.emails.map(e => e.split('@')[0]).join(' & ') }

export function transition(state: string, action: string, hasNext: boolean) {
  if (!['advance', 'hold', 'reject'].includes(action)) throw new WorkflowError('Choose Advance, Hold or Reject.')
  if (state === 'advanced') { if (action === 'advance') return 'advanced'; throw new WorkflowError('An advanced enrollment cannot be changed; its history is preserved.', 409) }
  if (state === 'rejected') { if (action === 'reject') return 'rejected'; throw new WorkflowError('A rejected enrollment cannot be advanced.', 409) }
  if (action === 'advance' && !hasNext) throw new WorkflowError('This is the final configured round. Final decisions belong to the existing decision workflow.', 409)
  return action === 'advance' ? 'advanced' : action === 'hold' ? 'hold' : 'rejected'
}
