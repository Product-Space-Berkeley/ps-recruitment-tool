import Papa from 'papaparse'

export const MAX_COFFEE_CHAT_CSV_BYTES = 2 * 1024 * 1024
export const MAX_COFFEE_CHAT_ROWS = 5000

export type GoogleSheetSource = { sheetId: string; gid: string }

export function parseGoogleSheetUrl(value: string): GoogleSheetSource | null {
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com') return null
    const match = url.pathname.match(/^\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})(?:\/|$)/)
    if (!match) return null
    const hashParams = new URLSearchParams(url.hash.replace(/^#/, ''))
    const gid = url.searchParams.get('gid') ?? hashParams.get('gid') ?? '0'
    if (!/^\d+$/.test(gid)) return null
    return { sheetId: match[1], gid }
  } catch {
    return null
  }
}

export function googleSheetCsvUrl(source: GoogleSheetSource) {
  return `https://docs.google.com/spreadsheets/d/${source.sheetId}/export?format=csv&gid=${source.gid}`
}

export async function fetchGoogleSheetCsv(source: GoogleSheetSource) {
  const response = await fetch(googleSheetCsvUrl(source), {
    cache: 'no-store',
    redirect: 'follow',
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`Google Sheets returned HTTP ${response.status}.`)
  const declaredLength = Number(response.headers.get('content-length') ?? 0)
  if (declaredLength > MAX_COFFEE_CHAT_CSV_BYTES) throw new Error('Google Sheet CSV exceeds the 2 MB limit.')
  const csvText = await response.text()
  if (Buffer.byteLength(csvText, 'utf8') > MAX_COFFEE_CHAT_CSV_BYTES) {
    throw new Error('Google Sheet CSV exceeds the 2 MB limit.')
  }
  return csvText
}

export type CoffeeChatImportIssue = {
  row: number
  applicant_name: string
  reason: string
}

export type MatchedCoffeeChatRow = {
  source_row: number
  applicant_id: string
  applicant_name: string
  chatter_name: string
  notes: string
  is_coffee_chat: boolean
  recommended_overall: boolean | null
  chat_date: string | null
  other_notes: string | null
}

type ApplicantForMatch = {
  id: string
  first_name: string
  last_name: string
}

export type CoffeeChatImportPreview = {
  header_row: number
  source_rows: number
  coffee_chat_rows: number
  other_note_rows: number
  matched_rows: MatchedCoffeeChatRow[]
  issues: CoffeeChatImportIssue[]
  warnings: CoffeeChatImportIssue[]
}

export function normalizePersonName(value: string) {
  return value.normalize('NFKC').trim().toLocaleLowerCase('en-US').replace(/\s+/g, ' ')
}

function normalizeHeader(value: string) {
  return value.replace(/^\uFEFF/, '').normalize('NFKC').trim().toLocaleLowerCase('en-US').replace(/\s+/g, ' ')
}

function isCoffeeChat(value: string) {
  return new Set(['true', 'yes', 'y', '1', 'coffee chat']).has(normalizeHeader(value))
}

function parseRecommendation(value: string): boolean | null | undefined {
  const normalized = normalizeHeader(value)
  if (!normalized) return null
  if (new Set(['true', 'yes', 'y', '1', 'recommend']).has(normalized)) return true
  if (new Set(['false', 'no', 'n', '0', 'do not recommend']).has(normalized)) return false
  return undefined
}

function parseDateOnly(value: string): string | null | undefined {
  const raw = value.trim()
  if (!raw) return null

  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  const us = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  const parts = iso
    ? { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) }
    : us
      ? { year: Number(us[3]), month: Number(us[1]), day: Number(us[2]) }
      : null
  if (!parts) return undefined

  const test = new Date(Date.UTC(parts.year, parts.month - 1, parts.day))
  if (
    test.getUTCFullYear() !== parts.year ||
    test.getUTCMonth() !== parts.month - 1 ||
    test.getUTCDate() !== parts.day
  ) return undefined

  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

export function parseAndMatchCoffeeChatCsv(csvText: string, applicants: ApplicantForMatch[]): CoffeeChatImportPreview {
  const parsed = Papa.parse<string[]>(csvText.replace(/^\uFEFF/, ''), {
    header: false,
    skipEmptyLines: false,
    dynamicTyping: false,
  })

  const fatalParseErrors = parsed.errors.filter(error => error.type === 'Quotes' || error.type === 'Delimiter')
  if (fatalParseErrors.length) {
    throw new Error(`CSV could not be parsed: ${fatalParseErrors[0].message}`)
  }
  if (parsed.data.length > MAX_COFFEE_CHAT_ROWS) {
    throw new Error(`CSV exceeds the ${MAX_COFFEE_CHAT_ROWS.toLocaleString()} row limit.`)
  }

  const rows = parsed.data.map(row => row.map(cell => String(cell ?? '')))
  const headerIndex = rows.findIndex(row => {
    const headers = row.map(normalizeHeader)
    return headers.includes('plextech member') &&
      headers.includes('applicant') &&
      headers.includes('was this a coffee chat?') &&
      headers.some(header => header === 'notes' || header.startsWith('notes ('))
  })
  if (headerIndex < 0) {
    throw new Error('Could not find the coffee-chat header row. Expected PlexTech Member, Applicant, Notes, and Was this a Coffee Chat?.')
  }

  const headers = rows[headerIndex].map(normalizeHeader)
  const memberIndex = headers.indexOf('plextech member')
  const applicantIndex = headers.indexOf('applicant')
  const notesIndex = headers.findIndex(header => header === 'notes' || header.startsWith('notes ('))
  const coffeeIndex = headers.indexOf('was this a coffee chat?')
  const recommendationIndex = headers.findIndex(header => (
    header === 'recommend overall?' || header === 'recommend applicant?'
  ))
  const dateIndex = headers.indexOf('date')
  const otherNotesIndex = headers.indexOf('other notes')

  const applicantsByName = new Map<string, ApplicantForMatch[]>()
  for (const applicant of applicants) {
    const key = normalizePersonName(`${applicant.first_name} ${applicant.last_name}`)
    applicantsByName.set(key, [...(applicantsByName.get(key) ?? []), applicant])
  }

  const dataRows = rows.slice(headerIndex + 1)
  const nonEmptyRows = dataRows.filter(row => row.some(cell => cell.trim()))
  const matchedRows: MatchedCoffeeChatRow[] = []
  const issues: CoffeeChatImportIssue[] = []
  const warnings: CoffeeChatImportIssue[] = []
  let coffeeChatRows = 0
  let otherNoteRows = 0

  for (let offset = 0; offset < dataRows.length; offset++) {
    const row = dataRows[offset]
    if (!row.some(cell => cell.trim())) continue
    const markedCoffeeChat = isCoffeeChat(row[coffeeIndex] ?? '')
    const notes = (row[notesIndex] ?? '').trim()
    const otherNotes = otherNotesIndex >= 0 ? (row[otherNotesIndex] ?? '').trim() : ''
    if (!markedCoffeeChat && !notes && !otherNotes) continue
    if (markedCoffeeChat) coffeeChatRows++
    else otherNoteRows++
    const sourceRow = headerIndex + offset + 2
    const applicantName = (row[applicantIndex] ?? '').trim()
    const chatterName = (row[memberIndex] ?? '').trim()
    const issueTarget = markedCoffeeChat ? issues : warnings

    if (!applicantName) {
      issueTarget.push({ row: sourceRow, applicant_name: '', reason: 'Applicant name is missing.' })
      continue
    }
    if (!chatterName) {
      issueTarget.push({ row: sourceRow, applicant_name: applicantName, reason: 'PlexTech member name is missing.' })
      continue
    }

    const matches = applicantsByName.get(normalizePersonName(applicantName)) ?? []
    if (matches.length === 0) {
      issueTarget.push({ row: sourceRow, applicant_name: applicantName, reason: 'No applicant in this cycle has that exact name.' })
      continue
    }
    if (matches.length > 1) {
      issueTarget.push({ row: sourceRow, applicant_name: applicantName, reason: 'More than one applicant in this cycle has that name.' })
      continue
    }

    const rawDate = dateIndex >= 0 ? (row[dateIndex] ?? '') : ''
    const chatDate = parseDateOnly(rawDate)
    if (chatDate === undefined) {
      issueTarget.push({ row: sourceRow, applicant_name: applicantName, reason: `Date "${rawDate.trim()}" must use MM/DD/YYYY or YYYY-MM-DD.` })
      continue
    }

    const rawRecommendation = recommendationIndex >= 0 ? (row[recommendationIndex] ?? '') : ''
    const recommendedOverall = parseRecommendation(rawRecommendation)
    if (recommendedOverall === undefined) {
      issueTarget.push({
        row: sourceRow,
        applicant_name: applicantName,
        reason: `Recommend Overall? value "${rawRecommendation.trim()}" must be TRUE, FALSE, or blank.`,
      })
      continue
    }

    const applicant = matches[0]
    matchedRows.push({
      source_row: sourceRow,
      applicant_id: applicant.id,
      applicant_name: `${applicant.first_name} ${applicant.last_name}`.trim(),
      chatter_name: chatterName.slice(0, 200),
      notes: notes.slice(0, 10_000),
      is_coffee_chat: markedCoffeeChat,
      recommended_overall: recommendedOverall,
      chat_date: chatDate,
      other_notes: otherNotes.slice(0, 5_000) || null,
    })
  }

  return {
    header_row: headerIndex + 1,
    source_rows: nonEmptyRows.length,
    coffee_chat_rows: coffeeChatRows,
    other_note_rows: otherNoteRows,
    matched_rows: matchedRows,
    issues,
    warnings,
  }
}
