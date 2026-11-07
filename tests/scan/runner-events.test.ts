import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../src/index/db.js'
import { createScanRunner } from '../../src/scan/runner.js'
import { createActivityLock, type ActivityLock } from '../../src/core/activity.js'
import { createConfigStore, type ConfigStore } from '../../src/config/store.js'
import { loadConfig } from '../../src/config/load.js'
import { writeVerification } from '../../src/scan/verification.js'

/**
 * A Worker whose events the test emits by hand. A real thread decides for itself when 'error',
 * 'exit' and its messages arrive, so the orderings these tests pin — an 'exit' that lands after a
 * new scan has already started, a shutdown racing an 'error' — cannot be produced on demand with
 * one. tests/scan/runner.test.ts covers the same runner against real threads.
 */
const workers = vi.hoisted(() => [] as Array<{ posted: unknown[]; emit: (event: string, ...args: unknown[]) => boolean }>)
vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:worker_threads')>()
  // Imported here, not at the top: this factory is hoisted above every import in the file.
  const { EventEmitter } = await import('node:events')
  class FakeWorker extends EventEmitter {
    posted: unknown[] = []
    constructor() {
      super()
      workers.push(this)
    }
    postMessage(msg: unknown): void { this.posted.push(msg) }
  }
  return { ...actual, Worker: FakeWorker }
})

let db: Db
let dbPath: string
let configStore: ConfigStore
let activity: ActivityLock

beforeEach(() => {
  workers.length = 0
  const dir = mkdtempSync(join(tmpdir(), 'jm-runner-events-'))
  dbPath = join(dir, 'db.sqlite')
  db = openDb(dbPath)
  configStore = createConfigStore(loadConfig({
    DATA_DIR: dir, JELLYFIN_URL: 'http://198.51.100.20:8096', JELLYFIN_API_KEY: 'k',
    QBIT_INSTANCES: 'box-a=http://198.51.100.10:8080',
  }).env)
  writeVerification(db, {
    at: new Date().toISOString(), mappingsHash: configStore.mappingsHash(),
    jellyfin: { sampled: 20, resolved: 20, failures: [] },
    qbit: [{ instanceId: 'box-a', sampled: 0, resolved: 0, failures: [] }],
  })
  activity = createActivityLock()
})

const runnerFor = () => createScanRunner({ db, dbPath, env: {}, activity, configStore })
const statusOf = (scanId: number) => (db.prepare('SELECT status FROM scans WHERE id = ?').get(scanId) as { status: string }).status
const flush = () => new Promise((r) => setImmediate(r))

function started(result: ReturnType<ReturnType<typeof createScanRunner>['start']>): number {
  if (!('scanId' in result)) throw new Error(`expected a scanId, got ${JSON.stringify(result)}`)
  return result.scanId
}

describe('createScanRunner — worker events', () => {
  it("a worker's 'exit' after its 'error' does not finish the scan started in between", async () => {
    // 'error' finishes a crashed scan at once, and the thread's 'exit' follows a moment later.
    // A scan can start in that gap. The late 'exit' belongs to the dead worker: acting on it would
    // drop the live worker, fail the live scan's row and release the live scan's lock — opening the
    // index to a plan while a scan is rewriting it.
    const runner = runnerFor()
    const first = started(runner.start())
    const [dead] = workers
    dead!.emit('error', new Error('boom'))
    expect(statusOf(first)).toBe('failed')
    expect(activity.current()).toBeNull()

    const second = started(runner.start())
    expect(activity.current()).toEqual({ kind: 'scan', id: String(second) })
    dead!.emit('exit', 1)
    dead!.emit('message', { type: 'progress', payload: { phase: 'rules', done: 9, total: 9 } })

    expect(runner.isRunning()).toBe(true)
    expect(runner.status()).toMatchObject({ running: true, scanId: second, phase: null })
    expect(statusOf(second)).toBe('running')
    expect(activity.current()).toEqual({ kind: 'scan', id: String(second) })

    workers[1]!.emit('exit', 0)
    expect(runner.isRunning()).toBe(false)
    expect(activity.current()).toBeNull()
  })

  it('finishes a worker once: its own exit after its error changes nothing further', () => {
    const runner = runnerFor()
    const id = started(runner.start())
    workers[0]!.emit('error', new Error('boom'))
    workers[0]!.emit('exit', 1)
    expect(db.prepare('SELECT status, error FROM scans WHERE id = ?').get(id)).toEqual({ status: 'failed', error: 'boom' })
  })

  it("shutdown waits for the thread's exit even when an 'error' already finished the scan", async () => {
    const runner = runnerFor()
    started(runner.start())
    workers[0]!.emit('error', new Error('boom'))
    expect(runner.isRunning()).toBe(false)

    let resolved = false
    void runner.shutdown().then(() => { resolved = true })
    await flush()
    expect(resolved).toBe(false)
    workers[0]!.emit('exit', 1)
    await flush()
    expect(resolved).toBe(true)
  })

  it('shutdown sends the running worker a cancel and resolves on its exit', async () => {
    const runner = runnerFor()
    started(runner.start())
    let resolved = false
    void runner.shutdown().then(() => { resolved = true })
    expect(workers[0]!.posted).toEqual([{ type: 'cancel' }])
    await flush()
    expect(resolved).toBe(false)
    workers[0]!.emit('exit', 0)
    await flush()
    expect(resolved).toBe(true)
    expect(activity.current()).toBeNull()
  })
})
