#!/usr/bin/env node
/**
 * Destructive API load test for the deliberation tool.
 *
 * Safety requirements:
 *   - The target URL must be loopback-only.
 *   - ALLOW_DESTRUCTIVE_TESTS=1 must be set explicitly.
 *   - The server must be running with TEST_BYPASS_AUTH=1 against disposable data.
 *
 * Example:
 *   ALLOW_DESTRUCTIVE_TESTS=1 LOAD_TEST_BASE_URL=http://127.0.0.1:5173 \
 *     node scripts/loadtest.mjs
 */

import { performance } from 'node:perf_hooks'

function envInteger(name, fallback, min, max) {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`)
  }
  return value
}

function envNumber(name, fallback, min, max) {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}.`)
  }
  return value
}

function loopbackBase(raw) {
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`LOAD_TEST_BASE_URL is not a valid URL: ${raw}`)
  }
  const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
  if (!loopbackHosts.has(parsed.hostname.toLowerCase())) {
    throw new Error(`Refusing destructive load test against non-loopback host: ${parsed.hostname}`)
  }
  if (parsed.username || parsed.password) {
    throw new Error('LOAD_TEST_BASE_URL must not contain credentials.')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('LOAD_TEST_BASE_URL must use http or https.')
  }
  return parsed.toString().replace(/\/$/, '')
}

if (process.env.ALLOW_DESTRUCTIVE_TESTS !== '1') {
  throw new Error('Refusing to mutate data. Set ALLOW_DESTRUCTIVE_TESTS=1 for a disposable local test database.')
}

const BASE = loopbackBase(process.env.LOAD_TEST_BASE_URL ?? 'http://127.0.0.1:5173')
const N_USERS = envInteger('LOAD_TEST_USERS', 50, 1, 500)
const ACTIONS_PER_USER = envInteger('LOAD_TEST_ACTIONS_PER_USER', 200, 1, 10_000)
const N_CANDIDATES = envInteger('LOAD_TEST_CANDIDATES', 20, 1, 500)
const LEADERSHIP_FRACTION = envNumber('LOAD_TEST_LEADERSHIP_FRACTION', 0.2, 0, 1)
const REQUEST_TIMEOUT_MS = envInteger('LOAD_TEST_REQUEST_TIMEOUT_MS', 10_000, 100, 120_000)

// Defaults are deliberately generous enough for a local development server but
// strict enough that a script cannot print a visibly broken run and exit zero.
const MIN_SUCCESS_RATE = envNumber('LOAD_TEST_MIN_SUCCESS_RATE', 0.99, 0, 1)
const MAX_P95_MS = envNumber('LOAD_TEST_MAX_P95_MS', 2_000, 1, 120_000)
const MAX_P99_MS = envNumber('LOAD_TEST_MAX_P99_MS', 5_000, 1, 120_000)
const MIN_THROUGHPUT = envNumber('LOAD_TEST_MIN_THROUGHPUT', 10, 0, 100_000)

const ACTION_WEIGHTS = [
  ['vote', 50],
  ['unvote', 20],
  ['note', 20],
  ['statusPatch', 10],
]
// The deliberation UI exposes vouch/anti-vouch as vote toggles. Red flags are
// created through the candidate-note endpoint and are already represented by
// the note workload below.
const VOTE_TYPES = ['vouch', 'anti_vouch']
const ADMIN = { email: 'loadtest-admin@example.com', role: 'admin' }

function authHeaders(user) {
  return {
    'content-type': 'application/json',
    'x-test-email': user.email,
    'x-test-role': user.role,
  }
}

async function api(method, path, user, body) {
  const t0 = performance.now()
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: authHeaders(user),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const text = await res.text()
    let data
    if (text) {
      try { data = JSON.parse(text) } catch {}
    }
    return {
      ok: res.ok,
      status: res.status,
      data,
      ms: performance.now() - t0,
      errorBody: res.ok ? '' : text.slice(0, 300),
    }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      ms: performance.now() - t0,
      errorBody: error instanceof Error ? error.message : String(error),
    }
  }
}

