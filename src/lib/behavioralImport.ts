import Papa from 'papaparse'

// Positional parsing is intentional: the form has two "Question 2" headers.
export const BEHAVIORAL_HEADERS = ['Timestamp', 'Email Address', 'Score', 'Interviewer (PlexTech member)', 'Interviewee (applicant name)', 'Notes on Question 1', 'Question 1 Scoring', 'Question 2', 'Question 2', 'Question 3a Notes', 'Question 3a', 'Question 3b Notes', 'Question 3b', 'Question 4a Comments', 'Question 4a Scoring', 'Question 4b Comments', 'Question 4b Scoring', 'Question 4c Comments', 'Question 4c Scoring', 'Question 4d Comments', 'Question 4d Scoring', 'Question 5a Comments', 'Question 5a Scoring', 'Question 5b Comments', 'Question 5b Scoring', "Rate the applicant's passion for PlexTech and it's values", "Rate this applicant's ability to explain challenges AND lessons learned aka their resiliency and coachability", "How would you rate this applicant's ability to communicate and collaborate with others in a team setting?", '[IMPORTANT] RATE THIS APPLICANT AS AN OVERALL FIT INTO PLEXTECH BOTH TECHNICALLY AND CULTURE FIT', 'Comments/Additional Details']
export const BEHAVIORAL_CRITERIA = [
  [6, 'Question 1'], [8, 'Question 2'], [10, 'Question 3a'], [12, 'Question 3b'],
  [14, 'Question 4a'], [16, 'Question 4b'], [18, 'Question 4c'], [20, 'Question 4d'],
  [22, 'Question 5a'], [24, 'Question 5b'], [25, 'Passion for PlexTech'],
  [26, 'Resiliency & Coachability'], [27, 'Communication & Teamwork'], [28, 'Overall Fit'],
] as const
export const normalizeBehavioralName = (s: string) => s.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ')
export type BehavioralPerson = { id: string; name: string; role: 'curriculum' | 'developer' }
export type BehavioralRecord = {
  source_row: number; source_name: string; interviewer: string; interviewer_key: string
  timestamp: string; timestamp_order: number; complete: boolean; counted: boolean
  scores: { key: string; label: string; value: number; raw: string }[]
  responses: { label: string; value: string }[]
}
const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null

export function parseBehavioralCsv(csv: string): BehavioralRecord[] {
  if (new TextEncoder().encode(csv).length > 2 * 1024 * 1024) throw new Error('Sheet exceeds 2 MB.')
  const parsed = Papa.parse<string[]>(csv.replace(/^\uFEFF/, ''), { skipEmptyLines: 'greedy' })
  if (parsed.errors.length) throw new Error('Unable to parse behavioral CSV.')
  const [headers, ...rows] = parsed.data
  if (!headers || BEHAVIORAL_HEADERS.some((h, i) => normalizeBehavioralName(headers[i] ?? '') !== normalizeBehavioralName(h))) {
    throw new Error('Behavioral sheet columns have changed. Expected the FA26 behavioral form, including both Question 2 columns.')
  }
  if (rows.length > 2000) throw new Error('Expected at most 2,000 behavioral response rows.')
  return rows.map((row, i) => {
    const name = row[4]?.trim()
    const interviewer = row[3]?.trim()
    if (!name || !interviewer) throw new Error(`Row ${i + 2}: applicant and interviewer names are required.`)
    const timestamp = row[0]?.trim() ?? ''
    // Form timestamps are local LA wall time. Compare their numeric components,
    // independently of the server's timezone (all rows use the same source zone).
    const date = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2})$/.exec(timestamp)
    if (!date) throw new Error(`Row ${i + 2}: invalid form timestamp.`)
    const timestamp_order = Date.UTC(+date[3], +date[1] - 1, +date[2], +date[4], +date[5], +date[6])
    const scores = BEHAVIORAL_CRITERIA.flatMap(([col, label]) => {
      const raw = row[col]?.trim() ?? ''
      if (!raw) return []
      const value = Number(raw)
      if (!/^\d+(?:\.\d+)?$/.test(raw) || !Number.isFinite(value)) {
        throw new Error(`Row ${i + 2}: invalid ${label} rating (${raw}).`)
      }
      return [{ key: `behavioral_${col}`, label, value, raw }]
    })
    return {
      source_row: i + 2, source_name: name, interviewer,
      interviewer_key: normalizeBehavioralName(row[1]?.trim() || interviewer),
      timestamp, timestamp_order, complete: scores.length === 14, counted: false, scores,
      responses: [5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 29].flatMap(col => {
        const value = row[col]?.trim()
        return value ? [{ label: col === 7 ? 'Question 2 Notes' : headers[col], value: value.slice(0, 10000) }] : []
      }),
    }
  })
}

