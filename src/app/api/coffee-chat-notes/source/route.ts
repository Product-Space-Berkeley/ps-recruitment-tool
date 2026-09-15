import { NextRequest, NextResponse } from 'next/server'
import { connectDB } from '@/lib/mongodb'
import { Applicant, RecruitmentCycle } from '@/lib/models'
import { fetchGoogleSheetCsv, parseAndMatchCoffeeChatCsv, parseGoogleSheetUrl } from '@/lib/coffeeChats'
import { isObjectId, readJsonObject } from '@/lib/apiValidation'
import { consumeUserRateLimit } from '@/lib/rateLimit'
import { requireRole } from '@/lib/serverAuth'

export async function GET(req: NextRequest) {
  const auth = await requireRole('admin')
  if (auth instanceof NextResponse) return auth
  const cycleId = new URL(req.url).searchParams.get('cycle_id') ?? ''
  if (!isObjectId(cycleId)) return NextResponse.json({ error: 'A valid cycle_id is required.' }, { status: 400 })

  await connectDB()
  const cycle = await RecruitmentCycle.findById(cycleId)
    .schemaLevelProjections(false).select('coffee_chat_sheet_id coffee_chat_sheet_gid')
    .lean()
  if (!cycle) return NextResponse.json({ error: 'Recruitment cycle not found.' }, { status: 404 })
  const connected = Boolean(cycle.coffee_chat_sheet_id)
  return NextResponse.json({
    connected,
    sheet_url: connected
      ? `https://docs.google.com/spreadsheets/d/${cycle.coffee_chat_sheet_id}/edit?gid=${cycle.coffee_chat_sheet_gid ?? '0'}`
      : null,
  }, { headers: { 'Cache-Control': 'no-store, max-age=0' } })
}

export async function POST(req: NextRequest) {
  const auth = await requireRole('admin')
  if (auth instanceof NextResponse) return auth
  await connectDB()
  if (!await consumeUserRateLimit(auth.email, 'coffee-chat-source', 20, 60 * 60 * 1000)) {
    return NextResponse.json({ error: 'Too many connection attempts. Try again later.' }, { status: 429 })
  }
  const parsedBody = await readJsonObject(req, 20_000)
  if (!parsedBody.ok) return parsedBody.response
  const cycleId = typeof parsedBody.data.cycle_id === 'string' ? parsedBody.data.cycle_id : ''
  const sheetUrl = typeof parsedBody.data.sheet_url === 'string' ? parsedBody.data.sheet_url : ''
  if (!isObjectId(cycleId)) return NextResponse.json({ error: 'A valid cycle_id is required.' }, { status: 400 })

  const source = parseGoogleSheetUrl(sheetUrl)
  if (!source) {
    return NextResponse.json({ error: 'Enter a valid docs.google.com spreadsheet URL with a numeric gid.' }, { status: 400 })
  }
  const cycle = await RecruitmentCycle.findById(cycleId).select('_id').lean()
  if (!cycle) return NextResponse.json({ error: 'Recruitment cycle not found.' }, { status: 404 })

  try {
    const [csvText, applicants] = await Promise.all([
      fetchGoogleSheetCsv(source),
      Applicant.find({ cycle_id: cycleId }).select('first_name last_name').lean(),
    ])
    const preview = parseAndMatchCoffeeChatCsv(csvText, applicants.map(applicant => ({
      id: applicant._id.toString(),
      first_name: applicant.first_name,
      last_name: applicant.last_name,
    })))
    if (!preview.matched_rows.length) {
      return NextResponse.json({ error: 'The connected sheet has no notes matching applicants in this cycle.' }, { status: 422 })
    }
    await RecruitmentCycle.updateOne(
      { _id: cycleId },
      {
        $set: { coffee_chat_sheet_id: source.sheetId, coffee_chat_sheet_gid: source.gid },
        $inc: { configuration_version: 1 },
      },
    )
    return NextResponse.json({
      ok: true,
      matched: preview.matched_rows.length,
      skipped: preview.issues.length + preview.warnings.length,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unable to read the Google Sheet.'
    return NextResponse.json({ error: message }, { status: 422 })
  }
}
