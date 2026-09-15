import type { AuthOptions } from 'next-auth'
import GoogleProvider from 'next-auth/providers/google'
import { connectDB } from '@/lib/mongodb'
import { AuthorizedUser } from '@/lib/models'

export const authOptions: AuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],
  callbacks: {
    async signIn({ user, profile }) {
      if (!user.email) return false
      await connectDB()
      const email = user.email.trim().toLowerCase()
      const found = await AuthorizedUser.exists({ email })
      const googleProfile = profile as { email_verified?: boolean } | undefined
      const isVerifiedGoogleApplicant = googleProfile?.email_verified === true
      // Authorized members use the internal tools. Applicants may authenticate
      // with any verified Google account solely to prove ownership of the email
      // used on their application; requireRole() still rejects sessions without
      // an AuthorizedUser role from every protected internal API.
      return !!found || isVerifiedGoogleApplicant
    },
    async jwt({ token, profile }) {
      if (profile) {
        const googleProfile = profile as { email_verified?: boolean }
        token.applicantVerified = googleProfile.email_verified === true
      }
      return token
    },
    async session({ session, token }) {
      if (!session.user?.email) return session
      ;(session.user as typeof session.user & { applicantVerified?: boolean }).applicantVerified = token.applicantVerified === true
      await connectDB()
      const found = await AuthorizedUser.findOne({ email: session.user.email.toLowerCase() })
      if (found) {
        ;(session.user as typeof session.user & { role: string }).role = found.role
      }
      return session
    },
  },
  pages: {
    signIn: '/',
    error: '/unauthorized',
  },
}
