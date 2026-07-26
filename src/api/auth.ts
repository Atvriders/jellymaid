import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { JellyfinClient } from '../connectors/jellyfin.js'
import type { Lockout } from '../auth/lockout.js'
import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, signSession, verifySession } from '../auth/session.js'

const loginSchema = z.object({ username: z.string().min(1), password: z.string() })

export interface AuthDeps {
  jellyfin: Pick<JellyfinClient, 'authenticateByName'>
  sessionSecret: string
  lockout: Lockout
  secureCookie: boolean
}

function clientKey(req: FastifyRequest, username: string): string {
  return `${username} ${req.ip}`
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps): void {
  app.post('/api/auth/login', async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'username and password are required' })
    const { username, password } = parsed.data
    const key = clientKey(req, username)

    // Serialise attempts for this key. Everything from the check to the record must
    // happen without another request for the same key interleaving, or a burst of
    // concurrent logins all pass the check before any of them records a failure.
    const release = await deps.lockout.beginAttempt(key)
    try {
      const lock = deps.lockout.check(key)
      if (lock.locked) {
        return reply.code(429).send({ error: 'too many failed attempts', retryAfterMs: lock.retryAfterMs })
      }

      let result: { userId: string; token: string; isAdministrator: boolean }
      try {
        result = await deps.jellyfin.authenticateByName(username, password)
      } catch (err) {
        // ONLY a genuine credential rejection counts against the operator. An
        // unreachable Jellyfin — or any error we cannot classify — must not consume
        // an attempt, or an outage locks the operator out of their own cleanup tool.
        if ((err as { kind?: string }).kind !== 'auth') {
          return reply.code(503).send({ error: 'Jellyfin is unreachable' })
        }
        deps.lockout.recordFailure(key)
        return reply.code(401).send({ error: 'invalid credentials' })
      }

      if (!result.isAdministrator) {
        deps.lockout.recordFailure(key)
        return reply.code(403).send({ error: 'a Jellyfin administrator account is required' })
      }

      deps.lockout.reset(key)
      return sendSession(reply, username, result.userId)
    } finally {
      release()
    }
  })

  function sendSession(reply: FastifyReply, username: string, userId: string) {
    const token = signSession({ username, userId, issuedAt: Date.now() }, deps.sessionSecret)
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
    if (!session) return reply.code(401).send({ error: 'not authenticated' })
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
    if (!session) return reply.code(401).send({ error: 'not authenticated' })
    ;(req as FastifyRequest & { session?: unknown }).session = session
    return undefined
  }
}
