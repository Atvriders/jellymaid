import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildServer } from '../../src/server.js'
import { openDb } from '../../src/index/db.js'
import { createLogger } from '../../src/core/logger.js'
import { fileConfigSchema } from '../../src/config/schema.js'
import { signSession } from '../../src/auth/session.js'

const SECRET = 'y'.repeat(32)

function app() {
  const dir = mkdtempSync(join(tmpdir(), 'jm-pmapi-'))
  return buildServer({
    config: {
      env: {
        dataDir: dir, port: 0, trustProxy: false, sessionSecret: SECRET,
        jellyfin: { url: 'http://jf', apiKey: 'k' },
        qbittorrent: { url: 'http://qb', user: 'u', pass: 'p' },
        radarr: null, sonarr: null,
      },
      file: fileConfigSchema.parse({}),
    },
    db: openDb(join(dir, 'db.sqlite')),
    jellyfin: {
      ping: async () => {},
      items: async () => ({ items: [], totalRecordCount: 0 }),
    } as never,
    logger: createLogger({ level: 'error', sink: () => {} }),
  })
}

const authCookie = () => `jellymaid_session=${signSession({ username: 'bob', userId: 'u', issuedAt: Date.now() }, SECRET)}`

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

  it('verifies mappings and reports the failures', async () => {
    const a = app()
    await a.inject({
      method: 'PUT', url: '/api/pathmap', headers: { cookie: authCookie() },
      payload: { mappings: [{ role: 'library', jellyfin: '/media/Movies', container: '/nope', qbit: null }] },
    })
    const res = await a.inject({ method: 'POST', url: '/api/pathmap/verify', headers: { cookie: authCookie() } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveProperty('sampled')
    expect(res.json()).toHaveProperty('failures')
  })
})
