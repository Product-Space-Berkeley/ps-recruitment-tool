import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Apply | PlexTech - Berkeley',
}

export default function ApplyLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
