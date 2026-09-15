import { NextRequest, NextResponse } from 'next/server'
import { connectDB } from '@/lib/mongodb'
import { AuthorizedUser } from '@/lib/models'
import { requireRole } from '@/lib/serverAuth'
import { isEmail, readJsonObject } from '@/lib/apiValidation'

export async function GET() {
  const auth = await requireRole('admin')
  if (auth instanceof NextResponse) return auth

  await connectDB()
  const users = await AuthorizedUser.find().sort({ added_at: 1 }).lean()
  return NextResponse.json(users.map(u => ({ ...u, id: u._id.toString(), _id: undefined })))
}

export async function POST(req: NextRequest) {
  const auth = await requireRole('admin')
  if (auth instanceof NextResponse) return auth

  await connectDB()
  const parsedBody = await readJsonObject(req)
  if (!parsedBody.ok) return parsedBody.response
  const body = parsedBody.data
  const { email, role = 'grader' } = body
  if (!isEmail(email)) return NextResponse.json({ error: 'A valid email is required.' }, { status: 400 })
  const validRoles = ['grader', 'leadership', 'admin']
  if (typeof role !== 'string' || !validRoles.includes(role)) return NextResponse.json({ error: 'invalid role' }, { status: 400 })

  try {
    const user = await AuthorizedUser.create({ email: email.trim().toLowerCase(), role, added_by: auth.email })
    return NextResponse.json({ ...user.toObject(), id: user._id.toString(), _id: undefined }, { status: 201 })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    if (msg.includes('duplicate')) return NextResponse.json({ error: 'Email already exists.' }, { status: 409 })
    console.error('Failed to add authorized user:', e)
    return NextResponse.json({ error: 'Unable to add authorized user.' }, { status: 500 })
  }
}
