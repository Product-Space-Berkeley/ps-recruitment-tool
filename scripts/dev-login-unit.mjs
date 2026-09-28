import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

function load(path, env, dependencies = {}) {
  const exports = {}
  const code = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText
  vm.runInNewContext(code, {
    exports, process: { env }, URL,
    require(name) {
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`)
      return dependencies[name]
    },
  })
  return exports
}

const env = { NODE_ENV: 'development', DEV_LOGIN: '1', NEXTAUTH_URL: 'http://localhost:5173' }
const guard = load('src/lib/devLogin.ts', env)
for (const mode of ['production', 'test', undefined]) {
  env.NODE_ENV = mode
  assert.equal(guard.devLoginEnabled(), false)
}
env.NODE_ENV = 'development'
for (const url of ['', 'invalid', 'https://example.com', 'http://localhost.evil.com']) {
  env.NEXTAUTH_URL = url
  assert.equal(guard.devLoginEnabled(), false)
}
env.NEXTAUTH_URL = 'http://localhost:5173'
env.DEV_LOGIN = '0'
assert.equal(guard.devLoginEnabled(), false)
env.DEV_LOGIN = '1'
assert.equal(guard.devLoginEnabled(), true)

const dependencies = {
  'next-auth/providers/google': options => ({ id: 'google', ...options }),
  'next-auth/providers/credentials': options => options,
  '@/lib/devLogin': guard,
  '@/lib/mongodb': { connectDB: () => { throw Error('Dev login must not require MongoDB') } },
  '@/lib/models': {},
}
const { authOptions } = load('src/lib/authOptions.ts', env, dependencies)
const provider = authOptions.providers.find(p => p.id === 'dev-login')
assert.ok(provider)
assert.equal((await provider.authorize()).email, 'dev-admin@example.test')
const account = { provider: 'dev-login' }
assert.equal(await authOptions.callbacks.signIn({ account }), true)
const token = await authOptions.callbacks.jwt({ token: {}, account })
const session = await authOptions.callbacks.session({ session: {}, token })
assert.equal(session.user.role, 'admin')
assert.equal(session.user.applicantVerified, false)
assert.equal((await authOptions.callbacks.jwt({ token, account: { provider: 'google' } })).devLogin, false)
token.devLogin = true
for (const mode of ['disabled', 'production']) {
  env.DEV_LOGIN = mode === 'disabled' ? '0' : '1'
  env.NODE_ENV = mode === 'production' ? 'production' : 'development'
  assert.equal(await provider.authorize(), null)
  assert.equal(await authOptions.callbacks.signIn({ account }), false)
  assert.equal((await authOptions.callbacks.session({ session, token })).user, undefined)
  assert.equal(load('src/lib/authOptions.ts', env, dependencies).authOptions.providers.some(p => p.id === 'dev-login'), false)
}
console.log('Development login safeguards passed')
