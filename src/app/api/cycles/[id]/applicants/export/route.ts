import { NextRequest, NextResponse } from 'next/server'
import mongoose from 'mongoose'
import { connectDB } from '@/lib/mongodb'
import { Applicant, EssayResponse, EssayPrompt } from '@/lib/models'
import { requireRole } from '@/lib/serverAuth'
import { isObjectId } from '@/lib/apiValidation'

// Wrap a value as a safe CSV field (quotes doubled; commas/newlines contained).
function csv(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value)
  return `"${s.replace(/"/g, '""')}"`
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole('leadership')
  if (auth instanceof NextResponse) return auth

  await connectDB()
  const { id } = await params
  if (!isObjectId(id)) return NextResponse.json({ error: 'Invalid cycle id.' }, { status: 400 })

  // All applicants for this cycle (resume excluded — binary, not CSV-able).
  const applicants = await Applicant.find({ cycle_id: id }, { resume_base64: 0, photo_base64: 0 }).sort({ created_at: 1 }).lean()
  const applicantIds = applicants.map(a => a._id)

  // Essay prompts for this cycle define the essay columns (stable order).
  const prompts = await EssayPrompt.find({ cycle_id: id }).sort({ question_number: 1 }).lean()
  const promptQById = new Map(prompts.map(p => [p._id.toString(), p.question_number]))
  const questionNumbers = prompts.map(p => p.question_number)

  const responses = await EssayResponse.find({ applicant_id: mongoose.trusted({ $in: applicantIds }) }).lean()
  const essayByApplicant = new Map<string, Map<number, string>>()
  for (const r of responses) {
    const q = promptQById.get(r.prompt_id.toString())
    if (q === undefined) continue
    const aid = r.applicant_id.toString()
    if (!essayByApplicant.has(aid)) essayByApplicant.set(aid, new Map())
    essayByApplicant.get(aid)!.set(q, r.response ?? '')
  }

  const yesNo = (value: unknown) => value === true ? 'Yes' : value === false ? 'No' : ''
  const headers = [
    'first_name', 'last_name', 'email', 'phone', 'year', 'major', 'previously_applied',
    'time_commitment', 'meeting_availability', 'retreat_availability',
    ...questionNumbers.map(n => `essay_q${n}`),
    'additional_context', 'race', 'ethnicity', 'transfer', 'submitted_at',
  ]

  const rows = applicants.map(a => {
    const essays = essayByApplicant.get(a._id.toString())
    return [
      a.first_name ?? '',
      a.last_name ?? '',
      a.email ?? '',
      a.phone ?? '',
      a.year ?? '',
      a.major ?? '',
      yesNo(a.previously_applied),
      a.time_commitment ?? '',
      a.meeting_availability ?? '',
      a.retreat_availability ?? '',
      ...questionNumbers.map(n => essays?.get(n) ?? ''),
      a.additional_context ?? '',
      Array.isArray(a.race) ? a.race.join('; ') : '',
      a.ethnicity ?? '',
      yesNo(a.transfer),
      a.created_at ? new Date(a.created_at).toISOString() : '',
    ].map(csv).join(',')
  })

  const body = [headers.map(csv).join(','), ...rows].join('\r\n')

  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="applications-${id}.csv"`,
    },
  })
}
