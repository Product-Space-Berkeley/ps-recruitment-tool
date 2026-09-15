import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Grader Dashboard | PlexTech - Berkeley',
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
