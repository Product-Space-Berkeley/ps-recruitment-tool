import {NextResponse} from 'next/server'
import {psApi} from '@/lib/ps/api'
import {readJsonObject} from '@/lib/apiValidation'
import {socialCards,changeSocialCard} from '@/lib/ps/social'
type Context={params:Promise<{id:string;candidateId:string}>}
export async function GET(_req:Request,{params}:Context){return psApi('grader',async a=>{const p=await params;return NextResponse.json(await socialCards(p.id,p.candidateId,a.email),{headers:{'Cache-Control':'no-store'}})})}
export async function POST(req:Request,{params}:Context){return psApi('grader',async a=>{const p=await params,b=await readJsonObject(req);if(!b.ok)return b.response;return NextResponse.json(await changeSocialCard(p.id,p.candidateId,a.email,b.data))})}
