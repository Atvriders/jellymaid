import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import type { Db } from '../index/db.js'
import type { Logger } from '../core/logger.js'
import { failRunningScan, latestScan, pruneOldScans, type ScanProgress } from './orchestrator.js'
import { verificationBlocker } from './verification.js'

export interface ScanStatus {
  running: boolean
  scanId: number | null
  phase: string | null
  done: number
  total: number | null
  lastScan: ReturnType<typeof latestScan>
}

export interface ScanStartOptions {
  resumeScanId?: number
  /**
   * Bypasses the path-map verification gate. Only ever set by an operator explicitly forcing a
   * scan from the UI — the scheduler has no way to pass it, by design.
   */
  force?: boolean
}

/** `reason` exists so the HTTP layer can map a refusal to a status code without matching on prose. */
export type ScanStartResult = { scanId: number } | { error: string; reason: 'busy' | 'unverified' }

export interface ScanRunner {
  start(opts?: ScanStartOptions): ScanStartResult
  cancel(): boolean
  status(): ScanStatus
  isRunning(): boolean
}

/**
 * Owns the single scan worker. Two scans can never run at once: `start` refuses while one is
 * live, which is also what the scheduler's overlap check relies on.
 *
 * It also owns the path-map verification gate, because it is the one place EVERY scan goes
 * through — the nightly scheduled scan does not touch the HTTP layer, so a gate that lived in the
 * route would only ever have covered the manual button.
 */
export function createScanRunner(opts: {
  db: Db
  dbPath: string
  env: NodeJS.ProcessEnv
  workerUrl?: URL
  logger?: Logger
}): ScanRunner {
  let worker: Worker | null = null
  let currentScanId: number | null = null
  let progress: { phase: string | null; done: number; total: number | null } = { phase: null, done: 0, total: null }

  const workerPath = fileURLToPath(opts.workerUrl ?? new URL('./worker.js', import.meta.url))

  return {
    isRunning: () => worker !== null,

    start(startOpts = {}) {
      if (worker) return { error: 'a scan is already running', reason: 'busy' }
      if (!startOpts.force) {
        const blocker = verificationBlocker(opts.db)
        // Checked before the scans row is inserted and before the worker is spawned, so a
        // refused start leaves no trace behind.
        if (blocker) return { error: blocker, reason: 'unverified' }
      }
      const row = opts.db.prepare("INSERT INTO scans (started_at, status) VALUES (?, 'running')")
      const scanId = startOpts.resumeScanId ?? Number(row.run(new Date().toISOString()).lastInsertRowid)
      currentScanId = scanId
      progress = { phase: null, done: 0, total: null }

      worker = new Worker(workerPath, {
        workerData: { dbPath: opts.dbPath, scanId, env: { ...opts.env } },
      })
      worker.on('message', (msg: { type: 'progress'; payload: ScanProgress }) => {
        if (msg.type === 'progress') {
          progress = { phase: msg.payload.phase, done: msg.payload.done, total: msg.payload.total }
        }
      })

      /**
       * Defence in depth against a worker that dies harder than its own try/finally can catch —
       * killed, OOM'd, or thrown before it ever attached its own handlers (see
       * isWorkerInput/runWorkerScan in src/scan/worker.ts, which cover every path reachable from
       * inside the worker). On the ordinary path the row is already in a terminal state by the
       * time either event fires, so this UPDATE matches zero rows; the `AND status='running'`
       * guard is what makes it safe to run unconditionally here rather than only "when we think
       * something went wrong".
       *
       * Runs inside an EventEmitter callback ('error'/'exit'), which is why the ordering and the
       * try/catch below are not optional. The mutex is released FIRST: a throwing UPDATE (a
       * locked database, a closed handle) would otherwise leave `worker` set forever and refuse
       * every future scan for the life of the process. And an exception escaping an 'error'
       * handler is an uncaught exception — it would take the whole server down over a failed
       * scan's bookkeeping.
       */
      const finish = (detail?: string) => {
        const finishedScanId = currentScanId
        worker = null
        currentScanId = null
        if (finishedScanId === null) return
        try {
          failRunningScan(opts.db, finishedScanId, detail ?? 'scan worker exited unexpectedly')
          pruneOldScans(opts.db) // in case the worker never got far enough to run its own
        } catch (err) {
          opts.logger?.error('failed to record the outcome of a scan worker exit', {
            scanId: finishedScanId, err: (err as Error).message,
          })
        }
      }
      worker.on('error', (err) => finish(err.message))
      worker.on('exit', (code) => finish(code === 0 ? undefined : `worker exited with code ${code}`))
      return { scanId }
    },

    cancel() {
      if (!worker) return false
      worker.postMessage({ type: 'cancel' })
      return true
    },

    status() {
      return {
        running: worker !== null,
        scanId: currentScanId,
        phase: progress.phase,
        done: progress.done,
        total: progress.total,
        lastScan: latestScan(opts.db),
      }
    },
  }
}
