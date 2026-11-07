import { afterAll, describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import { QBIT_PROBE_TIMEOUT_MS, registerPathMapRoutes } from '../../src/api/pathmap.js'
import { openDb, type Db } from '../../src/index/db.js'
import { signSession } from '../../src/auth/session.js'
import { createConfigStore } from '../../src/config/store.js'
import { ConnectorError } from '../../src/connectors/http.js'
import { readVerification, verificationBlocker, writeVerification } from '../../src/scan/verification.js'
import type { QbitInstanceConfig } from '../../src/config/schema.js'
import type { JellyfinItem } from '../../src/connectors/jellyfin.js'
import type { QbitClient, Torrent } from '../../src/connectors/qbittorrent.js'
import type { PathMapping } from '../../src/core/types.js'

const SECRET = 'y'.repeat(32)

// Every directory, database and server a test makes is released afterwards: these run on shared
// machines whose disks fill up.
const made: string[] = []
const dbs: Db[] = []
const apps: FastifyInstance[] = []
afterAll(async () => {
  for (const app of apps) await app.close()
  for (const db of dbs) db.close()
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

const tmp = (label: string) => {
  const dir = mkdtempSync(join(tmpdir(), `jm-pmroutes-${label}-`))
  made.push(dir)
  return dir
}

type Items = (opts: { startIndex: number; limit: number }) => Promise<{ items: JellyfinItem[]; totalRecordCount: number }>
type Client = Pick<QbitClient, 'ping' | 'torrents'>

const instance = (id: string, url = 'http://198.51.100.10:8080'): QbitInstanceConfig => ({ id, url, user: null, pass: null })
const idleClient = (): Client => ({ ping: async () => ({ version: 'v5.2.2' }), torrents: async () => [] })

interface Options {
  items?: Items
  /** The instances the environment configures, in order. Defaults to one: box-a. */
  instances?: QbitInstanceConfig[]
  /** The client registry. An instance with no entry here has no client. Defaults to an idle client per instance. */
  clients?: Record<string, Client>
  random?: () => number
  probeTimeoutMs?: number
}

/** The routes on a bare Fastify, wired the way src/server.ts wires them (tests/server/wiring.test.ts covers that wiring itself). */
function build(opts: Options = {}) {
  const dir = tmp('app')
  const db = openDb(join(dir, 'db.sqlite'))
  dbs.push(db)
  const instances = opts.instances ?? [instance('box-a')]
  const configStore = createConfigStore({
    dataDir: dir, port: 0, trustProxy: 0, sessionSecret: SECRET,
    jellyfin: { url: 'http://jf', apiKey: 'k' },
    qbittorrents: instances,
    radarr: null, sonarr: null,
  })
  const clients = opts.clients ?? Object.fromEntries(instances.map((i) => [i.id, idleClient()]))
  const app = Fastify()
  apps.push(app)
  app.register(cookie)
  registerPathMapRoutes(app, {
    configStore,
    db,
    jellyfin: { items: opts.items ?? (async () => ({ items: [], totalRecordCount: 0 })) },
    qbittorrents: new Map(Object.entries(clients)),
    sessionSecret: SECRET,
    random: opts.random,
    probeTimeoutMs: opts.probeTimeoutMs,
  })
  return { app, db, dir, configStore }
}

/** A row as Jellyfin returns it; only the fields the sampler reads matter here. */
const row = (id: string, jfPath: string | null) => ({ id, jfPath }) as JellyfinItem

const authCookie = () => `jellymaid_session=${signSession({ username: 'bob', userId: 'u', issuedAt: Date.now(), isAdministrator: true }, SECRET)}`
const headers = () => ({ cookie: authCookie() })

const get = (app: FastifyInstance, url: string) => app.inject({ method: 'GET', url, headers: headers() })
const put = (app: FastifyInstance, mappings: unknown) => app.inject({ method: 'PUT', url: '/api/pathmap', headers: headers(), payload: { mappings } })
const post = (app: FastifyInstance, url: string, payload?: unknown) => app.inject({ method: 'POST', url, headers: headers(), payload: payload as never })

function torrent(over: Partial<Torrent> & Pick<Torrent, 'instanceId' | 'hash'>): Torrent {
  return {
    name: over.hash, savePath: null, contentPath: null, rootPath: null, category: null, tags: [],
    state: 'stalledUP', ratio: 1, seedingTimeSeconds: 0, isPrivate: false, privacySource: 'flag',
    trackerHost: null, sizeBytes: 0, progress: 1, addedOn: null,
    ...over,
  }
}

/** A library on disk with one single-file release: `<root>/Heat (1995)/Heat.mkv`, 5 bytes. */
function library(label: string) {
  const root = join(tmp(label), 'movies')
  mkdirSync(join(root, 'Heat (1995)'), { recursive: true })
  writeFileSync(join(root, 'Heat (1995)', 'Heat.mkv'), 'hello')
  return root
}

const libraryMapping = (container: string, over: Partial<PathMapping> = {}): PathMapping => ({
  role: 'library', jellyfin: '/media/Movies', container, qbit: '/movies', qbitInstance: 'box-a', ...over,
})

const heatTorrent = (instanceId: string, over: Partial<Torrent> = {}) =>
  torrent({ instanceId, hash: 'a'.repeat(40), contentPath: '/movies/Heat (1995)/Heat.mkv', rootPath: '', sizeBytes: 5, ...over })

describe('/api/pathmap', () => {
  it('requires a session', async () => {
    expect((await build().app.inject({ method: 'GET', url: '/api/pathmap' })).statusCode).toBe(401)
  })

  it('answers an empty install with no mappings, no problems and no verification', async () => {
    const res = await get(build().app, '/api/pathmap')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ mappings: [], problems: [], lastVerification: null })
  })

  it('reads the live config on every request, not the one in force when the routes were registered', async () => {
    const { app, configStore } = build()
    expect((await get(app, '/api/pathmap')).json().mappings).toEqual([])
    configStore.save({ pathMappings: [libraryMapping('/path/to/movies')] })
    expect((await get(app, '/api/pathmap')).json().mappings).toHaveLength(1)
  })

  it('shows a legacy mapping as owned by the only instance, exactly as the planner and the scan will read it', async () => {
    const { app, configStore } = build()
    configStore.save({ pathMappings: [{ role: 'download', jellyfin: null, container: '/path/to/dl', qbit: '/downloads', qbitInstance: null }] })
    const body = (await get(app, '/api/pathmap')).json()
    expect(body.mappings[0]).toMatchObject({ container: '/path/to/dl', qbit: '/downloads', qbitInstance: 'box-a' })
    expect(body.problems).toEqual([])
  })

  it('reports a mapping that names no instance when two could own it, and leaves it unowned', async () => {
    const { app, configStore } = build({ instances: [instance('box-a'), instance('box-b')] })
    configStore.save({ pathMappings: [{ role: 'download', jellyfin: null, container: '/path/to/dl', qbit: '/downloads', qbitInstance: null }] })
    const body = (await get(app, '/api/pathmap')).json()
    expect(body.mappings[0].qbitInstance).toBeNull()
    expect(body.problems).toHaveLength(1)
    expect(body.problems[0]).toContain('/path/to/dl')
  })

  describe('lastVerification', () => {
    const record = (mappingsHash: string) => ({
      at: '2026-10-30T00:00:00.000Z', mappingsHash,
      jellyfin: { sampled: 1, resolved: 1, failures: [] }, qbit: [{ instanceId: 'box-a', sampled: 0, resolved: 0, failures: [] }],
    })

    it('is current when it was taken against the mappings in force', async () => {
      const { app, db, configStore } = build()
      writeVerification(db, record(configStore.mappingsHash()))
      expect((await get(app, '/api/pathmap')).json().lastVerification).toEqual({ ...record(configStore.mappingsHash()), current: true })
    })

    it('is not current when it was taken against other mappings, and is still shown', async () => {
      const { app, db } = build()
      writeVerification(db, record('0123456789abcdef'))
      expect((await get(app, '/api/pathmap')).json().lastVerification).toMatchObject({ mappingsHash: '0123456789abcdef', current: false })
    })

    it('reads a record from before mapping sets existed as not current', async () => {
      const { app, db } = build()
      db.prepare("INSERT INTO kv (key, value_json) VALUES ('pathmap.lastVerification', ?)")
        .run(JSON.stringify({ sampled: 3, resolved: 3, failures: [], at: '2026-07-30T00:00:00.000Z' }))
      expect((await get(app, '/api/pathmap')).json().lastVerification).toMatchObject({ mappingsHash: '', current: false, jellyfin: { sampled: 3 } })
    })
  })
})

describe('PUT /api/pathmap', () => {
  it('requires a session', async () => {
    expect((await build().app.inject({ method: 'PUT', url: '/api/pathmap', payload: { mappings: [] } })).statusCode).toBe(401)
  })

  it('rejects a library mapping with a null jellyfin path', async () => {
    const res = await put(build().app, [{ role: 'library', jellyfin: null, container: '/mnt/m', qbit: null }])
    expect(res.statusCode).toBe(400)
  })

  it('persists a valid mapping set', async () => {
    const { app } = build()
    const res = await put(app, [{ role: 'library', jellyfin: '/media/Movies', container: '/mnt/m', qbit: null }])
    expect(res.statusCode).toBe(200)
    const got = await get(app, '/api/pathmap')
    expect(got.json().mappings[0].jellyfin).toBe('/media/Movies')
  })

  it('rejects a relative container — it is the root a later delete sweep may not climb above', async () => {
    const res = await put(build().app, [{ role: 'library', jellyfin: '/media/Movies', container: 'media', qbit: null }])
    expect(res.statusCode).toBe(400)
    expect(String(res.json().issues)).toMatch(/absolute/i)
  })

  it('rejects "/" as a container outright', async () => {
    const res = await put(build().app, [{ role: 'library', jellyfin: '/media/Movies', container: '/', qbit: null }])
    expect(res.statusCode).toBe(400)
    expect(String(res.json().issues)).toMatch(/filesystem root/i)
  })

  it('rejects relative jellyfin and qbit paths', async () => {
    const jf = await put(build().app, [{ role: 'library', jellyfin: 'media/Movies', container: '/mnt/m', qbit: null }])
    expect(jf.statusCode).toBe(400)
    const qb = await put(build().app, [{ role: 'download', jellyfin: null, container: '/mnt/d', qbit: 'downloads' }])
    expect(qb.statusCode).toBe(400)
  })

  it('rejects an instance with no qBittorrent path to translate', async () => {
    const res = await put(build().app, [{ role: 'library', jellyfin: '/media/Movies', container: '/mnt/m', qbit: null, qbitInstance: 'box-a' }])
    expect(res.statusCode).toBe(400)
  })

  it('PUT returns problems from normalizeMappings, and still saves', async () => {
    const { app, configStore } = build({ instances: [instance('box-a'), instance('box-b')] })
    const res = await put(app, [
      // Names no instance while two exist: nothing can say whose it is.
      { role: 'library', jellyfin: '/media/Movies', container: '/path/to/movies', qbit: '/movies', qbitInstance: null },
      // Names an instance that is not configured.
      { role: 'library', jellyfin: '/media/TV', container: '/path/to/tv', qbit: '/tv', qbitInstance: 'box-z' },
      // Not torrent-backed at all: no problem.
      { role: 'library', jellyfin: '/media/Home', container: '/path/to/home', qbit: null, qbitInstance: null },
    ])
    expect(res.statusCode).toBe(200)
    const { problems, mappings } = res.json()
    expect(problems).toHaveLength(2)
    expect(problems.join('\n')).toContain('/path/to/movies')
    expect(problems.join('\n')).toContain('box-z')
    expect(mappings).toHaveLength(3)
    expect(configStore.file().pathMappings).toHaveLength(3)
  })

  // Final re-review N1: both boxes report /movies, and box B's row is labelled box-a.
  it('PUT reports one instance mapping /movies to two folders, and Verify then fails that instance and shuts the gate', async () => {
    const aMovies = library('n1-a')
    const bMovies = join(tmp('n1-b'), 'movies')
    mkdirSync(join(bMovies, 'Alien (1979)'), { recursive: true })
    writeFileSync(join(bMovies, 'Alien (1979)', 'Alien.mkv'), 'alien!')
    const { app, db, configStore } = build({
      instances: [instance('box-a'), instance('box-b', 'http://198.51.100.11:8080')],
      items: async () => ({ items: [row('i1', '/media/Movies/Heat (1995)/Heat.mkv')], totalRecordCount: 1 }),
      clients: {
        'box-a': { ping: async () => ({ version: 'v5.2.2' }), torrents: async () => [heatTorrent('box-a')] },
        'box-b': {
          ping: async () => ({ version: 'v5.2.2' }),
          torrents: async () => [heatTorrent('box-b', { hash: 'b'.repeat(40), contentPath: '/movies/Alien (1979)/Alien.mkv', sizeBytes: 6 })],
        },
      },
    })
    const res = await put(app, [
      libraryMapping(aMovies),
      libraryMapping(bMovies, { jellyfin: '/media/Movies B' }), // box B's row, mislabelled box-a
    ])
    expect(res.statusCode).toBe(200)
    const problem = `box-a maps /movies to two folders (${aMovies}, ${bMovies}); one of them probably belongs to another box`
    expect(res.json().problems).toEqual([expect.stringContaining(problem)])
    expect((await get(app, '/api/pathmap')).json().problems).toEqual(res.json().problems)

    const verified = await post(app, '/api/pathmap/verify')
    expect(verified.statusCode).toBe(200)
    const [boxA, boxB] = verified.json().qbit
    expect(boxA.failures).toEqual([{ qbitPath: '/movies', reason: expect.stringContaining(problem) }])
    // box-b's own report is clean — its film lies under no prefix of its own — so box-a's must not be.
    expect(boxB).toMatchObject({ instanceId: 'box-b', failures: [], ignored: { count: 1 } })
    const gate = verificationBlocker(db, { mappingsHash: configStore.mappingsHash(), instanceIds: configStore.instanceIds() })
    expect(gate).toContain(problem)
  })

  it('answers in the shape GET does, with the instance filled in where only one could own it', async () => {
    const { app } = build()
    const res = await put(app, [{ role: 'download', jellyfin: null, container: '/path/to/dl', qbit: '/downloads', qbitInstance: null }])
    expect(res.json()).toEqual({
      mappings: [{ role: 'download', jellyfin: null, container: '/path/to/dl', qbit: '/downloads', qbitInstance: 'box-a' }],
      problems: [],
      lastVerification: null,
    })
    expect((await get(app, '/api/pathmap')).json()).toEqual(res.json())
  })

  it('a PUT that fails validation changes nothing', async () => {
    const { app, db, configStore } = build()
    await put(app, [libraryMapping('/path/to/movies')])
    writeVerification(db, {
      at: '2026-10-30T00:00:00.000Z', mappingsHash: configStore.mappingsHash(),
      jellyfin: { sampled: 1, resolved: 1, failures: [] }, qbit: [{ instanceId: 'box-a', sampled: 0, resolved: 0, failures: [] }],
    })
    const before = JSON.stringify((await get(app, '/api/pathmap')).json())
    const bad = await put(app, [{ role: 'library', jellyfin: null, container: '/mnt/m', qbit: null }])
    expect(bad.statusCode).toBe(400)
    expect(JSON.stringify((await get(app, '/api/pathmap')).json())).toBe(before)
  })

  describe('a stored verification describes one mapping set', () => {
    async function verified() {
      const disk = library('stale')
      const built = build({
        items: async () => ({ items: [row('i1', '/media/Movies/Heat (1995)/Heat.mkv')], totalRecordCount: 1 }),
        clients: { 'box-a': { ping: async () => ({ version: 'v5.2.2' }), torrents: async () => [heatTorrent('box-a')] } },
      })
      await put(built.app, [libraryMapping(disk)])
      expect((await post(built.app, '/api/pathmap/verify')).statusCode).toBe(200)
      const gate = () => verificationBlocker(built.db, { mappingsHash: built.configStore.mappingsHash(), instanceIds: built.configStore.instanceIds() })
      expect(gate()).toBeNull()
      return { ...built, disk, gate }
    }

    it('keeps its record when the very same set is saved again, and still lets the gate through', async () => {
      const { app, disk, gate } = await verified()
      const res = await put(app, [libraryMapping(disk)])
      expect(res.json().lastVerification.current).toBe(true)
      expect(gate()).toBeNull()
    })

    it('shows it as not current, and the gate blocks, once any mapping changes', async () => {
      const { app, disk, gate } = await verified()
      const res = await put(app, [libraryMapping(disk, { qbit: '/films' })])
      expect(res.json().lastVerification).toMatchObject({ current: false })
      expect(res.json().lastVerification.jellyfin.sampled).toBe(1) // the old result is still there to read
      expect(gate()).toMatch(/changed/i)
    })
  })
})

describe('POST /api/pathmap/verify', () => {
  it('requires a session', async () => {
    expect((await build().app.inject({ method: 'POST', url: '/api/pathmap/verify' })).statusCode).toBe(401)
  })

  it('verifies the Jellyfin half and reports the failures', async () => {
    const { app } = build({
      items: async () => ({ items: [row('i1', '/media/Movies/Heat.mkv'), row('i2', '/other/Alien.mkv')], totalRecordCount: 2 }),
    })
    await put(app, [{ role: 'library', jellyfin: '/media/Movies', container: '/nope', qbit: null }])
    const res = await post(app, '/api/pathmap/verify')
    expect(res.statusCode).toBe(200)
    expect(res.json().jellyfin).toMatchObject({ sampled: 2, resolved: 0 })
    expect(res.json().jellyfin.failures).toEqual([
      { jellyfinPath: '/media/Movies/Heat.mkv', reason: 'mapped to /nope/Heat.mkv but not found on disk' },
      { jellyfinPath: '/other/Alien.mkv', reason: 'no mapping covers this path' },
    ])
  })

  it('Verify writes a record with the current mappingsHash', async () => {
    const disk = library('record')
    const { app, db, configStore } = build({
      items: async () => ({ items: [row('i1', '/media/Movies/Heat (1995)/Heat.mkv')], totalRecordCount: 1 }),
      clients: { 'box-a': { ping: async () => ({ version: 'v5.2.2' }), torrents: async () => [heatTorrent('box-a')] } },
    })
    await put(app, [libraryMapping(disk)])
    const res = await post(app, '/api/pathmap/verify')
    expect(res.statusCode).toBe(200)

    const stored = readVerification(db)
    expect(stored).not.toBeNull()
    expect(stored!.mappingsHash).toBe(configStore.mappingsHash())
    expect(stored!.mappingsHash).toMatch(/^[0-9a-f]{16}$/)
    expect(stored!.jellyfin).toEqual({ sampled: 1, resolved: 1, failures: [] })
    expect(stored!.qbit).toEqual([{ instanceId: 'box-a', sampled: 1, resolved: 1, failures: [] }])
    // The response is the stored record, plus the fact that it describes the mappings now in force.
    expect(res.json()).toEqual({ ...stored, current: true })
  })

  it('a passing verification lets the scan and plan gate through — an unforced scan is no longer refused', async () => {
    const disk = library('gate')
    const { app, db, configStore } = build({
      items: async () => ({ items: [row('i1', '/media/Movies/Heat (1995)/Heat.mkv')], totalRecordCount: 1 }),
      clients: { 'box-a': { ping: async () => ({ version: 'v5.2.2' }), torrents: async () => [heatTorrent('box-a')] } },
    })
    await put(app, [libraryMapping(disk)])
    // Before Verify there is nothing to go on.
    expect(verificationBlocker(db, { mappingsHash: configStore.mappingsHash(), instanceIds: configStore.instanceIds() })).toMatch(/never been verified/i)
    await post(app, '/api/pathmap/verify')
    expect(verificationBlocker(db, { mappingsHash: configStore.mappingsHash(), instanceIds: configStore.instanceIds() })).toBeNull()
  })

  it('verifies each instance through its own prefix and reports them in the order they are configured', async () => {
    const boxA = library('two-a')
    const boxB = library('two-b')
    const { app, db, configStore } = build({
      instances: [instance('box-a'), instance('box-b')],
      items: async () => ({ items: [row('i1', '/media/A/Heat (1995)/Heat.mkv'), row('i2', '/media/B/Heat (1995)/Heat.mkv')], totalRecordCount: 2 }),
      clients: {
        'box-a': { ping: async () => ({ version: 'v5.2.2' }), torrents: async () => [heatTorrent('box-a')] },
        // Box B's file is one byte short of what its torrent says: the path is there, the content is not.
        'box-b': { ping: async () => ({ version: 'v5.1.2' }), torrents: async () => [heatTorrent('box-b', { sizeBytes: 6 })] },
      },
    })
    await put(app, [
      libraryMapping(boxA, { jellyfin: '/media/A', qbitInstance: 'box-a' }),
      libraryMapping(boxB, { jellyfin: '/media/B', qbitInstance: 'box-b' }),
    ])
    const res = await post(app, '/api/pathmap/verify')
    expect(res.statusCode).toBe(200)
    const { qbit } = res.json()
    expect(qbit.map((r: { instanceId: string }) => r.instanceId)).toEqual(['box-a', 'box-b'])
    expect(qbit[0]).toEqual({ instanceId: 'box-a', sampled: 1, resolved: 1, failures: [] })
    expect(qbit[1]).toMatchObject({ instanceId: 'box-b', sampled: 1, resolved: 0 })
    expect(qbit[1].failures[0].reason).toMatch(/5 bytes.*6 bytes/)
    // A failing instance is recorded, and it blocks.
    expect(verificationBlocker(db, { mappingsHash: configStore.mappingsHash(), instanceIds: configStore.instanceIds() })).toMatch(/box-b/)
  })

  it('records an instance with no client as a failure, not as missing', async () => {
    const { app, db, configStore } = build({
      instances: [instance('box-a'), instance('box-b')],
      items: async () => ({ items: [row('i1', '/media/Movies/Heat.mkv')], totalRecordCount: 1 }),
      clients: { 'box-a': idleClient() },
    })
    const res = await post(app, '/api/pathmap/verify')
    expect(res.statusCode).toBe(200)
    const missing = res.json().qbit[1]
    expect(missing).toMatchObject({ instanceId: 'box-b', sampled: 0, resolved: 0 })
    expect(missing.failures[0].reason).toMatch(/no qBittorrent client/i)
    expect(verificationBlocker(db, { mappingsHash: configStore.mappingsHash(), instanceIds: configStore.instanceIds() })).not.toBeNull()
  })

  it('records an instance that cannot list its torrents as a failure', async () => {
    const { app } = build({
      items: async () => ({ items: [row('i1', '/media/Movies/Heat.mkv')], totalRecordCount: 1 }),
      clients: { 'box-a': { ping: async () => ({ version: 'v5.2.2' }), torrents: async () => { throw new Error('[qbittorrent] unreachable: HTTP 502') } } },
    })
    const res = await post(app, '/api/pathmap/verify')
    expect(res.json().qbit[0]).toEqual({
      instanceId: 'box-a', sampled: 0, resolved: 0,
      failures: [{ qbitPath: '', reason: 'could not list torrents: [qbittorrent] unreachable: HTTP 502' }],
    })
  })

  it('writes nothing when Jellyfin cannot be asked, so the previous answer keeps standing', async () => {
    const { app, db } = build({ items: async () => { throw new Error('jellyfin is down') } })
    const res = await post(app, '/api/pathmap/verify')
    expect(res.statusCode).toBe(500)
    expect(readVerification(db)).toBeNull()
  })

  it('refuses to record a result for mappings that changed while it was running', async () => {
    // The result describes the set that was checked. Stamped with the NEW set's hash it would vouch for
    // mappings nobody looked at; stamped with the old one it could overwrite a newer, valid record.
    let swapped = false
    let configStoreRef: ReturnType<typeof build>['configStore'] | undefined
    const { app, db, configStore } = build({
      items: async () => {
        if (!swapped) {
          swapped = true
          configStoreRef!.save({ pathMappings: [libraryMapping('/path/to/somewhere/else')] })
        }
        return { items: [row('i1', '/media/Movies/Heat.mkv')], totalRecordCount: 1 }
      },
    })
    configStoreRef = configStore
    const res = await post(app, '/api/pathmap/verify')
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('mappings changed')
    expect(res.json().reason).toMatch(/Run Verify again/)
    expect(readVerification(db)).toBeNull()
  })
})

describe('item sampling', () => {
  function sampler(total: number, pathFor: (i: number) => string | null) {
    const startIndexes: number[] = []
    const random = (() => { let n = 0; const seq = [0.9, 0.1, 0.5, 0.7, 0.3]; return () => seq[n++ % seq.length]! })()
    const { app } = build({
      random,
      items: async ({ startIndex, limit }) => {
        startIndexes.push(startIndex)
        const items = Array.from({ length: Math.min(limit, Math.max(0, total - startIndex)) },
          (_, k) => row(`i${startIndex + k}`, pathFor(startIndex + k)))
        return { items, totalRecordCount: total }
      },
    })
    return { app, startIndexes }
  }

  it('draws from random offsets across the library, not just the first page', async () => {
    // Jellyfin's default ordering puts one library first, so a first-page-only sample reports
    // "verification passing" while a second library's mapping is entirely wrong.
    const { app, startIndexes } = sampler(10_000, (i) => `/media/Movies/Film ${i}/Film.mkv`)
    const res = await post(app, '/api/pathmap/verify')
    expect(res.statusCode).toBe(200)
    expect(startIndexes.length).toBeGreaterThan(1)
    expect(startIndexes.every((s) => s === 0)).toBe(false)
    expect(startIndexes.some((s) => s > 1000)).toBe(true)
  })

  it('caps the request count so a verify can never become a scan', async () => {
    // Every row is a pathless Series/Season row, so the sample target is never reached.
    const { app, startIndexes } = sampler(10_000, () => null)
    await post(app, '/api/pathmap/verify')
    expect(startIndexes.length).toBeLessThanOrEqual(6) // 1 count probe + at most 5 windows
  })

  it('only counts rows that actually carry a path towards the sample', async () => {
    // Half the rows are pathless; the reported sample must contain no phantom entries.
    const { app } = sampler(10_000, (i) => (i % 2 === 0 ? `/media/Movies/Film ${i}/Film.mkv` : null))
    const body = (await post(app, '/api/pathmap/verify')).json()
    expect(body.jellyfin.sampled).toBeGreaterThan(0)
    expect(body.jellyfin.sampled).toBeLessThanOrEqual(20)
    expect(body.jellyfin.failures).toHaveLength(body.jellyfin.sampled)
  })
})

describe('POST /api/pathmap/detect', () => {
  /** A mount holding one Jellyfin-visible release, laid out the way a box's torrents are saved. */
  function mountWith(label: string, ...folders: string[]) {
    const mount = tmp(label)
    for (const folder of folders) {
      mkdirSync(join(mount, 'Movies', folder), { recursive: true })
      writeFileSync(join(mount, 'Movies', folder, `${folder}.mkv`), 'x')
    }
    return mount
  }
  const heatItems: Items = async () => ({ items: [row('i1', '/media/Movies/Heat (1995)/Heat (1995).mkv')], totalRecordCount: 1 })
  const heatFolder = (instanceId: string, hash: string) =>
    torrent({ instanceId, hash, contentPath: '/movies/Heat (1995)', rootPath: '/movies/Heat (1995)' })

  it('requires a session', async () => {
    const res = await build().app.inject({ method: 'POST', url: '/api/pathmap/detect', payload: { mountRoots: ['/mnt'] } })
    expect(res.statusCode).toBe(401)
  })

  it('rejects a body with no mountRoots', async () => {
    const res = await post(build().app, '/api/pathmap/detect', {})
    expect(res.statusCode).toBe(400)
  })

  it('proposes a mapping for a sampled item found under the mount root', async () => {
    const mount = mountWith('detect-plain', 'Heat (1995)')
    const { app } = build({ items: heatItems })
    const res = await post(app, '/api/pathmap/detect', { mountRoots: [mount] })
    expect(res.statusCode).toBe(200)
    // No instance holds a torrent there, so the torrent side stays unset for the operator to choose.
    expect(res.json()).toEqual({
      proposals: [{ role: 'library', jellyfin: '/media/Movies', container: join(mount, 'Movies'), qbit: null, qbitInstance: null }],
    })
  })

  it("fills in the qBittorrent side from where an instance's torrents are", async () => {
    const mount = mountWith('detect-fill', 'Heat (1995)')
    const { app } = build({
      instances: [instance('box-a'), instance('box-b')],
      items: heatItems,
      clients: {
        'box-a': { ping: async () => ({ version: 'v5.2.2' }), torrents: async () => [] },
        'box-b': { ping: async () => ({ version: 'v5.1.2' }), torrents: async () => [heatFolder('box-b', 'b'.repeat(40))] },
      },
    })
    const res = await post(app, '/api/pathmap/detect', { mountRoots: [mount] })
    expect(res.json().proposals).toEqual([
      { role: 'library', jellyfin: '/media/Movies', container: join(mount, 'Movies'), qbit: '/movies', qbitInstance: 'box-b' },
    ])
  })

  it('leaves the qBittorrent side unset when two instances both fit the root', async () => {
    const mount = mountWith('detect-both', 'Heat (1995)')
    const { app } = build({
      instances: [instance('box-a'), instance('box-b')],
      items: heatItems,
      clients: {
        'box-a': { ping: async () => ({ version: 'v5.2.2' }), torrents: async () => [heatFolder('box-a', 'a'.repeat(40))] },
        'box-b': { ping: async () => ({ version: 'v5.1.2' }), torrents: async () => [heatFolder('box-b', 'b'.repeat(40))] },
      },
    })
    const res = await post(app, '/api/pathmap/detect', { mountRoots: [mount] })
    expect(res.json().proposals).toEqual([
      { role: 'library', jellyfin: '/media/Movies', container: join(mount, 'Movies'), qbit: null, qbitInstance: null },
    ])
  })

  it('still answers with the Jellyfin proposals when an instance cannot be asked', async () => {
    const mount = mountWith('detect-down', 'Heat (1995)')
    const { app } = build({
      items: heatItems,
      clients: { 'box-a': { ping: async () => ({ version: 'v5.2.2' }), torrents: async () => { throw new Error('unreachable') } } },
    })
    const res = await post(app, '/api/pathmap/detect', { mountRoots: [mount] })
    expect(res.statusCode).toBe(200)
    expect(res.json().proposals).toHaveLength(1)
    expect(res.json().proposals[0]).toMatchObject({ qbit: null, qbitInstance: null })
  })

  it('does not ask any instance for its torrents when there is nothing to propose a root for', async () => {
    let asked = 0
    const { app } = build({
      items: async () => ({ items: [row('i1', '/media/Movies/Nope/Nope.mkv')], totalRecordCount: 1 }),
      clients: { 'box-a': { ping: async () => ({ version: 'v5.2.2' }), torrents: async () => { asked += 1; return [] } } },
    })
    const res = await post(app, '/api/pathmap/detect', { mountRoots: [tmp('detect-empty')] })
    expect(res.json()).toEqual({ proposals: [] })
    expect(asked).toBe(0)
  })
})

describe('GET /api/qbit/instances', () => {
  const ok = (version = 'v5.2.2', count = 0): Client => ({
    ping: async () => ({ version }),
    torrents: async () => Array.from({ length: count }, (_, i) => torrent({ instanceId: 'x', hash: String(i) })),
  })
  const instancesOf = async (app: FastifyInstance) => (await get(app, '/api/qbit/instances')).json().instances as Array<{
    id: string; url: string; reachable: boolean; version: string | null; error: string | null; torrentCount: number | null
  }>

  it('requires a session', async () => {
    expect((await build().app.inject({ method: 'GET', url: '/api/qbit/instances' })).statusCode).toBe(401)
  })

  it('keeps its whole probe within three seconds', () => {
    expect(QBIT_PROBE_TIMEOUT_MS).toBeGreaterThan(0)
    expect(QBIT_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(3000)
  })

  it('strips credentials from URLs', async () => {
    const { app } = build({
      instances: [
        instance('box-a', 'http://alice:s3cret@198.51.100.10:8080'),
        // Anything riding in the query string is as private as a password in the authority.
        instance('box-b', 'https://bob:p%40ss@198.51.100.11/qbit?token=abc#frag'),
      ],
    })
    const res = await get(app, '/api/qbit/instances')
    const { instances } = res.json()
    expect(instances.map((i: { url: string }) => i.url)).toEqual(['http://198.51.100.10:8080', 'https://198.51.100.11/qbit'])
    for (const secret of ['alice', 's3cret', 'bob', 'p%40ss', 'p@ss', 'token', 'abc', 'frag']) {
      expect(res.body).not.toContain(secret)
    }
  })

  it('reports per-instance reachability, version and torrent count', async () => {
    let listedDown = 0
    const { app } = build({
      instances: [instance('box-a'), instance('box-b')],
      clients: {
        'box-a': ok('v5.2.2', 3),
        'box-b': {
          ping: async () => { throw new ConnectorError('unreachable', 'qbittorrent', 'HTTP 502', 502) },
          torrents: async () => { listedDown += 1; return [] },
        },
      },
    })
    const [a, b] = await instancesOf(app)
    expect(a).toEqual({ id: 'box-a', url: 'http://198.51.100.10:8080', reachable: true, version: 'v5.2.2', error: null, torrentCount: 3 })
    expect(b).toMatchObject({ id: 'box-b', reachable: false, version: null, torrentCount: null })
    expect(b!.error).toContain('HTTP 502')
    // An instance that cannot answer a ping is not asked for its whole torrent list as well.
    expect(listedDown).toBe(0)
  })

  it('lists the instances in the order they are configured', async () => {
    const { app } = build({ instances: [instance('zeta'), instance('alpha'), instance('mid')] })
    expect((await instancesOf(app)).map((i) => i.id)).toEqual(['zeta', 'alpha', 'mid'])
  })

  it('reports an instance with no client as unreachable', async () => {
    const { app } = build({ instances: [instance('box-a'), instance('box-b')], clients: { 'box-a': ok() } })
    const [, b] = await instancesOf(app)
    expect(b).toMatchObject({ id: 'box-b', reachable: false, version: null, torrentCount: null })
    expect(b!.error).toMatch(/no qBittorrent client/i)
  })

  it('gives up on a ping that never answers and says so, without waiting for it', async () => {
    const { app } = build({
      probeTimeoutMs: 40,
      clients: { 'box-a': { ping: () => new Promise(() => {}), torrents: async () => [] } },
    })
    const started = Date.now()
    const [a] = await instancesOf(app)
    expect(a).toMatchObject({ reachable: false, version: null, torrentCount: null })
    expect(a!.error).toMatch(/did not answer/i)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('reports a reachable instance whose torrent list errors or times out with a null count', async () => {
    const { app } = build({
      probeTimeoutMs: 40,
      instances: [instance('box-a'), instance('box-b')],
      clients: {
        'box-a': { ping: async () => ({ version: 'v5.2.2' }), torrents: async () => { throw new Error('list failed') } },
        'box-b': { ping: async () => ({ version: 'v5.1.2' }), torrents: () => new Promise(() => {}) },
      },
    })
    const [a, b] = await instancesOf(app)
    expect(a).toMatchObject({ reachable: true, version: 'v5.2.2', error: null, torrentCount: null })
    expect(b).toMatchObject({ reachable: true, version: 'v5.1.2', error: null, torrentCount: null })
  })

  it('probes the instances at the same time, not one after another', async () => {
    // Each ping answers only once BOTH have been asked. Probed one after another, the first would
    // wait for a second that is never started, and be reported unreachable.
    let started = 0
    let release!: () => void
    const bothAsked = new Promise<void>((resolve) => { release = resolve })
    const meet = (version: string): Client => ({
      ping: async () => { started += 1; if (started === 2) release(); await bothAsked; return { version } },
      torrents: async () => [],
    })
    const { app } = build({
      probeTimeoutMs: 1000,
      instances: [instance('box-a'), instance('box-b')],
      clients: { 'box-a': meet('v5.2.2'), 'box-b': meet('v5.1.2') },
    })
    const [a, b] = await instancesOf(app)
    expect([a!.reachable, b!.reachable]).toEqual([true, true])
  })

  it('shares one ping between overlapping requests, so a hung instance cannot pile up requests behind its rate limit', async () => {
    let pings = 0
    let answer!: (v: { version: string }) => void
    const pending = new Promise<{ version: string }>((resolve) => { answer = resolve })
    const { app } = build({
      probeTimeoutMs: 30,
      clients: { 'box-a': { ping: () => { pings += 1; return pending }, torrents: async () => [] } },
    })
    const [first, second] = await Promise.all([instancesOf(app), instancesOf(app)])
    expect([first[0]!.reachable, second[0]!.reachable]).toEqual([false, false])
    expect(pings).toBe(1)
    // Still hung: a later request joins the same ping rather than starting a fourth, fifth, ...
    await instancesOf(app)
    expect(pings).toBe(1)
    // Once it answers, the next request asks afresh.
    answer({ version: 'v5.2.2' })
    await new Promise((resolve) => setImmediate(resolve))
    const [after] = await instancesOf(app)
    expect(after).toMatchObject({ reachable: true, version: 'v5.2.2' })
    expect(pings).toBe(2)
  })
})
