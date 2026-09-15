'use client'

import { useRouter } from 'next/navigation'

export default function PrivacyPolicy() {
  const router = useRouter()

  return (
    <div className="apply-page">
      <div className="apply-form-card" style={{ maxWidth: '700px' }}>
        <h2>PlexTech Application Platform — Privacy Policy</h2>
        <p style={{ color: 'grey', lineHeight: 1.7 }}>
          To authenticate you, the application uses Google sign-in and receives your
          basic Google account identity. The form separately collects your required Berkeley email,
          contact and academic information,
          optional demographic information, links you choose to provide, your resume, and your
          written responses.<br /><br />
          PlexTech uses this information only to administer recruitment, grading, and deliberations.
          Access is limited to authorized PlexTech graders and leadership. Records are retained only
          as needed for recruitment administration and are removed from the active database when an
          administrator deletes the recruitment cycle; limited copies may remain temporarily in
          service-provider backups.<br /><br />
          To ask about your information or request deletion, contact info@plextech.berkeley.edu.
        </p>
        <button className="apply-btn-primary" onClick={() => router.push('/apply')}>
          Return Home
        </button>
      </div>
    </div>
  )
}
