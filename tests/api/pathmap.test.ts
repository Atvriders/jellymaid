import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import { buildServer } from '../../src/server.js'
import { registerPathMapRoutes } from '../../src/api/pathmap.js'
import { openDb } from '../../src/index/db.js'
import { createLogger } from '../../src/core/logger.js'
import { fileConfigSchema } from '../../src/config/schema.js'
import { signSession } from '../../src/auth/session.js'
import type { JellyfinItem } from '../../src/connectors/jellyfin.js'

const SECRET = 'y'.repeat(32)

/** Set by app() on every call — lets tests inspect the same db the server under test is using,
 * the same pattern tests/api/scan.test.ts uses for its own module-level `db`. */
let db: ReturnType<typeof openDb>

const fakeScanRunner = () => ({
  start: () => ({ scanId: 1 }), cancel: () => false, isRunning: () => false,
  status: () => ({ running: false, scanId: null, phase: null, done: 0, total: null, lastScan: null }),
})

function app(items?: (opts: { startIndex: number; limit: number }) => Promise<{ items: JellyfinItem[]; totalRecordCount: number }>) {
  const dir = mkdtempSync(join(tmpdir(), 'jm-pmapi-'))
  db = openDb(join(dir, 'db.sqlite'))
  return buildServer({
    config: {
      env: {
        dataDir: dir, port: 0, trustProxy: 0, sessionSecret: SECRET,
        jellyfin: { url: 'http://jf', apiKey: 'k' },
        qbittorrent: { url: 'http://qb', user: 'u', pass: 'p' },
        radarr: null, sonarr: null,
      },
      file: fileConfigSchema.parse({}),
    },
    db,
    jellyfin: {
      ping: async () => {},
      items: items ?? (async () => ({ items: [], totalRecordCount: 0 })),
    } as never,
    logger: createLogger({ level: 'error', sink: () => {} }),
    scanRunner: fakeScanRunner() as never,
    // Unused by these path-map tests — plans.test.ts covers the plan/execute/trash routes.
    plannerDeps: (() => ({})) as never,
    trashDeps: (() => ({})) as never,
    executor: {} as never,
  })
}

/** A row as Jellyfin returns it; only the fields the sampler reads matter here. */
const row = (id: string, jfPath: string | null) => ({ id, jfPath }) as JellyfinItem

const authCookie = () => `jellymaid_session=${signSession({ username: 'bob', userId: 'u', issuedAt: Date.now(), isAdministrator: true }, SECRET)}`

describe('/api/pathmap', () => {
  it('requires a session', async () => {
    expect((await app().inject({ method: 'GET', url: '/api/pathmap' })).statusCode).toBe(401)
  })

  it('returns the configured mappings for an authenticated admin', async () => {
    const res = await app().inject({ method: 'GET', url: '/api/pathmap', headers: { cookie: authCookie() } })
    expect(res.statusCode).toBe(200)
    expect(res.json().mappings).toEqual([])
  })

  it('rejects a library mapping with a null jellyfin path', async () => {
    const res = await app().inject({
      method: 'PUT', url: '/api/pathmap', headers: { cookie: authCookie() },
      payload: { mappings: [{ role: 'library', jellyfin: null, container: '/mnt/m', qbit: null }] },
    })
    expect(res.statusCode).toBe(400)
  })

  it('persists a valid mapping set', async () => {
    const a = app()
    const put = await a.inject({
      method: 'PUT', url: '/api/pathmap', headers: { cookie: authCookie() },
      payload: { mappings: [{ role: 'library', jellyfin: '/media/Movies', container: '/mnt/m', qbit: null }] },
    })
    expect(put.statusCode).toBe(200)
    const get = await a.inject({ method: 'GET', url: '/api/pathmap', headers: { cookie: authCookie() } })
    expect(get.json().mappings[0].jellyfin).toBe('/media/Movies')
  })

  it('rejects a relative container — it is the root a later delete sweep may not climb above', async () => {
    const res = await app().inject({
      method: 'PUT', url: '/api/pathmap', headers: { cookie: authCookie() },
      payload: { mappings: [{ role: 'library', jellyfin: '/media/Movies', container: 'media', qbit: null }] },
    })
    expect(res.statusCode).toBe(400)
    expect(String(res.json().issues)).toMatch(/absolute/i)
  })

  it('rejects "/" as a container outright', async () => {
    const res = await app().inject({
      method: 'PUT', url: '/api/pathmap', headers: { cookie: authCookie() },
      payload: { mappings: [{ role: 'library', jellyfin: '/media/Movies', container: '/', qbit: null }] },
    })
    expect(res.statusCode).toBe(400)
    expect(String(res.json().issues)).toMatch(/filesystem root/i)
  })

  it('rejects relative jellyfin and qbit paths', async () => {
    const jf = await app().inject({
      method: 'PUT', url: '/api/pathmap', headers: { cookie: authCookie() },
      payload: { mappings: [{ role: 'library', jellyfin: 'media/Movies', container: '/mnt/m', qbit: null }] },
    })
    expect(jf.statusCode).toBe(400)
    const qb = await app().inject({
      method: 'PUT', url: '/api/pathmap', headers: { cookie: authCookie() },
      payload: { mappings: [{ role: 'download', jellyfin: null, container: '/mnt/d', qbit: 'downloads' }] },
    })
    expect(qb.statusCode).toBe(400)
  })

  it('verifies mappings and reports the failures', async () => {
    const a = app(async () => ({
      items: [row('i1', '/media/Movies/Heat.mkv'), row('i2', '/other/Alien.mkv')],
      totalRecordCount: 2,
    }))
    await a.inject({
      method: 'PUT', url: '/api/pathmap', headers: { cookie: authCookie() },
      payload: { mappings: [{ role: 'library', jellyfin: '/media/Movies', container: '/nope', qbit: null }] },
    })
    const res = await a.inject({ method: 'POST', url: '/api/pathmap/verify', headers: { cookie: authCookie() } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ sampled: 2, resolved: 0 })
    expect(res.json().failures).toEqual([
      { jellyfinPath: '/media/Movies/Heat.mkv', reason: 'mapped to /nope/Heat.mkv but not found on disk' },
      { jellyfinPath: '/other/Alien.mkv', reason: 'no mapping covers this path' },
    ])
  })

  it('requires a session to verify', async () => {
    expect((await app().inject({ method: 'POST', url: '/api/pathmap/verify' })).statusCode).toBe(401)
  })
})

