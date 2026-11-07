import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exec as execCb } from 'node:child_process'
import { promisify } from 'node:util'
import Fastify from 'fastify'
import { buildServer, type ServerDeps } from '../../src/server.js'
import { openDb } from '../../src/index/db.js'
import { createLogger } from '../../src/core/logger.js'
import { createConfigStore } from '../../src/config/store.js'

const exec = promisify(execCb)

const dockerfile = () => readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8')

/**
 * Pulls the LITERAL command string out of the Dockerfile's HEALTHCHECK instruction — never a
 * hand-copied stand-in. The whole point of this file (see the ALSO finding this repo's audit
 * raised: "nothing pins the HEALTHCHECK expression against /healthz's actual shape") is that if a
 * future edit reshapes the /healthz response and nobody updates this string to match, this
 * extraction still reflects whatever actually ships — only running it against a live server (below)
 * can catch that drift.
 */
function healthcheckCommand(): string {
  const m = dockerfile().match(/^HEALTHCHECK[^\n]*\\\s*\n\s*CMD (.+)$/m)
  if (!m) throw new Error('could not find a HEALTHCHECK CMD line in the Dockerfile')
  return m[1] as string
}

type Pingable = { ping: () => Promise<void> } | null

/** The same stub ServerDeps shape tests/api/health.test.ts and tests/server/trust-proxy.test.ts use. */
function stubDeps(overrides: Partial<{ jellyfin: Pingable; qbittorrent: Pingable }> = {}): ServerDeps {
  const dir = mkdtempSync(join(tmpdir(), 'jm-hc-'))
  return {
    configStore: createConfigStore({
      dataDir: dir, port: 0, trustProxy: 0, sessionSecret: 'x'.repeat(32),
      jellyfin: { url: 'http://jf', apiKey: 'k' },
      qbittorrents: [{ id: 'box-a', url: 'http://qb', user: null, pass: null }],
      radarr: null, sonarr: null,
    }),
    db: openDb(join(dir, 'db.sqlite')),
    jellyfin: (overrides.jellyfin ?? { ping: async () => {} }) as never,
    qbittorrents: new Map([['box-a', (overrides.qbittorrent ?? { ping: async () => {} }) as never]]),
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
  }
}

describe('Dockerfile HEALTHCHECK against the real /healthz shape (MAJOR 3 + the ALSO finding)', () => {
  it('exits 0 against a healthy, fully-reachable server', async () => {
    const app = buildServer(stubDeps())
    const address = await app.listen({ port: 0, host: '127.0.0.1' })
    const port = new URL(address).port
    try {
      await expect(exec(healthcheckCommand(), { env: { ...process.env, PORT: port } })).resolves.toBeDefined()
    } finally {
      await app.close()
    }
  })

  it('still exits 0 when a connector is degraded — the healthcheck is liveness-only, not a connector-status oracle', async () => {
    const app = buildServer(
      stubDeps({ jellyfin: { ping: async () => { throw Object.assign(new Error('down'), { kind: 'unreachable' }) } } }),
    )
    const address = await app.listen({ port: 0, host: '127.0.0.1' })
    const port = new URL(address).port
    try {
      await expect(exec(healthcheckCommand(), { env: { ...process.env, PORT: port } })).resolves.toBeDefined()
    } finally {
      await app.close()
    }
  })

  it('exits 1 when nothing is listening at all (process down, the one case that should actually restart it)', async () => {
    await expect(exec(healthcheckCommand(), { env: { ...process.env, PORT: '1' } })).rejects.toMatchObject({ code: 1 })
  })

  it('exits 1 against a well-formed-JSON body that has no `status` field at all — pins the command to the real shape', async () => {
    const app = Fastify()
    app.get('/healthz', async () => ({ ok: true })) // no `status` field, unlike the real route
    const address = await app.listen({ port: 0, host: '127.0.0.1' })
    const port = new URL(address).port
    try {
      await expect(exec(healthcheckCommand(), { env: { ...process.env, PORT: port } })).rejects.toMatchObject({ code: 1 })
    } finally {
      await app.close()
    }
  })
})
