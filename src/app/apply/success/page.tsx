'use client'

import { useSearchParams } from 'next/navigation'
import { useRouter } from 'next/navigation'
import { Suspense } from 'react'

function SuccessInner() {
  const router = useRouter()
  const params = useSearchParams()
  const id = params.get('id') ?? ''
  const name = params.get('name') ?? ''

  if (!id) {
    router.replace('/apply/form')
    return null
  }

  return (
    <div className="apply-page">
      <div className="apply-form-card">
        <h2>Thank you{name ? `, ${name}` : ''}, for applying to PlexTech!</h2>
        <h4>We will reach out to you very soon.</h4>
        <br />
        <h3 style={{ color: 'black' }}>Your Applicant ID:</h3>
        <h4 style={{ color: '#ff8a00' }}>{id}</h4>
        <h6>
          Please keep this ID in a safe place; you will not be able to access it later.<br />
          Should you need to contact us regarding your application, please refer to this ID.
        </h6>
        <br />
        <button className="apply-btn-primary" onClick={() => router.push('/apply')}>
          Return Home
        </button>
      </div>
    </div>
  )
}

export default function SuccessPage() {
  return (
    <Suspense fallback={null}>
      <SuccessInner />
    </Suspense>
  )
}
