import mongoose from 'mongoose'
import nextEnv from '@next/env'
import { PS_INDEXES } from './ps-index-manifest.mjs'
nextEnv.loadEnvConfig(process.cwd(), false, { info() {}, error() {} })
const expectedDatabase = process.argv.find(arg => arg.startsWith('--database='))?.slice('--database='.length)
if (!expectedDatabase) throw new Error('Specify --database=<expected database name>. Default is read-only preflight; --apply creates additive indexes.')
if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required.')
try {
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 10000, secureProtocol: 'TLSv1_2_method' })
  if (mongoose.connection.name !== expectedDatabase) throw new Error('Database name does not match the explicit expected target.')
  const db = mongoose.connection.db
  for (const definition of PS_INDEXES) {
    const collection = db.collection(definition.collection)
    if (definition.unique) {
      const group = Object.fromEntries(Object.keys(definition.key).map(key => [key, `$${key}`]))
      const duplicate = await collection.aggregate([...(definition.partialFilterExpression ? [{ $match: definition.partialFilterExpression }] : []), { $group: { _id: group, count: { $sum: 1 } } }, { $match: { count: { $gt: 1 } } }, { $limit: 1 }]).toArray()
      if (duplicate.length) throw new Error(`Duplicate keys in ${definition.collection}; no indexes were applied. Resolve through a reviewed remediation.`)
    }
  }
  if (process.argv.includes('--apply')) {
    for (const definition of PS_INDEXES) {
      const { collection, key, ...options } = definition
      await db.collection(collection).createIndex(key, options)
    }
    console.log('Additive PS indexes created; no legacy indexes or data changed.')
  } else console.log('PS index preflight passed. No changes made. Use --apply with the same explicit database to create indexes before deployment.')
} catch (error) { console.error('PS index check failed:', error instanceof Error && !/password|mongodb:|mongodb\+srv:/.test(error.message) ? error.message : 'Connection or index operation failed.'); process.exitCode = 1 }
finally { await mongoose.disconnect() }