async function preflight() {
  const unauthenticated = await fetch(`${BASE}/api/authorized-users`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (unauthenticated.status !== 401) {
    throw new Error(`Protected-route preflight expected 401 without test headers; got ${unauthenticated.status}.`)
  }

  const authenticated = await fetch(`${BASE}/api/authorized-users`, {
    headers: authHeaders(ADMIN),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (authenticated.status === 401) {
    throw new Error('Server is reachable but TEST_BYPASS_AUTH=1 is not active.')
  }
  if (!authenticated.ok) {
    throw new Error(`Authenticated preflight failed with status ${authenticated.status}.`)
  }
}

async function seed(ctx) {
  console.log('Seeding disposable test data via API...')
  const cycleRes = await api('POST', '/api/cycles', ADMIN, {
    name: `LoadTest-${Date.now()}`,
    status: 'active',
    accepting_applications: false,
  })
  if (!cycleRes.ok || !cycleRes.data?.id) {
    throw new Error(`cycle create failed: ${cycleRes.status} ${cycleRes.errorBody}`)
  }
  ctx.cycleId = cycleRes.data.id

  const roundRes = await api('POST', '/api/rounds', ADMIN, {
    cycle_id: ctx.cycleId,
    name: 'LoadTest Round',
    grading_type: null,
    order_index: 1,
    status: 'deliberating',
    role: null,
  })
  if (!roundRes.ok || !roundRes.data?.id) {
    throw new Error(`round create failed: ${roundRes.status} ${roundRes.errorBody}`)
  }
  ctx.roundId = roundRes.data.id

  ctx.sessionId = Math.random().toString(36).slice(2, 8).toUpperCase().padEnd(6, '0')
  const sessionRes = await api('POST', '/api/sessions', ADMIN, {
    id: ctx.sessionId,
    round_id: ctx.roundId,
    name: 'LoadTest Deliberation',
    anonymous: false,
    role: null,
  })
  if (!sessionRes.ok) {
    throw new Error(`session create failed: ${sessionRes.status} ${sessionRes.errorBody}`)
  }

  ctx.users = Array.from({ length: N_USERS }, (_, index) => {
    if (index === 0) return ADMIN
    return {
      email: `loaduser${index}@example.com`,
      role: index / N_USERS < LEADERSHIP_FRACTION ? 'leadership' : 'grader',
    }
  })

  for (const user of ctx.users) {
    const result = await api('POST', '/api/session-members', user, {
      session_id: ctx.sessionId,
      user_email: user.email,
    })
    if (!result.ok) {
      throw new Error(`session-member join failed for ${user.email}: ${result.status} ${result.errorBody}`)
    }
  }

  const candidates = Array.from({ length: N_CANDIDATES }, (_, index) => ({
    name: `Candidate ${index + 1}`,
    status: 'pending',
    data: { score: Math.random() * 100, candidate_number: index + 1 },
  }))
  const candidateRes = await api('POST', `/api/sessions/${ctx.sessionId}/candidates`, ADMIN, candidates)
  if (!candidateRes.ok || !Array.isArray(candidateRes.data)) {
    throw new Error(`candidate insert failed: ${candidateRes.status} ${candidateRes.errorBody}`)
  }
  ctx.candidateIds = candidateRes.data.map(candidate => candidate.id)
  if (ctx.candidateIds.length !== N_CANDIDATES || ctx.candidateIds.some(id => !id)) {
    throw new Error(`candidate insert returned ${ctx.candidateIds.length}; expected ${N_CANDIDATES}.`)
  }
}

function pickWeighted(weights) {
  const total = weights.reduce((sum, [, weight]) => sum + weight, 0)
  let remaining = Math.random() * total
  for (const [name, weight] of weights) {
    remaining -= weight
    if (remaining <= 0) return name
  }
  return weights[0][0]
}

function pick(values) {
  return values[Math.floor(Math.random() * values.length)]
}

function record(metrics, action, result, elapsedMs) {
  const bucket = metrics[action] ?? (metrics[action] = {
    count: 0,
    ok: 0,
    latencies: [],
    errors: {},
    sampleErrors: [],
  })
  bucket.count += 1
  bucket.latencies.push(elapsedMs)
  if (result?.ok) {
    bucket.ok += 1
    return
  }
  const status = String(result?.status ?? 0)
  bucket.errors[status] = (bucket.errors[status] ?? 0) + 1
  if (bucket.sampleErrors.length < 3 && result?.errorBody) {
    bucket.sampleErrors.push(`${status}: ${result.errorBody}`)
  }
}

async function runWorker(user, ctx, metrics) {
  // Match the real deliberation UI: it caches each POST response's vote id
  // and sends that id directly when toggling the vote off. Measuring an extra
  // GET here would turn "unvote latency" into a synthetic read+delete bundle
  // that the browser never performs to discover the id.
  const ownVotes = new Map()

  for (let index = 0; index < ACTIONS_PER_USER; index += 1) {
    let action = pickWeighted(ACTION_WEIGHTS)
    let candidateId = pick(ctx.candidateIds)

    // Decision writes intentionally require the session creator or an admin.
    if (action === 'statusPatch' && user.email !== ADMIN.email) action = 'note'

    const ownedEntries = [...ownVotes.entries()].filter(([, voteTypes]) => voteTypes.size > 0)
    if (action === 'unvote' && ownedEntries.length === 0) action = 'vote'

    if (action === 'unvote') {
      ;[candidateId] = pick(ownedEntries)
    }

    let ownedForCandidate = ownVotes.get(candidateId)
    if (!ownedForCandidate) {
      ownedForCandidate = new Map()
      ownVotes.set(candidateId, ownedForCandidate)
    }

    let availableVoteTypes = VOTE_TYPES.filter(voteType => !ownedForCandidate.has(voteType))
    if (action === 'vote' && availableVoteTypes.length === 0) action = 'unvote'

    const startedAt = performance.now()
    let result

    if (action === 'vote') {
      availableVoteTypes = VOTE_TYPES.filter(voteType => !ownedForCandidate.has(voteType))
      const voteType = pick(availableVoteTypes)
      result = await api('POST', '/api/votes', user, {
        candidate_id: candidateId,
        voter_name: user.email,
        vote_type: voteType,
      })
      if (result.ok && typeof result.data?.id === 'string') {
        ownedForCandidate.set(voteType, result.data.id)
      } else if (result.ok) {
        result = {
          ...result,
          ok: false,
          status: 502,
          errorBody: 'Vote creation did not return the vote id required by the UI contract.',
        }
      }
    } else if (action === 'unvote') {
      const [voteType, voteId] = pick([...ownedForCandidate.entries()])
      result = await api('DELETE', '/api/votes', user, { id: voteId })
      if (result.ok) ownedForCandidate.delete(voteType)
    } else if (action === 'note') {
      result = await api('POST', '/api/candidate-notes', user, {
        candidate_id: candidateId,
        author: user.email,
        content: `Note from ${user.email} at ${Date.now()}: ${Math.random().toString(36).slice(2)}`,
        type: Math.random() < 0.9 ? 'note' : 'red_flag',
      })
    } else if (action === 'statusPatch') {
      result = await api('PATCH', `/api/candidates/${candidateId}`, user, {
        status: pick(['pending', 'accepted', 'rejected', 'hold']),
      })
    }

    record(metrics, action, result, performance.now() - startedAt)
  }
}

function percentile(values, fraction) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]
}

function reportAndAssert(metrics, elapsedSeconds) {
  console.log('\n=================== RESULTS ====================')
  console.log(`Target:               ${BASE}`)
  console.log(`Total elapsed:        ${elapsedSeconds.toFixed(1)}s`)

  let totalRequests = 0
  let totalSuccessful = 0
  const allLatencies = []
  let transportOrServerErrors = 0

  for (const metric of Object.values(metrics)) {
    totalRequests += metric.count
    totalSuccessful += metric.ok
    allLatencies.push(...metric.latencies)
    transportOrServerErrors += Object.entries(metric.errors)
      .filter(([status]) => status === '0' || Number(status) >= 500)
      .reduce((sum, [, count]) => sum + count, 0)
  }

  const successRate = totalRequests === 0 ? 0 : totalSuccessful / totalRequests
  const throughput = totalRequests / Math.max(elapsedSeconds, 0.001)
  const p95 = percentile(allLatencies, 0.95)
  const p99 = percentile(allLatencies, 0.99)

  console.log(`Total actions:        ${totalRequests}`)
  console.log(`Success rate:         ${(successRate * 100).toFixed(2)}%`)
  console.log(`Throughput:           ${throughput.toFixed(1)} actions/s`)
  console.log(`Overall p95 / p99:    ${p95.toFixed(0)}ms / ${p99.toFixed(0)}ms`)
  console.log('\nPer-action breakdown:')

  for (const [action, metric] of Object.entries(metrics)) {
    const failurePercent = (1 - metric.ok / metric.count) * 100
    console.log(
      `  ${action.padEnd(13)} n=${String(metric.count).padEnd(6)} ok=${metric.ok}`
      + ` fail=${failurePercent.toFixed(1)}% p50=${percentile(metric.latencies, 0.5).toFixed(0)}ms`
      + ` p95=${percentile(metric.latencies, 0.95).toFixed(0)}ms`
      + ` p99=${percentile(metric.latencies, 0.99).toFixed(0)}ms`,
    )
    if (Object.keys(metric.errors).length > 0) {
      console.log(`     errors: ${Object.entries(metric.errors).map(([status, count]) => `${status}=${count}`).join(', ')}`)
      for (const sample of metric.sampleErrors) console.log(`       sample: ${sample}`)
    }
  }
  console.log('===============================================\n')

  const violations = []
  const expectedActions = N_USERS * ACTIONS_PER_USER
  if (totalRequests !== expectedActions) violations.push(`recorded ${totalRequests} actions; expected ${expectedActions}`)
  if (successRate < MIN_SUCCESS_RATE) violations.push(`success rate ${successRate.toFixed(4)} < ${MIN_SUCCESS_RATE}`)
  if (p95 > MAX_P95_MS) violations.push(`p95 ${p95.toFixed(0)}ms > ${MAX_P95_MS}ms`)
  if (p99 > MAX_P99_MS) violations.push(`p99 ${p99.toFixed(0)}ms > ${MAX_P99_MS}ms`)
  if (throughput < MIN_THROUGHPUT) violations.push(`throughput ${throughput.toFixed(1)} < ${MIN_THROUGHPUT} actions/s`)
  if (transportOrServerErrors > 0) violations.push(`${transportOrServerErrors} transport/5xx errors observed`)

  if (violations.length > 0) {
    throw new Error(`Load-test gate failed:\n- ${violations.join('\n- ')}`)
  }
}

async function teardown(ctx) {
  if (!ctx.cycleId) return
  console.log('Tearing down disposable test data...')
  const result = await api('DELETE', `/api/cycles/${ctx.cycleId}`, ADMIN)
  if (!result.ok && result.status !== 404) {
    throw new Error(`cycle teardown failed: ${result.status} ${result.errorBody}`)
  }
}

async function main() {
  const ctx = {}
  let primaryError
  try {
    await preflight()
    await seed(ctx)
    console.log(`✓ Seeded session ${ctx.sessionId} with ${ctx.candidateIds.length} candidates and ${ctx.users.length} members`)
    console.log(`Spawning ${N_USERS} concurrent users × ${ACTIONS_PER_USER} actions...`)

    const metrics = {}
    const startedAt = performance.now()
    await Promise.all(ctx.users.map(user => runWorker(user, ctx, metrics)))
    reportAndAssert(metrics, (performance.now() - startedAt) / 1000)
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
  console.log('✓ Load-test thresholds passed.')
}

main().catch(error => {
  console.error('FATAL:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
