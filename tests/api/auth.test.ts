// tests/api/auth.test.ts
import { describe, it, expect, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import { registerAuthRoutes, requireSession } from '../../src/api/auth.js'
import { createLockout, type Lockout } from '../../src/auth/lockout.js'
import { SESSION_COOKIE, signSession } from '../../src/auth/session.js'

type Risk = { allowed: boolean; reason: string | null }
type Authenticate = (u: string, p: string) => Promise<{ userId: string; isAdministrator: boolean }>
interface Warning { msg: string; fields: Record<string, unknown> | undefined }

const ALLOWED: Risk = { allowed: true, reason: null }
const allow = async (): Promise<Risk> => ALLOWED
const authError = () => Object.assign(new Error('bad'), { kind: 'auth', name: 'ConnectorError' })

function build(
  authenticate: Authenticate,
  opts?: {
    userLockout?: Lockout
    ipLockout?: Lockout
    loginRisk?: (username: string) => Promise<Risk>
    /** Receives every warning the route logs; without it they are dropped. */
    warnings?: Warning[]
  },
) {
  const app = Fastify()
  app.register(cookie)
  registerAuthRoutes(app, {
    jellyfin: { authenticateByName: authenticate, loginRisk: opts?.loginRisk ?? allow },
    sessionSecret: 'a-very-long-test-secret',
    userLockout: opts?.userLockout ?? createLockout({ maxFailures: 3, windowMs: 300_000, lockMs: 3_600_000 }),
    ipLockout: opts?.ipLockout ?? createLockout({ maxFailures: 3, windowMs: 300_000, lockMs: 900_000 }),
    secureCookie: false,
    logger: { warn: (msg, fields) => { opts?.warnings?.push({ msg, fields }) } },
  })
  return app
}

const login = (app: FastifyInstance, username: string, password = 'x') =>
  app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } })

