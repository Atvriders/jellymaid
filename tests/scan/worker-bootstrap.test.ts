import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../../src/index/db.js'

// Kept in its own file, separate from worker.test.ts: mocking node:worker_threads here would
// otherwise also apply to worker.test.ts's ordinary top-level `import { runWorkerScan, ... }
// from '../../src/scan/worker.js'`, which would run the bootstrap block against whatever
// workerData the mock started with, before any test even runs.
const mocks = vi.hoisted(() => ({
  workerData: null as unknown,
  on: vi.fn(),
  postMessage: vi.fn(),
  unref: vi.fn(),
}))

vi.mock('node:worker_threads', () => ({
  get workerData() { return mocks.workerData },
  parentPort: { on: mocks.on, postMessage: mocks.postMessage, unref: mocks.unref },
}))

describe('worker bootstrap', () => {
  // Regression test for a real bug found while implementing this task: a registered listener on
  // parentPort (a MessagePort) is itself a handle that keeps a worker thread's event loop alive.
  // Without unref(), a real `new Worker('.../worker.js', ...)` thread never exits once its scan
  // finishes — verified against the compiled dist/src/scan/worker.js directly: it posted 'done'
  // but sat there indefinitely afterwards. src/scan/runner.ts's mutex depends entirely on the
  // worker's 'exit'/'error' events to clear `isRunning()`; without this fix, every scan after the
  // very first one would be refused with "a scan is already running", forever, until a restart.
  it('unrefs parentPort synchronously at startup, before the scan itself ever runs', async () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'jm-worker-boot-'))
    const dbPath = join(dbDir, 'db.sqlite')
    // Creates+migrates the schema and seeds the row the real runner would have inserted before
    // ever spawning the worker; the bootstrap reopens this same path itself.
    const seed = openDb(dbPath)
    seed.prepare("INSERT INTO scans (id, started_at, status) VALUES (1, ?, 'running')").run(new Date().toISOString())
    seed.close()

    const dataDir = mkdtempSync(join(tmpdir(), 'jm-worker-boot-data-'))
    mocks.workerData = {
      dbPath, scanId: 1,
      env: {
        DATA_DIR: dataDir,
        // Unreachable on purpose: the scan phases fail-skip against these quickly, which is all
        // this test needs (a real outcome that lets runWorkerScan's own finally close the db).
        JELLYFIN_URL: 'http://127.0.0.1:1', JELLYFIN_API_KEY: 'k',
        QBIT_URL: 'http://127.0.0.1:1', QBIT_USER: 'u', QBIT_PASS: 'p',
      },
    }

    vi.resetModules()
    await import('../../src/scan/worker.js')

    // Called synchronously, right after the listener is registered and BEFORE the scan (an async
    // operation against those unreachable dummy services) ever starts — so it must already have
    // happened by the time the dynamic import's own promise resolves.
    expect(mocks.on).toHaveBeenCalledWith('message', expect.any(Function))
    expect(mocks.unref).toHaveBeenCalled()

    // Let the background scan actually finish and close its own db handle, so the test does not
    // leak an open connection into the next one.
    await vi.waitFor(() => {
      const check = openDb(dbPath)
      const row = check.prepare('SELECT status FROM scans WHERE id = 1').get() as { status: string }
      check.close()
      expect(row.status).not.toBe('running')
    }, { timeout: 10_000, interval: 100 })
  })
})
