import Papa from 'papaparse'
import { CandidateData } from './types'

export interface ParsedCandidate {
  name: string
  data: CandidateData
}

function detectDelimiter(text: string): string {
  const firstLine = text.split('\n')[0] ?? ''
  const tabCount = (firstLine.match(/\t/g) ?? []).length
  const commaCount = (firstLine.match(/,/g) ?? []).length
  return tabCount >= commaCount ? '\t' : ','
}

export function parseDelibCSV(csvText: string): ParsedCandidate[] {
  const delimiter = detectDelimiter(csvText)

  const result = Papa.parse(csvText, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
    delimiter,
  })

  const rows = result.data as Record<string, string>[]

  return rows
    .filter((row) => {
      const name = row['Column 1'] || row['Name'] || row['name'] || ''
      return name.trim().length > 0
    })
    .map((row) => {
      const name = (row['Column 1'] || row['Name'] || row['name'] || '').trim()

      const score = parseFloat(row['Scores'] || row['Score'] || '')
      const coffeeChats = parseInt(row['Number of Coffee Chats'] || row['Coffee Chats'] || '0')
      const candidateNumber = parseInt(row['Candidate_Number'] || row['Candidate Number'] || '0')
      const essays = parseFloat(row['Essays'] || '')
      const essaysRaw = parseFloat(row['Essays Raw'] || '')
      const resume = parseFloat(row['Resume'] || '')
      const resumeRaw = parseFloat(row['Resume Raw'] || '')

      const data: CandidateData = {
        score: isNaN(score) ? undefined : score,
        coffee_chats: isNaN(coffeeChats) ? undefined : coffeeChats,
        linkedin: (row['LinkedIn'] || '').trim() || undefined,
        candidate_number: isNaN(candidateNumber) ? undefined : candidateNumber,
        graders: (row['Graders'] || '').trim() || undefined,
        essays: isNaN(essays) ? undefined : essays,
        essays_raw: isNaN(essaysRaw) ? undefined : essaysRaw,
        resume: isNaN(resume) ? undefined : resume,
        resume_raw: isNaN(resumeRaw) ? undefined : resumeRaw,
        resume_link: (row['Resume Link'] || '').trim() || undefined,
        initial_vouch: (row['Vouch?'] || '').trim() || undefined,
        initial_anti_vouch: (row['Anit-vouch'] || row['Anti-vouch'] || '').trim() || undefined,
      }

      return { name, data }
    })
}
