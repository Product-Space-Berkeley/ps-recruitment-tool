import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const dir = await mkdtemp(join(process.cwd(), '.behavioral-unit-'))
try {
  const source = await readFile('src/lib/behavioralImport.ts', 'utf8')
  const file = join(dir, 'module.mjs')
  await writeFile(file, ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText)
  const { BEHAVIORAL_HEADERS: headers, BEHAVIORAL_CRITERIA: criteria, parseBehavioralCsv: parse, aggregateBehavioral: aggregate, matchBehavioral: match } = await import(pathToFileURL(file).href)
  const displayFile = join(dir, 'display.mjs')
  await writeFile(displayFile, ts.transpileModule(await readFile('src/lib/behavioralDisplay.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText)
  const { behavioralQuestion, behavioralScoreSuffix, behavioralNoteLabel, BEHAVIORAL_AVERAGE_MAX } = await import(pathToFileURL(displayFile).href)
  assert.equal(BEHAVIORAL_AVERAGE_MAX, 58 / 14)
  for (const [col, label] of criteria) {
    assert.notEqual(behavioralQuestion(`behavioral_${col}`, label, 'curriculum'), label)
    assert.equal(behavioralScoreSuffix(`behavioral_${col}`), col === 28 ? ' / 6' : ' / 4')
  }
  assert.match(behavioralQuestion('behavioral_10', '', 'curriculum'), /curriculum track/)
  assert.match(behavioralQuestion('behavioral_10', '', 'developer'), /community/)
  assert.equal(behavioralNoteLabel('Question 3a Notes', 'developer'), behavioralQuestion('behavioral_10', '', 'developer'))
  assert.match(behavioralNoteLabel('Question 4c Comments'), /difficult team member/)
  assert.equal(behavioralNoteLabel('Comments/Additional Details'), 'Comments/Additional Details')
  assert.equal(behavioralScoreSuffix('unknown'), '')
  assert.equal(behavioralQuestion('unknown', 'Unmapped question'), 'Unmapped question')
  const csv = rows => [headers, ...rows].map(row => row.map(x => JSON.stringify(String(x))).join(',')).join('\n')
  const row = (name = 'RJ', email = 'one@example.com', rating = 4, fit = 6, time = '9/8/2026 13:00:00') => {
    const r = Array(30).fill(''); r[0] = time; r[1] = email; r[2] = '999'; r[3] = email; r[4] = name
    for (const [index] of criteria) r[index] = rating
    r[28] = fit; r[7] = 'Question two narrative'; r[29] = 'Additional comments'; return r
  }
  const records = parse(csv([row(), row('RJ', 'two@example.com', 2, 5)]))
  const result = aggregate(records)
  assert.equal(result.overall_score, ((13 * 4 + 6) / 14 + (13 * 2 + 5) / 14) / 2)
  assert.equal(result.records[0].scores.length, 14)
  assert.equal(result.records[0].responses[0].value, 'Question two narrative')
  assert.equal(result.criterion_averages.at(-1).value, 5.5)
  const placeholder = email => {
    const r = row('Diya Vatsavai', email, 1, 1)
    for (const i of [5,7,9,11,13,15,17,19,21,23,29]) r[i] = 'no show'
    return r
  }
  const lucas = row('Diya Vatsavai', 'lucasjohansson@berkeley.edu')
  const preston = row('Diya Vatasavai', 'patjandra@berkeley.edu', 3, 4)
  const ratings = [1,1,2,4,4,4,4,2,3,3,3,4,4,5]
  criteria.forEach(([col], i) => { lucas[col] = ratings[i] })
  const corrected = aggregate(parse(csv([placeholder('carlychvn@berkeley.edu'), placeholder('davyn@berkeley.edu'), lucas, preston])))
  assert.equal(corrected.overall_score, (44 / 14 + 43 / 14) / 2)
  assert.equal(corrected.records.length, 4)
  assert.deepEqual(corrected.records.map(r => r.counted), [false, false, true, true])
  assert.equal(corrected.records[0].responses[0].value, 'no show')
  const otherApplicant = placeholder('carlychvn@berkeley.edu'); otherApplicant[4] = 'Other Applicant'
  assert.equal(aggregate(parse(csv([otherApplicant]))).overall_score, 1)
  const later = row('RJ', 'one@example.com', 1, 1, '9/8/2026 14:00:00')
  const revised = aggregate(parse(csv([row(), later])))
  assert.equal(revised.overall_score, 1); assert.equal(revised.records[0].counted, false)
  later[6] = ''
  const incomplete = aggregate(parse(csv([row(), later])))
  assert.equal(incomplete.overall_score, null); assert.equal(incomplete.records.length, 2)
  assert.equal(incomplete.records[1].scores.length, 13)
  assert.equal(aggregate([]).overall_score, null)
  assert.deepEqual(aggregate(parse(csv([row()]))), aggregate(parse(csv([row()]))))
  assert.equal(aggregate(parse(csv([row()]))).records.length, 1)
  const roster = [{ id: 'r', name: 'Ren Jie Tee', role: 'curriculum' }, { id: 'j', name: 'Jeffrey (Jeff) Li', role: 'developer' }, { id: 'p', name: 'Reyansh Pallikonda', role: 'developer' }]
  const matched = match(parse(csv([row(), row('Jefferey Li'), row('Reyansh Pallilkonda')])), roster)
  assert.equal(matched.unresolved.length, 0); assert.equal(matched.grouped.size, 3)
  assert.equal(matched.resolutions.rj, 'r')
  assert.equal(match(parse(csv([row('Ren')])), [...roster, { id: 'r2', name: 'Ren Smith', role: 'developer' }]).unresolved.length, 1)
  assert.equal(match(parse(csv([row('Unknown')])), roster, { unknown: 'j' }).grouped.get('j').length, 1)
  assert.equal(match(parse(csv([row('Unknown')])), roster, { unknown: 'exclude' }).unresolved.length, 0)
  assert.equal(match(parse(csv([row('__proto__')])), roster).unresolved.length, 1)
  assert.throws(() => parse('Name,Score\nPerson,1'), /columns/)
  assert.deepEqual(parse(csv([])), [])
  const invalid = row(); invalid[6] = 'no'; assert.throws(() => parse(csv([invalid])), /invalid/)
  console.log('Behavioral parser, averages, latest-response, alias, ambiguity and repeat checks passed.')
} finally { await rm(dir, { recursive: true, force: true }) }
