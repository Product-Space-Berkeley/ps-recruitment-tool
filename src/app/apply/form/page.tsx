'use client'

import { useEffect, useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import { signIn, signOut, useSession } from 'next-auth/react'
import { APPLICATIONS_LAUNCHED } from '@/lib/applicationStatus'
import { isBerkeleyEmail } from '@/lib/emailValidation'
import {
  APPLICANT_YEARS, ETHNICITY_OPTIONS, MAX_AVAILABILITY_NOTE_LENGTH, MAX_PHOTO_BYTES, MAX_RACE_OTHER_LENGTH,
  MAX_RESUME_BYTES, MEETING_CONFIRMATION, PHOTO_TYPES, RACE_OPTIONS, RACE_OTHER_PREFIX, RETREAT_CONFIRMATION,
  countWords, essayLimitError,
} from '@/lib/applicationFields'

interface EssayPrompt { id: string; question_number: number; prompt: string; description: string | null; word_limit: number | null }
interface Cycle { id: string; name: string; accepting_applications: boolean; status: string; application_deadline: string | null }

// '' = unanswered; 'confirm' = the standard confirmation; 'other' = explained conflict
type AvailabilityChoice = '' | 'confirm' | 'other'
type YesNo = '' | 'Yes' | 'No'

interface ApplicationDraft {
  version: 2
  cycleId: string
  savedAt: number
  expiresAt: number
  fields: {
    firstName: string
    lastName: string
    phone: string
    undergradConfirmed: boolean
    major: string
    year: string
    previouslyApplied: YesNo
    commitments: string
    meetingChoice: AvailabilityChoice
    meetingOther: string
    retreatChoice: AvailabilityChoice
    retreatOther: string
    hoursConfirmed: boolean
    answers: Record<string, string>
    additionalContext: string
    race: string[]
    raceOther: string
    ethnicity: string
    transfer: YesNo
  }
}

const DRAFT_STORAGE_PREFIX = 'ps-application-draft:v2'
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

const DRAFT_STRING_FIELDS = [
  'firstName', 'lastName', 'phone', 'major', 'year', 'previouslyApplied', 'commitments',
  'meetingChoice', 'meetingOther', 'retreatChoice', 'retreatOther', 'additionalContext', 'raceOther',
  'ethnicity', 'transfer',
] as const

function parseApplicationDraft(raw: string): ApplicationDraft | null {
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const draft = value as Partial<ApplicationDraft>
    const fields = draft.fields as Record<string, unknown> | undefined
    if (
      draft.version !== 2
      || typeof draft.cycleId !== 'string'
      || typeof draft.savedAt !== 'number'
      || typeof draft.expiresAt !== 'number'
      || typeof fields !== 'object'
      || fields === null
      || Array.isArray(fields)
      || DRAFT_STRING_FIELDS.some(key => typeof fields[key] !== 'string')
      || typeof fields.undergradConfirmed !== 'boolean'
      || typeof fields.hoursConfirmed !== 'boolean'
      || !Array.isArray(fields.race)
      || fields.race.some(entry => typeof entry !== 'string')
      || !isStringRecord(fields.answers)
    ) return null
    return draft as ApplicationDraft
  } catch {
    return null
  }
}

