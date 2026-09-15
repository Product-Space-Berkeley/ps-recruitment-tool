import Papa from 'papaparse'

export const MAX_INTERVIEW_CSV_BYTES = 2 * 1024 * 1024
export const MAX_INTERVIEW_ROWS = 2_000

export type InterviewImportFormat = 'developer_fa26' | 'curriculum_fa26'

export type InterviewScore = {
  key: string
  label: string
  value: number
  raw: string
}

export type InterviewResponse = {
  label: string
  value: string
}

export type InterviewRecord = {
  source_row: number
  interviewer: string
  scores: InterviewScore[]
  responses: InterviewResponse[]
}

export type ParsedInterviewCandidate = {
  source_name: string
  source_names: string[]
  format: InterviewImportFormat
  interviewers: string[]
  criterion_averages: Array<{ key: string; label: string; value: number }>
  overall_score: number | null
  records: InterviewRecord[]
}

export type ParsedInterviewCsv = {
  format: InterviewImportFormat
  source_rows: number
  candidates: ParsedInterviewCandidate[]
}

type Criterion = { header: string; key: string; label: string }

const DEV_CRITERIA: Criterion[] = [
  { header: 'Rate this applicants Technical Proficiency on the topic they were talking about', key: 'technical_proficiency', label: 'Technical Proficiency' },
  { header: "Rate this applicant's ability to explain the challenges faced AND the lessons learned while building the project", key: 'challenges_lessons', label: 'Challenges & Lessons' },
  { header: "How would you rate this applicant's ability to communicate and collaborate with others in a team setting?", key: 'communication_teamwork', label: 'Communication & Teamwork' },
  { header: "How would you rate this applicant's Passion for the topic they presented on?", key: 'passion', label: 'Passion' },
  { header: "How would you rate this applicant's Lessons learned from their project", key: 'project_lessons', label: 'Project Lessons' },
  { header: 'Part 1 Scoring', key: 'part_1', label: 'Part 1' },
  { header: 'Part 2 Scoring', key: 'part_2', label: 'Part 2' },
  { header: 'Part 3 Scoring', key: 'part_3', label: 'Part 3' },
  { header: 'Part 4 Scoring', key: 'part_4', label: 'Part 4' },
  { header: 'Part 5 Scoring', key: 'part_5', label: 'Part 5' },
  { header: 'How well is the candidate able to explain their topic', key: 'topic_explanation', label: 'Topic Explanation' },
  { header: 'How well is the candidate able to explain how their topic can be used practically', key: 'practical_application', label: 'Practical Application' },
]

const CURRICULUM_CRITERIA: Criterion[] = [
  { header: 'Why do apps use a server instead of storing all data only on the user’s device? scoring table', key: 'server', label: 'Server' },
  { header: 'What is an optimistic update, and why is it useful? scoring table', key: 'optimistic_update', label: 'Optimistic Update' },
  { header: 'What should happen if an optimistic update is made but the server request fails? scoring table', key: 'rollback', label: 'Rollback' },
  { header: 'You have implemented optimistic updates for a task-tracking app. Everything works during testing, but after release, some users report that their changes are not being saved. You have access to the application code, server code, and server logs. Based on the information, determine whether the failures are most likely caused by a temporary issue outside your code, such as a poor internet connection or server outage, or by a bug in the application/server system. Explain what the logs tell you and where you would investigate next. scoring table', key: 'logs', label: 'Logs' },
  { header: 'A task-tracking app may only have an internet connection once per day. Users should still be able to mark tasks as complete/incomplete tasks while offline. Design a system that allows the app to work without internet access and eventually saves those changes to the server when a connection becomes available. What the app should do when the user makes a change while offline? What should happen when the app reconnects to the internet? scoring table', key: 'offline', label: 'Offline' },
  { header: 'A user quickly clicks the same task twice in an app that implements optimistic update:\n\na. First click marks “Buy groceries” as completed, and the app sends a request to the server to set completed=true\nb. Second click, immediately after the first, marks it as incomplete again, and the app sends another request to set completed=false\nc. Because the network can take different amounts of time, the second request reaches the server first, and the first request reaches the server afterward.\n\nWhat problem could this cause? What would the final task state be on the server and in local UI? How would you design the system so the server ultimately reflects the user’s most recent action? scoring table', key: 'double_click', label: 'Double Click' },
  { header: 'all_unique scoring table', key: 'all_unique', label: 'all_unique' },
  { header: 'count_reachable scoring table', key: 'count_reachable', label: 'count_reachable' },
]

