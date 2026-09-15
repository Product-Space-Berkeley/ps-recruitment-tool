#!/usr/bin/env node
/**
 * Read-only verification of security- and load-critical MongoDB indexes.
 *
 * This script deliberately does not call createIndexes(), syncIndexes(), or any
 * write API. It exits nonzero when a required collection/index is missing or an
 * index with the right key has different security-sensitive options.
 *
 * Usage:
 *   SECURITY_INDEX_DB_NAME='recruitment_portal' SECURITY_INDEX_EXPECTED_CYCLE_ID='...' \
 *     MONGODB_URI='mongodb+srv://...' \
 *     node scripts/verify-indexes.mjs
 */

import mongoose from 'mongoose'

const MONGODB_URI = process.env.MONGODB_URI
if (!MONGODB_URI) throw new Error('MONGODB_URI is required for read-only index verification.')
const SECURITY_INDEX_DB_NAME = process.env.SECURITY_INDEX_DB_NAME?.trim()
if (!SECURITY_INDEX_DB_NAME) {
  throw new Error('SECURITY_INDEX_DB_NAME is required to assert the exact database being verified.')
}
const SECURITY_INDEX_EXPECTED_CYCLE_ID = process.env.SECURITY_INDEX_EXPECTED_CYCLE_ID?.trim()
if (!SECURITY_INDEX_EXPECTED_CYCLE_ID || !/^[a-f\d]{24}$/i.test(SECURITY_INDEX_EXPECTED_CYCLE_ID)) {
  throw new Error('SECURITY_INDEX_EXPECTED_CYCLE_ID must be the 24-character id of a known production cycle.')
}

const SERVER_SELECTION_TIMEOUT_MS = readInteger('INDEX_CHECK_TIMEOUT_MS', 10_000, 100, 120_000)

// Keep this manifest aligned with src/lib/models/index.ts and the explicit
// production index migration. Null-role uniqueness is intentional: route-level
// conflict checks alone do not close the TOCTOU window.
const EXPECTED_INDEXES = {
  securitylocks: [
    required({ _id: 1 }),
  ],
  authorizedusers: [
    required({ email: 1 }, { unique: true }),
  ],
  recruitmentcycles: [
    required(
      { accepting_applications: 1 },
      { unique: true, partialFilterExpression: { accepting_applications: true } },
    ),
  ],
  essayprompts: [
    required({ cycle_id: 1, question_number: 1 }, { unique: true }),
  ],
  applicants: [
    required(
      { cycle_id: 1, email: 1 },
      {
        unique: true,
        collation: {
          locale: 'en', strength: 2, caseLevel: false, caseFirst: 'off',
          numericOrdering: false, alternate: 'non-ignorable', maxVariable: 'punct',
          normalization: false, backwards: false,
        },
        partialFilterExpression: { email: { $type: 'string' } },
      },
    ),
    required({ cycle_id: 1, created_at: 1 }),
  ],
  ratelimits: [
    required({ expires_at: 1 }, { expireAfterSeconds: 0 }),
  ],
  essayresponses: [
    required({ applicant_id: 1, prompt_id: 1 }, { unique: true }),
  ],
  rounds: [
    required(
      { cycle_id: 1, role: 1, order_index: 1 },
      { unique: true, partialFilterExpression: null },
    ),
  ],
  graderassignments: [
    required({ round_id: 1, applicant_id: 1, grader_email: 1 }, { unique: true }),
    required({ grader_email: 1, round_id: 1, applicant_id: 1 }),
    required({ grader_email: 1, applicant_id: 1 }),
  ],
  reviews: [
    required({ round_id: 1, applicant_id: 1, grader_email: 1 }, { unique: true }),
    required({ grader_email: 1, round_id: 1, applicant_id: 1 }),
  ],
  sessions: [
    required(
      { round_id: 1, role: 1 },
      {
        unique: true,
        partialFilterExpression: { status: 'active', round_id: { $type: 'objectId' } },
      },
    ),
  ],
  candidates: [
    required({ session_id: 1, created_at: 1 }),
    required(
      { session_id: 1, applicant_id: 1 },
      { unique: true, partialFilterExpression: { applicant_id: { $type: 'objectId' } } },
    ),
  ],
  votes: [
    required(
      { candidate_id: 1, voter_email: 1, vote_type: 1 },
      { unique: true, partialFilterExpression: { voter_email: { $type: 'string' } } },
    ),
  ],
  candidatenotes: [
    required({ candidate_id: 1, created_at: 1 }),
  ],
  coffeechatnotes: [
    required({ cycle_id: 1, applicant_id: 1, chat_date: 1 }),
  ],
  sessionmembers: [
    required({ session_id: 1, user_email: 1 }, { unique: true }),
  ],
  sessionbans: [
    required({ session_id: 1, email: 1 }, { unique: true }),
  ],
}

