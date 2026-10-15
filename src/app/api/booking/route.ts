import { NextRequest, NextResponse } from 'next/server'
import { connectDB } from '@/lib/mongodb'
import { bookingData, bookSlot } from '@/lib/ps/scheduling'
import { WorkflowError } from '@/lib/ps/domain'
import { readJsonObject } from '@/lib/apiValidation'
async function run(action:()=>Promise<unknown>){try{await connectDB();return NextResponse.json(await action(),{headers:{'Cache-Control':'no-store'}})}catch(e){return NextResponse.json({error:e instanceof WorkflowError?e.message:'Unable to book. Please retry.'},{status:e instanceof WorkflowError?e.status:500})}}
export async function GET(req:NextRequest){return run(()=>bookingData(req.headers.get('x-booking-token')??''))}
export async function POST(req:NextRequest){const b=await readJsonObject(req);if(!b.ok)return b.response;return run(()=>bookSlot(req.headers.get('x-booking-token')??'',String(b.data.slot_id??'')))}
