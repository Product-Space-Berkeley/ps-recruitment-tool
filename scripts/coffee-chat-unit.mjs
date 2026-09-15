#!/usr/bin/env node

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import ts from 'typescript'

const sourcePath = join(process.cwd(), 'src/lib/coffeeChats.ts')
const source = await readFile(sourcePath, 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
  },
  fileName: sourcePath,
}).outputText
const temporaryDirectory = await mkdtemp(join(process.cwd(), '.coffee-chat-unit-'))
const compiledPath = join(temporaryDirectory, 'module.mjs')

try {
  await writeFile(compiledPath, compiled, { encoding: 'utf8', mode: 0o600 })
  const { fetchGoogleSheetCsv, googleSheetCsvUrl, parseAndMatchCoffeeChatCsv, parseGoogleSheetUrl } = await import(`${pathToFileURL(compiledPath).href}?v=${Date.now()}`)
  const sheetSource = parseGoogleSheetUrl('https://docs.google.com/spreadsheets/d/1abcdefghijklmnopqrstuvwxyz123456789/edit?gid=42#gid=42')
  assert.deepEqual(sheetSource, { sheetId: '1abcdefghijklmnopqrstuvwxyz123456789', gid: '42' })
  assert.equal(
    googleSheetCsvUrl(sheetSource),
    'https://docs.google.com/spreadsheets/d/1abcdefghijklmnopqrstuvwxyz123456789/export?format=csv&gid=42',
  )
  assert.equal(parseGoogleSheetUrl('https://example.com/spreadsheets/d/1abcdefghijklmnopqrstuvwxyz123456789/edit?gid=42'), null)
  assert.equal(parseGoogleSheetUrl('https://docs.google.com/spreadsheets/d/1abcdefghijklmnopqrstuvwxyz123456789/edit?gid=not-a-number'), null)
  if (process.env.COFFEE_CHAT_SHEET_URL) {
    const liveSource = parseGoogleSheetUrl(process.env.COFFEE_CHAT_SHEET_URL)
    assert.ok(liveSource)
    const liveCsv = await fetchGoogleSheetCsv(liveSource)
    assert.match(liveCsv, /PlexTech Member/)
    assert.match(liveCsv, /Was this a Coffee Chat\?/)
  }
  const applicants = [
    { id: '1', first_name: 'Ada', last_name: 'Lovelace' },
    { id: '2', first_name: 'Grace', last_name: 'Hopper' },
  ]
  const csv = [
    'f',
    'PlexTech Member,Applicant,Notes,Was this a Coffee Chat?,Recommend Overall?,Date,Other notes',
    'Member One,Ada Lovelace,Strong conversation,TRUE,TRUE,09/01/2026,Follow up',
    'Member Two,Grace Hopper,Not a fit,TRUE,FALSE,09/02/2026,',
    'Member Three,Ada Lovelace,Helpful non-coffee context,FALSE,,09/03/2026,Met at an event',
    'Member Four,Unknown Person,Unmatched non-coffee context,FALSE,,09/04/2026,',
    'Member Five,Unknown Person,,FALSE,,09/05/2026,',
  ].join('\n')

  const preview = parseAndMatchCoffeeChatCsv(csv, applicants)
  assert.equal(preview.issues.length, 0)
  assert.equal(preview.warnings.length, 1)
  assert.match(preview.warnings[0].reason, /No applicant/)
  assert.equal(preview.coffee_chat_rows, 2)
  assert.equal(preview.other_note_rows, 2)
  assert.equal(preview.matched_rows.length, 3)
  assert.equal(preview.matched_rows[0].recommended_overall, true)
  assert.equal(preview.matched_rows[1].recommended_overall, false)
  assert.equal(preview.matched_rows[2].is_coffee_chat, false)

  const invalid = parseAndMatchCoffeeChatCsv(csv.replace(',TRUE,09/01/2026', ',MAYBE,09/01/2026'), applicants)
  assert.equal(invalid.issues.length, 1)
  assert.match(invalid.issues[0].reason, /must be TRUE, FALSE, or blank/)

  console.log('Coffee-chat import unit checks passed.')
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true })
}
