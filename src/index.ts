import { loadConfig } from './config/load.js'
import { openDb } from './index/db.js'
import { createLogger } from './core/logger.js'
import { createJellyfinClient } from './connectors/jellyfin.js'
import { buildServer } from './server.js'
import { join } from 'node:path'

const logger = createLogger({ level: (process.env.LOG_LEVEL as 'info') ?? 'info' })
const config = loadConfig(process.env)
const db = openDb(join(config.env.dataDir, 'jellymaid.db'))
const jellyfin = createJellyfinClient({
  url: config.env.jellyfin.url,
  apiKey: config.env.jellyfin.apiKey,
  concurrency: config.file.rateLimits.jellyfin.concurrency,
  minDelayMs: config.file.rateLimits.jellyfin.minDelayMs,
})

const app = buildServer({ config, db, jellyfin, logger })
app.listen({ port: config.env.port, host: '0.0.0.0' })
  .then(() => logger.info('jellymaid listening', { port: config.env.port }))
  .catch((err) => { logger.error('failed to start', { err: (err as Error).message }); process.exit(1) })
