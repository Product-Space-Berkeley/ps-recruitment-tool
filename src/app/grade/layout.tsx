import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Grader Portal | PlexTech - Berkeley',
}

export default function GradeLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
