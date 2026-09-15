#!/usr/bin/env node
/**
 * Preflight and apply the explicit production index migration used by the
 * security-hardened release.
 *
 * Dry run (default, no writes):
 *   SECURITY_INDEX_DB_NAME='recruitment_portal' SECURITY_INDEX_EXPECTED_CYCLE_ID='...' MONGODB_URI='...' \
 *     node scripts/migrate-security-indexes.mjs
 *
 * Apply only after an Atlas backup/checkpoint is confirmed:
 *   ALLOW_SECURITY_INDEX_MIGRATION=1 SECURITY_INDEX_DB_NAME='recruitment_portal' \
 *     SECURITY_INDEX_EXPECTED_CYCLE_ID='...' MONGODB_URI='...' \
 *     node scripts/migrate-security-indexes.mjs --apply
 */

import mongoose from 'mongoose'

const MONGODB_URI = process.env.MONGODB_URI
if (!MONGODB_URI) throw new Error('MONGODB_URI is required.')
const SECURITY_INDEX_DB_NAME = process.env.SECURITY_INDEX_DB_NAME?.trim()
if (!SECURITY_INDEX_DB_NAME) {
  throw new Error('SECURITY_INDEX_DB_NAME is required to assert the exact migration target database.')
}
const SECURITY_INDEX_EXPECTED_CYCLE_ID = process.env.SECURITY_INDEX_EXPECTED_CYCLE_ID?.trim()
if (!SECURITY_INDEX_EXPECTED_CYCLE_ID || !/^[a-f\d]{24}$/i.test(SECURITY_INDEX_EXPECTED_CYCLE_ID)) {
  throw new Error('SECURITY_INDEX_EXPECTED_CYCLE_ID must be the 24-character id of a known production cycle.')
}

const APPLY = process.argv.includes('--apply')
if (APPLY && process.env.ALLOW_SECURITY_INDEX_MIGRATION !== '1') {
  throw new Error('Set ALLOW_SECURITY_INDEX_MIGRATION=1 to apply this migration.')
}

const APPLICANT_EMAIL_COLLATION = {
  locale: 'en', strength: 2, caseLevel: false, caseFirst: 'off',
  numericOrdering: false, alternate: 'non-ignorable', maxVariable: 'punct',
  normalization: false, backwards: false,
}

const DESIRED = [
  // MongoDB creates this collection's built-in _id index when the collection
  // is explicitly created below. Listing it in the manifest prevents the
  // first last-admin mutation from attempting runtime DDL in production.
  index('securitylocks', { _id: 1 }),
  index('authorizedusers', { email: 1 }, { unique: true }),
  index('recruitmentcycles', { accepting_applications: 1 }, {
    unique: true,
    name: 'uniq_open_cycle_v1',
    partialFilterExpression: { accepting_applications: true },
  }, ['accepting_applications_1']),
  index('essayprompts', { cycle_id: 1, question_number: 1 }, { unique: true }),
  index('applicants', { cycle_id: 1, email: 1 }, {
    unique: true,
    name: 'uniq_cycle_email_ci_v1',
    collation: APPLICANT_EMAIL_COLLATION,
    partialFilterExpression: { email: { $type: 'string' } },
  }, ['cycle_id_1_email_1']),
  index('applicants', { cycle_id: 1, created_at: 1 }),
  index('ratelimits', { expires_at: 1 }, { expireAfterSeconds: 0 }),
  index('essayresponses', { applicant_id: 1, prompt_id: 1 }, { unique: true }),
  index('rounds', { cycle_id: 1, role: 1, order_index: 1 }, {
    unique: true,
    name: 'uniq_round_position_v2',
  }, ['cycle_id_1_role_1_order_index_1', 'uniq_round_position_v1']),
  index('graderassignments', { round_id: 1, applicant_id: 1, grader_email: 1 }, { unique: true }),
  index('graderassignments', { grader_email: 1, round_id: 1, applicant_id: 1 }),
  index('graderassignments', { grader_email: 1, applicant_id: 1 }),
  index('reviews', { round_id: 1, applicant_id: 1, grader_email: 1 }, { unique: true }),
  index('reviews', { grader_email: 1, round_id: 1, applicant_id: 1 }),
  index('sessions', { round_id: 1, role: 1 }, {
    unique: true,
    name: 'uniq_active_session_role_v2',
    partialFilterExpression: { status: 'active', round_id: { $type: 'objectId' } },
  }, ['round_id_1_role_1', 'uniq_active_session_role_v1']),
  index('candidates', { session_id: 1, created_at: 1 }),
  index('candidates', { session_id: 1, applicant_id: 1 }, {
    unique: true,
    name: 'uniq_session_applicant_v1',
    partialFilterExpression: { applicant_id: { $type: 'objectId' } },
  }, ['session_id_1_applicant_id_1']),
  index('votes', { candidate_id: 1, voter_email: 1, vote_type: 1 }, {
    unique: true,
    partialFilterExpression: { voter_email: { $type: 'string' } },
  }),
  index('candidatenotes', { candidate_id: 1, created_at: 1 }),
  index('coffeechatnotes', { cycle_id: 1, applicant_id: 1, chat_date: 1 }),
  index('sessionmembers', { session_id: 1, user_email: 1 }, { unique: true }),
  index('sessionbans', { session_id: 1, email: 1 }, { unique: true }),
]

