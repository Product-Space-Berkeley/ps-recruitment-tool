'use client'

import { useEffect, useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import { signIn, useSession } from 'next-auth/react'
import { APPLICATIONS_LAUNCHED } from '@/lib/applicationStatus'
import { isBerkeleyEmail } from '@/lib/emailValidation'

const RACE_OPTIONS = [
  'American Indian or Alaska Native',
  'Asian (including Indian subcontinent and Philippines origin)',
  'Black or African American',
  'White',
  'Hispanic or Latino',
  'Middle Eastern',
  'Native American or Other Pacific Islander',
  'Prefer not to answer',
]

interface EssayPrompt { id: string; question_number: number; prompt: string; description: string | null }
interface Cycle { id: string; name: string; accepting_applications: boolean; status: string; application_deadline: string | null }

interface ApplicationDraft {
  version: 1
  cycleId: string
  savedAt: number
  expiresAt: number
  fields: {
    firstName: string
    lastName: string
    email: string
    phone: string
    year: string
    transfer: boolean
    major: string
    gender: string
    genderOther: string
    race: string[]
    role: string
    linkedin: string
    website: string
    answers: Record<string, string>
    commitments: string
  }
}

const DRAFT_STORAGE_PREFIX = 'plextech-application-draft:v1'
const DEFAULT_DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000

function draftStorageKey(cycleId: string, email: string) {
  return `${DRAFT_STORAGE_PREFIX}:${cycleId}:${encodeURIComponent(email)}`
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.values(value).every(entry => typeof entry === 'string')
}

function parseApplicationDraft(raw: string): ApplicationDraft | null {
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const draft = value as Partial<ApplicationDraft>
    const fields = draft.fields
    if (
      draft.version !== 1
      || typeof draft.cycleId !== 'string'
      || typeof draft.savedAt !== 'number'
      || typeof draft.expiresAt !== 'number'
      || typeof fields !== 'object'
      || fields === null
      || Array.isArray(fields)
    ) return null

    const candidate = fields as Partial<ApplicationDraft['fields']>
    if (
      typeof candidate.firstName !== 'string'
      || typeof candidate.lastName !== 'string'
      || (candidate.email !== undefined && typeof candidate.email !== 'string')
      || typeof candidate.phone !== 'string'
      || typeof candidate.year !== 'string'
      || typeof candidate.transfer !== 'boolean'
      || typeof candidate.major !== 'string'
      || typeof candidate.gender !== 'string'
      || typeof candidate.genderOther !== 'string'
      || !Array.isArray(candidate.race)
      || candidate.race.some(entry => typeof entry !== 'string')
      || typeof candidate.role !== 'string'
      || typeof candidate.linkedin !== 'string'
      || typeof candidate.website !== 'string'
      || !isStringRecord(candidate.answers)
      || typeof candidate.commitments !== 'string'
    ) return null

    const parsedDraft = draft as ApplicationDraft
    if (typeof candidate.email !== 'string') parsedDraft.fields.email = ''
    return parsedDraft
  } catch {
    return null
  }
}

