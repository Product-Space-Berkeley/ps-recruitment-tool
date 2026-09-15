import { NextRequest, NextResponse } from 'next/server'
import mongoose from 'mongoose'
import { connectDB } from '@/lib/mongodb'
import { AuthorizedUser, GraderAssignment, Review, SecurityLock } from '@/lib/models'
import { requireRole } from '@/lib/serverAuth'
import { isEmail, isObjectId, readJsonObject } from '@/lib/apiValidation'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole('admin')
  if (auth instanceof NextResponse) return auth

  await connectDB()
  const { id } = await params
  if (!isObjectId(id)) return NextResponse.json({ error: 'Invalid user id.' }, { status: 400 })
  const parsedBody = await readJsonObject(req)
  if (!parsedBody.ok) return parsedBody.response
  const body = parsedBody.data
  const validRoles = ['grader', 'leadership', 'admin']
  if ('role' in body && (typeof body.role !== 'string' || !validRoles.includes(body.role))) {
    return NextResponse.json({ error: 'invalid role' }, { status: 400 })
  }

  const allowed: Record<string, unknown> = {}
  if (body.role) allowed.role = body.role
  if (body.email) {
    if (!isEmail(body.email)) return NextResponse.json({ error: 'Invalid email.' }, { status: 400 })
    allowed.email = body.email.trim().toLowerCase()
  }
  if (Object.keys(allowed).length === 0) return NextResponse.json({ error: 'No valid updates supplied.' }, { status: 400 })

  let outcome: 'updated' | 'missing' | 'self-demotion' | 'self-email' | 'last-admin' = 'missing'
  let user: Record<string, unknown> | null = null
  try {
    await mongoose.connection.transaction(async session => {
      await SecurityLock.findOneAndUpdate(
        { _id: 'authorized-admins' },
        { $inc: { version: 1 } },
        { upsert: true, new: true, session },
      )
      const existing = await AuthorizedUser.findById(id).session(session).lean()
      if (!existing) return
      if (existing.email.toLowerCase() === auth.email && body.role && body.role !== 'admin') {
        outcome = 'self-demotion'
        return
      }
      if (
        existing.email.toLowerCase() === auth.email
        && typeof allowed.email === 'string'
        && allowed.email !== existing.email.toLowerCase()
      ) {
        // The current session is keyed by the old email. Letting an admin
        // rename their own identity would invalidate their next request and
        // can lock out the sole administrator without a verified handoff.
        outcome = 'self-email'
        return
      }
      if (existing.role === 'admin' && body.role && body.role !== 'admin') {
        const adminCount = await AuthorizedUser.countDocuments({ role: 'admin' }).session(session)
        if (adminCount <= 1) { outcome = 'last-admin'; return }
      }
      if (typeof allowed.email === 'string' && allowed.email !== existing.email) {
        // Keep identity-keyed grading records reachable after an administrator
        // corrects an email address. These writes also conflict with concurrent
        // assignment/review submissions that still reference the old identity.
        await GraderAssignment.updateMany(
          { grader_email: existing.email },
          { $set: { grader_email: allowed.email } },
          { session },
        )
        await Review.updateMany(
          { grader_email: existing.email },
          { $set: { grader_email: allowed.email } },
          { session },
        )
      }
      const updated = await AuthorizedUser.findByIdAndUpdate(id, allowed, { new: true, session }).lean()
      if (!updated) return
      outcome = 'updated'
      user = updated as unknown as Record<string, unknown>
    })
  } catch (error: unknown) {
    if (typeof error === 'object' && error && 'code' in error && error.code === 11000) {
      return NextResponse.json({ error: 'Email or grader records conflict with an existing account.' }, { status: 409 })
    }
    throw error
  }
  if (outcome === 'missing') return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (outcome === 'self-demotion') return NextResponse.json({ error: 'You cannot remove your own admin access.' }, { status: 409 })
  if (outcome === 'self-email') return NextResponse.json({ error: 'You cannot change your own admin email.' }, { status: 409 })
  if (outcome === 'last-admin') return NextResponse.json({ error: 'At least one admin is required.' }, { status: 409 })
  const userPayload = user as Record<string, unknown> | null
  if (!userPayload) return NextResponse.json({ error: 'Unable to update user.' }, { status: 500 })
  return NextResponse.json({ ...userPayload, id: String(userPayload._id), _id: undefined })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole('admin')
  if (auth instanceof NextResponse) return auth

  await connectDB()
  const { id } = await params
  if (!isObjectId(id)) return NextResponse.json({ error: 'Invalid user id.' }, { status: 400 })
  let outcome: 'deleted' | 'missing' | 'self-delete' | 'last-admin' = 'missing'
  await mongoose.connection.transaction(async session => {
    await SecurityLock.findOneAndUpdate(
      { _id: 'authorized-admins' },
      { $inc: { version: 1 } },
      { upsert: true, new: true, session },
    )
    const existing = await AuthorizedUser.findById(id).session(session).lean()
    if (!existing) return
    if (existing.email.toLowerCase() === auth.email) {
      outcome = 'self-delete'
      return
    }
    if (existing.role === 'admin') {
      const adminCount = await AuthorizedUser.countDocuments({ role: 'admin' }).session(session)
      if (adminCount <= 1) { outcome = 'last-admin'; return }
    }
    // Removing a grader revokes pending access immediately. Historical reviews
    // remain as an audit record, while all outstanding assignments are removed.
    await GraderAssignment.deleteMany({ grader_email: existing.email }, { session })
    await AuthorizedUser.findByIdAndDelete(id, { session })
    outcome = 'deleted'
  })
  if (outcome === 'missing') return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (outcome === 'self-delete') return NextResponse.json({ error: 'You cannot delete your own admin account.' }, { status: 409 })
  if (outcome === 'last-admin') return NextResponse.json({ error: 'At least one admin is required.' }, { status: 409 })
  return NextResponse.json({ ok: true })
}
