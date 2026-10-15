import { NextResponse } from 'next/server'
import { psApi } from '@/lib/ps/api'
import { readJsonObject } from '@/lib/apiValidation'
import { scheduleAction, scheduleData } from '@/lib/ps/scheduling'
type Context={params:Promise<{id:string}>}
export async function GET(_req:Request,{params}:Context){return psApi('leadership',async auth=>NextResponse.json(await scheduleData((await params).id,auth.email,auth.role)))}
export async function POST(req:Request,{params}:Context){return psApi('leadership',async auth=>{const b=await readJsonObject(req);if(!b.ok)return b.response;return NextResponse.json(await scheduleAction((await params).id,b.data,auth))})}
