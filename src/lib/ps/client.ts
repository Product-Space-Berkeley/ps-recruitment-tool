export async function requestJson<T>(url: string, body?: unknown, method = 'POST'): Promise<T> {
  const endpoint = url.split('?')[0]
  let response: Response
  try {
    response = await fetch(url, { cache: 'no-store', ...(body === undefined && method === 'POST' ? {} : { method }), ...(body === undefined ? {} : body instanceof FormData ? { body } : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })
  } catch {
    throw new Error(`Could not reach ${endpoint}. Check your connection and retry.`)
  }
  const context = `${endpoint} (HTTP ${response.status})`
  if (response.redirected) throw new Error(`${context} redirected instead of returning API data. Sign in again and retry.`)
  const contentType = response.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase()
  if (!contentType || !/^application\/(?:json|[\w.+-]+\+json)$/.test(contentType)) throw new Error(`${context} returned a non-JSON response (${contentType || 'missing Content-Type'}). Please retry; if this persists, check the server logs.`)
  let text: string
  try { text = await response.text() } catch { throw new Error(`${context} could not be read. Please retry.`) }
  if (!text.trim()) throw new Error(`${context} returned an empty response. Please retry; if this persists, check the server logs.`)
  let data: unknown
  try { data = JSON.parse(text) } catch { throw new Error(`${context} returned invalid JSON. Please retry; if this persists, check the server logs.`) }
  if (!response.ok) {
    const message = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : 'The request failed. Please retry.'
    throw new Error(`${context}: ${message}`)
  }
  if (data === null) throw new Error(`${context} returned no API data. Please retry.`)
  return data as T
}

export async function requestArray<T>(url: string): Promise<T[]> {
  const data = await requestJson<unknown>(url)
  if (!Array.isArray(data)) throw new Error(`${url.split('?')[0]} returned an invalid list. Please retry; if this persists, check the server logs.`)
  return data as T[]
}
