#!/usr/bin/env node

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import ts from 'typescript'

const sourcePath = join(process.cwd(), 'src/lib/graderStats.ts')
const source = await readFile(sourcePath, 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  fileName: sourcePath,
}).outputText
const temporaryDirectory = await mkdtemp(join(process.cwd(), '.grader-stats-unit-'))
const compiledPath = join(temporaryDirectory, 'module.mjs')

try {
  await writeFile(compiledPath, compiled, { encoding: 'utf8', mode: 0o600 })
  const { summarizeGraderRatings } = await import(`${pathToFileURL(compiledPath).href}?v=${Date.now()}`)

  const summaries = summarizeGraderRatings([
    {
      grader_email: 'strict@berkeley.edu',
      r0: 3,
      r1: 1, r2: 2, r3: 1, r4: 2, r5: 1, r6: 2, r7: 1, r8: 2, r9: 1,
    },
    {
      grader_email: 'strict@berkeley.edu',
      r0: 1,
      r1: 2, r2: 1, r3: 2, r4: 1, r5: 2, r6: 1, r7: 2, r8: 1, r9: 2,
    },
    {
      grader_email: 'consistent@berkeley.edu',
      r0: 1,
      r1: 4, r2: 4, r3: 4, r4: 4, r5: 4, r6: 4, r7: 4, r8: 4, r9: 4,
    },
  ])

  const strict = summaries.get('strict@berkeley.edu')
  assert.equal(strict.ratingCount, 18)
  assert.equal(strict.averageRating, 1.5)
  assert.equal(strict.ratingStdDev, 0.5)
  assert.equal(
    strict.averageRating,
    1.5,
    'the separate 1–3 time-commitment flag must not affect the 1–4 rating average',
  )

  const consistent = summaries.get('consistent@berkeley.edu')
  assert.equal(consistent.ratingCount, 9)
  assert.equal(consistent.averageRating, 4)
  assert.equal(consistent.ratingStdDev, 0)

  console.log('Grader statistics unit checks passed.')
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true })
}
