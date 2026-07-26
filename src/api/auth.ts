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

    const lock = deps.lockout.check(key)
    if (lock.locked) {
      return reply.code(429).send({ error: 'too many failed attempts', retryAfterMs: lock.retryAfterMs })
    }

    let result: { userId: string; token: string; isAdministrator: boolean }
    try {
      result = await deps.jellyfin.authenticateByName(username, password)
    } catch (err) {
      const kind = (err as { kind?: string }).kind
      // Jellyfin being unreachable is not the operator's fault: no attempt is consumed.
      if (kind && kind !== 'auth') {
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
    const token = signSession({ username, userId: result.userId, issuedAt: Date.now() }, deps.sessionSecret)
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true, sameSite: 'lax', secure: deps.secureCookie, path: '/', maxAge: SESSION_MAX_AGE_SECONDS,
    })
    return reply.send({ username, userId: result.userId })
  })

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
