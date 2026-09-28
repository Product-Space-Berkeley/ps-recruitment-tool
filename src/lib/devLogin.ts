// Server-only opt-in. Rechecked when reading sessions so disabling the flag
// also revokes already-issued development sessions.
export function devLoginEnabled(): boolean {
  if (process.env.NODE_ENV !== 'development' || process.env.DEV_LOGIN !== '1') return false
  try {
    const url = new URL(process.env.NEXTAUTH_URL ?? '')
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  } catch {
    return false
  }
}
