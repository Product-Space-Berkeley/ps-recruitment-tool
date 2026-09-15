import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Apply | Product Space @ Berkeley',
}

export default function ApplyLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
