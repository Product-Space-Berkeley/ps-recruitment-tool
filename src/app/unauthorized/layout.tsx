import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Unauthorized | PlexTech - Berkeley',
}

export default function UnauthorizedLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