function oneOf<T extends string>(value: string, options: readonly T[]): T | '' {
  return (options as readonly string[]).includes(value) ? value as T : ''
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
  // Applicants must sign in with the Berkeley account they're applying with.
  const berkeleyAccount = isBerkeleyEmail(authEmail)
  const [cycle, setCycle] = useState<Cycle | null>(null)
  const [prompts, setPrompts] = useState<EssayPrompt[]>([])
  const [loadError, setLoadError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')

  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [phone, setPhone] = useState('')
  const [undergradConfirmed, setUndergradConfirmed] = useState(false)
  const [major, setMajor] = useState('')
  const [year, setYear] = useState('')
  const [previouslyApplied, setPreviouslyApplied] = useState<YesNo>('')
  const [resumeFile, setResumeFile] = useState<File | null>(null)
  const [photoFile, setPhotoFile] = useState<File | null>(null)
  const [commitments, setCommitments] = useState('')
  const [meetingChoice, setMeetingChoice] = useState<AvailabilityChoice>('')
  const [meetingOther, setMeetingOther] = useState('')
  const [retreatChoice, setRetreatChoice] = useState<AvailabilityChoice>('')
  const [retreatOther, setRetreatOther] = useState('')
  const [hoursConfirmed, setHoursConfirmed] = useState(false)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [additionalContext, setAdditionalContext] = useState('')
  const [race, setRace] = useState<string[]>([])
  const [raceOther, setRaceOther] = useState('')
  const [ethnicity, setEthnicity] = useState('')
  const [transfer, setTransfer] = useState<YesNo>('')
  // File problems are caught when a file is picked; everything else is
  // checked on submit and then re-checked live as the applicant fixes it.
  const [fileErrors, setFileErrors] = useState<Record<string, string>>({})
  const [attemptedSubmit, setAttemptedSubmit] = useState(false)
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

    if (authStatus !== 'authenticated' || !applicantVerified || !berkeleyAccount) return

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
          || promptData.length === 0
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
  }, [router, authStatus, applicantVerified, berkeleyAccount])

  useEffect(() => {
    if (!cycle || !draftKey || draftReadyKey === draftKey) return

    const restoreTimeout = window.setTimeout(() => {
      submittedRef.current = false
      try {
        const raw = window.localStorage.getItem(draftKey)
        const draft = raw ? parseApplicationDraft(raw) : null
        if (!draft || draft.cycleId !== cycle.id || draft.expiresAt <= Date.now()) {
          if (raw) window.localStorage.removeItem(draftKey)
          setDraftMessage('')
        } else {
          const f = draft.fields
          const validAnswerKeys = new Set(prompts.map(prompt => `answer_${prompt.id}`))
          setFirstName(f.firstName)
          setLastName(f.lastName)
          setPhone(f.phone)
          setUndergradConfirmed(f.undergradConfirmed)
          setMajor(f.major)
          setYear(oneOf(f.year, APPLICANT_YEARS))
          setPreviouslyApplied(oneOf(f.previouslyApplied, ['Yes', 'No'] as const))
          setCommitments(f.commitments)
          setMeetingChoice(oneOf(f.meetingChoice, ['confirm', 'other'] as const))
          setMeetingOther(f.meetingOther)
          setRetreatChoice(oneOf(f.retreatChoice, ['confirm', 'other'] as const))
          setRetreatOther(f.retreatOther)
          setHoursConfirmed(f.hoursConfirmed)
          setAnswers(Object.fromEntries(Object.entries(f.answers).filter(([key]) => validAnswerKeys.has(key))))
          setAdditionalContext(f.additionalContext)
          setRace(f.race.filter(option => RACE_OPTIONS.includes(option) || option === RACE_OTHER_PREFIX))
          setRaceOther(f.raceOther)
          setEthnicity(oneOf(f.ethnicity, ETHNICITY_OPTIONS))
          setTransfer(oneOf(f.transfer, ['Yes', 'No'] as const))
          setDraftMessage(`Draft saved at ${new Date(draft.savedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`)
        }
      } catch {
        setDraftMessage('')
      }
      setDraftReadyKey(draftKey)
    }, 0)

    return () => window.clearTimeout(restoreTimeout)
  }, [cycle, draftKey, draftReadyKey, prompts])

  useEffect(() => {
    if (!cycle || !draftKey || draftReadyKey !== draftKey || submittedRef.current) return

    const deadline = cycle.application_deadline ? new Date(cycle.application_deadline).getTime() : Number.NaN
    const payload: ApplicationDraft = {
      version: 2,
      cycleId: cycle.id,
      savedAt: Date.now(),
      expiresAt: Number.isFinite(deadline) ? deadline : Date.now() + DEFAULT_DRAFT_TTL_MS,
      fields: {
        firstName, lastName, phone, undergradConfirmed, major, year, previouslyApplied,
        commitments, meetingChoice, meetingOther, retreatChoice, retreatOther, hoursConfirmed,
        answers, additionalContext, race, raceOther, ethnicity, transfer,
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
    cycle, draftKey, draftReadyKey,
    firstName, lastName, phone, undergradConfirmed, major, year, previouslyApplied,
    commitments, meetingChoice, meetingOther, retreatChoice, retreatOther, hoursConfirmed,
    answers, additionalContext, race, raceOther, ethnicity, transfer,
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

  // `RACE_OTHER_PREFIX` in `race` marks the "Other" box as checked; its text lives in `raceOther`.
  function toggleRace(option: string) {
    setRace(prev => prev.includes(option) ? prev.filter(r => r !== option) : [...prev, option])
  }

  function pickFile(file: File | undefined, field: 'resume' | 'photo') {
    if (!file) return
    const isResume = field === 'resume'
    const setFile = isResume ? setResumeFile : setPhotoFile
    const allowedTypes: readonly string[] = isResume ? ['application/pdf'] : PHOTO_TYPES
    const maxBytes = isResume ? MAX_RESUME_BYTES : MAX_PHOTO_BYTES
    let error = ''
    if (!allowedTypes.includes(file.type)) {
      error = isResume
        ? `"${file.name}" isn't a PDF. Save or export your resume as a PDF and upload that file.`
        : `"${file.name}" isn't a JPG or PNG. If it's an iPhone photo (HEIC), take a screenshot of it or export it as a JPG, then upload that.`
    } else if (file.size > maxBytes) {
      error = `"${file.name}" is ${(file.size / 1024 / 1024).toFixed(1)}MB, but the limit is ${maxBytes / 1024 / 1024}MB. Upload a smaller file.`
    }
    setFile(error ? null : file)
    setFileErrors(prev => ({ ...prev, [field]: error }))
  }

  // Every problem with the form, in page order. Each message says what to change.
  function collectIssues(): { key: string; label: string; message: string }[] {
    const issues: { key: string; label: string; message: string }[] = []
    const add = (key: string, label: string, message: string) => issues.push({ key, label, message })
    if (!firstName.trim()) add('firstName', 'First name', 'Enter your first name.')
    if (!lastName.trim()) add('lastName', 'Last name', 'Enter your last name.')
    if (phone.trim().length < 7) add('phone', 'Phone number', 'Enter your phone number, including the area code.')
    if (!undergradConfirmed) add('undergrad', 'UC Berkeley undergraduate', "Check the box to confirm you're a continuing UC Berkeley undergraduate.")
    if (!major.trim()) add('major', 'Major(s) & minor(s)', 'Enter your major(s), and any minor(s).')
    if (!year) add('year', 'Year', 'Select your year.')
    if (!previouslyApplied) add('previouslyApplied', 'Previously applied', "Select whether you've applied to Product Space before.")
    if (!resumeFile) add('resume', 'Resume', fileErrors.resume || 'Upload your resume as a PDF (3MB max).')
    if (!photoFile) add('photo', 'Photo', fileErrors.photo || 'Upload a photo of yourself as a JPG or PNG (2MB max).')
    if (!commitments.trim()) add('commitments', 'Commitments', 'List your commitments this semester, with the estimated hours per week for each.')
    if (!meetingChoice) add('meeting', 'Thursday meetings', 'Confirm you can attend Thursday meetings (8:00 - 9:30 PM), or choose "Other" and explain your conflict.')
    else if (meetingChoice === 'other' && !meetingOther.trim()) add('meeting', 'Thursday meetings', 'You chose "Other". Briefly explain your conflict in the box below it.')
    if (!retreatChoice) add('retreat', 'Retreat', 'Confirm you blocked the retreat dates (9/18 - 9/20), or choose "Other" and explain your conflict.')
    else if (retreatChoice === 'other' && !retreatOther.trim()) add('retreat', 'Retreat', 'You chose "Other". Briefly explain your conflict in the box below it.')
    if (!hoursConfirmed) add('hours', '15 hours a week', 'Check the box to confirm you can dedicate at least 15 hours a week.')
    prompts.forEach((prompt, i) => {
      const key = `answer_${prompt.id}`
      const answer = (answers[key] ?? '').trim()
      const message = answer ? essayLimitError(answer, prompt.word_limit) : 'Answer this question.'
      if (message) add(key, `Written question ${i + 1}`, message)
    })
    if (race.includes(RACE_OTHER_PREFIX) && !raceOther.trim()) {
      add('race', 'Race', 'You checked "Other". Describe it in the box, or uncheck "Other".')
    }
    return issues
  }

  const issues = attemptedSubmit ? collectIssues() : []
  const fieldError = (key: string) => issues.find(issue => issue.key === key)?.message ?? fileErrors[key] ?? ''

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitError('')
    setAttemptedSubmit(true)
    // The list of problems is shown next to the Submit button.
    if (collectIssues().length > 0 || !cycle) return

    setSubmitting(true)
    try {
      const [resume_base64, photo_base64] = await Promise.all([fileToBase64(resumeFile!), fileToBase64(photoFile!)])

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
          email: authEmail,
          phone: phone.trim(),
          undergrad_confirmed: undergradConfirmed,
          major: major.trim(),
          year,
          previously_applied: previouslyApplied === 'Yes',
          resume_base64,
          photo_base64,
          photo_type: photoFile!.type,
          time_commitment: commitments.trim(),
          meeting_availability: meetingChoice === 'confirm' ? MEETING_CONFIRMATION : meetingOther.trim(),
          retreat_availability: retreatChoice === 'confirm' ? RETREAT_CONFIRMATION : retreatOther.trim(),
          hours_confirmed: hoursConfirmed,
          essays,
          additional_context: additionalContext.trim() || null,
          race: race.map(r => r === RACE_OTHER_PREFIX ? `${RACE_OTHER_PREFIX}${raceOther.trim()}` : r),
          ethnicity: ethnicity || null,
          transfer: transfer ? transfer === 'Yes' : null,
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
      setSubmitError(err instanceof Error ? err.message : 'An unexpected error occurred. Please contact contact@product.berkeley.edu.')
    } finally {
      setSubmitting(false)
    }
  }

  if (authStatus === 'loading') return null
  if (authStatus !== 'authenticated' || !applicantVerified || !berkeleyAccount) {
    const wrongAccount = authStatus === 'authenticated' && authEmail
    const startSignIn = async () => {
      if (window.self !== window.top) {
        window.open('/apply/form', '_blank', 'noopener,noreferrer')
        return
      }
      if (wrongAccount) await signOut({ redirect: false })
      // `hd` asks Google to suggest berkeley.edu accounts; the server still checks.
      void signIn('google', { callbackUrl: '/apply/form' }, { hd: 'berkeley.edu', prompt: 'select_account' })
    }
    return (
      <div className="apply-page">
        <div className="apply-home-card">
          <Image src="/product-space-logo.png" alt="Product Space" width={50} height={50} />
          {wrongAccount ? (
            <>
              <h2>Use your Berkeley account</h2>
              <p role="alert">
                You&apos;re signed in as <strong>{authEmail}</strong>. Product Space applications require your
                {' '}<strong>@berkeley.edu</strong> Google account. Sign in again and choose your Berkeley account.
              </p>
            </>
          ) : (
            <>
              <h2>Verify your email</h2>
              <p>Sign in with your @berkeley.edu Google account to start your application.</p>
            </>
          )}
          <button
            type="button"
            className="apply-btn-primary"
            onClick={startSignIn}
          >
            {wrongAccount ? 'Sign in with your Berkeley account' : 'Sign in with Google'}
          </button>
        </div>
      </div>
    )
  }
  if (!cycle) {
    return (
      <div className="apply-page">
        <div className="apply-home-card">
          <Image src="/product-space-logo.png" alt="Product Space" width={50} height={50} />
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
          <Image src="/product-space-logo.png" alt="Product Space" width={80} height={80} />
          <h1>Product Space Application — {cycle.name}</h1>
          <h4>Thank you for your interest in Product Space!<br />Please fill out the information below and we will get back to you soon.</h4>
          <p>All applications submitted are final; duplicates will not be accepted.</p>
          {draftMessage && (
            <p aria-live="polite" style={{ color: '#6b7280', fontSize: '0.9rem' }}>{draftMessage}</p>
          )}
          {cycle.application_deadline && (
            <p style={{ color: 'var(--ps-accent)' }}>
              Applications close on {new Date(cycle.application_deadline).toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short', timeZone: 'America/Los_Angeles' })} PT
            </p>
          )}
        </div>

        <div className="apply-field">
          <label>First Name</label>
          <input type="text" value={firstName} onChange={e => setFirstName(e.target.value)} />
          {fieldError('firstName') && <p className="apply-warning">{fieldError('firstName')}</p>}
        </div>

        <div className="apply-field">
          <label>Last Name</label>
          <input type="text" value={lastName} onChange={e => setLastName(e.target.value)} />
          {fieldError('lastName') && <p className="apply-warning">{fieldError('lastName')}</p>}
        </div>

        <div className="apply-field">
          <label>Berkeley Email</label>
          <input type="email" value={authEmail} readOnly aria-readonly="true" />
          <p className="apply-hint" style={{ marginTop: '0.25rem' }}>This is the Google account you signed in with.</p>
        </div>

        <div className="apply-field">
          <label>Phone Number</label>
          <input type="text" value={phone} onChange={e => setPhone(e.target.value)} autoComplete="tel" />
          {fieldError('phone') && <p className="apply-warning">{fieldError('phone')}</p>}
        </div>

        <div className="apply-field">
          <label>Are you an undergraduate continuing UC Berkeley student?</label>
          <p className="apply-hint">As a campus student organization, Product Space at Berkeley can only support undergraduate UC Berkeley students at this time.</p>
          <label className="apply-choice">
            <input type="checkbox" checked={undergradConfirmed} onChange={e => setUndergradConfirmed(e.target.checked)} />
            Yes, I confirm that I am an undergraduate continuing student at UC Berkeley.
          </label>
          {fieldError('undergrad') && <p className="apply-warning">{fieldError('undergrad')}</p>}
        </div>

        <div className="apply-field">
          <label>Major(s) &amp; Minor(s)</label>
          <input type="text" value={major} onChange={e => setMajor(e.target.value)} />
          {fieldError('major') && <p className="apply-warning">{fieldError('major')}</p>}
        </div>

        <ChoiceField label="Year" name="year" options={APPLICANT_YEARS} value={year} onChange={setYear} error={fieldError('year')} />

        <ChoiceField
          label="Have you previously applied to Product Space?"
          name="previouslyApplied"
          options={['Yes', 'No']}
          value={previouslyApplied}
          onChange={v => setPreviouslyApplied(v as YesNo)}
          error={fieldError('previouslyApplied')}
        />

        <FileField
          label="Resume"
          hint="Please upload a one-page PDF. Documents of other formats will not be reviewed."
          accept="application/pdf"
          file={resumeFile}
          error={fieldError('resume')}
          onPick={file => pickFile(file, 'resume')}
        />

        <FileField
          label="Photo"
          hint="Please include a picture of you alone (JPG or PNG). This is just for us to match names to faces and will NOT be used in the evaluation of your application!"
          accept={PHOTO_TYPES.join(',')}
          file={photoFile}
          error={fieldError('photo')}
          onPick={file => pickFile(file, 'photo')}
        />

        <div className="apply-field">
          <label>Please list your existing commitments for this semester, including academics, work, clubs, and research.</label>
          <p className="apply-hint">
            For each commitment, include the name and your estimated weekly time commitment. For courses, list each course
            individually. For clubs or organizations, include your role or position and the estimated weekly time commitment in hours.
          </p>
          <p className="apply-hint">Example: CS170 - 10 hrs/week, DATA100 - 10 hrs/week; research - 6 hrs/week</p>
          <textarea value={commitments} maxLength={3000} onChange={e => setCommitments(e.target.value)} />
          {fieldError('commitments') && <p className="apply-warning">{fieldError('commitments')}</p>}
        </div>

        <AvailabilityField
          label="Our mandatory general meetings are weekly on Thursdays from 8:00 - 9:30 PM. Please plan to keep this time available if possible."
          name="meeting"
          confirmation={MEETING_CONFIRMATION}
          choice={meetingChoice}
          other={meetingOther}
          onChoice={setMeetingChoice}
          onOther={setMeetingOther}
          error={fieldError('meeting')}
        />

        <AvailabilityField
          label="Our retreat is tentatively scheduled for 9/18 - 9/20. Just in case, please add a calendar reminder for these dates."
          name="retreat"
          confirmation={RETREAT_CONFIRMATION}
          choice={retreatChoice}
          other={retreatOther}
          onChoice={setRetreatChoice}
          onOther={setRetreatOther}
          error={fieldError('retreat')}
        />

        <div className="apply-field">
          <label>Please confirm that you are able to dedicate at least 15 hours a week to Product Space (meetings, socials, &amp; assignments).</label>
          <label className="apply-choice">
            <input type="checkbox" checked={hoursConfirmed} onChange={e => setHoursConfirmed(e.target.checked)} />
            Yes, I can dedicate 15 hours a week.
          </label>
          {fieldError('hours') && <p className="apply-warning">{fieldError('hours')}</p>}
        </div>

        <h3 className="apply-section-title">Written Questions</h3>
        <p style={{ color: 'var(--text-muted)', marginBottom: '1.5rem' }}>Please do not exceed the word limit.</p>

        {prompts.map(prompt => {
          const key = `answer_${prompt.id}`
          const answer = answers[key] ?? ''
          const description = prompt.description ? promptDescriptionWithoutWordCount(prompt.description) : ''
          return (
            <div className="apply-field" key={prompt.id}>
              <label>
                {prompt.prompt}{' '}
                {prompt.word_limit && <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>[{prompt.word_limit} words max]</span>}
              </label>
              {description && <p className="apply-hint">{description}</p>}
              <textarea
                value={answer}
                onChange={e => setAnswers(prev => ({ ...prev, [key]: e.target.value }))}
              />
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                {prompt.word_limit
                  ? `${countWords(answer)} / ${prompt.word_limit} words`
                  : `${answer.length} / 1,500 characters`}
              </p>
              {fieldError(key) && <p className="apply-warning">{fieldError(key)}</p>}
            </div>
          )
        })}

        <div className="apply-field">
          <label>[Optional] Do you have any important context or clarifications that you&apos;d like to share with us?</label>
          <p className="apply-hint">
            This is not intended as extra room to bolster your application. This is a space for information such as
            personal/family circumstances, atypical academic paths, context on existing commitments, etc.
          </p>
          <textarea value={additionalContext} maxLength={3000} onChange={e => setAdditionalContext(e.target.value)} />
        </div>

        <h3 className="apply-section-title">Self Identification</h3>
        <p style={{ color: 'var(--text-muted)', marginBottom: '1.5rem' }}>
          All questions in this section are completely optional and are used purely for reporting purposes to improve our
          recruitment process. Any answers you provide will not be used against you in any way.
        </p>

        <div className="apply-field">
          <label>Race (Select one or more)</label>
          {RACE_OPTIONS.map(option => (
            <label key={option} className="apply-choice">
              <input type="checkbox" checked={race.includes(option)} onChange={() => toggleRace(option)} />
              {option}
            </label>
          ))}
          <label className="apply-choice">
            <input type="checkbox" checked={race.includes(RACE_OTHER_PREFIX)} onChange={() => toggleRace(RACE_OTHER_PREFIX)} />
            Other:
          </label>
          {race.includes(RACE_OTHER_PREFIX) && (
            <input type="text" value={raceOther} maxLength={MAX_RACE_OTHER_LENGTH} onChange={e => setRaceOther(e.target.value)} />
          )}
          {fieldError('race') && <p className="apply-warning">{fieldError('race')}</p>}
        </div>

        <ChoiceField label="Ethnicity" name="ethnicity" options={ETHNICITY_OPTIONS} value={ethnicity} onChange={setEthnicity} optional />

        <ChoiceField
          label="Are you a transfer student?"
          name="transfer"
          options={['Yes', 'No']}
          value={transfer}
          onChange={v => setTransfer(v as YesNo)}
          optional
        />

        <div style={{ marginBottom: '3rem' }}>
          <button type="submit" className="apply-btn-primary" disabled={submitting}>
            {submitting ? 'Submitting...' : 'Submit'}
          </button>
          {issues.length > 0 && (
            <div role="alert" className="apply-warning">
              <p>Please fix {issues.length === 1 ? 'this' : `these ${issues.length}`} before submitting:</p>
              <ul style={{ margin: '0.25rem 0 0 1.25rem', listStyle: 'disc' }}>
                {issues.map(issue => <li key={issue.key}><strong>{issue.label}:</strong> {issue.message}</li>)}
              </ul>
            </div>
          )}
          {submitError && <p role="alert" className="apply-warning">{submitError}</p>}
        </div>

        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Copyright © 2026 Product Space All Rights Reserved.</p>
      </form>
    </div>
  )
}

function ChoiceField({ label, name, options, value, onChange, error, optional }: {
  label: string
  name: string
  options: readonly string[]
  value: string
  onChange: (value: string) => void
  error?: string
  optional?: boolean
}) {
  return (
    <div className="apply-field" role="radiogroup" aria-label={label}>
      <label>{label}</label>
      {options.map(option => (
        <label key={option} className="apply-choice">
          <input type="radio" name={name} checked={value === option} onChange={() => onChange(option)} />
          {option}
        </label>
      ))}
      {optional && value && (
        <button type="button" onClick={() => onChange('')} style={{ alignSelf: 'flex-start', fontSize: '0.85rem', color: 'var(--text-muted)', textDecoration: 'underline' }}>
          Clear selection
        </button>
      )}
      {error && <p className="apply-warning">{error}</p>}
    </div>
  )
}

function AvailabilityField({ label, name, confirmation, choice, other, onChoice, onOther, error }: {
  label: string
  name: string
  confirmation: string
  choice: AvailabilityChoice
  other: string
  onChoice: (choice: AvailabilityChoice) => void
  onOther: (text: string) => void
  error?: string
}) {
  return (
    <div className="apply-field" role="radiogroup" aria-label={label}>
      <label>{label}</label>
      <p className="apply-hint">If you have a time conflict, feel free to select &quot;Other&quot; and briefly explain. This will <strong>NOT</strong> impact or disqualify your application.</p>
      <label className="apply-choice">
        <input type="radio" name={name} checked={choice === 'confirm'} onChange={() => onChoice('confirm')} />
        {confirmation}
      </label>
      <label className="apply-choice">
        <input type="radio" name={name} checked={choice === 'other'} onChange={() => onChoice('other')} />
        Other:
      </label>
      {choice === 'other' && (
        <input type="text" value={other} maxLength={MAX_AVAILABILITY_NOTE_LENGTH} onChange={e => onOther(e.target.value)} />
      )}
      {error && <p className="apply-warning">{error}</p>}
    </div>
  )
}

function FileField({ label, hint, accept, file, error, onPick }: {
  label: string
  hint: string
  accept: string
  file: File | null
  error?: string
  onPick: (file: File | undefined) => void
}) {
  return (
    <div className="apply-field">
      <label>{label}</label>
      <p className="apply-hint">{hint}</p>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
        <label className="apply-btn-secondary" style={{ cursor: 'pointer', marginBottom: 0 }}>
          Choose File
          <input type="file" accept={accept} style={{ display: 'none' }} onChange={e => onPick(e.target.files?.[0])} />
        </label>
        <span style={{ color: file ? 'var(--text-primary)' : 'grey', fontSize: '0.9rem' }}>
          {file ? file.name : 'No file chosen'}
        </span>
      </div>
      {error && <p className="apply-warning">{error}</p>}
    </div>
  )
}
