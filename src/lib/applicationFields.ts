// Options and limits shared by the application form and the submission API.

export const APPLICANT_YEARS = ['Freshman', 'Sophomore', 'Junior (non-transfer)', 'Junior (transfer)', 'Senior']

export const RACE_OPTIONS = [
  'American Indian or Alaska Native',
  'Asian',
  'Native Hawaiian or Other Pacific Islander',
  'Black or African American',
  'White',
]
// A free-text race entry is stored as `${RACE_OTHER_PREFIX}<text>`.
export const RACE_OTHER_PREFIX = 'Other: '
export const MAX_RACE_OTHER_LENGTH = 100

export const ETHNICITY_OPTIONS = ['Hispanic', 'Not Hispanic']

export const MEETING_CONFIRMATION = 'I confirm that I blocked this time in my calendar.'
export const RETREAT_CONFIRMATION = 'I confirm that I blocked these dates in my calendar.'
export const MAX_AVAILABILITY_NOTE_LENGTH = 500

export const MIN_PROMPTS = 1
export const MAX_PROMPTS = 3
export const MAX_WORD_LIMIT = 1000
// Applies to every essay; prompts saved before word limits existed use the
// legacy 1,500-character cap instead of a word count.
export const MAX_ESSAY_CHARACTERS = 5000
export const LEGACY_ESSAY_CHARACTERS = 1500

export const MAX_RESUME_BYTES = 3 * 1024 * 1024
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024
export const PHOTO_TYPES = ['image/jpeg', 'image/png'] as const

export function countWords(text: string): number {
  const trimmed = text.trim()
  return trimmed ? trimmed.split(/\s+/).length : 0
}

// Returns an error message, or null when the response fits the prompt's limit.
export function essayLimitError(response: string, wordLimit: number | null | undefined): string | null {
  const characterLimit = typeof wordLimit === 'number' ? MAX_ESSAY_CHARACTERS : LEGACY_ESSAY_CHARACTERS
  if (response.length > characterLimit) {
    return `This answer is ${response.length.toLocaleString()} characters, but the limit is ${characterLimit.toLocaleString()}. `
      + `Remove at least ${(response.length - characterLimit).toLocaleString()} characters.`
  }
  if (typeof wordLimit !== 'number') return null
  const words = countWords(response)
  return words > wordLimit
    ? `This answer is ${words} words, but the limit is ${wordLimit}. Remove at least ${words - wordLimit} ${words - wordLimit === 1 ? 'word' : 'words'}.`
    : null
}
