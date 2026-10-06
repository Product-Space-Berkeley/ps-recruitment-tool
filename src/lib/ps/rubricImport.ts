import ExcelJS from 'exceljs'
import Papa from 'papaparse'
import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { WorkflowError } from './domain'
import type { Format, Purpose, Question, Structure } from './rubricV2'

export const IMPORT_LIMITS = { bytes: 3 * 1024 * 1024, expanded: 24 * 1024 * 1024, rows: 2000, columns: 200, entries: 512 }
export type ImportPreview = { structure: Structure; provenance: { kind: 'csv' | 'xlsx'; fingerprint: string; file_name: string; sheet: string }; excluded: { column: number; header: string; reason: string }[]; warnings: string[] }
function fail(s: string, status = 400): never { throw new WorkflowError(s, status) }
// Preflight every ZIP entry against actual bounded inflation, before the workbook library runs.
// ZIP64, macros, external links and encrypted packages are deliberately unsupported.
export function preflightXlsx(bytes: Buffer) {
  if (bytes.readUInt32LE(0) !== 0x04034b50) fail('The file is not an XLSX package.')
  let end = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (bytes.readUInt32LE(i) === 0x06054b50) { end = i; break }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) fail('Invalid or unsupported XLSX archive.')
  const count = bytes.readUInt16LE(end + 10), centralSize = bytes.readUInt32LE(end + 12), central = bytes.readUInt32LE(end + 16)
  if (!count || count > IMPORT_LIMITS.entries || central + centralSize !== end) fail('XLSX package exceeds the supported limits.')
  let cursor = central, total = 0, hasWorkbook = false
  const names = new Set<string>()
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) fail('Invalid XLSX directory.')
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), compressed = bytes.readUInt32LE(cursor + 20), expanded = bytes.readUInt32LE(cursor + 24)
    const length = bytes.readUInt16LE(cursor + 28), extra = bytes.readUInt16LE(cursor + 30), comment = bytes.readUInt16LE(cursor + 32), offset = bytes.readUInt32LE(cursor + 42)
    const name = bytes.subarray(cursor + 46, cursor + 46 + length).toString('utf8')
    if (names.has(name) || name.includes('..') || name.startsWith('/') || name.includes('\\') || /vbaProject|externalLinks/i.test(name) || flags & 1 || ![0, 8].includes(method) || expanded > IMPORT_LIMITS.expanded || offset + 30 > central) fail('Unsafe or unsupported XLSX entry.')
    names.add(name); hasWorkbook ||= name === 'xl/workbook.xml'
    if (bytes.readUInt32LE(offset) !== 0x04034b50) fail('Invalid XLSX entry.')
    const start = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28)
    if (start + compressed > central) fail('Invalid XLSX entry bounds.')
    const payload = bytes.subarray(start, start + compressed)
    let inflated: Buffer
    try { inflated = method === 8 ? inflateRawSync(payload, { maxOutputLength: IMPORT_LIMITS.expanded - total }) : payload } catch { fail('XLSX expanded data exceeds limits or is invalid.') }
    total += inflated!.length
    if (inflated!.length !== expanded || total > IMPORT_LIMITS.expanded) fail('XLSX expanded data exceeds limits or is invalid.')
    if (/xl\/worksheets\/.*\.xml$/.test(name)) {
      const xml = inflated!.toString('utf8')
      if (/<(?:\w+:)?f[\s>]/.test(xml)) fail('Formula-containing sheets are unsupported. Export a values-only template.')
      for (const match of xml.matchAll(/\br="([A-Z]+)(\d+)"/g)) {
        const column = [...match[1]].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0)
        if (column > IMPORT_LIMITS.columns || Number(match[2]) > IMPORT_LIMITS.rows) fail('Worksheet exceeds 200 columns or 2000 rows.')
      }
    }
    cursor += 46 + length + extra + comment
  }
  if (cursor !== end || !hasWorkbook || !names.has('[Content_Types].xml')) fail('The ZIP is not a supported XLSX workbook.')
}
const metadata = /^(timestamp|your name|grader name|co[- ]?interviewer|candidate (name|email|grade)|applicant (name|email|id)|email|grade|semester id|operation|totalscore|total score)/i
function canonical(rows: unknown[][], sheet: string, name: string, kind: 'csv' | 'xlsx', bytes: Buffer): ImportPreview {
  if (!rows.length || rows.length > IMPORT_LIMITS.rows || rows.some(r => r.length > IMPORT_LIMITS.columns)) fail('Sheet exceeds row/column limits or has no header.')
  const headers = rows[0]
  if (!headers.length || headers.some(h => typeof h !== 'string' || !h.trim() || h.length > 4000)) fail('The first row must contain nonempty text headers, at most 4000 characters each. Blank columns must be removed.')
  const excluded: ImportPreview['excluded'] = [], questions: Question[] = []
  headers.forEach((raw, i) => {
    const header = String(raw)
    if (metadata.test(header.trim())) { excluded.push({ column: i + 1, header, reason: 'Identity, administrative or historical output column; not a grading question.' }); return }
    let purpose: Purpose | null = null, format: Format | null = null, scale: Question['scale'] = null
    const hints: string[] = []
    if (/paste (?:the )?link|link to.*(?:interview|note)/i.test(header)) { purpose = 'QUALITATIVE'; format = 'url' }
    else if (/red\s*flag|concerns/i.test(header)) purpose = 'RED_FLAG'
    else if (/penalt/i.test(header)) purpose = 'PENALTY'
    else if (/bonus/i.test(header)) purpose = 'BONUS'
    else if (/next round|interview\s*level|wouldshowup|wouldcontribute|technical bar|show up and put|contribute something/i.test(header)) purpose = 'DECISION_SIGNAL'
    else if (/comments|notes|disagree|anything good/i.test(header)) { purpose = 'QUALITATIVE'; format = 'long_text' }
    if (purpose) hints.push('Purpose/format suggestions inferred from heading; confirm before publishing.')
    const observed = rows.slice(1).map(r => r[i]).filter(v => v !== null && v !== undefined && v !== '')
    // Never retain free-text response samples or historical rows in the preview/draft.
    if (observed.length && observed.every(v => typeof v === 'boolean' || (typeof v === 'string' && /^(yes|no)$/i.test(v.trim())))) { format = 'boolean'; hints.push('Yes/No observed; inferred format requires confirmation.') }
    else if (observed.length && observed.every(v => (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())))) {
      const values = [...new Set(observed.map(Number))].sort((a, b) => a - b)
      if (values.length > 1 && values.length <= 20) { format = 'number'; scale = { min: values[0], max: values[values.length - 1], step: Math.min(...values.slice(1).map((v, i) => v - values[i])) }; hints.push('Scale suggested from observed numbers; bounds/step may be incomplete. Confirm against the official rubric.') }
    }
    questions.push({ id: `column-${i + 1}`, category_id: 'imported', label: header, description: '', order: questions.length, purpose, format, scale, options: [], required: null, confirmed: false, source: { sheet, column: i + 1, header, suggestion: hints.join(' ') } })
  })
  if (!questions.length) fail('No grading questions found. Identity/administrative columns alone cannot form a rubric.')
  return { structure: { schema_version: 2, name: name.replace(/\.(xlsx|csv)$/i, '').slice(0, 200), categories: [{ id: 'imported', name: 'Imported questions — categorize before publication', order: 0, weight_bps: null }], questions, weighting: 'unconfigured' }, provenance: { kind, fingerprint: createHash('sha256').update(bytes).digest('hex'), file_name: name.slice(0, 200), sheet }, excluded, warnings: ['Structure only. No historical submissions, applicant data or uploaded file is saved.', 'Scales, options, purposes, required status, categories and weights need admin confirmation. No official score is calculated.'] }
}
export async function parseStructureFile(bytes: Buffer, name: string, sheetName?: string) {
  if (!bytes.length || bytes.length > IMPORT_LIMITS.bytes) fail('Upload must be between 1 byte and 3 MB.', 413)
  if (/Application \(Responses\)|\b(?:Vouch|Red Flag) Form/i.test(name)) fail('Application intake and operational vouch/red-flag forms are outside rubric structure import. Select a grading template.', 415)
  const extension = name.split('.').pop()?.toLowerCase()
  if (extension === 'csv') {
    let csv: string
    try { csv = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { fail('CSV must be UTF-8 text.') }
    if (csv!.includes('\0') || /[\x01-\x08\x0b\x0c\x0e-\x1f]/.test(csv!)) fail('CSV contains binary data.')
    const parsed = Papa.parse<string[]>(csv!, { skipEmptyLines: 'greedy' })
    if (parsed.errors.length) fail('CSV could not be parsed. Check quoting and delimiters.')
    return canonical(parsed.data, 'CSV', name, 'csv', bytes)
  }
  if (extension !== 'xlsx' || bytes.length < 22) fail('Only .xlsx and UTF-8 .csv structure files are supported.', 415)
  preflightXlsx(bytes)
  const workbook = new ExcelJS.Workbook()
  try { await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer) } catch { fail('Unable to read XLSX workbook.') }
  const sheets = workbook.worksheets.filter(s => s.state === 'visible')
  const sheet = sheetName ? sheets.find(s => s.name === sheetName) : sheets.length === 1 ? sheets[0] : undefined
  if (!sheet) fail(`Choose one visible worksheet: ${sheets.map(s => s.name).join(', ').slice(0, 1000)}`)
  if (sheet!.rowCount > IMPORT_LIMITS.rows || sheet!.columnCount > IMPORT_LIMITS.columns) fail('Worksheet exceeds supported row/column limits.')
  const rows: unknown[][] = []
  for (let i = 1; i <= sheet!.rowCount; i++) {
    const row: unknown[] = []
    for (let j = 1; j <= sheet!.columnCount; j++) {
      const v = sheet!.getRow(i).getCell(j).value
      row.push(v && typeof v === 'object' && 'richText' in v ? v.richText.map(t => t.text).join('') : typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : null)
    }
    rows.push(row)
  }
  return canonical(rows, sheet!.name, name, 'xlsx', bytes)
}