const admin: Authenticate = async () => ({ userId: 'u1', isAdministrator: true })

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
    const app = build(async () => ({ userId: 'u2', isAdministrator: false }))
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

  it('does NOT consume an attempt when Jellyfin returns a malformed authentication response', async () => {
    // A missing/empty AccessToken is classified 'bad-response' by the connector (see
    // src/connectors/jellyfin.ts), not 'auth': it is not evidence the credentials were wrong,
    // so — like 'unreachable' above — it must not count against the lockout either.
    const err = Object.assign(new Error('no token'), { kind: 'bad-response', name: 'ConnectorError' })
    const app = build(async () => { throw err })
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

  it('locks the IP after three failures spread across three different usernames, for a PUBLIC address', async () => {
    // 203.0.113.0/24 (TEST-NET-3) is not in any of the private/loopback ranges isPrivateAddress
    // checks, so it is "public" for the purposes of the IP lockout dimension — same convention
    // tests/auth/lockout.test.ts already uses for its documentation-range addresses.
    const app = build(async () => { throw Object.assign(new Error('bad'), { kind: 'auth', name: 'ConnectorError' }) })
    for (const username of ['alice', 'bob', 'carol'] as const) {
      const r = await app.inject({
        method: 'POST', url: '/api/auth/login', remoteAddress: '203.0.113.9',
        payload: { username, password: 'x' },
      })
      expect(r.statusCode).toBe(401)
    }
    // A username the lockout has never seen still must not get a free guess from this IP.
    const res = await app.inject({
      method: 'POST', url: '/api/auth/login', remoteAddress: '203.0.113.9',
      payload: { username: 'dave', password: 'x' },
    })
    expect(res.statusCode).toBe(429)
  })

  it('does NOT lock a different username from a PRIVATE address after three failures there', async () => {
    // 10.0.0.0/8 is private: it is either a LAN client (the username dimension still applies)
    // or a reverse proxy whose real clients have all collapsed onto this address — either way,
    // locking the address itself must not become a remote unauthenticated shutdown of login.
    const app = build(async () => { throw Object.assign(new Error('bad'), { kind: 'auth', name: 'ConnectorError' }) })
    for (const username of ['alice', 'bob', 'carol'] as const) {
      const r = await app.inject({
        method: 'POST', url: '/api/auth/login', remoteAddress: '10.9.9.9',
        payload: { username, password: 'x' },
      })
      expect(r.statusCode).toBe(401)
    }
    const res = await app.inject({
      method: 'POST', url: '/api/auth/login', remoteAddress: '10.9.9.9',
      payload: { username: 'dave', password: 'x' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('the IP dimension unlocks after 15 minutes while the 60-minute username dimension is still held', async () => {
    let t = 0
    const now = () => t
    const app = Fastify()
    app.register(cookie)
    registerAuthRoutes(app, {
      jellyfin: { authenticateByName: async () => { throw Object.assign(new Error('bad'), { kind: 'auth', name: 'ConnectorError' }) }, loginRisk: allow },
      sessionSecret: 'a-very-long-test-secret',
      userLockout: createLockout({ maxFailures: 3, windowMs: 5 * 60_000, lockMs: 60 * 60_000, now }),
      ipLockout: createLockout({ maxFailures: 3, windowMs: 5 * 60_000, lockMs: 15 * 60_000, now }),
      secureCookie: false,
    })
    const PUBLIC_IP = '203.0.113.44'

    // Three failures for 'tick' from PUBLIC_IP lock both dimensions.
    for (let i = 0; i < 3; i += 1) {
      await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: PUBLIC_IP, payload: { username: 'tick', password: 'x' } })
    }
    // IP dimension: a fresh username from the same address is refused.
    expect((await app.inject({
      method: 'POST', url: '/api/auth/login', remoteAddress: PUBLIC_IP, payload: { username: 'fresh1', password: 'x' },
    })).statusCode).toBe(429)
    // Username dimension: the same username from a fresh address is refused too.
    expect((await app.inject({
      method: 'POST', url: '/api/auth/login', remoteAddress: '198.51.100.9', payload: { username: 'tick', password: 'x' },
    })).statusCode).toBe(429)

    t = 15 * 60_000 + 1
    // The IP lock has expired: a fresh username from PUBLIC_IP is now admitted past the IP
    // check — it still fails on invalid credentials (401), but is no longer refused pre-emptively (429).
    expect((await app.inject({
      method: 'POST', url: '/api/auth/login', remoteAddress: PUBLIC_IP, payload: { username: 'fresh2', password: 'x' },
    })).statusCode).toBe(401)
    // The username lock has NOT expired: 'tick' is still refused from any address.
    expect((await app.inject({
      method: 'POST', url: '/api/auth/login', remoteAddress: '198.51.100.10', payload: { username: 'tick', password: 'x' },
    })).statusCode).toBe(429)
  })

  it('a successful login clears both the username and the IP counters', async () => {
    // A PUBLIC address, so the IP dimension is actually in play and this test exercises both
    // counters rather than only the username one.
    let admitted = false
    const app = build(async () => {
      if (admitted) return { userId: 'u1', isAdministrator: true }
      throw Object.assign(new Error('bad'), { kind: 'auth', name: 'ConnectorError' })
    })
    for (let i = 0; i < 2; i += 1) {
      await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '203.0.113.5', payload: { username: 'bob', password: 'x' } })
    }
    admitted = true
    const ok = await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '203.0.113.5', payload: { username: 'bob', password: 'pw' } })
    expect(ok.statusCode).toBe(200)

    admitted = false
    // Both counters were reset, so three more failures are needed before the lock returns.
    for (let i = 0; i < 2; i += 1) {
      const r = await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '203.0.113.5', payload: { username: 'bob', password: 'x' } })
      expect(r.statusCode).toBe(401)
    }
  })

  it('never echoes the password back in any response', async () => {
    const app = build(async () => { throw Object.assign(new Error('nope'), { kind: 'auth', name: 'ConnectorError' }) })
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'bob', password: 'hunter2' } })
    expect(res.body).not.toContain('hunter2')
  })
})

