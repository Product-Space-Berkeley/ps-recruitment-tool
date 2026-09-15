#!/usr/bin/env node
/**
 * Verifies session bans + red-flag anonymity.
 * Requires: TEST_BYPASS_AUTH=1 npm run dev
 */
const BASE = 'http://127.0.0.1:5173'

const OWNER  = { email: 'owner@example.com',  role: 'leadership' }
const MEMBER = { email: 'member@example.com', role: 'grader' }
const TROLL  = { email: 'troll@example.com',  role: 'grader' }

const H = u => ({ 'content-type': 'application/json', 'x-test-email': u.email, 'x-test-role': u.role })
async function api(method, path, user, body) {
  const res = await fetch(`${BASE}${path}`, { method, headers: H(user), body: body ? JSON.stringify(body) : undefined })
  let data; try { data = await res.json() } catch {}
  return { status: res.status, ok: res.ok, data }
}

let pass = 0, fail = 0
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; console.log(`  ✗ ${label} ${detail}`) }
}

const cleanup = []

async function main() {
  // --- setup ---
  const cycle = await api('POST', '/api/cycles', OWNER, { name: `BanTest-${Date.now()}`, status: 'active', accepting_applications: false })
  cleanup.push(() => api('DELETE', `/api/cycles/${cycle.data.id}`, OWNER))
  const round = await api('POST', '/api/rounds', OWNER, { cycle_id: cycle.data.id, name: 'R', grading_type: null, order_index: 1, status: 'deliberating' })
  cleanup.push(() => api('DELETE', `/api/rounds/${round.data.id}`, OWNER))

  const sid = 'BAN' + Math.random().toString(36).substring(2, 5).toUpperCase()
  await api('POST', '/api/sessions', OWNER, { id: sid, round_id: round.data.id, name: 'Ban Test', status: 'active', created_by: OWNER.email, anonymous: false })

  await api('POST', '/api/session-members', OWNER,  { session_id: sid })
  await api('POST', '/api/session-members', MEMBER, { session_id: sid })
  await api('POST', '/api/session-members', TROLL,  { session_id: sid })

  const cands = await api('POST', `/api/sessions/${sid}/candidates`, OWNER, [{ name: 'Cand A', status: 'pending', data: {} }])
  const cid = cands.data[0].id

  console.log('\n── Red-flag anonymity ──')
  // MEMBER and TROLL both red-flag; MEMBER also vouches
  await api('POST', '/api/votes', MEMBER, { candidate_id: cid, voter_name: 'Member Person', vote_type: 'red_flag' })
  await api('POST', '/api/votes', TROLL,  { candidate_id: cid, voter_name: 'Troll Person',  vote_type: 'red_flag' })
  await api('POST', '/api/votes', MEMBER, { candidate_id: cid, voter_name: 'Member Person', vote_type: 'vouch' })

  const asOwner  = await api('GET', `/api/votes?candidate_ids=${cid}`, OWNER)
  const asMember = await api('GET', `/api/votes?candidate_ids=${cid}`, MEMBER)

  const ownerFlagNames = asOwner.data.filter(v => v.vote_type === 'red_flag').map(v => v.voter_name)
  check('creator sees real red-flag names', ownerFlagNames.includes('Member Person') && ownerFlagNames.includes('Troll Person'), JSON.stringify(ownerFlagNames))

  const memberFlags = asMember.data.filter(v => v.vote_type === 'red_flag')
  const othersFlag = memberFlags.find(v => v.voter_name !== 'Member Person')
  const ownFlag    = memberFlags.find(v => v.voter_name === 'Member Person')
  check("member sees others' red flag as Anonymous", othersFlag?.voter_name === 'Anonymous', JSON.stringify(memberFlags.map(v => v.voter_name)))
  check('member still sees their own red flag', !!ownFlag)
  check('no email leaks on redacted flag', othersFlag?.voter_email === null)

  const memberVouch = asMember.data.find(v => v.vote_type === 'vouch')
  check('vouches remain attributed (not anonymized)', memberVouch?.voter_name === 'Member Person')

  // Notes
  await api('POST', '/api/candidate-notes', TROLL,  { candidate_id: cid, author: 'Troll Person',  content: 'flag note', type: 'red_flag' })
  await api('POST', '/api/candidate-notes', MEMBER, { candidate_id: cid, author: 'Member Person', content: 'normal note', type: 'note' })

  const notesOwner  = await api('GET', `/api/candidate-notes?candidate_id=${cid}`, OWNER)
  const notesMember = await api('GET', `/api/candidate-notes?candidate_id=${cid}`, MEMBER)
  check('creator sees red-flag note author', notesOwner.data.find(n => n.type === 'red_flag')?.author === 'Troll Person')
  check('member sees red-flag note as Anonymous', notesMember.data.find(n => n.type === 'red_flag')?.author === 'Anonymous')
  check('plain notes stay attributed', notesMember.data.find(n => n.type === 'note')?.author === 'Member Person')

  console.log('\n── Session bans ──')
  const banByMember = await api('POST', '/api/session-bans', MEMBER, { session_id: sid, email: TROLL.email })
  check('non-creator cannot ban (403)', banByMember.status === 403, `got ${banByMember.status}`)

  const banSelf = await api('POST', '/api/session-bans', OWNER, { session_id: sid, email: OWNER.email })
  check('cannot ban the session creator (400)', banSelf.status === 400, `got ${banSelf.status}`)

  const ban = await api('POST', '/api/session-bans', OWNER, { session_id: sid, email: TROLL.email })
  check('creator can ban', ban.ok, `got ${ban.status}`)

  const membersAfter = await api('GET', `/api/session-members?session_id=${sid}`, OWNER)
  check('ban kicks them out of the session', !membersAfter.data.some(m => m.user_email === TROLL.email))

  const rejoin = await api('POST', '/api/session-members', TROLL, { session_id: sid })
  check('banned user cannot rejoin (403)', rejoin.status === 403, `got ${rejoin.status}`)

  const openSession = await api('GET', `/api/sessions/${sid}`, TROLL)
  check('banned user cannot open session (403)', openSession.status === 403, `got ${openSession.status}`)

  const memberStillOk = await api('GET', `/api/sessions/${sid}`, MEMBER)
  check('unbanned member unaffected', memberStillOk.ok)

  const voteWhileBanned = await api('POST', '/api/votes', TROLL, { candidate_id: cid, voter_name: 'Troll', vote_type: 'vouch' })
  check('banned user cannot vote (403)', voteWhileBanned.status === 403, `got ${voteWhileBanned.status}`)

  await api('DELETE', '/api/session-bans', OWNER, { session_id: sid, email: TROLL.email })
  const rejoinAfterUnban = await api('POST', '/api/session-members', TROLL, { session_id: sid })
  check('unban restores access', rejoinAfterUnban.ok, `got ${rejoinAfterUnban.status}`)

  console.log(`\n${pass} passed, ${fail} failed\n`)
  for (const c of cleanup.reverse()) await c()
  if (fail) process.exit(1)
}

main().catch(async e => {
  console.error('FATAL:', e.message)
  for (const c of cleanup.reverse()) { try { await c() } catch {} }
  process.exit(1)
})
