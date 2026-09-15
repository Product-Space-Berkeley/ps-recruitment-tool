import { getServerSession } from 'next-auth'
import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { authOptions } from '@/lib/authOptions'

type Role = 'grader' | 'leadership' | 'admin'
const ROLES = new Set<Role>(['grader', 'leadership', 'admin'])

interface AuthedSession {
  email: string
  role: Role
}

interface ApplicantSession {
  email: string
}

export async function requireApplicantAuth(): Promise<ApplicantSession | NextResponse> {
  const session = await getServerSession(authOptions)
  const user = session?.user as ({ email?: string | null; applicantVerified?: boolean }) | undefined
  const email = user?.email?.trim().toLowerCase()
  if (!email || user?.applicantVerified !== true) {
    return NextResponse.json(
      { error: 'Sign in with a verified Google account to apply.' },
      { status: 401 },
    )
  }
  return { email }
}

// Returns the session user, or a 401 NextResponse if not authenticated.
// Usage: const auth = await requireAuth(); if (auth instanceof NextResponse) return auth;
//
// Role MUST be set by the session callback (which reads it from AuthorizedUser).
// If role is missing, the user has been removed from AuthorizedUser since their session
// was issued — we reject rather than silently downgrading to 'grader'.
export async function requireAuth(): Promise<AuthedSession | NextResponse> {
  // Dev-only test bypass — only honored when not in production AND TEST_BYPASS_AUTH=1.
  // Lets a load-test script send x-test-email + x-test-role headers without OAuth.
  if (process.env.NODE_ENV !== 'production' && process.env.TEST_BYPASS_AUTH === '1') {
    const h = await headers()
    const testEmail = h.get('x-test-email')
    const testRole = h.get('x-test-role') as Role | null
    if (testEmail && (testRole === 'grader' || testRole === 'leadership' || testRole === 'admin')) {
      return { email: testEmail.toLowerCase(), role: testRole }
    }
  }

  const session = await getServerSession(authOptions)
  const user = session?.user as ({ email?: string | null; role?: unknown }) | undefined
  if (!user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (typeof user.role !== 'string' || !ROLES.has(user.role as Role)) {
    return NextResponse.json({ error: 'Account no longer authorized' }, { status: 401 })
  }
  return { email: user.email.trim().toLowerCase(), role: user.role as Role }
}

// Like requireAuth but also enforces a minimum role.
// Role hierarchy: grader < leadership < admin
const ROLE_RANK: Record<Role, number> = { grader: 0, leadership: 1, admin: 2 }

export async function requireRole(minRole: Role): Promise<AuthedSession | NextResponse> {
  const auth = await requireAuth()
  if (auth instanceof NextResponse) return auth
  const rank = ROLE_RANK[auth.role]
  if (typeof rank !== 'number' || rank < ROLE_RANK[minRole]) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  return auth
}
