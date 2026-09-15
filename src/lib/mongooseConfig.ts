import mongoose from 'mongoose'

let configured = false

/**
 * Apply security-sensitive Mongoose defaults before any schemas are created.
 *
 * sanitizeFilter protects scalar filter values from query-selector injection.
 * Server-authored operators must therefore be explicitly marked with
 * `mongoose.trusted()` at their call sites.
 */
export function configureMongooseSecurity() {
  if (configured) return

  mongoose.set({
    runValidators: true,
    sanitizeFilter: true,
    sanitizeProjection: true,
    strict: 'throw',
    strictQuery: 'throw',
  })

  configured = true
}
