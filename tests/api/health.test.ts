import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { buildServer } from '../../src/server.js'
import { registerHealthRoutes } from '../../src/api/health.js'
import { openDb } from '../../src/index/db.js'
import { createLogger } from '../../src/core/logger.js'
import { fileConfigSchema } from '../../src/config/schema.js'
import { createPathMap } from '../../src/fs/pathmap.js'

type Pingable = { ping: () => Promise<void> } | null

/**
 * Builds the same stub ServerDeps every route test in this file needs, with each of the four
 * connectors independently swappable. `null` means "not configured" — the same shape production
 * uses for an omitted optional Radarr/Sonarr instance (src/index.ts).
 */
function depsWith(connectors: { jellyfin: Pingable; qbittorrent: Pingable; radarr: Pingable; sonarr: Pingable }) {
  const dir = mkdtempSync(join(tmpdir(), 'jm-srv-'))
  return {
    config: {
      env: {
        dataDir: dir, port: 0, trustProxy: 0, sessionSecret: 'x'.repeat(32),
        jellyfin: { url: 'http://jf', apiKey: 'k' },
        qbittorrent: { url: 'http://qb', user: 'u', pass: 'p' },
        radarr: null, sonarr: null,
      },
      file: fileConfigSchema.parse({}),
    },
    db: openDb(join(dir, 'db.sqlite')),
    jellyfin: connectors.jellyfin as never,
    qbittorrent: connectors.qbittorrent as never,
    radarr: connectors.radarr as never,
    sonarr: connectors.sonarr as never,
    logger: createLogger({ level: 'error', sink: () => {} }),
    scanRunner: {
      start: () => ({ scanId: 1 }), cancel: () => false, isRunning: () => false,
      status: () => ({ running: false, scanId: null, phase: null, done: 0, total: null, lastScan: null }),
    } as never,
    // Unused by these health-check tests — plans.test.ts covers the plan/execute/trash routes.
    plannerDeps: (() => ({})) as never,
    trashDeps: (() => ({})) as never,
    executor: {} as never,
    pathMap: createPathMap([]),
  }
}

/** Only Jellyfin varies; qBittorrent is "configured and healthy", Radarr/Sonarr are unused. */
const testDeps = (pingImpl: () => Promise<void>) => depsWith({
  jellyfin: { ping: pingImpl },
  qbittorrent: { ping: async () => {} },
  radarr: null,
  sonarr: null,
})

describe('GET /healthz', () => {
  it('reports ok with schema version and a reachable jellyfin', async () => {
    const app = buildServer(testDeps(async () => {}))
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('ok')
    expect(body.schemaVersion).toBeGreaterThan(0)
    expect(body.connectors.jellyfin).toBe('ok')
  })

  it('reports degraded, not failed, when jellyfin is unreachable', async () => {
    const app = buildServer(testDeps(async () => { throw Object.assign(new Error('x'), { kind: 'unreachable' }) }))
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('degraded')
    expect(res.json().connectors.jellyfin).toBe('unreachable')
  })

  it('needs no session — it is a container probe', async () => {
    const app = buildServer(testDeps(async () => {}))
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200)
  })

  it('pings Jellyfin once for repeated probes, so an anonymous caller cannot spend the scan budget', async () => {
    let pings = 0
    const app = buildServer(testDeps(async () => { pings += 1 }))
    const a = await app.inject({ method: 'GET', url: '/healthz' })
    const b = await app.inject({ method: 'GET', url: '/healthz' })
    expect(pings).toBe(1)
    expect(a.json().connectors.jellyfin).toBe('ok')
    expect(b.json().connectors.jellyfin).toBe('ok')
  })

  it('collapses a concurrent burst of probes into a single ping', async () => {
    let pings = 0
    const app = buildServer(testDeps(async () => {
      pings += 1
      await new Promise((r) => setTimeout(r, 20))
    }))
    const results = await Promise.all(Array.from({ length: 25 }, () => app.inject({ method: 'GET', url: '/healthz' })))
    expect(pings).toBe(1)
    expect(results.every((r) => r.statusCode === 200)).toBe(true)
  })

  it('re-pings once the cache TTL has passed, so a real outage still surfaces', async () => {
    let pings = 0
    let t = 0
    const dir = mkdtempSync(join(tmpdir(), 'jm-hc-'))
    const app = Fastify()
    registerHealthRoutes(app, {
      db: openDb(join(dir, 'db.sqlite')),
      jellyfin: { ping: async () => { pings += 1 } },
      qbittorrent: null,
      radarr: null,
      sonarr: null,
      now: () => t,
    })
    await app.inject({ method: 'GET', url: '/healthz' })
    t = 10_000
    await app.inject({ method: 'GET', url: '/healthz' })
    expect(pings).toBe(2)
  })
})

