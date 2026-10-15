'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { getCurrentUser } from '@/lib/auth'
import type { UserRole } from '@/lib/types'

/** The same destinations and selected state on every recruitment page. */
export default function RecruitmentNav({ role }: { role?: UserRole }) {
  const pathname = usePathname()
  const [loadedRole, setLoadedRole] = useState<UserRole>()
  useEffect(() => {
    if (role) return
    let active = true
    getCurrentUser().then(user => { if (active) setLoadedRole(user?.role) }).catch(() => {})
    return () => { active = false }
  }, [role])
  const currentRole = role ?? loadedRole
  const leadership = currentRole === 'admin' || currentRole === 'leadership'
  const links = [
    { href: '/dashboard', label: 'Dashboard', visible: true },
    { href: '/admin', label: 'Applications & cycles', visible: currentRole === 'admin' },
    { href: '/admin/rounds', label: 'Rounds & rubrics', visible: leadership },
    { href: '/grade/ps', label: 'Review candidates', visible: true },
    { href: '/admin/candidates', label: 'Candidates', visible: leadership },
  ]
  return <nav aria-label="Recruitment navigation" className="w-full border-b border-[var(--border)] bg-[var(--bg-surface)] px-3 py-3 sm:px-5">
    <div className="flex flex-wrap gap-1">
      {links.filter(link => link.visible).map(link => {
        const selected = pathname === link.href || (link.href === '/admin/candidates' && pathname.startsWith(link.href + '/'))
        return <Link key={link.href} href={link.href} aria-current={selected ? 'page' : undefined}
          className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ps-accent)] ${selected ? 'bg-[var(--bg-active)] text-[var(--text-primary)] shadow-sm' : 'text-[var(--text-muted)] hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)]'}`}>
          {link.label}
        </Link>
      })}
    </div>
  </nav>
}
