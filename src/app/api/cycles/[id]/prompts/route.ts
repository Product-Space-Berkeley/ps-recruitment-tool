import { NextRequest, NextResponse } from 'next/server'
import mongoose from 'mongoose'
import { connectDB } from '@/lib/mongodb'
import { Applicant, EssayPrompt, RecruitmentCycle } from '@/lib/models'
import { requireRole } from '@/lib/serverAuth'
import { isNonEmptyString, isObjectId, isPlainRecord, readJsonArray } from '@/lib/apiValidation'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isObjectId(id)) return NextResponse.json({ error: 'Invalid cycle id.' }, { status: 400 })

  await connectDB()
  const auth = await requireRole('grader')
  const isMember = !(auth instanceof NextResponse)
  if (!isMember) {
    const cycle = await RecruitmentCycle.findOne({
      _id: id,
      status: 'active',
      accepting_applications: true,
    }).select('application_deadline').lean()
    const deadlinePassed = !!cycle?.application_deadline && cycle.application_deadline.getTime() < Date.now()
    if (!cycle || deadlinePassed) return NextResponse.json({ error: 'Applications are not open.' }, { status: 404 })
  }

  const prompts = await EssayPrompt.find({ cycle_id: id }).sort({ question_number: 1 }).lean()
  return NextResponse.json(prompts.map(p => ({
    id: p._id.toString(),
    cycle_id: p.cycle_id.toString(),
    question_number: p.question_number,
    prompt: p.prompt,
    description: p.description,
    ...(isMember ? { criterion1: p.criterion1, criterion2: p.criterion2 } : {}),
  })))
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole('leadership')
  if (auth instanceof NextResponse) return auth

  await connectDB()
  const { id } = await params
  if (!isObjectId(id)) return NextResponse.json({ error: 'Invalid cycle id.' }, { status: 400 })

  const parsedBody = await readJsonArray(req)
  if (!parsedBody.ok) return parsedBody.response
  if (parsedBody.data.length !== 3 || parsedBody.data.some(prompt => !isPlainRecord(prompt))) {
    return NextResponse.json({ error: 'Exactly three essay prompts are required.' }, { status: 400 })
  }

  const prompts = parsedBody.data as Record<string, unknown>[]
  const questionNumbers = prompts.map(prompt => prompt.question_number)
  if (
    questionNumbers.some(number => !Number.isInteger(number) || Number(number) < 1 || Number(number) > 3)
    || new Set(questionNumbers).size !== prompts.length
  ) {
    return NextResponse.json({ error: 'Question numbers must be unique integers from 1 through 3.' }, { status: 400 })
  }

  const normalized: Array<{
    question_number: number
    prompt: string
    description: string | null
    criterion1: string
    criterion2: string
  }> = []
  for (const p of prompts) {
    if (!isNonEmptyString(p.prompt, 2000)) {
      return NextResponse.json({ error: 'Every prompt must contain question text.' }, { status: 400 })
    }
    if (p.id !== undefined && !isObjectId(p.id)) {
      return NextResponse.json({ error: 'Invalid prompt id.' }, { status: 400 })
    }
    if (p.description !== undefined && p.description !== null && typeof p.description !== 'string') {
      return NextResponse.json({ error: 'Prompt descriptions must be text.' }, { status: 400 })
    }
    if (!isNonEmptyString(p.criterion1, 500) || !isNonEmptyString(p.criterion2, 500)) {
      return NextResponse.json({ error: 'Each prompt requires two grading criteria.' }, { status: 400 })
    }
    if (typeof p.description === 'string' && p.description.length > 2000) {
      return NextResponse.json({ error: 'Prompt descriptions must be 2,000 characters or fewer.' }, { status: 400 })
    }
    normalized.push({
      question_number: Number(p.question_number),
      prompt: p.prompt.trim(),
      description: typeof p.description === 'string' && p.description.trim() ? p.description.trim() : null,
      criterion1: p.criterion1.trim(),
      criterion2: p.criterion2.trim(),
    })
  }

  await RecruitmentCycle.updateOne(
    { _id: id, configuration_version: mongoose.trusted({ $exists: false }) },
    { $set: { configuration_version: 0 } },
  )

  let conflict: 'missing' | 'open' | 'submitted' | 'changed' | null = null
  await mongoose.connection.transaction(async session => {
    const cycle = await RecruitmentCycle.findById(id).session(session).lean()
    if (!cycle) { conflict = 'missing'; return }
    if (cycle.accepting_applications) { conflict = 'open'; return }
    if (await Applicant.exists({ cycle_id: id }).session(session)) { conflict = 'submitted'; return }

    // Touch the cycle document to serialize prompt edits against the atomic
    // application-opening transaction.
    const locked = await RecruitmentCycle.findOneAndUpdate(
      { _id: id, configuration_version: cycle.configuration_version, accepting_applications: false },
      { $inc: { configuration_version: 1 } },
      { new: true, session },
    )
    if (!locked) { conflict = 'changed'; return }

    await EssayPrompt.bulkWrite(normalized.map(prompt => ({
      updateOne: {
        filter: { cycle_id: id, question_number: prompt.question_number },
        update: { $set: { cycle_id: id, ...prompt } },
        upsert: true,
      },
    })), { session })
    await EssayPrompt.deleteMany(
      { cycle_id: id, question_number: mongoose.trusted({ $nin: [1, 2, 3] }) },
      { session },
    )
  })

  if (conflict === 'missing') return NextResponse.json({ error: 'Cycle not found.' }, { status: 404 })
  if (conflict === 'open') return NextResponse.json({ error: 'Close applications before editing prompts.' }, { status: 409 })
  if (conflict === 'submitted') return NextResponse.json({ error: 'Prompts cannot change after an application is submitted.' }, { status: 409 })
  if (conflict === 'changed') return NextResponse.json({ error: 'Cycle configuration changed. Reload and try again.' }, { status: 409 })

  const results = await EssayPrompt.find({ cycle_id: id }).sort({ question_number: 1 }).lean()
  return NextResponse.json(results.map(prompt => ({
    ...prompt,
    id: prompt._id.toString(),
    cycle_id: prompt.cycle_id.toString(),
    _id: undefined,
  })))
}
