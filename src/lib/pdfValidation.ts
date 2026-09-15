import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFObject,
  PDFStream,
} from 'pdf-lib'

const MAX_PDF_OBJECTS_TO_INSPECT = 50_000
const MAX_PDF_OBJECT_DEPTH = 30

// Block executable or embedded payloads rather than harmless PDF structure.
// Common exporters add AcroForm, OpenAction, additional-action, file-spec, and
// external-navigation metadata to otherwise ordinary resumes. Those wrappers
// are allowed; dangerous values nested inside them (JavaScript, Launch, XFA,
// SubmitForm, embedded files, and multimedia) are still found by the recursive
// scan and rejected below.
const BLOCKED_PDF_FEATURES: Record<string, string> = {
  EF: 'an embedded file',
  EmbeddedFile: 'an embedded file',
  EmbeddedFiles: 'an embedded file',
  ImportData: 'an external data import action',
  JavaScript: 'embedded JavaScript',
  JS: 'embedded JavaScript',
  Launch: 'a program-launch action',
  Movie: 'embedded video',
  Rendition: 'embedded multimedia',
  RichMedia: 'embedded rich media',
  Sound: 'embedded audio',
  SubmitForm: 'an automatic form-submission action',
  '3D': 'embedded 3D content',
  XFA: 'active XFA form content',
}

const BLOCKED_PDF_NAMES = new Set(Object.keys(BLOCKED_PDF_FEATURES))

export type PdfValidationResult =
  | { ok: true }
  | { ok: false; error: string }

function decodedName(name: PDFName) {
  try {
    return name.decodeText()
  } catch {
    return name.asString().replace(/^\//, '')
  }
}

type PdfInspectionIssue =
  | { kind: 'blocked-feature'; name: string }
  | { kind: 'complexity-limit' }

function findPdfInspectionIssue(objects: PDFObject[]): PdfInspectionIssue | null {
  const stack = objects.map(object => ({ object, depth: 0 }))
  const visited = new Set<PDFObject>()
  let inspected = 0

  while (stack.length > 0) {
    const current = stack.pop()!
    if (visited.has(current.object)) continue
    visited.add(current.object)
    inspected += 1
    if (inspected > MAX_PDF_OBJECTS_TO_INSPECT || current.depth > MAX_PDF_OBJECT_DEPTH) {
      return { kind: 'complexity-limit' }
    }

    if (current.object instanceof PDFName) {
      const name = decodedName(current.object)
      if (BLOCKED_PDF_NAMES.has(name)) return { kind: 'blocked-feature', name }
      continue
    }
    if (current.object instanceof PDFStream) {
      stack.push({ object: current.object.dict, depth: current.depth + 1 })
      continue
    }
    if (current.object instanceof PDFDict) {
      for (const [key, value] of current.object.entries()) {
        const name = decodedName(key)
        if (BLOCKED_PDF_NAMES.has(name)) return { kind: 'blocked-feature', name }
        stack.push({ object: value, depth: current.depth + 1 })
      }
      continue
    }
    if (current.object instanceof PDFArray) {
      for (const value of current.object.asArray()) {
        stack.push({ object: value, depth: current.depth + 1 })
      }
    }
  }

  return null
}

export async function validateResumePdf(bytes: Uint8Array): Promise<PdfValidationResult> {
  let document: PDFDocument
  try {
    document = await PDFDocument.load(bytes, {
      ignoreEncryption: false,
      throwOnInvalidObject: true,
      updateMetadata: false,
      capNumbers: true,
    })
  } catch (error) {
    const parserMessage = error instanceof Error ? error.message : ''
    if (/encrypt/i.test(parserMessage)) {
      return { ok: false, error: 'The resume PDF is password-protected or encrypted. Please export an unencrypted copy and try again.' }
    }
    if (/header/i.test(parserMessage)) {
      return { ok: false, error: 'The resume could not be parsed because it does not have a readable PDF header. Please re-export or print it as a new PDF and try again.' }
    }
    return { ok: false, error: 'The resume PDF could not be parsed because its file structure is invalid or unsupported. Please re-export or print it as a new PDF and try again.' }
  }

  if (document.isEncrypted) {
    return { ok: false, error: 'Encrypted PDFs are not accepted.' }
  }
  if (document.getPageCount() !== 1) {
    return { ok: false, error: 'Please upload a one-page resume.' }
  }

  const indirectObjects = document.context.enumerateIndirectObjects().map(([, object]) => object)
  const inspectionIssue = findPdfInspectionIssue([document.catalog, ...indirectObjects])
  if (inspectionIssue?.kind === 'complexity-limit') {
    return {
      ok: false,
      error: 'The resume PDF is too complex to inspect safely. Please re-export or print it as a flattened one-page PDF and try again.',
    }
  }
  if (inspectionIssue?.kind === 'blocked-feature') {
    const description = BLOCKED_PDF_FEATURES[inspectionIssue.name] ?? 'an unsupported active feature'
    return {
      ok: false,
      error: `The resume PDF contains ${description} (PDF feature /${inspectionIssue.name}), which is not accepted. Please re-export or print it as a standard one-page PDF and try again.`,
    }
  }

  return { ok: true }
}
