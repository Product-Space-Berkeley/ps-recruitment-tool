import { NextRequest, NextResponse } from 'next/server'
import mongoose from 'mongoose'
import { connectDB } from '@/lib/mongodb'
import { RecruitmentCycle, Round } from '@/lib/models'
import { requireRole } from '@/lib/serverAuth'
import { isNonEmptyString, isObjectId, readJsonObject } from '@/lib/apiValidation'

class RoundCreateRejected extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'RoundCreateRejected'
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireRole('leadership')
  if (auth instanceof NextResponse) return auth

  await connectDB()
  const parsedBody = await readJsonObject(req)
  if (!parsedBody.ok) return parsedBody.response
  const body = parsedBody.data
  const { cycle_id, name, grading_type = null, order_index = 1, status = 'pending', role = null } = body
  if (!isObjectId(cycle_id) || !isNonEmptyString(name, 200)) {
    return NextResponse.json({ error: 'A valid cycle_id and name are required.' }, { status: 400 })
  }
  if (grading_type !== null && grading_type !== 'rubric' && grading_type !== 'interview') {
    return NextResponse.json({ error: 'Invalid grading type.' }, { status: 400 })
  }
  if (!Number.isInteger(order_index) || Number(order_index) < 1 || Number(order_index) > 100) {
    return NextResponse.json({ error: 'order_index must be an integer from 1 through 100.' }, { status: 400 })
  }
  if (status !== 'pending' && status !== 'grading' && status !== 'deliberating' && status !== 'ended') {
    return NextResponse.json({ error: 'Invalid round status.' }, { status: 400 })
  }
  if (role !== null && role !== 'curriculum' && role !== 'developer') {
    return NextResponse.json({ error: 'Invalid role.' }, { status: 400 })
  }

  const desiredOrder = Number(order_index)
  try {
    let payload: Record<string, unknown> | null = null
    await mongoose.connection.transaction(async dbSession => {
      // Touching the active cycle in the same transaction makes a concurrent
      // cycle close/delete conflict instead of allowing an orphan round.
      const cycle = await RecruitmentCycle.findOneAndUpdate(
        { _id: cycle_id, status: 'active' },
        { $inc: { lifecycle_write_count: 1 } },
        { new: true, session: dbSession },
      ).select('_id').lean()
      if (!cycle) throw new RoundCreateRejected('Active cycle not found.', 404)

      // Conflict is scoped to the same role track — curriculum and developer
      // rounds advance independently, so they can share order_index values.
      const conflict = await Round.findOne({
        cycle_id,
        role: role ?? null,
        order_index: mongoose.trusted({ $gte: desiredOrder }),
      }).session(dbSession).lean()
      if (conflict) {
        throw new RoundCreateRejected('A round at this position already exists for this role track.', 409)
      }

      const [round] = await Round.create([{
        cycle_id,
        name: name.trim(),
        grading_type,
        order_index: desiredOrder,
        status,
        role,
      }], { session: dbSession })
      payload = {
        ...round.toObject(),
        id: round._id.toString(),
        cycle_id: round.cycle_id.toString(),
        _id: undefined,
      }
    })
    return NextResponse.json(payload, { status: 201 })
  } catch (err: unknown) {
    if (err instanceof RoundCreateRejected) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    const message = err instanceof Error ? err.message : 'Failed to create round'
    if (message.includes('duplicate key')) {
      return NextResponse.json(
        { error: 'A round at this position already exists for this role track.' },
        { status: 409 },
      )
    }
    console.error('Failed to create round:', err)
    return NextResponse.json({ error: 'Unable to create round.' }, { status: 400 })
  }
}
