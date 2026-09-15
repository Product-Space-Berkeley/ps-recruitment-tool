import { NextRequest, NextResponse } from 'next/server'
import mongoose from 'mongoose'
import { connectDB } from '@/lib/mongodb'
import { RecruitmentCycle } from '@/lib/models'
import { requireRole } from '@/lib/serverAuth'
import { isNonEmptyString, readJsonObject } from '@/lib/apiValidation'

export async function GET() {
  await connectDB()

  // The public application portal (/apply) needs this endpoint to find the open
  // cycle, and applicants have no accounts — so unauthenticated callers get only
  // cycles currently accepting applications. Members see the full history.
  const auth = await requireRole('grader')
  const isMember = !(auth instanceof NextResponse)

  const filter = isMember
    ? {}
    : {
        status: 'active',
        accepting_applications: true,
        application_deadline: mongoose.trusted({ $gt: new Date() }),
      }
  const cycles = await RecruitmentCycle.find(filter).sort({ created_at: -1 }).lean()
  const payload = cycles.map(c => isMember
    ? { ...c, id: c._id.toString(), _id: undefined }
    : {
        id: c._id.toString(),
        name: c.name,
        status: c.status,
        accepting_applications: c.accepting_applications,
        application_deadline: c.application_deadline,
      })
  return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store, max-age=0' } })
}

export async function POST(req: NextRequest) {
  const auth = await requireRole('leadership')
  if (auth instanceof NextResponse) return auth

  await connectDB()
  const parsedBody = await readJsonObject(req)
  if (!parsedBody.ok) return parsedBody.response
  const body = parsedBody.data
  const { name, status = 'active' } = body
  if (!isNonEmptyString(name, 100)) return NextResponse.json({ error: 'A cycle name is required.' }, { status: 400 })
  if (status !== 'active' && status !== 'ended') return NextResponse.json({ error: 'Invalid cycle status.' }, { status: 400 })

  const cycle = await RecruitmentCycle.create({ name: name.trim(), status })
  return NextResponse.json({ ...cycle.toObject(), id: cycle._id.toString(), _id: undefined }, { status: 201 })
}
