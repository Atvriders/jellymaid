import { loadConfig } from './config/load.js'
import { createConfigStore } from './config/store.js'
import { openDb } from './index/db.js'
import { createLogger, parseLogLevel } from './core/logger.js'
import { createActivityLock } from './core/activity.js'
import { createJellyfinClient } from './connectors/jellyfin.js'
import { createQbitClients } from './connectors/qbittorrent.js'
import { createRadarrClient, createSonarrClient } from './connectors/arr.js'
import { createExecutor } from './plan/executor.js'
import type { PlannerDeps } from './plan/planner.js'
import { purgeExpiredTrash, type TrashDeps } from './plan/trash.js'
import { buildServer } from './server.js'
import { createScanRunner } from './scan/runner.js'
import { createScheduler } from './scan/scheduler.js'
import { reconcileInterruptedScans } from './scan/orchestrator.js'
import { createShutdown } from './shutdown.js'
import { join } from 'node:path'

const logger = createLogger({ level: parseLogLevel(process.env.LOG_LEVEL) })
// Loaded once at boot so a broken environment or config.json refuses to start with every problem
// listed. From here on, anything that acts on config.json asks the store, which re-reads it when
// it changes: path mappings and thresholds are edited at runtime and take effect without a restart.
const config = loadConfig(process.env)
const configStore = createConfigStore(config.env)
const dbPath = join(config.env.dataDir, 'jellymaid.db')
const db = openDb(dbPath)
// Scans and plan runs exclude each other: a scan rewrites the index a plan resolves against.
const activity = createActivityLock()
const jellyfin = createJellyfinClient({
  url: config.env.jellyfin.url,
  apiKey: config.env.jellyfin.apiKey,
  concurrency: config.file.rateLimits.jellyfin.concurrency,
  minDelayMs: config.file.rateLimits.jellyfin.minDelayMs,
})

// One long-lived set of connectors for every plan build and execution this process performs —
// unlike a scan's connectors (see src/scan/worker.ts's buildWorkerDeps), these are never
// per-request and never carry an AbortSignal: a plan build or a delete is not something an
// operator can cancel mid-flight from the UI the way a scan is. One qBittorrent client per
// configured instance, each with its own session and rate-limit gate.
//
// The private-tracker list is a getter, not the boot-time value: Settings edits it at runtime, and
// these clients live as long as the process. A captured array would keep classifying torrents
// against the list as it stood at boot — a host added in Settings would never make its torrents
// private here, and the ratio guard would stay off for exactly the torrents it was added to protect.
const qbittorrents = createQbitClients(config.env.qbittorrents, {
  concurrency: config.file.rateLimits.qbittorrent.concurrency,
  minDelayMs: config.file.rateLimits.qbittorrent.minDelayMs,
  privateTrackerHosts: () => configStore.file().guards.privateTrackerHosts,
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

// A thunk, not a captured value: buildPlan snapshots the *arr inventory and the live config
// itself for the one build it is asked to do (see snapshotInventory, PlannerDeps), so what this
// needs to hand over each time is the LIVE connectors and store, not a plan-time snapshot of them.
const plannerDeps = (): PlannerDeps => ({ db, configStore, qbittorrents, radarr, sonarr, activity })
const trashDeps = (): TrashDeps => ({ db, config: configStore.file(), pathMap: configStore.pathMap() })
const executor = createExecutor({ db, configStore, qbittorrents, radarr, sonarr, jellyfin, activity })

// Before anything else can read the scans table: the scan worker is a thread of THIS process, so
// a row still marked 'running' at startup belongs to a process that is already gone (a container
// restart mid-scan). Nothing else ever reconciles it — the runner's safety net only covers a
// worker dying inside a live process — so it would sit at 'running' forever while isRunning()
// reports false.
const reconciled = reconcileInterruptedScans(db)
if (reconciled > 0) logger.warn('marked interrupted scans as failed at startup', { scans: reconciled })

const scanRunner = createScanRunner({ db, dbPath, env: process.env, logger, activity, configStore, qbittorrents })
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
  configStore, db, jellyfin, qbittorrents, radarr, sonarr, logger, scanRunner, plannerDeps, trashDeps, executor,
})

// `docker stop` sends SIGTERM, then SIGKILLs after its grace period. Without a handler the process
// dies at once — mid-action for a running plan, with the database still open under it. See
// createShutdown for the order and why it matters; it runs once however many signals arrive.
const shutdown = createShutdown({
  app, scanRunner, executor, db, schedulers: [scheduler, purgeScheduler], logger,
  exit: (code) => process.exit(code),
})
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { void shutdown(signal) })

app.listen({ port: config.env.port, host: '0.0.0.0' })
  .then(() => logger.info('jellymaid listening', { port: config.env.port }))
  .catch((err) => { logger.error('failed to start', { err: (err as Error).message }); process.exit(1) })
