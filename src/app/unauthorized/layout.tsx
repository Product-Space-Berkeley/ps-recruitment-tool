import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Unauthorized | Product Space @ Berkeley',
}

export default function UnauthorizedLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
