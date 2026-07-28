import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AppConfig } from './config/schema.js'
import type { Db } from './index/db.js'
import type { JellyfinClient } from './connectors/jellyfin.js'
import type { QbitClient } from './connectors/qbittorrent.js'
import type { ArrClient } from './connectors/arr.js'
import type { Logger } from './core/logger.js'
import type { ScanRunner } from './scan/runner.js'
import type { PlannerDeps } from './plan/planner.js'
import type { TrashDeps } from './plan/trash.js'
import type { createExecutor } from './plan/executor.js'
import type { PathMap } from './fs/pathmap.js'
import { createLockout } from './auth/lockout.js'
import { registerAuthRoutes } from './api/auth.js'
import { registerHealthRoutes } from './api/health.js'
import { registerPathMapRoutes } from './api/pathmap.js'
import { registerScanRoutes } from './api/scan.js'
import { registerFindingsRoutes } from './api/findings.js'
import { registerPlanRoutes } from './api/plans.js'
import { registerExplorerRoutes } from './api/explorer.js'

export interface ServerDeps {
  config: AppConfig
  db: Db
  jellyfin: JellyfinClient
  /**
   * Only `/healthz` reads these three directly today — the planner and executor reach the same
   * underlying instances through `plannerDeps`/`executor` instead, since they need narrower
   * (`Pick`-restricted) views. Radarr/Sonarr are `null` exactly when the operator never
   * configured that optional instance (src/index.ts); qBittorrent is mandatory config, so it is
   * never null in production, but the type stays as permissive as Radarr/Sonarr's so tests do not
   * need a real client.
   */
  qbittorrent: Pick<QbitClient, 'ping'>
  radarr: Pick<ArrClient, 'ping'> | null
  sonarr: Pick<ArrClient, 'ping'> | null
  logger: Logger
  scanRunner: ScanRunner
  /** Thunk, not a value: the planner needs a fresh *arr/qBittorrent view for every build, and a
   * value captured once at server-construction time would go stale for the life of the process. */
  plannerDeps: () => PlannerDeps
  trashDeps: () => TrashDeps
  executor: ReturnType<typeof createExecutor>
  /** Same long-lived instance the planner and executor use (src/index.ts) — the Explorer's
   * containment check must be the identical `isWithinRoot` every destructive path already trusts,
   * not a second instance built from a possibly-stale copy of the config. */
  pathMap: PathMap
  /**
   * Where the built SPA (`client/dist`) lives. Optional so every existing route test keeps
   * building a server without ever having a client build on disk; defaults to the real build
   * output location so a production run needs nothing extra. Static serving (and the SPA
   * fallback below) is skipped entirely when this directory does not exist, rather than
   * registering `@fastify/static` against a missing root — that would make every 404 an error
   * about a missing directory instead of the API's own 404.
   */
  clientDir?: string
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

  registerHealthRoutes(app, {
    db: deps.db,
    jellyfin: deps.jellyfin,
    qbittorrent: deps.qbittorrent,
    radarr: deps.radarr,
    sonarr: deps.sonarr,
  })
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
  // No `db` here: the path-map verification gate lives in the runner (src/scan/verification.ts),
  // so the scheduled scan is covered by it too. This route only maps its refusal to a 412.
  registerScanRoutes(app, {
    runner: deps.scanRunner,
    sessionSecret: deps.config.env.sessionSecret,
  })
  registerFindingsRoutes(app, { db: deps.db, sessionSecret: deps.config.env.sessionSecret })
  registerExplorerRoutes(app, { db: deps.db, sessionSecret: deps.config.env.sessionSecret, pathMap: deps.pathMap })
  registerPlanRoutes(app, {
    db: deps.db,
    sessionSecret: deps.config.env.sessionSecret,
    plannerDeps: deps.plannerDeps,
    trashDeps: deps.trashDeps,
    executor: deps.executor,
    jellyfin: deps.jellyfin,
  })

  const clientDir = deps.clientDir ?? join(process.cwd(), 'client', 'dist')
  if (existsSync(clientDir)) {
    app.register(fastifyStatic, { root: clientDir, prefix: '/' })
    // SPA fallback — anything that is not an API route serves index.html, so a client-side route
    // like /findings or /plan survives a hard reload. An unknown /api (or /healthz) path must NOT
    // be swallowed by this: it stays a JSON 404, or a caller hitting a typo'd or removed endpoint
    // would get an HTML page back instead of an error it can detect.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/healthz')) {
        return reply.code(404).send({ error: 'not found' })
      }
      return reply.sendFile('index.html')
    })
  }

  app.setErrorHandler((err, _req, reply) => {
    deps.logger.error('unhandled route error', { err: (err as Error).message })
    return reply.code(500).send({ error: 'internal error' })
  })

  return app
}
