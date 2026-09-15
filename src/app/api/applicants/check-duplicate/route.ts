import { NextResponse } from 'next/server'

export function GET() {
  // The previous endpoint accepted arbitrary emails and could be used to
  // enumerate applicants. Submission validates the entered Berkeley email and
  // handles duplicates atomically through the cycle/email unique index.
  return NextResponse.json({ error: 'This endpoint is no longer available.' }, { status: 410 })
}
