import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import type { AppConfig } from './config/schema.js'
import type { Db } from './index/db.js'
import type { JellyfinClient } from './connectors/jellyfin.js'
import type { Logger } from './core/logger.js'
import type { ScanRunner } from './scan/runner.js'
import { createLockout } from './auth/lockout.js'
import { registerAuthRoutes } from './api/auth.js'
import { registerHealthRoutes } from './api/health.js'
import { registerPathMapRoutes } from './api/pathmap.js'
import { registerScanRoutes } from './api/scan.js'

export interface ServerDeps {
  config: AppConfig
  db: Db
  jellyfin: JellyfinClient
  logger: Logger
  scanRunner: ScanRunner
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({
    // A NUMBER, not a boolean: Fastify trusts that many hops from the right, so req.ip is the
    // rightmost-but-N X-Forwarded-For token. `true` would take the leftmost — caller-supplied —
    // token, which would hand the login lockout's key to the attacker.
    trustProxy: deps.config.env.trustProxy,
    bodyLimit: 2 * 1024 * 1024,
    logger: false,
  })
  app.register(cookie)

  registerHealthRoutes(app, { db: deps.db, jellyfin: deps.jellyfin })
  registerAuthRoutes(app, {
    jellyfin: deps.jellyfin,
    sessionSecret: deps.config.env.sessionSecret,
    // Two independent lockout instances with different durations, not one shared duration
    // parameterised per key: the username dimension protects a single credential and can afford
    // a long lock (60 minutes); the IP dimension can catch shared infrastructure rather than
    // only the culprit, so a false-positive lock recovers faster (15 minutes). See
    // isPrivateAddress in src/api/auth.ts for why the IP dimension is skipped altogether behind
    // a misconfigured or absent reverse proxy.
    userLockout: createLockout({ maxFailures: 3, windowMs: 5 * 60_000, lockMs: 60 * 60_000 }),
    ipLockout: createLockout({ maxFailures: 3, windowMs: 5 * 60_000, lockMs: 15 * 60_000 }),
    // Behind any proxy at all, the public edge is assumed to be TLS-terminating.
    secureCookie: deps.config.env.trustProxy > 0,
  })
  registerPathMapRoutes(app, {
    dataDir: deps.config.env.dataDir,
    sessionSecret: deps.config.env.sessionSecret,
    jellyfin: deps.jellyfin,
    db: deps.db,
  })
  registerScanRoutes(app, {
    runner: deps.scanRunner,
    sessionSecret: deps.config.env.sessionSecret,
    db: deps.db,
  })

  app.setErrorHandler((err, _req, reply) => {
    deps.logger.error('unhandled route error', { err: (err as Error).message })
    return reply.code(500).send({ error: 'internal error' })
  })

  return app
}
