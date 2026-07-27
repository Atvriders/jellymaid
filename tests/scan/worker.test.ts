import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../src/index/db.js'
import { runWorkerScan, buildWorkerDeps, type WorkerMessage } from '../../src/scan/worker.js'
import { fileConfigSchema } from '../../src/config/schema.js'
import { createPathMap } from '../../src/fs/pathmap.js'
import { loadConfig } from '../../src/config/load.js'
import { createLogger } from '../../src/core/logger.js'
import { ConnectorError } from '../../src/connectors/http.js'
import type { Phase } from '../../src/scan/phases/types.js'

let dbPath: string
let db: Db

beforeEach(() => {
  dbPath = join(mkdtempSync(join(tmpdir(), 'jm-worker-')), 'db.sqlite')
  db = openDb(dbPath)
})

function fakeDeps() {
  return {
    config: fileConfigSchema.parse({}), pathMap: createPathMap([]),
    jellyfin: null, qbittorrent: null, radarr: null, sonarr: null, hasher: null,
  }
}

function insertRunningScan(): number {
  const row = db.prepare("INSERT INTO scans (started_at, status) VALUES (?, 'running')").run(new Date().toISOString())
  return Number(row.lastInsertRowid)
}

describe('runWorkerScan', () => {
  it('prunes old scans after the run finishes, leaving at most two rows — nothing else owns retention', async () => {
    for (let i = 0; i < 3; i += 1) {
      db.prepare("INSERT INTO scans (started_at, finished_at, status) VALUES (?, ?, 'completed')")
        .run(new Date().toISOString(), new Date().toISOString())
    }
    const scanId = insertRunningScan()
    const posted: WorkerMessage[] = []
    await runWorkerScan({
      db, scanId, signal: new AbortController().signal, buildDeps: () => fakeDeps() as never,
      phases: [], post: (m) => posted.push(m),
    })

    const verify = openDb(dbPath)
    expect((verify.prepare('SELECT COUNT(*) c FROM scans').get() as { c: number }).c).toBe(2)
    verify.close()
    expect(posted.some((m) => m.type === 'done')).toBe(true)
  })

  it('closes its own database handle once the scan finishes', async () => {
    const scanId = insertRunningScan()
    await runWorkerScan({
      db, scanId, signal: new AbortController().signal, buildDeps: () => fakeDeps() as never,
      phases: [], post: () => {},
    })
    expect(db.open).toBe(false)
  })

  it('forwards progress and completion messages from the underlying scan', async () => {
    const scanId = insertRunningScan()
    const posted: WorkerMessage[] = []
    const phase: Phase = { name: 'jellyfin', run: async (ctx) => { ctx.progress(1, 2); return { status: 'completed', counts: {} } } }
    await runWorkerScan({
      db, scanId, signal: new AbortController().signal, buildDeps: () => fakeDeps() as never,
      phases: [phase], post: (m) => posted.push(m),
    })
    expect(posted).toContainEqual({ type: 'progress', payload: { phase: 'jellyfin', done: 1, total: 2 } })
    expect(posted.some((m) => m.type === 'done')).toBe(true)
  })

  it('marks the scan row failed — never left stuck at running — when building dependencies throws before runScan starts', async () => {
    // A malformed config or a connector construction error happens BEFORE runScan ever sees the
    // row, so runScan's own status/finished_at bookkeeping never runs for it. This is the
    // scenario runScan's own tests cannot cover, since they call it directly with deps already built.
    const scanId = insertRunningScan()
    const posted: WorkerMessage[] = []
    await runWorkerScan({
      db, scanId, signal: new AbortController().signal,
      buildDeps: () => { throw new Error('bad config') },
      post: (m) => posted.push(m),
    })
    const verify = openDb(dbPath)
    const row = verify.prepare('SELECT status, error, finished_at FROM scans WHERE id = ?').get(scanId) as
      { status: string; error: string; finished_at: string | null }
    verify.close()
    expect(row.status).toBe('failed')
    expect(row.error).toContain('bad config')
    expect(row.finished_at).toBeTruthy()
    expect(posted).toContainEqual({ type: 'error', payload: 'bad config' })
  })

  it('still prunes and closes the database when buildDeps throws', async () => {
    for (let i = 0; i < 3; i += 1) {
      db.prepare("INSERT INTO scans (started_at, finished_at, status) VALUES (?, ?, 'completed')")
        .run(new Date().toISOString(), new Date().toISOString())
    }
    const scanId = insertRunningScan()
    await runWorkerScan({
      db, scanId, signal: new AbortController().signal,
      buildDeps: () => { throw new Error('boom') },
      post: () => {},
    })
    expect(db.open).toBe(false)
    const verify = openDb(dbPath)
    expect((verify.prepare('SELECT COUNT(*) c FROM scans').get() as { c: number }).c).toBe(2)
    verify.close()
  })

  it('does not stomp a row runScan already finalised — the safety-net UPDATE only touches still-running rows', async () => {
    const scanId = insertRunningScan()
    await runWorkerScan({
      db, scanId, signal: new AbortController().signal, buildDeps: () => fakeDeps() as never,
      phases: [], post: () => {},
    })

    // Reopen (the call above already closed its own handle) and invoke again against the SAME
    // scan id, simulating some later mistaken re-invocation whose buildDeps throws. If the
    // safety-net UPDATE lacked the `AND status='running'` guard, this would clobber the real
    // 'completed' outcome the first call already recorded.
    const second = openDb(dbPath)
    await runWorkerScan({
      db: second, scanId, signal: new AbortController().signal,
      buildDeps: () => { throw new Error('must never overwrite the already-completed row') },
      post: () => {},
    })

    const verify = openDb(dbPath)
    const finishedRow = verify.prepare('SELECT status, error FROM scans WHERE id = ?').get(scanId) as { status: string; error: string | null }
    verify.close()
    expect(finishedRow.status).toBe('completed')
    expect(finishedRow.error).toBeNull()
  })
})

