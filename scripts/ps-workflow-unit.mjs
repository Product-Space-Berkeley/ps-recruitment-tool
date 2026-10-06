import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import ExcelJS from 'exceljs'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
const dir = await mkdtemp(join(tmpdir(), 'ps-workflow-'))
try {
  await symlink(resolve('node_modules'), join(dir, 'node_modules'), 'dir')
  const files = ['domain', 'assignments', 'rubrics', 'scoring', 'client', 'rubricV2', 'rubricCompatibility', 'rubricImport', 'rubricBuilder', 'weightedRubric', 'points', 'templates', 'candidateScores']
  for (const name of files) {
    const source = await readFile(`src/lib/ps/${name}.ts`, 'utf8')
    const result = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/(['\"])(\.\/[^'\"]+)\1/g, (_, quote, name) => `${quote}${name}.mjs${quote}`)
    await writeFile(join(dir, `${name}.mjs`), result)
  }
  const d = await import(pathToFileURL(join(dir, 'domain.mjs')))
  const rounds = [{ id: 'a', order_index: 4 }, { id: 'c', order_index: 12 }, { id: 'b', order_index: 7 }]
  assert.equal(d.nextRound(rounds, 'a').id, 'b')
  assert.equal(d.nextRound(rounds, 'c'), null)
  assert.equal(d.nextRound([...rounds, { id: 'x', order_index: 5, archived: true }], 'a').id, 'b')
  assert.deepEqual(d.validateOrder(rounds, ['b', 'c', 'a']), ['b', 'c', 'a'])
  assert.throws(() => d.validateOrder(rounds, ['a', 'a', 'c']))
  assert.throws(() => d.validateOrder(rounds, ['a', 'b']))
  const config = { name: 'Screen', evaluation_type: 'rubric', eligible_grader_emails: ['a@example.test'], reviews_required: 1 }
  assert.equal(d.validateConfiguration(config).reviews_required, 1)
  assert.throws(() => d.validateConfiguration({ ...config, reviews_required: 2 }))
  const { planAssignments } = await import(pathToFileURL(join(dir, 'assignments.mjs')))
  for (const [count, graders, n] of [[120, 12, 3], [137, 11, 3], [5, 5, 5], [1, 12, 3]]) {
    const input = { applicantIds: Array.from({ length: count }, (_, i) => `a-${i}`), eligibleEmails: Array.from({ length: graders }, (_, i) => `g-${i}@example.test`), reviewsRequired: n }
    const plan = planAssignments(input)
    assert.equal(plan.total, count * n)
    assert.ok(plan.spread <= 1)
    if (count === 120) assert.ok(plan.workload.every(w => w.count === 30))
    for (const id of input.applicantIds) { const rows = plan.rows.filter(r => r.applicant_id === id); assert.equal(rows.length, n); assert.equal(new Set(rows.map(r => r.grader_email)).size, n); assert.ok(rows.every(r => input.eligibleEmails.includes(r.grader_email))) }
    assert.deepEqual(plan, planAssignments(input))
    const rerun = planAssignments({ ...input, existing: plan.rows, completed: plan.rows.slice(0, 3) })
    assert.equal(rerun.additions.length, 0); assert.deepEqual(rerun.rows, plan.rows)
    assert.throws(() => planAssignments({ ...input, reviewsRequired: graders + 1 }))
  }
  const fixed = { applicant_id: 'a', grader_email: 'a@example.test' }
  const preserved = planAssignments({ applicantIds: ['a', 'b'], eligibleEmails: ['a@example.test', 'b@example.test'], reviewsRequired: 2, completed: [fixed] })
  assert.ok(preserved.rows.some(r => r.applicant_id === fixed.applicant_id && r.grader_email === fixed.grader_email))
  // A removed grader's completed review still counts; their unstarted work is released and reassigned.
  const removedGrader = planAssignments({ applicantIds: ['a'], eligibleEmails: ['b@example.test'], reviewsRequired: 1, completed: [fixed] })
  assert.deepEqual([removedGrader.additions.length, removedGrader.removals.length], [0, 0])
  const released = planAssignments({ applicantIds: ['a'], eligibleEmails: ['b@example.test'], reviewsRequired: 1, existing: [fixed] })
  assert.deepEqual(released.removals, [fixed]); assert.deepEqual(released.additions, [{ applicant_id: 'a', grader_email: 'b@example.test' }])
  // Raising N tops up; lowering N releases only unstarted work, busiest graders first, never completed work.
  const mid = { applicantIds: Array.from({ length: 30 }, (_, i) => `m-${i}`), eligibleEmails: ['g1@x.test', 'g2@x.test', 'g3@x.test', 'g4@x.test'], reviewsRequired: 2, seed: 'round-1' }
  const two = planAssignments(mid)
  const three = planAssignments({ ...mid, reviewsRequired: 3, existing: two.rows })
  assert.equal(three.additions.length, 30); assert.equal(three.removals.length, 0); assert.ok(three.spread <= 1)
  const done = three.rows.slice(0, 20)
  const one = planAssignments({ ...mid, reviewsRequired: 1, existing: three.rows, completed: done })
  for (const id of mid.applicantIds) {
    const kept = one.rows.filter(r => r.applicant_id === id), completedHere = done.filter(r => r.applicant_id === id).length
    assert.equal(kept.length, Math.max(1, completedHere), 'keep completed work, release the rest down to N')
    assert.ok(done.filter(r => r.applicant_id === id).every(c => kept.some(k => k.grader_email === c.grader_email)))
  }
  assert.equal(one.additions.length, 0)
  // Seeded order: deterministic per seed, not tied to applicant ID order.
  const seeded = planAssignments({ ...mid, applicantIds: mid.applicantIds.slice(0, 8), eligibleEmails: mid.eligibleEmails.slice(0, 2), reviewsRequired: 1 })
  assert.deepEqual(seeded, planAssignments({ ...mid, applicantIds: mid.applicantIds.slice(0, 8), eligibleEmails: mid.eligibleEmails.slice(0, 2), reviewsRequired: 1 }))
  const firstGrader = s => planAssignments({ ...mid, seed: s, applicantIds: mid.applicantIds.slice(0, 8), eligibleEmails: mid.eligibleEmails.slice(0, 2), reviewsRequired: 1 }).rows.filter(r => r.grader_email === 'g1@x.test').map(r => r.applicant_id).join()
  assert.notEqual(firstGrader('seed-a'), firstGrader('seed-b'), 'different seeds give different mixes')
  // Pairs plan as units exactly like graders.
  const pairPlan = planAssignments({ applicantIds: ['p1', 'p2', 'p3', 'p4'], eligibleEmails: ['pair-a', 'pair-b'], reviewsRequired: 1, seed: 'r' })
  assert.deepEqual(pairPlan.workload.map(w => w.count), [2, 2])
  // Pair validation.
  const eligible = ['a@x.test', 'b@x.test', 'c@x.test', 'd@x.test']
  assert.deepEqual(d.validatePairs([{ id: 'p1', emails: ['B@x.test', 'a@x.test'] }], eligible), [{ id: 'p1', emails: ['a@x.test', 'b@x.test'] }])
  assert.throws(() => d.validatePairs([{ id: 'p1', emails: ['a@x.test'] }], eligible), /two or three/)
  assert.throws(() => d.validatePairs([{ id: 'p1', emails: ['a@x.test', 'z@x.test'] }], eligible), /eligible grader/)
  assert.throws(() => d.validatePairs([{ id: 'p1', emails: ['a@x.test', 'b@x.test'] }, { id: 'p2', emails: ['a@x.test', 'c@x.test'] }], eligible), /more than one pair/)
  const pairConfig = d.validateConfiguration({ name: 'PD', evaluation_type: 'interview', eligible_grader_emails: eligible, reviews_required: 1, assignment_mode: 'pair', interviewer_pairs: [] })
  assert.deepEqual([pairConfig.assignment_mode, pairConfig.interviewer_pairs], ['pair', []], 'pairs can be chosen after creation')
  assert.throws(() => d.validateConfiguration({ ...pairConfig, reviews_required: 2, interviewer_pairs: [{ id: 'p1', emails: ['a@x.test', 'b@x.test'] }] }), /Pairs per candidate/)
  assert.equal(d.pairLabel({ id: 'p', emails: ['ana@x.test', 'ben@x.test'] }), 'ana & ben')
  const frozenInput = { applicantIds: ['done', 'new-1', 'new-2'], eligibleEmails: ['a@example.test', 'b@example.test', 'c@example.test'], reviewsRequired: 2, existing: [{ applicant_id: 'done', grader_email: 'a@example.test' }, { applicant_id: 'done', grader_email: 'b@example.test' }], frozenApplicantIds: ['done'] }
  const frozenPlan = planAssignments(frozenInput)
  assert.ok(frozenPlan.workload.every(w => w.count === 2), 'frozen assignments participate in balancing new work')
  assert.ok(frozenPlan.additions.every(row => row.applicant_id !== 'done'))
  const incompleteFrozen = planAssignments({ ...frozenInput, existing: frozenInput.existing.slice(0, 1) })
  assert.equal(incompleteFrozen.rows.filter(row => row.applicant_id === 'done').length, 1, 'terminal decisions never gain assignments')
  assert.equal(d.transition('pending', 'advance', true), 'advanced')
  assert.equal(d.transition('advanced', 'advance', true), 'advanced')
  assert.equal(d.transition('in_review', 'hold', true), 'hold')
  assert.equal(d.transition('hold', 'advance', true), 'advanced')
  assert.equal(d.transition('pending', 'reject', true), 'rejected')
  assert.throws(() => d.transition('advanced', 'hold', true))
  assert.throws(() => d.transition('rejected', 'advance', true))
  assert.throws(() => d.transition('pending', 'advance', false))
  const rubric = await import(pathToFileURL(join(dir, 'rubrics.mjs')))
  const criteria = [{ id: 'criterion-a', name: 'Provided criterion', description: '', weight: null, scale: { min: 0, max: 5, step: 0.5 }, options: [] }, { id: 'criterion-b', name: 'Provided option', description: '', weight: 2, scale: null, options: [{ value: 10, label: 'Provided label' }, { value: 20, label: 'Provided alternative' }] }]
  const ratings = [{ criterion_id: 'criterion-a', raw_score: 3.5 }, { criterion_id: 'criterion-b', raw_score: 10 }]
  const original = structuredClone(ratings)
  assert.deepEqual(rubric.validateRatings(criteria, ratings), ratings)
  assert.deepEqual(ratings, original, 'raw ratings remain unchanged')
  assert.equal(rubric.validateRubric({ name: 'Team rubric', criteria }).criteria.length, 2)
  assert.throws(() => rubric.validateRubric({ name: 'Unsafe ID', criteria: [{ ...criteria[0], id: 'constructor' }] }))
  assert.equal(rubric.validateRubric({ name: 'One', criteria: criteria.slice(0, 1) }).criteria.length, 1)
  assert.throws(() => rubric.validateRatings(criteria, [{ criterion_id: 'unknown', raw_score: 2 }, ratings[1]]))
  assert.throws(() => rubric.validateRatings(criteria, [{ criterion_id: 'criterion-a', raw_score: 2.25 }, ratings[1]]))
  assert.throws(() => rubric.validateRatings(criteria, [ratings[0], { criterion_id: 'criterion-b', raw_score: 11 }]))
  assert.throws(() => rubric.validateRatings(criteria, [ratings[0], ratings[0]]))
  const access = { actor: 'a', assignedTo: 'a', state: 'in_review', rubricId: 'version-1', submittedRubricId: 'version-1' }
  rubric.validateReviewAccess(access)
  assert.throws(() => rubric.validateReviewAccess({ ...access, assignedTo: 'b' }))
  assert.throws(() => rubric.validateReviewAccess({ ...access, submittedRubricId: 'version-2' }))
  assert.throws(() => rubric.validateReviewAccess({ ...access, state: 'advanced' }))
  assert.throws(() => rubric.parseRubricImport('unknown', 'data'))
  const v2 = await import(pathToFileURL(join(dir, 'rubricV2.mjs')))
  const compatibility = await import(pathToFileURL(join(dir, 'rubricCompatibility.mjs')))
  const projected = compatibility.copyStructure({ name: 'Old', criteria })
  assert.equal(compatibility.isV2({ name: 'Old', criteria }), false, 'missing schema version stays V1')
  assert.deepEqual(projected.questions.map(q => q.id), criteria.map(c => c.id))
  const structure = { ...projected, categories: [{ ...projected.categories[0], weight_bps: 10000 }], weighting: 'configured' }
  assert.equal(v2.validateStructure(structure, true).schema_version, 2)
  assert.throws(() => v2.validateStructure({ ...structure, categories: [{ ...structure.categories[0], weight_bps: 5000 }] }, true))
  assert.throws(() => v2.validateStructure({ ...structure, questions: structure.questions.map(q => ({ ...q, confirmed: false })) }, true))
  const bool = { ...structure.questions[0], id: 'red', purpose: 'RED_FLAG', format: 'boolean', scale: null, options: [] }
  const number = structure.questions[0]
  const responses = [{ question_id: number.id, format: 'number', value: 0 }, { question_id: bool.id, format: 'boolean', value: false }]
  assert.deepEqual(v2.validateResponses([{ ...bool, required: false }], []), [], 'missing optional response remains missing, not false')
  assert.deepEqual(v2.validateResponses([number, bool], responses), responses, 'zero/false retain type and raw value')
  assert.throws(() => v2.validateResponses([number, bool], responses.slice(0, 1)))
  assert.throws(() => v2.validateResponses([number], [{ ...responses[0], value: '0' }]))
  assert.throws(() => v2.validateResponses([bool], [{ ...responses[1], value: 'false' }]))
  assert.throws(() => v2.validateStructure({ ...structure, questions: [bool] }, true), /Only categories/)
  const formats = ['numeric_choice', 'single_choice', 'multiple_choice', 'short_text', 'long_text', 'url']
  for (const format of formats) {
    const q = { ...bool, format, options: format.includes('choice') ? [{ value: format === 'numeric_choice' ? -1 : 'a', label: 'A' }] : [] }
    const value = format === 'numeric_choice' ? -1 : format === 'single_choice' ? 'a' : format === 'multiple_choice' ? ['a'] : format === 'url' ? 'https://example.test/note' : '  exact raw text  '
    assert.deepEqual(v2.validateResponses([q], [{ question_id: q.id, format, value }])[0].value, value)
  }
  const builder = await import(pathToFileURL(join(dir, 'rubricBuilder.mjs')))
  const instructions = { ...builder.newSection('instructions', 'instructions'), name: 'Instructions for Conducting the Interview', description: 'Before the interview\n\n- Create interview notes\n- Review applicant information\n\nSee https://example.test/guide' }
  const guide = { ...builder.newSection('interview_guide', 'guide'), name: 'Product Design Question', description: 'Clarifying questions are critical. Always ask for prioritization.' }
  const scoreSection = { ...builder.newSection('scoring', 'score'), name: 'Product Design Scoring' }
  let manual = { schema_version: 2, name: 'Manual PS PD', weighting: 'unconfigured', categories: [instructions], questions: [] }
  assert.equal(v2.validateStructure(manual).questions.length, 0, 'instruction-only drafts can be saved')
  assert.throws(() => v2.validateStructure(manual, true), /response question/)
  manual = { ...manual, categories: [instructions, guide, scoreSection], questions: [builder.newQuestion(scoreSection, 'pd')] }
  manual.questions[0].required = true
  assert.equal(v2.validateStructure(manual, true).categories[0].description, instructions.description)
  assert.equal(builder.isScoringSection(instructions, manual.questions), false)
  assert.equal(builder.isScoringSection(scoreSection, manual.questions), true)
  manual.questions = builder.duplicateQuestion(manual.questions, 'pd', 'pd-copy')
  assert.equal(manual.questions[1].id, 'pd-copy')
  assert.notEqual(manual.questions[0], manual.questions[1])
  manual.questions = builder.reorder(manual.questions, 1, 0)
  assert.equal(manual.questions[0].id, 'pd-copy')
  manual.categories = builder.reorder(manual.categories, 1, 0)
  assert.equal(manual.categories[0].id, 'guide')
  manual.questions[0] = { ...manual.questions[0], label: 'Edited criterion', description: 'Exact helper', category_id: 'guide', purpose: 'QUALITATIVE' }
  manual.categories = manual.categories.map(c => c.id === 'score' ? { ...c, weight_bps: 8500 } : c)
  manual = builder.normalizeWeights(manual)
  assert.equal(manual.weighting, 'configured')
  assert.throws(() => v2.validateStructure(manual, true), /100%/)
  manual.categories = manual.categories.map(c => c.id === 'score' ? { ...c, weight_bps: 10000 } : c)
  assert.equal(v2.validateStructure(manual, true).categories.find(c => c.id === 'score').weight_bps, 10000)
  assert.throws(() => v2.validateStructure({ ...manual, categories: manual.categories.map(c => c.id === 'instructions' ? { ...c, weight_bps: 1000 } : c) }), /Only categories/)
  assert.throws(() => v2.validateStructure({ ...manual, questions: manual.questions.map(q => ({ ...q, category_id: 'instructions', purpose: 'SCORED_CRITERION' })) }), /informational/)
  const deletedSection = builder.removeSection(manual, 'guide')
  assert.ok(deletedSection.questions.every(q => q.category_id !== 'guide'), 'deleting a section removes its questions without dangling references')
  assert.ok(!deletedSection.categories.some(c => c.id === 'guide'))
  const movedOut = builder.normalizeWeights({ ...manual, questions: manual.questions.filter(q => q.id !== 'pd') })
  assert.equal(movedOut.categories.find(c => c.id === 'score').weight_bps, null, 'categories without scored criteria lose numerical weights')
  const rendererSource = await readFile('src/components/PSRubricFields.tsx', 'utf8')
  const rendererJS = ts.transpileModule(rendererSource, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/'@\/lib\/ps\/(\w+)'/g, "'./$1.mjs'")
  await writeFile(join(dir, 'fields.mjs'), rendererJS)
  const Fields = (await import(pathToFileURL(join(dir, 'fields.mjs')))).default
  const html = renderToStaticMarkup(React.createElement(Fields, { rubric: manual, values: {}, onChange() {}, context: { candidate: 'Jane Doe', interviewer: 'Alex' } }))
  assert.match(html, /Instructions for Conducting the Interview/)
  assert.match(html, /Create interview notes/)
  assert.match(html, /href="https:\/\/example.test\/guide"/)
  assert.match(html, /type="radio"/)
  assert.match(html, /100%/)
  assert.ok(!html.includes('schema_version'))
  const basic = { ...builder.newSection('basic_information', 'basic'), description: '<script>alert(1)</script> javascript:alert(1)' }
  const basicHTML = renderToStaticMarkup(React.createElement(Fields, { rubric: { ...manual, categories: [basic], questions: [] }, values: {}, onChange() {}, context: { candidate: 'Jane Doe', interviewer: 'Alex' } }))
  assert.match(basicHTML, /Jane Doe/); assert.match(basicHTML, /Alex/)
  assert.ok(!basicHTML.includes('<script>'))
  assert.ok(!basicHTML.includes('href="javascript:'))
  console.log('Manual section builder, CRUD/reorder/moves, inline weights, informational content and shared section rendering checks passed.')
  const imports = await import(pathToFileURL(join(dir, 'rubricImport.mjs')))
  const csv = Buffer.from('Timestamp,Applicant Name,Same,Same,Red Flag notes,Penalty overcommit,WouldShowUp\n2026,PRIVATE NAME,0,3,PRIVATE HISTORICAL TEXT,-1,No\n2026,OTHER PRIVATE NAME,3,0,OTHER PRIVATE TEXT,1,Yes')
  const imported = await imports.parseStructureFile(csv, 'structure.csv')
  assert.equal(imported.structure.questions.length, 5)
  assert.equal(imported.structure.questions[0].label, imported.structure.questions[1].label)
  assert.notEqual(imported.structure.questions[0].id, imported.structure.questions[1].id)
  assert.ok(!JSON.stringify(imported).includes('PRIVATE'), 'no historical response text retained')
  assert.equal(imported.structure.questions[4].format, 'boolean')
  assert.ok(imported.structure.questions.every(q => q.confirmed === false && q.required === null))
  await assert.rejects(() => imports.parseStructureFile(Buffer.from('%PDF-x'), 'fake.xlsx'))
  await assert.rejects(() => imports.parseStructureFile(Buffer.from('abc'), 'unsupported.xls'))
  await assert.rejects(() => imports.parseStructureFile(Buffer.alloc(imports.IMPORT_LIMITS.bytes + 1), 'oversized.csv'))
  const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('Responses')
  const long = 'Long question '.repeat(30)
  sheet.addRow(['Timestamp', long, 'Duplicate', 'Duplicate'])
  const blank = await imports.parseStructureFile(Buffer.from(await workbook.xlsx.writeBuffer()), 'blank.xlsx')
  sheet.addRow(['2026', 'PRIVATE COMMENT', 0, 3])
  const filled = await imports.parseStructureFile(Buffer.from(await workbook.xlsx.writeBuffer()), 'responses.xlsx')
  assert.deepEqual(blank.structure.questions.map(q => [q.id, q.label]), filled.structure.questions.map(q => [q.id, q.label]))
  assert.equal(blank.structure.questions[0].label, long)
  sheet.getCell('B2').value = { formula: '1+1', result: 2 }
  await assert.rejects(async () => imports.parseStructureFile(Buffer.from(await workbook.xlsx.writeBuffer()), 'formula.xlsx'))
  if (process.env.PS_MATERIALS_ZIP) {
    const zip = process.env.PS_MATERIALS_ZIP
    const names = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).split('\n').filter(n => n.endsWith('.xlsx') && /Written App Scoring|Take Home Scoring|PD Scoring|Written App Grading Backup/.test(n))
    assert.equal(names.length, 4)
    for (const name of names) {
      const parsed = await imports.parseStructureFile(execFileSync('unzip', ['-p', zip, name.replaceAll('[', '\\[').replaceAll(']', '\\]')], { maxBuffer: 4 * 1024 * 1024 }), name.split('/').pop())
      assert.ok(parsed.structure.questions.length >= 10)
      assert.ok(parsed.structure.questions.every(q => !q.confirmed))
      assert.equal(parsed.structure.weighting, 'unconfigured')
      if (/Take Home|PD Scoring/.test(name)) assert.ok(parsed.structure.questions.some(q => q.format === 'url' && q.purpose === 'QUALITATIVE'), 'interview-note URL remains typed evidence')
      console.log(`PS supplied structure parsed: ${name.split('/').pop()} (${parsed.structure.questions.length} questions, ${parsed.excluded.length} metadata columns)`)
    }
  }
  console.log('V1/V2 readers, typed formats, category weight constraints, XLSX/CSV structure/privacy/bounds checks passed.')
  const weighted = await import(pathToFileURL(join(dir, 'weightedRubric.mjs')))
  const section = { id: 's1', name: 'Evidence', order: 0, weight_bps: null, kind: 'general', description: 'Read application first.' }
  const scaleA = { ...weighted.newScaleQuestion('s1', 'scale_a'), label: 'Quality', weight_bps: 6000, min_label: 'Low', max_label: 'High' }
  const scaleB = { ...weighted.newScaleQuestion('s2', 'scale_b'), label: 'Depth', required: false, weight_bps: 4000, scale: { min: 1, max: 5, step: 1 } }
  const context = { ...scaleA, id: 'context', format: 'short_text', purpose: 'QUALITATIVE', label: 'Reason', scale: null, weight_bps: null }
  const choice = { ...context, id: 'choice', category_id: 's2', format: 'single_choice', label: 'Evidence signal', purpose: 'RED_FLAG', options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] }
  const weightedForm = { schema_version: 2, scoring_policy: 'question_weighted_0_3', name: 'Question weights', description: 'Round-specific', categories: [section, { ...section, id: 's2', name: 'Context' }], questions: [scaleA, context, scaleB, choice], weighting: 'unconfigured' }
  weighted.validateWeighted(weightedForm, true)
  const answers = [{ question_id: 'scale_a', format: 'number', value: 0 }, { question_id: 'scale_b', format: 'number', value: 5 }, { question_id: 'context', format: 'short_text', value: 'Evidence' }, { question_id: 'choice', format: 'single_choice', value: 'yes' }]
  assert.equal(weighted.scoreEvaluation(weightedForm, answers).score, 1.2, 'normalize different scale ranges, then apply 60/40 weights')
  assert.equal(weighted.scoreEvaluation(weightedForm, answers.filter(a => a.question_id !== 'scale_b')).score, 0, 'zero is valid and optional missing scales renormalize remaining weights')
  assert.equal(weighted.scoreEvaluation(weightedForm, answers.map(a => a.question_id === 'scale_a' ? { ...a, value: 3 } : a)).score, 3)
  assert.throws(() => weighted.scoreEvaluation(weightedForm, answers.map(a => a.question_id === 'context' ? { ...a, value: '   ' } : a)), /Reason/)
  assert.throws(() => weighted.scoreEvaluation({ ...weightedForm, questions: weightedForm.questions.map(q => ({ ...q, required: false })) }, []), /at least one/)
  for (const patch of [{ weight_bps: 0 }, { weight_bps: -1 }, { weight_bps: null }, { weight_bps: 5000 }, { scale: { min: 0, max: 11, step: 1 } }, { scale: { min: 0, max: 3, step: 0.5 } }]) assert.throws(() => weighted.validateWeighted({ ...weightedForm, questions: [{ ...scaleA, ...patch }, context, scaleB, choice] }, true))
  assert.throws(() => weighted.validateWeighted({ ...weightedForm, categories: [...weightedForm.categories, { ...section, id: 'empty' }] }, true), /Every section/)
  assert.throws(() => weighted.validateWeighted({ ...weightedForm, questions: weightedForm.questions.map(q => q.id === 'choice' ? { ...q, options: [{ value: 'a', label: 'Yes' }, { value: 'b', label: ' yes ' }] } : q) }, true), /distinct/)
  assert.throws(() => weighted.validateWeighted({ ...weightedForm, questions: weightedForm.questions.map(q => q.id === 'context' ? { ...q, weight_bps: 1 } : q) }, true), /Only linear/)
  const legacyCopy = weighted.weightedCopy({ ...weightedForm, scoring_policy: undefined, questions: [scaleA, { ...scaleA, id: 'b' }, { ...scaleA, id: 'c' }] })
  assert.deepEqual(legacyCopy.questions.map(q => q.weight_bps), [3334, 3333, 3333], 'equal weights round exactly to 100%')
  const originalWeighted = structuredClone(weightedForm)
  const duplicated = weighted.duplicateWeighted(weightedForm, 'scale_a', 'duplicate')
  assert.equal(duplicated.questions[1].weight_bps, null)
  assert.equal(duplicated.questions[0].weight_bps, 6000)
  assert.equal(weighted.weightSummary(duplicated).valid, false)
  const reordered = builder.reorder(duplicated.questions, 1, 3)
  assert.equal(reordered[3].id, 'duplicate'); assert.equal(reordered.find(q => q.id === 'scale_b').weight_bps, 4000)
  assert.equal(weighted.weightSummary({ ...weightedForm, questions: weightedForm.questions.filter(q => q.id !== 'scale_a') }).total, 4000, 'delete never changes other weights')
  assert.deepEqual(weightedForm, originalWeighted)
  const canonical = weighted.importRubricJSON(weighted.exportRubricJSON(weightedForm))
  assert.deepEqual(canonical.questions.map(q => [q.id, q.weight_bps, q.options]), weightedForm.questions.map(q => [q.id, q.weight_bps, q.options]))
  const nested = { title: 'Mock JSON', description: 'Imported', sections: [{ id: 'section_json', title: 'Scoring', instructions: 'Review first', questions: [{ id: 'question_json', title: 'Scale', description: 'Why?', type: 'scale', required: true, min: 0, max: 3, low: 'Low', high: 'High', weight: 100 }] }] }
  assert.equal(weighted.importRubricJSON(nested).questions[0].weight_bps, 10000)
  const missing = structuredClone(nested); delete missing.sections[0].questions[0].weight
  assert.equal(weighted.importRubricJSON(missing).questions[0].weight_bps, null)
  assert.throws(() => weighted.validateWeighted(weighted.importRubricJSON(missing), true), /positive weight/)
  const invalidImport = structuredClone(nested); invalidImport.sections[0].questions[0].max = 0
  assert.throws(() => weighted.importRubricJSON(invalidImport), /bounds/)
  assert.deepEqual(weightedForm, originalWeighted, 'imports and failures do not mutate an existing draft')
  const aggregate = weighted.aggregateEvaluations([{ id: 'a', applicant_id: 'app', rubric_version_id: 'v1', score: 1 }, { id: 'b', applicant_id: 'app', rubric_version_id: 'v1', score: 3 }, { id: 'c', applicant_id: 'app', rubric_version_id: 'v2', score: 0 }])
  assert.deepEqual(aggregate.map(g => [g.rubric_version_id, g.reviewer_count, g.score]), [['v1', 2, 2], ['v2', 1, 0]])
  console.log('Question weight/scale/required/zero/optional scoring, stable IDs, no silent rebalancing, JSON import/export and version-grouped aggregate checks passed.')
  const scoring = await import(pathToFileURL(join(dir, 'scoring.mjs')))
  const raw = [{ id: 'review-1', applicant_id: 'app-1', round_id: 'round-1', grader_email: 'a', rubric_version_id: 'v1', ratings, submitted_at: '2026-10-05' }]
  const before = structuredClone(raw)
  const outputs = scoring.unconfiguredScores('round-1', ['app-1', 'app-2'], raw)
  assert.ok(outputs.every(s => s.score === null && s.status === 'unconfigured'))
  assert.deepEqual(outputs[0].input_review_ids, ['review-1'])
  assert.deepEqual(raw, before)
  const client = await import(pathToFileURL(join(dir, 'client.mjs')))
  const originalFetch = globalThis.fetch
  try {
    const response = (body, status = 200, contentType = 'application/json') => new Response(body, { status, headers: contentType ? { 'Content-Type': contentType } : {} })
    globalThis.fetch = async () => response('[]')
    assert.deepEqual(await client.requestArray('/api/sessions'), [], 'a valid empty list succeeds')
    globalThis.fetch = async () => response('[{"id":"ABC123"}]')
    assert.equal((await client.requestArray('/api/sessions'))[0].id, 'ABC123')
    for (const [body, status, contentType, expected] of [
      ['', 500, null, /HTTP 500.*non-JSON/],
      ['', 200, 'application/json', /empty response/],
      ['<html>Sign in</html>', 200, 'text/html', /non-JSON/],
      ['{', 200, 'application/json', /invalid JSON/],
      ['null', 200, 'application/json', /no API data/],
      ['{"error":"Unauthorized"}', 401, 'application/json', /HTTP 401.*Unauthorized/],
      ['{"error":"Database unavailable"}', 503, 'application/problem+json', /HTTP 503.*Database unavailable/],
    ]) {
      globalThis.fetch = async () => response(body, status, contentType)
      await assert.rejects(() => client.requestJson('/api/sessions'), expected)
    }
    globalThis.fetch = async () => response('{}')
    await assert.rejects(() => client.requestArray('/api/sessions'), /invalid list/)
    globalThis.fetch = async () => { const redirected = response('<html>Login</html>', 200, 'text/html'); Object.defineProperty(redirected, 'redirected', { value: true }); return redirected }
    await assert.rejects(() => client.requestJson('/api/sessions'), /redirected.*Sign in/)
    globalThis.fetch = async () => { throw new TypeError('Fetch failed') }
    await assert.rejects(() => client.requestJson('/api/sessions'), /Could not reach/)
    let options
    globalThis.fetch = async (_url, input) => { options = input; return response('{"ok":true}') }
    await client.requestJson('/api/ps/reviews', { comments: 'Raw' })
    assert.equal(options.method, 'POST'); assert.equal(options.cache, 'no-store')
    const form = new FormData(); form.set('file', new Blob(['header']), 'template.csv')
    await client.requestJson('/api/ps/rounds/test/rubric-imports', form)
    assert.equal(options.body, form); assert.equal(options.headers, undefined, 'browser must set the multipart boundary')
    await client.requestJson('/api/authorized-users/test', undefined, 'DELETE')
    assert.equal(options.method, 'DELETE')
  } finally { globalThis.fetch = originalFetch }
  console.log('Checked API fetch status, content type, redirect, empty/malformed body and list validation checks passed.')
  console.log('PS assignment, transition, review and scoring checks passed.')
  console.log('PS round configuration and ordering checks passed.')

  // Points scoring and the FA26 templates.
  const pts = await import(pathToFileURL(join(dir, 'points.mjs')))
  const tpl = await import(pathToFileURL(join(dir, 'templates.mjs')))
  const expected = { written_app: { criteria: 17, bonus: 0, penalty: -2, max: 17 }, pd_interview: { criteria: 33, bonus: 8, penalty: -5, max: 41 }, final: { criteria: 52, bonus: 3, penalty: -3, max: 55 } }
  for (const round of tpl.PS_STANDARD_ROUNDS) {
    const s = pts.validatePoints(round.template(), true)
    for (const year of ['Freshman', 'Sophomore', 'Junior', 'Senior']) assert.deepEqual(pts.pointsRange(pts.visibleQuestions(s, year)), expected[round.key], `${round.key} ${year}`)
    assert.equal(pts.rubricRange(s).differs_by_grade, false)
  }
  assert.deepEqual(tpl.PS_STANDARD_ROUNDS.map(r => r.key), ['written_app', 'pd_interview', 'final'])

  // Written App: grade picks the resume section; hidden required questions are not required.
  const written = tpl.writtenAppTemplate()
  const answer = (ids, value) => ids.map(question_id => ({ question_id, format: 'numeric_choice', value }))
  const shared = [...answer(['q1_specificity', 'q1_reflection', 'q2_personality'], 2), ...answer(['notes_show_up', 'notes_contribute'], 1)]
  const freshman = pts.scorePoints(written, [...answer(['fr_initiative', 'fr_impact'], 3), ...answer(['fr_overcommitted'], -1), ...answer(['fr_exaggerated'], 0), ...shared], 'Freshman')
  assert.deepEqual([freshman.criteria, freshman.bonus, freshman.penalty, freshman.total, freshman.max], [14, 0, -1, 13, 17])
  assert.equal(freshman.percent, 76.47)
  assert.deepEqual(freshman.section_totals.find(t => t.category_id === 'resume_freshman'), { category_id: 'resume_freshman', points: 5, max: 6 })
  assert.throws(() => pts.scorePoints(written, [...answer(['up_initiative', 'up_impact'], 3), ...answer(['up_overcommitted', 'up_exaggerated'], 0), ...shared], 'Freshman'), /match unique questions/)
  const upper = [...answer(['up_initiative', 'up_impact'], 1), ...answer(['up_overcommitted', 'up_exaggerated'], 0), { question_id: 'up_interview_level', format: 'single_choice', value: 'option_2' }, ...shared]
  assert.equal(pts.scorePoints(written, upper, 'Senior').total, 10)
  assert.throws(() => pts.scorePoints(written, upper.filter(r => r.question_id !== 'up_interview_level'), 'Junior'), /required/)
  assert.throws(() => pts.scorePoints(written, upper, null), /no grade on file/)
  assert.throws(() => pts.scorePoints(written, upper, '2027'), /no grade on file/)

  // Final round: half points, bonuses and red flags all count toward the total.
  const final = tpl.finalRoundTemplate()
  const finalAnswers = final.questions.map(q => q.format === 'numeric_choice' ? { question_id: q.id, format: q.format, value: q.purpose === 'RED_FLAG' ? -1 : q.purpose === 'BONUS' ? 1 : Math.max(...q.options.map(o => o.value)) } : { question_id: q.id, format: q.format, value: q.format === 'url' ? 'https://docs.example.test/notes' : 'Strong presenter.' })
  const perfect = pts.scorePoints(final, finalAnswers, 'Junior')
  assert.deepEqual([perfect.criteria, perfect.bonus, perfect.penalty, perfect.total, perfect.max, perfect.percent], [52, 3, -3, 52, 55, 94.55])
  const halves = finalAnswers.map(r => r.question_id.startsWith('speaking_') ? { ...r, value: 0.5 } : r)
  assert.equal(pts.scorePoints(final, halves, 'Junior').criteria, 49)
  assert.throws(() => pts.scorePoints(final, finalAnswers.map(r => r.question_id === 'speaking_1' ? { ...r, value: 0.75 } : r), 'Junior'), /configured option/)

  // Publication rules for points questions.
  const base = { schema_version: 2, scoring_policy: 'points_v1', name: 'R', weighting: 'unconfigured', categories: [{ id: 's', name: 'S', order: 0, weight_bps: null }], questions: [{ id: 'c', category_id: 's', label: 'C', description: '', order: 0, purpose: 'SCORED_CRITERION', format: 'numeric_choice', required: true, confirmed: true, scale: null, options: [{ value: 0, label: '' }, { value: 3, label: '' }] }] }
  const withQ = q => ({ ...base, questions: [...base.questions, { ...base.questions[0], id: 'x', label: 'X', ...q }] })
  assert.equal(pts.validatePoints(base, true).questions.length, 1)
  assert.throws(() => pts.validatePoints(withQ({ purpose: 'BONUS', options: [{ value: -1, label: '' }, { value: 0, label: '' }] }), true), /positive points/)
  assert.throws(() => pts.validatePoints(withQ({ purpose: 'RED_FLAG', options: [{ value: 1, label: '' }, { value: 0, label: '' }] }), true), /negative points/)
  assert.throws(() => pts.validatePoints(withQ({ options: [{ value: -1, label: '' }, { value: 0, label: '' }] }), true), /can't have negative/)
  assert.throws(() => pts.validatePoints(withQ({ format: 'long_text', options: [] }), true), /can't carry points/)
  assert.throws(() => pts.validatePoints({ ...base, categories: [{ ...base.categories[0], weight_bps: 10000 }], weighting: 'configured' }), /no percentage weights/)
  assert.throws(() => pts.validatePoints({ ...base, categories: [{ ...base.categories[0], show_for_years: ['Freshman'] }] }, true), /would see no scored criteria/)
  assert.throws(() => pts.validatePoints({ ...base, categories: [{ ...base.categories[0], show_for_years: ['Grad'] }] }), /at least one grade/)
  assert.equal(pts.validatePoints({ ...base, questions: [{ ...base.questions[0], label: '' }] }).questions[0].label, '')

  // After grading starts, only wording may change.
  const reworded = structuredClone(written); reworded.questions[0].label = 'Initiative'; reworded.categories[0].description = 'New logistics'
  assert.deepEqual(pts.scoringChanges(written, reworded), [])
  const rescored = structuredClone(written); rescored.questions[0].options.push({ value: 4, label: '' })
  assert.deepEqual(pts.scoringChanges(written, rescored), ['questions, answer types or point values'])
  const regraded = structuredClone(written); regraded.categories[0].show_for_years = ['Freshman', 'Sophomore']
  assert.deepEqual(pts.scoringChanges(written, regraded), ['sections or their grade settings'])

  // Older weighted rubrics convert to point choices without weights.
  const converted = pts.pointsCopy({ schema_version: 2, scoring_policy: 'question_weighted_0_3', name: 'Old', weighting: 'unconfigured', categories: [{ id: 's', name: 'S', order: 0, weight_bps: null }], questions: [{ id: 'q', category_id: 's', label: 'Q', description: '', order: 0, purpose: 'SCORED_CRITERION', format: 'number', required: true, confirmed: true, scale: { min: 0, max: 3, step: 1 }, options: [], weight_bps: 10000 }] })
  assert.equal(converted.scoring_policy, 'points_v1')
  assert.deepEqual(converted.questions[0].options.map(o => o.value), [0, 1, 2, 3])
  assert.equal(converted.questions[0].weight_bps, undefined)
  assert.equal(pts.validatePoints(converted, true).questions[0].format, 'numeric_choice')

  // Grading form shows only the applicant's resume section.
  const freshmanHtml = renderToStaticMarkup(React.createElement(Fields, { rubric: written, values: {}, onChange() {}, context: { candidate: 'A', interviewer: 'B', year: 'Freshman' } }))
  assert.ok(freshmanHtml.includes('Resume Scoring [Freshman]') && !freshmanHtml.includes('Resume Scoring [Sophomore'))
  const previewHtml = renderToStaticMarkup(React.createElement(Fields, { rubric: written, values: {}, onChange() {} }))
  assert.ok(previewHtml.includes('Shown only for Freshman applicants') && previewHtml.includes('Resume Scoring [Sophomore'))
  assert.ok(renderToStaticMarkup(React.createElement(Fields, { rubric: final, values: {}, onChange() {} })).includes('+3 bonus · -3'))
  console.log('Points scoring, FA26 templates, grade-specific sections, publication rules and wording-only checks passed.')
  const cs = await import(pathToFileURL(join(dir, 'candidateScores.mjs')))
  const ev = (id, applicant_id, grader, score) => ({ id, applicant_id, grader, score, max_points: 17, percent: Math.round(score / 17 * 10000) / 100 })
  const evals = [ev('1', 'x', 'g1', 13), ev('2', 'x', 'g2', 16), ev('3', 'y', 'g1', 9), ev('4', 'z', 'g2', 17), ev('5', 'z', 'g1', 11)]
  const scores = cs.candidateScores(['x', 'y', 'z', 'w'], evals, 2)
  assert.deepEqual(scores.find(c => c.applicant_id === 'x'), { applicant_id: 'x', reviews: 2, required: 2, complete: true, score: 14.5, percent: 85.3, low: 13, high: 16, max_points: 17, input_review_ids: ['1', '2'] })
  assert.deepEqual([scores[1].complete, scores[1].score, scores[1].low], [false, null, null], 'hidden until every evaluation is in')
  assert.deepEqual([scores[3].reviews, scores[3].max_points], [0, null])
  const graderRows = cs.graderSummaries(evals)
  assert.deepEqual(graderRows.map(g => [g.grader, g.reviews, g.average]), [['g1', 3, 11], ['g2', 2, 16.5]])
  assert.ok(graderRows[1].spread_percent > 0)
  console.log('Seeded assignment order, mid-round top-up/release, interviewer pairs and candidate/grader score summaries passed.')
} finally { await rm(dir, { recursive: true, force: true }) }