describe('GET /healthz — all connectors', () => {
  it('reports every configured connector', async () => {
    const app = buildServer(depsWith({
      jellyfin: { ping: async () => {} },
      qbittorrent: { ping: async () => {} },
      radarr: { ping: async () => {} },
      sonarr: null,
    }))
    const body = (await app.inject({ method: 'GET', url: '/healthz' })).json()
    expect(body.connectors).toEqual({ jellyfin: 'ok', qbittorrent: 'ok', radarr: 'ok', sonarr: 'not-configured' })
  })

  it('distinguishes not-configured from unreachable', async () => {
    const app = buildServer(depsWith({
      jellyfin: { ping: async () => {} },
      qbittorrent: { ping: async () => { throw Object.assign(new Error('x'), { kind: 'unreachable' }) } },
      radarr: null,
      sonarr: null,
    }))
    const body = (await app.inject({ method: 'GET', url: '/healthz' })).json()
    expect(body.connectors.qbittorrent).toBe('unreachable')
    expect(body.connectors.radarr).toBe('not-configured')
    expect(body.status).toBe('degraded')
  })

  it('an unconfigured optional connector does not make the service degraded', async () => {
    const app = buildServer(depsWith({
      jellyfin: { ping: async () => {} },
      qbittorrent: { ping: async () => {} },
      radarr: null,
      sonarr: null,
    }))
    expect((await app.inject({ method: 'GET', url: '/healthz' })).json().status).toBe('ok')
  })

  it('reports index row counts so an empty index is visible at a glance', async () => {
    const app = buildServer(depsWith({ jellyfin: { ping: async () => {} }, qbittorrent: { ping: async () => {} }, radarr: null, sonarr: null }))
    const body = (await app.inject({ method: 'GET', url: '/healthz' })).json()
    expect(body.indexCounts).toMatchObject({ jellyfinItems: 0, fsEntries: 0, findings: 0 })
  })
})

// Fixwave-2 finding MAJOR 2: commit b47ec6b's Promise.all over four statusOf calls gates the whole
// response on the SLOWEST connector, unbounded — production connectors inherit a 30s HttpClient
// timeout with up to 3 retries, so one hung connector could stall /healthz for ~2 minutes. The
// route's own comment claims concurrency alone protects it ("a single hanging connector must not
// delay every other connector's report"), but concurrency only bounds the SUM across connectors
// finishing in parallel, not the MAX any one of them is allowed to take.
describe('GET /healthz — finding MAJOR 2 (a hanging connector must not delay the response)', () => {
  it('does not block on a connector whose ping never resolves', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jm-hc-deadline-'))
    const app = Fastify()
    registerHealthRoutes(app, {
      db: openDb(join(dir, 'db.sqlite')),
      jellyfin: { ping: () => new Promise<void>(() => { /* never settles */ }) },
      qbittorrent: null,
      radarr: null,
      sonarr: null,
      probeDeadlineMs: 50,
    })
    const started = performance.now()
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    const elapsedMs = performance.now() - started
    // Generous relative to the 50ms deadline configured above — the point is this is nowhere near
    // the tens of seconds a real hung connector would otherwise cost, not a tight timing assertion.
    expect(elapsedMs).toBeLessThan(1000)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.connectors.jellyfin).toBe('timeout')
    // A probe that timed out is neither "ok" nor "not-configured" — it must still fail closed.
    expect(body.status).toBe('degraded')
  }, 2000)

  it('still reports a fast connector normally when a different connector hangs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jm-hc-deadline-mixed-'))
    const app = Fastify()
    registerHealthRoutes(app, {
      db: openDb(join(dir, 'db.sqlite')),
      jellyfin: { ping: () => new Promise<void>(() => { /* never settles */ }) },
      qbittorrent: { ping: async () => {} },
      radarr: null,
      sonarr: null,
      probeDeadlineMs: 50,
    })
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    const body = res.json()
    expect(body.connectors.jellyfin).toBe('timeout')
    expect(body.connectors.qbittorrent).toBe('ok')
  }, 2000)
})