describe('buildWorkerDeps', () => {
  function config(env: Partial<Record<string, string>> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'jm-worker-cfg-'))
    return loadConfig({
      DATA_DIR: dir,
      JELLYFIN_URL: 'http://jf:8096', JELLYFIN_API_KEY: 'k',
      QBIT_URL: 'http://qb:8080', QBIT_USER: 'u', QBIT_PASS: 'p',
      RADARR_URL: 'http://radarr:7878', RADARR_API_KEY: 'r',
      SONARR_URL: 'http://sonarr:8989', SONARR_API_KEY: 's',
      ...env,
    })
  }

  it('wires the same abort signal into every connector — cancelling the scan must not leave a request to time out on its own', async () => {
    const controller = new AbortController()
    controller.abort()
    let calls = 0
    const fetchImpl = (async () => { calls += 1; return new Response('[]', { status: 200 }) }) as unknown as typeof fetch
    const deps = buildWorkerDeps(db, config(), controller.signal, createLogger({ level: 'error', sink: () => {} }), fetchImpl)

    const results = await Promise.all([
      deps.jellyfin!.ping().catch((e) => e),
      deps.qbittorrent!.ping().catch((e) => e),
      deps.radarr!.ping().catch((e) => e),
      deps.sonarr!.ping().catch((e) => e),
    ])
    for (const err of results) {
      expect(err).toBeInstanceOf(ConnectorError)
      expect((err as ConnectorError).kind).toBe('cancelled')
    }
    expect(calls).toBe(0)
  })

  it('routes a sonarr onProblem report through the worker logger, so a partial *arr inventory is never silent', async () => {
    const warnings: Array<{ msg: string; fields?: Record<string, unknown> }> = []
    const logger = createLogger({ level: 'warn', sink: () => {} })
    const originalWarn = logger.warn.bind(logger)
    logger.warn = (msg, fields) => { warnings.push({ msg, fields }); originalWarn(msg, fields) }

    const fetchImpl = (async (url: string | URL) => {
      const u = String(url)
      if (u.includes('/api/v3/series')) {
        return new Response(JSON.stringify([{ id: 9, title: 'Broken', monitored: true, path: '/tv/Broken' }]), { status: 200 })
      }
      return new Response('boom', { status: 400 }) // episodefile/episode both fail for series 9
    }) as unknown as typeof fetch

    const deps = buildWorkerDeps(db, config(), new AbortController().signal, logger, fetchImpl)
    await deps.sonarr!.inventory()

    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.msg).toMatch(/arr inventory/i)
    expect(warnings[0]!.fields?.message).toContain('9')
  })

  it('leaves radarr/sonarr null when no *arr instance is configured', () => {
    const deps = buildWorkerDeps(db, config({ RADARR_URL: '', RADARR_API_KEY: '', SONARR_URL: '', SONARR_API_KEY: '' }),
      new AbortController().signal, createLogger({ level: 'error', sink: () => {} }))
    expect(deps.radarr).toBeNull()
    expect(deps.sonarr).toBeNull()
  })
})
