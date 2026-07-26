// tests/api/auth.test.ts
import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import { registerAuthRoutes, requireSession } from '../../src/api/auth.js'
import { createLockout } from '../../src/auth/lockout.js'
import { SESSION_COOKIE, signSession } from '../../src/auth/session.js'

function build(authenticate: (u: string, p: string) => Promise<{ userId: string; token: string; isAdministrator: boolean }>) {
  const app = Fastify()
  app.register(cookie)
  registerAuthRoutes(app, {
    jellyfin: { authenticateByName: authenticate } as never,
    sessionSecret: 'a-very-long-test-secret',
    lockout: createLockout({ maxFailures: 3, windowMs: 300_000, lockMs: 3_600_000 }),
    secureCookie: false,
  })
  return app
}

const admin = async () => ({ userId: 'u1', token: 'T', isAdministrator: true })

describe('POST /api/auth/login', () => {
  it('sets an httpOnly session cookie for an admin', async () => {
    const app = build(admin)
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'bob', password: 'pw' } })
    expect(res.statusCode).toBe(200)
    const setCookie = String(res.headers['set-cookie'])
    expect(setCookie).toContain(SESSION_COOKIE)
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Lax')
  })

  it('rejects a valid non-admin with 403 and no cookie', async () => {
    const app = build(async () => ({ userId: 'u2', token: 'T', isAdministrator: false }))
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'eve', password: 'pw' } })
    expect(res.statusCode).toBe(403)
    expect(res.headers['set-cookie']).toBeUndefined()
    expect(res.json().error).toMatch(/administrator/i)
  })

  it('locks out after three failures in the window', async () => {
    const app = build(async () => { const e = new Error('bad'); (e as never as { kind: string }).kind = 'auth'; throw e })
    for (let i = 0; i < 3; i += 1) {
      await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'bob', password: 'x' } })
    }
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'bob', password: 'x' } })
    expect(res.statusCode).toBe(429)
  })

  it('does NOT consume an attempt when Jellyfin is unreachable', async () => {
    const err = Object.assign(new Error('down'), { kind: 'unreachable', name: 'ConnectorError' })
    const app = build(async () => { throw err })
    for (let i = 0; i < 5; i += 1) {
      const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'bob', password: 'x' } })
      expect(r.statusCode).toBe(503)
    }
  })

  it('treats an error with no kind as a Jellyfin-side problem: 503 and no consumed attempt', async () => {
    const app = build(async () => { throw new Error('boom') })
    for (let i = 0; i < 5; i += 1) {
      const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'bob', password: 'x' } })
      expect(r.statusCode).toBe(503)
    }
  })

  it('serializes concurrent attempts for the same key so a burst cannot bypass the lockout', async () => {
    let calls = 0
    const app = build(async () => {
      calls += 1
      await new Promise((r) => setTimeout(r, 20))
      throw Object.assign(new Error('bad'), { kind: 'auth', name: 'ConnectorError' })
    })
    const attempts = Array.from({ length: 20 }, () =>
      app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'burst', password: 'x' } }),
    )
    const results = await Promise.all(attempts)
    expect(calls).toBeLessThanOrEqual(3)
    expect(results.some((r) => r.statusCode === 429)).toBe(true)
  })

  it('locks the USERNAME after three failures spread across three different IPs', async () => {
    const app = build(async () => { throw Object.assign(new Error('bad'), { kind: 'auth', name: 'ConnectorError' }) })
    for (const ip of ['10.0.0.1', '10.0.0.2', '10.0.0.3']) {
      const r = await app.inject({
        method: 'POST', url: '/api/auth/login', remoteAddress: ip,
        payload: { username: 'victim', password: 'x' },
      })
      expect(r.statusCode).toBe(401)
    }
    // A fourth IP the lockout has never seen still must not get a free guess at this account.
    const res = await app.inject({
      method: 'POST', url: '/api/auth/login', remoteAddress: '10.0.0.4',
      payload: { username: 'victim', password: 'x' },
    })
    expect(res.statusCode).toBe(429)
  })

  it('locks the IP after three failures spread across three different usernames', async () => {
    const app = build(async () => { throw Object.assign(new Error('bad'), { kind: 'auth', name: 'ConnectorError' }) })
    for (const username of ['alice', 'bob', 'carol'] as const) {
      const r = await app.inject({
        method: 'POST', url: '/api/auth/login', remoteAddress: '10.9.9.9',
        payload: { username, password: 'x' },
      })
      expect(r.statusCode).toBe(401)
    }
    // A username the lockout has never seen still must not get a free guess from this IP.
    const res = await app.inject({
      method: 'POST', url: '/api/auth/login', remoteAddress: '10.9.9.9',
      payload: { username: 'dave', password: 'x' },
    })
    expect(res.statusCode).toBe(429)
  })

  it('a successful login clears both the username and the IP counters', async () => {
    let admitted = false
    const app = build(async () => {
      if (admitted) return { userId: 'u1', token: 'T', isAdministrator: true }
      throw Object.assign(new Error('bad'), { kind: 'auth', name: 'ConnectorError' })
    })
    for (let i = 0; i < 2; i += 1) {
      await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '10.5.5.5', payload: { username: 'bob', password: 'x' } })
    }
    admitted = true
    const ok = await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '10.5.5.5', payload: { username: 'bob', password: 'pw' } })
    expect(ok.statusCode).toBe(200)

    admitted = false
    // Both counters were reset, so three more failures are needed before the lock returns.
    for (let i = 0; i < 2; i += 1) {
      const r = await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '10.5.5.5', payload: { username: 'bob', password: 'x' } })
      expect(r.statusCode).toBe(401)
    }
  })

  it('never echoes the password back in any response', async () => {
    const app = build(async () => { throw Object.assign(new Error('nope'), { kind: 'auth', name: 'ConnectorError' }) })
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'bob', password: 'hunter2' } })
    expect(res.body).not.toContain('hunter2')
  })
})

