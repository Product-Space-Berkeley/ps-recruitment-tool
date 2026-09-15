'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import { signIn, useSession } from 'next-auth/react'
import { APPLICATIONS_LAUNCHED } from '@/lib/applicationStatus'

interface Cycle { id: string; name: string; status: string; accepting_applications: boolean; application_deadline: string | null }

export default function ApplyHome() {
  const router = useRouter()
  const { data: authSession } = useSession()
  const [cycle, setCycle] = useState<Cycle | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [now, setNow] = useState<number | null>(null)

  useEffect(() => {
    fetch('/api/cycles', { cache: 'no-store' })
      .then(async response => {
        if (!response.ok) throw new Error('Cycle lookup failed')
        const data: unknown = await response.json()
        if (!Array.isArray(data)) throw new Error('Cycle lookup returned an invalid response')
        return data as Cycle[]
      })
      .then((cycles: Cycle[]) => {
        const active = cycles.find(c => c.status === 'active') ?? null
        setCycle(active)
      })
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    const updateTime = () => setNow(Date.now())
    updateTime()
    const interval = window.setInterval(updateTime, 1000)

    return () => window.clearInterval(interval)
  }, [])

  const deadline = cycle?.application_deadline
    ? new Date(cycle.application_deadline).getTime()
    : null
  const accepting = APPLICATIONS_LAUNCHED
    && (cycle?.accepting_applications ?? false)
    && deadline !== null
    && now !== null
    && now < deadline

  function startApplication() {
    if (window.self !== window.top) {
      window.open('/apply/form', '_blank', 'noopener,noreferrer')
      return
    }
    if (authSession) router.push('/apply/form')
    else void signIn('google', { callbackUrl: '/apply/form' })
  }

  return (
    <div className="apply-page">
      <div className="apply-home-card">
        <Image src="/PlexTechLogo.png" alt="PlexTech logo" width={35} height={35} style={{ marginBottom: '0.5rem' }} />
        <h2>Welcome to the PlexTech Application Platform!</h2>
        {loading ? null : loadError ? (
          <div style={{ color: '#ec6f34' }} role="status">
            <h4>Application information is temporarily unavailable.</h4>
            <p style={{ fontSize: '0.9rem', marginTop: '0.5rem' }}>Please refresh and try again shortly.</p>
          </div>
        ) : accepting ? (
          <>
            <h4>If you are an applicant, please proceed to the application form.</h4>
            {cycle?.application_deadline && (
              <p style={{ color: '#ec6f34', fontSize: '0.9rem', marginTop: '0.5rem' }}>
                Applications close on {new Date(cycle.application_deadline).toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short', timeZone: 'America/Los_Angeles' })} PT
              </p>
            )}
          </>
        ) : (
          <div style={{ color: '#ec6f34' }}>
            <h4>Applications are now closed.</h4>
            <p style={{ fontSize: '0.9rem', marginTop: '0.5rem' }}>
              Please apply again in Spring 2027!
            </p>
          </div>
        )}

        <div style={{ paddingTop: '15px', paddingLeft: '15px' }}>
          {accepting && (
            <button
              className="apply-btn-primary"
              onClick={startApplication}
            >
              Application Form
            </button>
          )}
          <button className="apply-btn-secondary" onClick={() => router.push('/')}>
            Member Login
          </button>
        </div>
      </div>

      <footer style={{ textAlign: 'center', marginTop: '2rem', color: 'grey', fontSize: '0.85rem' }}>
        Copyright © 2026 PlexTech All Rights Reserved. &nbsp;·&nbsp;
        <span
          style={{ textDecoration: 'underline', cursor: 'pointer' }}
          onClick={() => router.push('/apply/privacy-policy')}
        >
          Privacy Policy
        </span>
      </footer>
    </div>
  )
}