function readInteger(name, fallback, min, max) {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`)
  }
  return value
}

function required(key, options = {}) {
  return { key, options }
}

function keySignature(key) {
  return JSON.stringify(Object.entries(key))
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonical(value[key])]),
  )
}

function sameValue(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}

function optionDifferences(actual, expected) {
  const differences = []
  if (Boolean(actual.unique) !== Boolean(expected.unique)) {
    differences.push(`unique expected=${Boolean(expected.unique)} actual=${Boolean(actual.unique)}`)
  }
  if (Boolean(actual.sparse) !== Boolean(expected.sparse)) {
    differences.push(`sparse expected=${Boolean(expected.sparse)} actual=${Boolean(actual.sparse)}`)
  }
  if (Boolean(actual.hidden) !== Boolean(expected.hidden)) {
    differences.push(`hidden expected=${Boolean(expected.hidden)} actual=${Boolean(actual.hidden)}`)
  }
  const actualExpiry = actual.expireAfterSeconds === undefined
    ? null
    : Number(actual.expireAfterSeconds)
  const expectedExpiry = expected.expireAfterSeconds ?? null
  if (actualExpiry !== expectedExpiry) {
    differences.push(`expireAfterSeconds expected=${String(expectedExpiry)} actual=${String(actualExpiry)}`)
  }
  const actualPartial = actual.partialFilterExpression ?? null
  const expectedPartial = expected.partialFilterExpression ?? null
  if (!sameValue(actualPartial, expectedPartial)) {
    differences.push(
      `partialFilterExpression expected=${JSON.stringify(expectedPartial)}`
      + ` actual=${JSON.stringify(actualPartial)}`,
    )
  }
  if ('collation' in expected) {
    const actualCollation = actual.collation ?? null
    const expectedSubset = expected.collation
    const mismatched = Object.entries(expectedSubset)
      .some(([key, value]) => !sameValue(actualCollation?.[key], value))
    if (mismatched) {
      differences.push(
        `collation expected=${JSON.stringify(expectedSubset)}`
        + ` actual=${JSON.stringify(actualCollation)}`,
      )
    }
  } else if (actual.collation) {
    differences.push(`collation expected=null actual=${JSON.stringify(actual.collation)}`)
  }
  return differences
}

async function main() {
  let failures = 0
  try {
    await mongoose.connect(MONGODB_URI, {
      bufferCommands: false,
      dbName: SECURITY_INDEX_DB_NAME,
      serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS,
      secureProtocol: 'TLSv1_2_method',
    })
    const db = mongoose.connection.db
    if (!db) throw new Error('MongoDB connection did not expose a database handle.')
    if (db.databaseName !== SECURITY_INDEX_DB_NAME) {
      throw new Error(`Connected database ${db.databaseName} does not match SECURITY_INDEX_DB_NAME.`)
    }
    const hello = await db.admin().command({ hello: 1 })
    if (!hello.setName && hello.msg !== 'isdbgrid') {
      throw new Error('MongoDB is not a replica set or sharded cluster; required transactions will not work.')
    }
    const expectedCycle = await db.collection('recruitmentcycles').findOne(
      { _id: new mongoose.Types.ObjectId(SECURITY_INDEX_EXPECTED_CYCLE_ID) },
      { projection: { _id: 1 } },
    )
    if (!expectedCycle) {
      throw new Error('The expected recruitment-cycle sentinel is absent; refusing to verify this database.')
    }

    const collections = new Set(
      (await db.listCollections({}, { nameOnly: true }).toArray()).map(collection => collection.name),
    )

    console.log(
      `Read-only index verification: ${Object.keys(EXPECTED_INDEXES).length} collections in ${db.databaseName}`,
    )
    for (const [collectionName, expectedIndexes] of Object.entries(EXPECTED_INDEXES)) {
      if (!collections.has(collectionName)) {
        failures += expectedIndexes.length
        console.error(`✗ ${collectionName}: collection is missing`)
        continue
      }

      const actualIndexes = await db.collection(collectionName).listIndexes().toArray()
      const byKey = new Map()
      for (const index of actualIndexes) {
        const signature = keySignature(index.key)
        const sameKey = byKey.get(signature) ?? []
        sameKey.push(index)
        byKey.set(signature, sameKey)
      }

      for (const expected of expectedIndexes) {
        const signature = keySignature(expected.key)
        const sameKey = byKey.get(signature) ?? []
        const label = `${collectionName}.${Object.entries(expected.key).map(([key, direction]) => `${key}:${direction}`).join(',')}`
        if (sameKey.length === 0) {
          failures += 1
          console.error(`✗ ${label}: missing`)
          continue
        }

        const matching = sameKey.find(actual => optionDifferences(actual, expected.options).length === 0)
        if (!matching) {
          failures += 1
          const variants = sameKey.map(actual => (
            `${actual.name}: ${optionDifferences(actual, expected.options).join('; ')}`
          ))
          console.error(`✗ ${label}: no same-key variant matches (${variants.join(' | ')})`)
        } else {
          console.log(`✓ ${label}`)
        }
      }
    }
  } finally {
    await mongoose.disconnect().catch(() => {})
  }

  if (failures > 0) {
    throw new Error(`${failures} required index check${failures === 1 ? '' : 's'} failed. No indexes were changed.`)
  }
  console.log('✓ All required indexes are present with the expected options. No indexes were changed.')
}

main().catch(error => {
  const raw = error instanceof Error ? error.message : String(error)
  console.error('FATAL:', raw.replaceAll(MONGODB_URI, '<redacted MongoDB URI>'))
  process.exitCode = 1
})
