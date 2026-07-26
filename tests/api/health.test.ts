import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildServer } from '../../src/server.js'
import { openDb } from '../../src/index/db.js'
import { createLogger } from '../../src/core/logger.js'
import { fileConfigSchema } from '../../src/config/schema.js'

function testDeps(pingImpl: () => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'jm-srv-'))
  return {
    config: {
      env: {
        dataDir: dir, port: 0, trustProxy: false, sessionSecret: 'x'.repeat(32),
        jellyfin: { url: 'http://jf', apiKey: 'k' },
        qbittorrent: { url: 'http://qb', user: 'u', pass: 'p' },
        radarr: null, sonarr: null,
      },
      file: fileConfigSchema.parse({}),
    },
    db: openDb(join(dir, 'db.sqlite')),
    jellyfin: { ping: pingImpl } as never,
    logger: createLogger({ level: 'error', sink: () => {} }),
  }
}

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
})
