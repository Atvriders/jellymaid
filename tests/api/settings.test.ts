import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerSettingsRoutes } from '../../src/api/settings.js'
import { createConfigStore, type ConfigStore } from '../../src/config/store.js'
import { fileConfigSchema } from '../../src/config/schema.js'
import { signSession } from '../../src/auth/session.js'

const SECRET = 's'.repeat(32)
// isAdministrator: true is required — requireSession (src/api/auth.ts) rejects any session that
// does not carry it, the same admin re-assertion every other guarded route relies on.
const auth = () => ({ cookie: `jellymaid_session=${signSession({ username: 'bob', userId: 'u', issuedAt: Date.now(), isAdministrator: true }, SECRET)}` })

let dir: string
let store: ConfigStore

/** Written BEFORE the store first reads, so the file is the starting state, not an edit. */
const writeConfig = (config: unknown) => writeFileSync(join(dir, 'config.json'), JSON.stringify(config))
const onDisk = () => JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as ReturnType<typeof fileConfigSchema.parse>

function build() {
  const app = Fastify()
  app.register(cookie)
  registerSettingsRoutes(app, { configStore: store, sessionSecret: SECRET })
  return app
}

const put = (payload: unknown) =>
  build().inject({ method: 'PUT', url: '/api/config/settings', headers: auth(), payload: payload as object })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jm-settings-'))
  store = createConfigStore({
    dataDir: dir, port: 0, trustProxy: 0, sessionSecret: SECRET,
    jellyfin: { url: 'http://jellyfin.example', apiKey: 'k' },
    qbittorrents: [{ id: 'box-a', url: 'http://qbit.example', user: null, pass: null }],
    radarr: null, sonarr: null,
  })
})

describe('GET /api/config/settings', () => {
  it('requires a session', async () => {
    expect((await build().inject({ method: 'GET', url: '/api/config/settings' })).statusCode).toBe(401)
  })

  it('returns the SettingsView of the config in force, and nothing else from the file', async () => {
    const res = await build().inject({ method: 'GET', url: '/api/config/settings', headers: auth() })
    expect(res.statusCode).toBe(200)
    const defaults = fileConfigSchema.parse({})
    // toEqual, not toMatchObject: a rate limit, a rule setting or a path mapping appearing here
    // would be the file leaking through a view that is meant to be exactly these three groups.
    expect(res.json()).toEqual({
      guards: {
        minRatio: defaults.guards.minRatio,
        minSeedTimeDays: defaults.guards.minSeedTimeDays,
        protectedCategories: [],
        protectedTags: [],
        privateTrackerHosts: [],
      },
      keeper: { policy: 'best-quality' },
      trash: { maxBytes: defaults.trash.maxBytes, retentionDays: defaults.trash.retentionDays },
    })
  })

  it('shows the private tracker host list, which the operator has to see to edit', async () => {
    writeConfig({ guards: { privateTrackerHosts: ['tracker.example'] } })
    const res = await build().inject({ method: 'GET', url: '/api/config/settings', headers: auth() })
    expect(res.json().guards.privateTrackerHosts).toEqual(['tracker.example'])
  })

  it('follows an edit to config.json without a restart', async () => {
    const app = build()
    expect((await app.inject({ method: 'GET', url: '/api/config/settings', headers: auth() })).json().keeper.policy).toBe('best-quality')
    writeConfig({ keeper: { policy: 'smallest' } })
    expect((await app.inject({ method: 'GET', url: '/api/config/settings', headers: auth() })).json().keeper.policy).toBe('smallest')
  })
})

