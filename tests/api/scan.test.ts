import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import { registerScanRoutes } from '../../src/api/scan.js'
import type { ScanRunner } from '../../src/scan/runner.js'
import { signSession } from '../../src/auth/session.js'
import { openDb } from '../../src/index/db.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SECRET = 'z'.repeat(32)
// isAdministrator: true is required — requireSession (src/api/auth.ts) rejects any session that
// does not carry it, the same admin re-assertion every other guarded route relies on.
const auth = () => ({ cookie: `jellymaid_session=${signSession({ username: 'bob', userId: 'u', issuedAt: Date.now(), isAdministrator: true }, SECRET)}` })

let db: ReturnType<typeof openDb>

function build(runner: Partial<ReturnType<typeof fakeRunner>> = {}) {
  const app = Fastify()
  app.register(cookie)
  db = openDb(join(mkdtempSync(join(tmpdir(), 'jm-scanapi-')), 'db.sqlite'))
  registerScanRoutes(app, { runner: { ...fakeRunner(), ...runner } as never, sessionSecret: SECRET, db })
  return app
}

// Typed as the real ScanRunner interface (not inferred from the literal) so that overrides like
// `{ start: () => ({ error: '...' }) }` — a real, valid ScanRunner['start'] return shape — remain
// assignable to `Partial<ReturnType<typeof fakeRunner>>` below.
function fakeRunner(): ScanRunner {
  return {
    start: () => ({ scanId: 1 }),
    cancel: () => true,
    isRunning: () => false,
    status: () => ({ running: false, scanId: null, phase: null, done: 0, total: null, lastScan: null }),
  }
}

/** Mirrors what POST /api/pathmap/verify persists. */
function setVerification(report: { sampled: number; resolved: number; failures: unknown[] }) {
  db.prepare("INSERT OR REPLACE INTO kv (key, value_json) VALUES ('pathmap.lastVerification', ?)")
    .run(JSON.stringify({ ...report, at: new Date().toISOString() }))
}

describe('/api/scan', () => {
  it('requires a session to start', async () => {
    expect((await build().inject({ method: 'POST', url: '/api/scan/start' })).statusCode).toBe(401)
  })

  it('starts a scan and returns the id', async () => {
    const app = build()
    setVerification({ sampled: 1, resolved: 1, failures: [] })
    const res = await app.inject({ method: 'POST', url: '/api/scan/start', headers: auth() })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ scanId: 1 })
  })

  it('returns 409 when a scan is already running', async () => {
    const app = build({ start: () => ({ error: 'a scan is already running' }) })
    setVerification({ sampled: 1, resolved: 1, failures: [] })
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
  // Spec §11: a scan must not run against an unverified path map. Indexing the wrong paths is how
  // a cleanup tool ends up proposing deletions for files it misidentified.
  it('refuses with 412 when verification has never been run', async () => {
    const app = build()
    const res = await app.inject({ method: 'POST', url: '/api/scan/start', headers: auth() })
    expect(res.statusCode).toBe(412)
    expect(res.json().error).toMatch(/verif/i)
  })

  it('refuses when the last verification had failures', async () => {
    const app = build()
    setVerification({ sampled: 20, resolved: 12, failures: [{ jellyfinPath: '/media/x.mkv', reason: 'no mapping covers this path' }] })
    const res = await app.inject({ method: 'POST', url: '/api/scan/start', headers: auth() })
    expect(res.statusCode).toBe(412)
  })

  it('starts when the last verification was clean', async () => {
    const app = build()
    setVerification({ sampled: 20, resolved: 20, failures: [] })
    const res = await app.inject({ method: 'POST', url: '/api/scan/start', headers: auth() })
    expect(res.statusCode).toBe(202)
  })

  it('starts anyway when the operator explicitly forces it', async () => {
    const app = build()
    setVerification({ sampled: 20, resolved: 0, failures: [{ jellyfinPath: '/x', reason: 'nope' }] })
    const res = await app.inject({ method: 'POST', url: '/api/scan/start', headers: auth(), payload: { force: true } })
    expect(res.statusCode).toBe(202)
  })
})
