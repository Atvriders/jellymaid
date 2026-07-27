import { loadConfig } from './config/load.js'
import { openDb } from './index/db.js'
import { createLogger, parseLogLevel } from './core/logger.js'
import { createJellyfinClient } from './connectors/jellyfin.js'
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

const app = buildServer({ config, db, jellyfin, logger, scanRunner })
app.listen({ port: config.env.port, host: '0.0.0.0' })
  .then(() => logger.info('jellymaid listening', { port: config.env.port }))
  .catch((err) => { logger.error('failed to start', { err: (err as Error).message }); process.exit(1) })
