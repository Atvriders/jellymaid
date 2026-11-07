import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { buildServer } from '../../src/server.js'
import { openDb } from '../../src/index/db.js'
import { createLogger } from '../../src/core/logger.js'
import { createConfigStore } from '../../src/config/store.js'

// Same stub-deps shape as tests/api/health.test.ts, plus `clientDir` pointing at a temp
// directory containing a built SPA's index.html.
function testDeps(clientDir: string) {
  const dir = mkdtempSync(join(tmpdir(), 'jm-srv-static-'))
  return {
    configStore: createConfigStore({
      dataDir: dir, port: 0, trustProxy: 0, sessionSecret: 'x'.repeat(32),
      jellyfin: { url: 'http://jf', apiKey: 'k' },
      qbittorrents: [{ id: 'box-a', url: 'http://qb', user: null, pass: null }],
      radarr: null, sonarr: null,
    }),
    db: openDb(join(dir, 'db.sqlite')),
    jellyfin: { ping: async () => {} } as never,
    qbittorrents: new Map([['box-a', { ping: async () => ({ version: 'v5.2.2' }), torrents: async () => [] }]]),
    radarr: null,
    sonarr: null,
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

  // CRITICAL 1 (@fastify/static upgrade, 4 high-severity advisories fixed in v9.1.1/v10.1.1/v10.1.2):
  // the real-world stakes are that `/data/.session-secret` sits on the same container as this
  // static root. None of the fixed advisories are a root-escape in this app's own configuration
  // (they are all timing bugs in a caller-registered `allowedPath`/route-guard check, and this
  // route registers no such guard on top of @fastify/static) — but a plain traversal attempt out of
  // `clientDir`, encoded or not, must still never reach a file that lives next to it. Defense in
  // depth for the exact shape of file this app keeps beside the served root.
  it('does not escape clientDir to serve a file that merely sits next to it, plain or encoded', async () => {
    const dir = buildClientDir()
    const secretPath = join(dirname(dir), `sibling-secret-${Date.now()}.txt`)
    writeFileSync(secretPath, 'do-not-serve-me')
    const app = buildServer(testDeps(dir))
    const secretName = secretPath.slice(dirname(dir).length + 1)
    for (const url of [`/../${secretName}`, `/%2e%2e/${secretName}`, `/..%2f${secretName}`]) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.body).not.toBe('do-not-serve-me')
    }
  })
})
