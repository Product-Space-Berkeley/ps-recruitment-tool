'use client'

import { useRouter } from 'next/navigation'
import ThemeToggle from '@/components/ThemeToggle'

export default function Unauthorized() {
  const router = useRouter()

  return (
    <main className="min-h-screen bg-[var(--bg-base)] flex items-center justify-center p-4">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <div className="text-center max-w-sm">
        <p className="plex-gradient-text text-sm font-bold uppercase tracking-widest mb-6">PlexTech Berkeley</p>
        <h1 className="text-2xl font-bold text-[var(--text-primary)] mb-2">Access Denied</h1>
        <p className="text-[var(--text-muted)] mb-6">
          Applicants should use a verified Google account. Internal tools require an email authorized by a PlexTech admin.
        </p>
        <button
          onClick={() => router.push('/')}
          className="plex-gradient text-white font-medium px-6 py-2 rounded-lg"
        >
          Back to Login
        </button>
      </div>
    </main>
  )
}
