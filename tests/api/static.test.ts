import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildServer } from '../../src/server.js'
import { openDb } from '../../src/index/db.js'
import { createLogger } from '../../src/core/logger.js'
import { fileConfigSchema } from '../../src/config/schema.js'

// Same stub-deps shape as tests/api/health.test.ts, plus `clientDir` pointing at a temp
// directory containing a built SPA's index.html.
function testDeps(clientDir: string) {
  const dir = mkdtempSync(join(tmpdir(), 'jm-srv-static-'))
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
    jellyfin: { ping: async () => {} } as never,
    logger: createLogger({ level: 'error', sink: () => {} }),
    scanRunner: {
      start: () => ({ scanId: 1 }), cancel: () => false, isRunning: () => false,
      status: () => ({ running: false, scanId: null, phase: null, done: 0, total: null, lastScan: null }),
    } as never,
    plannerDeps: (() => ({})) as never,
    trashDeps: (() => ({})) as never,
    executor: {} as never,
    clientDir,
  }
}

function buildClientDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jm-client-dist-'))
  writeFileSync(join(dir, 'index.html'), '<div id="root"></div>')
  return dir
}

describe('spa fallback', () => {
  it('serves index.html for an unknown non-api path', async () => {
    const app = buildServer(testDeps(buildClientDir()))
    const res = await app.inject({ method: 'GET', url: '/findings' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('<div id="root"></div>')
  })

  it('serves index.html for a deep client-side route too', async () => {
    const app = buildServer(testDeps(buildClientDir()))
    const res = await app.inject({ method: 'GET', url: '/plan/some-nested-thing' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('<div id="root"></div>')
  })

  it('still 404s an unknown /api path as JSON', async () => {
    const app = buildServer(testDeps(buildClientDir()))
    const res = await app.inject({ method: 'GET', url: '/api/no-such-route' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'not found' })
  })

  it('still 404s an unknown /healthz-prefixed path as JSON, not the SPA shell', async () => {
    const app = buildServer(testDeps(buildClientDir()))
    const res = await app.inject({ method: 'GET', url: '/healthz/nope' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'not found' })
  })

  it('serves an actual built asset by its real path, not the SPA shell', async () => {
    const dir = buildClientDir()
    mkdirSync(join(dir, 'assets'), { recursive: true })
    writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log("hi")')
    const app = buildServer(testDeps(dir))
    const res = await app.inject({ method: 'GET', url: '/assets/index-abc123.js' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('console.log("hi")')
  })

  it('does not register static serving at all when clientDir does not exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jm-client-dist-missing-'))
    const app = buildServer({ ...testDeps(join(dir, 'does-not-exist')) })
    const res = await app.inject({ method: 'GET', url: '/findings' })
    // No SPA to fall back to, and no fastify-static registered to shadow the default 404 —
    // Fastify's own default not-found handler applies.
    expect(res.statusCode).toBe(404)
  })
})
