import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildServer } from '../../src/server.js'
import { openDb } from '../../src/index/db.js'
import { createLogger } from '../../src/core/logger.js'
import { loadConfig } from '../../src/config/load.js'
import { createConfigStore } from '../../src/config/store.js'
import { signSession } from '../../src/auth/session.js'

/**
 * What src/server.ts itself is responsible for: that every lane's routes are registered on the real
 * server, with the dependencies they read. The routes' behavior is each route file's own test's job.
 */
function serverFor() {
  const dir = mkdtempSync(join(tmpdir(), 'jm-wiring-'))
  const config = loadConfig({
    DATA_DIR: dir,
    JELLYFIN_URL: 'http://jf:8096', JELLYFIN_API_KEY: 'k',
    QBIT_INSTANCES: 'box-a=http://qb-a:8080,box-b=http://qb-b:8080',
  })
  const lines: string[] = []
  const app = buildServer({
    configStore: createConfigStore(config.env),
    db: openDb(join(dir, 'db.sqlite')),
    jellyfin: {
      ping: async () => {},
      items: async () => ({ items: [], totalRecordCount: 0 }),
      loginRisk: async () => ({ allowed: false, reason: 'one more failure disables the account' }),
      authenticateByName: async () => { throw new Error('must not be attempted') },
    } as never,
    qbittorrents: new Map([
      ['box-a', { ping: async () => ({ version: 'v5.2.2' }), torrents: async () => [] }],
      ['box-b', { ping: async () => ({ version: 'v5.1.2' }), torrents: async () => [] }],
    ]),
    radarr: null,
    sonarr: null,
    logger: createLogger({ level: 'debug', sink: (line) => lines.push(line) }),
    scanRunner: {
      start: () => ({ scanId: 1 }), cancel: () => false, isRunning: () => false,
      status: () => ({ running: false, scanId: null, phase: null, done: 0, total: null, lastScan: null }),
      shutdown: async () => {},
    } as never,
    plannerDeps: (() => ({})) as never,
    trashDeps: (() => ({})) as never,
    executor: {} as never,
  })
  const secret = config.env.sessionSecret
  const cookie = `jellymaid_session=${signSession({ username: 'bob', userId: 'u', issuedAt: Date.now(), isAdministrator: true }, secret)}`
  return { app, lines, headers: { cookie } }
}

describe('server wiring', () => {
  it.each([
    ['GET', '/api/config/settings'],
    ['PUT', '/api/config/settings'],
    ['GET', '/api/config/thresholds'],
    ['GET', '/api/qbit/instances'],
    ['GET', '/api/pathmap'],
    ['GET', '/api/duplicates'],
    ['GET', '/api/explorer'],
    ['POST', '/api/plans'],
    ['POST', '/api/scan/start'],
  ] as const)('registers %s %s (a session is required, so it answers 401 rather than 404)', async (method, url) => {
    const res = await serverFor().app.inject({ method, url })
    expect(res.statusCode).toBe(401)
  })

  it('settings saved through the server are what the next read returns, without a restart', async () => {
    const { app, headers } = serverFor()
    const put = await app.inject({
      method: 'PUT', url: '/api/config/settings', headers,
      payload: { guards: { privateTrackerHosts: ['tracker.example.org'] }, keeper: { policy: 'smallest' } },
    })
    expect(put.statusCode).toBe(200)
    const get = await app.inject({ method: 'GET', url: '/api/config/settings', headers })
    expect(get.json()).toMatchObject({ guards: { privateTrackerHosts: ['tracker.example.org'] }, keeper: { policy: 'smallest' } })
  })

  it('lists every configured qBittorrent instance through the shared clients', async () => {
    const { app, headers } = serverFor()
    const res = await app.inject({ method: 'GET', url: '/api/qbit/instances', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json().instances.map((i: { id: string; reachable: boolean }) => [i.id, i.reachable]))
      .toEqual([['box-a', true], ['box-b', true]])
  })

  it('records a refused login in the process logger, not a logger of its own', async () => {
    const { app, lines } = serverFor()
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'bob', password: 'x' } })
    expect(res.statusCode).toBe(401)
    expect(lines.some((l) => /login refused/.test(l))).toBe(true)
  })
})
