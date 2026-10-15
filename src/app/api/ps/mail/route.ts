import {NextRequest,NextResponse} from 'next/server'
import {psApi} from '@/lib/ps/api'
import {readJsonObject} from '@/lib/apiValidation'
import {connectMailbox,disconnectMailbox,mailState,previewMail,sendMail} from '@/lib/ps/mail'
import {WorkflowError} from '@/lib/ps/domain'
export async function GET(req:NextRequest){return psApi('admin',async a=>NextResponse.json(await mailState(a.email,req.nextUrl.searchParams.get('round_id')??undefined),{headers:{'Cache-Control':'no-store'}}))}
export async function POST(req:NextRequest){return psApi('admin',async a=>{const b=await readJsonObject(req);if(!b.ok)return b.response;switch(b.data.action){case 'connect':return NextResponse.json(await connectMailbox(a.email));case 'disconnect':return NextResponse.json(await disconnectMailbox(a.email));case 'preview':return NextResponse.json(await previewMail(String(b.data.round_id),a.email,b.data));case 'send':if(!Array.isArray(b.data.ids)||b.data.ids.some(x=>typeof x!=='string'))throw new WorkflowError('Select messages to send.');return NextResponse.json(await sendMail(a.email,b.data.ids));default:throw new WorkflowError('Unknown email action.')}})}
