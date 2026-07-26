import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { JellyfinClient } from '../connectors/jellyfin.js'
import type { Lockout } from '../auth/lockout.js'
import { isPrivateAddress } from '../auth/address.js'
import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, signSession, verifySession } from '../auth/session.js'

const loginSchema = z.object({ username: z.string().min(1), password: z.string() })

export interface AuthDeps {
  jellyfin: Pick<JellyfinClient, 'authenticateByName'>
  sessionSecret: string
  /** Locks a USERNAME after repeated failures: 3 in 5 minutes → 60 minutes. */
  userLockout: Lockout
  /**
   * Locks a PUBLIC IP address after repeated failures — shorter than the username lock (3 in 5
   * minutes → 15 minutes), because unlike a username, an address can be shared innocent
   * infrastructure (NAT, a LAN, a proxy) rather than a single attacker, so a false-positive lock
   * should clear faster. Never checked or recorded for a private/loopback address — see
   * isPrivateAddress and its use below.
   */
  ipLockout: Lockout
  secureCookie: boolean
}

/**
 * TWO independent lockout dimensions, checked and recorded separately.
 * A single combined `username+ip` key locks neither half of a real attack: distributed guessing
 * against one account presents a new IP each time and never locks the account, and one IP
 * spraying many usernames never locks the IP. Either dimension being locked refuses the request;
 * a failure counts against both; a success clears both.
 */
const userKey = (username: string) => `user:${username}`
const ipKey = (req: FastifyRequest) => `ip:${req.ip}`

export function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps): void {
  app.post('/api/auth/login', async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'username and password are required' })
    const { username, password } = parsed.data

    // Skip the IP dimension entirely for a private/loopback address. It is either a LAN client
    // (low threat — the username dimension still covers it) or a reverse proxy whose real
    // clients have all collapsed onto one address (TRUST_PROXY unset or too low; see
    // src/config/load.ts). Locking THAT address is a self-inflicted denial of service against
    // every caller behind it, not a defence against any of them.
    const dims: Array<{ lockout: Lockout; key: string }> = [{ lockout: deps.userLockout, key: userKey(username) }]
    if (!isPrivateAddress(req.ip)) dims.push({ lockout: deps.ipLockout, key: ipKey(req) })

    // Serialise attempts for this username. Everything from the check to the record must
    // happen without another request for the same account interleaving, or a burst of
    // concurrent logins all pass the check before any of them records a failure.
    const release = await deps.userLockout.beginAttempt(userKey(username))
    try {
      const locked = dims.map((d) => d.lockout.check(d.key)).filter((l) => l.locked)
      if (locked.length) {
        const retryAfterMs = Math.max(...locked.map((l) => l.retryAfterMs))
        return reply.code(429).send({ error: 'too many failed attempts', retryAfterMs })
      }

      let result: { userId: string; token: string; isAdministrator: boolean }
      try {
        result = await deps.jellyfin.authenticateByName(username, password)
      } catch (err) {
        // ONLY a genuine credential rejection counts against the operator. An unreachable
        // Jellyfin, a malformed response ('bad-response') — or any error we cannot classify —
        // must not consume an attempt, or an outage (or a Jellyfin-side bug) locks the operator
        // out of their own cleanup tool.
        if ((err as { kind?: string }).kind !== 'auth') {
          return reply.code(503).send({ error: 'Jellyfin is unreachable' })
        }
        for (const d of dims) d.lockout.recordFailure(d.key)
        return reply.code(401).send({ error: 'invalid credentials' })
      }

      if (!result.isAdministrator) {
        for (const d of dims) d.lockout.recordFailure(d.key)
        return reply.code(403).send({ error: 'a Jellyfin administrator account is required' })
      }

      for (const d of dims) d.lockout.reset(d.key)
      return sendSession(reply, username, result.userId)
    } finally {
      release()
    }
  })

  function sendSession(reply: FastifyReply, username: string, userId: string) {
    // isAdministrator is recorded in the session, not just checked once at login, so every
    // later route can re-assert it instead of trusting that login must have checked.
    const token = signSession({ username, userId, issuedAt: Date.now(), isAdministrator: true }, deps.sessionSecret)
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true, sameSite: 'lax', secure: deps.secureCookie, path: '/', maxAge: SESSION_MAX_AGE_SECONDS,
    })
    return reply.send({ username, userId })
  }

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return reply.send({ ok: true })
  })

  app.get('/api/auth/me', async (req, reply) => {
    const session = readSession(req, deps.sessionSecret)
    // Same admin re-assertion as requireSession below: a correctly signed session that does not
    // carry the flag must not be treated as authenticated here either, or this route becomes the
    // one place a stale/hand-rolled session cookie is accepted when every mutating route refuses it.
    if (!session || session.isAdministrator !== true) return reply.code(401).send({ error: 'not authenticated' })
    return reply.send({ username: session.username, userId: session.userId })
  })
}

export function readSession(req: FastifyRequest, secret: string) {
  const raw = req.cookies?.[SESSION_COOKIE]
  return raw ? verifySession(raw, secret) : null
}

/** preHandler used by every mutating route in later plans. */
export function requireSession(secret: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const session = readSession(req, secret)
    // Re-assert the role from the signed payload rather than trusting that whoever minted this
    // cookie checked it. A session without the flag — an older or hand-rolled one — is refused.
    if (!session || session.isAdministrator !== true) {
      return reply.code(401).send({ error: 'not authenticated' })
    }
    ;(req as FastifyRequest & { session?: unknown }).session = session
    return undefined
  }
}
