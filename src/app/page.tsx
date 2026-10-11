'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getProviders, signIn, signOut, useSession } from 'next-auth/react'
import Link from 'next/link'
import ThemeToggle from '@/components/ThemeToggle'
import Image from 'next/image'

export default function Home() {
  const router = useRouter()
  const { data: session, status } = useSession()
  const [devLogin, setDevLogin] = useState(false)

  useEffect(() => {
    getProviders().then(providers => setDevLogin(Boolean(providers?.['dev-login']))).catch(() => setDevLogin(false))
  }, [])

  const role = (session?.user as { role?: string } | undefined)?.role
  const isMember = role === 'grader' || role === 'leadership' || role === 'admin'
  // Any verified Google account can sign in (applicants need it to apply), so a
  // non-member ends up here with a session but no role. Say so instead of
  // silently showing the sign-in button again.
  const unauthorizedEmail = status === 'authenticated' && !isMember ? session?.user?.email ?? null : null

  useEffect(() => {
    if (isMember) router.replace('/dashboard')
  }, [isMember, router])

  async function switchAccount() {
    await signOut({ redirect: false })
    await signIn('google', { callbackUrl: '/dashboard' }, { prompt: 'select_account' })
  }

  if (status === 'loading') {
    return (
      <main className="ps-entry min-h-screen bg-[var(--bg-base)] flex items-center justify-center">
        <div className="text-[var(--text-muted)] text-sm">Loading...</div>
      </main>
    )
  }

  return (
    <main className="ps-entry min-h-screen bg-[var(--bg-base)] flex items-center justify-center p-4">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-[var(--bg-raised)] border border-[var(--border)] shadow-[var(--shadow-soft)]">
            <Image src="/product-space-logo.png" alt="Product Space" width={40} height={52} className="object-contain" priority />
          </div>
          <p className="ps-gradient-text text-sm font-bold uppercase tracking-[0.22em] mb-3">Product Space @ Berkeley</p>
          <h1 className="text-4xl font-bold tracking-tight text-[var(--text-primary)]">Recruitment Hub</h1>
          <p className="text-[var(--text-muted)] mt-3 text-sm">Applications, grading, and deliberations in one place.</p>
        </div>

        <div className="bg-[var(--bg-surface)] border border-[var(--border)] rounded-[28px] p-8 space-y-5">
          {unauthorizedEmail ? (
            <div role="alert" className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm space-y-2">
              <p className="font-semibold text-[var(--text-primary)]">This account doesn&apos;t have access</p>
              <p className="text-[var(--text-muted)]">
                You&apos;re signed in as <strong className="text-[var(--text-primary)] break-all">{unauthorizedEmail}</strong>,
                which isn&apos;t on the Product Space member list. If you&apos;re a member, ask an admin to add this exact
                email, or sign in with the account they added.
              </p>
              <p className="text-[var(--text-muted)]">
                Applying to Product Space? <Link href="/apply" className="underline text-[var(--text-primary)]">Go to the application</Link>.
              </p>
            </div>
          ) : (
            <p className="text-sm text-[var(--text-muted)] text-center">
              Welcome to Product Space. Sign in to review applications and shape our next cohort.
            </p>
          )}

          <button
            onClick={unauthorizedEmail ? switchAccount : () => signIn('google', { callbackUrl: '/dashboard' })}
            className="w-full flex items-center justify-center gap-3 ps-gradient text-white font-bold py-3 rounded-xl transition-all hover:-translate-y-0.5"
          >
            <GoogleIcon />
            {unauthorizedEmail ? 'Sign in with a different account' : 'Sign in with Google'}
          </button>
          {devLogin && (
            <div className="space-y-2">
              <button
                onClick={() => signIn('dev-login', { callbackUrl: '/dashboard' })}
                className="w-full border border-[var(--border)] text-[var(--text-primary)] font-bold py-3 rounded-xl"
              >
                Dev login (admin)
              </button>
              <p className="text-xs text-center text-[var(--text-muted)]">
                Local testing only. Changes are saved to your configured database.
              </p>
            </div>
          )}
        </div>

        <p className="text-center text-xs text-[var(--text-muted)] mt-4">
          Access is restricted to authorized members only.
        </p>
      </div>
    </main>
  )
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18">
      <path fill="#4285F4" d="M16.51 8H8.98v3h4.3c-.18 1-.74 1.48-1.6 2.04v2.01h2.6a7.8 7.8 0 0 0 2.38-5.88c0-.57-.05-.66-.15-1.18z"/>
      <path fill="#34A853" d="M8.98 17c2.16 0 3.97-.72 5.3-1.94l-2.6-2a4.8 4.8 0 0 1-7.18-2.54H1.83v2.07A8 8 0 0 0 8.98 17z"/>
      <path fill="#FBBC05" d="M4.5 10.52a4.8 4.8 0 0 1 0-3.04V5.41H1.83a8 8 0 0 0 0 7.18l2.67-2.07z"/>
      <path fill="#EA4335" d="M8.98 4.18c1.17 0 2.23.4 3.06 1.2l2.3-2.3A8 8 0 0 0 1.83 5.4L4.5 7.49a4.77 4.77 0 0 1 4.48-3.3z"/>
    </svg>
  )
}