function index(collection, key, options = {}, predecessorNames = []) {
  return { collection, key, options, predecessorNames }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
}

function same(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}

function keySignature(key) {
  return JSON.stringify(Object.entries(key))
}

function optionMatches(actual, desired) {
  if (Boolean(actual.unique) !== Boolean(desired.unique)) return false
  if (Boolean(actual.sparse) !== Boolean(desired.sparse)) return false
  if (Boolean(actual.hidden) !== Boolean(desired.hidden)) return false
  if ((actual.expireAfterSeconds ?? null) !== (desired.expireAfterSeconds ?? null)) return false
  if (!same(actual.partialFilterExpression ?? null, desired.partialFilterExpression ?? null)) return false

  const desiredCollation = desired.collation ?? null
  if (desiredCollation) {
    const actualCollation = actual.collation ?? {}
    if (Object.entries(desiredCollation).some(([key, value]) => !same(actualCollation[key], value))) return false
  } else if (actual.collation) {
    return false
  }
  return true
}

function reviewedPredecessorNames(desired) {
  return new Set([
    ...desired.predecessorNames,
    desired.options.name,
    desired.options.name ? `${desired.options.name}__replacement` : null,
  ].filter(Boolean))
}

async function duplicateGroupCount(collection, pipeline, options = {}) {
  const [result] = await collection.aggregate(
    [...pipeline, { $limit: 1 }],
    { allowDiskUse: true, ...options },
  ).toArray()
  return result ? 1 : 0
}

async function hasInvalidIdentityValue(db, collectionName, field, required) {
  const fieldReference = `$${field}`
  const fieldType = { $type: fieldReference }
  const normalized = {
    $cond: [
      { $eq: [fieldType, 'string'] },
      { $toLower: { $trim: { input: fieldReference } } },
      null,
    ],
  }
  const invalidString = {
    $and: [
      { $eq: [fieldType, 'string'] },
      { $or: [{ $eq: [normalized, ''] }, { $ne: [fieldReference, normalized] }] },
    ],
  }
  const invalidExpression = required
    ? { $or: [{ $ne: [fieldType, 'string'] }, invalidString] }
    : {
        $or: [
          { $not: [{ $in: [fieldType, ['missing', 'null', 'string']] }] },
          invalidString,
        ],
      }
  const [result] = await db.collection(collectionName).aggregate([
    { $match: { $expr: invalidExpression } },
    { $limit: 1 },
    { $project: { _id: 1 } },
  ]).toArray()
  return Boolean(result)
}

