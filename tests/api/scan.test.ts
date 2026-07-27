import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import { registerScanRoutes } from '../../src/api/scan.js'
import type { ScanRunner } from '../../src/scan/runner.js'
import { signSession } from '../../src/auth/session.js'

const SECRET = 'z'.repeat(32)
// isAdministrator: true is required — requireSession (src/api/auth.ts) rejects any session that
// does not carry it, the same admin re-assertion every other guarded route relies on.
const auth = () => ({ cookie: `jellymaid_session=${signSession({ username: 'bob', userId: 'u', issuedAt: Date.now(), isAdministrator: true }, SECRET)}` })

function build(runner: Partial<ScanRunner> = {}) {
  const app = Fastify()
  app.register(cookie)
  registerScanRoutes(app, { runner: { ...fakeRunner(), ...runner } as ScanRunner, sessionSecret: SECRET })
  return app
}

// Typed as the real ScanRunner interface (not inferred from the literal) so that overrides like
// `{ start: () => ({ error: '...', reason: 'busy' }) }` — a real, valid ScanRunner['start'] return
// shape — remain assignable below.
function fakeRunner(): ScanRunner {
  return {
    start: () => ({ scanId: 1 }),
    cancel: () => true,
    isRunning: () => false,
    status: () => ({ running: false, scanId: null, phase: null, done: 0, total: null, lastScan: null }),
  }
}

describe('/api/scan', () => {
  it('requires a session to start', async () => {
    expect((await build().inject({ method: 'POST', url: '/api/scan/start' })).statusCode).toBe(401)
  })

  it('starts a scan and returns the id', async () => {
    const res = await build().inject({ method: 'POST', url: '/api/scan/start', headers: auth() })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ scanId: 1 })
  })

  it('returns 409 when a scan is already running', async () => {
    const app = build({ start: () => ({ error: 'a scan is already running', reason: 'busy' }) })
    const res = await app.inject({ method: 'POST', url: '/api/scan/start', headers: auth() })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/already running/)
  })

  it('reports status without a session — the UI polls it on the login screen', async () => {
    const res = await build().inject({ method: 'GET', url: '/api/scan/status' })
    expect(res.statusCode).toBe(401)
  })

  it('reports status with a session', async () => {
    const res = await build().inject({ method: 'GET', url: '/api/scan/status', headers: auth() })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ running: false })
  })

  it('returns 409 on cancel when nothing is running', async () => {
    const res = await build({ cancel: () => false })
      .inject({ method: 'POST', url: '/api/scan/cancel', headers: auth() })
    expect(res.statusCode).toBe(409)
  })
})

describe('/api/scan/start — path-map verification gate', () => {
  // The gate itself lives in the runner (src/scan/verification.ts), because the nightly scheduled
  // scan never passes through this route; see tests/scan/runner.test.ts for the gate's own
  // behaviour. What this route owns is turning the runner's refusal into the right status code.
  it('maps an unverified refusal to 412 and marks it forcible', async () => {
    const app = build({ start: () => ({ error: 'path mappings have never been verified', reason: 'unverified' }) })
    const res = await app.inject({ method: 'POST', url: '/api/scan/start', headers: auth() })
    expect(res.statusCode).toBe(412)
    expect(res.json()).toMatchObject({ error: expect.stringMatching(/verif/i), forcible: true })
  })

  it('passes force straight through to the runner', async () => {
    const seen: Array<{ force?: boolean; resumeScanId?: number }> = []
    const app = build({ start: (o) => { seen.push(o ?? {}); return { scanId: 7 } } })
    await app.inject({ method: 'POST', url: '/api/scan/start', headers: auth(), payload: { force: true } })
    expect(seen).toEqual([{ force: true }])
  })
})
