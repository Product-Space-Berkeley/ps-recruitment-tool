export const NORMALIZATION_POLICY = 'reviewer_z_population_min3_v1'
type Evaluation = { applicant_id: string; grader: string; score: number; max_points: number }
export type Normalized = { applicant_id: string; cohort: string; z: number | null; recommendation: 'green' | 'yellow' | 'red'; diagnostic: string; rank: number | null; reviewer_z: { grader: string; z: number }[] }
export function normalizeRound(applicants: { id: string; year: string }[], evaluations: Evaluation[], required = 2): Normalized[] {
  const stats = new Map<string, { mean: number; sd: number; n: number; comparable: boolean }>()
  for (const grader of new Set(evaluations.map(e => e.grader))) {
    const rows = evaluations.filter(e => e.grader === grader), mean = rows.reduce((n, e) => n + e.score, 0) / rows.length
    stats.set(grader, { mean, sd: Math.sqrt(rows.reduce((n, e) => n + (e.score - mean) ** 2, 0) / rows.length), n: rows.length, comparable: new Set(rows.map(e => e.max_points)).size === 1 })
  }
  const compatibleMaximum = new Set(evaluations.map(e => e.max_points)).size <= 1
  const result: Normalized[] = applicants.map(a => {
    const label = a.year.toLowerCase(), cohort = label.startsWith('freshman') ? 'Freshmen' : label.startsWith('sophomore') ? 'Sophomores' : label.startsWith('junior') ? 'Juniors / transfers' : 'Unclassified'
    const rows = evaluations.filter(e => e.applicant_id === a.id)
    let diagnostic = rows.length !== required || new Set(rows.map(e => e.grader)).size !== required ? 'Needs two independent evaluations' : ''
    if (!diagnostic && !compatibleMaximum) diagnostic = 'Rubric maximum points differ within this round'
    if (!diagnostic && rows.some(e => { const s = stats.get(e.grader)!; return s.n < 3 || s.sd < 1e-9 || !s.comparable })) diagnostic = 'Insufficient reviewer sample, zero variance, or incompatible maximum points'
    if (cohort === 'Unclassified') diagnostic = 'Class year needs review'
    const reviewer_z = diagnostic ? [] : rows.map(e => ({ grader: e.grader, z: (e.score - stats.get(e.grader)!.mean) / stats.get(e.grader)!.sd }))
    return { applicant_id: a.id, cohort, rank: null, z: reviewer_z.length ? reviewer_z.reduce((n, e) => n + e.z, 0) / reviewer_z.length : null, reviewer_z, recommendation: 'yellow', diagnostic }
  })
  for (const cohort of new Set(result.map(r => r.cohort))) {
    const all = result.filter(r => r.cohort === cohort), n = cohort === 'Juniors / transfers' ? 3 : 5
    const valid = all.filter(r => r.z !== null)
    for (const r of valid) r.rank = 1 + valid.filter(other => other.z! > r.z! + 1e-9).length
    if (all.length < n * 2 || all.some(r => r.z === null)) continue
    const sorted = [...all].sort((a, b) => b.z! - a.z!), upper = sorted[n - 1].z!, lower = sorted[sorted.length - n].z!
    const upperTie = Math.abs(upper - sorted[n].z!) < 1e-9, lowerTie = Math.abs(lower - sorted[sorted.length - n - 1].z!) < 1e-9
    for (const r of all) {
      if (r.z! > upper + 1e-9 || (!upperTie && Math.abs(r.z! - upper) < 1e-9)) r.recommendation = 'green'
      else if (r.z! < lower - 1e-9 || (!lowerTie && Math.abs(r.z! - lower) < 1e-9)) r.recommendation = 'red'
    }
  }
  return result
}