describe('POST /api/auth/login — refusing an attempt that could disable the Jellyfin account', () => {
  const REFUSED: Risk = { allowed: false, reason: '2 failed login(s) recorded against a limit of 3; one more would disable the account' }
  const refuse = async (): Promise<Risk> => REFUSED
  const unavailable = (kind?: string) => async (): Promise<Risk> => {
    throw Object.assign(new Error('boom'), kind ? { kind, name: 'ConnectorError' } : {})
  }
  /** Everything a caller can observe of a response, minus the volatile Date header. */
  const observable = (res: Awaited<ReturnType<typeof login>>) => {
    const { date: _date, ...headers } = res.headers
    return { statusCode: res.statusCode, body: res.body, headers }
  }

  it('asks Jellyfin about the account BEFORE the password is forwarded, passing it the username only', async () => {
    const order: string[] = []
    const app = build(
      async (u) => { order.push(`authenticate:${u}`); return { userId: 'u1', isAdministrator: true } },
      { loginRisk: async (...args) => { order.push(`risk:${args.join(',')}`); return ALLOWED } },
    )
    expect((await login(app, 'bob', 'hunter2')).statusCode).toBe(200)
    expect(order).toEqual(['risk:bob', 'authenticate:bob'])
  })

  it('answers a refused attempt exactly like a wrong password, and Jellyfin never sees the password', async () => {
    let forwarded = 0
    const warnings: Warning[] = []
    const wrong = build(async () => { throw authError() })
    const refused = build(async () => { forwarded += 1; return { userId: 'u1', isAdministrator: true } }, { loginRisk: refuse, warnings })

    const a = await login(wrong, 'bob', 'hunter2')
    const b = await login(refused, 'bob', 'hunter2')

    expect(a.statusCode).toBe(401)
    // Same status, same body, same headers: nothing in the response tells the caller the account is one failure from lockout.
    expect(observable(b)).toEqual(observable(a))
    expect(b.headers['set-cookie']).toBeUndefined()
    expect(b.body).not.toContain('failed login')
    expect(forwarded).toBe(0)

    // The operator is told why, on the server side only, and the password is nowhere in it.
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.msg).toMatch(/refused/i)
    expect(warnings[0]!.fields).toMatchObject({ username: 'bob', reason: REFUSED.reason })
    expect(JSON.stringify(warnings)).not.toContain('hunter2')
  })

  it('counts a refused attempt against the caller exactly like a wrong password', async () => {
    // Three wrong passwords, then the lockout. A refusal that did not count would let a caller probe without limit;
    // one that counted differently would tell them which kind of "no" they got.
    const wrong = build(async () => { throw authError() })
    let riskChecks = 0
    const refused = build(admin, { loginRisk: async () => { riskChecks += 1; return REFUSED } })

    const statuses = async (app: FastifyInstance) => {
      const out: number[] = []
      for (let i = 0; i < 5; i += 1) out.push((await login(app, 'bob')).statusCode)
      return out
    }
    expect(await statuses(wrong)).toEqual([401, 401, 401, 429, 429])
    expect(await statuses(refused)).toEqual([401, 401, 401, 429, 429])
    // Once locked, Jellyfin is not even asked.
    expect(riskChecks).toBe(3)
  })

  it('neither asks Jellyfin about nor forwards a request the lockout has already turned away', async () => {
    let riskChecks = 0
    let authentications = 0
    const app = build(async () => { authentications += 1; throw authError() }, { loginRisk: async () => { riskChecks += 1; return ALLOWED } })
    for (let i = 0; i < 6; i += 1) await login(app, 'bob')
    expect(riskChecks).toBe(3)
    expect(authentications).toBe(3)
  })

  it.each([['unreachable'], ['timeout'], ['bad-response'], ['auth'], ['cancelled'], [undefined]])(
    'treats a loginRisk failure (kind %s) as Jellyfin being unavailable: 503, no password forwarded, no attempt consumed',
    async (kind) => {
      // `auth` here is Jellyfin refusing the SERVICE key, not the caller's credentials: not a wrong password.
      let forwarded = 0
      let risk: (username: string) => Promise<Risk> = unavailable(kind)
      const warnings: Warning[] = []
      const app = build(
        async () => { forwarded += 1; return { userId: 'u1', isAdministrator: true } },
        { loginRisk: (u) => risk(u), warnings },
      )
      for (let i = 0; i < 5; i += 1) {
        const r = await login(app, 'bob', 'hunter2')
        expect(r.statusCode).toBe(503)
        expect(r.json()).toEqual({ error: 'Jellyfin is unreachable' })
      }
      expect(forwarded).toBe(0)
      expect(warnings).toHaveLength(5)
      expect(JSON.stringify(warnings)).not.toContain('hunter2')

      // Five unavailable attempts used up nothing: once Jellyfin answers, the same caller gets in.
      risk = allow
      expect((await login(app, 'bob', 'hunter2')).statusCode).toBe(200)
      expect(forwarded).toBe(1)
    },
  )

  it('never forwards the password when the verdict is not an unambiguous yes', async () => {
    for (const verdict of [{ allowed: false, reason: null }, { reason: null }, { allowed: 'yes', reason: null }]) {
      let forwarded = 0
      const app = build(async () => { forwarded += 1; return { userId: 'u1', isAdministrator: true } }, { loginRisk: async () => verdict as never })
      expect((await login(app, 'bob')).statusCode).toBe(401)
      expect(forwarded).toBe(0)
    }
  })

  it('shares one lockout bucket between spellings of a username that differ only in case', async () => {
    // Jellyfin treats Admin and admin as one account, so each spelling must not get its own three guesses.
    const app = build(async () => { throw authError() })
    for (const name of ['Admin', 'admin', 'ADMIN']) expect((await login(app, name)).statusCode).toBe(401)
    for (const name of ['admin', 'Admin', 'aDMIN']) expect((await login(app, name)).statusCode).toBe(429)
  })

  it('shares the bucket for names that only differ in case beyond ASCII', async () => {
    const app = build(async () => { throw authError() })
    for (const name of ['Zoë', 'zoë', 'ZOË']) expect((await login(app, name)).statusCode).toBe(401)
    expect((await login(app, 'zoË')).statusCode).toBe(429)
  })

  it('keeps different usernames in different buckets', async () => {
    const app = build(async () => { throw authError() })
    for (const name of ['Admin', 'admin', 'ADMIN']) await login(app, name)
    expect((await login(app, 'adm1n')).statusCode).toBe(401)
    expect((await login(app, 'administrator')).statusCode).toBe(401)
  })

  it('a successful login under one spelling clears the failures recorded under another', async () => {
    let admitted = false
    const app = build(async () => {
      if (admitted) return { userId: 'u1', isAdministrator: true }
      throw authError()
    })
    await login(app, 'Admin'); await login(app, 'admin')
    admitted = true
    expect((await login(app, 'ADMIN', 'pw')).statusCode).toBe(200)
    admitted = false
    // Two more failures are again within the allowance (the third would lock), in whichever case.
    expect((await login(app, 'Admin')).statusCode).toBe(401)
    expect((await login(app, 'aDmIn')).statusCode).toBe(401)
  })

  it('keeps the name as typed in the session it issues', async () => {
    const app = build(admin)
    const res = await login(app, 'Admin', 'pw')
    expect(res.json()).toMatchObject({ username: 'Admin' })
  })

  it('cannot be walked past Jellyfin\'s own lockout by a burst, whatever the spelling of the name', async () => {
    // A stand-in for Jellyfin: a counter that disables the account when a failure brings it to the limit.
    // The risk read and the attempt must run as one serialised step per account, or every request of the
    // burst reads the same low count, passes, and together they push the counter over.
    const LIMIT = 3
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))
    let jellyfinCount = 0
    let disabled = false
    const app = build(
      async () => {
        await pause(10)
        jellyfinCount += 1
        if (jellyfinCount >= LIMIT) disabled = true
        throw authError()
      },
      {
        loginRisk: async () => {
          await pause(5)
          return jellyfinCount >= LIMIT - 1 ? REFUSED : ALLOWED
        },
      },
    )
    const spellings = ['Admin', 'admin', 'ADMIN', 'aDmIn']
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => login(app, spellings[i % spellings.length]!)))
    expect(disabled).toBe(false)
    expect(jellyfinCount).toBeLessThan(LIMIT)
    expect(results.every((r) => r.statusCode === 401 || r.statusCode === 429)).toBe(true)
  })

  it('records the refusal on stdout, as a JSON warn line, when no logger is wired in', async () => {
    // src/server.ts predates the logger dependency: a refusal must not vanish just because nobody passed one.
    vi.stubEnv('LOG_LEVEL', 'warn')
    const written: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { written.push(String(chunk)); return true })
    try {
      const app = Fastify()
      app.register(cookie)
      registerAuthRoutes(app, {
        jellyfin: { authenticateByName: admin, loginRisk: refuse },
        sessionSecret: 'a-very-long-test-secret',
        userLockout: createLockout({ maxFailures: 3, windowMs: 300_000, lockMs: 3_600_000 }),
        ipLockout: createLockout({ maxFailures: 3, windowMs: 300_000, lockMs: 900_000 }),
        secureCookie: false,
      })
      expect((await login(app, 'bob', 'hunter2')).statusCode).toBe(401)
    } finally {
      spy.mockRestore()
      vi.unstubAllEnvs()
    }
    const lines = written.flatMap((w) => w.split('\n')).filter((l) => l.startsWith('{')).flatMap((l) => {
      try { return [JSON.parse(l) as { level?: string; msg?: string; username?: string; reason?: string }] } catch { return [] }
    })
    const refusal = lines.find((l) => /refused/i.test(l.msg ?? ''))
    expect(refusal).toMatchObject({ level: 'warn', username: 'bob', reason: REFUSED.reason })
    expect(written.join('')).not.toContain('hunter2')
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

  it('rejects a correctly signed session that does NOT carry the admin flag', async () => {
    // Every requireSession route returns 401 for this; /api/auth/me must not be a hole that
    // admits a non-admin (or hand-rolled) session with a 200.
    const app = build(admin)
    const token = signSession({ username: 'bob', userId: 'u1', issuedAt: Date.now() } as never, 'a-very-long-test-secret')
    const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: `${SESSION_COOKIE}=${token}` } })
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