export async function readStructureUpload(req: Request) {
  const origin = req.headers.get('origin')
  if (req.headers.get('sec-fetch-site') === 'cross-site' || (origin && origin !== new URL(req.url).origin)) fail('Cross-site requests are not allowed.', 403)
  if (!req.headers.get('content-type')?.startsWith('multipart/form-data;')) fail('Use a multipart file upload.', 415)
  const limit = IMPORT_LIMITS.bytes + 64 * 1024
  if (Number(req.headers.get('content-length')) > limit || !req.body) fail('Upload body is too large or missing.', 413)
  const reader = req.body!.getReader(), chunks: Uint8Array[] = []
  let total = 0
  while (true) { const { done, value } = await reader.read(); if (done) break; total += value.length; if (total > limit) { await reader.cancel(); fail('Upload body exceeds 3 MB.', 413) } chunks.push(value) }
  let form: FormData
  try { form = await new Response(Buffer.concat(chunks), { headers: { 'Content-Type': req.headers.get('content-type')! } }).formData() } catch { fail('Invalid multipart upload.') }
  const file = form!.get('file'), sheet = form!.get('sheet')
  if (!(file instanceof File) || form!.getAll('file').length !== 1 || [...form!.keys()].some(k => !['file', 'sheet'].includes(k))) fail('Upload exactly one file, with an optional sheet name.')
  if (sheet !== null && (typeof sheet !== 'string' || sheet.length > 200)) fail('Invalid sheet name.')
  return parseStructureFile(Buffer.from(await (file as File).arrayBuffer()), (file as File).name, sheet as string | undefined)
}
