import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildServer } from '../../src/server.js'
import { openDb } from '../../src/index/db.js'
import { createLogger } from '../../src/core/logger.js'
import { loadConfig } from '../../src/config/load.js'

/** Builds the real server off the real loader, so the TRUST_PROXY env value is exercised end to end. */
function serverFor(trustProxyEnv?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'jm-proxy-'))
  const config = loadConfig({
    DATA_DIR: dir,
    JELLYFIN_URL: 'http://jf:8096', JELLYFIN_API_KEY: 'k',
    QBIT_URL: 'http://qb:8080', QBIT_USER: 'u', QBIT_PASS: 'p',
    ...(trustProxyEnv === undefined ? {} : { TRUST_PROXY: trustProxyEnv }),
  })
  const app = buildServer({
    config,
    db: openDb(join(dir, 'db.sqlite')),
    jellyfin: { ping: async () => {}, items: async () => ({ items: [], totalRecordCount: 0 }) } as never,
    logger: createLogger({ level: 'error', sink: () => {} }),
  })
  // The login lockout keys on req.ip; this echoes exactly the value it would key on.
  app.get('/__ip', async (req) => ({ ip: req.ip }))
  return app
}

describe('trustProxy hop count', () => {
  it('takes the RIGHTMOST X-Forwarded-For token, never the caller-supplied leftmost one', async () => {
    const app = serverFor('1')
    const res = await app.inject({
      method: 'GET', url: '/__ip',
      headers: { 'x-forwarded-for': '9.9.9.9, 10.0.0.5' },
      remoteAddress: '127.0.0.1',
    })
    // 9.9.9.9 is whatever the caller typed. If the lockout keyed on it, an attacker would
    // mint a fresh lockout bucket per request and never trip the 3-in-5-minutes limit.
    expect(res.json().ip).not.toBe('9.9.9.9')
    expect(res.json().ip).toBe('10.0.0.5')
  })

  it('ignores X-Forwarded-For entirely when TRUST_PROXY is unset', async () => {
    const app = serverFor()
    const res = await app.inject({
      method: 'GET', url: '/__ip',
      headers: { 'x-forwarded-for': '9.9.9.9, 10.0.0.5' },
      remoteAddress: '127.0.0.1',
    })
    expect(res.json().ip).toBe('127.0.0.1')
  })

  it('peels exactly as many hops as configured', async () => {
    const app = serverFor('2')
    const res = await app.inject({
      method: 'GET', url: '/__ip',
      headers: { 'x-forwarded-for': '9.9.9.9, 10.0.0.5, 10.0.0.6' },
      remoteAddress: '127.0.0.1',
    })
    expect(res.json().ip).toBe('10.0.0.5')
  })
})
