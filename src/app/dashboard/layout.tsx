import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Grader Dashboard | Product Space @ Berkeley',
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
