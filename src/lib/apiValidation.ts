import mongoose from 'mongoose'
import { NextResponse } from 'next/server.js'

const DEFAULT_MAX_JSON_BYTES = 1_000_000
const MAX_JSON_DEPTH = 20
const MAX_JSON_NODES = 20_000

export type JsonBodyResult =
  | { ok: true; data: unknown }
  | { ok: false; response: NextResponse }

export type JsonObjectResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; response: NextResponse }

export type JsonArrayResult =
  | { ok: true; data: unknown[] }
  | { ok: false; response: NextResponse }

function jsonError(message: string, status: number) {
  return { ok: false as const, response: NextResponse.json({ error: message }, { status }) }
}

function findUnsafeJsonKey(value: unknown): string | null {
  const stack: Array<{ value: unknown; path: string; depth: number }> = [
    { value, path: '$', depth: 0 },
  ]
  let nodes = 0

  while (stack.length > 0) {
    const current = stack.pop()!
    nodes += 1
    if (nodes > MAX_JSON_NODES) return 'JSON body is too complex.'
    if (current.depth > MAX_JSON_DEPTH) return 'JSON body is nested too deeply.'

    if (Array.isArray(current.value)) {
      for (let i = 0; i < current.value.length; i += 1) {
        stack.push({ value: current.value[i], path: `${current.path}[${i}]`, depth: current.depth + 1 })
      }
      continue
    }

    if (!isPlainRecord(current.value)) continue
    for (const [key, child] of Object.entries(current.value)) {
      // MongoDB treats leading `$` and dots as query/update syntax. The three
      // prototype-related names are rejected as an additional defense when
      // objects are later copied or merged.
      if (key.startsWith('$') || key.includes('.') || key === '__proto__' || key === 'prototype' || key === 'constructor') {
        return `Unsafe JSON key at ${current.path}.`
      }
      stack.push({ value: child, path: `${current.path}.${key}`, depth: current.depth + 1 })
    }
  }

  return null
}

export async function readJsonBody(
  req: Request,
  maxBytes = DEFAULT_MAX_JSON_BYTES,
): Promise<JsonBodyResult> {
  const fetchSite = req.headers.get('sec-fetch-site')?.toLowerCase()
  if (fetchSite === 'cross-site') {
    return jsonError('Cross-site requests are not allowed.', 403)
  }
  const origin = req.headers.get('origin')
  if (origin) {
    try {
      if (new URL(origin).origin !== new URL(req.url).origin) {
        return jsonError('Request origin is not allowed.', 403)
      }
    } catch {
      return jsonError('Request origin is invalid.', 403)
    }
  }

  const contentType = req.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') {
    return jsonError('Content-Type must be application/json.', 415)
  }

  const declaredLength = Number(req.headers.get('content-length') ?? 0)
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return jsonError('Request body is too large.', 413)
  }

  const body = req.body
  if (!body) return jsonError('Request body is required.', 400)

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        await reader.cancel('Request body exceeds the configured limit.')
        return jsonError('Request body is too large.', 413)
      }
      chunks.push(value)
    }
  } catch {
    return jsonError('Unable to read request body.', 400)
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return jsonError('Request body must be valid UTF-8.', 400)
  }

  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return jsonError('Request body must contain valid JSON.', 400)
  }

  const unsafe = findUnsafeJsonKey(data)
  if (unsafe) return jsonError(unsafe, 400)
  return { ok: true, data }
}

export async function readJsonObject(req: Request, maxBytes?: number): Promise<JsonObjectResult> {
  const result = await readJsonBody(req, maxBytes)
  if (!result.ok) return result
  if (!isPlainRecord(result.data)) return jsonError('Request body must be a JSON object.', 400)
  return { ok: true, data: result.data }
}

export async function readJsonArray(req: Request, maxBytes?: number): Promise<JsonArrayResult> {
  const result = await readJsonBody(req, maxBytes)
  if (!result.ok) return result
  if (!Array.isArray(result.data)) return jsonError('Request body must be a JSON array.', 400)
  return { ok: true, data: result.data }
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f\d]{24}$/i.test(value) && mongoose.isObjectIdOrHexString(value)
}

export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z0-9]{6}$/.test(value)
}

export function isEmail(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

export function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength
}

export function normalizeHttpUrl(value: unknown, maxLength = 500): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  const raw = value.trim()
  if (raw.length > maxLength) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    if (url.username || url.password) return null
    return url.toString()
  } catch {
    return null
  }
}

export function isNullableObjectId(value: unknown): value is string | null {
  return value === null || isObjectId(value)
}
