import { loadConfig } from './config/load.js'
import { openDb } from './index/db.js'
import { createLogger, parseLogLevel } from './core/logger.js'
import { createJellyfinClient } from './connectors/jellyfin.js'
import { createQbitClient } from './connectors/qbittorrent.js'
import { createRadarrClient, createSonarrClient } from './connectors/arr.js'
import { createPathMap } from './fs/pathmap.js'
import { createExecutor } from './plan/executor.js'
import type { PlannerDeps } from './plan/planner.js'
import { purgeExpiredTrash, type TrashDeps } from './plan/trash.js'
import { buildServer } from './server.js'
import { createScanRunner } from './scan/runner.js'
import { createScheduler } from './scan/scheduler.js'
import { reconcileInterruptedScans } from './scan/orchestrator.js'
import { join } from 'node:path'

const logger = createLogger({ level: parseLogLevel(process.env.LOG_LEVEL) })
const config = loadConfig(process.env)
const dbPath = join(config.env.dataDir, 'jellymaid.db')
const db = openDb(dbPath)
const jellyfin = createJellyfinClient({
  url: config.env.jellyfin.url,
  apiKey: config.env.jellyfin.apiKey,
  concurrency: config.file.rateLimits.jellyfin.concurrency,
  minDelayMs: config.file.rateLimits.jellyfin.minDelayMs,
})

// One long-lived set of connectors for every plan build and execution this process performs —
// unlike a scan's connectors (see src/scan/worker.ts's buildWorkerDeps), these are never
// per-request and never carry an AbortSignal: a plan build or a delete is not something an
// operator can cancel mid-flight from the UI the way a scan is.
const pathMap = createPathMap(config.file.pathMappings)
const qbittorrent = createQbitClient({
  url: config.env.qbittorrent.url,
  user: config.env.qbittorrent.user,
  pass: config.env.qbittorrent.pass,
  concurrency: config.file.rateLimits.qbittorrent.concurrency,
  minDelayMs: config.file.rateLimits.qbittorrent.minDelayMs,
  privateTrackerHosts: config.file.guards.privateTrackerHosts,
})
// A Sonarr series whose per-series fetch failed must not be silently indistinguishable from a
// complete inventory — see ArrClientOptions.onProblem — so it is routed to the same logger every
// other diagnostic in this process uses.
const onArrProblem = (message: string): void => logger.warn('arr inventory incomplete', { message })
const radarr = config.env.radarr
  ? createRadarrClient({
      ...config.env.radarr,
      concurrency: config.file.rateLimits.arr.concurrency,
      minDelayMs: config.file.rateLimits.arr.minDelayMs,
      onProblem: onArrProblem,
    })
  : null
const sonarr = config.env.sonarr
  ? createSonarrClient({
      ...config.env.sonarr,
      concurrency: config.file.rateLimits.arr.concurrency,
      minDelayMs: config.file.rateLimits.arr.minDelayMs,
      onProblem: onArrProblem,
    })
  : null

// A thunk, not a captured value: buildPlan snapshots the *arr inventory itself for the one build
// it is asked to do (see snapshotInventory), so what this needs to hand over each time is the
// LIVE connectors, not a plan-time snapshot of them.
const plannerDeps = (): PlannerDeps => ({ db, config: config.file, pathMap, qbittorrent, radarr, sonarr })
const trashDeps = (): TrashDeps => ({ db, config: config.file, pathMap })
const executor = createExecutor({ db, config: config.file, pathMap, qbittorrent, radarr, sonarr, jellyfin })

// Before anything else can read the scans table: the scan worker is a thread of THIS process, so
// a row still marked 'running' at startup belongs to a process that is already gone (a container
// restart mid-scan). Nothing else ever reconciles it — the runner's safety net only covers a
// worker dying inside a live process — so it would sit at 'running' forever while isRunning()
// reports false.
const reconciled = reconcileInterruptedScans(db)
if (reconciled > 0) logger.warn('marked interrupted scans as failed at startup', { scans: reconciled })

const scanRunner = createScanRunner({ db, dbPath, env: process.env, logger })
const scheduler = createScheduler({
  cron: config.file.scanCron,
  // No `force`: the scheduled scan goes through the same path-map verification gate as the
  // manual one, and there is deliberately no way for it to bypass it.
  run: async () => {
    const result = scanRunner.start()
    if ('error' in result) logger.warn('scheduled scan skipped', { error: result.error, reason: result.reason })
    else logger.info('scheduled scan started', { scanId: result.scanId })
  },
  isRunning: () => scanRunner.isRunning(),
  onError: (err) => logger.error('scheduled scan tick failed', { err: (err as Error).message }),
})
scheduler.start()

// A separate scheduler, not a step tacked onto the scan: the two run on independent cadences and
// a purge must not wait behind (or block) a scan. `isRunning: () => false` is safe because
// purgeExpiredTrash is entirely synchronous work (better-sqlite3 + sync fs calls) wrapped in an
// async `run` — there is nothing for a second tick to overlap with.
const purgeScheduler = createScheduler({
  cron: '30 4 * * *',
  isRunning: () => false,
  run: async () => {
    const { purged, failed } = purgeExpiredTrash(trashDeps())
    if (purged) logger.info('purged expired trash', { purged })
    // A file that could not be removed keeps its trash row deliberately — the row is the
    // only record that it exists. Say so, or the operator never learns it is stuck.
    if (failed.length) logger.warn('some trash entries could not be purged', { failed })
  },
  onError: (err) => logger.error('scheduled trash purge tick failed', { err: (err as Error).message }),
})
purgeScheduler.start()

const app = buildServer({
  config, db, jellyfin, qbittorrent, radarr, sonarr, logger, scanRunner, plannerDeps, trashDeps, executor, pathMap,
})
app.listen({ port: config.env.port, host: '0.0.0.0' })
  .then(() => logger.info('jellymaid listening', { port: config.env.port }))
  .catch((err) => { logger.error('failed to start', { err: (err as Error).message }); process.exit(1) })
