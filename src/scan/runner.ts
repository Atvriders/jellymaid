import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import type { Db } from '../index/db.js'
import { latestScan, pruneOldScans, type ScanProgress } from './orchestrator.js'

export interface ScanStatus {
  running: boolean
  scanId: number | null
  phase: string | null
  done: number
  total: number | null
  lastScan: ReturnType<typeof latestScan>
}

export interface ScanRunner {
  start(resumeScanId?: number): { scanId: number } | { error: string }
  cancel(): boolean
  status(): ScanStatus
  isRunning(): boolean
}

/**
 * Owns the single scan worker. Two scans can never run at once: `start` refuses while one is
 * live, which is also what the scheduler's overlap check relies on.
 */
export function createScanRunner(opts: {
  db: Db
  dbPath: string
  env: NodeJS.ProcessEnv
  workerUrl?: URL
}): ScanRunner {
  let worker: Worker | null = null
  let currentScanId: number | null = null
  let progress: { phase: string | null; done: number; total: number | null } = { phase: null, done: 0, total: null }

  const workerPath = fileURLToPath(opts.workerUrl ?? new URL('./worker.js', import.meta.url))

  return {
    isRunning: () => worker !== null,

    start(resumeScanId) {
      if (worker) return { error: 'a scan is already running' }
      const row = opts.db.prepare("INSERT INTO scans (started_at, status) VALUES (?, 'running')")
      const scanId = resumeScanId ?? Number(row.run(new Date().toISOString()).lastInsertRowid)
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
       */
      const finish = (detail?: string) => {
        if (currentScanId !== null) {
          opts.db.prepare("UPDATE scans SET status='failed', finished_at=?, error=? WHERE id=? AND status='running'")
            .run(new Date().toISOString(), detail ?? 'scan worker exited unexpectedly', currentScanId)
          pruneOldScans(opts.db) // in case the worker never got far enough to run its own
        }
        worker = null
        currentScanId = null
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
