'use client'

import { useState, useEffect, useCallback } from 'react'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { signOut } from 'next-auth/react'
import { getCurrentUser, canCreateSession, canManageUsers, CurrentUser } from '@/lib/auth'
import { Session, AuthorizedUser, Round, UserRole } from '@/lib/types'
import ThemeToggle from '@/components/ThemeToggle'

export default function Dashboard() {
  const router = useRouter()
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [mySessions, setMySessions] = useState<Session[]>([])
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [pendingGrading, setPendingGrading] = useState<number | null>(null)

  // Join / create
  const [tab, setTab] = useState<'join' | 'create'>('join')
  const [joinSessionId, setJoinSessionId] = useState('')
  const [joinError, setJoinError] = useState('')
  const [joinLoading, setJoinLoading] = useState(false)
  const [createSessionName, setCreateSessionName] = useState('')
  const [createError, setCreateError] = useState('')
  const [createLoading, setCreateLoading] = useState(false)

  // User management (admins only)
  const [authorizedUsers, setAuthorizedUsers] = useState<AuthorizedUser[]>([])
  const [usersLoading, setUsersLoading] = useState(false)
  const [newEmail, setNewEmail] = useState('')
  const [newRole, setNewRole] = useState<UserRole>('grader')
  const [bulkEmails, setBulkEmails] = useState('')
  const [showBulk, setShowBulk] = useState(false)
  const [userError, setUserError] = useState('')

  function copyId(id: string, e: React.MouseEvent) {
    e.stopPropagation()
    navigator.clipboard.writeText(id)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 1500)
  }

  const loadSessions = useCallback(async (email: string) => {
    const allSessions: Session[] = await fetch('/api/sessions').then(r => r.json())
    const mine = allSessions.filter(
      s => s.created_by === email
    )
    setMySessions(mine)
  }, [])

  const loadUsers = useCallback(async () => {
    setUsersLoading(true)
    const data: AuthorizedUser[] = await fetch('/api/authorized-users').then(r => r.json())
    setAuthorizedUsers(data ?? [])
    setUsersLoading(false)
  }, [])

  useEffect(() => {
    async function init() {
      const user = await getCurrentUser()
      if (!user) {
        router.replace('/')
        return
      }
      setCurrentUser(user)
      await Promise.all([
        loadSessions(user.email),
        (async () => {
          const [assignments, reviews] = await Promise.all([
            fetch(`/api/grader-assignments?grader_email=${encodeURIComponent(user.email)}`).then(r => r.json()),
            fetch(`/api/reviews?grader_email=${encodeURIComponent(user.email)}`).then(r => r.json()),
          ])

          const assignmentRows: { round_id: string; applicant_id: string }[] = Array.isArray(assignments) ? assignments : []
          const reviewRows: { round_id: string; applicant_id: string }[] = Array.isArray(reviews) ? reviews : []
          const roundIds = [...new Set(assignmentRows.map(assignment => assignment.round_id))]
          const rounds = (await Promise.all(
            roundIds.map(id => fetch(`/api/rounds/${id}`).then(r => r.ok ? r.json() : null))
          )).filter(Boolean) as Round[]
          const activeRoundIds = new Set(
            rounds.filter(round => round.status === 'grading').map(round => round.id)
          )

          const assigned = assignmentRows.filter(assignment => activeRoundIds.has(assignment.round_id)).length
          const reviewed = reviewRows.filter(review => activeRoundIds.has(review.round_id)).length
          setPendingGrading(Math.max(0, assigned - reviewed))
        })(),
      ])
      if (canManageUsers(user.role)) await loadUsers()
      setLoading(false)
    }
    init()
  }, [router, loadSessions, loadUsers])

  async function handleSignOut() {
    await signOut({ callbackUrl: '/' })
  }

  async function handleJoin(e: React.FormEvent) {
    e.preventDefault()
    setJoinError('')
    setJoinLoading(true)
    const sessionId = joinSessionId.trim().toUpperCase()
    if (!sessionId) { setJoinError('Enter a session ID.'); setJoinLoading(false); return }

    const res = await fetch('/api/session-members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, user_email: currentUser!.email }),
    })
    if (!res.ok) {
      const error = await res.json().catch(() => ({}))
      setJoinError(error.error ?? 'Session not found.')
      setJoinLoading(false)
      return
    }
    router.push(`/session/${sessionId}`)
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setCreateError('')
    setCreateLoading(true)
    const sessionName = createSessionName.trim()
    if (!sessionName) { setCreateError('Enter a session name.'); setCreateLoading(false); return }

    const sessionId = Math.random().toString(36).substring(2, 8).toUpperCase()
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: sessionId, name: sessionName, status: 'active',
        created_by: currentUser!.email, anonymous: false,
      }),
    })
    if (!res.ok) {
      const err = await res.json()
      setCreateError('Failed to create session: ' + (err.error ?? res.statusText))
      setCreateLoading(false)
      return
    }

    await fetch('/api/session-members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, user_email: currentUser!.email }),
    })
    router.push(`/session/${sessionId}`)
  }

  async function handleAddUser(e: React.FormEvent) {
    e.preventDefault()
    const email = newEmail.trim().toLowerCase()
    if (!email || !email.includes('@')) { setUserError('Enter a valid email.'); return }
    const res = await fetch('/api/authorized-users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, role: newRole, added_by: currentUser!.email }),
    })
    if (!res.ok) {
      const err = await res.json()
      setUserError(err.error ?? 'Failed to add user.')
    } else {
      setNewEmail(''); setUserError(''); await loadUsers()
    }
  }

  async function handleBulkAdd(e: React.FormEvent) {
    e.preventDefault()
    const emails = bulkEmails.split(/[\n,]+/).map(e => e.trim()).filter(e => e.includes('@'))
    if (emails.length === 0) { setUserError('No valid emails found.'); return }
    await Promise.all(emails.map(email =>
      fetch('/api/authorized-users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.toLowerCase(), role: newRole, added_by: currentUser!.email }),
      })
    ))
    setBulkEmails(''); setShowBulk(false); setUserError(''); await loadUsers()
  }

  async function updateUserRole(id: string, role: UserRole) {
    await fetch(`/api/authorized-users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    })
    await loadUsers()
  }

  async function removeUser(id: string) {
    await fetch(`/api/authorized-users/${id}`, { method: 'DELETE' })
    await loadUsers()
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-[var(--bg-base)] flex items-center justify-center">
        <div className="text-gray-500 text-sm">Loading...</div>
      </main>
    )
  }

  const user = currentUser!
  const isAdmin = user.role === 'admin'

  const ROLE_BADGE: Record<UserRole, string> = {
    admin:      'bg-purple-500/15 text-purple-400 border-purple-500/30',
    leadership: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
    grader:     'bg-[var(--bg-raised)] text-[var(--text-muted)] border-[var(--border)]',
  }

  return (
    <main className="min-h-screen bg-[var(--bg-base)] flex flex-col">
      <header className="bg-[var(--bg-surface)] border-b border-[var(--border)] px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Image
            src="/PlexTechLogo.png"
            alt="PlexTech"
            width={23}
            height={34}
            className="h-8 w-auto shrink-0"
            priority
          />
          <span className="text-[var(--border)]">|</span>
          <h1 className="font-bold text-[var(--text-primary)]">Deliberations</h1>
        </div>
        <div className="flex items-center gap-3">
          <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${ROLE_BADGE[user.role]}`}>
            {user.role}
          </span>
          <span className="text-sm text-[var(--text-muted)] hidden sm:block">{user.name}</span>
          <ThemeToggle />
          <button
            onClick={handleSignOut}
            className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] border border-[var(--border)] px-3 py-1.5 rounded-lg transition-colors"
          >
            Sign out
          </button>
        </div>
      </header>

      <div className="flex-1 p-4 max-w-2xl mx-auto w-full space-y-6 pt-8">

        {/* Shortcuts */}
        <div className={`grid gap-3 ${isAdmin ? 'grid-cols-2' : 'grid-cols-1'}`}>
          {isAdmin && (
            <button
              onClick={() => router.push('/admin')}
              className="bg-[var(--bg-surface)] hover:bg-[var(--bg-raised)] border border-[var(--border)] rounded-xl px-4 py-3 text-left transition-colors"
            >
              <p className="font-medium text-[var(--text-primary)] text-sm">Admin Console</p>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">Cycles, rounds, assignments</p>
            </button>
          )}
          <button
            onClick={() => router.push('/grade')}
            className="bg-[var(--bg-surface)] hover:bg-[var(--bg-raised)] border border-[var(--border)] rounded-xl px-4 py-3 text-left transition-colors"
          >
            <div className="flex items-center justify-between">
              <p className="font-medium text-[var(--text-primary)] text-sm">Grading Queue</p>
              {pendingGrading !== null && pendingGrading > 0 && (
                <span className="text-xs bg-[#FF6B35] text-white font-bold px-2 py-0.5 rounded-full">
                  {pendingGrading}
                </span>
              )}
            </div>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              {pendingGrading === null
                ? 'Review applicants assigned to you'
                : pendingGrading === 0
                  ? 'No pending reviews'
                  : `${pendingGrading} applicant${pendingGrading === 1 ? '' : 's'} to review`}
            </p>
          </button>
        </div>

        {/* Join / Create session */}
        <div className="bg-[var(--bg-surface)] rounded-xl border border-[var(--border)] overflow-hidden">
          <div className="flex border-b border-[var(--border)]">
            <button
              className={`flex-1 py-3 text-sm font-medium transition-colors ${tab === 'join' ? 'plex-gradient text-white' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}
              onClick={() => setTab('join')}
            >
              Join Session
            </button>
            {canCreateSession(user.role) && (
              <button
                className={`flex-1 py-3 text-sm font-medium transition-colors ${tab === 'create' ? 'plex-gradient text-white' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}
                onClick={() => setTab('create')}
              >
                Create Session
              </button>
            )}
          </div>

          <div className="p-6">
            {tab === 'join' ? (
              <form onSubmit={handleJoin} className="space-y-4">
                <p className="text-sm text-[var(--text-muted)]">Enter the session ID shared by your admin.</p>
                <input
                  type="text"
                  value={joinSessionId}
                  onChange={(e) => setJoinSessionId(e.target.value.toUpperCase())}
                  placeholder="e.g. ABC123"
                  className="w-full bg-[var(--bg-raised)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[#FF6B35] font-mono text-lg tracking-widest"
                />
                {joinError && <p className="text-red-400 text-sm">{joinError}</p>}
                <button type="submit" disabled={joinLoading}
                  className="w-full plex-gradient disabled:opacity-50 text-white font-medium py-2 rounded-lg">
                  {joinLoading ? 'Joining...' : 'Join Session'}
                </button>
              </form>
            ) : (
              <form onSubmit={handleCreate} className="space-y-4">
                <p className="text-sm text-[var(--text-muted)]">Create a new delib session. You will be the admin.</p>
                <input
                  type="text"
                  value={createSessionName}
                  onChange={(e) => setCreateSessionName(e.target.value)}
                  placeholder="e.g. Spring 2026 Delibs"
                  className="w-full bg-[var(--bg-raised)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[#FF6B35]"
                />
                {createError && <p className="text-red-400 text-sm">{createError}</p>}
                <button type="submit" disabled={createLoading}
                  className="w-full plex-gradient disabled:opacity-50 text-white font-medium py-2 rounded-lg">
                  {createLoading ? 'Creating...' : 'Create Session'}
                </button>
              </form>
            )}
          </div>
        </div>

        {/* Your Sessions */}
        {mySessions.length > 0 && (
          <div>
            <h2 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-3">Your Sessions</h2>
            <div className="space-y-2">
              {mySessions.map(session => (
                <button
                  key={session.id}
                  onClick={() => router.push(`/session/${session.id}`)}
                  className="w-full flex items-center justify-between bg-[var(--bg-surface)] hover:bg-[var(--bg-raised)] border border-[var(--border)] rounded-xl px-4 py-3 transition-colors text-left"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-[var(--text-primary)] truncate">{session.name}</p>
                    <p
                      className="text-xs font-mono mt-0.5 text-[#FF6B35] hover:opacity-70 transition-opacity w-fit"
                      onClick={(e) => copyId(session.id, e)}
                      title="Click to copy"
                    >
                      {copiedId === session.id ? 'Copied!' : session.id}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0 ml-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                      session.status === 'active'
                        ? 'bg-green-500/15 text-green-600'
                        : 'bg-[var(--bg-raised)] text-[var(--text-muted)]'
                    }`}>
                      {session.status}
                    </span>
                    <span className="text-[var(--text-muted)] text-sm">→</span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* User Management (admins only) */}
        {isAdmin && (
          <div>
            <h2 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-3">Authorized Users</h2>
            <div className="bg-[var(--bg-surface)] rounded-xl border border-[var(--border)] p-4 space-y-4">
              <p className="text-xs text-[var(--text-muted)]">
                Only these emails can sign in. Set role to control what each person can access.
              </p>

              {/* Add single user */}
              <form onSubmit={handleAddUser} className="flex gap-2">
                <input
                  type="email"
                  value={newEmail}
                  onChange={e => { setNewEmail(e.target.value); setUserError('') }}
                  placeholder="email@berkeley.edu"
                  className="flex-1 bg-[var(--bg-raised)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)] placeholder-[var(--text-muted)] text-sm focus:outline-none focus:border-[#FF6B35]"
                />
                <select
                  value={newRole}
                  onChange={e => setNewRole(e.target.value as UserRole)}
                  className="bg-[var(--bg-raised)] border border-[var(--border)] rounded-lg px-2 py-2 text-[var(--text-primary)] text-sm focus:outline-none focus:border-[#FF6B35]"
                >
                  <option value="grader">Grader</option>
                  <option value="leadership">Leadership</option>
                  <option value="admin">Admin</option>
                </select>
                <button type="submit" className="plex-gradient text-white text-sm px-3 py-2 rounded-lg shrink-0">
                  Add
                </button>
              </form>

              {/* Bulk add */}
              <div>
                <button onClick={() => setShowBulk(!showBulk)} className="text-xs text-[#FF6B35] hover:opacity-80">
                  {showBulk ? 'Hide bulk add' : '+ Bulk add (paste list)'}
                </button>
                {showBulk && (
                  <form onSubmit={handleBulkAdd} className="mt-2 space-y-2">
                    <textarea
                      value={bulkEmails}
                      onChange={e => setBulkEmails(e.target.value)}
                      placeholder="One email per line, or comma-separated"
                      rows={4}
                      className="w-full bg-[var(--bg-raised)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)] placeholder-[var(--text-muted)] text-sm focus:outline-none focus:border-[#FF6B35] resize-none"
                    />
                    <p className="text-xs text-[var(--text-muted)]">All will be added with role: <strong>{newRole}</strong></p>
                    <button type="submit" className="w-full plex-gradient text-white text-sm py-2 rounded-lg">
                      Add All
                    </button>
                  </form>
                )}
              </div>

              {userError && <p className="text-red-400 text-xs">{userError}</p>}

              {/* User list */}
              {usersLoading ? (
                <p className="text-[var(--text-muted)] text-sm text-center py-2">Loading...</p>
              ) : authorizedUsers.length === 0 ? (
                <p className="text-[var(--text-muted)] text-sm text-center py-2">No users yet.</p>
              ) : (
                <ul className="space-y-1 max-h-64 overflow-y-auto">
                  {authorizedUsers.map(({ id, email, role }) => (
                    <li key={id} className="flex items-center justify-between gap-2 bg-[var(--bg-raised)] border border-[var(--border)] rounded-lg px-3 py-2">
                      <span className="text-sm text-[var(--text-secondary)] truncate flex-1">{email}</span>
                      <select
                        value={role}
                        onChange={e => updateUserRole(id, e.target.value as UserRole)}
                        className="bg-[var(--bg-surface)] border border-[var(--border)] rounded px-1.5 py-0.5 text-xs text-[var(--text-primary)] focus:outline-none"
                      >
                        <option value="grader">Grader</option>
                        <option value="leadership">Leadership</option>
                        <option value="admin">Admin</option>
                      </select>
                      <button
                        onClick={() => removeUser(id)}
                        className="text-red-400 hover:text-red-300 text-xs shrink-0 transition-colors"
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

      </div>
    </main>
  )
}
