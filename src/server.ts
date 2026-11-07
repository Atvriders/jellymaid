import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ConfigStore } from './config/store.js'
import type { Db } from './index/db.js'
import type { JellyfinClient } from './connectors/jellyfin.js'
import type { QbitClient } from './connectors/qbittorrent.js'
import type { ArrClient } from './connectors/arr.js'
import type { Logger } from './core/logger.js'
import type { ScanRunner } from './scan/runner.js'
import type { PlannerDeps } from './plan/planner.js'
import type { TrashDeps } from './plan/trash.js'
import type { createExecutor } from './plan/executor.js'
import { createLockout } from './auth/lockout.js'
import { registerAuthRoutes } from './api/auth.js'
import { registerHealthRoutes } from './api/health.js'
import { registerPathMapRoutes } from './api/pathmap.js'
import { registerScanRoutes } from './api/scan.js'
import { registerFindingsRoutes } from './api/findings.js'
import { registerPlanRoutes } from './api/plans.js'
import { registerExplorerRoutes } from './api/explorer.js'
import { registerSettingsRoutes } from './api/settings.js'

export interface ServerDeps {
  /**
   * The environment (secrets, port, proxy hops) and the LIVE config.json behind it. There is
   * deliberately no boot-time copy of the file config here: path mappings and thresholds change at
   * runtime, and every route that needs them asks the store when it runs.
   */
  configStore: ConfigStore
  db: Db
  jellyfin: JellyfinClient
  /**
   * `/healthz` reads these three directly, and the path-map routes read the qBittorrent clients
   * too (Verify and Detect sample their torrent lists; /api/qbit/instances pings them) — the
   * planner and executor reach the same underlying instances through `plannerDeps`/`executor`
   * instead, since they need narrower (`Pick`-restricted) views. They are the SAME long-lived
   * clients everywhere, so a login backoff one of them is serving holds for every caller.
   * Radarr/Sonarr are `null` exactly when the operator never configured that optional instance
   * (src/index.ts); at least one qBittorrent instance is mandatory config, so the map is never
   * empty in production. Radarr/Sonarr also carry `inventory` (beyond plain `ping`) so `/healthz`
   * can surface the `arrUnmappable` count (carry-forward.md:49) from the same read
   * `resolveTarget` uses — see src/api/health.ts.
   */
  qbittorrents: ReadonlyMap<string, Pick<QbitClient, 'ping' | 'torrents'>>
  radarr: Pick<ArrClient, 'ping' | 'inventory'> | null
  sonarr: Pick<ArrClient, 'ping' | 'inventory'> | null
  logger: Logger
  scanRunner: ScanRunner
  /** Thunk, not a value: the planner needs a fresh *arr/qBittorrent view for every build, and a
   * value captured once at server-construction time would go stale for the life of the process. */
  plannerDeps: () => PlannerDeps
  trashDeps: () => TrashDeps
  executor: ReturnType<typeof createExecutor>
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
  const env = deps.configStore.env
  const app = Fastify({
    // A NUMBER, not a boolean: Fastify trusts that many hops from the right, so req.ip is the
    // rightmost-but-N X-Forwarded-For token. `true` would take the leftmost — caller-supplied —
    // token, which would hand the login lockout's key to the attacker.
    trustProxy: env.trustProxy,
    bodyLimit: 2 * 1024 * 1024,
    logger: false,
  })
  app.register(cookie)

  registerHealthRoutes(app, {
    db: deps.db,
    jellyfin: deps.jellyfin,
    qbittorrents: deps.qbittorrents,
    radarr: deps.radarr,
    sonarr: deps.sonarr,
    configStore: deps.configStore,
  })
  registerAuthRoutes(app, {
    jellyfin: deps.jellyfin,
    sessionSecret: env.sessionSecret,
    // Two independent lockout instances with different durations, not one shared duration
    // parameterised per key: the username dimension protects a single credential and can afford
    // a long lock (60 minutes); the IP dimension can catch shared infrastructure rather than
    // only the culprit, so a false-positive lock recovers faster (15 minutes). See
    // isPrivateAddress in src/api/auth.ts for why the IP dimension is skipped altogether behind
    // a misconfigured or absent reverse proxy.
    userLockout: createLockout({ maxFailures: 3, windowMs: 5 * 60_000, lockMs: 60 * 60_000 }),
    ipLockout: createLockout({ maxFailures: 3, windowMs: 5 * 60_000, lockMs: 15 * 60_000 }),
    // Behind any proxy at all, the public edge is assumed to be TLS-terminating.
    secureCookie: env.trustProxy > 0,
    // The process logger, so a refused login lands where every other diagnostic does.
    logger: deps.logger,
  })
  registerPathMapRoutes(app, {
    configStore: deps.configStore,
    db: deps.db,
    jellyfin: deps.jellyfin,
    qbittorrents: deps.qbittorrents,
    sessionSecret: env.sessionSecret,
  })
  // No `db` here: the path-map verification gate lives in the runner (src/scan/verification.ts),
  // so the scheduled scan is covered by it too. This route only maps its refusal to a 412.
  registerScanRoutes(app, {
    runner: deps.scanRunner,
    sessionSecret: env.sessionSecret,
  })
  // The live store: which box a duplicate sits on, and whether its torrent has met the current
  // thresholds, are read with the config in force when the page loads.
  registerFindingsRoutes(app, { db: deps.db, sessionSecret: env.sessionSecret, configStore: deps.configStore })
  // The same live path map the planner and executor read, so the Explorer's containment check is
  // the identical `isWithinRoot` every destructive path trusts.
  registerExplorerRoutes(app, { db: deps.db, sessionSecret: env.sessionSecret, configStore: deps.configStore })
  // Thresholds, the keeper policy and the private-tracker list, edited through the same store every
  // reader asks — so a saved change reaches the next plan build and torrent read without a restart.
  registerSettingsRoutes(app, { configStore: deps.configStore, sessionSecret: env.sessionSecret })
  registerPlanRoutes(app, {
    db: deps.db,
    sessionSecret: env.sessionSecret,
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
