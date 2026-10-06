import assert from 'node:assert/strict'
import { cp, mkdtemp, rm, symlink, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { createInterface } from 'node:readline'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
// Isolated app copy + disposable MongoDB. Never uses the developer's .env or database.
const directory = await mkdtemp(join(tmpdir(), 'ps-http-test-'))
let repl, child
try {
  for (const name of ['src', 'public', 'package.json', 'package-lock.json', 'tsconfig.json', 'next.config.ts', 'postcss.config.mjs']) await cp(resolve(name), join(directory, name), { recursive: true })
  const apiPath = join(directory, 'src/lib/ps/api.ts')
  const apiSource = await readFile(apiPath, 'utf8')
  await writeFile(apiPath, apiSource.replace("console.error('PS workflow request failed', error instanceof Error ? error.name : 'UnknownError')", "console.error('PS isolated HTTP test error', error)"))
  // Fault injection exists only in this disposable copy, never in application code.
  const faultPath = join(directory, 'database-failure.flag')
  const dbPath = join(directory, 'src/lib/mongodb.ts')
  const dbSource = await readFile(dbPath, 'utf8')
  await writeFile(dbPath, "import { existsSync } from 'node:fs'\n" + dbSource.replace('export async function connectDB() {', `export async function connectDB() {\n  if (existsSync(${JSON.stringify(faultPath)})) throw new mongoose.Error.MongooseServerSelectionError('Disposable connection failure')`))
  await symlink(resolve('node_modules'), join(directory, 'node_modules'), 'dir')
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  const uri = repl.getUri('ps_http_tests')
  await mongoose.connect(uri)
  const cycleId = new mongoose.Types.ObjectId(), applicantIds = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()]
  await mongoose.connection.collection('recruitmentcycles').insertOne({ _id: cycleId, name: 'HTTP test', status: 'active', configuration_version: 0, lifecycle_write_count: 0 })
  const emails = ['one@example.test', 'two@example.test', 'three@example.test']
  await mongoose.connection.collection('authorizedusers').insertMany(emails.map(email => ({ email, role: 'grader', assignment_write_count: 0 })))
  await mongoose.connection.collection('applicants').insertMany(applicantIds.map((id, i) => ({ _id: id, cycle_id: cycleId, first_name: `Test ${i}`, last_name: 'Applicant', email: `test${i}@example.test` })))
  const socket = createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve)); const port = socket.address().port; await new Promise(resolve => socket.close(resolve))
  const base = `http://localhost:${port}`
  child = spawn(process.execPath, [resolve('node_modules/next/dist/bin/next'), 'dev', '--webpack', '--port', String(port)], { cwd: directory, env: { ...process.env, NODE_ENV: 'development', MONGODB_URI: uri, TEST_BYPASS_AUTH: '1', DEV_LOGIN: '1', NEXTAUTH_URL: base, NEXTAUTH_SECRET: 'disposable-local-test-only' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', chunk => { output = (output + chunk).slice(-6000) }); child.stderr.on('data', chunk => { output = (output + chunk).slice(-6000) })
  for (let i = 0; !output.includes('Ready in'); i++) { if (i > 180 || child.exitCode !== null) throw new Error('Disposable Next server failed to become ready.'); await new Promise(resolve => setTimeout(resolve, 250)) }
  async function call(path, { method = 'GET', body, role = 'admin', email = 'lead@example.test', status = 200 } = {}) {
    const response = await fetch(base + path, { method, signal: AbortSignal.timeout(60000), headers: { ...(role ? { 'x-test-role': role, 'x-test-email': email } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json', origin: base } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
    const data = await response.json().catch(() => null)
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}${response.status >= 500 ? '\n' + output : ''}`)
    assert.ok(data !== null, 'Every API response must be JSON')
    assert.match(response.headers.get('Content-Type') ?? '', /^application\/json/)
    assert.equal(response.redirected, false, 'API authorization must not redirect to HTML')
    return data
  }
  await call('/api/sessions', { role: null, status: 401 })
  assert.deepEqual(await call('/api/sessions'), [])
  const session = await call('/api/sessions', { method: 'POST', status: 201, body: { id: 'TEST01', name: 'HTTP session fixture' } })
  assert.equal(session.id, 'TEST01')
  assert.equal((await call('/api/sessions'))[0].id, 'TEST01')
  assert.deepEqual(await call('/api/sessions', { role: 'grader', email: emails[0] }), [], 'unjoined graders still cannot list another creator session')
  await call('/api/sessions?round_id=invalid', { status: 400 })
  await call('/api/sessions', { method: 'POST', role: 'grader', body: { id: 'TEST02', name: 'Forbidden' }, status: 403 })
  await writeFile(faultPath, 'unavailable')
  const unavailable = await call('/api/sessions', { status: 503 })
  assert.match(unavailable.error, /database connection is unavailable/)
  await call('/api/sessions', { method: 'POST', body: { id: 'TEST02', name: 'Failure must not create a session' }, status: 503 })
  await rm(faultPath)
  assert.equal((await call('/api/sessions')).length, 1, 'failure responses preserve sessions and recovery does not require a cache reset')
  await call('/api/ps/graders', { role: null, status: 401 })
  assert.equal((await call('/api/ps/graders')).length, 3)
  await call(`/api/ps/cycles/${cycleId}/rounds`, { method: 'POST', role: 'grader', status: 403, body: {} })
  const standardCycle = new mongoose.Types.ObjectId()
  await mongoose.connection.collection('recruitmentcycles').insertOne({ _id: standardCycle, name: 'HTTP standard rounds', status: 'active', configuration_version: 0, lifecycle_write_count: 0 })
  await call(`/api/ps/cycles/${standardCycle}/rounds`, { method: 'POST', role: 'grader', status: 403, body: { template: 'ps_standard', eligible_grader_emails: emails, reviews_required: 2 } })
  const standard = await call(`/api/ps/cycles/${standardCycle}/rounds`, { method: 'POST', status: 201, body: { template: 'ps_standard', eligible_grader_emails: emails, reviews_required: 2 } })
  assert.deepEqual(standard.map(r => r.name), ['Written App / Resume Screening', 'PD Design Interview', 'Final Round: Take-home + Social'])
  const standardDrafts = await call(`/api/ps/rounds/${standard[1].id}/rubric-drafts`)
  assert.equal(standardDrafts.length, 1); assert.equal(standardDrafts[0].scoring_policy, 'points_v1')
  await call(`/api/ps/cycles/${standardCycle}/rounds`, { method: 'POST', status: 409, body: { template: 'ps_standard', eligible_grader_emails: emails, reviews_required: 2 } })
  const config ={ name: 'Screening', evaluation_type: 'rubric', reviews_required: 2, eligible_grader_emails: emails }
  const first = await call(`/api/ps/cycles/${cycleId}/rounds`, { method: 'POST', body: config, status: 201 })
  const last = await call(`/api/ps/cycles/${cycleId}/rounds`, { method: 'POST', body: { ...config, name: 'Final configured round', evaluation_type: 'submission_rubric' }, status: 201 })
  await call(`/api/ps/cycles/${cycleId}/rounds`, { method: 'PATCH', body: { configuration_version: 0, round_ids: [first.id, last.id] } })
  const setup = await call(`/api/ps/cycles/${cycleId}/rounds`)
  assert.ok(setup.rounds.every(round => !round.configuration_locked && !round.rubric_locked))
  for (const changes of [{ order_index: 999 }, { scoring_engine: 'plex' }, { workflow: 'legacy' }, { rubric_version_id: new mongoose.Types.ObjectId().toString() }]) {
    await call(`/api/ps/rounds/${first.id}`, { method: 'PATCH', status: 400, body: { configuration_version: setup.rounds[0].configuration_version, ...changes } })
  }
  await call(`/api/ps/rounds/${first.id}`, { method: 'PATCH', status: 400, body: { name: 'Missing version' } })
  await call(`/api/rounds/${first.id}`, { method: 'PATCH', body: { name: 'Bypass' }, status: 409 })
  const preview = await call(`/api/ps/rounds/${first.id}/assignments`)
  assert.equal(preview.total, 4)
  await call(`/api/ps/rounds/${first.id}/assignments`, { method: 'POST', body: { preview_token: preview.preview_token } })
  const unconfigured = await call('/api/ps/grading', { role: 'grader', email: emails[0] })
  assert.equal(unconfigured.rubrics.length, 0)
  const round = await call(`/api/ps/rounds/${first.id}`)
  assert.equal(round.configuration_locked, true)
  assert.equal(round.rubric_locked, false)
  const rubric = await call(`/api/ps/rounds/${first.id}/rubrics`, { method: 'POST', status: 201, body: { configuration_version: round.configuration_version, name: 'Provided rubric', criteria: [{ id: 'a', name: 'Team criterion', description: '', scale: { min: 0, max: 5, step: 0.5 }, options: [] }, { id: 'b', name: 'Team options', description: '', scale: null, options: [{ value: 10, label: 'Option supplied by team' }] }] } })
  const queue = await call('/api/ps/grading', { role: 'grader', email: emails[0] })
  assert.equal(queue.rubrics[0].id, rubric.id)
  assert.equal(queue.rounds[0].cycle_name, 'HTTP test')
  assert.deepEqual(queue.progress, [{ round_id: first.id, total: queue.assignments.length, completed: 0, pending: queue.assignments.length }])
  const own = queue.assignments[0]
  const reviewBody = { round_id: first.id, applicant_id: own.applicant_id, rubric_version_id: rubric.id, ratings: [{ criterion_id: 'a', raw_score: 3.5 }, { criterion_id: 'b', raw_score: 10 }], comments: 'Raw comments' }
  await call('/api/ps/reviews', { method: 'POST', role: 'grader', email: emails[0], body: { ...reviewBody, ratings: [{ criterion_id: 'bad', raw_score: 3.5 }, reviewBody.ratings[1]] }, status: 400 })
  const stored = await call('/api/ps/reviews', { method: 'POST', role: 'grader', email: emails[0], body: reviewBody, status: 201 })
  assert.equal(stored.ratings[0].raw_score, 3.5)
  const afterReview = await call('/api/ps/grading', { role: 'grader', email: emails[0] })
  assert.equal(afterReview.progress[0].completed, 1)
  assert.equal(afterReview.progress[0].total, queue.assignments.length)
  assert.equal(afterReview.progress[0].pending, queue.assignments.length - 1)
  assert.ok(afterReview.assignments.every(assignment => assignment.id !== own.id))
  const enrollmentAfterReview = await call(`/api/ps/rounds/${first.id}/enrollments`)
  assert.equal(enrollmentAfterReview.reviews_required, 2)
  const reviewedEnrollment = enrollmentAfterReview.enrollments.find(row => row.applicant_id === own.applicant_id)
  assert.equal(reviewedEnrollment.completed_reviews, 1)
  assert.equal(reviewedEnrollment.state, 'in_review', 'one of two reviews cannot mark the candidate complete or advance them')
  assert.equal((await call(`/api/ps/rounds/${last.id}/enrollments`)).enrollments.length, 0, 'saving a review never creates a next-round enrollment')
  assert.equal((await call(`/api/ps/rounds/${first.id}`)).rubric_locked, true)
  await call('/api/ps/reviews', { method: 'POST', role: 'grader', email: emails[0], body: reviewBody, status: 409 })
  await call('/api/reviews', { method: 'POST', role: 'grader', email: emails[0], body: reviewBody, status: 409 })
  await call(`/api/admin/grading-stats?round_id=${first.id}`, { status: 409 })
  const scores = await call(`/api/ps/rounds/${first.id}/scores`)
  assert.ok(scores.scores.every(score => score.status === 'unconfigured' && score.score === null))
  await call(`/api/rounds/${first.id}`, { method: 'DELETE', status: 409 })
  await call(`/api/cycles/${cycleId}`, { method: 'DELETE', status: 409 })
  await call(`/api/ps/rounds/${first.id}/enrollments`, { method: 'POST', body: { action: 'advance', applicant_id: own.applicant_id } })
  await call(`/api/ps/rounds/${first.id}/enrollments`, { method: 'POST', body: { action: 'advance', applicant_id: own.applicant_id } })
  assert.equal((await call(`/api/ps/rounds/${last.id}/enrollments`)).enrollments.length, 1)
  await call(`/api/ps/rounds/${last.id}/enrollments`, { method: 'POST', body: { action: 'advance', applicant_id: own.applicant_id }, status: 409 })
  // Regression: queue filters round-level eligibility even with a historical assignment.
  await mongoose.connection.collection('rounds').updateOne({ _id: new mongoose.Types.ObjectId(first.id) }, { $set: { eligible_grader_emails: emails.slice(1) } })
  const ineligible = await call('/api/ps/grading', { role: 'grader', email: emails[0] })
  assert.equal(ineligible.assignments.length, 0)
  assert.equal(ineligible.rounds.length, 0)
  await mongoose.connection.collection('rounds').updateOne({ _id: new mongoose.Types.ObjectId(first.id) }, { $set: { eligible_grader_emails: emails } })
  const activePreview = await call(`/api/ps/rounds/${first.id}/assignments`)
  await mongoose.connection.collection('rounds').updateOne({ _id: new mongoose.Types.ObjectId(first.id) }, { $set: { status: 'deliberating' } })
  await call(`/api/ps/rounds/${first.id}/assignments`, { status: 409 })
  await call(`/api/ps/rounds/${first.id}/assignments`, { method: 'POST', body: { preview_token: activePreview.preview_token }, status: 409 })
  await mongoose.connection.collection('rounds').updateOne({ _id: new mongoose.Types.ObjectId(first.id) }, { $set: { status: 'grading' } })
  await mongoose.connection.collection('recruitmentcycles').updateOne({ _id: cycleId }, { $set: { status: 'ended' } })
  const closed = await call('/api/ps/grading', { role: 'grader', email: emails[0] })
  assert.equal(closed.rounds.length, 0)
  assert.equal(closed.assignments.length, 0)
  await call(`/api/ps/rounds/${first.id}/assignments`, { status: 409 })
  await call(`/api/ps/rounds/${first.id}/assignments`, { method: 'POST', body: { preview_token: activePreview.preview_token }, status: 409 })
  await call('/api/ps/reviews', { method: 'POST', role: 'grader', email: emails[0], body: reviewBody, status: 409 })
  const historical = await call(`/api/ps/reviews?round_id=${first.id}`)
  assert.equal(historical[0].ratings[0].raw_score, 3.5)
  assert.equal((await call(`/api/ps/rounds/${last.id}/enrollments`)).enrollments.length, 1)
  const v2cycle = new mongoose.Types.ObjectId()
  await mongoose.connection.collection('recruitmentcycles').insertOne({ _id: v2cycle, name: 'V2 HTTP', status: 'active', configuration_version: 0, lifecycle_write_count: 0 })
  await mongoose.connection.collection('applicants').insertOne({ cycle_id: v2cycle, first_name: 'Typed', last_name: 'HTTP', email: 'typed-http@example.test' })
  const v2round = await call(`/api/ps/cycles/${v2cycle}/rounds`, { method: 'POST', status: 201, body: { ...config, name: 'Typed HTTP round', reviews_required: 1 } })
  const url = `/api/ps/rounds/${v2round.id}`
  await call(url + '/rubric-drafts', { role: 'grader', status: 403 })
  await call(url + '/rubric-imports', { method: 'POST', role: 'grader', status: 403, body: {} })
  await call(url + '/rubric-imports', { method: 'POST', status: 415, body: {} })
  async function upload(payload, fileName, status = 200, headers = {}) {
    const form = new FormData(); form.set('file', new Blob([payload]), fileName)
    const response = await fetch(base + url + '/rubric-imports', { method: 'POST', headers: { 'x-test-role': 'admin', 'x-test-email': 'lead@example.test', origin: base, ...headers }, body: form })
    const data = await response.json(); assert.equal(response.status, status, JSON.stringify(data)); assert.match(response.headers.get('content-type'), /application\/json/); return data
  }
  const previewImport = await upload('Timestamp,Applicant Name,Numeric,Red Flag notes\n2026,PRIVATE PERSON,0,PRIVATE RESPONSE\n2026,OTHER PERSON,3,OTHER RESPONSE', 'example.csv')
  assert.ok(!JSON.stringify(previewImport).includes('PRIVATE'))
  assert.equal(await mongoose.connection.collection('rubricdrafts').countDocuments({ round_id: new mongoose.Types.ObjectId(v2round.id) }), 0, 'parsing never persists a draft or preview')
  assert.equal(await mongoose.connection.collection('genericreviews').countDocuments({ round_id: new mongoose.Types.ObjectId(v2round.id) }), 0, 'historical responses never become reviews')
  await upload('abc', 'bad.pdf', 415)
  await upload('abc', 'test.csv', 403, { origin: 'https://other.example.test' })
  await upload('abc', 'test.csv', 403, { 'sec-fetch-site': 'cross-site' })
  let draft = await call(url + '/rubric-drafts', { method: 'POST', status: 201, body: { structure: previewImport.structure, provenance: previewImport.provenance } })
  const draftPath = `/api/ps/rubric-drafts/${draft.id}`
  await call(draftPath + '/publish', { method: 'POST', status: 400, body: { revision: 0, configuration_version: v2round.configuration_version } })
  await call(draftPath, { method: 'PATCH', role: 'grader', status: 403, body: {} })
  const structure = { ...draft, questions: draft.questions.map((q, i) => ({ ...q, purpose: i ? 'RED_FLAG' : 'SCORED_CRITERION', format: i ? 'boolean' : 'number', scale: i ? null : { min: 0, max: 3, step: 1 }, required: true, confirmed: true })), weighting: 'configured', categories: draft.categories.map(c => ({ ...c, weight_bps: 10000 })) }
  draft = await call(draftPath, { method: 'PATCH', body: { revision: 0, structure } })
  await call(draftPath, { method: 'PATCH', status: 409, body: { revision: 0, structure } })
  assert.equal((await call(draftPath)).revision, 1)
  const published = await call(draftPath + '/publish', { method: 'POST', status: 201, body: { revision: 1, configuration_version: v2round.configuration_version } })
  assert.equal((await call(draftPath + '/publish', { method: 'POST', status: 201, body: { revision: 1, configuration_version: v2round.configuration_version } })).id, published.id)
  await call(draftPath, { method: 'PATCH', status: 409, body: { revision: 2, structure } })
  const manualRound = await call(`/api/ps/cycles/${v2cycle}/rounds`, { method: 'POST', status: 201, body: { ...config, name: 'Manual form', reviews_required: 1 } })
  const manualStructure = { schema_version: 2, name: 'Manual PD rubric', weighting: 'unconfigured', categories: [{ id: 'instructions', name: 'Instructions', kind: 'instructions', description: 'Before the interview\n\n- Create notes\n- Review applicant details', order: 0, weight_bps: null }], questions: [] }
  let manual = await call(`/api/ps/rounds/${manualRound.id}/rubric-drafts`, { method: 'POST', status: 201, body: { structure: manualStructure } })
  const manualPath = `/api/ps/rubric-drafts/${manual.id}`
  assert.equal((await call(manualPath)).categories[0].description, manualStructure.categories[0].description)
  await call(manualPath + '/publish', { method: 'POST', status: 400, body: { revision: 0, configuration_version: manualRound.configuration_version } })
  const withScoring = { ...manualStructure, weighting: 'configured', categories: [...manualStructure.categories, { id: 'scoring', name: 'Product Design Scoring', kind: 'scoring', description: '0–3 scale explanation', order: 1, weight_bps: 8500 }], questions: [{ id: 'pd', category_id: 'scoring', label: 'OVERALL: easy to follow response', description: '', order: 0, purpose: 'SCORED_CRITERION', format: 'number', required: true, confirmed: true, scale: { min: 0, max: 3, step: 1 }, options: [] }] }
  manual = await call(manualPath, { method: 'PATCH', body: { revision: 0, structure: withScoring } })
  await call(manualPath + '/publish', { method: 'POST', status: 400, body: { revision: 1, configuration_version: manualRound.configuration_version } })
  withScoring.categories[1].weight_bps = 10000
  manual = await call(manualPath, { method: 'PATCH', body: { revision: 1, structure: withScoring } })
  const manualVersion = await call(manualPath + '/publish', { method: 'POST', status: 201, body: { revision: 2, configuration_version: manualRound.configuration_version } })
  assert.equal(manualVersion.categories[0].kind, 'instructions')
  assert.equal(manualVersion.categories[0].description, manualStructure.categories[0].description)
  assert.equal(manualVersion.categories[1].weight_bps, 10000)
  assert.equal(manualVersion.categories[0].weight_bps, null)
  console.log('Manual form HTTP instructions-only drafts, saved section content, inline weights and immutable publication checks passed.')
  const assignmentsPreview = await call(url + '/assignments')
  await call(url + '/assignments', { method: 'POST', body: { preview_token: assignmentsPreview.preview_token } })
  const pair2 = await mongoose.connection.collection('graderassignments').findOne({ round_id: new mongoose.Types.ObjectId(v2round.id) })
  const typedQueue = await call('/api/ps/grading', { role: 'grader', email: pair2.grader_email })
  assert.equal(typedQueue.rubrics.find(r => r.id === published.id).schema_version, 2)
  const typedBody = { schema_version: 2, round_id: v2round.id, applicant_id: String(pair2.applicant_id), rubric_version_id: published.id, comments: ' raw ', responses: [{ question_id: draft.questions[0].id, format: 'number', value: 0 }, { question_id: draft.questions[1].id, format: 'boolean', value: false }] }
  const typedReview = await call('/api/ps/reviews', { method: 'POST', role: 'grader', email: pair2.grader_email, status: 201, body: typedBody })
  assert.deepEqual(typedReview.responses.map(r => r.value), [0, false])
  assert.equal(typedReview.comments, ' raw ')
  assert.equal((await call(url + '/enrollments')).enrollments[0].state, 'ready_for_deliberation')
  assert.equal((await call(url + '/scores')).scores[0].score, null)
  console.log('V2 HTTP upload privacy/no persistence, auth, draft revision/publication, typed raw grading and evidence/scoring boundaries passed.')
  {
    const wc = new mongoose.Types.ObjectId(), wa = new mongoose.Types.ObjectId()
    await mongoose.connection.collection('recruitmentcycles').insertOne({ _id: wc, name: 'Weighted HTTP', status: 'active', configuration_version: 0 })
    await mongoose.connection.collection('applicants').insertOne({ _id: wa, cycle_id: wc, first_name: 'Weighted', last_name: 'Candidate', email: 'weighted@example.test' })
    const wr = await call(`/api/ps/cycles/${wc}/rounds`, { method: 'POST', status: 201, body: { ...config, name: 'Weighted HTTP round', reviews_required: 1 } })
    const wurl = `/api/ps/rounds/${wr.id}`
    const json = { title: 'Imported weighted', description: 'Form description', sections: [{ id: 's', title: 'Section', instructions: 'Read the application.', questions: [{ id: 'q', title: 'Quality', description: 'Explain quality', type: 'scale', min: 0, max: 3, low: 'Low', high: 'High', required: true, weight: 100 }] }] }
    for (const role of [null, 'grader', 'leadership']) {
      await call(wurl + '/rubric-json', { method: 'POST', role, body: json, status: role === null ? 401 : 403 })
      await call(wurl + '/rubric-drafts', { method: 'POST', role, body: {}, status: role === null ? 401 : 403 })
      await call(wurl + '/rubrics', { method: 'POST', role, body: {}, status: role === null ? 401 : 403 })
    }
    const preview = await call(wurl + '/rubric-json', { method: 'POST', body: json })
    assert.equal(preview.weights.total, 10000)
    assert.equal(await mongoose.connection.collection('rubricdrafts').countDocuments({ round_id: new mongoose.Types.ObjectId(wr.id) }), 0)
    const incompleteJSON = structuredClone(json); delete incompleteJSON.sections[0].questions[0].weight
    assert.equal((await call(wurl + '/rubric-json', { method: 'POST', body: incompleteJSON })).weights.missing, 1)
    const d = await call(wurl + '/rubric-drafts', { method: 'POST', status: 201, body: { structure: preview.structure } })
    const dp = `/api/ps/rubric-drafts/${d.id}`
    await call(wurl + '/rubric-json', { method: 'POST', status: 400, body: { ...json, sections: [{ ...json.sections[0], questions: [{ ...json.sections[0].questions[0], max: 0 }] }] } })
    assert.equal((await call(dp)).revision, 0, 'invalid import leaves persisted draft unchanged')
    for (const role of ['grader', 'leadership']) {
      await call(dp, { method: 'PATCH', role, body: {}, status: 403 })
      await call(dp + '/publish', { method: 'POST', role, body: {}, status: 403 })
    }
    const v = await call(dp + '/publish', { method: 'POST', status: 201, body: { revision: 0, configuration_version: wr.configuration_version } })
    assert.equal(v.scoring_policy, 'question_weighted_0_3')
    const ap = await call(wurl + '/assignments'); await call(wurl + '/assignments', { method: 'POST', body: { preview_token: ap.preview_token } })
    const pair = await mongoose.connection.collection('graderassignments').findOne({ round_id: new mongoose.Types.ObjectId(wr.id) })
    const body = { schema_version: 2, round_id: wr.id, applicant_id: String(wa), rubric_version_id: v.id, revision: 0, comments: 'Original', responses: [{ question_id: 'q', format: 'number', value: 0 }], score: 100 }
    await call('/api/ps/reviews', { method: 'POST', role: 'grader', email: 'unassigned@example.test', body, status: 403 })
    await call('/api/ps/reviews', { method: 'POST', role: 'grader', email: pair.grader_email, body: { ...body, responses: [] }, status: 400 })
    const first = await call('/api/ps/reviews', { method: 'POST', role: 'grader', email: pair.grader_email, body, status: 201 })
    assert.equal(first.score, 0)
    const second = await call('/api/ps/reviews', { method: 'POST', role: 'grader', email: pair.grader_email, body: { ...body, revision: 1, responses: [{ question_id: 'q', format: 'number', value: 3 }] }, status: 201 })
    assert.equal(second.score, 3)
    await call('/api/ps/reviews', { method: 'POST', role: 'grader', email: pair.grader_email, body, status: 409 })
    const queue = await call('/api/ps/grading', { role: 'grader', email: pair.grader_email })
    assert.equal(queue.progress.find(r => r.round_id === wr.id).completed, 1)
    assert.equal(queue.evaluations.filter(e => e.round_id === wr.id).length, 1)
    assert.equal(queue.evaluations.find(e => e.round_id === wr.id).revision, 2)
    assert.ok(!queue.assignments.some(a => a.round_id === wr.id))
    const history = await call(`/api/ps/reviews?round_id=${wr.id}`)
    assert.equal(history.length, 2); assert.equal(history.filter(r => r.is_current).length, 1)
    assert.equal((await call(wurl + '/enrollments')).enrollments[0].completed_reviews, 1)
    const scores = await call(wurl + '/scores')
    assert.deepEqual(scores.version_scores.map(s => [s.score, s.reviewer_count]), [[3, 1]])
    const newDraft = await call(wurl + '/rubric-drafts', { method: 'POST', status: 201, body: { structure: { ...preview.structure, description: 'Changed draft' } } })
    const newVersion = await call(`/api/ps/rubric-drafts/${newDraft.id}/publish`, { method: 'POST', status: 201, body: { revision: 0, configuration_version: (await call(wurl)).configuration_version } })
    assert.equal(newVersion.version, 2)
    const reopened = await call('/api/ps/grading', { role: 'grader', email: pair.grader_email })
    assert.ok(reopened.rubrics.some(r => r.id === v.id), 'own edit form retains original published rubric after new publication')
    assert.equal((await call(`/api/ps/reviews?round_id=${wr.id}`))[0].score, 0)
    await writeFile(faultPath, 'unavailable')
    await call(wurl + '/rubric-drafts', { method: 'POST', body: { structure: preview.structure }, status: 500 })
    await rm(faultPath)
    assert.equal((await call(`/api/ps/rubric-drafts/${newDraft.id}`)).status, 'published')
    console.log('Weighted JSON/admin permissions, failure preservation, server scores, editable queue, immutable revisions/no double counts and historical version HTTP checks passed.')
  }
  {
    // Interviewer pair round over HTTP: queue partners, shared evaluation, scores and pair reassignment targets.
    const pc = new mongoose.Types.ObjectId(), pApps = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()]
    await mongoose.connection.collection('recruitmentcycles').insertOne({ _id: pc, name: 'HTTP pairs', status: 'active', configuration_version: 0, lifecycle_write_count: 0 })
    await mongoose.connection.collection('applicants').insertMany(pApps.map((_id, i) => ({ _id, cycle_id: pc, first_name: `Paired${i}`, last_name: 'HTTP', email: `paired${i}@example.test`, year: 'Sophomore' })))
    const pairs = [{ id: 'one', emails: [emails[0], emails[1]] }]
    const pr = await call(`/api/ps/cycles/${pc}/rounds`, { method: 'POST', status: 201, body: { name: 'PD', evaluation_type: 'interview', eligible_grader_emails: emails, reviews_required: 1, assignment_mode: 'pair', interviewer_pairs: pairs } })
    assert.deepEqual([pr.assignment_mode, pr.interviewer_pairs], ['pair', pairs])
    const q = (id, purpose, values) => ({ id, category_id: 's', label: id, description: '', purpose, format: 'numeric_choice', required: true, confirmed: true, scale: null, options: values.map(value => ({ value, label: '' })) })
    const pointsStructure = { schema_version: 2, scoring_policy: 'points_v1', name: 'PD points', weighting: 'unconfigured', categories: [{ id: 's', name: 'Scoring', weight_bps: null }], questions: [q('skill', 'SCORED_CRITERION', [0, 1, 2, 3]), q('extra', 'BONUS', [1, 0]), q('flag', 'RED_FLAG', [-1, 0])] }
    const pDraft = await call(`/api/ps/rounds/${pr.id}/rubric-drafts`, { method: 'POST', status: 201, body: { structure: pointsStructure } })
    const pVersion = await call(`/api/ps/rubric-drafts/${pDraft.id}/publish`, { method: 'POST', status: 201, body: { revision: 0, configuration_version: pr.configuration_version } })
    const pPreview = await call(`/api/ps/rounds/${pr.id}/assignments`)
    assert.deepEqual([pPreview.mode, pPreview.workload], ['pair', [{ email: 'one & two', count: 2 }]])
    await call(`/api/ps/rounds/${pr.id}/assignments`, { method: 'POST', body: { preview_token: pPreview.preview_token } })
    const queue = await call('/api/ps/grading', { role: 'grader', email: emails[0] })
    const mine = queue.assignments.filter(a => a.round_id === pr.id)
    assert.equal(mine.length, 2); assert.deepEqual(mine[0].partners, [emails[1]])
    const body = applicant_id => ({ round_id: pr.id, applicant_id, rubric_version_id: pVersion.id, schema_version: 2, revision: 0, comments: '', responses: [{ question_id: 'skill', format: 'numeric_choice', value: 3 }, { question_id: 'extra', format: 'numeric_choice', value: 1 }, { question_id: 'flag', format: 'numeric_choice', value: -1 }] })
    const saved = await call('/api/ps/reviews', { method: 'POST', role: 'grader', email: emails[0], status: 201, body: body(mine[0].applicant_id) })
    assert.deepEqual([saved.score, saved.max_points, saved.panel_emails], [3, 4, [emails[0], emails[1]]])
    const partnerQueue = await call('/api/ps/grading', { role: 'grader', email: emails[1] })
    assert.equal(partnerQueue.assignments.filter(a => a.round_id === pr.id).length, 1, "a partner's submission clears it from both queues")
    assert.equal(partnerQueue.evaluations.filter(e => e.round_id === pr.id).length, 1, 'the partner can open the shared evaluation')
    const scores = await call(`/api/ps/rounds/${pr.id}/scores`)
    assert.equal(scores.engine, 'points_average_v1')
    const scored = scores.candidates.find(c => c.applicant_id === mine[0].applicant_id), waiting = scores.candidates.find(c => c.applicant_id !== mine[0].applicant_id)
    assert.deepEqual([scored.complete, scored.score, scored.percent], [true, 3, 75]); assert.deepEqual([waiting.complete, waiting.score], [false, null])
    assert.deepEqual(scores.graders.map(g => [g.grader, g.reviews]), [['one & two', 1]])
    await call(`/api/ps/rounds/${pr.id}/scores`, { role: 'grader', email: emails[0], status: 403 })
    const reassign = await call(`/api/ps/rounds/${pr.id}/reassign`)
    assert.deepEqual([reassign.mode, reassign.targets, reassign.assignments.length], ['pair', [{ id: 'one', label: 'one & two' }], 1])
    console.log('Interviewer pair HTTP queue partners, shared evaluation, candidate/grader scores and pair reassignment targets passed.')
  }
  const page = await fetch(base + '/admin/rounds'); assert.equal(page.status, 200); assert.ok((await page.text()).includes('Recruitment rounds'))
  const gradePage = await fetch(base + '/grade/ps'); assert.equal(gradePage.status, 200); assert.ok((await gradePage.text()).includes('PS grading'))
  const dashboard = await fetch(base + '/dashboard'); assert.equal(dashboard.status, 200)
  console.log('PS HTTP authorization, JSON errors, configuration, assignments, grading, progression, scoring and history guards passed.')
  console.log('Sessions HTTP auth, empty/normal lists, database-failure JSON and recovery checks passed.')
  if (process.argv.includes('--legacy')) {
    async function runLegacy(name, args = [], extra = {}) {
      const env = { ...process.env, MONGODB_URI: uri, SECURITY_INDEX_DB_NAME: 'ps_http_tests', SECURITY_INDEX_EXPECTED_CYCLE_ID: String(cycleId), ...extra }
      await new Promise((resolveRun, reject) => {
        const proc = spawn(process.execPath, [resolve('scripts/' + name), ...args], { env, stdio: 'inherit' })
        proc.once('error', reject); proc.once('exit', code => code === 0 ? resolveRun() : reject(new Error(name + ' failed: ' + code)))
      })
    }
    await runLegacy('migrate-security-indexes.mjs', ['--apply'], { ALLOW_SECURITY_INDEX_MIGRATION: '1' })
    await runLegacy('verify-indexes.mjs')
    await runLegacy('ps-indexes.mjs', ['--database=ps_http_tests'])
    await runLegacy('ps-indexes.mjs', ['--database=ps_http_tests', '--apply'])
    await runLegacy('race-toctou.mjs', [], { ALLOW_DESTRUCTIVE_TESTS: '1', RACE_TEST_BASE_URL: base, RACE_TEST_MONGODB_URI: uri, RACE_TEST_ATTEMPTS: '5', RACE_TEST_STATE_ATTEMPTS: '2', RACE_TEST_ACTIVITY_HIERARCHY_ATTEMPTS: '2', RACE_TEST_CANDIDATES_PER_IMPORT: '100', RACE_TEST_REQUEST_TIMEOUT_MS: '60000' })
    await runLegacy('loadtest.mjs', [], { ALLOW_DESTRUCTIVE_TESTS: '1', LOAD_TEST_BASE_URL: base, LOAD_TEST_USERS: '5', LOAD_TEST_ACTIONS_PER_USER: '20', LOAD_TEST_CANDIDATES: '5', LOAD_TEST_REQUEST_TIMEOUT_MS: '60000' })
  }
  if (process.argv.includes('--browser')) {
    const browserCycle = new mongoose.Types.ObjectId()
    await mongoose.connection.collection('recruitmentcycles').insertOne({ _id: browserCycle, name: 'V2 browser QA', status: 'active', configuration_version: 0, lifecycle_write_count: 0 })
    await mongoose.connection.collection('authorizedusers').insertOne({ email: 'dev-admin@example.test', role: 'admin', assignment_write_count: 0 })
    await mongoose.connection.collection('applicants').insertMany(Array.from({ length: 3 }, (_, i) => ({ cycle_id: browserCycle, first_name: `Browser${i}`, last_name: 'Candidate', email: `browser${i}@example.test` })))
    for (const name of ['Resume Screening', 'Behavioral', 'Social Round', 'Take Home']) await call(`/api/ps/cycles/${browserCycle}/rounds`, { method: 'POST', status: 201, body: { name, evaluation_type: 'rubric', reviews_required: 1, eligible_grader_emails: ['dev-admin@example.test'] } })
    console.log(`BROWSER_TEST_BASE=${base}`)
    console.log('Disposable browser fixture commands: normal, empty, failure, recover, done')
    const input = createInterface({ input: process.stdin })
    for await (const command of input) {
      if (command === 'done') break
      if (command === 'normal') await mongoose.connection.collection('sessions').updateOne({ _id: 'BROW01' }, { $set: { name: 'Browser test session', created_by: 'dev-admin@example.test', created_at: new Date(), status: 'active', round_id: null, role: null, anonymous: false } }, { upsert: true })
      if (command === 'empty') await mongoose.connection.collection('sessions').deleteOne({ _id: 'BROW01' })
      if (command === 'failure') await writeFile(faultPath, 'unavailable')
      if (command === 'recover') await rm(faultPath, { force: true })
      console.log(`Browser fixture: ${command}`)
    }
    input.close()
  }
} finally {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)) }
  await mongoose.disconnect(); if (repl) await repl.stop(); await rm(directory, { recursive: true, force: true })
}