const normalizeHeader = (value: string) => value
  .replace(/^\uFEFF/, '')
  .normalize('NFKC')
  .trim()
  .toLocaleLowerCase('en-US')
  .replace(/\s+/g, ' ')

export const normalizeInterviewName = (value: string) => value
  .normalize('NFKC')
  .trim()
  .toLocaleLowerCase('en-US')
  .replace(/\s+/g, ' ')

function round(value: number) {
  return Math.round(value * 100) / 100
}

function leadingNumber(value: string) {
  const match = value.trim().match(/^-?\d+(?:\.\d+)?/)
  return match ? Number(match[0]) : null
}

function curriculumScore(value: string) {
  const numeric = leadingNumber(value)
  if (numeric !== null) return numeric

  // The FA26 Curriculum form has zero-point choices whose labels do not
  // begin with a number (for example, "Didn't attempt" and "Didn't start").
  // The authoritative Ranked Applicants sheet counts these and blank rubric
  // cells as zero, so mirror that behavior when rebuilding scores from the
  // response export.
  const normalized = value
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[’]/g, "'")
  if (!normalized || normalized.startsWith("didn't attempt") || normalized.startsWith("didn't start")) {
    return 0
  }
  return null
}

function requireColumns(headers: string[], columns: string[]) {
  const normalized = new Set(headers.map(normalizeHeader))
  return columns.every(column => normalized.has(normalizeHeader(column)))
}

function findHeader(headers: string[], expected: string) {
  const normalized = normalizeHeader(expected)
  return headers.find(header => normalizeHeader(header) === normalized)
}

function aggregateCandidate(
  format: InterviewImportFormat,
  sourceNames: string[],
  records: InterviewRecord[],
): ParsedInterviewCandidate {
  const criteria = format === 'developer_fa26' ? DEV_CRITERIA : CURRICULUM_CRITERIA
  const criterionAverages = criteria.flatMap(criterion => {
    const values = records.flatMap(record => record.scores
      .filter(score => score.key === criterion.key)
      .map(score => score.value))
    return values.length
      ? [{ key: criterion.key, label: criterion.label, value: round(values.reduce((sum, value) => sum + value, 0) / values.length) }]
      : []
  })
  const complete = criterionAverages.length === criteria.length
  const overallScore = !complete
    ? null
    : format === 'developer_fa26'
      ? round(criterionAverages.reduce((sum, score) => sum + score.value, 0) / criteria.length)
      : round(criterionAverages.reduce((sum, score) => sum + score.value, 0))

  return {
    source_name: sourceNames[0],
    source_names: sourceNames,
    format,
    interviewers: [...new Set(records.map(record => record.interviewer).filter(Boolean))],
    criterion_averages: criterionAverages,
    overall_score: overallScore,
    records: records.sort((left, right) => left.source_row - right.source_row),
  }
}

export function mergeInterviewCandidates(candidates: ParsedInterviewCandidate[]) {
  if (!candidates.length) throw new Error('At least one interview candidate is required.')
  const format = candidates[0].format
  if (candidates.some(candidate => candidate.format !== format)) {
    throw new Error('Interview candidates from different formats cannot be combined.')
  }
  return aggregateCandidate(
    format,
    [...new Set(candidates.flatMap(candidate => candidate.source_names))],
    candidates.flatMap(candidate => candidate.records),
  )
}