export function aggregateBehavioral(records: BehavioralRecord[]) {
  // Admin-confirmed FA26 correction: these two placeholder no-show reports
  // preceded Diya's completed interview. Retain the source notes and ratings
  // for reference, but never count them again on automatic resync.
  const excluded = (r: BehavioralRecord) =>
    ['diya vatsavai', 'diya vatasavai'].includes(normalizeBehavioralName(r.source_name)) &&
    ['carlychvn@berkeley.edu', 'davyn@berkeley.edu'].includes(r.interviewer_key) &&
    r.scores.length === 14 && r.scores.every(s => s.value === 1) &&
    r.responses.length > 0 && r.responses.every(n => normalizeBehavioralName(n.value) === 'no show')
  const latest = new Map<string, BehavioralRecord>()
  for (const r of [...records].sort((a, b) => a.timestamp_order - b.timestamp_order || a.source_row - b.source_row)) latest.set(r.interviewer_key, r)
  const included = [...latest.values()].filter(r => r.complete && !excluded(r))
  return {
    format: 'behavioral_fa26' as const,
    interviewers: [...new Set(records.map(r => r.interviewer))],
    criterion_averages: BEHAVIORAL_CRITERIA.flatMap(([col, label]) => {
      const value = mean(included.map(r => r.scores.find(s => s.key === `behavioral_${col}`)!.value))
      return value === null ? [] : [{ key: `behavioral_${col}`, label, value }]
    }),
    overall_score: mean(included.map(r => mean(r.scores.map(s => s.value))!)),
    records: records.map(r => ({ ...r, counted: latest.get(r.interviewer_key) === r && r.complete && !excluded(r) })),
    source_names: [...new Set(records.map(r => r.source_name))],
  }
}

// Reviewed FA26 aliases. Resolve these to an eligible applicant ID at connection
// time; persisted resolutions remain authoritative on subsequent refreshes.
const aliases: Record<string, string> = {
  rj: 'ren jie tee', 'jeffery li': 'jeffrey li', 'jefferey li': 'jeffrey li', 'jefferi li': 'jeffrey li',
  reyansh: 'reyansh pallikonda', 'reyansh pallilkonda': 'reyansh pallikonda',
  'diya vatasavai': 'diya vatsavai', abduallah: 'abdullah alabdullah',
  'william rodas': 'william lopez rodas',
}
export function matchBehavioral(records: BehavioralRecord[], roster: BehavioralPerson[], saved: Record<string, string> = {}) {
  const resolutions: Record<string, string> = Object.assign(Object.create(null), saved)
  const unresolved: { name: string; rows: number[] }[] = []
  const grouped = new Map<string, BehavioralRecord[]>()
  const plainName = (s: string) => normalizeBehavioralName(s.replace(/\([^)]*\)/g, ''))
  for (const name of new Set(records.map(r => normalizeBehavioralName(r.source_name)))) {
    const rows = records.filter(r => normalizeBehavioralName(r.source_name) === name)
    const explicit = Object.hasOwn(saved, name) ? saved[name] : undefined
    if (explicit === 'exclude') continue
    const canonical = Object.hasOwn(aliases, name) ? aliases[name] : name
    const matches = explicit ? roster.filter(p => p.id === explicit) : roster.filter(p => {
      const normalized = plainName(p.name)
      return normalized === canonical || (!canonical.includes(' ') && normalized.split(' ')[0] === canonical)
    })
    if (matches.length !== 1) { unresolved.push({ name: rows[0].source_name, rows: rows.map(r => r.source_row) }); continue }
    resolutions[name] = matches[0].id
    grouped.set(matches[0].id, [...(grouped.get(matches[0].id) ?? []), ...rows])
  }
  return { resolutions, unresolved, grouped }
}