describe('/api/pathmap/verify — persistence for the scan-start gate', () => {
  // POST /api/scan/start (src/api/scan.ts) refuses to start against an unverified path map
  // unless forced. It reads this exact record, so verify must actually write it, not just
  // return the report in the response body.
  it('persists the report under pathmap.lastVerification so a later scan-start gate can read it', async () => {
    const a = app(async () => ({ items: [row('i1', '/media/Movies/Heat.mkv')], totalRecordCount: 1 }))
    await a.inject({
      method: 'PUT', url: '/api/pathmap', headers: { cookie: authCookie() },
      payload: { mappings: [{ role: 'library', jellyfin: '/media/Movies', container: '/nope', qbit: null }] },
    })
    await a.inject({ method: 'POST', url: '/api/pathmap/verify', headers: { cookie: authCookie() } })

    const stored = db.prepare("SELECT value_json FROM kv WHERE key = 'pathmap.lastVerification'").get() as
      { value_json: string } | undefined
    expect(stored).toBeDefined()
    const record = JSON.parse(stored!.value_json) as { sampled: number; resolved: number; at: string }
    expect(record).toMatchObject({ sampled: 1, resolved: 0 })
    expect(record.at).toBeTruthy()
  })

  it('saving a new mapping set clears any prior verification record, so an edited map cannot ride on a stale pass', async () => {
    const a = app(async () => ({ items: [row('i1', '/media/Movies/Heat.mkv')], totalRecordCount: 1 }))
    await a.inject({
      method: 'PUT', url: '/api/pathmap', headers: { cookie: authCookie() },
      payload: { mappings: [{ role: 'library', jellyfin: '/media/Movies', container: '/nope', qbit: null }] },
    })
    await a.inject({ method: 'POST', url: '/api/pathmap/verify', headers: { cookie: authCookie() } })
    expect(db.prepare("SELECT 1 FROM kv WHERE key = 'pathmap.lastVerification'").get()).toBeDefined()

    await a.inject({
      method: 'PUT', url: '/api/pathmap', headers: { cookie: authCookie() },
      payload: { mappings: [{ role: 'library', jellyfin: '/media/Movies', container: '/nope', qbit: null }] },
    })
    expect(db.prepare("SELECT 1 FROM kv WHERE key = 'pathmap.lastVerification'").get()).toBeUndefined()
  })

  it('a PUT that fails validation does not clear an existing verification record', async () => {
    const a = app(async () => ({ items: [row('i1', '/media/Movies/Heat.mkv')], totalRecordCount: 1 }))
    await a.inject({
      method: 'PUT', url: '/api/pathmap', headers: { cookie: authCookie() },
      payload: { mappings: [{ role: 'library', jellyfin: '/media/Movies', container: '/nope', qbit: null }] },
    })
    await a.inject({ method: 'POST', url: '/api/pathmap/verify', headers: { cookie: authCookie() } })

    const bad = await a.inject({
      method: 'PUT', url: '/api/pathmap', headers: { cookie: authCookie() },
      payload: { mappings: [{ role: 'library', jellyfin: null, container: '/mnt/m', qbit: null }] },
    })
    expect(bad.statusCode).toBe(400)
    expect(db.prepare("SELECT 1 FROM kv WHERE key = 'pathmap.lastVerification'").get()).toBeDefined()
  })
})

