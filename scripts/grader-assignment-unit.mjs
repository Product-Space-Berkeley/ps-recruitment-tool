#!/usr/bin/env node

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import ts from 'typescript'

const sourcePath = join(process.cwd(), 'src/lib/graderAssignments.ts')
const source = await readFile(sourcePath, 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  fileName: sourcePath,
}).outputText
const temporaryDirectory = await mkdtemp(join(process.cwd(), '.grader-assignment-unit-'))
const compiledPath = join(temporaryDirectory, 'module.mjs')

try {
  await writeFile(compiledPath, compiled, { encoding: 'utf8', mode: 0o600 })
  const {
    buildGraderAssignments,
    filterReassignmentCandidatesBySource,
    rankReassignmentCandidates,
    reassignmentSourceOptions,
    reviewerPoolForRole,
  } = await import(`${pathToFileURL(compiledPath).href}?v=${Date.now()}`)

  const applicantIds = Array.from({ length: 282 }, (_, index) => `applicant-${index}`)
  const memberEmails = Array.from({ length: 26 }, (_, index) => `grader-${index}@berkeley.edu`)
  const leadershipEmails = Array.from({ length: 17 }, (_, index) => `leader-${index}@berkeley.edu`)
  const input = { roundId: 'round-1', applicantIds, memberEmails, leadershipEmails }
  const rows = buildGraderAssignments(input)

  assert.equal(rows.length, 564)
  assert.deepEqual(rows, buildGraderAssignments(input), 'assignment must be deterministic')

  const memberSet = new Set(memberEmails)
  const leadershipSet = new Set(leadershipEmails)
  const byApplicant = new Map()
  for (const row of rows) {
    const current = byApplicant.get(row.applicant_id) ?? []
    current.push(row.grader_email)
    byApplicant.set(row.applicant_id, current)
  }

  for (const reviewers of byApplicant.values()) {
    assert.equal(reviewers.length, 2)
    assert.equal(new Set(reviewers).size, 2)
    const leadershipCount = reviewers.filter(email => leadershipSet.has(email)).length
    const memberCount = reviewers.filter(email => memberSet.has(email)).length
    assert.equal(leadershipCount, 1)
    assert.equal(memberCount, 1)
  }

  const memberLoads = memberEmails.map(email => rows.filter(row => row.grader_email === email).length)
  const leadershipLoads = leadershipEmails.map(email => rows.filter(row => row.grader_email === email).length)
  assert.deepEqual([...new Set(memberLoads)].sort(), [10, 11])
  assert.deepEqual([...new Set(leadershipLoads)].sort(), [16, 17])

  assert.throws(() => buildGraderAssignments({ ...input, leadershipEmails: [] }))

  assert.equal(reviewerPoolForRole('grader'), 'regular')
  assert.equal(reviewerPoolForRole('leadership'), 'leadership')
  assert.equal(reviewerPoolForRole('admin'), 'leadership')
  assert.equal(reviewerPoolForRole('alumni'), null)

  const ranked = rankReassignmentCandidates({
    targetEmail: 'target@berkeley.edu',
    targetPool: 'regular',
    targetApplicantIds: ['already-seen'],
    candidates: [
      {
        assignmentId: 'a4', applicantId: 'app-4', applicantName: 'Four',
        sourceEmail: 'regular-b@berkeley.edu', sourcePool: 'regular',
        applicantCompletedReviews: 1, sourcePendingCount: 9,
      },
      {
        assignmentId: 'a2', applicantId: 'app-2', applicantName: 'Two',
        sourceEmail: 'regular-a@berkeley.edu', sourcePool: 'regular',
        applicantCompletedReviews: 0, sourcePendingCount: 4,
      },
      {
        assignmentId: 'a1', applicantId: 'app-1', applicantName: 'One',
        sourceEmail: 'regular-b@berkeley.edu', sourcePool: 'regular',
        applicantCompletedReviews: 0, sourcePendingCount: 9,
      },
      {
        assignmentId: 'a1-duplicate', applicantId: 'app-1', applicantName: 'One',
        sourceEmail: 'regular-c@berkeley.edu', sourcePool: 'regular',
        applicantCompletedReviews: 0, sourcePendingCount: 2,
      },
      {
        assignmentId: 'seen', applicantId: 'already-seen', applicantName: 'Seen',
        sourceEmail: 'regular-b@berkeley.edu', sourcePool: 'regular',
        applicantCompletedReviews: 0, sourcePendingCount: 10,
      },
      {
        assignmentId: 'leader', applicantId: 'leadership-app', applicantName: 'Leader',
        sourceEmail: 'leader@berkeley.edu', sourcePool: 'leadership',
        applicantCompletedReviews: 0, sourcePendingCount: 20,
      },
    ],
  })
  assert.deepEqual(
    ranked.map(candidate => candidate.assignmentId),
    ['a1', 'a2', 'a4'],
    'reassignment ranking should prioritize low review counts, then high source backlog, and preserve reviewer pools',
  )
  assert.deepEqual(reassignmentSourceOptions(ranked), [
    { email: 'regular-b@berkeley.edu', available: 2, pool: 'regular' },
    { email: 'regular-a@berkeley.edu', available: 1, pool: 'regular' },
  ])
  assert.deepEqual(
    filterReassignmentCandidatesBySource(ranked, ' REGULAR-B@berkeley.edu ').map(candidate => candidate.assignmentId),
    ['a1', 'a4'],
  )
  assert.equal(filterReassignmentCandidatesBySource(ranked, 'missing@berkeley.edu').length, 0)
  assert.equal(filterReassignmentCandidatesBySource(ranked).length, ranked.length)

  const crossPoolRanked = rankReassignmentCandidates({
    targetEmail: 'target-leader@berkeley.edu',
    targetPool: 'leadership',
    targetApplicantIds: [],
    allowedSourcePools: ['leadership', 'regular'],
    candidates: [
      {
        assignmentId: 'regular', applicantId: 'regular-app', applicantName: 'Regular Source',
        sourceEmail: 'regular@berkeley.edu', sourcePool: 'regular',
        applicantCompletedReviews: 0, sourcePendingCount: 5,
      },
      {
        assignmentId: 'leader', applicantId: 'leader-app', applicantName: 'Leadership Source',
        sourceEmail: 'leader@berkeley.edu', sourcePool: 'leadership',
        applicantCompletedReviews: 0, sourcePendingCount: 4,
      },
    ],
  })
  assert.deepEqual(
    crossPoolRanked.map(candidate => candidate.assignmentId),
    ['regular', 'leader'],
    'leadership targets may explicitly include regular-source assignments',
  )
  console.log('Grader assignment unit checks passed.')
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true })
}
