import { parentPort, workerData } from 'node:worker_threads'
import { openDb, type Db } from '../index/db.js'
import { loadConfig } from '../config/load.js'
import type { AppConfig } from '../config/schema.js'
import { createPathMap } from '../fs/pathmap.js'
import { createHasher } from '../fs/hasher.js'
import { createJellyfinClient } from '../connectors/jellyfin.js'
import { createQbitClient } from '../connectors/qbittorrent.js'
import { createRadarrClient, createSonarrClient } from '../connectors/arr.js'
import { runScan, pruneOldScans } from './orchestrator.js'
import { createLogger, parseLogLevel, type Logger } from '../core/logger.js'
import type { Phase, ScanDeps } from './phases/types.js'

export interface WorkerInput { dbPath: string; scanId: number; env: NodeJS.ProcessEnv }

export type WorkerMessage =
  | { type: 'progress'; payload: { phase: string; done: number; total: number | null } }
  | { type: 'done'; payload: unknown }
  | { type: 'error'; payload: string }

/**
 * Builds the real scan connectors, all sharing ONE AbortController signal for the scan's whole
 * lifetime. Cancelling the scan interrupts whichever request each connector currently has in
 * flight — without this, cancelling would still wait out however many retries a slow or dead
 * service has left (up to ~2 minutes; see the retry/backoff logic in src/connectors/http.ts).
 *
 * `fetchImpl` is a test-only seam (mirrors every connector's own option of the same name) so this
 * can be exercised without real network calls; production leaves it undefined and each connector
 * falls back to the global fetch.
 */
export function buildWorkerDeps(
  db: Db,
  config: AppConfig,
  signal: AbortSignal,
  logger: Logger,
  fetchImpl?: typeof fetch,
): ScanDeps {
  // A Sonarr series whose per-series fetch failed is skipped rather than aborting the whole
  // walk (see src/connectors/arr.ts) — but a silently incomplete *arr inventory means a file can
  // be deleted without ever being unmonitored, and the *arr promptly re-downloads it. Routed
  // through the worker's own logger so it surfaces wherever the rest of the scan's diagnostics do.
  const onProblem = (message: string): void => logger.warn('arr inventory incomplete', { message })

  return {
    config: config.file,
    pathMap: createPathMap(config.file.pathMappings),
    hasher: createHasher(db),
    jellyfin: createJellyfinClient({
      url: config.env.jellyfin.url, apiKey: config.env.jellyfin.apiKey,
      concurrency: config.file.rateLimits.jellyfin.concurrency,
      minDelayMs: config.file.rateLimits.jellyfin.minDelayMs,
      signal, fetchImpl,
    }),
    qbittorrent: createQbitClient({
      url: config.env.qbittorrent.url, user: config.env.qbittorrent.user, pass: config.env.qbittorrent.pass,
      concurrency: config.file.rateLimits.qbittorrent.concurrency,
      minDelayMs: config.file.rateLimits.qbittorrent.minDelayMs,
      privateTrackerHosts: config.file.guards.privateTrackerHosts,
      signal, fetchImpl,
    }),
    radarr: config.env.radarr
      ? createRadarrClient({
          ...config.env.radarr, concurrency: config.file.rateLimits.arr.concurrency,
          minDelayMs: config.file.rateLimits.arr.minDelayMs, signal, fetchImpl, onProblem,
        })
      : null,
    sonarr: config.env.sonarr
      ? createSonarrClient({
          ...config.env.sonarr, concurrency: config.file.rateLimits.arr.concurrency,
          minDelayMs: config.file.rateLimits.arr.minDelayMs, signal, fetchImpl, onProblem,
        })
      : null,
  }
}

/**
 * Runs one scan to completion and always leaves the `scans` row in a terminal state — never
 * stuck at `running` — even if something throws before `runScan` gets a chance to do its own
 * bookkeeping. `buildDeps` is a thunk rather than an already-built `ScanDeps` precisely so a
 * failure while constructing the connectors (a malformed config, say) is caught here too, not
 * only failures inside `runScan` itself.
 */
export async function runWorkerScan(opts: {
  db: Db
  scanId: number
  signal: AbortSignal
  buildDeps: () => ScanDeps
  phases?: Phase[]
  post: (msg: WorkerMessage) => void
}): Promise<void> {
  try {
    const deps = opts.buildDeps()
    const summary = await runScan({
      db: opts.db, deps, signal: opts.signal, scanId: opts.scanId, phases: opts.phases,
      onProgress: (payload) => opts.post({ type: 'progress', payload }),
    })
    opts.post({ type: 'done', payload: summary })
  } catch (err) {
    const message = (err as Error).message
    opts.post({ type: 'error', payload: message })
    // `runScan` already marks the row failed/cancelled/completed on every path it controls; this
    // only fires for a throw from `buildDeps()`, before runScan ever sees the row. The
    // `AND status='running'` guard makes this a no-op — never a stomp — on any row runScan
    // already finalised.
    opts.db.prepare("UPDATE scans SET status='failed', finished_at=?, error=? WHERE id=? AND status='running'")
      .run(new Date().toISOString(), message, opts.scanId)
  } finally {
    // Retention has exactly one owner — the worker, once a scan has actually finished, any
    // outcome. See pruneOldScans's doc comment in src/scan/orchestrator.ts.
    pruneOldScans(opts.db)
    opts.db.close()
  }
}

/** Narrows workerData to our own shape, rather than a bare truthiness check. Vitest's own
 * worker/fork pool machinery can populate `workerData` with ITS OWN unrelated payload when this
 * module is merely imported by a test (e.g. tinypool sets it to a private array under the
 * 'threads' pool) — a plain `if (workerData)` would misfire and try to boot a scan using that
 * payload. Importing this module must never have a side effect beyond defining these exports. */
function isWorkerInput(value: unknown): value is WorkerInput {
  return typeof value === 'object' && value !== null
    && typeof (value as WorkerInput).dbPath === 'string'
    && typeof (value as WorkerInput).scanId === 'number'
    && typeof (value as WorkerInput).env === 'object'
}

if (isWorkerInput(workerData)) {
  const input = workerData
  const controller = new AbortController()
  parentPort?.on('message', (msg: { type: string }) => { if (msg.type === 'cancel') controller.abort() })
  // A registered listener on parentPort (a MessagePort) is itself a handle that keeps this
  // thread's event loop alive — Node will NOT let the thread exit on its own once the scan
  // finishes and every other handle (fetch, timers, the db) is gone, because the port could
  // still receive a message. unref() opts out of that: the listener still fires for any message
  // that DOES arrive while the scan is running (there is plenty of other ref'd work keeping the
  // loop alive then), but once runWorkerScan settles and closes the db, this stops being the
  // one thing standing between the thread and a normal exit. Without this, runner.ts's
  // `worker.on('exit', …)` would never fire after the FIRST scan, and isRunning() would report
  // true forever — the mutex would permanently refuse every scan after it.
  parentPort?.unref()
  const db = openDb(input.dbPath)
  const logger = createLogger({ level: parseLogLevel(input.env.LOG_LEVEL) })
  void runWorkerScan({
    db, scanId: input.scanId, signal: controller.signal,
    buildDeps: () => buildWorkerDeps(db, loadConfig(input.env), controller.signal, logger),
    post: (msg) => parentPort?.postMessage(msg),
  })
}