describe('GET /api/auth/me', () => {
  it('returns 401 without a session', async () => {
    const app = build(admin)
    expect((await app.inject({ method: 'GET', url: '/api/auth/me' })).statusCode).toBe(401)
  })

  it('returns the username with a valid session', async () => {
    const app = build(admin)
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'bob', password: 'pw' } })
    const cookieHeader = String(login.headers['set-cookie']).split(';')[0]!
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: cookieHeader } })
    expect(me.json()).toMatchObject({ username: 'bob' })
  })

  it('rejects a tampered session cookie', async () => {
    const app = build(admin)
    const res = await app.inject({
      method: 'GET', url: '/api/auth/me',
      headers: { cookie: `${SESSION_COOKIE}=eyJhIjoxfQ.forged` },
    })
    expect(res.statusCode).toBe(401)
  })
})

describe('requireSession preHandler', () => {
  const secret = 'a-very-long-test-secret'

  function buildProtected() {
    const app = Fastify()
    app.register(cookie)
    app.get('/protected', { preHandler: requireSession(secret) }, async () => ({ ok: true }))
    return app
  }

  it('blocks a request with no session', async () => {
    const app = buildProtected()
    const res = await app.inject({ method: 'GET', url: '/protected' })
    expect(res.statusCode).toBe(401)
  })

  it('lets a request with a valid session reach the handler', async () => {
    const app = buildProtected()
    const token = signSession({ username: 'bob', userId: 'u1', issuedAt: Date.now(), isAdministrator: true }, secret)
    const res = await app.inject({ method: 'GET', url: '/protected', headers: { cookie: `${SESSION_COOKIE}=${token}` } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })

  it('rejects a correctly signed session that does NOT carry the admin flag', async () => {
    // The role is re-asserted from the signed payload rather than assumed because login checked
    // it once. A session minted without the flag is not an admin session.
    const app = buildProtected()
    const token = signSession({ username: 'bob', userId: 'u1', issuedAt: Date.now() } as never, secret)
    const res = await app.inject({ method: 'GET', url: '/protected', headers: { cookie: `${SESSION_COOKIE}=${token}` } })
    expect(res.statusCode).toBe(401)
  })

  it('rejects a session whose admin flag is truthy but not exactly true', async () => {
    const app = buildProtected()
    const token = signSession({ username: 'bob', userId: 'u1', issuedAt: Date.now(), isAdministrator: 'yes' } as never, secret)
    const res = await app.inject({ method: 'GET', url: '/protected', headers: { cookie: `${SESSION_COOKIE}=${token}` } })
    expect(res.statusCode).toBe(401)
  })

  it('issues sessions that carry the admin flag, so the guard admits a real login', async () => {
    const login = await build(admin).inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'bob', password: 'pw' } })
    const cookieHeader = String(login.headers['set-cookie']).split(';')[0]!
    const res = await buildProtected().inject({ method: 'GET', url: '/protected', headers: { cookie: cookieHeader } })
    expect(res.statusCode).toBe(200)
  })
})
