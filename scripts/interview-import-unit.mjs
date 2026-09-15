#!/usr/bin/env node

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import ts from 'typescript'

const sourcePath = join(process.cwd(), 'src/lib/interviewImport.ts')
const source = await readFile(sourcePath, 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
  },
  fileName: sourcePath,
}).outputText
const temporaryDirectory = await mkdtemp(join(process.cwd(), '.interview-import-unit-'))
const compiledPath = join(temporaryDirectory, 'module.mjs')

const csvCell = value => `"${String(value).replaceAll('"', '""')}"`
const makeCsv = rows => rows.map(row => row.map(csvCell).join(',')).join('\n')

const developerCriteria = [
  'Rate this applicants Technical Proficiency on the topic they were talking about',
  "Rate this applicant's ability to explain the challenges faced AND the lessons learned while building the project",
  "How would you rate this applicant's ability to communicate and collaborate with others in a team setting?",
  "How would you rate this applicant's Passion for the topic they presented on?",
  "How would you rate this applicant's Lessons learned from their project",
  'Part 1 Scoring', 'Part 2 Scoring', 'Part 3 Scoring', 'Part 4 Scoring', 'Part 5 Scoring',
  'How well is the candidate able to explain their topic',
  'How well is the candidate able to explain how their topic can be used practically',
]

const curriculumCriteria = [
  'Why do apps use a server instead of storing all data only on the user’s device? scoring table',
  'What is an optimistic update, and why is it useful? scoring table',
  'What should happen if an optimistic update is made but the server request fails? scoring table',
  'You have implemented optimistic updates for a task-tracking app. Everything works during testing, but after release, some users report that their changes are not being saved. You have access to the application code, server code, and server logs. Based on the information, determine whether the failures are most likely caused by a temporary issue outside your code, such as a poor internet connection or server outage, or by a bug in the application/server system. Explain what the logs tell you and where you would investigate next. scoring table',
  'A task-tracking app may only have an internet connection once per day. Users should still be able to mark tasks as complete/incomplete tasks while offline. Design a system that allows the app to work without internet access and eventually saves those changes to the server when a connection becomes available. What the app should do when the user makes a change while offline? What should happen when the app reconnects to the internet? scoring table',
  'A user quickly clicks the same task twice in an app that implements optimistic update:\n\na. First click marks “Buy groceries” as completed, and the app sends a request to the server to set completed=true\nb. Second click, immediately after the first, marks it as incomplete again, and the app sends another request to set completed=false\nc. Because the network can take different amounts of time, the second request reaches the server first, and the first request reaches the server afterward.\n\nWhat problem could this cause? What would the final task state be on the server and in local UI? How would you design the system so the server ultimately reflects the user’s most recent action? scoring table',
  'all_unique scoring table',
  'count_reachable scoring table',
]

try {
  await writeFile(compiledPath, compiled, { encoding: 'utf8', mode: 0o600 })
  const { parseInterviewCsv } = await import(`${pathToFileURL(compiledPath).href}?v=${Date.now()}`)

  const developerHeaders = ['Timestamp', 'Interviewer (member of PlexTech)', 'Interviewee (applicant)', ...developerCriteria, 'Final Comments']
  const developer = parseInterviewCsv(makeCsv([
    developerHeaders,
    ['9/1/2026', 'Interviewer One', 'Ada Lovelace', ...Array(12).fill('7'), 'Excellent explanation'],
    ['9/2/2026', 'Interviewer Two', 'Ada Lovelace', ...Array(12).fill('5'), 'Strong follow-up'],
  ]))
  assert.equal(developer.format, 'developer_fa26')
  assert.equal(developer.candidates.length, 1)
  assert.deepEqual(developer.candidates[0].interviewers, ['Interviewer One', 'Interviewer Two'])
  assert.equal(developer.candidates[0].overall_score, 6)
  assert.equal(developer.candidates[0].criterion_averages.length, 12)
  assert.equal(developer.candidates[0].records[0].responses[0].value, 'Excellent explanation')

  const curriculumHeaders = ['Timestamp', 'Interviewer Name', 'Applicant Name', ...curriculumCriteria, 'Final notes']
  const curriculum = parseInterviewCsv(makeCsv([
    curriculumHeaders,
    ['9/3/2026', 'Interviewer Three', 'Grace Hopper', '2: Fully correct', '2: Fully correct', '2: Fully correct', '3: Excellent', '3: Excellent', '3: Excellent', '2: Correct', '2: Correct', 'Clear reasoning'],
  ]))
  assert.equal(curriculum.format, 'curriculum_fa26')
  assert.equal(curriculum.candidates[0].overall_score, 19)
  assert.equal(curriculum.candidates[0].records[0].scores[0].value, 2)
  assert.equal(curriculum.candidates[0].records[0].responses[0].value, 'Clear reasoning')

  const curriculumZeroLabels = parseInterviewCsv(makeCsv([
    curriculumHeaders,
    [
      '9/4/2026',
      'Interviewer Four',
      'Katherine Johnson',
      '2: Fully correct',
      '2: Fully correct',
      '2: Fully correct',
      '3: Fully correct',
      '3: Fully correct',
      '3: Good',
      "Didn't attempt",
      "Didn't start, or didn't make significant progress.",
      'No final notes',
    ],
    [
      '9/4/2026',
      'Interviewer Five',
      'Katherine Johnson',
      '2: Fully correct',
      '2: Fully correct',
      '2: Fully correct',
      '3: Fully correct',
      '3: Fully correct',
      '3: Good',
      '',
      '',
      'No final notes',
    ],
  ]))
  assert.equal(curriculumZeroLabels.candidates[0].overall_score, 15)
  assert.equal(curriculumZeroLabels.candidates[0].criterion_averages.length, 8)
  assert.deepEqual(
    curriculumZeroLabels.candidates[0].criterion_averages.slice(-2).map(score => score.value),
    [0, 0],
  )

  assert.throws(() => parseInterviewCsv('Name,Score\nAda,4'), /does not match/)
  if (process.env.INTERVIEW_DEV_CSV) {
    const liveDeveloper = parseInterviewCsv(await readFile(process.env.INTERVIEW_DEV_CSV, 'utf8'))
    assert.equal(liveDeveloper.format, 'developer_fa26')
    assert.ok(liveDeveloper.candidates.length > 0)
  }
  if (process.env.INTERVIEW_CURRICULUM_CSV) {
    const liveCurriculum = parseInterviewCsv(await readFile(process.env.INTERVIEW_CURRICULUM_CSV, 'utf8'))
    assert.equal(liveCurriculum.format, 'curriculum_fa26')
    assert.ok(liveCurriculum.candidates.length > 0)
  }
  console.log('Interview import unit checks passed.')
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true })
}