function promptDescriptionWithoutWordCount(description: string) {
  return description.replace(/\s*\(~?\d+(?:\s*[–-]\s*\d+)?\s+words?\)\s*$/i, '').trim()
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve((reader.result as string).split(',')[1]) // strip data URI prefix
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

export default function ApplicationForm() {
  const router = useRouter()
  const { data: authSession, status: authStatus } = useSession()
  const applicantVerified = (authSession?.user as { applicantVerified?: boolean } | undefined)?.applicantVerified === true
  const authEmail = authSession?.user?.email?.trim().toLowerCase() ?? ''
  const [cycle, setCycle] = useState<Cycle | null>(null)
  const [prompts, setPrompts] = useState<EssayPrompt[]>([])
  const [loadError, setLoadError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')

  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [year, setYear] = useState('')
  const [transfer, setTransfer] = useState(false)
  const [major, setMajor] = useState('')
  const [gender, setGender] = useState('')
  const [genderOther, setGenderOther] = useState('')
  const [race, setRace] = useState<string[]>([])
  const [role, setRole] = useState('')
  const [resumeFile, setResumeFile] = useState<File | null>(null)
  const [linkedin, setLinkedin] = useState('')
  const [website, setWebsite] = useState('')
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [commitments, setCommitments] = useState('')
  const [raceDropdownOpen, setRaceDropdownOpen] = useState(false)
  const raceRef = useRef<HTMLDivElement>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [draftReadyKey, setDraftReadyKey] = useState('')
  const [draftMessage, setDraftMessage] = useState('')
  const submittedRef = useRef(false)
  const latestDraftRef = useRef<{ key: string; value: string } | null>(null)
  const draftKey = cycle && authEmail ? draftStorageKey(cycle.id, authEmail) : ''

  useEffect(() => {
    if (!APPLICATIONS_LAUNCHED) {
      router.replace('/apply')
      return
    }

    if (authStatus !== 'authenticated' || !applicantVerified) return

    let cancelled = false
    async function load() {
      try {
        const res = await fetch('/api/cycles', { cache: 'no-store' })
        if (!res.ok) throw new Error('Unable to load the active recruitment cycle.')
        const cycles: unknown = await res.json()
        if (!Array.isArray(cycles)) throw new Error('The recruitment-cycle response was invalid.')
        const active = cycles.find((candidate): candidate is Cycle => (
          typeof candidate === 'object'
          && candidate !== null
          && typeof candidate.id === 'string'
          && candidate.status === 'active'
          && candidate.accepting_applications === true
        )) ?? null
        if (!active) { router.replace('/apply'); return }

        const pRes = await fetch(`/api/cycles/${active.id}/prompts`, { cache: 'no-store' })
        if (!pRes.ok) throw new Error('Unable to load the application prompts.')
        const promptData: unknown = await pRes.json()
        if (
          !Array.isArray(promptData)
          || promptData.length !== 3
          || promptData.some(prompt => (
            typeof prompt !== 'object'
            || prompt === null
            || typeof prompt.id !== 'string'
            || typeof prompt.question_number !== 'number'
            || typeof prompt.prompt !== 'string'
          ))
        ) {
          throw new Error('The application prompts are incomplete or invalid.')
        }
        if (cancelled) return
        setPrompts(promptData as EssayPrompt[])
        setCycle(active)
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : 'Unable to load the application.')
        }
      }
    }
    void load()
    return () => { cancelled = true }
  }, [router, authStatus, applicantVerified])

  useEffect(() => {
    if (!cycle || !draftKey || draftReadyKey === draftKey) return

    const restoreTimeout = window.setTimeout(() => {
      submittedRef.current = false
      try {
        const raw = window.localStorage.getItem(draftKey)
        const draft = raw ? parseApplicationDraft(raw) : null
        if (!draft || draft.cycleId !== cycle.id || draft.expiresAt <= Date.now()) {
          if (raw) window.localStorage.removeItem(draftKey)
          setEmail(current => current || (authEmail.endsWith('@berkeley.edu') ? authEmail : ''))
          setDraftMessage('')
        } else {
          const validAnswerKeys = new Set(prompts.map(prompt => `answer_${prompt.id}`))
          const restoredAnswers = Object.fromEntries(
            Object.entries(draft.fields.answers).filter(([key]) => validAnswerKeys.has(key)),
          )
          setFirstName(draft.fields.firstName)
          setLastName(draft.fields.lastName)
          setEmail(draft.fields.email || (authEmail.endsWith('@berkeley.edu') ? authEmail : ''))
          setPhone(draft.fields.phone)
          setYear(['Freshman', 'Sophomore', 'Junior', 'Senior'].includes(draft.fields.year) ? draft.fields.year : '')
          setTransfer(draft.fields.transfer)
          setMajor(draft.fields.major)
          setGender(['Male', 'Female', 'Other'].includes(draft.fields.gender) ? draft.fields.gender : '')
          setGenderOther(draft.fields.genderOther)
          setRace(draft.fields.race.filter(option => RACE_OPTIONS.includes(option)))
          setRole(['Curriculum Student', 'Industry Developer'].includes(draft.fields.role) ? draft.fields.role : '')
          setLinkedin(draft.fields.linkedin)
          setWebsite(draft.fields.website)
          setAnswers(restoredAnswers)
          setCommitments(draft.fields.commitments)
          setDraftMessage(`Draft saved at ${new Date(draft.savedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`)
        }
      } catch {
        setDraftMessage('')
      }
      setDraftReadyKey(draftKey)
    }, 0)

    return () => window.clearTimeout(restoreTimeout)
  }, [authEmail, cycle, draftKey, draftReadyKey, prompts])

  useEffect(() => {
    if (!cycle || !draftKey || draftReadyKey !== draftKey || submittedRef.current) return

    const deadline = cycle.application_deadline ? new Date(cycle.application_deadline).getTime() : Number.NaN
    const payload: ApplicationDraft = {
      version: 1,
      cycleId: cycle.id,
      savedAt: Date.now(),
      expiresAt: Number.isFinite(deadline) ? deadline : Date.now() + DEFAULT_DRAFT_TTL_MS,
      fields: {
        firstName,
        lastName,
        email,
        phone,
        year,
        transfer,
        major,
        gender,
        genderOther,
        race,
        role,
        linkedin,
        website,
        answers,
        commitments,
      },
    }
    const pendingDraft = { key: draftKey, value: JSON.stringify(payload) }
    latestDraftRef.current = pendingDraft

    const timeout = window.setTimeout(() => {
      if (submittedRef.current) return
      try {
        window.localStorage.setItem(pendingDraft.key, pendingDraft.value)
        setDraftMessage(`Draft saved at ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`)
      } catch {
        setDraftMessage('')
      }
    }, 500)

    return () => window.clearTimeout(timeout)
  }, [
    cycle,
    draftKey,
    draftReadyKey,
    firstName,
    lastName,
    email,
    phone,
    year,
    transfer,
    major,
    gender,
    genderOther,
    race,
    role,
    linkedin,
    website,
    answers,
    commitments,
  ])

  useEffect(() => {
    function flushDraft() {
      if (submittedRef.current || !latestDraftRef.current) return
      try {
        window.localStorage.setItem(latestDraftRef.current.key, latestDraftRef.current.value)
      } catch {
        // The form remains usable when local storage is disabled or full.
      }
    }
    window.addEventListener('pagehide', flushDraft)
    return () => window.removeEventListener('pagehide', flushDraft)
  }, [])

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (raceRef.current && !raceRef.current.contains(e.target as Node)) {
        setRaceDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  function toggleRace(option: string) {
    setRace(prev => prev.includes(option) ? prev.filter(r => r !== option) : [...prev, option])
  }

  function validate(): boolean {
    const e: Record<string, string> = {}
    if (!firstName.trim()) e.firstName = 'required'
    if (!lastName.trim()) e.lastName = 'required'
    if (!isBerkeleyEmail(email)) e.email = 'Must be a @berkeley.edu email.'
    if (!phone.trim()) e.phone = 'required'
    if (!year) e.year = 'required'
    if (!major.trim()) e.major = 'required'
    if (!role) e.role = 'required'
    if (!resumeFile) e.resume = 'required'
    if (race.length === 0) e.race = 'required'
    if (!commitments.trim()) e.commitments = 'required'
    for (const prompt of prompts) {
      const key = `answer_${prompt.id}`
      const val = answers[key] ?? ''
      if (!val.trim()) e[key] = 'required'
      else if (val.length > 1500) e[key] = 'Your answer must be 1,500 characters or fewer.'
    }
    setErrors(e)
    return Object.keys(e).length === 0
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitError('')
    if (!validate()) { setSubmitError('Please fill out the required fields above.'); return }
    if (!cycle) return

    setSubmitting(true)
    try {
      // Convert PDF to base64 (same as the original portal)
      const resume_base64 = await fileToBase64(resumeFile!)

      const effectiveGender = gender === 'Other' ? genderOther || 'Other' : gender

      const essays = prompts.map(p => ({
        prompt_id: p.id,
        response: (answers[`answer_${p.id}`] ?? '').trim(),
      }))

      const res = await fetch('/api/applicants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cycle_id: cycle.id,
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          email: email.trim(),
          phone: phone.trim(),
          year,
          transfer,
          major: major.trim(),
          gender: effectiveGender,
          race,
          desired_roles: role,
          linkedin: linkedin.trim() || null,
          website: website.trim() || null,
          time_commitment: commitments.trim(),
          resume_base64,
          essays,
        }),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error ?? 'Submission failed.')
      }

      const { id } = await res.json()
      submittedRef.current = true
      latestDraftRef.current = null
      if (draftKey) {
        try {
          window.localStorage.removeItem(draftKey)
        } catch {
          // Submission succeeded even if browser storage cannot be cleared.
        }
      }
      router.push(`/apply/success?id=${id}&name=${encodeURIComponent(firstName)}`)
    } catch (err: unknown) {
      setSubmitError(err instanceof Error ? err.message : 'An unexpected error occurred. Please contact plextech@berkeley.edu.')
    } finally {
      setSubmitting(false)
    }
  }

  if (authStatus === 'loading') return null
  if (authStatus !== 'authenticated' || !applicantVerified) {
    const startSignIn = () => {
      if (window.self !== window.top) {
        window.open('/apply/form', '_blank', 'noopener,noreferrer')
        return
      }
      void signIn('google', { callbackUrl: '/apply/form' })
    }
    return (
      <div className="apply-page">
        <div className="apply-home-card">
          <Image src="/PlexTechLogo.png" alt="PlexTech" width={50} height={50} />
          <h2>Verify your email</h2>
          <p>Sign in with any verified Google account before starting your application.</p>
          <button
            type="button"
            className="apply-btn-primary"
            onClick={startSignIn}
          >
            Sign in with Google
          </button>
        </div>
      </div>
    )
  }
  if (!cycle) {
    return (
      <div className="apply-page">
        <div className="apply-home-card">
          <Image src="/PlexTechLogo.png" alt="PlexTech" width={50} height={50} />
          <h2>{loadError ? 'Application temporarily unavailable' : 'Loading application…'}</h2>
          {loadError && (
            <>
              <p>{loadError} Please refresh or try again shortly.</p>
              <button type="button" className="apply-btn-primary" onClick={() => window.location.reload()}>
                Refresh
              </button>
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="apply-page">
      <form className="apply-form-card" onSubmit={handleSubmit} noValidate>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button type="button" className="apply-btn-primary" onClick={() => router.push('/apply')}>
            Return Home
          </button>
        </div>

        <div className="apply-form-title">
          <Image src="/PlexTechLogo.png" alt="PlexTech" width={80} height={80} />
          <h1>PlexTech Application — {cycle.name}</h1>
          <h4>Thank you for your interest in PlexTech!<br />Please fill out the information below and we will get back to you soon.</h4>
          <p>All applications submitted are final; duplicates will not be accepted.</p>
          {draftMessage && (
            <p aria-live="polite" style={{ color: '#6b7280', fontSize: '0.9rem' }}>{draftMessage}</p>
          )}
          {cycle.application_deadline && (
            <p style={{ color: '#ec6f34' }}>
              Applications close on {new Date(cycle.application_deadline).toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short', timeZone: 'America/Los_Angeles' })} PT
            </p>
          )}
        </div>

        <div className="apply-field">
          <label>First Name</label>
          <input type="text" value={firstName} onChange={e => setFirstName(e.target.value)} />
          {errors.firstName && <p className="apply-warning">{errors.firstName}</p>}
        </div>

        <div className="apply-field">
          <label>Last Name</label>
          <input type="text" value={lastName} onChange={e => setLastName(e.target.value)} />
          {errors.lastName && <p className="apply-warning">{errors.lastName}</p>}
        </div>

        <div className="apply-field">
          <label>Berkeley Email</label>
          <input
            type="email"
            value={email}
            onChange={event => setEmail(event.target.value)}
            autoComplete="email"
            placeholder="name@berkeley.edu"
          />
          {errors.email && <p className="apply-warning">{errors.email}</p>}
        </div>

        <div className="apply-field">
          <label>Phone Number</label>
          <input type="text" value={phone} onChange={e => setPhone(e.target.value)} />
          {errors.phone && <p className="apply-warning">{errors.phone}</p>}
        </div>

        <div className="apply-field">
          <label>Year</label>
          <select value={year} onChange={e => setYear(e.target.value)}>
            <option value="" disabled>Choose your year:</option>
            {['Freshman', 'Sophomore', 'Junior', 'Senior'].map(y => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
          {errors.year && <p className="apply-warning">{errors.year}</p>}
          <label className="flex items-center gap-2 mt-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={transfer}
              onChange={e => setTransfer(e.target.checked)}
            />
            I am a transfer student
          </label>
        </div>

        <div className="apply-field">
          <label>Major</label>
          <input type="text" value={major} onChange={e => setMajor(e.target.value)} />
          {errors.major && <p className="apply-warning">{errors.major}</p>}
        </div>

        <div className="apply-field">
          <label>Gender</label>
          <select value={gender} onChange={e => setGender(e.target.value)}>
            <option value="" disabled>Please select:</option>
            <option value="Male">Male</option>
            <option value="Female">Female</option>
            <option value="Other">Other</option>
          </select>
          {gender === 'Other' && (
            <>
              <label>(If selected &apos;Other,&apos; please specify below:)</label>
              <input type="text" value={genderOther} onChange={e => setGenderOther(e.target.value)} />
            </>
          )}
        </div>

        <div className="apply-field" ref={raceRef}>
          <label>Your Demographic Background</label>
          <p style={{ margin: '0.25rem 0 0.5rem', color: 'grey' }}>Please be ensured that this has absolutely no impact on your application.</p>
          <div className="apply-multiselect" onClick={() => setRaceDropdownOpen(o => !o)}>
            {race.length === 0
              ? <span style={{ color: '#999' }}>Select from below</span>
              : race.map(r => (
                <span key={r} className="apply-chip" onClick={e => { e.stopPropagation(); toggleRace(r) }}>
                  {r} ✕
                </span>
              ))
            }
          </div>
          {raceDropdownOpen && (
            <div className="apply-dropdown">
              {RACE_OPTIONS.map(opt => (
                <div
                  key={opt}
                  className={`apply-dropdown-item${race.includes(opt) ? ' selected' : ''}`}
                  onClick={() => toggleRace(opt)}
                >
                  {opt}
                </div>
              ))}
            </div>
          )}
          {errors.race && <p className="apply-warning">{errors.race}</p>}
        </div>

        <div className="apply-field">
          <label>Intended Role</label>
          <select value={role} onChange={e => setRole(e.target.value)}>
            <option value="" disabled>Please select:</option>
            <option value="Curriculum Student">Curriculum Student</option>
            <option value="Industry Developer">Industry Developer</option>
          </select>
          {errors.role && <p className="apply-warning">{errors.role}</p>}
        </div>

        <div className="apply-field">
          <label>Resume / CV</label>
          <p style={{ color: 'grey', margin: '0.25rem 0' }}>Please limit your resume to a one-page PDF document. Documents of other formats will not be reviewed.</p>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
            <label className="apply-btn-secondary" style={{ cursor: 'pointer', marginBottom: 0 }}>
              Choose File
              <input
                type="file"
                accept="application/pdf"
                style={{ display: 'none' }}
                onChange={e => {
                  const file = e.target.files?.[0]
                  if (!file) return
                  if (file.type !== 'application/pdf') {
                    setResumeFile(null)
                    setErrors(prev => ({ ...prev, resume: 'Please choose a PDF file.' }))
                  } else if (file.size > 3 * 1024 * 1024) {
                    setResumeFile(null)
                    setErrors(prev => ({ ...prev, resume: 'Max file size is 3MB.' }))
                  } else {
                    setResumeFile(file)
                    setErrors(prev => ({ ...prev, resume: '' }))
                  }
                }}
              />
            </label>
            <span style={{ color: resumeFile ? '#333' : 'grey', fontSize: '0.9rem' }}>
              {resumeFile ? resumeFile.name : 'No file chosen'}
            </span>
          </div>
          {errors.resume && <p className="apply-warning">{errors.resume}</p>}
        </div>

        <div className="apply-field">
          <label>LinkedIn Profile (optional)</label>
          <input type="text" value={linkedin} onChange={e => setLinkedin(e.target.value)} />
        </div>

        <div className="apply-field">
          <label>Personal Website (optional)</label>
          <input type="text" value={website} onChange={e => setWebsite(e.target.value)} />
        </div>

        {prompts.map(prompt => {
          const key = `answer_${prompt.id}`
          const description = prompt.description ? promptDescriptionWithoutWordCount(prompt.description) : ''
          return (
            <div className="apply-field" key={prompt.id}>
              <label>{prompt.prompt} <span style={{ color: 'grey', fontWeight: 400 }}>(150–200 words)</span></label>
              {description && <p style={{ color: 'grey', margin: '0.25rem 0' }}>{description}</p>}
              <textarea
                value={answers[key] ?? ''}
                maxLength={1500}
                onChange={e => setAnswers(prev => ({ ...prev, [key]: e.target.value }))}
              />
              <p style={{ fontSize: '0.8rem', color: 'grey' }}>{(answers[key] ?? '').length} / 1,500 characters</p>
              {errors[key] && <p className="apply-warning">{errors[key]}</p>}
            </div>
          )
        })}

        <div className="apply-field">
          <label>Please tell us about your commitments this semester.</label>
          <p style={{ color: 'grey', margin: '0.25rem 0' }}>
            What classes are you taking this semester? Please let us know any other organizations, employment, or commitments you are involved in this semester.
          </p>
          <p style={{ color: 'grey', margin: '0.25rem 0' }}>(Example: CS61A: xx hours)</p>
          <textarea value={commitments} onChange={e => setCommitments(e.target.value)} />
          {errors.commitments && <p className="apply-warning">{errors.commitments}</p>}
        </div>

        <div style={{ marginBottom: '3rem' }}>
          <button type="submit" className="apply-btn-primary" disabled={submitting}>
            {submitting ? 'Submitting...' : 'Submit'}
          </button>
          {submitError && <p className="apply-warning">{submitError}</p>}
        </div>

        <p style={{ color: 'grey', fontSize: '0.85rem' }}>Copyright © 2026 PlexTech All Rights Reserved.</p>
      </form>
    </div>
  )
}
