import { getSession } from 'next-auth/react'
import { UserRole } from './types'

export interface CurrentUser {
  id: string
  email: string
  name: string
  role: UserRole
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const session = await getSession()
  const user = session?.user as ({ role?: string; email?: string | null; name?: string | null }) | undefined
  if (!user?.email || !['grader', 'leadership', 'admin'].includes(user.role ?? '')) return null
  return {
    id: user.email,
    email: user.email,
    name: user.name ?? user.email,
    role: (user.role ?? 'grader') as UserRole,
  }
}

export function canCreateSession(role: UserRole): boolean {
  return role === 'admin' || role === 'leadership'
}

export function canManageUsers(role: UserRole): boolean {
  return role === 'admin'
}

export function canAccessAdmin(role: UserRole): boolean {
  return role === 'admin'
}
