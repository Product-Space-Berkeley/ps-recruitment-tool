#!/usr/bin/env node
/**
 * Destructive TOCTOU race tests for recruitment and deliberation writes.
 *
 * Safety requirements:
 *   - The target URL must be loopback-only.
 *   - ALLOW_DESTRUCTIVE_TESTS=1 must be set explicitly.
 *   - The server must use TEST_BYPASS_AUTH=1 and a disposable replica-set DB.
 *   - RACE_TEST_MONGODB_URI must point to the same loopback-only test DB. It is
 *     used only to seed an applicant because there is deliberately no admin API
 *     that bypasses applicant OAuth.
 *
 * Example:
 *   ALLOW_DESTRUCTIVE_TESTS=1 RACE_TEST_BASE_URL=http://127.0.0.1:5173 \
 *     RACE_TEST_MONGODB_URI='mongodb://127.0.0.1:27017/plextech_race' \
 *     node scripts/race-toctou.mjs
 */

import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import mongoose from 'mongoose'

function envInteger(name, fallback, min, max) {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`)
  }
  return value
}

function loopbackBase(raw) {
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`RACE_TEST_BASE_URL is not a valid URL: ${raw}`)
  }
  const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
  if (!loopbackHosts.has(parsed.hostname.toLowerCase())) {
    throw new Error(`Refusing destructive race test against non-loopback host: ${parsed.hostname}`)
  }
  if (parsed.username || parsed.password) {
    throw new Error('RACE_TEST_BASE_URL must not contain credentials.')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('RACE_TEST_BASE_URL must use http or https.')
  }
  return parsed.toString().replace(/\/$/, '')
}

function disposableLoopbackMongoUri(raw) {
  if (!raw) {
    throw new Error(
      'RACE_TEST_MONGODB_URI is required for review fixtures and must point to the same disposable loopback DB as the server.',
    )
  }
  if (!raw.startsWith('mongodb://')) {
    throw new Error('RACE_TEST_MONGODB_URI must use mongodb:// (mongodb+srv and remote clusters are refused).')
  }

  const withoutScheme = raw.slice('mongodb://'.length)
  const slashIndex = withoutScheme.indexOf('/')
  if (slashIndex < 0) throw new Error('RACE_TEST_MONGODB_URI must include an explicit database name.')
  const authority = withoutScheme.slice(0, slashIndex)
  const dbAndQuery = withoutScheme.slice(slashIndex + 1)
  const hostList = authority.slice(authority.lastIndexOf('@') + 1)
  const databaseName = decodeURIComponent(dbAndQuery.split('?')[0] ?? '')
  const allowedHosts = new Set(['localhost', '127.0.0.1', '::1'])

  if (!databaseName || !/(?:test|race|toctou|disposable)/i.test(databaseName)) {
    throw new Error(
      `Refusing Mongo database "${databaseName || '(missing)'}"; its name must contain test, race, toctou, or disposable.`,
    )
  }
  if (/(?:^|[?&])(?:tls|ssl)=true(?:&|$)/i.test(raw)) {
    throw new Error('RACE_TEST_MONGODB_URI must not enable TLS; only a local disposable MongoDB is allowed.')
  }

  for (const hostPort of hostList.split(',')) {
    let hostname
    if (hostPort.startsWith('[')) {
      const closingBracket = hostPort.indexOf(']')
      if (closingBracket < 0) throw new Error(`Invalid Mongo host: ${hostPort}`)
      hostname = hostPort.slice(1, closingBracket)
      const suffix = hostPort.slice(closingBracket + 1)
      if (suffix && !/^:\d+$/.test(suffix)) throw new Error(`Invalid Mongo host: ${hostPort}`)
    } else {
      const parts = hostPort.split(':')
      if (parts.length > 2 || (parts[1] && !/^\d+$/.test(parts[1]))) {
        throw new Error(`Invalid Mongo host: ${hostPort}`)
      }
      hostname = parts[0]
    }
    if (!allowedHosts.has(hostname.toLowerCase())) {
      throw new Error(`Refusing destructive race test against non-loopback Mongo host: ${hostname}`)
    }
  }

  return { uri: raw, databaseName }
}

if (process.env.ALLOW_DESTRUCTIVE_TESTS !== '1') {
  throw new Error('Refusing to mutate data. Set ALLOW_DESTRUCTIVE_TESTS=1 for a disposable local test database.')
}

const BASE = loopbackBase(
  process.env.RACE_TEST_BASE_URL
  ?? process.env.LOAD_TEST_BASE_URL
  ?? 'http://127.0.0.1:5173',
)
const ATTEMPTS = envInteger('RACE_TEST_ATTEMPTS', 20, 2, 500)
const STATE_ATTEMPTS = envInteger('RACE_TEST_STATE_ATTEMPTS', 10, 2, 50)
// The hierarchy matrix is intentionally broad (2 resources x 3 authorization
// paths x 5 lifecycle mutations). Two repetitions are enough to exercise both
// launch orders without making the complete destructive gate prohibitively slow.
const ACTIVITY_HIERARCHY_ATTEMPTS = envInteger('RACE_TEST_ACTIVITY_HIERARCHY_ATTEMPTS', 2, 2, 20)
const CANDIDATES_PER_IMPORT = envInteger('RACE_TEST_CANDIDATES_PER_IMPORT', 100, 1, 500)
const REQUEST_TIMEOUT_MS = envInteger('RACE_TEST_REQUEST_TIMEOUT_MS', 10_000, 100, 120_000)
const MONGO = disposableLoopbackMongoUri(process.env.RACE_TEST_MONGODB_URI)
const ADMIN = { email: 'race-admin@example.com', role: 'admin' }
const RUN_TOKEN = `${Date.now().toString(36)}-${process.pid.toString(36)}`
const GRADER = { email: `race-grader-${RUN_TOKEN}@example.com`, role: 'grader' }
const SESSION_NAMESPACE = (Date.now() + process.pid)
  .toString(36)
  .toUpperCase()
  .slice(-3)
  .padStart(3, '0')

function authHeaders(user) {
  return {
    'content-type': 'application/json',
    'x-test-email': user.email,
    'x-test-role': user.role,
  }
}

async function api(method, path, body, user = ADMIN) {
  const startedAt = performance.now()
  try {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: user ? authHeaders(user) : undefined,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const text = await response.text()
    let data
    if (text) {
      try { data = JSON.parse(text) } catch {}
    }
    return {
      status: response.status,
      ok: response.ok,
      data,
      errorBody: response.ok ? '' : text.slice(0, 300),
      ms: performance.now() - startedAt,
    }
  } catch (error) {
    return {
      status: 0,
      ok: false,
      errorBody: error instanceof Error ? error.message : String(error),
      ms: performance.now() - startedAt,
    }
  }
}

async function preflight() {
  const unauthenticated = await api('GET', '/api/authorized-users', undefined, null)
  assert.equal(
    unauthenticated.status,
    401,
    `protected-route preflight expected 401 without test headers; got ${unauthenticated.status}`,
  )

  const authenticated = await api('GET', '/api/authorized-users')
  if (authenticated.status === 401) {
    throw new Error('Server is reachable but TEST_BYPASS_AUTH=1 is not active.')
  }
  assert.equal(authenticated.ok, true, `authenticated preflight failed: ${authenticated.status} ${authenticated.errorBody}`)
}

function stateActor(kind, index) {
  return {
    email: `race-${kind}-${RUN_TOKEN}-${index}@example.com`,
    role: 'admin',
  }
}

function stateSessionId(kind, index) {
  const suffix = index.toString(36).toUpperCase().padStart(2, '0')
  assert.ok(/^[A-Z]$/.test(kind), `invalid session kind: ${kind}`)
  assert.ok(suffix.length <= 2, `session index ${index} is too large`)
  return `${kind}${SESSION_NAMESPACE}${suffix}`
}

async function connectFixtureDatabase(ctx) {
  ctx.fixtureConnection = await mongoose.createConnection(MONGO.uri, {
    autoCreate: false,
    autoIndex: false,
    maxPoolSize: 5,
    serverSelectionTimeoutMS: REQUEST_TIMEOUT_MS,
  }).asPromise()
  assert.equal(
    ctx.fixtureConnection.name,
    MONGO.databaseName,
    `Mongo driver selected ${ctx.fixtureConnection.name}; expected ${MONGO.databaseName}`,
  )
  assert.ok(ctx.fixtureConnection.db, 'fixture Mongo connection has no database handle')
  ctx.fixtureDb = ctx.fixtureConnection.db

  const hello = await ctx.fixtureDb.admin().command({ hello: 1 })
  assert.ok(
    typeof hello.setName === 'string' || hello.msg === 'isdbgrid',
    'RACE_TEST_MONGODB_URI must point to a replica set or sharded test deployment so transactions are real.',
  )

  const cycle = await ctx.fixtureDb.collection('recruitmentcycles').findOne({
    _id: new mongoose.Types.ObjectId(ctx.cycleId),
  })
  assert.ok(
    cycle,
    'The loopback server and RACE_TEST_MONGODB_URI do not appear to use the same database; refusing fixture insertion.',
  )
}

async function seedReviewFixture(ctx) {
  const grader = await api('POST', '/api/authorized-users', {
    email: GRADER.email,
    role: GRADER.role,
  })
  assert.equal(grader.status, 201, `grader fixture setup failed: ${grader.status} ${grader.errorBody}`)
  assert.ok(grader.data?.id, 'grader fixture setup did not return an id')
  ctx.graderUserId = grader.data.id

  ctx.applicantId = new mongoose.Types.ObjectId()
  const insert = await ctx.fixtureDb.collection('applicants').insertOne({
    _id: ctx.applicantId,
    cycle_id: new mongoose.Types.ObjectId(ctx.cycleId),
    first_name: 'Race',
    last_name: 'Applicant',
    email: `race-applicant-${RUN_TOKEN}@berkeley.edu`,
    identity_provider: 'google-berkeley',
    identity_verified_at: new Date(),
    desired_roles: 'Industry Developer',
    created_at: new Date(),
  })
  assert.equal(insert.acknowledged, true, 'applicant fixture insert was not acknowledged')
}

async function setup(ctx) {
  ctx.sessionIds = new Set()
  ctx.roundIds = new Set()
  ctx.cycleIds = new Set()
  ctx.authorizedUserIds = new Set()
  const cycle = await api('POST', '/api/cycles', {
    name: `TOCTOU-${Date.now()}`,
    status: 'active',
    accepting_applications: false,
  })
  assert.equal(cycle.status, 201, `cycle setup failed: ${cycle.status} ${cycle.errorBody}`)
  assert.ok(cycle.data?.id, 'cycle setup did not return an id')
  ctx.cycleId = cycle.data.id
  ctx.cycleIds.add(ctx.cycleId)

  await connectFixtureDatabase(ctx)
  await seedReviewFixture(ctx)

  const round = await api('POST', '/api/rounds', {
    cycle_id: ctx.cycleId,
    name: 'Race Session Host Round',
    grading_type: 'rubric',
    order_index: 1,
    status: 'grading',
    role: null,
  })
  assert.equal(round.status, 201, `round setup failed: ${round.status} ${round.errorBody}`)
  assert.ok(round.data?.id, 'round setup did not return an id')
  ctx.roundId = round.data.id
  ctx.roundIds.add(ctx.roundId)
  ctx.authorizedUserIds.add(ctx.graderUserId)
}

async function raceSessionCreate(roundId, role) {
  return Promise.all(Array.from({ length: ATTEMPTS }, (_, index) => {
    const prefix = role === null ? 'Z' : 'N'
    const sessionId = stateSessionId(prefix, index)
    return api('POST', '/api/sessions', {
      id: sessionId,
      round_id: roundId,
      name: `race-session-${role ?? 'null'}-${index}`,
      anonymous: false,
      role,
    })
  }))
}

async function raceRoundCreate(cycleId, role, orderIndex) {
  return Promise.all(Array.from({ length: ATTEMPTS }, (_, index) =>
    api('POST', '/api/rounds', {
      cycle_id: cycleId,
      name: `race-round-${role ?? 'null'}-${index}`,
      grading_type: 'interview',
      order_index: orderIndex,
      status: 'pending',
      role,
    }),
  ))
}

function assertExactRace(label, attempts) {
  const successes = attempts.filter(attempt => attempt.status === 201)
  const conflicts = attempts.filter(attempt => attempt.status === 409)
  const unexpected = attempts.filter(attempt => attempt.status !== 201 && attempt.status !== 409)

  console.log(`  ${label}`)
  console.log(`    201 success: ${successes.length} (expected 1)`)
  console.log(`    409 conflict: ${conflicts.length} (expected ${ATTEMPTS - 1})`)
  console.log(`    unexpected:  ${unexpected.length} (expected 0)`)
  for (const failure of unexpected.slice(0, 3)) {
    console.log(`      ${failure.status}: ${failure.errorBody}`)
  }

  assert.equal(successes.length, 1, `${label}: expected exactly one 201 response`)
  assert.equal(conflicts.length, ATTEMPTS - 1, `${label}: expected exactly ${ATTEMPTS - 1} conflict responses`)
  assert.equal(unexpected.length, 0, `${label}: received unexpected response statuses`)
}

async function assertSessionCount(roundId, role) {
  const result = await api('GET', `/api/sessions?round_id=${encodeURIComponent(roundId)}`)
  assert.equal(result.ok, true, `session postcondition lookup failed: ${result.status} ${result.errorBody}`)
  assert.ok(Array.isArray(result.data), 'session postcondition lookup did not return an array')
  const matching = result.data.filter(session => (session.role ?? null) === role)
  assert.equal(matching.length, 1, `expected one persisted session for role ${role ?? 'null'}; found ${matching.length}`)
}

async function assertRoundCount(cycleId, role, orderIndex) {
  const result = await api('GET', `/api/cycles/${encodeURIComponent(cycleId)}/rounds`)
  assert.equal(result.ok, true, `round postcondition lookup failed: ${result.status} ${result.errorBody}`)
  assert.ok(Array.isArray(result.data), 'round postcondition lookup did not return an array')
  const matching = result.data.filter(round =>
    (round.role ?? null) === role && Number(round.order_index) === orderIndex,
  )
  assert.equal(
    matching.length,
    1,
    `expected one persisted round for role ${role ?? 'null'} at order ${orderIndex}; found ${matching.length}`,
  )
}

function assertStatusIn(label, result, allowedStatuses) {
  assert.ok(
    allowedStatuses.includes(result.status),
    `${label}: expected ${allowedStatuses.join(' or ')}, got ${result.status} ${result.errorBody}`,
  )
}

async function launchRace(index, first, second) {
  // Alternate which request is initiated first so the gate does not only test
  // one fetch-scheduling bias while still keeping both operations in flight.
  if (index % 2 === 0) {
    const firstPromise = first()
    const secondPromise = second()
    return Promise.all([firstPromise, secondPromise])
  }
  const secondPromise = second()
  const firstPromise = first()
  return Promise.all([firstPromise, secondPromise])
}

function reviewBody(roundId, applicantId) {
  return {
    round_id: roundId,
    applicant_id: applicantId,
    r0: 3,
    r1: 4,
    r2: 4,
    r3: 4,
    r4: 4,
    r5: 4,
    r6: 4,
    r7: 4,
    r8: 4,
    r9: 4,
    comment0: 'Disposable race-test comment zero.',
    comment1: 'Disposable race-test comment one.',
    comment2: 'Disposable race-test comment two.',
    comment3: 'Disposable race-test comment three.',
    comment4: 'Disposable race-test comment four.',
  }
}

async function createReviewRound(ctx, label, index) {
  const round = await api('POST', '/api/rounds', {
    cycle_id: ctx.cycleId,
    name: `Review ${label} race ${index}`,
    grading_type: 'rubric',
    order_index: 20,
    status: 'grading',
    role: null,
  })
  assert.equal(round.status, 201, `${label} round setup failed: ${round.status} ${round.errorBody}`)
  assert.ok(round.data?.id, `${label} round setup did not return an id`)
  ctx.roundIds.add(round.data.id)

  const assignment = await api('POST', '/api/grader-assignments', [{
    round_id: round.data.id,
    applicant_id: ctx.applicantId.toString(),
    grader_email: GRADER.email,
  }], stateActor(`assign-${label}`, index))
  assert.equal(
    assignment.status,
    200,
    `${label} assignment setup failed: ${assignment.status} ${assignment.errorBody}`,
  )
  return round.data.id
}

async function deleteRound(ctx, roundId, label) {
  const result = await api('DELETE', `/api/rounds/${encodeURIComponent(roundId)}`)
  assertStatusIn(`${label} cleanup`, result, [200, 404])
  ctx.roundIds.delete(roundId)
}

async function assertReviewState(roundId, expectedReviews) {
  const [round, reviews, assignments] = await Promise.all([
    api('GET', `/api/rounds/${encodeURIComponent(roundId)}`),
    api(
      'GET',
      `/api/reviews?round_id=${encodeURIComponent(roundId)}&grader_email=${encodeURIComponent(GRADER.email)}`,
    ),
    api(
      'GET',
      `/api/grader-assignments?round_id=${encodeURIComponent(roundId)}&grader_email=${encodeURIComponent(GRADER.email)}`,
    ),
  ])
  assert.equal(round.status, 200, `round postcondition lookup failed: ${round.status} ${round.errorBody}`)
  assert.equal(round.data?.status, 'ended', 'round-close race must finish with an ended round')
  assert.equal(
    Number(round.data?.review_submission_count ?? 0),
    expectedReviews,
    'round submission counter diverged from committed reviews',
  )
  assert.equal(reviews.status, 200, `review postcondition lookup failed: ${reviews.status} ${reviews.errorBody}`)
  assert.ok(Array.isArray(reviews.data), 'review postcondition lookup did not return an array')
  assert.equal(reviews.data.length, expectedReviews, 'persisted review count disagrees with the review response')
  assert.equal(assignments.status, 200, `assignment postcondition lookup failed: ${assignments.status} ${assignments.errorBody}`)
  assert.ok(Array.isArray(assignments.data), 'assignment postcondition lookup did not return an array')
  assert.equal(assignments.data.length, 1, 'round close unexpectedly removed the grader assignment')
  assert.equal(
    Number(assignments.data[0]?.submission_count ?? 0),
    expectedReviews,
    'assignment submission counter diverged from committed reviews',
  )
}

async function raceReviewsAgainstRoundClose(ctx) {
  let committed = 0
  let rejected = 0
  for (let index = 0; index < STATE_ATTEMPTS; index += 1) {
    const roundId = await createReviewRound(ctx, 'close', index)
    const [review, close] = await launchRace(
      index,
      () => api('POST', '/api/reviews', reviewBody(roundId, ctx.applicantId.toString()), GRADER),
      () => api('PATCH', `/api/rounds/${encodeURIComponent(roundId)}`, { status: 'ended' }),
    )
    assert.equal(close.status, 200, `round close failed: ${close.status} ${close.errorBody}`)
    assertStatusIn('review vs round close', review, [201, 409])
    const expectedReviews = review.status === 201 ? 1 : 0
    committed += expectedReviews
    rejected += 1 - expectedReviews
    await assertReviewState(roundId, expectedReviews)
    await deleteRound(ctx, roundId, 'review-close round')
  }
  console.log(`  Review submit vs round close: ${committed} committed before close, ${rejected} rejected after close`)
}

async function raceReviewsAgainstAssignmentRemoval(ctx) {
  let committedBeforeDelete = 0
  let rejectedAfterDelete = 0
  for (let index = 0; index < STATE_ATTEMPTS; index += 1) {
    const roundId = await createReviewRound(ctx, 'delete', index)
    const [review, removeAssignments] = await launchRace(
      index,
      () => api('POST', '/api/reviews', reviewBody(roundId, ctx.applicantId.toString()), GRADER),
      () => api('DELETE', `/api/rounds/${encodeURIComponent(roundId)}`),
    )
    assert.equal(
      removeAssignments.status,
      200,
      `assignment-removing round delete failed: ${removeAssignments.status} ${removeAssignments.errorBody}`,
    )
    ctx.roundIds.delete(roundId)
    assertStatusIn('review vs assignment-removing round delete', review, [201, 404])
    committedBeforeDelete += review.status === 201 ? 1 : 0
    rejectedAfterDelete += review.status === 404 ? 1 : 0

    const [round, reviews, assignments, rawReviews, rawAssignments] = await Promise.all([
      api('GET', `/api/rounds/${encodeURIComponent(roundId)}`),
      api('GET', `/api/reviews?round_id=${encodeURIComponent(roundId)}`),
      api('GET', `/api/grader-assignments?round_id=${encodeURIComponent(roundId)}`),
      ctx.fixtureDb.collection('reviews').countDocuments({ round_id: new mongoose.Types.ObjectId(roundId) }),
      ctx.fixtureDb.collection('graderassignments').countDocuments({ round_id: new mongoose.Types.ObjectId(roundId) }),
    ])
    assert.equal(round.status, 404, 'deleted round remained visible after the race')
    assert.equal(reviews.status, 200, `review cleanup lookup failed: ${reviews.status} ${reviews.errorBody}`)
    assert.deepEqual(reviews.data, [], 'round deletion left reviews behind')
    assert.equal(assignments.status, 200, `assignment cleanup lookup failed: ${assignments.status} ${assignments.errorBody}`)
    assert.deepEqual(assignments.data, [], 'round deletion left assignments behind')
    assert.equal(rawReviews, 0, 'round deletion left raw review rows behind')
    assert.equal(rawAssignments, 0, 'round deletion left raw assignment rows behind')
  }
  console.log(
    `  Review submit vs assignment-removing delete: ${committedBeforeDelete} committed then cascaded, ${rejectedAfterDelete} rejected`,
  )
}

function candidateRows(kind, index) {
  return Array.from({ length: CANDIDATES_PER_IMPORT }, (_, candidateIndex) => ({
    name: `${kind} race ${index} candidate ${candidateIndex}`,
    status: 'pending',
    data: { run: RUN_TOKEN, kind, index, candidate_index: candidateIndex },
  }))
}

async function createStandaloneSession(ctx, id, actor, label) {
  const result = await api('POST', '/api/sessions', {
    id,
    round_id: null,
    name: label,
    anonymous: false,
    role: null,
  }, actor)
  assert.equal(result.status, 201, `${label} setup failed: ${result.status} ${result.errorBody}`)
  ctx.sessionIds.add(id)
}

async function deleteSession(ctx, id, actor, label) {
  const result = await api('DELETE', `/api/sessions/${encodeURIComponent(id)}`, undefined, actor)
  assertStatusIn(`${label} cleanup`, result, [200, 404])
  ctx.sessionIds.delete(id)
}

async function createCycle(ctx, label, index) {
  const result = await api('POST', '/api/cycles', {
    name: `TOCTOU ${label} ${index}`,
    status: 'active',
    accepting_applications: false,
  }, stateActor(`cycle-${label}`, index))
  assert.equal(result.status, 201, `${label} cycle setup failed: ${result.status} ${result.errorBody}`)
  assert.ok(result.data?.id, `${label} cycle setup did not return an id`)
  ctx.cycleIds.add(result.data.id)
  return result.data.id
}

async function deleteCycle(ctx, cycleId, label, actor = ADMIN) {
  const result = await api('DELETE', `/api/cycles/${encodeURIComponent(cycleId)}`, undefined, actor)
  assertStatusIn(`${label} cycle cleanup`, result, [200, 404])
  ctx.cycleIds.delete(cycleId)
}

async function createRoundForCycle(ctx, cycleId, label, index, status = 'pending', orderIndex = 1) {
  const result = await api('POST', '/api/rounds', {
    cycle_id: cycleId,
    name: `${label} round ${index}`,
    grading_type: 'rubric',
    order_index: orderIndex,
    status,
    role: null,
  }, stateActor(`round-${label}`, index))
  assert.equal(result.status, 201, `${label} round setup failed: ${result.status} ${result.errorBody}`)
  assert.ok(result.data?.id, `${label} round setup did not return an id`)
  return result.data.id
}

async function seedApplicantForCycle(ctx, cycleId, label, index) {
  const applicantId = new mongoose.Types.ObjectId()
  const insert = await ctx.fixtureDb.collection('applicants').insertOne({
    _id: applicantId,
    cycle_id: new mongoose.Types.ObjectId(cycleId),
    first_name: `${label}Race`,
    last_name: `Applicant${index}`,
    email: `${label}-${RUN_TOKEN}-${index}@berkeley.edu`.toLowerCase(),
    identity_provider: 'google-berkeley',
    identity_verified_at: new Date(),
    desired_roles: 'Industry Developer',
    created_at: new Date(),
  })
  assert.equal(insert.acknowledged, true, `${label} applicant fixture insert was not acknowledged`)
  return applicantId
}

async function createAuthorizedGrader(ctx, label, index) {
  const email = `race-target-${label}-${RUN_TOKEN}-${index}@example.com`
  const result = await api('POST', '/api/authorized-users', { email, role: 'grader' })
  assert.equal(result.status, 201, `${label} grader setup failed: ${result.status} ${result.errorBody}`)
  assert.ok(result.data?.id, `${label} grader setup did not return an id`)
  ctx.authorizedUserIds.add(result.data.id)
  return { id: result.data.id, email }
}

async function createCandidateFixture(ctx, sessionKind, index, label, withWriter = false) {
  const owner = stateActor(`${label}-owner`, index)
  const writer = stateActor(`${label}-writer`, index)
  const sessionId = stateSessionId(sessionKind, index)
  await createStandaloneSession(ctx, sessionId, owner, `${label} ${index}`)

  if (withWriter) {
    const member = await api('POST', '/api/session-members', {
      session_id: sessionId,
      user_email: writer.email,
    }, owner)
    assert.equal(member.status, 200, `${label} member setup failed: ${member.status} ${member.errorBody}`)
  }

  const imported = await api('POST', `/api/sessions/${encodeURIComponent(sessionId)}/candidates`, [{
    name: `${label} candidate ${index}`,
    status: 'pending',
    data: { run: RUN_TOKEN, label, index },
  }], owner)
  assert.equal(imported.status, 201, `${label} candidate setup failed: ${imported.status} ${imported.errorBody}`)
  assert.ok(Array.isArray(imported.data) && imported.data.length === 1, `${label} candidate setup returned invalid data`)
  assert.ok(imported.data[0]?.id, `${label} candidate setup did not return an id`)

  return {
    owner,
    writer,
    sessionId,
    candidateId: imported.data[0].id,
    originalName: `${label} candidate ${index}`,
  }
}

function activityWrite(resource, candidateId, index, fresh = false) {
  if (resource === 'vote') {
    return {
      path: '/api/votes',
      body: {
        candidate_id: candidateId,
        vote_type: fresh ? 'anti_vouch' : 'vouch',
        voter_name: fresh ? `Fresh writer ${index}` : `Race writer ${index}`,
      },
      collection: 'votes',
    }
  }
  return {
    path: '/api/candidate-notes',
    body: {
      candidate_id: candidateId,
      content: fresh ? `Fresh post-lifecycle note ${index}` : `Concurrent lifecycle note ${index}`,
      type: 'note',
      author: fresh ? `Fresh writer ${index}` : `Race writer ${index}`,
    },
    collection: 'candidatenotes',
  }
}

async function activityRows(resource, candidateId, actor) {
  return resource === 'vote'
    ? api('GET', `/api/votes?candidate_ids=${encodeURIComponent(candidateId)}`, undefined, actor)
    : api('GET', `/api/candidate-notes?candidate_id=${encodeURIComponent(candidateId)}`, undefined, actor)
}

async function assertRawActivityCount(ctx, resource, candidateId, expected, label) {
  const { collection } = activityWrite(resource, candidateId, 0)
  const count = await ctx.fixtureDb.collection(collection).countDocuments({
    candidate_id: new mongoose.Types.ObjectId(candidateId),
  })
  assert.equal(count, expected, `${label}: raw ${resource} count diverged from the committed response`)
}

async function raceActivityCreatesAgainstSessionLifecycle(ctx, resource, mutation, sessionKind) {
  let committed = 0
  let rejected = 0
  for (let index = 0; index < STATE_ATTEMPTS; index += 1) {
    const label = `${resource}-${mutation}`
    const fixture = await createCandidateFixture(ctx, sessionKind, index, label, true)
    const initialWrite = activityWrite(resource, fixture.candidateId, index)
    const lifecycle = mutation === 'end'
      ? () => api('PATCH', `/api/sessions/${encodeURIComponent(fixture.sessionId)}`, { status: 'ended' }, fixture.owner)
      : mutation === 'delete'
        ? () => api('DELETE', `/api/sessions/${encodeURIComponent(fixture.sessionId)}`, undefined, fixture.owner)
        : mutation === 'remove-member'
          ? () => api('DELETE', '/api/session-members', {
            session_id: fixture.sessionId,
            user_email: fixture.writer.email,
          }, fixture.owner)
          : () => api('POST', '/api/session-bans', {
            session_id: fixture.sessionId,
            email: fixture.writer.email,
          }, fixture.owner)

    const [write, lifecycleResult] = await launchRace(
      index,
      () => api('POST', initialWrite.path, initialWrite.body, fixture.writer),
      lifecycle,
    )
    const expectedLifecycleStatus = mutation === 'ban' ? 201 : 200
    assert.equal(
      lifecycleResult.status,
      expectedLifecycleStatus,
      `${label} lifecycle mutation failed: ${lifecycleResult.status} ${lifecycleResult.errorBody}`,
    )
    const rejectedStatus = mutation === 'end' ? 409 : mutation === 'delete' ? 404 : 403
    assertStatusIn(label, write, [201, rejectedStatus])
    committed += write.status === 201 ? 1 : 0
    rejected += write.status === rejectedStatus ? 1 : 0

    if (mutation === 'delete') {
      ctx.sessionIds.delete(fixture.sessionId)
      const [session, rawSession, rawCandidate, rawMember, rawBan] = await Promise.all([
        api('GET', `/api/sessions/${encodeURIComponent(fixture.sessionId)}`, undefined, fixture.owner),
        ctx.fixtureDb.collection('sessions').countDocuments({ _id: fixture.sessionId }),
        ctx.fixtureDb.collection('candidates').countDocuments({ _id: new mongoose.Types.ObjectId(fixture.candidateId) }),
        ctx.fixtureDb.collection('sessionmembers').countDocuments({ session_id: fixture.sessionId }),
        ctx.fixtureDb.collection('sessionbans').countDocuments({ session_id: fixture.sessionId }),
      ])
      assert.equal(session.status, 404, `${label}: deleted session remained API-visible`)
      assert.equal(rawSession, 0, `${label}: raw session survived deletion`)
      assert.equal(rawCandidate, 0, `${label}: candidate orphan survived session deletion`)
      assert.equal(rawMember, 0, `${label}: membership orphan survived session deletion`)
      assert.equal(rawBan, 0, `${label}: ban orphan survived session deletion`)
      await assertRawActivityCount(ctx, resource, fixture.candidateId, 0, label)
      const fresh = activityWrite(resource, fixture.candidateId, index, true)
      const freshResult = await api('POST', fresh.path, fresh.body, fixture.writer)
      assert.equal(freshResult.status, 404, `${label}: a fresh write was accepted after parent deletion`)
      continue
    }

    const expectedActivityCount = write.status === 201 ? 1 : 0
    const [session, rows] = await Promise.all([
      api('GET', `/api/sessions/${encodeURIComponent(fixture.sessionId)}`, undefined, fixture.owner),
      activityRows(resource, fixture.candidateId, fixture.owner),
    ])
    assert.equal(session.status, 200, `${label}: session postcondition lookup failed: ${session.status} ${session.errorBody}`)
    assert.equal(session.data?.status, mutation === 'end' ? 'ended' : 'active', `${label}: final session state is incorrect`)
    assert.equal(rows.status, 200, `${label}: activity postcondition lookup failed: ${rows.status} ${rows.errorBody}`)
    assert.ok(Array.isArray(rows.data), `${label}: activity postcondition lookup did not return an array`)
    assert.equal(rows.data.length, expectedActivityCount, `${label}: API activity count diverged from the committed response`)
    await assertRawActivityCount(ctx, resource, fixture.candidateId, expectedActivityCount, label)

    if (mutation === 'remove-member' || mutation === 'ban') {
      const [rawMembers, rawBans] = await Promise.all([
        ctx.fixtureDb.collection('sessionmembers').countDocuments({
          session_id: fixture.sessionId,
          user_email: fixture.writer.email,
        }),
        ctx.fixtureDb.collection('sessionbans').countDocuments({
          session_id: fixture.sessionId,
          email: fixture.writer.email,
        }),
      ])
      assert.equal(rawMembers, 0, `${label}: removed member remained in the session`)
      assert.equal(rawBans, mutation === 'ban' ? 1 : 0, `${label}: final ban state is incorrect`)
    }

    const fresh = activityWrite(resource, fixture.candidateId, index, true)
    const freshResult = await api('POST', fresh.path, fresh.body, fixture.writer)
    assert.equal(freshResult.status, rejectedStatus, `${label}: a fresh write was accepted after lifecycle mutation`)
    await assertRawActivityCount(ctx, resource, fixture.candidateId, expectedActivityCount, `${label} fresh-write`)
    await deleteSession(ctx, fixture.sessionId, fixture.owner, `${label} session`)
  }
  console.log(`  ${resource} create vs session ${mutation}: ${committed} committed first, ${rejected} rejected`)
}

function activityDelete(resource, id, actor) {
  return resource === 'vote'
    ? api('DELETE', '/api/votes', { id }, actor)
    : api('DELETE', `/api/candidate-notes?id=${encodeURIComponent(id)}`, undefined, actor)
}

async function createHierarchicalActivityFixture(ctx, resource, operation, lifecycle, index) {
  const label = `${resource}-${operation}-${lifecycle}`
  const owner = {
    email: `race-${label}-host-${RUN_TOKEN}-${index}@example.com`,
    role: 'admin',
  }
  const writer = {
    email: `race-${label}-writer-${RUN_TOKEN}-${index}@example.com`,
    role: 'grader',
  }
  // Alternating repetitions cover both privileged roles while launchRace uses
  // the same parity to cover both request launch orders. This actor is never a
  // member of the deliberation session.
  const privileged = {
    email: `race-${label}-privileged-${RUN_TOKEN}-${index}@example.com`,
    role: index % 2 === 0 ? 'leadership' : 'admin',
  }
  const cycleId = await createCycle(ctx, label, index)
  const roundId = await createRoundForCycle(ctx, cycleId, label, index, 'deliberating')
  const sessionId = stateSessionId('A', index)
  const session = await api('POST', '/api/sessions', {
    id: sessionId,
    round_id: roundId,
    name: `${label} session ${index}`,
    anonymous: false,
    role: null,
  }, owner)
  assert.equal(session.status, 201, `${label}: session setup failed: ${session.status} ${session.errorBody}`)
  ctx.sessionIds.add(sessionId)

  const member = await api('POST', '/api/session-members', {
    session_id: sessionId,
    user_email: writer.email,
  }, owner)
  assert.equal(member.status, 200, `${label}: writer membership setup failed: ${member.status} ${member.errorBody}`)

  const imported = await api('POST', `/api/sessions/${encodeURIComponent(sessionId)}/candidates`, [{
    name: `${label} candidate ${index}`,
    status: 'pending',
    data: { run: RUN_TOKEN, resource, operation, lifecycle, index },
  }], owner)
  assert.equal(imported.status, 201, `${label}: candidate setup failed: ${imported.status} ${imported.errorBody}`)
  assert.ok(Array.isArray(imported.data) && imported.data.length === 1, `${label}: candidate setup returned invalid data`)
  assert.ok(imported.data[0]?.id, `${label}: candidate setup did not return an id`)

  const privilegedMembership = await ctx.fixtureDb.collection('sessionmembers').countDocuments({
    session_id: sessionId,
    user_email: privileged.email,
  })
  assert.equal(privilegedMembership, 0, `${label}: privileged deletion actor unexpectedly became a member`)

  return {
    label,
    owner,
    writer,
    privileged,
    cycleId,
    roundId,
    sessionId,
    candidateId: imported.data[0].id,
  }
}

async function seedActivityForDelete(resource, fixture, index) {
  const write = activityWrite(resource, fixture.candidateId, index)
  const result = await api('POST', write.path, write.body, fixture.writer)
  assert.equal(
    result.status,
    201,
    `${fixture.label}: activity setup failed: ${result.status} ${result.errorBody}`,
  )
  assert.ok(result.data?.id, `${fixture.label}: activity setup did not return an id`)
  return result.data.id
}

function hierarchyLifecycleRequest(fixture, lifecycle) {
  if (lifecycle === 'candidate-delete') {
    return api('DELETE', `/api/candidates/${encodeURIComponent(fixture.candidateId)}`, undefined, fixture.owner)
  }
  if (lifecycle === 'round-end') {
    return api('PATCH', `/api/rounds/${encodeURIComponent(fixture.roundId)}`, { status: 'ended' }, fixture.owner)
  }
  if (lifecycle === 'round-delete') {
    return api('DELETE', `/api/rounds/${encodeURIComponent(fixture.roundId)}`, undefined, fixture.owner)
  }
  if (lifecycle === 'cycle-end') {
    return api('PATCH', `/api/cycles/${encodeURIComponent(fixture.cycleId)}`, { status: 'ended' }, fixture.owner)
  }
  return api('DELETE', `/api/cycles/${encodeURIComponent(fixture.cycleId)}`, undefined, fixture.owner)
}

function rejectedActivityStatus(lifecycle) {
  return lifecycle.endsWith('-end') ? 409 : 404
}

function allowedActivityRaceStatuses(resource, operation, lifecycle) {
  const rejectedStatus = rejectedActivityStatus(lifecycle)
  if (operation === 'create') return [201, rejectedStatus]
  // Vote deletion is deliberately idempotent when its row has already been
  // cascaded. Note deletion distinguishes that case with a 404.
  if (lifecycle.endsWith('-delete') && resource === 'vote') return [200]
  return [200, rejectedStatus]
}

async function hierarchyCounts(ctx, fixture) {
  const cycleObjectId = new mongoose.Types.ObjectId(fixture.cycleId)
  const roundObjectId = new mongoose.Types.ObjectId(fixture.roundId)
  const candidateObjectId = new mongoose.Types.ObjectId(fixture.candidateId)
  const [cycle, round, session, candidate, member, ban, vote, note] = await Promise.all([
    ctx.fixtureDb.collection('recruitmentcycles').findOne({ _id: cycleObjectId }),
    ctx.fixtureDb.collection('rounds').findOne({ _id: roundObjectId }),
    ctx.fixtureDb.collection('sessions').findOne({ _id: fixture.sessionId }),
    ctx.fixtureDb.collection('candidates').findOne({ _id: candidateObjectId }),
    ctx.fixtureDb.collection('sessionmembers').countDocuments({ session_id: fixture.sessionId }),
    ctx.fixtureDb.collection('sessionbans').countDocuments({ session_id: fixture.sessionId }),
    ctx.fixtureDb.collection('votes').countDocuments({ candidate_id: candidateObjectId }),
    ctx.fixtureDb.collection('candidatenotes').countDocuments({ candidate_id: candidateObjectId }),
  ])
  return { cycle, round, session, candidate, member, ban, vote, note }
}

function assertDeletedHierarchy(label, lifecycle, state) {
  if (lifecycle === 'candidate-delete') {
    assert.ok(state.cycle, `${label}: cycle disappeared during candidate deletion`)
    assert.ok(state.round, `${label}: round disappeared during candidate deletion`)
    assert.ok(state.session, `${label}: session disappeared during candidate deletion`)
    assert.equal(state.candidate, null, `${label}: candidate survived direct deletion`)
    assert.equal(state.member, 1, `${label}: direct candidate deletion changed session membership`)
  } else if (lifecycle === 'round-delete') {
    assert.ok(state.cycle, `${label}: cycle disappeared during round deletion`)
    assert.equal(state.round, null, `${label}: round survived deletion`)
    assert.equal(state.session, null, `${label}: session orphan survived round deletion`)
    assert.equal(state.candidate, null, `${label}: candidate orphan survived round deletion`)
    assert.equal(state.member, 0, `${label}: membership orphan survived round deletion`)
  } else {
    assert.equal(state.cycle, null, `${label}: cycle survived deletion`)
    assert.equal(state.round, null, `${label}: round orphan survived cycle deletion`)
    assert.equal(state.session, null, `${label}: session orphan survived cycle deletion`)
    assert.equal(state.candidate, null, `${label}: candidate orphan survived cycle deletion`)
    assert.equal(state.member, 0, `${label}: membership orphan survived cycle deletion`)
  }
  assert.equal(state.ban, 0, `${label}: ban orphan survived lifecycle deletion`)
  assert.equal(state.vote, 0, `${label}: vote orphan survived lifecycle deletion`)
  assert.equal(state.note, 0, `${label}: note orphan survived lifecycle deletion`)
}

function assertEndedHierarchy(label, lifecycle, state) {
  assert.ok(state.cycle, `${label}: cycle disappeared during lifecycle end`)
  assert.ok(state.round, `${label}: round disappeared during lifecycle end`)
  assert.ok(state.session, `${label}: session disappeared during lifecycle end`)
  assert.ok(state.candidate, `${label}: candidate disappeared during lifecycle end`)
  assert.equal(state.member, 1, `${label}: lifecycle end changed session membership`)
  assert.equal(state.ban, 0, `${label}: lifecycle end created a ban`)
  if (lifecycle === 'cycle-end') {
    assert.equal(state.cycle.status, 'ended', `${label}: cycle was not ended`)
    assert.equal(state.round.status, 'ended', `${label}: descendant round was not ended with its cycle`)
  } else {
    assert.equal(state.cycle.status, 'active', `${label}: round end changed cycle status`)
    assert.equal(state.round.status, 'ended', `${label}: round was not ended`)
  }
  assert.equal(state.session.status, 'ended', `${label}: descendant session was not ended`)
}

async function raceActivityAgainstHierarchyLifecycle(ctx, resource, operation, lifecycle) {
  let committed = 0
  let rejected = 0
  for (let index = 0; index < ACTIVITY_HIERARCHY_ATTEMPTS; index += 1) {
    const fixture = await createHierarchicalActivityFixture(ctx, resource, operation, lifecycle, index)
    const activityId = operation === 'create'
      ? null
      : await seedActivityForDelete(resource, fixture, index)
    const actor = operation === 'privileged-delete' ? fixture.privileged : fixture.writer
    const mutate = operation === 'create'
      ? () => {
        const write = activityWrite(resource, fixture.candidateId, index)
        return api('POST', write.path, write.body, actor)
      }
      : () => activityDelete(resource, activityId, actor)

    const [activityResult, lifecycleResult] = await launchRace(
      index,
      mutate,
      () => hierarchyLifecycleRequest(fixture, lifecycle),
    )
    assert.equal(
      lifecycleResult.status,
      200,
      `${fixture.label}: lifecycle mutation failed: ${lifecycleResult.status} ${lifecycleResult.errorBody}`,
    )
    assertStatusIn(
      fixture.label,
      activityResult,
      allowedActivityRaceStatuses(resource, operation, lifecycle),
    )
    const successStatus = operation === 'create' ? 201 : 200
    committed += activityResult.status === successStatus ? 1 : 0
    rejected += activityResult.status === successStatus ? 0 : 1

    if (lifecycle === 'cycle-delete') ctx.cycleIds.delete(fixture.cycleId)
    if (lifecycle === 'round-delete' || lifecycle === 'cycle-delete') {
      ctx.sessionIds.delete(fixture.sessionId)
    }

    let state = await hierarchyCounts(ctx, fixture)
    if (lifecycle.endsWith('-delete')) {
      assertDeletedHierarchy(fixture.label, lifecycle, state)
    } else {
      assertEndedHierarchy(fixture.label, lifecycle, state)
      const expectedCount = operation === 'create'
        ? activityResult.status === 201 ? 1 : 0
        : activityResult.status === 200 ? 0 : 1
      assert.equal(
        state[resource],
        expectedCount,
        `${fixture.label}: persisted ${resource} count does not match the linearized response`,
      )
      assert.equal(
        state[resource === 'vote' ? 'note' : 'vote'],
        0,
        `${fixture.label}: unrelated activity appeared during the race`,
      )
    }

    const fresh = activityWrite(resource, fixture.candidateId, index, true)
    const freshResult = await api('POST', fresh.path, fresh.body, fixture.writer)
    assert.equal(
      freshResult.status,
      rejectedActivityStatus(lifecycle),
      `${fixture.label}: fresh post-lifecycle ${resource} mutation was accepted: ${freshResult.status} ${freshResult.errorBody}`,
    )
    state = await hierarchyCounts(ctx, fixture)
    if (lifecycle.endsWith('-delete')) {
      assertDeletedHierarchy(`${fixture.label} fresh-write`, lifecycle, state)
    } else {
      const expectedCount = operation === 'create'
        ? activityResult.status === 201 ? 1 : 0
        : activityResult.status === 200 ? 0 : 1
      assert.equal(
        state[resource],
        expectedCount,
        `${fixture.label}: rejected fresh write changed persisted activity`,
      )
    }

    ctx.sessionIds.delete(fixture.sessionId)
    if (lifecycle !== 'cycle-delete') {
      await deleteCycle(ctx, fixture.cycleId, fixture.label, fixture.owner)
    }
  }
  console.log(
    `  ${resource} ${operation} vs ${lifecycle}: ${committed} linearized before lifecycle, ${rejected} rejected after lifecycle`,
  )
}

async function raceCandidatePatchesAgainstSessionLifecycle(ctx, mutation, sessionKind) {
  let committed = 0
  let rejected = 0
  for (let index = 0; index < STATE_ATTEMPTS; index += 1) {
    const label = `candidate-patch-${mutation}`
    const fixture = await createCandidateFixture(ctx, sessionKind, index, label)
    const updatedName = `${label} updated ${index}`
    const [candidatePatch, lifecycle] = await launchRace(
      index,
      () => api('PATCH', `/api/candidates/${encodeURIComponent(fixture.candidateId)}`, { name: updatedName }, fixture.owner),
      () => mutation === 'end'
        ? api('PATCH', `/api/sessions/${encodeURIComponent(fixture.sessionId)}`, { status: 'ended' }, fixture.owner)
        : api('DELETE', `/api/sessions/${encodeURIComponent(fixture.sessionId)}`, undefined, fixture.owner),
    )
    assert.equal(lifecycle.status, 200, `${label}: lifecycle mutation failed: ${lifecycle.status} ${lifecycle.errorBody}`)
    const rejectedStatus = mutation === 'end' ? 409 : 404
    assertStatusIn(label, candidatePatch, [200, rejectedStatus])
    committed += candidatePatch.status === 200 ? 1 : 0
    rejected += candidatePatch.status === rejectedStatus ? 1 : 0

    const freshPatch = await api(
      'PATCH',
      `/api/candidates/${encodeURIComponent(fixture.candidateId)}`,
      { name: `${label} fresh ${index}` },
      fixture.owner,
    )
    assert.equal(freshPatch.status, rejectedStatus, `${label}: fresh candidate PATCH was accepted after lifecycle mutation`)

    if (mutation === 'delete') {
      ctx.sessionIds.delete(fixture.sessionId)
      const [session, rawCandidate, rawVotes, rawNotes] = await Promise.all([
        api('GET', `/api/sessions/${encodeURIComponent(fixture.sessionId)}`, undefined, fixture.owner),
        ctx.fixtureDb.collection('candidates').countDocuments({ _id: new mongoose.Types.ObjectId(fixture.candidateId) }),
        ctx.fixtureDb.collection('votes').countDocuments({ candidate_id: new mongoose.Types.ObjectId(fixture.candidateId) }),
        ctx.fixtureDb.collection('candidatenotes').countDocuments({ candidate_id: new mongoose.Types.ObjectId(fixture.candidateId) }),
      ])
      assert.equal(session.status, 404, `${label}: deleted session remained API-visible`)
      assert.equal(rawCandidate, 0, `${label}: candidate survived session deletion`)
      assert.equal(rawVotes, 0, `${label}: vote orphan survived session deletion`)
      assert.equal(rawNotes, 0, `${label}: note orphan survived session deletion`)
      continue
    }

    const [session, candidates, rawCandidate] = await Promise.all([
      api('GET', `/api/sessions/${encodeURIComponent(fixture.sessionId)}`, undefined, fixture.owner),
      api('GET', `/api/sessions/${encodeURIComponent(fixture.sessionId)}/candidates`, undefined, fixture.owner),
      ctx.fixtureDb.collection('candidates').findOne({ _id: new mongoose.Types.ObjectId(fixture.candidateId) }),
    ])
    assert.equal(session.status, 200, `${label}: session postcondition lookup failed`)
    assert.equal(session.data?.status, 'ended', `${label}: session was not ended`)
    assert.equal(candidates.status, 200, `${label}: candidate postcondition lookup failed`)
    assert.ok(Array.isArray(candidates.data) && candidates.data.length === 1, `${label}: candidate API postcondition is invalid`)
    assert.ok(rawCandidate, `${label}: candidate disappeared after session end`)
    const expectedName = candidatePatch.status === 200 ? updatedName : fixture.originalName
    assert.equal(candidates.data[0]?.name, expectedName, `${label}: API candidate state diverged from the winning operation`)
    assert.equal(rawCandidate.name, expectedName, `${label}: raw candidate state diverged from the winning operation`)
    await deleteSession(ctx, fixture.sessionId, fixture.owner, `${label} session`)
  }
  console.log(`  Candidate PATCH vs session ${mutation}: ${committed} committed first, ${rejected} rejected`)
}

async function raceCandidateImportsAgainstSessionEnd(ctx) {
  let committed = 0
  let rejected = 0
  for (let index = 0; index < STATE_ATTEMPTS; index += 1) {
    const actor = stateActor('candidate-close', index)
    const sessionId = stateSessionId('C', index)
    await createStandaloneSession(ctx, sessionId, actor, `Candidate close race ${index}`)
    const [candidateImport, close] = await launchRace(
      index,
      () => api('POST', `/api/sessions/${sessionId}/candidates`, candidateRows('close', index), actor),
      () => api('PATCH', `/api/sessions/${sessionId}`, { status: 'ended' }, actor),
    )
    assert.equal(close.status, 200, `session end failed: ${close.status} ${close.errorBody}`)
    assertStatusIn('candidate import vs session end', candidateImport, [201, 409])
    const expectedCandidates = candidateImport.status === 201 ? CANDIDATES_PER_IMPORT : 0
    committed += candidateImport.status === 201 ? 1 : 0
    rejected += candidateImport.status === 409 ? 1 : 0

    const [session, candidates, rawCandidates] = await Promise.all([
      api('GET', `/api/sessions/${sessionId}`, undefined, actor),
      api('GET', `/api/sessions/${sessionId}/candidates`, undefined, actor),
      ctx.fixtureDb.collection('candidates').countDocuments({ session_id: sessionId }),
    ])
    assert.equal(session.status, 200, `ended-session lookup failed: ${session.status} ${session.errorBody}`)
    assert.equal(session.data?.status, 'ended', 'session-end race did not persist the ended state')
    assert.equal(
      Number(session.data?.candidate_import_count ?? 0),
      candidateImport.status === 201 ? 1 : 0,
      'session import counter diverged from committed candidate import',
    )
    assert.equal(candidates.status, 200, `candidate postcondition lookup failed: ${candidates.status} ${candidates.errorBody}`)
    assert.ok(Array.isArray(candidates.data), 'candidate postcondition lookup did not return an array')
    assert.equal(candidates.data.length, expectedCandidates, 'candidate import response and persisted rows disagree')
    assert.equal(rawCandidates, expectedCandidates, 'raw candidate count and import response disagree')
    await deleteSession(ctx, sessionId, actor, 'candidate-close session')
  }
  console.log(`  Candidate import vs session end: ${committed} committed before end, ${rejected} rejected after end`)
}

async function raceCandidateImportsAgainstSessionDelete(ctx) {
  let committedBeforeDelete = 0
  let rejectedAfterDelete = 0
  for (let index = 0; index < STATE_ATTEMPTS; index += 1) {
    const actor = stateActor('candidate-delete', index)
    const sessionId = stateSessionId('D', index)
    await createStandaloneSession(ctx, sessionId, actor, `Candidate delete race ${index}`)
    const [candidateImport, deletion] = await launchRace(
      index,
      () => api('POST', `/api/sessions/${sessionId}/candidates`, candidateRows('delete', index), actor),
      () => api('DELETE', `/api/sessions/${sessionId}`, undefined, actor),
    )
    assert.equal(deletion.status, 200, `session delete failed: ${deletion.status} ${deletion.errorBody}`)
    ctx.sessionIds.delete(sessionId)
    assertStatusIn('candidate import vs session delete', candidateImport, [201, 404])
    committedBeforeDelete += candidateImport.status === 201 ? 1 : 0
    rejectedAfterDelete += candidateImport.status === 404 ? 1 : 0

    const deletedSession = await api('GET', `/api/sessions/${sessionId}`, undefined, actor)
    assert.equal(deletedSession.status, 404, 'deleted session remained visible after the race')

    // Reusing the same custom session ID turns any orphaned rows into visible
    // candidates, providing an API-level cascade check in addition to raw DB.
    await createStandaloneSession(ctx, sessionId, actor, `Candidate orphan check ${index}`)
    const [orphanCandidates, rawCandidates] = await Promise.all([
      api('GET', `/api/sessions/${sessionId}/candidates`, undefined, actor),
      ctx.fixtureDb.collection('candidates').countDocuments({ session_id: sessionId }),
    ])
    assert.equal(orphanCandidates.status, 200, `orphan check failed: ${orphanCandidates.status} ${orphanCandidates.errorBody}`)
    assert.deepEqual(orphanCandidates.data, [], 'session deletion left API-visible candidate orphans')
    assert.equal(rawCandidates, 0, 'session deletion left raw candidate orphans')
    await deleteSession(ctx, sessionId, actor, 'candidate-orphan-check session')
  }
  console.log(
    `  Candidate import vs session delete: ${committedBeforeDelete} committed then cascaded, ${rejectedAfterDelete} rejected`,
  )
}

async function raceRoundCreatesAgainstCycleLifecycle(ctx, mutation) {
  let committed = 0
  let rejected = 0
  for (let index = 0; index < STATE_ATTEMPTS; index += 1) {
    const label = `round-create-cycle-${mutation}`
    const actor = stateActor(label, index)
    const cycleId = await createCycle(ctx, label, index)
    const [roundCreate, lifecycle] = await launchRace(
      index,
      () => api('POST', '/api/rounds', {
        cycle_id: cycleId,
        name: `${label} ${index}`,
        grading_type: 'rubric',
        order_index: 1,
        status: 'pending',
        role: null,
      }, actor),
      () => mutation === 'end'
        ? api('PATCH', `/api/cycles/${encodeURIComponent(cycleId)}`, { status: 'ended' }, actor)
        : api('DELETE', `/api/cycles/${encodeURIComponent(cycleId)}`, undefined, actor),
    )
    assert.equal(lifecycle.status, 200, `${label}: lifecycle mutation failed: ${lifecycle.status} ${lifecycle.errorBody}`)
    assertStatusIn(label, roundCreate, [201, 404])
    committed += roundCreate.status === 201 ? 1 : 0
    rejected += roundCreate.status === 404 ? 1 : 0

    const fresh = await api('POST', '/api/rounds', {
      cycle_id: cycleId,
      name: `${label} fresh ${index}`,
      grading_type: 'rubric',
      order_index: 2,
      status: 'pending',
      role: null,
    }, actor)
    assert.equal(fresh.status, 404, `${label}: fresh round creation was accepted after cycle ${mutation}`)

    const rawRounds = await ctx.fixtureDb.collection('rounds')
      .find({ cycle_id: new mongoose.Types.ObjectId(cycleId) })
      .toArray()
    if (mutation === 'delete') {
      ctx.cycleIds.delete(cycleId)
      const [cycle, apiRounds, rawCycle] = await Promise.all([
        api('GET', `/api/cycles/${encodeURIComponent(cycleId)}`, undefined, actor),
        api('GET', `/api/cycles/${encodeURIComponent(cycleId)}/rounds`, undefined, actor),
        ctx.fixtureDb.collection('recruitmentcycles').countDocuments({ _id: new mongoose.Types.ObjectId(cycleId) }),
      ])
      assert.equal(cycle.status, 404, `${label}: deleted cycle remained API-visible`)
      assertStatusIn(`${label} round lookup`, apiRounds, [200, 404])
      if (apiRounds.status === 200) assert.deepEqual(apiRounds.data, [], `${label}: deleted cycle retained API-visible rounds`)
      assert.equal(rawCycle, 0, `${label}: raw cycle survived deletion`)
      assert.equal(rawRounds.length, 0, `${label}: round orphan survived cycle deletion`)
      continue
    }

    const [cycle, apiRounds] = await Promise.all([
      api('GET', `/api/cycles/${encodeURIComponent(cycleId)}`, undefined, actor),
      api('GET', `/api/cycles/${encodeURIComponent(cycleId)}/rounds`, undefined, actor),
    ])
    assert.equal(cycle.status, 200, `${label}: ended cycle lookup failed`)
    assert.equal(cycle.data?.status, 'ended', `${label}: cycle was not ended`)
    assert.equal(apiRounds.status, 200, `${label}: round lookup failed`)
    assert.ok(Array.isArray(apiRounds.data), `${label}: round lookup did not return an array`)
    const expectedRounds = roundCreate.status === 201 ? 1 : 0
    assert.equal(apiRounds.data.length, expectedRounds, `${label}: API round count diverged from the creation response`)
    assert.equal(rawRounds.length, expectedRounds, `${label}: raw round count diverged from the creation response`)
    if (expectedRounds === 1) {
      assert.equal(apiRounds.data[0]?.status, 'ended', `${label}: child-first round was not ended with its cycle`)
      assert.equal(rawRounds[0]?.status, 'ended', `${label}: raw child-first round was not ended with its cycle`)
    }
    await deleteCycle(ctx, cycleId, label, actor)
  }
  console.log(`  Round create vs cycle ${mutation}: ${committed} committed first, ${rejected} rejected`)
}

async function raceSessionCreatesAgainstRoundLifecycle(ctx, mutation, sessionKind, freshKind) {
  let committed = 0
  let rejected = 0
  for (let index = 0; index < STATE_ATTEMPTS; index += 1) {
    const label = `session-create-round-${mutation}`
    const actor = stateActor(label, index)
    const cycleId = await createCycle(ctx, label, index)
    const roundId = await createRoundForCycle(ctx, cycleId, label, index)
    const sessionId = stateSessionId(sessionKind, index)
    const [sessionCreate, lifecycle] = await launchRace(
      index,
      () => api('POST', '/api/sessions', {
        id: sessionId,
        round_id: roundId,
        name: `${label} ${index}`,
        anonymous: false,
        role: null,
      }, actor),
      () => mutation === 'end'
        ? api('PATCH', `/api/rounds/${encodeURIComponent(roundId)}`, { status: 'ended' }, actor)
        : api('DELETE', `/api/rounds/${encodeURIComponent(roundId)}`, undefined, actor),
    )
    assert.equal(lifecycle.status, 200, `${label}: lifecycle mutation failed: ${lifecycle.status} ${lifecycle.errorBody}`)
    assertStatusIn(label, sessionCreate, [201, 409])
    committed += sessionCreate.status === 201 ? 1 : 0
    rejected += sessionCreate.status === 409 ? 1 : 0
    if (sessionCreate.status === 201) ctx.sessionIds.add(sessionId)

    const freshSessionId = stateSessionId(freshKind, index)
    const fresh = await api('POST', '/api/sessions', {
      id: freshSessionId,
      round_id: roundId,
      name: `${label} fresh ${index}`,
      anonymous: false,
      role: null,
    }, actor)
    assert.equal(fresh.status, 409, `${label}: fresh session creation was accepted after round ${mutation}`)

    const [apiSessions, rawSessions] = await Promise.all([
      api('GET', `/api/sessions?round_id=${encodeURIComponent(roundId)}`, undefined, actor),
      ctx.fixtureDb.collection('sessions').find({ round_id: new mongoose.Types.ObjectId(roundId) }).toArray(),
    ])
    assert.equal(apiSessions.status, 200, `${label}: session postcondition lookup failed`)
    assert.ok(Array.isArray(apiSessions.data), `${label}: session postcondition lookup did not return an array`)

    if (mutation === 'delete') {
      const [round, rawRound] = await Promise.all([
        api('GET', `/api/rounds/${encodeURIComponent(roundId)}`, undefined, actor),
        ctx.fixtureDb.collection('rounds').countDocuments({ _id: new mongoose.Types.ObjectId(roundId) }),
      ])
      assert.equal(round.status, 404, `${label}: deleted round remained API-visible`)
      assert.equal(rawRound, 0, `${label}: raw round survived deletion`)
      assert.deepEqual(apiSessions.data, [], `${label}: session survived round deletion`)
      assert.equal(rawSessions.length, 0, `${label}: raw session orphan survived round deletion`)
    } else {
      const round = await api('GET', `/api/rounds/${encodeURIComponent(roundId)}`, undefined, actor)
      assert.equal(round.status, 200, `${label}: ended round lookup failed`)
      assert.equal(round.data?.status, 'ended', `${label}: round was not ended`)
      const expectedSessions = sessionCreate.status === 201 ? 1 : 0
      assert.equal(apiSessions.data.length, expectedSessions, `${label}: API session count diverged from creation response`)
      assert.equal(rawSessions.length, expectedSessions, `${label}: raw session count diverged from creation response`)
      if (expectedSessions === 1) {
        assert.equal(apiSessions.data[0]?.status, 'ended', `${label}: child-first session was not ended with its round`)
        assert.equal(rawSessions[0]?.status, 'ended', `${label}: raw child-first session was not ended with its round`)
      }
    }

    ctx.sessionIds.delete(sessionId)
    await deleteCycle(ctx, cycleId, label, actor)
  }
  console.log(`  Session create vs round ${mutation}: ${committed} committed first, ${rejected} rejected`)
}

async function raceSessionReparentsAgainstTargetRoundLifecycle(ctx, mutation, sessionKind) {
  let committed = 0
  let rejected = 0
  for (let index = 0; index < STATE_ATTEMPTS; index += 1) {
    const label = `session-reparent-round-${mutation}`
    const actor = stateActor(label, index)
    const cycleId = await createCycle(ctx, label, index)
    const sourceRoundId = await createRoundForCycle(ctx, cycleId, `${label}-source`, index, 'pending', 1)
    const targetRoundId = await createRoundForCycle(ctx, cycleId, `${label}-target`, index, 'pending', 2)
    const sessionId = stateSessionId(sessionKind, index)
    const sessionCreate = await api('POST', '/api/sessions', {
      id: sessionId,
      round_id: sourceRoundId,
      name: `${label} ${index}`,
      anonymous: false,
      role: null,
    }, actor)
    assert.equal(sessionCreate.status, 201, `${label}: source session setup failed: ${sessionCreate.status} ${sessionCreate.errorBody}`)
    ctx.sessionIds.add(sessionId)

    const [reparent, lifecycle] = await launchRace(
      index,
      () => api('PATCH', `/api/sessions/${encodeURIComponent(sessionId)}`, { round_id: targetRoundId }, actor),
      () => mutation === 'end'
        ? api('PATCH', `/api/rounds/${encodeURIComponent(targetRoundId)}`, { status: 'ended' }, actor)
        : api('DELETE', `/api/rounds/${encodeURIComponent(targetRoundId)}`, undefined, actor),
    )
    assert.equal(lifecycle.status, 200, `${label}: target-round lifecycle mutation failed: ${lifecycle.status} ${lifecycle.errorBody}`)
    assertStatusIn(label, reparent, [200, 409])
    committed += reparent.status === 200 ? 1 : 0
    rejected += reparent.status === 409 ? 1 : 0

    const fresh = await api(
      'PATCH',
      `/api/sessions/${encodeURIComponent(sessionId)}`,
      { round_id: targetRoundId },
      actor,
    )
    assertStatusIn(`${label} fresh reparent`, fresh, mutation === 'end' ? [409] : [404, 409])

    const [targetRound, targetSessions, rawTargetSessions, session, rawSession] = await Promise.all([
      api('GET', `/api/rounds/${encodeURIComponent(targetRoundId)}`, undefined, actor),
      api('GET', `/api/sessions?round_id=${encodeURIComponent(targetRoundId)}`, undefined, actor),
      ctx.fixtureDb.collection('sessions').find({ round_id: new mongoose.Types.ObjectId(targetRoundId) }).toArray(),
      api('GET', `/api/sessions/${encodeURIComponent(sessionId)}`, undefined, actor),
      ctx.fixtureDb.collection('sessions').findOne({ _id: sessionId }),
    ])
    assert.equal(targetSessions.status, 200, `${label}: target-session lookup failed`)
    assert.ok(Array.isArray(targetSessions.data), `${label}: target-session lookup did not return an array`)

    if (mutation === 'end') {
      assert.equal(targetRound.status, 200, `${label}: ended target round lookup failed`)
      assert.equal(targetRound.data?.status, 'ended', `${label}: target round was not ended`)
      assert.equal(session.status, 200, `${label}: source session disappeared after target-round end`)
      assert.ok(rawSession, `${label}: raw source session disappeared after target-round end`)
      if (reparent.status === 200) {
        assert.equal(session.data?.round_id, targetRoundId, `${label}: committed reparent did not persist`)
        assert.equal(session.data?.status, 'ended', `${label}: reparented session remained active after target-round end`)
        assert.equal(rawSession.round_id?.toString(), targetRoundId, `${label}: raw committed reparent did not persist`)
        assert.equal(rawSession.status, 'ended', `${label}: raw reparented session remained active after target-round end`)
        assert.equal(targetSessions.data.length, 1, `${label}: committed reparent is missing from target-round sessions`)
        assert.equal(rawTargetSessions.length, 1, `${label}: raw committed reparent is missing from target round`)
      } else {
        assert.equal(session.data?.round_id, sourceRoundId, `${label}: rejected reparent moved the session`)
        assert.equal(session.data?.status, 'active', `${label}: rejected reparent changed source session status`)
        assert.equal(rawSession.round_id?.toString(), sourceRoundId, `${label}: raw rejected reparent moved the session`)
        assert.equal(rawSession.status, 'active', `${label}: raw rejected reparent changed source session status`)
        assert.deepEqual(targetSessions.data, [], `${label}: rejected reparent left an API-visible target child`)
        assert.equal(rawTargetSessions.length, 0, `${label}: rejected reparent left a raw target child`)
      }
    } else {
      assert.equal(targetRound.status, 404, `${label}: deleted target round remained API-visible`)
      assert.deepEqual(targetSessions.data, [], `${label}: target-round deletion left an API-visible child`)
      assert.equal(rawTargetSessions.length, 0, `${label}: target-round deletion left a raw child`)
      if (reparent.status === 200) {
        assert.equal(session.status, 404, `${label}: reparented session survived target-round deletion`)
        assert.equal(rawSession, null, `${label}: raw reparented session survived target-round deletion`)
        ctx.sessionIds.delete(sessionId)
      } else {
        assert.equal(session.status, 200, `${label}: rejected reparent removed the source session`)
        assert.ok(rawSession, `${label}: rejected reparent removed the raw source session`)
        assert.equal(session.data?.round_id, sourceRoundId, `${label}: rejected reparent moved the session`)
        assert.equal(session.data?.status, 'active', `${label}: rejected reparent changed source session status`)
        assert.equal(rawSession.round_id?.toString(), sourceRoundId, `${label}: raw rejected reparent moved the session`)
        assert.equal(rawSession.status, 'active', `${label}: raw rejected reparent changed source session status`)
      }
    }

    ctx.sessionIds.delete(sessionId)
    await deleteCycle(ctx, cycleId, label, actor)
  }
  console.log(`  Session reparent vs target round ${mutation}: ${committed} committed first, ${rejected} rejected`)
}

function assignmentBody(roundId, applicantId, graderEmail) {
  return [{
    round_id: roundId,
    applicant_id: applicantId.toString(),
    grader_email: graderEmail,
  }]
}

async function raceAssignmentsAgainstRoundLifecycle(ctx, mutation) {
  let committed = 0
  let rejected = 0
  for (let index = 0; index < STATE_ATTEMPTS; index += 1) {
    const label = `assignment-round-${mutation}`
    const actor = stateActor(label, index)
    const cycleId = await createCycle(ctx, label, index)
    const applicantId = await seedApplicantForCycle(ctx, cycleId, label, index)
    const roundId = await createRoundForCycle(ctx, cycleId, label, index, 'grading')
    const [assignment, lifecycle] = await launchRace(
      index,
      () => api('POST', '/api/grader-assignments', assignmentBody(roundId, applicantId, GRADER.email), actor),
      () => mutation === 'end'
        ? api('PATCH', `/api/rounds/${encodeURIComponent(roundId)}`, { status: 'ended' }, actor)
        : api('DELETE', `/api/rounds/${encodeURIComponent(roundId)}`, undefined, actor),
    )
    assert.equal(lifecycle.status, 200, `${label}: lifecycle mutation failed: ${lifecycle.status} ${lifecycle.errorBody}`)
    assertStatusIn(label, assignment, [200, 409])
    committed += assignment.status === 200 ? 1 : 0
    rejected += assignment.status === 409 ? 1 : 0

    const fresh = await api(
      'POST',
      '/api/grader-assignments',
      assignmentBody(roundId, applicantId, GRADER.email),
      actor,
    )
    assert.equal(fresh.status, 409, `${label}: fresh assignment was accepted after round ${mutation}`)

    const [apiAssignments, rawAssignments] = await Promise.all([
      api('GET', `/api/grader-assignments?round_id=${encodeURIComponent(roundId)}`, undefined, actor),
      ctx.fixtureDb.collection('graderassignments').find({ round_id: new mongoose.Types.ObjectId(roundId) }).toArray(),
    ])
    assert.equal(apiAssignments.status, 200, `${label}: assignment postcondition lookup failed`)
    assert.ok(Array.isArray(apiAssignments.data), `${label}: assignment lookup did not return an array`)
    if (mutation === 'delete') {
      const round = await api('GET', `/api/rounds/${encodeURIComponent(roundId)}`, undefined, actor)
      assert.equal(round.status, 404, `${label}: deleted round remained API-visible`)
      assert.deepEqual(apiAssignments.data, [], `${label}: assignment survived round deletion`)
      assert.equal(rawAssignments.length, 0, `${label}: raw assignment survived round deletion`)
    } else {
      const round = await api('GET', `/api/rounds/${encodeURIComponent(roundId)}`, undefined, actor)
      assert.equal(round.status, 200, `${label}: ended round lookup failed`)
      assert.equal(round.data?.status, 'ended', `${label}: round was not ended`)
      const expectedAssignments = assignment.status === 200 ? 1 : 0
      assert.equal(apiAssignments.data.length, expectedAssignments, `${label}: API assignment count diverged from response`)
      assert.equal(rawAssignments.length, expectedAssignments, `${label}: raw assignment count diverged from response`)
    }
    await deleteCycle(ctx, cycleId, label, actor)
  }
  console.log(`  Assignment create vs round ${mutation}: ${committed} committed first, ${rejected} rejected`)
}

async function raceAssignmentsAgainstCycleDelete(ctx) {
  let committed = 0
  let rejected = 0
  for (let index = 0; index < STATE_ATTEMPTS; index += 1) {
    const label = 'assignment-cycle-delete'
    const actor = stateActor(label, index)
    const cycleId = await createCycle(ctx, label, index)
    const applicantId = await seedApplicantForCycle(ctx, cycleId, label, index)
    const roundId = await createRoundForCycle(ctx, cycleId, label, index, 'grading')
    const [assignment, deletion] = await launchRace(
      index,
      () => api('POST', '/api/grader-assignments', assignmentBody(roundId, applicantId, GRADER.email), actor),
      () => api('DELETE', `/api/cycles/${encodeURIComponent(cycleId)}`, undefined, actor),
    )
    assert.equal(deletion.status, 200, `${label}: cycle deletion failed: ${deletion.status} ${deletion.errorBody}`)
    assertStatusIn(label, assignment, [200, 400, 404, 409])
    committed += assignment.status === 200 ? 1 : 0
    rejected += assignment.status === 200 ? 0 : 1
    ctx.cycleIds.delete(cycleId)

    const fresh = await api('POST', '/api/grader-assignments', assignmentBody(roundId, applicantId, GRADER.email), actor)
    assert.ok(fresh.status >= 400 && fresh.status < 500, `${label}: fresh assignment was not safely rejected: ${fresh.status} ${fresh.errorBody}`)
    const [cycle, round, rawApplicant, rawRound, rawAssignments] = await Promise.all([
      api('GET', `/api/cycles/${encodeURIComponent(cycleId)}`, undefined, actor),
      api('GET', `/api/rounds/${encodeURIComponent(roundId)}`, undefined, actor),
      ctx.fixtureDb.collection('applicants').countDocuments({ _id: applicantId }),
      ctx.fixtureDb.collection('rounds').countDocuments({ _id: new mongoose.Types.ObjectId(roundId) }),
      ctx.fixtureDb.collection('graderassignments').countDocuments({
        round_id: new mongoose.Types.ObjectId(roundId),
        applicant_id: applicantId,
      }),
    ])
    assert.equal(cycle.status, 404, `${label}: deleted cycle remained API-visible`)
    assert.equal(round.status, 404, `${label}: descendant round remained API-visible`)
    assert.equal(rawApplicant, 0, `${label}: applicant orphan survived cycle deletion`)
    assert.equal(rawRound, 0, `${label}: round orphan survived cycle deletion`)
    assert.equal(rawAssignments, 0, `${label}: assignment orphan survived cycle deletion`)
  }
  console.log(`  Assignment create vs cycle delete: ${committed} committed then cascaded, ${rejected} rejected`)
}

async function raceAssignmentsAgainstAuthorizedUserDelete(ctx) {
  let committed = 0
  let rejected = 0
  for (let index = 0; index < STATE_ATTEMPTS; index += 1) {
    const label = 'assignment-authorized-user-delete'
    const actor = stateActor(label, index)
    const cycleId = await createCycle(ctx, label, index)
    const applicantId = await seedApplicantForCycle(ctx, cycleId, label, index)
    const roundId = await createRoundForCycle(ctx, cycleId, label, index, 'grading')
    const grader = await createAuthorizedGrader(ctx, label, index)
    const [assignment, deletion] = await launchRace(
      index,
      () => api('POST', '/api/grader-assignments', assignmentBody(roundId, applicantId, grader.email), actor),
      () => api('DELETE', `/api/authorized-users/${encodeURIComponent(grader.id)}`, undefined, actor),
    )
    assert.equal(deletion.status, 200, `${label}: authorized-user deletion failed: ${deletion.status} ${deletion.errorBody}`)
    assertStatusIn(label, assignment, [200, 400, 404, 409])
    committed += assignment.status === 200 ? 1 : 0
    rejected += assignment.status === 200 ? 0 : 1
    ctx.authorizedUserIds.delete(grader.id)

    const fresh = await api('POST', '/api/grader-assignments', assignmentBody(roundId, applicantId, grader.email), actor)
    assert.ok(fresh.status >= 400 && fresh.status < 500, `${label}: fresh assignment was not safely rejected: ${fresh.status} ${fresh.errorBody}`)
    const [apiAssignments, rawUser, rawAssignments] = await Promise.all([
      api('GET', `/api/grader-assignments?round_id=${encodeURIComponent(roundId)}&grader_email=${encodeURIComponent(grader.email)}`, undefined, actor),
      ctx.fixtureDb.collection('authorizedusers').countDocuments({ email: grader.email }),
      ctx.fixtureDb.collection('graderassignments').countDocuments({ grader_email: grader.email }),
    ])
    assert.equal(apiAssignments.status, 200, `${label}: assignment postcondition lookup failed`)
    assert.deepEqual(apiAssignments.data, [], `${label}: deleted grader retained API-visible assignments`)
    assert.equal(rawUser, 0, `${label}: raw authorized user survived deletion`)
    assert.equal(rawAssignments, 0, `${label}: deleted grader retained raw assignments`)
    await deleteCycle(ctx, cycleId, label, actor)
  }
  console.log(`  Assignment create vs authorized-user delete: ${committed} committed then cascaded, ${rejected} rejected`)
}

async function raceMemberOrBanCreateAgainstSessionDelete(ctx, resource, sessionKind) {
  let committed = 0
  let rejected = 0
  for (let index = 0; index < STATE_ATTEMPTS; index += 1) {
    const label = `${resource}-create-session-delete`
    const owner = stateActor(`${label}-owner`, index)
    const target = stateActor(`${label}-target`, index)
    const sessionId = stateSessionId(sessionKind, index)
    await createStandaloneSession(ctx, sessionId, owner, `${label} ${index}`)
    const create = resource === 'member'
      ? () => api('POST', '/api/session-members', { session_id: sessionId, user_email: target.email }, owner)
      : () => api('POST', '/api/session-bans', { session_id: sessionId, email: target.email }, owner)
    const [childCreate, deletion] = await launchRace(
      index,
      create,
      () => api('DELETE', `/api/sessions/${encodeURIComponent(sessionId)}`, undefined, owner),
    )
    assert.equal(deletion.status, 200, `${label}: session deletion failed: ${deletion.status} ${deletion.errorBody}`)
    const successStatus = resource === 'member' ? 200 : 201
    assertStatusIn(label, childCreate, [successStatus, 404])
    committed += childCreate.status === successStatus ? 1 : 0
    rejected += childCreate.status === 404 ? 1 : 0
    ctx.sessionIds.delete(sessionId)

    const fresh = await create()
    assert.equal(fresh.status, 404, `${label}: fresh child creation was accepted after session deletion`)
    const [session, rawSession, rawMembers, rawBans] = await Promise.all([
      api('GET', `/api/sessions/${encodeURIComponent(sessionId)}`, undefined, owner),
      ctx.fixtureDb.collection('sessions').countDocuments({ _id: sessionId }),
      ctx.fixtureDb.collection('sessionmembers').countDocuments({ session_id: sessionId }),
      ctx.fixtureDb.collection('sessionbans').countDocuments({ session_id: sessionId }),
    ])
    assert.equal(session.status, 404, `${label}: deleted session remained API-visible`)
    assert.equal(rawSession, 0, `${label}: raw session survived deletion`)
    assert.equal(rawMembers, 0, `${label}: membership orphan survived session deletion`)
    assert.equal(rawBans, 0, `${label}: ban orphan survived session deletion`)
  }
  console.log(`  ${resource} create vs session delete: ${committed} committed then cascaded, ${rejected} rejected`)
}

function coffeeChatCsv(applicantName, index) {
  return [
    'PlexTech Member,Applicant,Notes,Was this a Coffee Chat?,Date,Other Notes',
    `Race Chatter,${applicantName},Lifecycle import ${index},Yes,2026-08-26,Disposable race data`,
  ].join('\n')
}

async function raceCoffeeImportsAgainstCycleDelete(ctx) {
  let committed = 0
  let rejected = 0
  for (let index = 0; index < STATE_ATTEMPTS; index += 1) {
    const label = 'coffee-import-cycle-delete'
    const actor = stateActor(label, index)
    const cycleId = await createCycle(ctx, label, index)
    const applicantId = await seedApplicantForCycle(ctx, cycleId, 'Coffee', index)
    const applicantName = `CoffeeRace Applicant${index}`
    const body = { action: 'commit', cycle_id: cycleId, csv_text: coffeeChatCsv(applicantName, index) }
    const [coffeeImport, deletion] = await launchRace(
      index,
      () => api('POST', '/api/coffee-chat-notes/import', body, actor),
      () => api('DELETE', `/api/cycles/${encodeURIComponent(cycleId)}`, undefined, actor),
    )
    assert.equal(deletion.status, 200, `${label}: cycle deletion failed: ${deletion.status} ${deletion.errorBody}`)
    assertStatusIn(label, coffeeImport, [200, 404])
    committed += coffeeImport.status === 200 ? 1 : 0
    rejected += coffeeImport.status === 404 ? 1 : 0
    ctx.cycleIds.delete(cycleId)

    const fresh = await api('POST', '/api/coffee-chat-notes/import', body, actor)
    assert.equal(fresh.status, 404, `${label}: fresh coffee-chat import was accepted after cycle deletion`)
    const [cycle, rawApplicant, rawNotes] = await Promise.all([
      api('GET', `/api/cycles/${encodeURIComponent(cycleId)}`, undefined, actor),
      ctx.fixtureDb.collection('applicants').countDocuments({ _id: applicantId }),
      ctx.fixtureDb.collection('coffeechatnotes').countDocuments({ cycle_id: new mongoose.Types.ObjectId(cycleId) }),
    ])
    assert.equal(cycle.status, 404, `${label}: deleted cycle remained API-visible`)
    assert.equal(rawApplicant, 0, `${label}: applicant orphan survived cycle deletion`)
    assert.equal(rawNotes, 0, `${label}: coffee-chat notes survived cycle deletion`)
  }
  console.log(`  Coffee-chat import vs cycle delete: ${committed} committed then cascaded, ${rejected} rejected`)
}

async function teardown(ctx) {
  const errors = []
  for (const sessionId of ctx.sessionIds ?? []) {
    const result = await api('DELETE', `/api/sessions/${encodeURIComponent(sessionId)}`)
    if (!result.ok && result.status !== 404) {
      errors.push(`session ${sessionId}: ${result.status} ${result.errorBody}`)
    }
  }
  for (const cycleId of ctx.cycleIds ?? []) {
    const result = await api('DELETE', `/api/cycles/${encodeURIComponent(cycleId)}`)
    if (!result.ok && result.status !== 404) {
      errors.push(`cycle ${cycleId}: ${result.status} ${result.errorBody}`)
    }
  }
  for (const userId of ctx.authorizedUserIds ?? []) {
    const result = await api('DELETE', `/api/authorized-users/${encodeURIComponent(userId)}`)
    if (!result.ok && result.status !== 404) {
      errors.push(`authorized user ${userId}: ${result.status} ${result.errorBody}`)
    }
  }
  if (ctx.fixtureDb && ctx.applicantId) {
    await ctx.fixtureDb.collection('reviews').deleteMany({ applicant_id: ctx.applicantId })
    await ctx.fixtureDb.collection('graderassignments').deleteMany({ applicant_id: ctx.applicantId })
    await ctx.fixtureDb.collection('applicants').deleteOne({ _id: ctx.applicantId })
  }
  if (ctx.fixtureConnection) await ctx.fixtureConnection.close()
  if (errors.length > 0) {
    throw new Error(`teardown failed:\n- ${errors.join('\n- ')}`)
  }
}

async function main() {
  const ctx = {}
  let primaryError
  try {
    await preflight()
    await setup(ctx)
    console.log('--- TOCTOU race-condition gate ---')
    console.log(`Target: ${BASE}\n`)
    console.log(`Unique-create fanout: ${ATTEMPTS}; state-transition repetitions: ${STATE_ATTEMPTS}`)
    console.log(`Activity hierarchy repetitions: ${ACTIVITY_HIERARCHY_ATTEMPTS} (both launch orders)`)
    console.log(`Candidate rows per import: ${CANDIDATES_PER_IMPORT}\n`)

    console.log('Unique-index races:')
    const namedSessionAttempts = await raceSessionCreate(ctx.roundId, 'curriculum')
    assertExactRace('Session create, role=curriculum', namedSessionAttempts)
    await assertSessionCount(ctx.roundId, 'curriculum')

    const nullSessionAttempts = await raceSessionCreate(ctx.roundId, null)
    assertExactRace('Session create, role=null', nullSessionAttempts)
    await assertSessionCount(ctx.roundId, null)

    const namedRoundAttempts = await raceRoundCreate(ctx.cycleId, 'developer', 5)
    assertExactRace('Round create, role=developer, order=5', namedRoundAttempts)
    await assertRoundCount(ctx.cycleId, 'developer', 5)

    const nullRoundAttempts = await raceRoundCreate(ctx.cycleId, null, 6)
    assertExactRace('Round create, role=null, order=6', nullRoundAttempts)
    await assertRoundCount(ctx.cycleId, null, 6)

    console.log('\nReview transaction races:')
    await raceReviewsAgainstRoundClose(ctx)
    await raceReviewsAgainstAssignmentRemoval(ctx)

    console.log('\nCandidate import transaction races:')
    await raceCandidateImportsAgainstSessionEnd(ctx)
    await raceCandidateImportsAgainstSessionDelete(ctx)

    console.log('\nDeliberation activity transaction races:')
    await raceActivityCreatesAgainstSessionLifecycle(ctx, 'vote', 'end', 'E')
    await raceActivityCreatesAgainstSessionLifecycle(ctx, 'vote', 'delete', 'F')
    await raceActivityCreatesAgainstSessionLifecycle(ctx, 'vote', 'remove-member', 'G')
    await raceActivityCreatesAgainstSessionLifecycle(ctx, 'vote', 'ban', 'H')
    await raceActivityCreatesAgainstSessionLifecycle(ctx, 'note', 'end', 'I')
    await raceActivityCreatesAgainstSessionLifecycle(ctx, 'note', 'delete', 'J')
    await raceActivityCreatesAgainstSessionLifecycle(ctx, 'note', 'remove-member', 'K')
    await raceActivityCreatesAgainstSessionLifecycle(ctx, 'note', 'ban', 'L')

    console.log('\nDeliberation activity hierarchy races:')
    for (const resource of ['vote', 'note']) {
      for (const operation of ['create', 'owner-delete', 'privileged-delete']) {
        for (const lifecycle of ['candidate-delete', 'round-end', 'round-delete', 'cycle-end', 'cycle-delete']) {
          await raceActivityAgainstHierarchyLifecycle(ctx, resource, operation, lifecycle)
        }
      }
    }

    console.log('\nCandidate decision transaction races:')
    await raceCandidatePatchesAgainstSessionLifecycle(ctx, 'end', 'M')
    await raceCandidatePatchesAgainstSessionLifecycle(ctx, 'delete', 'O')

    console.log('\nParent-child lifecycle races:')
    await raceRoundCreatesAgainstCycleLifecycle(ctx, 'end')
    await raceRoundCreatesAgainstCycleLifecycle(ctx, 'delete')
    await raceSessionCreatesAgainstRoundLifecycle(ctx, 'end', 'P', 'T')
    await raceSessionCreatesAgainstRoundLifecycle(ctx, 'delete', 'Q', 'U')
    await raceSessionReparentsAgainstTargetRoundLifecycle(ctx, 'end', 'V')
    await raceSessionReparentsAgainstTargetRoundLifecycle(ctx, 'delete', 'W')
    await raceAssignmentsAgainstRoundLifecycle(ctx, 'end')
    await raceAssignmentsAgainstRoundLifecycle(ctx, 'delete')
    await raceAssignmentsAgainstCycleDelete(ctx)
    await raceAssignmentsAgainstAuthorizedUserDelete(ctx)
    await raceMemberOrBanCreateAgainstSessionDelete(ctx, 'member', 'R')
    await raceMemberOrBanCreateAgainstSessionDelete(ctx, 'ban', 'S')
    await raceCoffeeImportsAgainstCycleDelete(ctx)
  } catch (error) {
    primaryError = error
  } finally {
    try {
      await teardown(ctx)
    } catch (teardownError) {
      if (primaryError) {
        console.error('TEARDOWN ERROR:', teardownError)
      } else {
        primaryError = teardownError
      }
    }
  }

  if (primaryError) throw primaryError
  console.log('\n✓ All unique-index, write-lifecycle, transaction-race, counter, and cascade assertions passed.')
}

main().catch(error => {
  console.error('FATAL:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
