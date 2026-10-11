import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/serverAuth'
import { connectDB } from '@/lib/mongodb'
import { WorkflowError } from './domain'
export async function psApi(role: 'grader' | 'leadership' | 'admin', action: (auth: { email: string; role: string }) => Promise<NextResponse>) {
  try {
    const auth = await requireRole(role)
    if (auth instanceof NextResponse) return auth
    await connectDB()
    return await action(auth)
  } catch (error) {
    if (error instanceof WorkflowError) return NextResponse.json({ error: error.message }, { status: error.status })
    if (typeof error === 'object' && error && 'code' in error && error.code === 11000) return NextResponse.json({ error: 'This record already exists. Refresh and retry.' }, { status: 409 })
    console.error('PS workflow request failed', error instanceof Error ? error.name : 'UnknownError')
    return NextResponse.json({ error: 'Unable to complete this request. Please retry.' }, { status: 500 })
  }
}
export { objectId, serialize } from './records'
