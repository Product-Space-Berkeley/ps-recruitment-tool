import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Deliberation | PlexTech - Berkeley',
}

export default function SessionLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
