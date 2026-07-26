// tests/api/auth.test.ts
import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import { registerAuthRoutes } from '../../src/api/auth.js'
import { createLockout } from '../../src/auth/lockout.js'
import { SESSION_COOKIE } from '../../src/auth/session.js'

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
