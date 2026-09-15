import mongoose from 'mongoose'
import { configureMongooseSecurity } from '@/lib/mongooseConfig'

configureMongooseSecurity()

// Cache connection across hot reloads in dev
const globalWithMongoose = global as typeof global & { mongoose?: { conn: typeof mongoose | null; promise: Promise<typeof mongoose> | null } }

if (!globalWithMongoose.mongoose) {
  globalWithMongoose.mongoose = { conn: null, promise: null }
}

const cached = globalWithMongoose.mongoose

export async function connectDB() {
  const uri = process.env.MONGODB_URI
  if (!uri) throw new Error('MONGODB_URI is not defined in environment variables.')
  if (cached.conn) return cached.conn
  if (!cached.promise) {
    cached.promise = mongoose.connect(uri, {
      bufferCommands: false,
      // Production indexes are changed only by the reviewed migration script.
      // Automatic DDL during a serverless cold start is unpredictable and can
      // fail when a same-key index needs different security options.
      autoIndex: process.env.NODE_ENV !== 'production',
      autoCreate: process.env.NODE_ENV !== 'production',
      maxPoolSize: 10,
      minPoolSize: 0,
      maxIdleTimeMS: 30_000,
      serverSelectionTimeoutMS: 10_000,
      socketTimeoutMS: 45_000,
      // Atlas currently rejects Node 24's TLS 1.3 ClientHello for this cluster.
      // TLS 1.2 remains encrypted and is supported by Atlas on every runtime we use.
      secureProtocol: 'TLSv1_2_method',
    })
  }
  try {
    cached.conn = await cached.promise
  } catch (error) {
    // Do not keep a rejected promise cached for the lifetime of the server process.
    cached.promise = null
    throw error
  }
  return cached.conn
}
