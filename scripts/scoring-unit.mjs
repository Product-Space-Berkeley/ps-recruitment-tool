#!/usr/bin/env node

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import ts from 'typescript'

const sourcePath = join(process.cwd(), 'src/lib/scoring.ts')
const source = await readFile(sourcePath, 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  fileName: sourcePath,
}).outputText
const temporaryDirectory = await mkdtemp(join(process.cwd(), '.scoring-unit-'))
const compiledPath = join(temporaryDirectory, 'module.mjs')

try {
  await writeFile(compiledPath, compiled, { encoding: 'utf8', mode: 0o600 })
  const { evaluateResults } = await import(`${pathToFileURL(compiledPath).href}?v=${Date.now()}`)

  const applicants = [
    {
      id: 'freshman',
      first_name: 'Freshman',
      last_name: 'Applicant',
      desired_roles: 'Industry Developer',
      year: 'Freshman',
    },
    {
      id: 'senior',
      first_name: 'Senior',
      last_name: 'Applicant',
      desired_roles: 'Industry Developer',
      year: 'Senior',
    },
  ]
  const reviews = applicants.map(applicant => ({
    grader_email: 'grader@berkeley.edu',
    applicant_id: applicant.id,
    r0: 3,
    r1: 3, r2: 3, r3: 3, r4: 3, r5: 3,
    r6: 3, r7: 3, r8: 3, r9: 3,
  }))

  const results = evaluateResults(reviews, applicants)
  const freshman = results.find(result => result.applicant_id === 'freshman')
  const senior = results.find(result => result.applicant_id === 'senior')

  assert.ok(freshman)
  assert.ok(senior)
  assert.equal(
    freshman.total,
    senior.total,
    'class year must not affect an applicant score',
  )

  console.log('Scoring unit checks passed.')
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true })
}
