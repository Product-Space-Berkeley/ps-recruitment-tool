import { DefaultSession } from 'next-auth'

declare module 'next-auth' {
  interface Session {
    user?: DefaultSession['user'] & {
      role?: 'grader' | 'leadership' | 'admin'
      applicantVerified?: boolean
    }
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    applicantVerified?: boolean
  }
}
