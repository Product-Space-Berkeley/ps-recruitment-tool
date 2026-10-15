import mongoose, { Schema, model, models } from 'mongoose'
import { createHash, createHmac, randomBytes } from 'crypto'
import { Applicant, AuthorizedUser, GraderAssignment, Round } from '@/lib/models'
import { CandidateRound, GenericReview, PSEvaluationContribution, ReviewConflict } from './models'
import { lockRound, psRound } from './rounds'
import { WorkflowError } from './domain'
import { objectId, serialize } from './records'
const slotSchema = new Schema({ round_id: {type:Schema.Types.ObjectId,required:true}, start:{type:Date,required:true}, end:{type:Date,required:true}, break_minutes:{type:Number,default:0}, location:{type:String,required:true}, capacity:{type:Number,default:1}, cutoff_hours:{type:Number,default:24}, available_emails:[String] })
slotSchema.index({round_id:1,start:1},{unique:true})
export const InterviewSlot = models.InterviewSlot || model('InterviewSlot',slotSchema)
const bookingSchema = new Schema({round_id:{type:Schema.Types.ObjectId,required:true},applicant_id:{type:Schema.Types.ObjectId,required:true},slot_id:{type:Schema.Types.ObjectId,default:null},interviewers:[String],token_hash:{type:String,required:true,select:false},events:[{action:String,actor:String,at:Date}],needs_replacement:{type:Boolean,default:false}})
bookingSchema.index({round_id:1,applicant_id:1},{unique:true});bookingSchema.index({token_hash:1},{unique:true})
export const InterviewBooking=models.InterviewBooking||model('InterviewBooking',bookingSchema)
const hash=(token:string)=>createHash('sha256').update(token).digest('hex')
function number(value:unknown,min:number,max:number,fallback:number){const n=value===undefined?fallback:Number(value);if(!Number.isInteger(n)||n<min||n>max)throw new WorkflowError(`Enter a whole number between ${min} and ${max}.`);return n}
async function schedulingRound(id:string,tx:mongoose.ClientSession){const r=await lockRound(id,tx);if(!['pending','grading'].includes(r.status)||r.assignment_mode==='pair'||r.reviews_required!==2)throw new WorkflowError('Scheduling needs an open round with two independent reviews.',409);return r}
export async function scheduleData(id:string,email:string,role:string){await psRound(id);const slots=await InterviewSlot.find({round_id:id}).sort({start:1}).lean();const bookings=await InterviewBooking.find({round_id:id}).lean();const people=await Applicant.find({_id:mongoose.trusted({$in:bookings.map(b=>b.applicant_id)})}).select('first_name last_name').lean();return {slots:slots.map(serialize),bookings:bookings.filter(b=>role==='admin'||role==='leadership'||b.interviewers.includes(email)).map(b=>({...serialize(b),name:people.find(p=>String(p._id)===String(b.applicant_id))?.first_name+' '+(people.find(p=>String(p._id)===String(b.applicant_id))?.last_name??'')}))}}
export async function scheduleAction(id:string,body:Record<string,unknown>,actor:{email:string;role:string}){
  objectId(id);await Promise.all([InterviewSlot.init(),InterviewBooking.init()]);let result:Record<string,unknown>={ok:true}
  await mongoose.connection.transaction(async tx=>{
    const round=await schedulingRound(id,tx), admin=actor.role==='admin'
    await AuthorizedUser.updateMany({email:mongoose.trusted({$in:round.eligible_grader_emails})},{$inc:{assignment_write_count:1}},{session:tx})
    if(body.action==='create_slots'){
      if(!admin)throw new WorkflowError('Only admins configure interview slots.',403)
      const start=new Date(String(body.start)),duration=number(body.duration,5,180,45),gap=number(body.break_minutes,0,120,10),count=number(body.count,1,40,1),capacity=number(body.capacity,1,20,1),cutoff=number(body.cutoff_hours,0,168,24),location=String(body.location??'').trim()
      if(!Number.isFinite(+start)||+start<=Date.now()||!location||location.length>300)throw new WorkflowError('Choose a future start time and a location (up to 300 characters).')
      const rows=Array.from({length:count},(_,i)=>({round_id:id,start:new Date(+start+i*(duration+gap)*60000),end:new Date(+start+(i*(duration+gap)+duration)*60000),break_minutes:gap,capacity,cutoff_hours:cutoff,location,available_emails:[]}))
      const existing=await InterviewSlot.find({round_id:id}).session(tx).lean()
      if(rows.some(r=>existing.some(e=>+r.start<+e.end+e.break_minutes*60000&&+r.end+gap*60000>+e.start)))throw new WorkflowError('Slots overlap. Use capacity for simultaneous interviews.',409)
      await InterviewSlot.insertMany(rows,{session:tx})
    }else if(body.action==='invite'){
      if(!admin)throw new WorkflowError('Only admins create booking links.',403)
      const aid=String(body.applicant_id);objectId(aid)
      if(!await CandidateRound.exists({round_id:id,applicant_id:aid,state:mongoose.trusted({$in:['pending','in_review']})}).session(tx))throw new WorkflowError('Applicant is not waiting for this interview.',409)
      const token=body.mail_key && process.env.MAIL_TOKEN_KEY ? createHmac('sha256',process.env.MAIL_TOKEN_KEY).update(String(body.mail_key)).digest('hex') : randomBytes(32).toString('hex')
      await InterviewBooking.findOneAndUpdate({round_id:id,applicant_id:aid},{$set:{token_hash:hash(token)},$setOnInsert:{interviewers:[]},$push:{events:{action:'link_created',actor:actor.email,at:new Date()}}},{upsert:true,session:tx})
      result={token,applicant_id:aid}
    }else if(body.action==='availability'){
      if(!round.eligible_grader_emails.includes(actor.email))throw new WorkflowError('You are not in this round’s reviewer pool.',403)
      const sid=String(body.slot_id);objectId(sid)
      const slot=await InterviewSlot.findOne({_id:sid,round_id:id}).session(tx).lean();if(!slot||+slot.start<=Date.now())throw new WorkflowError('This slot is no longer available.',409)
      if(typeof body.available!=='boolean')throw new WorkflowError('Choose available or unavailable.')
      await InterviewSlot.updateOne({_id:sid},body.available?{$addToSet:{available_emails:actor.email}}:{$pull:{available_emails:actor.email}},{session:tx})
      if(!body.available){const booked=await InterviewBooking.find({round_id:id,slot_id:sid,interviewers:actor.email}).session(tx).lean();for(const b of booked){await assertUnstarted(String(b.applicant_id),id,tx);await GraderAssignment.deleteOne({round_id:id,applicant_id:b.applicant_id,grader_email:actor.email},{session:tx});await InterviewBooking.updateOne({_id:b._id},{$pull:{interviewers:actor.email},$set:{needs_replacement:true},$push:{events:{action:'interviewer_cancelled',actor:actor.email,at:new Date()}}},{session:tx});await allocate(String(b._id),round,slot,tx)}}
    }else if(body.action==='replace'){
      if(!admin)throw new WorkflowError('Only admins retry allocation.',403)
      const bid=String(body.booking_id);objectId(bid);const b=await InterviewBooking.findOne({_id:bid,round_id:id}).session(tx).lean();if(!b?.slot_id)throw new WorkflowError('Booking not found.',404);const slot=await InterviewSlot.findById(b.slot_id).session(tx).lean();if(!slot)throw new WorkflowError('Slot not found.',404);await allocate(bid,round,slot,tx)
    }else throw new WorkflowError('Unknown scheduling action.')
  });return result
}
async function assertUnstarted(aid:string,rid:string,tx:mongoose.ClientSession){if(await PSEvaluationContribution.exists({round_id:rid,applicant_id:aid}).session(tx)||await GenericReview.exists({round_id:rid,applicant_id:aid}).session(tx))throw new WorkflowError('Reviews have started. Ask leadership to resolve the review before changing interviewers.',409)}
type Slot={_id:unknown;start:Date;end:Date;break_minutes:number;capacity:number;cutoff_hours:number;available_emails:string[]}
export async function allocate(bid:string,round:{_id:unknown;eligible_grader_emails:string[]},slot:Slot,tx:mongoose.ClientSession){
 const booking=await InterviewBooking.findById(bid).session(tx).lean();if(!booking)throw new WorkflowError('Booking not found.',404)
 const slots=await InterviewSlot.find({start:mongoose.trusted({$lt:new Date(+slot.end+slot.break_minutes*60000)})}).session(tx).lean()
 const overlapping=slots.filter(s=>+s.end+s.break_minutes*60000>+slot.start).map(s=>s._id)
 const busy=await InterviewBooking.find({_id:mongoose.trusted({$ne:booking._id}),slot_id:mongoose.trusted({$in:overlapping})}).session(tx).lean()
 const conflicts=await ReviewConflict.find({round_id:round._id,applicant_id:booking.applicant_id}).session(tx).lean()
 const allowed=await AuthorizedUser.find({email:mongoose.trusted({$in:round.eligible_grader_emails}),role:mongoose.trusted({$in:['admin','leadership']})}).session(tx).lean()
 const current=await InterviewSlot.findById(slot._id).session(tx).lean()
 const counts=await InterviewBooking.find({round_id:round._id}).session(tx).lean()
 const load=(email:string)=>counts.reduce((n,b)=>n+Number(b.interviewers.includes(email)),0)
 const candidates=allowed.map(a=>a.email).filter(e=>current?.available_emails.includes(e)&&!booking.interviewers.includes(e)&&!busy.some(b=>b.interviewers.includes(e))&&!conflicts.some(c=>c.grader_email===e)).sort((a,b)=>load(a)-load(b)||a.localeCompare(b))
 const selected=[...booking.interviewers,...candidates.slice(0,2-booking.interviewers.length)]
 await InterviewBooking.updateOne({_id:bid},{$set:{interviewers:selected,needs_replacement:selected.length<2}},{session:tx})
 for(const email of selected)await GraderAssignment.updateOne({round_id:round._id,applicant_id:booking.applicant_id,grader_email:email},{$setOnInsert:{assigned_at:new Date()}},{upsert:true,session:tx})
 return selected.length===2
}
export async function bookingData(token:string){if(!/^[a-f0-9]{64}$/.test(token))throw new WorkflowError('Invalid booking link.',404);const b=await InterviewBooking.findOne({token_hash:hash(token)}).lean();if(!b)throw new WorkflowError('This booking link has expired or was replaced.',404);const round=await psRound(String(b.round_id));const slots=await InterviewSlot.find({round_id:b.round_id,start:mongoose.trusted({$gt:new Date()})}).sort({start:1}).lean();const bookings=await InterviewBooking.find({round_id:b.round_id}).lean();return {round_name:round.name,booking:serialize(b),slots:slots.filter(s=>bookings.filter(x=>String(x.slot_id)===String(s._id)).length<s.capacity||String(b.slot_id)===String(s._id)).map(s=>({id:String(s._id),start:s.start,end:s.end,location:s.location,cutoff_hours:s.cutoff_hours}))}}
export async function bookSlot(token:string,sid:string){objectId(sid);if(!/^[a-f0-9]{64}$/.test(token))throw new WorkflowError('Invalid booking link.',404)
 await mongoose.connection.transaction(async tx=>{const b=await InterviewBooking.findOne({token_hash:hash(token)}).session(tx).lean();if(!b)throw new WorkflowError('Invalid booking link.',404);const round=await schedulingRound(String(b.round_id),tx);const slot=await InterviewSlot.findOne({_id:sid,round_id:b.round_id}).session(tx).lean();if(!slot||+slot.start-slot.cutoff_hours*3600000<=Date.now())throw new WorkflowError('This slot is past its booking cutoff.',409);if(String(b.slot_id)===sid)return
 if(b.slot_id){const old=await InterviewSlot.findById(b.slot_id).session(tx).lean();if(!old||+old.start-old.cutoff_hours*3600000<=Date.now())throw new WorkflowError('Rescheduling has closed. Contact leadership.',409)}
 await assertUnstarted(String(b.applicant_id),String(b.round_id),tx)
 if(await InterviewBooking.countDocuments({slot_id:sid}).session(tx)>=slot.capacity)throw new WorkflowError('Someone just booked the last place. Choose another slot.',409)
 // Serialize allocations across rounds too: each eligible interviewer is a shared write fence.
 await AuthorizedUser.updateMany({email:mongoose.trusted({$in:round.eligible_grader_emails})},{$inc:{assignment_write_count:1}},{session:tx})
 await GraderAssignment.deleteMany({round_id:b.round_id,applicant_id:b.applicant_id},{session:tx})
 await InterviewBooking.updateOne({_id:b._id},{$set:{slot_id:sid,interviewers:[]},$push:{events:{action:b.slot_id?'rescheduled':'booked',actor:'applicant',at:new Date()}}},{session:tx})
 if(!round.rubric_version_id)throw new WorkflowError('Leadership must publish the rubric before booking opens.',409)
 if(!await allocate(String(b._id),round,slot,tx))throw new WorkflowError('Two interviewers are not available for this slot. Choose another or contact leadership.',409)
 await Round.updateOne({_id:round._id},{$set:{status:'grading'}},{session:tx})
 });return {ok:true}
}
