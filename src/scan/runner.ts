import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import type { Db } from '../index/db.js'
import type { Logger } from '../core/logger.js'
import type { ActivityKind, ActivityLock } from '../core/activity.js'
import type { ConfigStore } from '../config/store.js'
import type { QbitClient } from '../connectors/qbittorrent.js'
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
  /** Cancel the running scan, if any, and resolve once its worker has exited. Every later start() is refused. */
  shutdown(): Promise<void>
}

function heldByReason(heldBy: { kind: ActivityKind; id: string }): string {
  return heldBy.kind === 'plan'
    ? `plan ${heldBy.id} is running; scans and plan runs never overlap, so start the scan once it has finished`
    : `scan ${heldBy.id} is still running`
}

/**
 * Owns the single scan worker. Two scans can never run at once: `start` refuses while one is
 * live, which is also what the scheduler's overlap check relies on. A scan and a plan run can
 * never overlap either: a scan holds the ActivityLock from its start() until its worker is gone,
 * and start() is refused while a plan holds it.
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
  /** Scans and plan runs exclude each other through this lock. */
  activity: ActivityLock
  /** The live mapping set the verification gate is checked against. */
  configStore: ConfigStore
  /**
   * The process's long-lived qBittorrent clients, asked at every start which of them are holding
   * off logging in. The worker builds its own fresh clients, which remember no refusal; without
   * this, a wrong password would cost another failed login every scan and a nightly scan would walk
   * the address into qBittorrent's one-hour ban (Ruling 18). Absent = no instance is held off.
   */
  qbittorrents?: ReadonlyMap<string, Pick<QbitClient, 'loginBlocked'>>
}): ScanRunner {
  let worker: Worker | null = null
  let currentScanId: number | null = null
  let progress: { phase: string | null; done: number; total: number | null } = { phase: null, done: 0, total: null }
  // Settles when the most recently started worker's thread has exited. Kept apart from `worker`,
  // which an 'error' clears while the thread is still on its way out.
  let lastExit: Promise<void> = Promise.resolve()
  let shuttingDown = false

  const workerPath = fileURLToPath(opts.workerUrl ?? new URL('./worker.js', import.meta.url))

  return {
    isRunning: () => worker !== null,

    start(startOpts = {}) {
      if (shuttingDown) return { error: 'the server is shutting down', reason: 'busy' }
      if (worker) return { error: 'a scan is already running', reason: 'busy' }
      if (!startOpts.force) {
        // Checked against the mapping set configured NOW — a verification of any other set, or one
        // that never asked a configured instance, is not a verification of this one.
        const blocker = verificationBlocker(opts.db, {
          mappingsHash: opts.configStore.mappingsHash(),
          instanceIds: opts.configStore.instanceIds(),
        })
        // Checked before the scans row is inserted and before the worker is spawned, so a
        // refused start leaves no trace behind.
        if (blocker) return { error: blocker, reason: 'unverified' }
      }
      const row = opts.db.prepare("INSERT INTO scans (started_at, status) VALUES (?, 'running')")
      const scanId = startOpts.resumeScanId ?? Number(row.run(new Date().toISOString()).lastInsertRowid)
      // The lock is held under the scan's own id, so it is taken once the id exists. A refusal
      // removes the row inserted to learn that id: a refused start leaves no trace, the same as a
      // refusal by the gate above. A resumed row was never inserted here and is left as it was.
      const lock = opts.activity.tryAcquire('scan', String(scanId))
      if (!lock.ok) {
        if (startOpts.resumeScanId === undefined) opts.db.prepare('DELETE FROM scans WHERE id = ?').run(scanId)
        return { error: heldByReason(lock.heldBy), reason: 'busy' }
      }

      let spawned: Worker
      try {
        const qbitLoginBlocked = [...(opts.qbittorrents ?? [])].filter(([, c]) => c.loginBlocked()).map(([id]) => id)
        spawned = new Worker(workerPath, {
          workerData: { dbPath: opts.dbPath, scanId, env: { ...opts.env }, qbitLoginBlocked },
        })
      } catch (err) {
        // A worker that never existed never exits, and its exit is the only other thing that
        // releases the lock: every plan would be refused as busy until the process restarted.
        opts.activity.release('scan', String(scanId))
        try {
          failRunningScan(opts.db, scanId, `the scan worker could not be started: ${(err as Error).message}`)
        } catch (bookkeeping) {
          opts.logger?.error('failed to record a scan worker that could not be started', {
            scanId, err: (bookkeeping as Error).message,
          })
        }
        throw err
      }
      worker = spawned
      currentScanId = scanId
      progress = { phase: null, done: 0, total: null }

      spawned.on('message', (msg: { type: 'progress'; payload: ScanProgress }) => {
        // A finished worker's late messages describe a scan that is over.
        if (worker !== spawned) return
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
       * try/catch below are not optional. The mutex and the lock are released FIRST: a throwing
       * UPDATE (a locked database, a closed handle) would otherwise leave `worker` set forever and
       * refuse every future scan for the life of the process. And an exception escaping an
       * 'error' handler is an uncaught exception — it would take the whole server down over a
       * failed scan's bookkeeping.
       *
       * Bound to THIS worker. A crash emits 'error' and then, a moment later, 'exit'; the first
       * finishes the scan and the second must change nothing. By then `worker` may already be a
       * NEW scan's worker, and finishing that one from here would fail its row and release its
       * lock while it is still rewriting the index.
       */
      const finish = (detail?: string) => {
        if (worker !== spawned) return
        worker = null
        currentScanId = null
        opts.activity.release('scan', String(scanId))
        try {
          failRunningScan(opts.db, scanId, detail ?? 'scan worker exited unexpectedly')
          pruneOldScans(opts.db) // in case the worker never got far enough to run its own
        } catch (err) {
          opts.logger?.error('failed to record the outcome of a scan worker exit', {
            scanId, err: (err as Error).message,
          })
        }
      }
      spawned.on('error', (err) => finish(err.message))
      spawned.on('exit', (code) => finish(code === 0 ? undefined : `worker exited with code ${code}`))
      // 'exit' is the one event every way out of a worker ends in — a clean finish, a cancel, a
      // crash — so this cannot hang on a worker that died some other way first.
      lastExit = new Promise<void>((resolve) => { spawned.once('exit', () => resolve()) })
      return { scanId }
    },

    cancel() {
      if (!worker) return false
      worker.postMessage({ type: 'cancel' })
      return true
    },

    shutdown() {
      // No new scan may start behind this: the scheduler keeps ticking until the process exits.
      shuttingDown = true
      worker?.postMessage({ type: 'cancel' })
      return lastExit
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