export function parseInterviewCsv(csvText: string): ParsedInterviewCsv {
  const parsed = Papa.parse<Record<string, string>>(csvText.replace(/^\uFEFF/, ''), {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
  })
  const fatalError = parsed.errors.find(error => error.type === 'Quotes' || error.type === 'Delimiter')
  if (fatalError) throw new Error(`CSV could not be parsed: ${fatalError.message}`)
  if (parsed.data.length > MAX_INTERVIEW_ROWS) {
    throw new Error(`CSV exceeds the ${MAX_INTERVIEW_ROWS.toLocaleString()} row limit.`)
  }
  if (!parsed.data.length || !parsed.meta.fields?.length) throw new Error('The CSV contains no interview responses.')

  const headers = parsed.meta.fields
  const isDeveloper = requireColumns(headers, [
    'Interviewer (member of PlexTech)',
    'Interviewee (applicant)',
    ...DEV_CRITERIA.map(criterion => criterion.header),
  ])
  const isCurriculum = requireColumns(headers, [
    'Interviewer Name',
    'Applicant Name',
    ...CURRICULUM_CRITERIA.map(criterion => criterion.header),
  ])
  if (!isDeveloper && !isCurriculum) {
    throw new Error('CSV does not match the FA26 Developer or Curriculum interview response format.')
  }

  const format: InterviewImportFormat = isDeveloper ? 'developer_fa26' : 'curriculum_fa26'
  const criteria = isDeveloper ? DEV_CRITERIA : CURRICULUM_CRITERIA
  const nameHeader = findHeader(headers, isDeveloper ? 'Interviewee (applicant)' : 'Applicant Name')!
  const interviewerHeader = findHeader(headers, isDeveloper ? 'Interviewer (member of PlexTech)' : 'Interviewer Name')!
  const timestampHeader = findHeader(headers, 'Timestamp')
  const criterionHeaders = new Map(criteria.map(criterion => [normalizeHeader(criterion.header), criterion]))
  const excludedHeaders = new Set([
    normalizeHeader(nameHeader),
    normalizeHeader(interviewerHeader),
    normalizeHeader(timestampHeader ?? ''),
    normalizeHeader('Email Address'),
    normalizeHeader('Score'),
    ...criterionHeaders.keys(),
  ])

  const grouped = new Map<string, { sourceName: string; records: InterviewRecord[] }>()
  parsed.data.forEach((row, index) => {
    const sourceName = String(row[nameHeader] ?? '').trim()
    if (!sourceName) return
    const interviewer = String(row[interviewerHeader] ?? '').trim() || 'Interviewer'
    const scores: InterviewScore[] = []
    for (const header of headers) {
      const criterion = criterionHeaders.get(normalizeHeader(header))
      if (!criterion) continue
      const raw = String(row[header] ?? '').trim()
      if (isDeveloper && !raw) continue
      const value = isDeveloper && /^-?\d+(?:\.\d+)?$/.test(raw)
        ? Number(raw)
        : isCurriculum
          ? curriculumScore(raw)
          : leadingNumber(raw)
      if (value === null || !Number.isFinite(value)) continue
      scores.push({
        key: criterion.key,
        label: criterion.label,
        value,
        raw: (raw || 'No score submitted (counted as 0)').slice(0, 500),
      })
    }
    const responses = headers.flatMap(header => {
      if (excludedHeaders.has(normalizeHeader(header))) return []
      const value = String(row[header] ?? '').trim()
      return value ? [{ label: header.slice(0, 500), value: value.slice(0, 10_000) }] : []
    })
    const key = normalizeInterviewName(sourceName)
    const group = grouped.get(key) ?? { sourceName, records: [] }
    group.records.push({
      source_row: index + 2,
      interviewer: interviewer.slice(0, 200),
      scores,
      responses,
    })
    grouped.set(key, group)
  })

  const candidates = [...grouped.values()]
    .map(group => aggregateCandidate(format, [group.sourceName], group.records))
    .sort((left, right) => (right.overall_score ?? -Infinity) - (left.overall_score ?? -Infinity) || left.source_name.localeCompare(right.source_name))
  if (!candidates.length) throw new Error('The CSV contains no candidates.')
  return { format, source_rows: parsed.data.length, candidates }
}
