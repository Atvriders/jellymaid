import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../src/index/db.js'
import { createScanRunner } from '../../src/scan/runner.js'
import { createScheduler } from '../../src/scan/scheduler.js'
import { createActivityLock, type ActivityLock } from '../../src/core/activity.js'
import { createConfigStore, type ConfigStore } from '../../src/config/store.js'
import { loadConfig } from '../../src/config/load.js'
import { writeVerification } from '../../src/scan/verification.js'

let db: Db
let dbPath: string
let configStore: ConfigStore
let activity: ActivityLock

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'jm-runner-'))
  dbPath = join(dir, 'db.sqlite')
  db = openDb(dbPath)
  configStore = createConfigStore(loadConfig({
    DATA_DIR: dir, JELLYFIN_URL: 'http://198.51.100.20:8096', JELLYFIN_API_KEY: 'k',
    QBIT_INSTANCES: 'box-a=http://198.51.100.10:8080',
  }).env)
  activity = createActivityLock()
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

/**
 * Polls `condition` until it holds or the deadline passes, then returns. Every wait in this file
 * is really "wait until the worker thread has exited and the runner's bookkeeping has caught up",
 * which is a CONDITION, not a duration: a fixed sleep encodes an assumption about how fast a
 * thread spawns and exits, and under parallel-vitest CPU contention that assumption is wrong
 * often enough to make this suite — the one guarding deletion — flake red. On timeout it returns
 * rather than throwing, so the `expect` that follows produces the real, legible failure message.
 */
