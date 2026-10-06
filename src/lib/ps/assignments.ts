import { WorkflowError } from './domain'
// A "grader" here is any assignable unit: a person in individual rounds, an interviewer pair in pair rounds.
export type AssignmentPair = { applicant_id: string; grader_email: string }
export type AssignmentPlan = { rows: AssignmentPair[]; additions: AssignmentPair[]; removals: AssignmentPair[]; workload: { email: string; count: number }[]; total: number; spread: number }
// FNV-1a with a MurmurHash3 finalizer: stable and dependency-free, and well mixed even when IDs differ by one character.
function hash(text: string) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16
  return h >>> 0
}
export function planAssignments(input: { applicantIds: string[]; eligibleEmails: string[]; reviewsRequired: number; existing?: AssignmentPair[]; completed?: AssignmentPair[]; frozenApplicantIds?: string[]; seed?: string }): AssignmentPlan {
  const seed = input.seed ?? ''
  const rank = (id: string) => hash(`${seed}:${id}`)
  // Seeded order: reproducible, and unrelated to submission order or alphabetical names.
  const applicants = [...new Set(input.applicantIds)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  const emails = [...new Set(input.eligibleEmails.map(e => e.trim().toLowerCase()))].sort()
  const n = input.reviewsRequired
  if (!Number.isInteger(n) || n < 1 || n > emails.length) throw new WorkflowError('Reviews required must be between 1 and the eligible grader count.')
  const applicantSet = new Set(applicants), emailSet = new Set(emails)
  const frozen = new Set(input.frozenApplicantIds ?? [])
  const key = (p: AssignmentPair) => `${p.applicant_id}::${p.grader_email}`
  const normal = (p: AssignmentPair) => ({ applicant_id: p.applicant_id, grader_email: p.grader_email.trim().toLowerCase() })
  const completed = new Map<string, AssignmentPair>()
  for (const p of (input.completed ?? []).map(normal)) completed.set(key(p), p)
  const pairs = new Map<string, AssignmentPair>(), existingKeys = new Set((input.existing ?? []).map(p => key(normal(p)))), removals: AssignmentPair[] = []
  for (const p of [...(input.existing ?? []).map(normal), ...completed.values()]) {
    if (!applicantSet.has(p.applicant_id)) throw new WorkflowError('Existing assignments or reviews reference an applicant outside this round. Resolve this before generation.', 409)
    if (completed.has(key(p)) || frozen.has(p.applicant_id)) { pairs.set(key(p), p); continue }
    // Unstarted work for someone no longer eligible is released and reassigned.
    if (!emailSet.has(p.grader_email)) { removals.push(p); continue }
    pairs.set(key(p), p)
  }
  const load = new Map(emails.map(e => [e, 0]))
  for (const p of pairs.values()) if (load.has(p.grader_email)) load.set(p.grader_email, load.get(p.grader_email)! + 1)
  const pick = (candidates: string[], direction: 1 | -1) => candidates.sort((a, b) => direction * (load.get(a)! - load.get(b)!) || rank(a) - rank(b) || a.localeCompare(b))[0]
  for (const applicant of applicants) {
    const mine = () => [...pairs.values()].filter(p => p.applicant_id === applicant)
    // Frozen candidates still count toward workload, but never gain or lose work.
    if (frozen.has(applicant)) continue
    // Too many graders after N was lowered: release unstarted work from the busiest graders first.
    let removable = mine().filter(p => !completed.has(key(p)))
    while (mine().length > n && removable.length) {
      const email = pick(removable.map(p => p.grader_email), -1), p = removable.find(r => r.grader_email === email)!
      pairs.delete(key(p)); removals.push(p); load.set(email, load.get(email)! - 1)
      removable = removable.filter(r => r !== p)
    }
    const assigned = new Set(mine().map(p => p.grader_email))
    while (assigned.size < n) {
      const email = pick(emails.filter(e => !assigned.has(e)), 1)
      const pair = { applicant_id: applicant, grader_email: email }
      pairs.set(key(pair), pair); assigned.add(email); load.set(email, load.get(email)! + 1)
    }
  }
  const rows = [...pairs.values()].sort((a, b) => a.applicant_id.localeCompare(b.applicant_id) || a.grader_email.localeCompare(b.grader_email))
  const workload = emails.map(email => ({ email, count: load.get(email)! }))
  return { rows, additions: rows.filter(p => !existingKeys.has(key(p)) && emailSet.has(p.grader_email)), removals, workload, total: rows.length, spread: Math.max(...load.values()) - Math.min(...load.values()) }
}