describe('PUT /api/config/settings', () => {
  it('requires a session', async () => {
    const res = await build().inject({ method: 'PUT', url: '/api/config/settings', payload: { guards: { minRatio: 2 } } })
    expect(res.statusCode).toBe(401)
    expect(store.file().guards.minRatio).toBe(1)
  })

  it('settings PUT changes minRatio live and keeps siblings; rejects negative values', async () => {
    writeConfig({
      guards: {
        minRatio: 1, minSeedTimeDays: 7, protectedCategories: ['keep'], protectedTags: ['pinned'],
        privateTrackerHosts: ['tracker.example'],
      },
      keeper: { policy: 'smallest' },
    })
    expect(store.file().guards.minRatio).toBe(1)

    const res = await put({ guards: { minRatio: 2 } })
    expect(res.statusCode).toBe(200)
    // The response is the whole SettingsView after the merge, not an echo of the patch.
    expect(res.json()).toEqual({
      guards: {
        minRatio: 2, minSeedTimeDays: 7, protectedCategories: ['keep'], protectedTags: ['pinned'],
        privateTrackerHosts: ['tracker.example'],
      },
      keeper: { policy: 'smallest' },
      trash: { maxBytes: store.file().trash.maxBytes, retentionDays: store.file().trash.retentionDays },
    })
    // Live: the same store the planner reads, with no restart and no explicit reload.
    expect(store.file().guards.minRatio).toBe(2)
    expect(store.file().guards.minSeedTimeDays).toBe(7)
    // And durable: it is in config.json, not just in a cache.
    expect(onDisk().guards.minRatio).toBe(2)
    expect(onDisk().guards.minSeedTimeDays).toBe(7)
    expect((await build().inject({ method: 'GET', url: '/api/config/settings', headers: auth() })).json().guards.minRatio).toBe(2)

    for (const guards of [{ minRatio: -0.5 }, { minSeedTimeDays: -1 }]) {
      const rejected = await put({ guards })
      expect(rejected.statusCode).toBe(400)
      expect(rejected.json().error).toBeTruthy()
    }
    // Nothing a rejected request carried was applied.
    expect(store.file().guards.minRatio).toBe(2)
    expect(store.file().guards.minSeedTimeDays).toBe(7)
  })

  it('applies guards and keeper in one request, and a zero threshold is allowed', async () => {
    const res = await put({ guards: { minRatio: 0, minSeedTimeDays: 0 }, keeper: { policy: 'none' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().guards).toMatchObject({ minRatio: 0, minSeedTimeDays: 0 })
    expect(res.json().keeper).toEqual({ policy: 'none' })
    expect(store.file().keeper.policy).toBe('none')
  })

  it('replaces a list wholesale, so a list can be emptied', async () => {
    writeConfig({ guards: { protectedTags: ['a', 'b'], protectedCategories: ['x'] } })
    const res = await put({ guards: { protectedTags: ['c'] } })
    expect(res.json().guards.protectedTags).toEqual(['c'])
    expect(res.json().guards.protectedCategories).toEqual(['x'])

    const emptied = await put({ guards: { protectedTags: [] } })
    expect(emptied.json().guards.protectedTags).toEqual([])
    expect(store.file().guards.protectedTags).toEqual([])
  })

  it('leaves the rest of config.json alone', async () => {
    const mapping = { role: 'library', jellyfin: '/media', container: '/mnt/m', qbit: null, qbitInstance: null }
    writeConfig({ scanCron: '5 4 * * *', pathMappings: [mapping], trash: { retentionDays: 9 } })
    // The change itself must have landed, or "everything else is unchanged" proves nothing.
    expect((await put({ guards: { minRatio: 3 } })).statusCode).toBe(200)
    expect(store.file().guards.minRatio).toBe(3)
    expect(store.file().scanCron).toBe('5 4 * * *')
    expect(store.file().pathMappings).toEqual([mapping])
    expect(store.file().trash.retentionDays).toBe(9)
  })

  it('accepts an empty patch and reports the current view', async () => {
    writeConfig({ guards: { minRatio: 4 } })
    const res = await put({})
    expect(res.statusCode).toBe(200)
    expect(res.json().guards.minRatio).toBe(4)
  })

  it.each([
    ['a string where a number belongs', { guards: { minRatio: '2' } }],
    ['a non-array list', { guards: { protectedTags: 'a' } }],
    ['a non-string list entry', { guards: { protectedCategories: [1] } }],
    ['an unknown keeper policy', { keeper: { policy: 'newest' } }],
    ['a group the contract does not make editable', { trash: { retentionDays: 5 } }],
    ['a key the group does not have', { guards: { minRatoi: 2 } }],
    ['a top-level key that is not a settings group', { scanCron: '* * * * *' }],
    ['a body that is not an object', []],
  ])('rejects %s with a 400 and applies nothing', async (_label, body) => {
    writeConfig({ guards: { minRatio: 1.5 } })
    const before = readFileSync(join(dir, 'config.json'), 'utf8')
    const res = await put(body)
    expect(res.statusCode).toBe(400)
    expect(readFileSync(join(dir, 'config.json'), 'utf8')).toBe(before)
  })

  // JSON has no Infinity, but JSON.parse('1e999') is one. JSON.stringify turns it back into
  // `null`, which would be written into config.json and make the file unreadable — for the guard
  // thresholds, on a route whose whole job is editing them.
  it('rejects a number too large to store, instead of writing a config.json that no longer loads', async () => {
    writeConfig({ guards: { minRatio: 1.5 } })
    const res = await build().inject({
      method: 'PUT', url: '/api/config/settings',
      headers: { ...auth(), 'content-type': 'application/json' },
      payload: '{"guards":{"minSeedTimeDays":1e999}}',
    })
    expect(res.statusCode).toBe(400)
    expect(store.file().guards.minRatio).toBe(1.5)
  })
})

describe('GET /api/config/thresholds (compat)', () => {
  it('requires a session', async () => {
    expect((await build().inject({ method: 'GET', url: '/api/config/thresholds' })).statusCode).toBe(401)
  })

  it('reports the guard and trash thresholds actually in force, never a value that could edit them', async () => {
    const res = await build().inject({ method: 'GET', url: '/api/config/thresholds', headers: auth() })
    expect(res.statusCode).toBe(200)
    const parsed = fileConfigSchema.parse({})
    expect(res.json()).toEqual({
      minRatio: parsed.guards.minRatio,
      minSeedTimeDays: parsed.guards.minSeedTimeDays,
      protectedCategories: parsed.guards.protectedCategories,
      protectedTags: parsed.guards.protectedTags,
      trashMaxBytes: parsed.trash.maxBytes,
      trashRetentionDays: parsed.trash.retentionDays,
    })
  })

  // This route keeps the shape it had in plans.ts for any caller written against it: the private
  // tracker host list is NOT part of it (the settings route above is where the operator sees it).
  // Configured non-empty here, unlike the all-defaults test above, because an empty array leaking
  // looks identical to no leak at all.
  it('never publishes the private tracker host list', async () => {
    writeConfig({ guards: { privateTrackerHosts: ['tracker.example', 'secret.example'] } })
    const res = await build().inject({ method: 'GET', url: '/api/config/thresholds', headers: auth() })
    expect(res.statusCode).toBe(200)
    expect(res.json()).not.toHaveProperty('privateTrackerHosts')
    expect(JSON.stringify(res.json())).not.toContain('tracker.example')
  })

  it('follows a settings change without a restart', async () => {
    await put({ guards: { minRatio: 2.5, minSeedTimeDays: 30 } })
    const res = await build().inject({ method: 'GET', url: '/api/config/thresholds', headers: auth() })
    expect(res.json()).toMatchObject({ minRatio: 2.5, minSeedTimeDays: 30 })
  })
})
