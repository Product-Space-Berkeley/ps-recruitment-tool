'use client'

import { Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import ThemeToggle from '@/components/ThemeToggle'

// NextAuth redirects here (pages.error) with ?error=<code>.
// https://next-auth.js.org/configuration/pages#error-codes
const MESSAGES: Record<string, { title: string; body: string }> = {
  AccessDenied: {
    title: 'Access denied',
    body: 'This Google account isn\'t on the Product Space member list and its email isn\'t verified by Google. Members: ask an admin to add the exact email you sign in with. Applicants: use a Google account with a verified email.',
  },
  OAuthCallback: {
    title: 'Google sign-in didn\'t finish',
    body: 'Sign-in was cancelled or Google returned an error. Try again, and choose the account you want to use when Google asks.',
  },
  OAuthSignin: {
    title: 'Couldn\'t start Google sign-in',
    body: 'Try again in a regular browser window (Chrome or Safari); some in-app browsers block Google sign-in. If it keeps happening, tell a Product Space admin.',
  },
  Configuration: {
    title: 'Sign-in is misconfigured',
    body: 'The server\'s login settings are incomplete or invalid. This isn\'t something you can fix. Please tell a Product Space admin.',
  },
  Callback: {
    title: 'Sign-in failed',
    body: 'Something went wrong while finishing sign-in, often a temporary database problem. Wait a moment and try again; if it persists, tell a Product Space admin.',
  },
}

const DEFAULT_MESSAGE = {
  title: 'Sign-in failed',
  body: 'Something went wrong while signing in. Try again; if it keeps happening, tell a Product Space admin.',
}

export default function Unauthorized() {
  return (
    <main className="min-h-screen bg-[var(--bg-base)] flex items-center justify-center p-4">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <Suspense fallback={null}>
        <ErrorDetails />
      </Suspense>
    </main>
  )
}

function ErrorDetails() {
  const router = useRouter()
  const code = useSearchParams().get('error')
  const message = (code && MESSAGES[code]) || DEFAULT_MESSAGE

  return (
    <div className="text-center max-w-sm">
      <p className="ps-gradient-text text-sm font-bold uppercase tracking-widest mb-6">Product Space @ Berkeley</p>
      <h1 className="text-2xl font-bold text-[var(--text-primary)] mb-2">{message.title}</h1>
      <p className="text-[var(--text-muted)] mb-6">{message.body}</p>
      <button
        onClick={() => router.push('/')}
        className="ps-gradient text-white font-medium px-6 py-2 rounded-lg"
      >
        Back to Login
      </button>
      {code && <p className="text-xs text-[var(--text-muted)] mt-4">Error code: {code}</p>}
    </div>
  )
}
