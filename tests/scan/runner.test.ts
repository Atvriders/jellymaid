import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../src/index/db.js'
import { createScanRunner } from '../../src/scan/runner.js'

let db: Db
let dbPath: string

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'jm-runner-'))
  dbPath = join(dir, 'db.sqlite')
  db = openDb(dbPath)
})

/**
 * Writes a tiny standalone worker script and returns a file:// URL to it, so these tests can
 * stand in for the real src/scan/worker.js and exercise the runner's OWN bookkeeping (the mutex,
 * the crash safety-net) without touching the network or running a real scan.
 */
function fakeWorker(body: string): URL {
  const dir = mkdtempSync(join(tmpdir(), 'jm-runner-worker-'))
  const path = join(dir, 'fake-worker.mjs')
  writeFileSync(path, body)
  return new URL(`file://${path}`)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('createScanRunner', () => {
  it('refuses to start a second scan while one is already running', () => {
    // Blocks the worker thread synchronously for a fixed window with no timers/handles, so it
    // exits on its own once the window elapses — no message-based cancellation needed for this
    // assertion, which only cares about the window right after the first start() call.
    const workerUrl = fakeWorker(`Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300)`)
    const runner = createScanRunner({ db, dbPath, env: {}, workerUrl })

    const first = runner.start()
    expect('scanId' in first).toBe(true)
    expect(runner.isRunning()).toBe(true)

    const second = runner.start()
    expect(second).toEqual({ error: 'a scan is already running' })

    // Only one row was ever inserted — the refused second start() must not have written its own.
    expect((db.prepare('SELECT COUNT(*) c FROM scans').get() as { c: number }).c).toBe(1)
  })

  it('accepts a new scan once the previous worker has actually exited', async () => {
    const workerUrl = fakeWorker(`Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)`)
    const runner = createScanRunner({ db, dbPath, env: {}, workerUrl })
    runner.start()
    await sleep(400)
    expect(runner.isRunning()).toBe(false)
    const second = runner.start()
    expect('scanId' in second).toBe(true)
    await sleep(400)
  })

  it('marks the scan row failed — not stuck at running — when the worker dies before it can finish', async () => {
    // Simulates a worker crashing harder than its own try/finally can catch: thrown at the top
    // level of the script, before it ever gets a chance to touch the database.
    const workerUrl = fakeWorker(`throw new Error('boom at startup')`)
    const runner = createScanRunner({ db, dbPath, env: {}, workerUrl })
    const result = runner.start()
    if (!('scanId' in result)) throw new Error('expected a scanId')

    await sleep(400)

    const row = db.prepare('SELECT status FROM scans WHERE id = ?').get(result.scanId) as { status: string }
    expect(row.status).toBe('failed')
    expect(runner.isRunning()).toBe(false)
  })

  it('cancel() returns false when nothing is running', () => {
    const runner = createScanRunner({ db, dbPath, env: {}, workerUrl: fakeWorker('') })
    expect(runner.cancel()).toBe(false)
  })

  it('cancel() posts a cancel message and reports true while a scan is running', async () => {
    // A non-blocking keepalive (setInterval), not Atomics.wait: a synchronous block would starve
    // the worker's own message loop, so it would never observe the 'cancel' message at all.
    // clearInterval() alone is not enough either — a *registered* listener on parentPort (a
    // MessagePort) is itself a handle that keeps the thread alive on its own (see
    // src/scan/worker.ts's own use of parentPort.unref() for the real fix); process.exit(0)
    // stands in for that here since this fake script's whole point is testing the runner's
    // reaction to the worker actually going away.
    const workerUrl = fakeWorker(`
      import { parentPort } from 'node:worker_threads'
      const timer = setInterval(() => {}, 1000)
      parentPort?.on('message', (msg) => { if (msg && msg.type === 'cancel') { clearInterval(timer); process.exit(0) } })
    `)
    const runner = createScanRunner({ db, dbPath, env: {}, workerUrl })
    runner.start()
    expect(runner.cancel()).toBe(true)
    await sleep(300)
    expect(runner.isRunning()).toBe(false)
  })
})