async function waitFor(condition: () => boolean, timeoutMs = 5000, intervalMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (condition()) return
    if (Date.now() >= deadline) return
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

/** A verification of the CURRENT mapping set, with the given Jellyfin half and a clean box-a half. */
function setVerification(
  report: { sampled: number; resolved: number; failures: Array<{ jellyfinPath: string; reason: string }> },
  over: { mappingsHash?: string; qbit?: Array<{ instanceId: string; sampled: number; resolved: number; failures: [] }> } = {},
) {
  writeVerification(db, {
    at: new Date().toISOString(),
    mappingsHash: over.mappingsHash ?? configStore.mappingsHash(),
    jellyfin: report,
    qbit: over.qbit ?? [{ instanceId: 'box-a', sampled: 0, resolved: 0, failures: [] }],
  })
}

const clean = () => setVerification({ sampled: 20, resolved: 20, failures: [] })

describe('createScanRunner', () => {
  beforeEach(() => { clean() })

  it('refuses to start a second scan while one is already running', () => {
    // Blocks the worker thread synchronously for a fixed window with no timers/handles, so it
    // exits on its own once the window elapses — no message-based cancellation needed for this
    // assertion, which only cares about the window right after the first start() call.
    const workerUrl = fakeWorker(`Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300)`)
    const runner = createScanRunner({ db, dbPath, env: {}, workerUrl, activity, configStore })

    const first = runner.start()
    expect('scanId' in first).toBe(true)
    expect(runner.isRunning()).toBe(true)

    const second = runner.start()
    expect(second).toEqual({ error: 'a scan is already running', reason: 'busy' })

    // Only one row was ever inserted — the refused second start() must not have written its own.
    expect((db.prepare('SELECT COUNT(*) c FROM scans').get() as { c: number }).c).toBe(1)
  })

  it('accepts a new scan once the previous worker has actually exited', async () => {
    const workerUrl = fakeWorker(`Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)`)
    const runner = createScanRunner({ db, dbPath, env: {}, workerUrl, activity, configStore })
    runner.start()
    await waitFor(() => !runner.isRunning())
    expect(runner.isRunning()).toBe(false)
    const second = runner.start()
    expect('scanId' in second).toBe(true)
    // Let the second worker exit before the test ends, so it does not outlive the suite.
    await waitFor(() => !runner.isRunning())
  })

  it('marks the scan row failed — not stuck at running — when the worker dies before it can finish', async () => {
    // Simulates a worker crashing harder than its own try/finally can catch: thrown at the top
    // level of the script, before it ever gets a chance to touch the database.
    const workerUrl = fakeWorker(`throw new Error('boom at startup')`)
    const runner = createScanRunner({ db, dbPath, env: {}, workerUrl, activity, configStore })
    const result = runner.start()
    if (!('scanId' in result)) throw new Error('expected a scanId')

    await waitFor(() => (
      db.prepare('SELECT status FROM scans WHERE id = ?').get(result.scanId) as { status: string } | undefined
    )?.status === 'failed')

    const row = db.prepare('SELECT status FROM scans WHERE id = ?').get(result.scanId) as { status: string }
    expect(row.status).toBe('failed')
    expect(runner.isRunning()).toBe(false)
  })

  it('releases the mutex even when the post-exit bookkeeping throws', async () => {
    // finish() runs inside an EventEmitter callback. A throwing UPDATE must not leave `worker`
    // set (every future scan refused for the life of the process) and must not escape as an
    // uncaught exception from an 'error'/'exit' handler, which would kill the whole server.
    const workerUrl = fakeWorker(`Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)`)
    const exploding = {
      prepare: (sql: string) => {
        if (sql.startsWith('UPDATE scans')) throw new Error('database is locked')
        return db.prepare(sql)
      },
    } as unknown as Db
    const runner = createScanRunner({ db: exploding, dbPath, env: {}, workerUrl, activity, configStore })
    // The gate reads through the same handle, so seed it before swapping in the exploding one.
    expect('scanId' in runner.start()).toBe(true)
    await waitFor(() => !runner.isRunning())
    expect(runner.isRunning()).toBe(false)
    expect('scanId' in runner.start()).toBe(true)
    await waitFor(() => !runner.isRunning())
  })

  it('cancel() returns false when nothing is running', () => {
    const runner = createScanRunner({ db, dbPath, env: {}, workerUrl: fakeWorker(''), activity, configStore })
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
    const runner = createScanRunner({ db, dbPath, env: {}, workerUrl, activity, configStore })
    runner.start()
    expect(runner.cancel()).toBe(true)
    await waitFor(() => !runner.isRunning())
    expect(runner.isRunning()).toBe(false)
  })
})

describe('createScanRunner — path-map verification gate', () => {
  // Spec §11: a scan must not run against an unverified path map. The gate lives here rather
  // than in the HTTP route because the nightly scheduled scan — the default and dominant path —
  // calls start() directly and never touches Fastify.
  const runner = () => createScanRunner({
    db, dbPath, env: {}, workerUrl: fakeWorker(`Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)`),
    activity, configStore,
  })

  it('refuses, and spawns nothing, when verification has never been run', () => {
    const result = runner().start()
    expect(result).toEqual({ error: expect.stringMatching(/verif/i), reason: 'unverified' })
    // A refused start leaves no trace: no scans row, so no half-started scan to reconcile later.
    expect((db.prepare('SELECT COUNT(*) c FROM scans').get() as { c: number }).c).toBe(0)
  })

  it('refuses when the last verification had failures', () => {
    setVerification({ sampled: 20, resolved: 12, failures: [{ jellyfinPath: '/media/x.mkv', reason: 'no mapping' }] })
    expect(runner().start()).toMatchObject({ reason: 'unverified' })
  })

  it('refuses a verification that sampled nothing at all', () => {
    // verifyMappings returns {sampled: 0, resolved: 0, failures: []} when sampleItems() yields
    // nothing. Every other clause reads that as a clean pass. It is not one — nothing was
    // checked — and "couldn't check" must never score as "checked and clean" at this gate.
    setVerification({ sampled: 0, resolved: 0, failures: [] })
    const result = runner().start()
    expect(result).toMatchObject({ reason: 'unverified' })
    expect((result as { error: string }).error).toMatch(/sampled 0/i)
  })

  it('refuses when the mapping set changed since it was verified — the gate reads configStore.mappingsHash()', () => {
    setVerification({ sampled: 20, resolved: 20, failures: [] }, { mappingsHash: '0000000000000000' })
    const result = runner().start()
    expect(result).toMatchObject({ reason: 'unverified' })
    expect((result as { error: string }).error).toMatch(/changed/i)
  })

  it('refuses when a configured instance was never verified — the gate reads configStore.instanceIds()', () => {
    setVerification({ sampled: 20, resolved: 20, failures: [] }, { qbit: [] })
    const result = runner().start()
    expect(result).toMatchObject({ reason: 'unverified' })
    expect((result as { error: string }).error).toMatch(/box-a/)
  })

  it('starts when the last verification was clean', async () => {
    clean()
    // Hoisted out of the expect() so there is a handle to poll for the worker's exit.
    const r = runner()
    expect('scanId' in r.start()).toBe(true)
    await waitFor(() => !r.isRunning())
  })

  it('starts anyway when the operator explicitly forces it', async () => {
    setVerification({ sampled: 20, resolved: 0, failures: [{ jellyfinPath: '/x', reason: 'nope' }] })
    const r = runner()
    expect('scanId' in r.start({ force: true })).toBe(true)
    await waitFor(() => !r.isRunning())
  })

  it('gates the scheduled path too — a scheduler tick with a failing verification runs no scan', async () => {
    // The nightly scan is the dominant path and gets NO bypass: createScheduler calls
    // runner.start() with no options, so `force` is not something it can even express.
    setVerification({ sampled: 20, resolved: 1, failures: [{ jellyfinPath: '/x', reason: 'nope' }] })
    const r = runner()
    const skipped: string[] = []
    const scheduler = createScheduler({
      cron: '* * * * *',
      isRunning: () => r.isRunning(),
      now: () => new Date('2026-07-26T03:00:01Z'),
      run: async () => {
        const result = r.start()
        if ('error' in result) skipped.push(result.error)
      },
    })
    expect(await scheduler.tick()).toBe('ran')
    expect(skipped).toHaveLength(1)
    expect(skipped[0]).toMatch(/verif/i)
    expect(r.isRunning()).toBe(false)
    expect((db.prepare('SELECT COUNT(*) c FROM scans').get() as { c: number }).c).toBe(0)
  })
})

describe('createScanRunner — gate inputs', () => {
  it('runner gate uses configStore.mappingsHash() and instanceIds()', async () => {
    // Read on every start, never captured at construction: mappings are edited live and the gate
    // must judge the set configured NOW.
    let hash = 'aaaaaaaaaaaaaaaa'
    let ids = ['box-a']
    const store = { mappingsHash: () => hash, instanceIds: () => ids } as unknown as ConfigStore
    writeVerification(db, {
      at: new Date().toISOString(), mappingsHash: 'aaaaaaaaaaaaaaaa',
      jellyfin: { sampled: 20, resolved: 20, failures: [] },
      qbit: [{ instanceId: 'box-a', sampled: 5, resolved: 5, failures: [] }],
    })
    const runner = createScanRunner({
      db, dbPath, env: {}, workerUrl: fakeWorker(`Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)`),
      activity, configStore: store,
    })

    hash = 'bbbbbbbbbbbbbbbb'
    expect(runner.start()).toEqual({ error: expect.stringMatching(/changed/i), reason: 'unverified' })

    hash = 'aaaaaaaaaaaaaaaa'
    ids = ['box-a', 'box-b']
    expect(runner.start()).toEqual({ error: expect.stringMatching(/box-b/), reason: 'unverified' })

    ids = ['box-a']
    expect('scanId' in runner.start()).toBe(true)
    await waitFor(() => !runner.isRunning())
  })
})

describe('createScanRunner — activity lock', () => {
  beforeEach(() => { clean() })

  const scanCount = () => (db.prepare('SELECT COUNT(*) c FROM scans').get() as { c: number }).c

  it('runner refuses to start while the ActivityLock is held by a plan and releases it when the worker exits (also on crash)', async () => {
    expect(activity.tryAcquire('plan', 'plan-1')).toEqual({ ok: true })
    const runner = createScanRunner({
      db, dbPath, env: {}, workerUrl: fakeWorker(`Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)`),
      activity, configStore,
    })
    // Refused, naming the holder — and with no trace: no row, no worker, the plan's lock intact.
    expect(runner.start()).toEqual({ error: expect.stringMatching(/plan-1/), reason: 'busy' })
    // `force` is the operator's way past an unverified path map, never past a running plan.
    expect(runner.start({ force: true })).toMatchObject({ reason: 'busy' })
    expect(scanCount()).toBe(0)
    expect(runner.isRunning()).toBe(false)
    expect(activity.current()).toEqual({ kind: 'plan', id: 'plan-1' })

    activity.release('plan', 'plan-1')
    const started = runner.start()
    if (!('scanId' in started)) throw new Error(`expected a scanId, got ${JSON.stringify(started)}`)
    // Held by this scan, under its id, for as long as its worker lives: a plan is refused meanwhile.
    expect(activity.current()).toEqual({ kind: 'scan', id: String(started.scanId) })
    expect(activity.tryAcquire('plan', 'plan-2')).toEqual({ ok: false, heldBy: { kind: 'scan', id: String(started.scanId) } })
    await waitFor(() => activity.current() === null)
    expect(activity.current()).toBeNull()
    expect(runner.isRunning()).toBe(false)

    // A worker that crashes outright releases it too.
    const crashing = createScanRunner({
      db, dbPath, env: {}, workerUrl: fakeWorker(`throw new Error('boom at startup')`), activity, configStore,
    })
    const crashed = crashing.start()
    if (!('scanId' in crashed)) throw new Error('expected a scanId')
    expect(activity.current()).toEqual({ kind: 'scan', id: String(crashed.scanId) })
    await waitFor(() => activity.current() === null)
    expect(activity.current()).toBeNull()
    expect(activity.tryAcquire('plan', 'plan-3')).toEqual({ ok: true })
  })

  it('refuses a resume while a plan holds the lock, leaving the resumed row as it was', () => {
    const id = Number(db.prepare("INSERT INTO scans (started_at, status, phase) VALUES ('t', 'cancelled', 'qbittorrent')").run().lastInsertRowid)
    activity.tryAcquire('plan', 'plan-1')
    const runner = createScanRunner({ db, dbPath, env: {}, workerUrl: fakeWorker(''), activity, configStore })
    expect(runner.start({ resumeScanId: id })).toMatchObject({ reason: 'busy' })
    expect(scanCount()).toBe(1)
    expect(db.prepare('SELECT status FROM scans WHERE id = ?').get(id)).toEqual({ status: 'cancelled' })
  })

  it('releases the lock and fails the row when the worker cannot even be spawned', () => {
    // A worker that never exists never exits, so nothing else would ever release the lock — and
    // every plan would be refused as busy until the process restarts.
    const runner = createScanRunner({
      db, dbPath, env: { UNCLONEABLE: (() => {}) as unknown as string }, workerUrl: fakeWorker(''), activity, configStore,
    })
    expect(() => runner.start()).toThrow(/could not be cloned/)
    expect(activity.current()).toBeNull()
    expect(runner.isRunning()).toBe(false)
    expect(db.prepare('SELECT status, error FROM scans').all()).toEqual([
      { status: 'failed', error: expect.stringMatching(/could not be started/) },
    ])
  })
})

describe('createScanRunner — shutdown', () => {
  beforeEach(() => { clean() })

  it('resolves at once when no scan is running', async () => {
    const runner = createScanRunner({ db, dbPath, env: {}, workerUrl: fakeWorker(''), activity, configStore })
    await runner.shutdown()
    expect(runner.isRunning()).toBe(false)
  })

  it('shutdown cancels the running scan and resolves after the worker exits', async () => {
    // Exits only once told to cancel, and only some time after: shutdown resolving at all proves
    // the cancel was sent, and what is true the moment it resolves proves it waited for the exit.
    const workerUrl = fakeWorker(`
      import { parentPort } from 'node:worker_threads'
      const timer = setInterval(() => {}, 1000)
      parentPort?.on('message', (msg) => {
        if (msg && msg.type === 'cancel') setTimeout(() => { clearInterval(timer); process.exit(0) }, 100)
      })
    `)
    const runner = createScanRunner({ db, dbPath, env: {}, workerUrl, activity, configStore })
    const started = runner.start()
    if (!('scanId' in started)) throw new Error('expected a scanId')
    await runner.shutdown()
    expect(runner.isRunning()).toBe(false)
    expect(activity.current()).toBeNull()
    expect((db.prepare('SELECT status FROM scans WHERE id = ?').get(started.scanId) as { status: string }).status)
      .not.toBe('running')

    // The server is going away: no new scan may start behind shutdown's back (the scheduler still
    // ticks until the process exits).
    expect(runner.start()).toEqual({ error: expect.stringMatching(/shutting down/), reason: 'busy' })
    expect((db.prepare('SELECT COUNT(*) c FROM scans').get() as { c: number }).c).toBe(1)
  })
})

// Ruling 18: the worker's clients are fresh every scan, so the login block lives on the main
// thread's long-lived clients, and the runner hands it over when it starts the worker.
describe('createScanRunner — qBittorrent login blocks', () => {
  beforeEach(() => { clean() })

  /** A worker that writes the workerData it was started with to `out`, then exits. */
  function recordingWorker(out: string): URL {
    return fakeWorker(`
      import { workerData } from 'node:worker_threads'
      import { writeFileSync } from 'node:fs'
      writeFileSync(${JSON.stringify(out)}, JSON.stringify(workerData))
    `)
  }

  it('passes the instances whose main-thread client holds a login block to the worker', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'jm-runner-blocked-')), 'workerData.json')
    const runner = createScanRunner({
      db, dbPath, env: {}, workerUrl: recordingWorker(out), activity, configStore,
      qbittorrents: new Map([
        ['box-a', { loginBlocked: () => false }],
        ['box-b', { loginBlocked: () => true }],
      ]),
    })
    expect(runner.start()).toHaveProperty('scanId')
    await waitFor(() => !runner.isRunning())
    expect(JSON.parse(readFileSync(out, 'utf8'))).toMatchObject({ qbitLoginBlocked: ['box-b'] })
  })

  it('asks at every start, so a block that has lapsed since is not handed on', async () => {
    let blocked = true
    const out = join(mkdtempSync(join(tmpdir(), 'jm-runner-blocked-')), 'workerData.json')
    const runner = createScanRunner({
      db, dbPath, env: {}, workerUrl: recordingWorker(out), activity, configStore,
      qbittorrents: new Map([['box-a', { loginBlocked: () => blocked }]]),
    })
    runner.start()
    await waitFor(() => !runner.isRunning())
    expect(JSON.parse(readFileSync(out, 'utf8')).qbitLoginBlocked).toEqual(['box-a'])
    blocked = false
    runner.start()
    await waitFor(() => !runner.isRunning())
    expect(JSON.parse(readFileSync(out, 'utf8')).qbitLoginBlocked).toEqual([])
  })
})
