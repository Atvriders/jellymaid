import { loadConfig } from './config/load.js'
import { openDb } from './index/db.js'
import { createLogger, parseLogLevel } from './core/logger.js'
import { createJellyfinClient } from './connectors/jellyfin.js'
import { buildServer } from './server.js'
import { createScanRunner } from './scan/runner.js'
import { createScheduler } from './scan/scheduler.js'
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

const scanRunner = createScanRunner({ db, dbPath, env: process.env })
const scheduler = createScheduler({
  cron: config.file.scanCron,
  run: async () => {
    const result = scanRunner.start()
    if ('error' in result) logger.warn('scheduled scan skipped', { error: result.error })
    else logger.info('scheduled scan started', { scanId: result.scanId })
  },
  isRunning: () => scanRunner.isRunning(),
})
scheduler.start()

const app = buildServer({ config, db, jellyfin, logger, scanRunner })
app.listen({ port: config.env.port, host: '0.0.0.0' })
  .then(() => logger.info('jellymaid listening', { port: config.env.port }))
  .catch((err) => { logger.error('failed to start', { err: (err as Error).message }); process.exit(1) })
