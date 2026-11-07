import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { buildServer } from '../../src/server.js'
import { registerHealthRoutes } from '../../src/api/health.js'
import { openDb } from '../../src/index/db.js'
import { createLogger } from '../../src/core/logger.js'
import { createConfigStore } from '../../src/config/store.js'
import { createPathMap } from '../../src/fs/pathmap.js'

type Pingable = { ping: () => Promise<unknown> } | null

/** One instance, 'box-a', serving the given double; null = no qBittorrent instance at all. */
const qbitMap = (client: Pingable) => (client ? new Map([['box-a', client]]) : new Map())

/** The route reads only the path map from the store. */
const storeWith = (pathMap = createPathMap([])) => ({ pathMap: () => pathMap })

/**
 * Builds the same stub ServerDeps every route test in this file needs, with each of the four
 * connectors independently swappable. `null` means "not configured" — the same shape production
 * uses for an omitted optional Radarr/Sonarr instance (src/index.ts).
 */
function depsWith(connectors: { jellyfin: Pingable; qbittorrent: Pingable; radarr: Pingable; sonarr: Pingable }) {
  const dir = mkdtempSync(join(tmpdir(), 'jm-srv-'))
  return {
    configStore: createConfigStore({
      dataDir: dir, port: 0, trustProxy: 0, sessionSecret: 'x'.repeat(32),
      jellyfin: { url: 'http://jf', apiKey: 'k' },
      qbittorrents: [{ id: 'box-a', url: 'http://qb', user: null, pass: null }],
      radarr: null, sonarr: null,
    }),
    db: openDb(join(dir, 'db.sqlite')),
    jellyfin: connectors.jellyfin as never,
    qbittorrents: qbitMap(connectors.qbittorrent) as never,
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
      qbittorrents: qbitMap(null),
      radarr: null,
      sonarr: null,
      configStore: storeWith(),
      now: () => t,
    })
    await app.inject({ method: 'GET', url: '/healthz' })
    t = 10_000
    await app.inject({ method: 'GET', url: '/healthz' })
    expect(pings).toBe(2)
  })
})

