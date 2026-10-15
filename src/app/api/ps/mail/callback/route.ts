import {NextRequest,NextResponse} from 'next/server'
import {psApi} from '@/lib/ps/api'
import {finishMailbox} from '@/lib/ps/mail'
export async function GET(req:NextRequest){return psApi('admin',async a=>{await finishMailbox(a.email,req.nextUrl.searchParams.get('state')??'',req.nextUrl.searchParams.get('code')??'');return NextResponse.redirect(new URL('/admin/rounds',process.env.NEXTAUTH_URL))})}