async function preflight(db) {
  const failures = []

  // These collections contain the production data that proves we reached the
  // real recruitment database. Never recreate them as empty collections during
  // a security migration; that could disguise a partial restore or wrong
  // target as a successful rollout.
  const requiredExistingCollections = [
    'recruitmentcycles',
    'applicants',
    'essayprompts',
    'authorizedusers',
  ]
  const existingCollections = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map(item => item.name),
  )
  for (const collectionName of requiredExistingCollections) {
    if (!existingCollections.has(collectionName)) {
      failures.push(`Required production collection ${collectionName} is absent; refusing to create it.`)
    }
  }

  const expectedCycle = await db.collection('recruitmentcycles').findOne(
    { _id: new mongoose.Types.ObjectId(SECURITY_INDEX_EXPECTED_CYCLE_ID) },
    { projection: { _id: 1, name: 1 } },
  )
  if (!expectedCycle) {
    failures.push('The expected recruitment-cycle sentinel is absent; refusing to target this database.')
  } else {
    console.log(`✓ Production sentinel found: ${expectedCycle.name ?? expectedCycle._id.toString()}.`)
  }

  const openCycles = await db.collection('recruitmentcycles').countDocuments({ accepting_applications: true }, { limit: 2 })
  if (openCycles > 1) failures.push('More than one recruitment cycle is accepting applications.')

  if (await duplicateGroupCount(db.collection('rounds'), [
    { $group: { _id: { cycle_id: '$cycle_id', role: '$role', order_index: '$order_index' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ])) failures.push('Duplicate round positions exist, including null-role positions.')

  if (await duplicateGroupCount(db.collection('sessions'), [
    { $match: { status: 'active', round_id: { $type: 'objectId' } } },
    { $group: { _id: { round_id: '$round_id', role: '$role' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ])) failures.push('Duplicate active round/role sessions exist.')

  if (await duplicateGroupCount(db.collection('candidates'), [
    { $match: { applicant_id: { $type: 'objectId' } } },
    { $group: { _id: { session_id: '$session_id', applicant_id: '$applicant_id' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ])) failures.push('Duplicate applicant-linked candidates exist in a session.')

  const duplicateChecks = [
    ['authorizedusers', [], '$email', 'Duplicate authorized-user emails exist.'],
    ['essayprompts', [], { cycle_id: '$cycle_id', question_number: '$question_number' }, 'Duplicate essay prompt positions exist.'],
    ['essayresponses', [], { applicant_id: '$applicant_id', prompt_id: '$prompt_id' }, 'Duplicate essay responses exist.'],
    ['graderassignments', [], { round_id: '$round_id', applicant_id: '$applicant_id', grader_email: '$grader_email' }, 'Duplicate grader assignments exist.'],
    ['reviews', [], { round_id: '$round_id', applicant_id: '$applicant_id', grader_email: '$grader_email' }, 'Duplicate reviews exist.'],
    ['votes', [{ $match: { voter_email: { $type: 'string' } } }], { candidate_id: '$candidate_id', voter_email: '$voter_email', vote_type: '$vote_type' }, 'Duplicate authenticated votes exist.'],
    ['sessionmembers', [], { session_id: '$session_id', user_email: '$user_email' }, 'Duplicate session members exist.'],
    ['sessionbans', [], { session_id: '$session_id', email: '$email' }, 'Duplicate session bans exist.'],
  ]
  for (const [collectionName, prefix, groupId, message] of duplicateChecks) {
    if (await duplicateGroupCount(db.collection(collectionName), [
      ...prefix,
      { $group: { _id: groupId, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
    ])) failures.push(message)
  }

  if (await duplicateGroupCount(db.collection('applicants'), [
    { $match: { email: { $type: 'string' } } },
    { $group: { _id: { cycle_id: '$cycle_id', email: '$email' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ], { collation: APPLICANT_EMAIL_COLLATION })) {
    failures.push('Applicant email duplicates exist under the exact target collation.')
  }

  const invalidApplicantEmail = await duplicateGroupCount(db.collection('applicants'), [
    { $match: { $expr: { $ne: [{ $type: '$email' }, 'string'] } } },
  ])
  if (invalidApplicantEmail) {
    failures.push('At least one legacy applicant has a missing, null, or non-string email and requires manual remediation.')
  }

  const applicantCursor = db.collection('applicants').find(
    { email: { $type: 'string' } },
    { projection: { _id: 1, cycle_id: 1, email: 1 } },
  )
  const normalizedOwners = new Map()
  const emailUpdates = []
  for await (const applicant of applicantCursor) {
    const normalized = applicant.email.trim().toLowerCase()
    if (!normalized) {
      failures.push('At least one applicant has a blank string email.')
      continue
    }
    const key = `${applicant.cycle_id}:${normalized}`
    if (normalizedOwners.has(key)) {
      failures.push('Case-insensitive duplicate applicant emails exist within a cycle.')
      continue
    }
    normalizedOwners.set(key, applicant._id)
    if (normalized !== applicant.email) emailUpdates.push({ _id: applicant._id, email: normalized })
  }

  if (emailUpdates.length > 0) {
    failures.push('Applicant emails require lowercase/trim normalization; remediate them explicitly before migration.')
  }

  const identityFields = [
    ['authorizedusers', 'email', true],
    ['authorizedusers', 'added_by', false],
    ['graderassignments', 'grader_email', true],
    ['reviews', 'grader_email', true],
    ['sessions', 'created_by', true],
    ['sessionmembers', 'user_email', true],
    ['sessionbans', 'email', true],
    ['sessionbans', 'banned_by', true],
    ['votes', 'voter_email', false],
    ['candidatenotes', 'author_email', false],
    ['coffeechatnotes', 'imported_by', true],
  ]
  for (const [collectionName, field, required] of identityFields) {
    if (await hasInvalidIdentityValue(db, collectionName, field, required)) {
      failures.push(`${collectionName}.${field} contains a missing, blank, mixed-case, or whitespace-padded identity value.`)
    }
  }

  console.log(`Preflight: ${openCycles} open cycle; ${emailUpdates.length} applicant email value(s) require normalization.`)
  if (failures.length > 0) {
    for (const failure of [...new Set(failures)]) console.error(`✗ ${failure}`)
    throw new Error('Security index preflight failed. No changes were made.')
  }
  console.log('✓ Duplicate and normalization preflights passed.')
}

async function inspectIndexPlan(db) {
  const failures = []
  const knownCollections = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map(item => item.name),
  )

  for (const desired of DESIRED) {
    const label = `${desired.collection}.${Object.keys(desired.key).join('+')}`
    if (!knownCollections.has(desired.collection)) {
      console.log(`PLAN ${label}: create collection, then create index.`)
      continue
    }

    const indexes = await db.collection(desired.collection).listIndexes().toArray()
    const sameKeyIndexes = indexes.filter(item => keySignature(item.key) === keySignature(desired.key))
    let matching = sameKeyIndexes.find(item => optionMatches(item, desired.options))
    const desiredNameCollision = desired.options.name
      ? indexes.find(item => item.name === desired.options.name)
      : null
    if (desiredNameCollision && keySignature(desiredNameCollision.key) !== keySignature(desired.key)) {
      failures.push(`${label}: desired index name is already used by a different key.`)
      continue
    }

    if (!matching) {
      if (!desired.options.name && sameKeyIndexes.length > 0) {
        failures.push(`${label}: incompatible unnamed same-key index requires a reviewed named migration.`)
        continue
      }
      if (desiredNameCollision) {
        const replacementName = `${desired.options.name}__replacement`
        const replacementCollision = indexes.find(item => item.name === replacementName)
        if (replacementCollision) {
          if (
            keySignature(replacementCollision.key) !== keySignature(desired.key)
            || !optionMatches(replacementCollision, desired.options)
          ) {
            failures.push(`${label}: replacement index name is already used incompatibly.`)
            continue
          }
          matching = replacementCollision
        } else {
          console.log(`PLAN ${label}: create secure replacement ${replacementName} before cleanup.`)
        }
      } else {
        console.log(`PLAN ${label}: create index${desired.options.name ? ` ${desired.options.name}` : ''}.`)
      }
    } else {
      console.log(`PLAN ${label}: matching index ${matching.name} already exists.`)
    }

    const reviewedPredecessors = reviewedPredecessorNames(desired)
    for (const sameKey of sameKeyIndexes.filter(item => item.name !== matching?.name)) {
      if (!reviewedPredecessors.has(sameKey.name)) {
        failures.push(`${label}: unexpected same-key index ${sameKey.name} requires manual review.`)
      } else {
        console.log(`PLAN ${label}: drop reviewed predecessor ${sameKey.name} only after replacement verification.`)
      }
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`✗ ${failure}`)
    throw new Error('Security index plan contains unresolved conflicts. No changes were made.')
  }
  console.log('✓ Explicit index plan is conflict-free.')
}

async function applyMigration(db) {
  const knownCollections = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(item => item.name))
  for (const desired of DESIRED) {
    if (!knownCollections.has(desired.collection)) {
      await db.createCollection(desired.collection)
      knownCollections.add(desired.collection)
      console.log(`✓ ${desired.collection}: created empty collection for explicit index management.`)
    }
    const collection = db.collection(desired.collection)
    let indexes = await collection.listIndexes().toArray()
    let sameKeyIndexes = indexes.filter(item => keySignature(item.key) === keySignature(desired.key))
    let matching = sameKeyIndexes.find(item => optionMatches(item, desired.options))
    const label = `${desired.collection}.${Object.keys(desired.key).join('+')}`
    const initialNameCollision = desired.options.name
      ? indexes.find(item => item.name === desired.options.name)
      : null
    if (initialNameCollision && keySignature(initialNameCollision.key) !== keySignature(desired.key)) {
      throw new Error(`${label}: desired index name is already used by a different key.`)
    }
    if (!matching) {
      let createOptions = { ...desired.options }
      if (desired.options.name) {
        const nameCollision = indexes.find(item => item.name === desired.options.name)
        if (nameCollision && keySignature(nameCollision.key) !== keySignature(desired.key)) {
          throw new Error(`${label}: desired index name is already used by a different key.`)
        }
        if (nameCollision) {
          // A prior failed migration may have left the intended name attached
          // to the old options. Build a coexistable secure replacement first.
          createOptions = { ...createOptions, name: `${desired.options.name}__replacement` }
          const replacementCollision = indexes.find(item => item.name === createOptions.name)
          if (replacementCollision) {
            if (
              keySignature(replacementCollision.key) !== keySignature(desired.key)
              || !optionMatches(replacementCollision, desired.options)
            ) {
              throw new Error(`${label}: replacement index name is already used incompatibly.`)
            }
            matching = replacementCollision
          }
        }
      } else if (sameKeyIndexes.length > 0) {
        // Same-key replacement without a distinct name cannot be created beside
        // the old index. Refuse to drop first because that would open a live
        // uniqueness gap if replacement creation failed.
        throw new Error(`${label}: incompatible unnamed index requires a reviewed named migration.`)
      }

      if (!matching) {
        await collection.createIndex(desired.key, createOptions)
        console.log(`✓ ${label}: created.`)
        indexes = await collection.listIndexes().toArray()
        sameKeyIndexes = indexes.filter(item => keySignature(item.key) === keySignature(desired.key))
        matching = sameKeyIndexes.find(item => optionMatches(item, desired.options))
        if (!matching) throw new Error(`${label}: replacement was created but could not be verified.`)
      }
    } else {
      console.log(`✓ ${label} already matches.`)
    }

    // Once one correct index is confirmed, clean up every weaker same-key
    // predecessor. This makes reruns safe after a create-succeeded/drop-failed
    // partial migration.
    indexes = await collection.listIndexes().toArray()
    sameKeyIndexes = indexes.filter(item => keySignature(item.key) === keySignature(desired.key))
    const reviewedPredecessors = reviewedPredecessorNames(desired)
    for (const superseded of sameKeyIndexes.filter(item => item.name !== matching.name)) {
      if (!reviewedPredecessors.has(superseded.name)) {
        throw new Error(
          `${label}: unexpected same-key index ${superseded.name}; review it manually instead of deleting automatically.`,
        )
      }
      await collection.dropIndex(superseded.name)
      console.log(`✓ ${label}: removed superseded index ${superseded.name}.`)
    }
  }
}

async function verify(db) {
  const failures = []
  const knownCollections = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(item => item.name))
  for (const desired of DESIRED) {
    if (!knownCollections.has(desired.collection)) {
      failures.push(`${desired.collection} (collection missing)`)
      continue
    }
    const indexes = await db.collection(desired.collection).listIndexes().toArray()
    const matching = indexes.find(item => (
      keySignature(item.key) === keySignature(desired.key)
      && optionMatches(item, desired.options)
    ))
    if (!matching) {
      failures.push(`${desired.collection}.${Object.keys(desired.key).join('+')}`)
    }
  }
  if (failures.length) throw new Error(`Index verification failed: ${failures.join(', ')}`)
  console.log('✓ Security index verification passed.')
}

async function main() {
  try {
    await mongoose.connect(MONGODB_URI, {
      dbName: SECURITY_INDEX_DB_NAME,
      autoCreate: false,
      autoIndex: false,
      bufferCommands: false,
      serverSelectionTimeoutMS: 10_000,
      secureProtocol: 'TLSv1_2_method',
    })
    const db = mongoose.connection.db
    if (!db) throw new Error('MongoDB connection did not expose a database handle.')
    if (db.databaseName !== SECURITY_INDEX_DB_NAME) {
      throw new Error(`Connected database ${db.databaseName} does not match SECURITY_INDEX_DB_NAME.`)
    }
    const hello = await db.admin().command({ hello: 1 })
    if (!hello.setName && hello.msg !== 'isdbgrid') {
      throw new Error('MongoDB must be a replica set or sharded cluster because this release requires transactions.')
    }

    console.log(`Security index migration mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`)
    console.log(`Verified target database: ${db.databaseName}; transaction topology: ${hello.setName ? 'replica set' : 'sharded cluster'}.`)
    await preflight(db)
    await inspectIndexPlan(db)
    if (!APPLY) {
      console.log('✓ Dry run complete. No data or indexes were changed.')
      return
    }
    await applyMigration(db)
    await verify(db)
  } finally {
    await mongoose.disconnect().catch(() => {})
  }
}

main().catch(error => {
  const raw = error instanceof Error ? error.message : String(error)
  console.error('FATAL:', raw.replaceAll(MONGODB_URI, '<redacted MongoDB URI>'))
  process.exitCode = 1
})
