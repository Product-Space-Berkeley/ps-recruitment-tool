// Isolated Mongo transaction checks. Never writes to the configured app database.
import assert from 'node:assert/strict'
import Module, { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import mongoose from 'mongoose'
import { spawn } from 'node:child_process'
const require = createRequire(import.meta.url)
const resolve = Module._resolveFilename
Module._resolveFilename = function (id, ...args) { return resolve.call(this, id.startsWith('@/') ? path.resolve('src', id.slice(2)) : id, ...args) }
require.extensions['.ts'] = (m, f) => m._compile(ts.transpileModule(readFileSync(f, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, f)
if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI required; a separate disposable database is always used.')
const dbName = `plextech_behavioral_test_${Date.now()}`
await mongoose.connect(process.env.MONGODB_URI, { dbName, secureProtocol: 'TLSv1_2_method' })
let dev
try {
  const models = require('../src/lib/models/index.ts')
  await Promise.all(Object.values(models).filter(m => typeof m.init === 'function').map(m => m.init()))
  const { RecruitmentCycle: Cycle, Round, Session, Candidate, Applicant } = models
  const { BEHAVIORAL_HEADERS: headers, BEHAVIORAL_CRITERIA: criteria } = require('../src/lib/behavioralImport.ts')
  const row = (name, score = 4) => { const r = Array(30).fill(''); r[0] = '9/8/2026 15:00:00'; r[1] = 'reader@example.com'; r[3] = 'Reader'; r[4] = name; r[7] = 'Preserved notes'; for (const [i] of criteria) r[i] = score; r[28] = 6; return r }
  let rows = [row('Ada Lovelace'), row('Grace Hopper')], fetches = 0, fail = false
  require('../src/lib/coffeeChats.ts').fetchGoogleSheetCsv = async () => { fetches++; if (fail) throw new Error('Fixture outage'); return [headers, ...rows].map(r => r.map(x => JSON.stringify(String(x))).join(',')).join('\n') }
  const { behavioralRoster, syncBehavioral } = require('../src/lib/behavioralSync.ts')
  const cycle = await Cycle.create({ name: 'Isolated behavioral test' })
  const finals = []
  for (const [role, name] of [['curriculum', 'Ada Lovelace'], ['developer', 'Grace Hopper']]) {
    const applicant = await Applicant.create({ cycle_id: cycle._id, first_name: name.split(' ')[0], last_name: name.split(' ')[1], email: `${role}@example.com` })
    const prior = await Round.create({ cycle_id: cycle._id, name: `${role} prior`, order_index: 2, role, grading_type: 'interview' })
    const sess = await Session.create({ _id: role === 'curriculum' ? 'TESTCU' : 'TESTDE', round_id: prior._id, name: role, role, status: 'ended', created_by: 'admin@example.com' })
    await Candidate.create({ session_id: sess._id, applicant_id: applicant._id, name, status: 'accepted' })
    finals.push(await Round.create({ cycle_id: cycle._id, name: `${role} final`, order_index: 3, role, grading_type: 'interview' }))
  }
  const targets = await behavioralRoster(cycle.id, finals.map(r => r.id))
  assert.equal(targets.roster.length, 2)
  const configuration = { ...targets, sheetId: 'fixture', gid: '0', resolutions: {}, created_by: 'admin@example.com' }
  const first = await syncBehavioral(cycle.id, { force: true, configuration })
  assert.equal(first.applicants, 2)
  const ids = first.sessions.map(s => s.id)
  const before = await Candidate.find({ session_id: mongoose.trusted({ $in: ids }) }).lean()
  assert.equal(before.length, 2); assert.equal(before[0].data.interview.records.length, 1)
  await Candidate.updateOne({ _id: before[0]._id }, { $set: { status: 'accepted', 'data.manual': 'Keep me' } })
  const count = fetches
  const throttled = await Promise.all([syncBehavioral(cycle.id), syncBehavioral(cycle.id)])
  assert.ok(throttled.every(r => r.busy)); assert.equal(fetches, count)
  rows = [row('Ada Lovelace', 2)]
  await syncBehavioral(cycle.id, { force: true })
  const after = await Candidate.find({ session_id: mongoose.trusted({ $in: ids }) }).lean()
  assert.deepEqual(after.map(c => String(c._id)).sort(), before.map(c => String(c._id)).sort())
  assert.equal(after.find(c => String(c._id) === String(before[0]._id)).status, 'accepted')
  assert.equal(after.find(c => String(c._id) === String(before[0]._id)).data.manual, 'Keep me')
  assert.equal(after.find(c => c.name === 'Grace Hopper').data.score, null)
  const savedScore = after.find(c => c.name === 'Ada Lovelace').data.score
  rows.push(row('Unknown Person'))
  await assert.rejects(syncBehavioral(cycle.id, { force: true }), /unmatched/)
  assert.equal((await Candidate.findOne({ name: 'Ada Lovelace', session_id: mongoose.trusted({ $in: ids }) })).data.score, savedScore)
  fail = true
  await assert.rejects(syncBehavioral(cycle.id, { force: true }), /outage/)
  assert.equal((await Candidate.findOne({ name: 'Ada Lovelace', session_id: mongoose.trusted({ $in: ids }) })).data.score, savedScore)
  console.log('Isolated transaction checks passed: track lookup, initialization, shared throttle, repeated sync, removed responses, decision preservation, unmatched and outage snapshots.')
  if (process.argv.includes('--http')) {
    const uri = new URL(process.env.MONGODB_URI); uri.pathname = `/${dbName}`
    dev = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--webpack', '--port', '5192'], { env: { ...process.env, MONGODB_URI: uri.href, TEST_BYPASS_AUTH: '1' }, stdio: ['ignore', 'ignore', 'ignore'] })
    for (let i = 0; i < 60; i++) { try { await fetch('http://localhost:5192/'); break } catch { await new Promise(r => setTimeout(r, 500)) } }
    const endpoint = `http://localhost:5192/api/behavioral-sync?session_id=${ids[0]}`
    const headersFor = (role, email = 'admin@example.com') => ({ 'x-test-role': role, 'x-test-email': email, 'Content-Type': 'application/json' })
    assert.equal((await fetch(endpoint)).status, 401)
    assert.equal((await fetch(endpoint, { headers: headersFor('grader', 'outsider@example.com') })).status, 403)
    assert.equal((await fetch(endpoint, { headers: headersFor('admin') })).status, 200)
    assert.equal((await fetch('http://localhost:5192/api/behavioral-sync', { method: 'POST', headers: headersFor('grader'), body: JSON.stringify({ action: 'sync', cycle_id: cycle.id }) })).status, 403)
    console.log('Local HTTP authentication checks passed: anonymous, outsider and non-admin rejected; joined admin allowed.')
    const sessionId = ids[0]
    const target = before.find(c => c.session_id === sessionId)
    const other = before.find(c => c.session_id !== sessionId)
    const extra = await Candidate.create({ session_id: sessionId, name: 'Extra fixture' })
    await Applicant.updateOne({ _id: target.applicant_id }, { $set: { year: 'Freshman' } })
    await Cycle.updateOne({ _id: cycle._id }, { $set: { behavioral_source: null } })
    const control = (body, role = 'admin', email = 'admin@example.com') => fetch(`http://localhost:5192/api/sessions/${sessionId}/controls`, { method: 'POST', headers: headersFor(role, email), body: JSON.stringify(body) })
    const vote = candidateId => fetch('http://localhost:5192/api/votes', { method: 'POST', headers: headersFor('admin'), body: JSON.stringify({ candidate_id: String(candidateId), vote_type: 'vouch' }) })
    assert.equal((await control({ action: 'focus', candidate_id: String(target._id) }, 'grader')).status, 403)
    assert.equal((await control({ action: 'focus', candidate_id: String(target._id) }, 'admin', 'outsider@example.com')).status, 403)
    assert.equal((await control({ action: 'focus', candidate_id: String(other._id) })).status, 400)
    assert.equal((await control({ action: 'focus', candidate_id: String(target._id) })).status, 200)
    let currentSession = await Session.findById(sessionId).lean()
    assert.equal(String(currentSession.focused_candidate_id), String(target._id))
    assert.equal(currentSession.focus_version, 1)
    assert.equal((await control({ action: 'focus', candidate_id: String(target._id) })).status, 200)
    currentSession = await Session.findById(sessionId).lean()
    assert.equal(currentSession.focus_version, 2)
    assert.equal((await control({ action: 'focus', candidate_id: null })).status, 200)
    assert.equal((await Session.findById(sessionId)).focused_candidate_id, null)
    const candidateResponse = await fetch(`http://localhost:5192/api/sessions/${sessionId}/candidates`, { headers: headersFor('admin') })
    assert.equal((await candidateResponse.json()).find(c => c.id === String(target._id)).data['Class year'], 'Freshman')
    assert.equal((await control({ action: 'vouch-limit', enabled: true })).status, 200)
    const concurrent = await Promise.all([vote(target._id), vote(extra._id)])
    assert.deepEqual(concurrent.map(r => r.status).sort(), [201, 409])
    const winning = await models.Vote.findOne({ voter_email: 'admin@example.com', vote_type: 'vouch' }).lean()
    assert.equal((await fetch('http://localhost:5192/api/votes', { method: 'DELETE', headers: headersFor('admin'), body: JSON.stringify({ id: String(winning._id) }) })).status, 200)
    assert.equal((await vote(target._id)).status, 201)
    assert.equal((await control({ action: 'vouch-limit', enabled: false })).status, 200)
    assert.equal((await vote(extra._id)).status, 201)
    assert.equal((await control({ action: 'vouch-limit', enabled: true })).status, 409)
    assert.equal(await models.Vote.countDocuments({ voter_email: 'admin@example.com', vote_type: 'vouch' }), 2)
    // A bounded 40-viewer burst against this script's disposable DB only.
    await control({ action: 'vouch-limit', enabled: false })
    const viewers = Array.from({ length: 40 }, (_, i) => `viewer-${i}@example.com`)
    await models.SessionMember.insertMany(viewers.map(user_email => ({ session_id: sessionId, user_email })))
    const voteUrl = `http://localhost:5192/api/votes?candidate_ids=${target._id},${extra._id}`
    const liveUrl = `http://localhost:5192/api/sessions/${sessionId}/live`
    assert.equal((await fetch(liveUrl)).status, 401)
    assert.equal((await fetch(liveUrl, { headers: headersFor('grader', 'outsider@example.com') })).status, 403)
    await fetch(voteUrl, { headers: headersFor('admin') }) // warm route compilation
    const timings = []
    const measured = async (url, options) => { const start = performance.now(); const r = await fetch(url, options); const body = await r.json(); timings.push(performance.now() - start); assert.ok(r.ok, `${r.status}: ${JSON.stringify(body)}`); return body }
    await Promise.all(viewers.map(email => measured('http://localhost:5192/api/votes', { method: 'POST', headers: headersFor('grader', email), body: JSON.stringify({ candidate_id: String(target._id), vote_type: 'vouch', voter_name: email }) })))
    assert.equal(await models.Vote.countDocuments({ candidate_id: target._id, voter_email: mongoose.trusted({ $in: viewers }) }), 40)
    for (let wave = 0; wave < 3; wave++) await Promise.all(viewers.map(async email => {
      const snapshot = await measured(liveUrl, { headers: headersFor('grader', email) })
      assert.ok(snapshot.candidates.every(c => Object.keys(c).every(k => k === 'id' || k === 'status')))
      assert.equal(snapshot.session.status, 'active')
      const result = snapshot.votes
      assert.equal(result.filter(v => v.vote_type === 'vouch').length, 42)
      assert.equal(result.filter(v => v.voter_email === email).length, 1)
      assert.ok(result.every(v => v.voter_email === null || v.voter_email === email))
    }))
    const sorted = timings.sort((a, b) => a - b)
    assert.equal((await control({ action: 'vouch-visibility', enabled: false }, 'grader')).status, 403)
    assert.equal((await control({ action: 'vouch-visibility', enabled: false })).status, 200)
    const hidden = await (await fetch(liveUrl, { headers: headersFor('grader', viewers[0]) })).json()
    assert.equal(hidden.session.show_vouch_counts, false)
    assert.equal(hidden.votes.length, 1)
    assert.equal(hidden.votes[0].voter_email, viewers[0])
    const hiddenLegacy = await (await fetch(voteUrl, { headers: headersFor('grader', viewers[0]) })).json()
    assert.equal(hiddenLegacy.length, 1)
    assert.equal((await control({ action: 'vouch-visibility', enabled: true })).status, 200)
    const revealed = await (await fetch(liveUrl, { headers: headersFor('grader', viewers[0]) })).json()
    assert.equal(revealed.votes.length, 42)
    console.log(JSON.stringify({ test: '40 concurrent viewers; 40 writes + 120 reads', requests: sorted.length, errors: 0, p95_ms: Math.round(sorted[Math.ceil(sorted.length * .95) - 1]), max_ms: Math.round(sorted.at(-1)) }))
    await Session.updateOne({ _id: sessionId }, { $set: { status: 'ended' } })
    assert.equal((await control({ action: 'focus', candidate_id: String(target._id) })).status, 409)
    console.log('Session controls checks passed: admin/member restrictions, cross-session focus rejection, focus revisions/clear, class year, concurrent one-vouch cap, removal/reuse, non-destructive enable and ended session.')
  }
} finally {
  dev?.kill('SIGTERM')
  if (mongoose.connection.name !== dbName || !dbName.startsWith('plextech_behavioral_test_')) throw new Error('Refusing cleanup outside test database.')
  await mongoose.connection.dropDatabase()
  await mongoose.disconnect()
}
