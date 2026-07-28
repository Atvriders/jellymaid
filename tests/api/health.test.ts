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
