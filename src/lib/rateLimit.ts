import { createHmac } from 'crypto'
import { NextRequest } from 'next/server'
import { RateLimit } from '@/lib/models'

function clientAddress(req: NextRequest) {
  return (
    req.headers.get('x-vercel-forwarded-for')
    ?? req.headers.get('x-forwarded-for')
    ?? 'unknown'
  ).split(',')[0].trim()
}

export async function consumePublicRateLimit(
  req: NextRequest,
  scope: string,
  limit: number,
  windowMs: number,
) {
  const bucket = Math.floor(Date.now() / windowMs)
  const secret = process.env.NEXTAUTH_SECRET
  if (process.env.NODE_ENV === 'production' && !secret) {
    throw new Error('NEXTAUTH_SECRET is required in production.')
  }

  const id = createHmac('sha256', secret ?? 'local-development-only')
    .update(`${scope}:${clientAddress(req)}:${bucket}`)
    .digest('hex')

  const entry = await RateLimit.findByIdAndUpdate(
    id,
    {
      $inc: { count: 1 },
      $setOnInsert: { expires_at: new Date((bucket + 1) * windowMs) },
    },
    { upsert: true, new: true },
  ).lean()

  return (entry?.count ?? limit + 1) <= limit
}

export async function consumeUserRateLimit(
  email: string,
  scope: string,
  limit: number,
  windowMs: number,
) {
  const bucket = Math.floor(Date.now() / windowMs)
  const secret = process.env.NEXTAUTH_SECRET
  if (process.env.NODE_ENV === 'production' && !secret) {
    throw new Error('NEXTAUTH_SECRET is required in production.')
  }
  const id = createHmac('sha256', secret ?? 'local-development-only')
    .update(`${scope}:user:${email.trim().toLowerCase()}:${bucket}`)
    .digest('hex')
  const entry = await RateLimit.findByIdAndUpdate(
    id,
    {
      $inc: { count: 1 },
      $setOnInsert: { expires_at: new Date((bucket + 1) * windowMs) },
    },
    { upsert: true, new: true },
  ).lean()
  return (entry?.count ?? limit + 1) <= limit
}
