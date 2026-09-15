#!/usr/bin/env node

import process from 'node:process'
import mongoose from 'mongoose'

const uri = process.env.MONGODB_URI
const cycleName = process.env.INFOSESSION_CYCLE_NAME
if (!uri) throw new Error('MONGODB_URI is required.')
if (!cycleName) throw new Error('INFOSESSION_CYCLE_NAME is required.')

const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const rawInput = Buffer.concat(chunks).toString('utf8')
const records = JSON.parse(rawInput)
if (!Array.isArray(records) || records.length > 2_000) {
  throw new Error('Expected an array of at most 2,000 attendance records.')
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const attendanceByEmail = new Map()
for (const record of records) {
  const email = typeof record?.email === 'string' ? record.email.trim().toLowerCase() : ''
  const infosession = typeof record?.infosession === 'string' ? record.infosession.trim() : ''
  if (!emailPattern.test(email) || !infosession || infosession.length > 200) {
    throw new Error('Every attendance record must contain a valid email and infosession.')
  }
  const sessions = attendanceByEmail.get(email) ?? new Set()
  sessions.add(infosession)
  attendanceByEmail.set(email, sessions)
}

try {
  await mongoose.connect(uri)
  const db = mongoose.connection.db
  const cycle = await db.collection('recruitmentcycles').findOne({ name: cycleName }, { projection: { _id: 1 } })
  if (!cycle) throw new Error(`Recruitment cycle "${cycleName}" was not found.`)

  const applicants = await db.collection('applicants')
    .find({ cycle_id: cycle._id }, { projection: { _id: 1, email: 1 } })
    .toArray()
  const applicantByEmail = new Map(
    applicants
      .filter(applicant => typeof applicant.email === 'string')
      .map(applicant => [applicant.email.trim().toLowerCase(), applicant]),
  )
  const matched = [...attendanceByEmail.keys()].filter(email => applicantByEmail.has(email))

  const session = await mongoose.startSession()
  await session.withTransaction(async () => {
    await db.collection('applicants').updateMany(
      { cycle_id: cycle._id },
      { $set: { infosessions_attended: [] } },
      { session },
    )
    if (matched.length > 0) {
      await db.collection('applicants').bulkWrite(
        matched.map(email => ({
          updateOne: {
            filter: { _id: applicantByEmail.get(email)._id, cycle_id: cycle._id },
            update: { $set: { infosessions_attended: [...attendanceByEmail.get(email)].sort() } },
          },
        })),
        { session },
      )
    }
  })
  await session.endSession()

  console.log(JSON.stringify({
    cycle: cycleName,
    applicants: applicants.length,
    attendance_emails: attendanceByEmail.size,
    matched_applicants: matched.length,
    unmatched_attendance_emails: attendanceByEmail.size - matched.length,
  }))
} finally {
  await mongoose.disconnect()
}