describe('GET /healthz — qBittorrent instances', () => {
  const withBoxes = (
    boxes: Record<string, () => Promise<unknown>>,
    extra: { now?: () => number; probeDeadlineMs?: number } = {},
  ) => {
    const dir = mkdtempSync(join(tmpdir(), 'jm-hc-boxes-'))
    const app = Fastify()
    registerHealthRoutes(app, {
      db: openDb(join(dir, 'db.sqlite')),
      jellyfin: { ping: async () => {} },
      qbittorrents: new Map(Object.entries(boxes).map(([id, ping]) => [id, { ping }])),
      radarr: null,
      sonarr: null,
      configStore: storeWith(),
      ...extra,
    })
    return app
  }
  const kindError = (kind: string) => () => Promise.reject(Object.assign(new Error('x'), { kind }))
  const probe = async (app: ReturnType<typeof withBoxes>) => (await app.inject({ method: 'GET', url: '/healthz' })).json()

  it('reports qbittorrent ok only when every instance answers', async () => {
    const app = withBoxes({ 'box-a': async () => ({ version: 'v5.2.2' }), 'box-b': async () => ({ version: 'v5.1.2' }) })
    const body = (await app.inject({ method: 'GET', url: '/healthz' })).json()
    expect(body.connectors.qbittorrent).toBe('ok')
    expect(body.status).toBe('ok')
  })

  it('reports the worst instance, so one healthy box cannot hide a dead one', async () => {
    const app = withBoxes({
      'box-a': async () => ({ version: 'v5.2.2' }),
      'box-b': async () => { throw Object.assign(new Error('x'), { kind: 'auth' }) },
    })
    const body = (await app.inject({ method: 'GET', url: '/healthz' })).json()
    expect(body.connectors.qbittorrent).toBe('auth')
    expect(body.status).toBe('degraded')
  })

  it('healthz lists every qBittorrent instance with version; connectors.qbittorrent is the worst', async () => {
    const body = await probe(withBoxes({
      'box-a': async () => ({ version: 'v5.2.2' }),
      'box-b': async () => ({ version: 'v5.1.2' }),
      'box-c': kindError('auth'),
      'box-d': kindError('unreachable'),
    }))
    expect(body.connectors.qbitInstances).toEqual({
      'box-a': { status: 'ok', version: 'v5.2.2' },
      'box-b': { status: 'ok', version: 'v5.1.2' },
      'box-c': { status: 'auth', error: 'auth' },
      'box-d': { status: 'unreachable', error: 'unreachable' },
    })
    // Not the first failure in list order (that would be 'auth'): an unreachable box outranks one
    // that merely rejects credentials, and a healthy box outranks nothing.
    expect(body.connectors.qbittorrent).toBe('unreachable')
    expect(body.status).toBe('degraded')
  })

  it('lists healthy instances with their versions and keeps the aggregate ok', async () => {
    const body = await probe(withBoxes({
      'box-a': async () => ({ version: 'v5.2.2' }),
      'box-b': async () => ({ version: 'v5.1.2' }),
    }))
    expect(body.connectors.qbitInstances).toEqual({
      'box-a': { status: 'ok', version: 'v5.2.2' },
      'box-b': { status: 'ok', version: 'v5.1.2' },
    })
    expect(body.connectors.qbittorrent).toBe('ok')
    expect(body.status).toBe('ok')
  })

  it('names the failing box, so a healthy one cannot hide it', async () => {
    const body = await probe(withBoxes({ 'box-a': async () => ({ version: 'v5.2.2' }), 'box-b': kindError('auth') }))
    expect(body.connectors.qbitInstances['box-a']).toEqual({ status: 'ok', version: 'v5.2.2' })
    expect(body.connectors.qbitInstances['box-b']).toEqual({ status: 'auth', error: 'auth' })
    expect(body.connectors.qbittorrent).toBe('auth')
  })

  it('reports an instance whose ping gives no version as ok without one', async () => {
    const body = await probe(withBoxes({ 'box-a': async () => {} }))
    expect(body.connectors.qbitInstances['box-a']).toEqual({ status: 'ok' })
  })

  // The per-instance status is the contract's four-value union; the detail it cannot carry
  // (a timeout, a rate limit, a malformed answer) goes in `error`, from the same allowlist of
  // connector-error kinds the aggregate uses — never the error's own message.
  it.each(['timeout', 'rate-limited', 'bad-response', 'cancelled'])(
    'reports a %s failure as unreachable with the kind in error, and the aggregate keeps the kind',
    async (kind) => {
      const body = await probe(withBoxes({ 'box-a': kindError(kind) }))
      expect(body.connectors.qbitInstances['box-a']).toEqual({ status: 'unreachable', error: kind })
      expect(body.connectors.qbittorrent).toBe(kind)
      expect(body.status).toBe('degraded')
    },
  )

  it('ranks failures so the aggregate does not depend on the order instances are listed in', async () => {
    const failures = { 'box-a': kindError('auth'), 'box-b': kindError('unreachable') }
    expect((await probe(withBoxes(failures))).connectors.qbittorrent).toBe('unreachable')
    expect((await probe(withBoxes({ 'box-b': failures['box-b'], 'box-a': failures['box-a'] }))).connectors.qbittorrent).toBe('unreachable')
  })

  it('never puts an error message, URL or credential in the unauthenticated response', async () => {
    const body = await probe(withBoxes({
      'box-a': async () => { throw new Error('connect ECONNREFUSED http://operator:hunter2@198.51.100.10:8080/api/v2/app/version') },
      'box-b': async () => { throw Object.assign(new Error('boom'), { kind: '…?apikey=SECRET-abcdef' }) },
    }))
    expect(body.connectors.qbitInstances['box-a']).toEqual({ status: 'unreachable', error: 'unreachable' })
    expect(body.connectors.qbitInstances['box-b']).toEqual({ status: 'unreachable', error: 'unreachable' })
    const text = JSON.stringify(body)
    for (const leaked of ['hunter2', 'operator', '198.51.100', 'SECRET', 'ECONNREFUSED']) expect(text).not.toContain(leaked)
  })

  // A version is text the qBittorrent server chose, served with no authentication: only something
  // shaped like a version number is passed through.
  it.each([
    ['markup', '<script>alert(1)</script>'],
    ['a sentence', 'v5.2.2 is running on host nas.example'],
    ['an over-long string', `v${'9'.repeat(200)}`],
    ['a non-string', 5],
    ['an empty string', ''],
  ])('omits a version that is %s', async (_label, version) => {
    const body = await probe(withBoxes({ 'box-a': async () => ({ version }) }))
    expect(body.connectors.qbitInstances['box-a']).toEqual({ status: 'ok' })
  })

  it('passes ordinary version spellings through', async () => {
    const body = await probe(withBoxes({
      'box-a': async () => ({ version: 'v5.2.2' }),
      'box-b': async () => ({ version: '4.6.7' }),
      'box-c': async () => ({ version: 'v5.0.0rc1' }),
    }))
    expect(Object.values(body.connectors.qbitInstances).map((i) => (i as { version: string }).version))
      .toEqual(['v5.2.2', '4.6.7', 'v5.0.0rc1'])
  })

  it('has no instances to list, and reports qbittorrent as not-configured, when none is configured', async () => {
    const body = await probe(withBoxes({}))
    expect(body.connectors.qbitInstances).toEqual({})
    expect(body.connectors.qbittorrent).toBe('not-configured')
    expect(body.status).toBe('ok')
  })

  it('pings each instance once within the TTL and again after it, so an anonymous caller cannot spend a box\'s budget', async () => {
    const pings = { a: 0, b: 0 }
    let t = 0
    const app = withBoxes(
      { 'box-a': async () => { pings.a += 1; return { version: 'v5.2.2' } }, 'box-b': async () => { pings.b += 1; return { version: 'v5.1.2' } } },
      { now: () => t },
    )
    await Promise.all([probe(app), probe(app), probe(app)])
    expect(pings).toEqual({ a: 1, b: 1 })
    t = 10_000
    const later = await probe(app)
    expect(pings).toEqual({ a: 2, b: 2 })
    expect(later.connectors.qbitInstances['box-a'].version).toBe('v5.2.2')
  })

  // No wall-clock assertion: if the deadline did not cut the hung box off, `probe` would never
  // return and this test would hit its own timeout, which is the failure that matters.
  it('reports a box that hangs as timed out without holding up the other box', async () => {
    const body = await probe(withBoxes(
      { 'box-a': async () => ({ version: 'v5.2.2' }), 'box-b': () => new Promise<void>(() => { /* never settles */ }) },
      { probeDeadlineMs: 50 },
    ))
    expect(body.connectors.qbitInstances['box-a']).toEqual({ status: 'ok', version: 'v5.2.2' })
    expect(body.connectors.qbitInstances['box-b']).toEqual({ status: 'unreachable', error: 'timeout' })
    expect(body.connectors.qbittorrent).toBe('timeout')
    expect(body.status).toBe('degraded')
  }, 10_000)

  it('still answers with a status when config.json cannot be read, reporting arrUnmappable as not evaluated', async () => {
    // The container HEALTHCHECK needs a JSON `status`; a config typo must not make this probe 500.
    const dir = mkdtempSync(join(tmpdir(), 'jm-hc-badcfg-'))
    const app = Fastify()
    registerHealthRoutes(app, {
      db: openDb(join(dir, 'db.sqlite')),
      jellyfin: { ping: async () => {} },
      qbittorrents: qbitMap({ ping: async () => ({ version: 'v5.2.2' }) }),
      radarr: null,
      sonarr: null,
      configStore: { pathMap: () => { throw new Error('config.json is not valid JSON') } },
    })
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    expect(typeof res.json().status).toBe('string')
    expect(res.json().arrUnmappable).toEqual({ evaluated: false, count: 0 })
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
    expect(body.connectors).toEqual({
      jellyfin: 'ok', qbittorrent: 'ok', radarr: 'ok', sonarr: 'not-configured',
      qbitInstances: { 'box-a': { status: 'ok' } },
    })
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
      qbittorrents: qbitMap(null),
      radarr: null,
      sonarr: null,
      configStore: storeWith(),
      probeDeadlineMs: 50,
    })
    const started = performance.now()
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    const elapsedMs = performance.now() - started
    // Generous relative to the 50ms deadline configured above — the point is this is nowhere near
    // the tens of seconds a real hung connector would otherwise cost, not a tight timing assertion.
    // The ping never settles, so without the deadline this response would never come at all; any
    // finite bound proves the property. It was 1000ms, which a loaded host does not honor: with the
    // suite running in parallel on a disk under IO pressure, this one 50ms timer was measured firing
    // 1.6-2.9s late (no other work in the window), failing 2 runs in 3 at the plain lane merge.
    expect(elapsedMs).toBeLessThan(10_000)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.connectors.jellyfin).toBe('timeout')
    // A probe that timed out is neither "ok" nor "not-configured" — it must still fail closed.
    expect(body.status).toBe('degraded')
  }, 15_000)

  it('still reports a fast connector normally when a different connector hangs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jm-hc-deadline-mixed-'))
    const app = Fastify()
    registerHealthRoutes(app, {
      db: openDb(join(dir, 'db.sqlite')),
      jellyfin: { ping: () => new Promise<void>(() => { /* never settles */ }) },
      qbittorrents: qbitMap({ ping: async () => {} }),
      radarr: null,
      sonarr: null,
      configStore: storeWith(),
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
      qbittorrents: qbitMap(null),
      radarr: null,
      sonarr: null,
      configStore: storeWith(),
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

// Carry-forward.md:49 (Plan 4's addition, "Plan 6, before ship"): `arrUnmappable` (src/plan/resolve.ts)
// blocks every delete non-overridably (src/plan/guards.ts), but was reachable only by building a
// plan and reading its failure message. Surfaced here as a COUNT only — /healthz is unauthenticated,
// and the *arr paths themselves (root-folder names, library layout) are not safe to hand to an
// anonymous caller the way a bare integer is.
const arrRecord = (arrPath: string | null) => ({
  kind: 'radarr' as const, instance: 'radarr', remoteId: 1, title: 'Heat', arrPath,
  monitored: true, seriesId: null, episodeId: null, episodeFileId: null,
})

describe('GET /healthz — MAJOR 2 (surface arrUnmappable count)', () => {
  it('reports evaluated:true and count:0 when neither *arr is configured', async () => {
    const app = buildServer(depsWith({
      jellyfin: { ping: async () => {} }, qbittorrent: { ping: async () => {} }, radarr: null, sonarr: null,
    }))
    const body = (await app.inject({ method: 'GET', url: '/healthz' })).json()
    expect(body.arrUnmappable).toEqual({ evaluated: true, count: 0 })
  })

  it('counts a radarr record whose *arr path no mapping covers', async () => {
    const app = buildServer(depsWith({
      jellyfin: { ping: async () => {} },
      qbittorrent: { ping: async () => {} },
      radarr: {
        ping: async () => {},
        inventory: async () => ({ records: [arrRecord('/data/movies/Heat.mkv')], complete: true }),
      } as never,
      sonarr: null,
    }))
    const body = (await app.inject({ method: 'GET', url: '/healthz' })).json()
    expect(body.arrUnmappable).toEqual({ evaluated: true, count: 1 })
  })

  it('sums unmappable records across both radarr and sonarr', async () => {
    const app = buildServer(depsWith({
      jellyfin: { ping: async () => {} },
      qbittorrent: { ping: async () => {} },
      radarr: { ping: async () => {}, inventory: async () => ({ records: [arrRecord('/data/movies/Heat.mkv')], complete: true }) } as never,
      sonarr: { ping: async () => {}, inventory: async () => ({ records: [arrRecord('/data/tv/Show.mkv')], complete: true }) } as never,
    }))
    const body = (await app.inject({ method: 'GET', url: '/healthz' })).json()
    expect(body.arrUnmappable).toEqual({ evaluated: true, count: 2 })
  })

  it('does not count a record with no *arr path at all', async () => {
    const app = buildServer(depsWith({
      jellyfin: { ping: async () => {} },
      qbittorrent: { ping: async () => {} },
      radarr: { ping: async () => {}, inventory: async () => ({ records: [arrRecord(null)], complete: true }) } as never,
      sonarr: null,
    }))
    const body = (await app.inject({ method: 'GET', url: '/healthz' })).json()
    expect(body.arrUnmappable).toEqual({ evaluated: true, count: 0 })
  })

  it('does not count a record whose *arr path a mapping DOES translate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jm-hc-arrmap-'))
    const app = Fastify()
    registerHealthRoutes(app, {
      db: openDb(join(dir, 'db.sqlite')),
      jellyfin: { ping: async () => {} },
      qbittorrents: qbitMap(null),
      radarr: { ping: async () => {}, inventory: async () => ({ records: [arrRecord('/movies/Heat.mkv')], complete: true }) } as never,
      sonarr: null,
      configStore: storeWith(createPathMap([{ role: 'library', jellyfin: '/movies', container: '/data/movies', qbit: null, qbitInstance: null }])),
    })
    const body = (await app.inject({ method: 'GET', url: '/healthz' })).json()
    expect(body.arrUnmappable).toEqual({ evaluated: true, count: 0 })
  })

  it('never leaks the unmapped *arr path itself into the response body', async () => {
    const app = buildServer(depsWith({
      jellyfin: { ping: async () => {} },
      qbittorrent: { ping: async () => {} },
      radarr: { ping: async () => {}, inventory: async () => ({ records: [arrRecord('/data/movies/Heat.mkv')], complete: true }) } as never,
      sonarr: null,
    }))
    const body = (await app.inject({ method: 'GET', url: '/healthz' })).json()
    expect(body.arrUnmappable.count).toBe(1)
    expect(JSON.stringify(body)).not.toContain('Heat.mkv')
  })

  it('reports evaluated:false, not a false zero, when a configured *arr inventory fetch fails', async () => {
    const app = buildServer(depsWith({
      jellyfin: { ping: async () => {} },
      qbittorrent: { ping: async () => {} },
      radarr: { ping: async () => {}, inventory: async () => { throw new Error('unreachable') } } as never,
      sonarr: null,
    }))
    const body = (await app.inject({ method: 'GET', url: '/healthz' })).json()
    expect(body.arrUnmappable).toEqual({ evaluated: false, count: 0 })
  })

  it('does not flip top-level status to degraded from a non-zero arrUnmappable count', async () => {
    const app = buildServer(depsWith({
      jellyfin: { ping: async () => {} },
      qbittorrent: { ping: async () => {} },
      radarr: { ping: async () => {}, inventory: async () => ({ records: [arrRecord('/data/movies/Heat.mkv')], complete: true }) } as never,
      sonarr: null,
    }))
    const body = (await app.inject({ method: 'GET', url: '/healthz' })).json()
    expect(body.arrUnmappable.count).toBe(1)
    expect(body.status).toBe('ok')
  })

  it('does not flip top-level status to degraded when arrUnmappable could not be evaluated', async () => {
    const app = buildServer(depsWith({
      jellyfin: { ping: async () => {} },
      qbittorrent: { ping: async () => {} },
      radarr: { ping: async () => {}, inventory: async () => { throw new Error('unreachable') } } as never,
      sonarr: null,
    }))
    const body = (await app.inject({ method: 'GET', url: '/healthz' })).json()
    // The connector's own ping is what reports reachability; a narrower inventory-only failure
    // must not duplicate that signal through a second, unrelated field.
    expect(body.connectors.radarr).toBe('ok')
    expect(body.arrUnmappable.evaluated).toBe(false)
    expect(body.status).toBe('ok')
  })

  it('caches the *arr inventory fetch within the TTL, like the connector pings', async () => {
    let calls = 0
    let t = 0
    const dir = mkdtempSync(join(tmpdir(), 'jm-hc-arrcache-'))
    const app = Fastify()
    registerHealthRoutes(app, {
      db: openDb(join(dir, 'db.sqlite')),
      jellyfin: { ping: async () => {} },
      qbittorrents: qbitMap(null),
      radarr: { ping: async () => {}, inventory: async () => { calls += 1; return { records: [], complete: true } } } as never,
      sonarr: null,
      configStore: storeWith(),
      now: () => t,
    })
    await app.inject({ method: 'GET', url: '/healthz' })
    expect(calls).toBe(1)
    await app.inject({ method: 'GET', url: '/healthz' })
    expect(calls).toBe(1) // still within the TTL — no new inventory fetch

    t = 10_000 // past the TTL
    await app.inject({ method: 'GET', url: '/healthz' })
    expect(calls).toBe(2)
  })
})
