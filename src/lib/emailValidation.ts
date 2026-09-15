const BERKELEY_EMAIL_PATTERN = /^[^\s@]+@berkeley\.edu$/i

export function normalizeBerkeleyEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const email = value.trim().toLowerCase()
  return email.length <= 320 && BERKELEY_EMAIL_PATTERN.test(email) ? email : null
}

export function isBerkeleyEmail(value: unknown): value is string {
  return normalizeBerkeleyEmail(value) !== null
}