// Fixwave-2 finding MINOR 3: `(err as { kind?: string }).kind ?? 'unreachable'` trusted an
// arbitrary property on whatever was thrown, verbatim, into a body /healthz serves with no
// authentication. Only a bounded ConnectorError reaches this catch today, but one catch-and-rethrow
// elsewhere would put attacker- or bug-supplied text straight into the response.
describe('GET /healthz — finding MINOR 3 (err.kind must not be echoed unvalidated)', () => {
  it('falls back to "unreachable" for a kind outside the known connector-error vocabulary', async () => {
    const app = buildServer(testDeps(async () => {
      throw Object.assign(new Error('boom'), { kind: '…?apikey=RADARRKEY-abcdef-SECRET' })
    }))
    const body = (await app.inject({ method: 'GET', url: '/healthz' })).json()
    expect(body.connectors.jellyfin).toBe('unreachable')
  })

  it('still passes through a genuine known ConnectorError kind', async () => {
    const app = buildServer(testDeps(async () => {
      throw Object.assign(new Error('rate limited'), { kind: 'rate-limited' })
    }))
    const body = (await app.inject({ method: 'GET', url: '/healthz' })).json()
    expect(body.connectors.jellyfin).toBe('rate-limited')
  })
})

// Fixwave-2 finding MINOR 4: the four connector pings are TTL-cached specifically so an anonymous
// caller cannot spend a rate-limited budget, but indexCounts was added later with no such
// protection — every anonymous /healthz request ran four fresh COUNT(*) scans, scaling with library
// size (measured: 3.2ms of synchronous, event-loop-blocking work per request on a 250k-row index).
describe('GET /healthz — finding MINOR 4 (indexCounts must be TTL-cached like the connector pings)', () => {
  it('reuses cached indexCounts within the TTL instead of re-querying on every request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jm-hc-idx-'))
    const db = openDb(join(dir, 'db.sqlite'))
    let countQueries = 0
    const originalPrepare = db.prepare.bind(db)
    db.prepare = ((sql: string) => {
      if (sql.includes('COUNT(*)')) countQueries += 1
      return originalPrepare(sql)
    }) as typeof db.prepare
    let t = 0
    const app = Fastify()
    registerHealthRoutes(app, {
      db,
      jellyfin: { ping: async () => {} },
      qbittorrent: null,
      radarr: null,
      sonarr: null,
      now: () => t,
    })
    await app.inject({ method: 'GET', url: '/healthz' })
    const afterFirst = countQueries
    expect(afterFirst).toBeGreaterThan(0)
    await app.inject({ method: 'GET', url: '/healthz' })
    expect(countQueries).toBe(afterFirst) // still within the TTL — no new COUNT(*) queries

    t = 10_000 // past the TTL
    await app.inject({ method: 'GET', url: '/healthz' })
    expect(countQueries).toBe(afterFirst * 2)
  })
})
