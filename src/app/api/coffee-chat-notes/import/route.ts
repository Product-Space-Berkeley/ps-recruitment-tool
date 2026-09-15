import { NextRequest, NextResponse } from 'next/server'
import mongoose from 'mongoose'
import { connectDB } from '@/lib/mongodb'
import { Applicant, CoffeeChatNote, RecruitmentCycle } from '@/lib/models'
import {
  parseAndMatchCoffeeChatCsv,
  MAX_COFFEE_CHAT_CSV_BYTES,
  type CoffeeChatImportPreview,
} from '@/lib/coffeeChats'
import { requireRole } from '@/lib/serverAuth'
import { isObjectId, readJsonObject } from '@/lib/apiValidation'
import { consumeUserRateLimit } from '@/lib/rateLimit'

class CoffeeChatImportRejected extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly preview?: CoffeeChatImportPreview,
  ) {
    super(message)
    this.name = 'CoffeeChatImportRejected'
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireRole('admin')
  if (auth instanceof NextResponse) return auth

  await connectDB()
  if (!await consumeUserRateLimit(auth.email, 'coffee-chat-import', 20, 60 * 60 * 1000)) {
    return NextResponse.json({ error: 'Too many import attempts. Try again later.' }, { status: 429 })
  }

  const parsedBody = await readJsonObject(req, MAX_COFFEE_CHAT_CSV_BYTES + 50_000)
  if (!parsedBody.ok) return parsedBody.response
  const body = parsedBody.data
  const cycleId = typeof body.cycle_id === 'string' ? body.cycle_id : ''
  const csvText = typeof body.csv_text === 'string' ? body.csv_text : ''
  if (body.action !== 'preview' && body.action !== 'commit') {
    return NextResponse.json({ error: 'action must be preview or commit.' }, { status: 400 })
  }
  const action = body.action

  if (!isObjectId(cycleId)) {
    return NextResponse.json({ error: 'A valid cycle_id is required.' }, { status: 400 })
  }
  if (!csvText.trim()) {
    return NextResponse.json({ error: 'CSV text is required.' }, { status: 400 })
  }
  if (Buffer.byteLength(csvText, 'utf8') > MAX_COFFEE_CHAT_CSV_BYTES) {
    return NextResponse.json({ error: 'CSV exceeds the 2 MB limit.' }, { status: 413 })
  }

  if (action === 'preview') {
    const cycleExists = await RecruitmentCycle.exists({ _id: cycleId })
    if (!cycleExists) return NextResponse.json({ error: 'Recruitment cycle not found.' }, { status: 404 })

    const applicants = await Applicant.find({ cycle_id: cycleId })
      .select('first_name last_name')
      .lean()
    const preview = parseAndMatchCoffeeChatCsv(csvText, applicants.map(applicant => ({
      id: applicant._id.toString(),
      first_name: applicant.first_name,
      last_name: applicant.last_name,
    })))
    if (preview.matched_rows.length === 0) {
      return NextResponse.json(
        { error: 'The CSV contains no matched coffee-chat or interaction notes.', preview },
        { status: 422 },
      )
    }
    if (preview.issues.length > 0) {
      return NextResponse.json(
        { error: 'Every coffee-chat row must match exactly one applicant before import.', preview },
        { status: 422 },
      )
    }
    return NextResponse.json({ preview })
  }

  const importedAt = new Date()
  let committedPreview: CoffeeChatImportPreview | null = null
  try {
    await mongoose.connection.transaction(async session => {
      // Touching the cycle serializes this full replacement with concurrent
      // application submissions and cycle close/delete cascades.
      const cycle = await RecruitmentCycle.findOneAndUpdate(
        { _id: cycleId },
        { $inc: { lifecycle_write_count: 1 } },
        { new: true, session },
      ).select('_id').lean()
      if (!cycle) throw new CoffeeChatImportRejected('Recruitment cycle not found.', 404)

      const applicants = await Applicant.find({ cycle_id: cycleId })
        .select('first_name last_name')
        .session(session)
        .lean()
      const preview = parseAndMatchCoffeeChatCsv(csvText, applicants.map(applicant => ({
        id: applicant._id.toString(),
        first_name: applicant.first_name,
        last_name: applicant.last_name,
      })))
      if (preview.matched_rows.length === 0) {
        throw new CoffeeChatImportRejected('The CSV contains no matched coffee-chat or interaction notes.', 422, preview)
      }
      if (preview.issues.length > 0) {
        throw new CoffeeChatImportRejected(
          'Every coffee-chat row must match exactly one applicant before import.',
          422,
          preview,
        )
      }

      await CoffeeChatNote.deleteMany({ cycle_id: cycleId }, { session })
      await CoffeeChatNote.insertMany(
        preview.matched_rows.map(row => ({
          cycle_id: cycleId,
          applicant_id: row.applicant_id,
          applicant_name: row.applicant_name,
          chatter_name: row.chatter_name,
          notes: row.notes,
          is_coffee_chat: row.is_coffee_chat,
          recommended_overall: row.recommended_overall,
          chat_date: row.chat_date,
          other_notes: row.other_notes,
          imported_by: auth.email,
          imported_at: importedAt,
        })),
        { session },
      )
      committedPreview = preview
    })
  } catch (error: unknown) {
    if (error instanceof CoffeeChatImportRejected) {
      return NextResponse.json(
        error.preview ? { error: error.message, preview: error.preview } : { error: error.message },
        { status: error.status },
      )
    }
    throw error
  }

  const preview = committedPreview!

  return NextResponse.json({
    ok: true,
    imported: preview.matched_rows.length,
    applicants: new Set(preview.matched_rows.map(row => row.applicant_id)).size,
  })
}
