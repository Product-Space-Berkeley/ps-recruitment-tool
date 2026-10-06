import { NextResponse } from 'next/server'
import { AuthorizedUser } from '@/lib/models'
import { psApi } from '@/lib/ps/api'
// Selection source only; global access/role management remains unchanged.
export async function GET() { return psApi('leadership', async () => NextResponse.json(await AuthorizedUser.find().select('email role').sort({ email: 1 }).lean())) }
