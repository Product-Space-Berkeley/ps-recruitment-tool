#!/usr/bin/env node

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import ts from 'typescript'
import { PDFDocument, PDFName } from 'pdf-lib'

async function loadTypeScriptModule(relativePath) {
  // Compile the real TypeScript module into a temporary ESM file so this test
  // also works on Node 20, which cannot import .ts files directly. Keeping the
  // temporary directory under the project root lets Node resolve dependencies
  // from this project's node_modules directory.
  const sourcePath = join(process.cwd(), relativePath)
  const source = await readFile(sourcePath, 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: sourcePath,
  }).outputText

  const temporaryDirectory = await mkdtemp(join(process.cwd(), '.security-unit-'))
  const compiledPath = join(temporaryDirectory, 'module.mjs')
  await writeFile(compiledPath, compiled, { encoding: 'utf8', mode: 0o600 })
  return {
    module: await import(`${pathToFileURL(compiledPath).href}?v=${Date.now()}`),
    cleanup: () => rm(temporaryDirectory, { recursive: true, force: true }),
  }
}

function jsonRequest(value, headers = {}) {
  return new Request('http://127.0.0.1:5173/api/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(value),
  })
}

async function responseBody(result) {
  assert.equal(result.ok, false)
  return result.response.json()
}

async function main() {
  const validationModule = await loadTypeScriptModule('src/lib/apiValidation.ts')
  const emailModule = await loadTypeScriptModule('src/lib/emailValidation.ts')
  const pdfModule = await loadTypeScriptModule('src/lib/pdfValidation.ts')
  const validation = validationModule.module
  const {
    isEmail,
    isObjectId,
    isSessionId,
    normalizeHttpUrl,
    readJsonArray,
    readJsonObject,
  } = validation
  const { validateResumePdf } = pdfModule.module
  const { isBerkeleyEmail, normalizeBerkeleyEmail } = emailModule.module
  const reassignmentRouteSource = await readFile(
    join(process.cwd(), 'src/app/api/grader-assignments/reassign/route.ts'),
    'utf8',
  )
  const bulkStatusRouteSource = await readFile(
    join(process.cwd(), 'src/app/api/candidates/bulk-status/route.ts'),
    'utf8',
  )
  const resumeRouteSource = await readFile(
    join(process.cwd(), 'src/app/api/applicants/[id]/resume/route.ts'),
    'utf8',
  )
  const voteResetRouteSource = await readFile(
    join(process.cwd(), 'src/app/api/votes/reset/route.ts'),
    'utf8',
  )

  try {
    const valid = await readJsonObject(jsonRequest({ name: 'PlexTech', nested: { ok: true } }))
    assert.equal(valid.ok, true)

    for (const payload of [
      { id: { $ne: null } },
      { 'profile.role': 'admin' },
      JSON.parse('{"__proto__":{"admin":true}}'),
      { nested: { constructor: { prototype: { polluted: true } } } },
    ]) {
      const result = await readJsonObject(jsonRequest(payload))
      assert.equal(result.ok, false, `unsafe payload unexpectedly passed: ${JSON.stringify(payload)}`)
      assert.equal(result.response.status, 400)
    }

    const wrongType = await readJsonArray(jsonRequest({ not: 'an array' }))
    assert.equal(wrongType.ok, false)
    assert.equal(wrongType.response.status, 400)

    const wrongContentType = await readJsonObject(new Request('http://127.0.0.1:5173/api/test', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    }))
    assert.equal(wrongContentType.ok, false)
    assert.equal(wrongContentType.response.status, 415)

    const crossOrigin = await readJsonObject(jsonRequest({}, { origin: 'https://attacker.example' }))
    assert.equal(crossOrigin.ok, false)
    assert.equal(crossOrigin.response.status, 403)

    let emitted = false
    const oversizedStream = new ReadableStream({
      pull(controller) {
        if (emitted) return controller.close()
        emitted = true
        controller.enqueue(new TextEncoder().encode(`{"payload":"${'x'.repeat(2048)}"}`))
      },
    })
    const oversized = await readJsonObject(new Request('http://127.0.0.1:5173/api/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: oversizedStream,
      duplex: 'half',
    }), 512)
    assert.equal(oversized.ok, false)
    assert.equal(oversized.response.status, 413)
    assert.deepEqual(await responseBody(oversized), { error: 'Request body is too large.' })

    assert.equal(isObjectId('507f1f77bcf86cd799439011'), true)
    assert.equal(isObjectId('$ne'), false)
    assert.equal(isSessionId('AB12CD'), true)
    assert.equal(isSessionId('../BAD'), false)
    assert.equal(isEmail('student@berkeley.edu'), true)
    assert.equal(isEmail('student@berkeley.edu\nattacker@example.com'), false)
    assert.equal(isBerkeleyEmail('student@berkeley.edu'), true)
    assert.equal(isBerkeleyEmail('student@BERKELEY.EDU'), true)
    assert.equal(isBerkeleyEmail('student@gmail.com'), false)
    assert.equal(isBerkeleyEmail('student@berkeley.edu.attacker.example'), false)
    assert.equal(isBerkeleyEmail('student@berkeley.edu\nattacker@example.com'), false)
    assert.equal(normalizeBerkeleyEmail(' Student@BERKELEY.EDU '), 'student@berkeley.edu')
    assert.equal(normalizeHttpUrl('javascript:alert(1)'), null)
    assert.equal(normalizeHttpUrl('https://user:pass@example.com'), null)
    assert.equal(normalizeHttpUrl('https://example.com/path'), 'https://example.com/path')

    assert.match(
      reassignmentRouteSource,
      /requireRole\('admin'\)/,
      'grader reassignment must remain admin-only',
    )
    assert.match(
      bulkStatusRouteSource,
      /requireRole\('grader'\)/,
      'bulk candidate status updates must require an authenticated portal member',
    )
    assert.match(
      bulkStatusRouteSource,
      /if \(auth\.role !== 'admin'\) sessionFilter\.created_by = auth\.email/,
      'bulk candidate status updates must remain limited to admins or the session creator',
    )
    assert.match(
      bulkStatusRouteSource,
      /mongoose\.connection\.transaction/,
      'bulk candidate status updates must be transactional',
    )
    assert.match(
      bulkStatusRouteSource,
      /candidates\.length !== uniqueIds\.length/,
      'bulk candidate status updates must reject cross-session candidate IDs atomically',
    )
    assert.match(
      resumeRouteSource,
      /SessionMember\.exists/,
      'deliberation resume access must require membership for regular graders',
    )
    assert.match(
      resumeRouteSource,
      /Content-Disposition': 'inline; filename="resume\.pdf"'/,
      'inline resume responses must use a fixed safe filename',
    )
    assert.match(
      voteResetRouteSource,
      /if \(auth\.role !== 'admin'\) sessionFilter\.created_by = auth\.email/,
      'vote resets must remain limited to admins or the session creator',
    )
    assert.match(
      voteResetRouteSource,
      /vote_type: mongoose\.trusted\(\{ \$in: \['vouch', 'anti_vouch'\] \}\)/,
      'vote resets must preserve red flags',
    )
    assert.match(
      voteResetRouteSource,
      /mongoose\.connection\.transaction/,
      'vote resets must remain transactional',
    )

    const validPdf = await PDFDocument.create({ updateMetadata: false })
    validPdf.addPage()
    assert.deepEqual(await validateResumePdf(await validPdf.save()), { ok: true })

    const twoPagePdf = await PDFDocument.create({ updateMetadata: false })
    twoPagePdf.addPage()
    twoPagePdf.addPage()
    assert.equal((await validateResumePdf(await twoPagePdf.save())).ok, false)

    const activePdf = await PDFDocument.create({ updateMetadata: false })
    activePdf.addPage()
    activePdf.catalog.set(PDFName.of('OpenAction'), PDFName.of('JavaScript'))
    const activePdfResult = await validateResumePdf(await activePdf.save())
    assert.equal(activePdfResult.ok, false)
    assert.match(activePdfResult.error, /embedded JavaScript.*\/JavaScript/)

    // Navigation and external-file metadata are common in exported resumes.
    // They are safe when they do not contain an executable or embedded payload.
    const externalLinkPdf = await PDFDocument.create({ updateMetadata: false })
    externalLinkPdf.addPage()
    externalLinkPdf.catalog.set(
      PDFName.of('OpenAction'),
      externalLinkPdf.context.obj({
        S: PDFName.of('GoToR'),
        F: { Type: PDFName.of('Filespec'), F: 'portfolio.pdf' },
      }),
    )
    assert.deepEqual(await validateResumePdf(await externalLinkPdf.save()), { ok: true })

    const attachmentPdf = await PDFDocument.create({ updateMetadata: false })
    attachmentPdf.addPage()
    await attachmentPdf.attach(Uint8Array.of(1, 2, 3), 'payload.bin')
    const attachmentPdfResult = await validateResumePdf(await attachmentPdf.save())
    assert.equal(attachmentPdfResult.ok, false)
    assert.match(attachmentPdfResult.error, /embedded file.*\/(?:EF|EmbeddedFile|EmbeddedFiles)/)

    // Common PDF exporters may leave an empty AcroForm dictionary even when
    // the resume has no executable behavior. This metadata is safe to accept.
    const benignFormPdf = await PDFDocument.create({ updateMetadata: false })
    benignFormPdf.addPage()
    benignFormPdf.catalog.set(
      PDFName.of('AcroForm'),
      benignFormPdf.context.obj({ Fields: [] }),
    )
    assert.deepEqual(await validateResumePdf(await benignFormPdf.save()), { ok: true })

    // Active form features remain rejected even though AcroForm itself is
    // allowed. XFA can contain executable or externally supplied behavior.
    const activeFormPdf = await PDFDocument.create({ updateMetadata: false })
    activeFormPdf.addPage()
    activeFormPdf.catalog.set(
      PDFName.of('AcroForm'),
      activeFormPdf.context.obj({ Fields: [], XFA: PDFName.of('Payload') }),
    )
    const activeFormPdfResult = await validateResumePdf(await activeFormPdf.save())
    assert.equal(activeFormPdfResult.ok, false)
    assert.match(activeFormPdfResult.error, /active XFA form content.*\/XFA/)

    const invalidPdfResult = await validateResumePdf(Uint8Array.of(1, 2, 3))
    assert.equal(invalidPdfResult.ok, false)
    assert.match(invalidPdfResult.error, /readable PDF header/)

    console.log('Security unit checks passed.')
  } finally {
    await Promise.all([validationModule.cleanup(), emailModule.cleanup(), pdfModule.cleanup()])
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
