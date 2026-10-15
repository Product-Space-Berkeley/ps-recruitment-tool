import assert from 'node:assert/strict'
export async function latePhases({call,base,mongoose,emails}) {
 const db=mongoose.connection,oid=()=>new mongoose.Types.ObjectId(),cycle=oid(),round=oid(),a=oid(),b=oid()
 await db.collection('authorizedusers').updateMany({email:{$in:emails}},{$set:{role:'leadership'}})
 await db.collection('recruitmentcycles').insertOne({_id:cycle,name:'Scheduling fixture',status:'active'})
 await db.collection('rounds').insertOne({_id:round,cycle_id:cycle,workflow:'ps',name:'Take-home',status:'pending',archived:false,order_index:1,reviews_required:2,assignment_mode:'individual',grading_access:'assigned',eligible_grader_emails:emails,rubric_version_id:oid()})
 await db.collection('applicants').insertMany([a,b].map((id,i)=>({_id:id,cycle_id:cycle,first_name:'Scheduling '+i,last_name:'Test',year:'Junior (Transfer)',email:`schedule${i}@example.test`})))
 await db.collection('candidaterounds').insertMany([a,b].map(id=>({round_id:round,cycle_id:cycle,applicant_id:id,state:'pending',events:[]})))
 const url=`/api/ps/rounds/${round}/schedule`,start=new Date(Date.now()+7*86400000).toISOString()
 await call(url,{method:'POST',role:'leadership',email:emails[0],body:{action:'create_slots',start,location:'Campus'},status:403})
 await call(url,{method:'POST',body:{action:'create_slots',start,duration:45,break_minutes:15,count:2,capacity:1,location:'Campus',cutoff_hours:24}})
 const slots=(await call(url)).slots
 assert.equal(new Date(slots[1].start)-new Date(slots[0].start),3600000)
 for(const slot of slots)for(const email of emails)await call(url,{method:'POST',role:'leadership',email,body:{action:'availability',slot_id:slot.id,available:true}})
 const links=[];for(const id of [a,b])links.push((await call(url,{method:'POST',body:{action:'invite',applicant_id:String(id)}})).token)
 async function book(token,slot){const res=await fetch(base+'/api/booking',{method:'POST',headers:{'Content-Type':'application/json','x-booking-token':token,origin:base},body:JSON.stringify({slot_id:slot})});return {status:res.status,data:await res.json()}}
 const collision=await Promise.all(links.map(token=>book(token,slots[0].id)))
 assert.deepEqual(collision.map(r=>r.status).sort(),[200,409],JSON.stringify(collision))
 const winner=collision.findIndex(r=>r.status===200),loser=1-winner
 assert.equal((await book(links[loser],slots[1].id)).status,200)
 const bookings=(await call(url)).bookings
 assert.ok(bookings.every(x=>x.interviewers.length===2))
 assert.equal(await db.collection('graderassignments').countDocuments({round_id:round}),4)
 await call(`/api/ps/rounds/${round}/assignments`,{status:409})
 const first=bookings.find(x=>x.slot_id===slots[0].id)
 const removed=first.interviewers[0]
 await call(url,{method:'POST',role:'leadership',email:removed,body:{action:'availability',slot_id:slots[0].id,available:false}})
 const replaced=(await call(url)).bookings.find(x=>x.id===first.id)
 assert.equal(replaced.interviewers.length,2);assert.ok(!replaced.interviewers.includes(removed))
 const cancelled=replaced.interviewers.find(email=>!first.interviewers.includes(email))
 await call(url,{method:'POST',role:'leadership',email:cancelled,body:{action:'availability',slot_id:slots[0].id,available:false}})
 await call(`/api/ps/rounds/${round}/conflicts`,{method:'POST',role:'leadership',email:cancelled,body:{applicant_id:first.applicant_id}})
 assert.equal((await call(url)).bookings.find(x=>x.id===first.id).needs_replacement,true)
 await call(url,{method:'POST',role:'leadership',email:removed,body:{action:'availability',slot_id:slots[0].id,available:true}})
 await call(url,{method:'POST',body:{action:'replace',booking_id:first.id}})
 assert.equal((await call(url)).bookings.find(x=>x.id===first.id).needs_replacement,false)
 assert.equal(await db.collection('reviewconflicts').countDocuments({round_id:round,resolved:false}),0)
 // A different round cannot book interviewers already occupied at this time.
 const overlapping=oid(),other=oid()
 await db.collection('rounds').insertOne({_id:overlapping,cycle_id:cycle,workflow:'ps',name:'Overlapping PD',status:'pending',archived:false,order_index:0,reviews_required:2,assignment_mode:'individual',grading_access:'assigned',eligible_grader_emails:emails,rubric_version_id:oid()})
 await db.collection('applicants').insertOne({_id:other,cycle_id:cycle,first_name:'Other',last_name:'Slot',email:'other-slot@example.test'})
 await db.collection('candidaterounds').insertOne({round_id:overlapping,cycle_id:cycle,applicant_id:other,state:'pending'})
 const otherUrl=`/api/ps/rounds/${overlapping}/schedule`
 await call(otherUrl,{method:'POST',body:{action:'create_slots',start,location:'Other room'}})
 const otherSlot=(await call(otherUrl)).slots[0]
 for(const email of emails)await call(otherUrl,{method:'POST',role:'leadership',email,body:{action:'availability',slot_id:otherSlot.id,available:true}})
 const otherLink=await call(otherUrl,{method:'POST',body:{action:'invite',applicant_id:String(other)}})
 assert.equal((await book(otherLink.token,otherSlot.id)).status,409)
 assert.equal(await db.collection('graderassignments').countDocuments({round_id:overlapping}),0)
 // Explicit offsets preserve the two distinct 1:30 AM slots on the fall-back day.
 await call(otherUrl,{method:'POST',body:{action:'create_slots',start:'2030-11-03T01:30:00-07:00',duration:30,break_minutes:30,count:2,location:'DST fixture'}})
 const dst=(await call(otherUrl)).slots.filter(s=>s.location==='DST fixture')
 assert.equal(new Date(dst[1].start)-new Date(dst[0].start),3600000)
 const clock=s=>new Date(s).toLocaleString('en-US',{timeZone:'America/Los_Angeles',hour:'numeric',minute:'2-digit',timeZoneName:'short'})
 assert.match(clock(dst[0].start),/1:30 AM PDT/);assert.match(clock(dst[1].start),/1:30 AM PST/)

 await db.collection('interviewslots').updateOne({_id:new mongoose.Types.ObjectId(slots[0].id)},{$set:{start:new Date(Date.now()+3600000)}})
 assert.equal((await book(links[winner],slots[1].id)).status,409)
 assert.equal((await book('bad',slots[1].id)).status,404)
 const fresh=(await call(url,{method:'POST',body:{action:'invite',applicant_id:String(winner===0?a:b)}})).token
 assert.notEqual(fresh,links[winner]);assert.equal((await book(links[winner],slots[0].id)).status,404)
 console.log('Phase 4 scheduling: concurrent capacity, independent assignments, availability replacement, cutoff, invalid/replaced links and authorization passed.')
 // Final-room social membership, ownership, host moderation and polling readback.
 await db.collection('rounds').updateOne({_id:round},{$set:{status:'deliberating'}})
 await db.collection('candidaterounds').updateMany({round_id:round},{$set:{state:'hold'}})
 const room=await call(`/api/ps/rounds/${round}/deliberation`,{method:'POST',body:{}})
 const candidates=await call(`/api/sessions/${room.id}/candidates`),cid=candidates[0].id
 await db.collection('sessionmembers').insertMany(emails.slice(0,2).map(user_email=>({session_id:room.id,user_email})))
 const social=`/api/ps/sessions/${room.id}/social/${cid}`
 await call(social,{role:'grader',email:'outsider@example.test',status:403})
 await call(social,{method:'POST',role:'leadership',email:emails[0],body:{color:'green',text:'Helped the group include everyone.'}})
 let card=(await call(social,{role:'leadership',email:emails[1]})).cards[0]
 assert.equal(card.author,emails[0]);assert.equal(card.color,'green')
 await call(social,{method:'POST',role:'leadership',email:emails[1],body:{...card,text:'Changed'},status:403})
 await call(social,{method:'POST',role:'leadership',email:emails[0],body:{...card,color:'yellow',text:'Follow up about collaboration.'}})
 await call(social,{method:'POST',role:'leadership',email:emails[0],body:{...card,text:'Stale edit'},status:409})
 card=(await call(social)).cards[0];assert.equal(card.color,'yellow')
 await call(social,{method:'POST',body:{id:card.id,revision:card.revision,action:'delete'}})
 assert.equal((await call(social)).cards.length,0)
 console.log('Phase 5 social cards: membership, authored visibility, edit ownership, stale-edit rejection and host moderation passed.')
 // Provider calls are replaced in the disposable app; no real Google account or mail.
 const connect=await call('/api/ps/mail',{method:'POST',body:{action:'connect'}}),state=new URL(connect.url).searchParams.get('state')
 await call('/api/ps/mail',{method:'POST',role:'leadership',email:emails[0],body:{action:'connect'},status:403})
 const headers={'x-test-role':'admin','x-test-email':'lead@example.test'}
 const consent=await fetch(base+`/api/ps/mail/callback?state=${state}&code=fake`,{headers,redirect:'manual'})
 assert.equal(consent.status,307)
 await call(`/api/ps/mail/callback?state=${state}&code=fake`,{status:409})
 const mailbox=await db.collection('mailboxes').findOne({owner:'lead@example.test'});assert.ok(mailbox.encrypted_refresh&&!mailbox.encrypted_refresh.includes('fake-refresh'))
 const mailurl=`/api/ps/mail?round_id=${round}`
 const publicState=await call(mailurl)
 assert.ok(!JSON.stringify(publicState).includes('encrypted_refresh'))
 assert.ok(!JSON.stringify(publicState).includes('fake-refresh'))
 const preview={action:'preview',round_id:String(round),kind:'rejection',subject:'Decision for {{first_name}}',body:'Hi {{first_name}}, thank you for applying.'}
 assert.equal((await call('/api/ps/mail',{method:'POST',body:preview})).messages.length,0,'provisional colors do not create outcome emails')
 for(const c of candidates)await call(`/api/candidates/${c.id}`,{method:'PATCH',body:{status:'rejected'}})
 await call(`/api/ps/sessions/${room.id}/finish`,{method:'POST',body:{}})
 await call(social,{method:'POST',body:{color:'red',text:'Closed'},status:409})
 await call('/api/ps/mail',{method:'POST',body:{...preview,body:'{{private_scores}}'},status:400})
 let drafts=await call('/api/ps/mail',{method:'POST',body:preview});assert.equal(drafts.messages.length,2)
 drafts=await call('/api/ps/mail',{method:'POST',body:preview});assert.equal(drafts.messages.length,2)
 assert.ok(drafts.messages.every(m=>m.status==='draft'))
 const ids=drafts.messages.map(m=>m.id)
 await Promise.all([call('/api/ps/mail',{method:'POST',body:{action:'send',ids}}),call('/api/ps/mail',{method:'POST',body:{action:'send',ids}})])
 const sent=(await call(mailurl)).messages;assert.ok(sent.every(m=>m.status==='sent'&&m.attempts.length===2))
 await call('/api/ps/mail',{method:'POST',body:{action:'send',ids}})
 assert.ok((await call(mailurl)).messages.every(m=>m.attempts.length===2))
 const failures=await call('/api/ps/mail',{method:'POST',body:{...preview,subject:'FAIL'}})
 const fail=failures.messages.filter(m=>m.status==='draft').map(m=>m.id)
 await call('/api/ps/mail',{method:'POST',body:{action:'send',ids:fail}})
 assert.ok((await call(mailurl)).messages.filter(m=>fail.includes(m.id)).every(m=>m.status==='failed'))
 const uncertain=await call('/api/ps/mail',{method:'POST',body:{...preview,subject:'UNKNOWN'}})
 const unknown=uncertain.messages.filter(m=>m.status==='draft').map(m=>m.id)
 await call('/api/ps/mail',{method:'POST',body:{action:'send',ids:unknown}})
 await call('/api/ps/mail',{method:'POST',body:{action:'send',ids:unknown}})
 assert.ok((await call(mailurl)).messages.filter(m=>unknown.includes(m.id)).every(m=>m.status==='unknown'&&m.attempts.length===2))
 await call('/api/ps/mail',{method:'POST',body:{action:'disconnect'}})
 assert.equal((await call(mailurl)).mailbox,null)
 console.log('Phase 6 mail: OAuth state/replay, encrypted storage, draft preview, finalized-only recipients, concurrency/idempotency, rejected/uncertain delivery and disconnect passed with a fake provider.')
}