describe('/api/pathmap/detect', () => {
  it('requires a session', async () => {
    const res = await app().inject({
      method: 'POST', url: '/api/pathmap/detect', payload: { mountRoots: ['/mnt'] },
    })
    expect(res.statusCode).toBe(401)
  })

  it('rejects a body with no mountRoots', async () => {
    const res = await app().inject({
      method: 'POST', url: '/api/pathmap/detect', headers: { cookie: authCookie() }, payload: {},
    })
    expect(res.statusCode).toBe(400)
  })

  it('proposes a mapping for a sampled item found under the mount root', async () => {
    const media = mkdtempSync(join(tmpdir(), 'jm-detect-'))
    mkdirSync(join(media, 'Movies', 'Heat (1995)'), { recursive: true })
    writeFileSync(join(media, 'Movies', 'Heat (1995)', 'Heat.mkv'), 'x')
    const a = app(async () => ({
      items: [row('i1', '/media/Movies/Heat (1995)/Heat.mkv')],
      totalRecordCount: 1,
    }))
    const res = await a.inject({
      method: 'POST', url: '/api/pathmap/detect', headers: { cookie: authCookie() },
      payload: { mountRoots: [media] },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().proposed).toEqual([
      { role: 'library', jellyfin: '/media/Movies', container: join(media, 'Movies'), qbit: null },
    ])
  })
})

describe('item sampling', () => {
  function sampler(total: number, pathFor: (i: number) => string | null) {
    const startIndexes: number[] = []
    const random = (() => { let n = 0; const seq = [0.9, 0.1, 0.5, 0.7, 0.3]; return () => seq[n++ % seq.length]! })()
    const dir = mkdtempSync(join(tmpdir(), 'jm-sample-'))
    const fastify = Fastify()
    fastify.register(cookie)
    registerPathMapRoutes(fastify, {
      dataDir: dir,
      sessionSecret: SECRET,
      random,
      db: openDb(join(dir, 'db.sqlite')),
      jellyfin: {
        items: async ({ startIndex, limit }) => {
          startIndexes.push(startIndex)
          const items = Array.from({ length: Math.min(limit, Math.max(0, total - startIndex)) },
            (_, k) => row(`i${startIndex + k}`, pathFor(startIndex + k)))
          return { items, totalRecordCount: total }
        },
      },
    })
    return { fastify, startIndexes }
  }

  it('draws from random offsets across the library, not just the first page', async () => {
    // Jellyfin's default ordering puts one library first, so a first-page-only sample reports
    // "verification passing" while a second library's mapping is entirely wrong.
    const { fastify, startIndexes } = sampler(10_000, (i) => `/media/Movies/Film ${i}/Film.mkv`)
    const res = await fastify.inject({ method: 'POST', url: '/api/pathmap/verify', headers: { cookie: authCookie() } })
    expect(res.statusCode).toBe(200)
    expect(startIndexes.length).toBeGreaterThan(1)
    expect(startIndexes.every((s) => s === 0)).toBe(false)
    expect(startIndexes.some((s) => s > 1000)).toBe(true)
  })

  it('caps the request count so a verify can never become a scan', async () => {
    // Every row is a pathless Series/Season row, so the sample target is never reached.
    const { fastify, startIndexes } = sampler(10_000, () => null)
    await fastify.inject({ method: 'POST', url: '/api/pathmap/verify', headers: { cookie: authCookie() } })
    expect(startIndexes.length).toBeLessThanOrEqual(6) // 1 count probe + at most 5 windows
  })

  it('only counts rows that actually carry a path towards the sample', async () => {
    // Half the rows are pathless; the reported sample must contain no phantom entries.
    const { fastify } = sampler(10_000, (i) => (i % 2 === 0 ? `/media/Movies/Film ${i}/Film.mkv` : null))
    const res = await fastify.inject({ method: 'POST', url: '/api/pathmap/verify', headers: { cookie: authCookie() } })
    const body = res.json()
    expect(body.sampled).toBeGreaterThan(0)
    expect(body.sampled).toBeLessThanOrEqual(20)
    expect(body.failures).toHaveLength(body.sampled)
  })
})