export async function fullCycle({call,base,mongoose,emails}) {
 const db=mongoose.connection,cycle=new mongoose.Types.ObjectId(),pool=emails.slice(0,2)
 await db.collection('authorizedusers').updateMany({email:{$in:pool}},{$set:{role:'leadership'}})
 await db.collection('recruitmentcycles').insertOne({_id:cycle,name:'Complete cycle acceptance',status:'active'})
 const people=Array.from({length:6},(_,i)=>({_id:new mongoose.Types.ObjectId(),cycle_id:cycle,first_name:`Candidate ${i}`,last_name:'Full-cycle',email:`full${i}@example.test`,year:i%2?'Junior (Transfer)':'Junior'}))
 await db.collection('applicants').insertMany(people)
 const rounds=await call(`/api/ps/cycles/${cycle}/rounds`,{method:'POST',status:201,body:{template:'ps_standard',eligible_grader_emails:pool}})
 let current=people.map(p=>String(p._id))
 for(let stage=0;stage<rounds.length;stage++){
  const round=rounds[stage],url=`/api/ps/rounds/${round.id}`
  const structure={schema_version:2,scoring_policy:'points_v1',name:'Shared acceptance rubric',weighting:'unconfigured',categories:[{id:'skill',name:'Skill',weight_bps:null}],questions:[{id:'score',category_id:'skill',label:'Skill',description:'Evidence',purpose:'SCORED_CRITERION',format:'numeric_choice',required:true,confirmed:true,scale:null,options:Array.from({length:7},(_,value)=>({value,label:String(value)}))}]}
  const draft=await call(url+'/rubric-drafts',{method:'POST',status:201,body:{structure}})
  const rubric=await call(`/api/ps/rubric-drafts/${draft.id}/publish`,{method:'POST',status:201,body:{revision:0,configuration_version:round.configuration_version}})
  if(stage===0){const preview=await call(url+'/assignments');await call(url+'/assignments',{method:'POST',body:{preview_token:preview.preview_token}})}
  else{
   await call(url+'/assignments',{status:409})
   await call(url+'/schedule',{method:'POST',body:{action:'create_slots',start:new Date(Date.now()+(10+stage)*86400000).toISOString(),count:current.length,duration:45,break_minutes:15,capacity:1,cutoff_hours:24,location:'Campus'}})
   const slots=(await call(url+'/schedule')).slots
   for(const slot of slots)for(const email of pool)await call(url+'/schedule',{method:'POST',role:'leadership',email,body:{action:'availability',slot_id:slot.id,available:true}})
   for(const [i,applicant_id] of current.entries()){
    const {token}=await call(url+'/schedule',{method:'POST',body:{action:'invite',applicant_id}})
    const booked=await fetch(base+'/api/booking',{method:'POST',headers:{'Content-Type':'application/json','x-booking-token':token,origin:base},body:JSON.stringify({slot_id:slots[i].id})})
    assert.equal(booked.status,200,await booked.text())
   }
  }
  for(const [i,applicant_id] of current.entries())for(const [j,email] of pool.entries()){
   await call('/api/ps/reviews',{method:'POST',status:201,role:'leadership',email,body:{schema_version:2,round_id:round.id,applicant_id,rubric_version_id:rubric.id,revision:0,comments:`Independent ${j}`,responses:[{question_id:'score',format:'numeric_choice',value:i+j}]}})
   if(j===0)assert.equal((await call(`/api/ps/reviews?round_id=${round.id}`)).filter(r=>r.applicant_id===applicant_id).length,0)
  }
  await call(url+'/close',{method:'POST',body:{}})
  const scores=await call(url+'/scores');assert.equal(scores.frozen,true);assert.equal(scores.normalized.length,current.length);assert.ok(scores.normalized.every(r=>Number.isFinite(r.z)))
  if(stage===0){assert.equal(scores.normalized.filter(r=>r.recommendation==='green').length,3);assert.equal(scores.normalized.filter(r=>r.recommendation==='red').length,3)}
  else assert.ok(scores.normalized.every(r=>r.recommendation==='yellow'))
  const room=await call(url+'/deliberation',{method:'POST',body:{}}),candidates=await call(`/api/sessions/${room.id}/candidates`)
  const winners=stage===0?current.slice(3):current
  for(const c of candidates)await call(`/api/candidates/${c.id}`,{method:'PATCH',body:{status:winners.includes(c.applicant_id)?'accepted':'rejected'}})
  if(stage===2){const social=`/api/ps/sessions/${room.id}/social/${candidates[0].id}`;await call(social,{method:'POST',body:{color:'yellow',text:'Question for final discussion.'}});const after=await call(url+'/scores');assert.deepEqual(after.normalized,scores.normalized)}
  await call(`/api/ps/sessions/${room.id}/finish`,{method:'POST',body:{}})
  await call(`/api/ps/sessions/${room.id}/finish`,{method:'POST',body:{}})
  const board=await call(url+'/deliberation');assert.equal(board.candidates.filter(c=>c.state===(stage===2?'accepted':'advanced')).length,winners.length)
  current=winners
 }
 const profile=await call(`/api/ps/candidates/${current[0]}`)
 assert.equal(profile.timeline.length,3);assert.ok(profile.timeline.every(s=>s.score.frozen&&s.score.complete));assert.equal(profile.timeline[2].state,'accepted')
 console.log('Full three-round cycle passed: balanced written assignments, independent blind reviews, normalized snapshots, booking-assigned PD/final reviews, qualitative social cards, host progression and candidate history.')
}
