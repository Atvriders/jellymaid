// tests/config/load.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, saveConfig, tempConfigPath, ConfigError } from '../../src/config/load.js'

let dir: string
const baseEnv = () => ({
  DATA_DIR: dir,
  JELLYFIN_URL: 'http://jf:8096',
  JELLYFIN_API_KEY: 'k',
  QBIT_URL: 'http://qb:8080',
  QBIT_USER: 'u',
  QBIT_PASS: 'p',
})

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'jm-cfg-')) })

describe('loadConfig', () => {
  it('applies documented defaults when config.json is absent', () => {
    const cfg = loadConfig(baseEnv())
    expect(cfg.file.scanCron).toBe('0 3 * * *')
    expect(cfg.file.guards.minRatio).toBe(1.0)
    expect(cfg.file.guards.minSeedTimeDays).toBe(14)
    expect(cfg.file.trash.maxBytes).toBe(1_073_741_824)
    expect(cfg.file.trash.retentionDays).toBe(30)
    expect(cfg.file.rules['dupe.fuzzy-title'].similarity).toBe(0.88)
    expect(cfg.file.pathMappings).toEqual([])
  })

  it('reports every missing required secret in one error', () => {
    let caught: unknown
    try { loadConfig({ DATA_DIR: dir }) } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(ConfigError)
    const msg = (caught as ConfigError).message
    for (const k of ['JELLYFIN_URL', 'JELLYFIN_API_KEY', 'QBIT_URL', 'QBIT_USER', 'QBIT_PASS']) {
      expect(msg).toContain(k)
    }
  })

  it('treats Radarr and Sonarr as optional', () => {
    const cfg = loadConfig(baseEnv())
    expect(cfg.env.radarr).toBeNull()
    expect(cfg.env.sonarr).toBeNull()
    const withArr = loadConfig({ ...baseEnv(), RADARR_URL: 'http://r:7878', RADARR_API_KEY: 'rk' })
    expect(withArr.env.radarr).toEqual({ url: 'http://r:7878', apiKey: 'rk' })
  })

  it('rejects a half-configured *arr instead of silently ignoring it', () => {
    expect(() => loadConfig({ ...baseEnv(), RADARR_URL: 'http://r:7878' })).toThrow(/RADARR_API_KEY/)
  })

  it('merges config.json over defaults without dropping unspecified keys', () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ scanCron: '30 4 * * *' }))
    const cfg = loadConfig(baseEnv())
    expect(cfg.file.scanCron).toBe('30 4 * * *')
    expect(cfg.file.guards.minRatio).toBe(1.0)
  })

  it('rejects a download mapping that declares a jellyfin path', () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      pathMappings: [{ role: 'download', jellyfin: '/media/X', container: '/mnt/d', qbit: '/downloads' }],
    }))
    expect(() => loadConfig(baseEnv())).toThrow(/download/i)
  })

  it('rejects a library mapping without a jellyfin path', () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      pathMappings: [{ role: 'library', jellyfin: null, container: '/mnt/m', qbit: null }],
    }))
    expect(() => loadConfig(baseEnv())).toThrow(/library/i)
  })

  it('reads TRUST_PROXY as a hop count, not a boolean', () => {
    // Fastify treats a number as "trust N hops from the right", which makes the RIGHTMOST
    // X-Forwarded-For token authoritative. `true` would take the caller-supplied leftmost one.
    expect(loadConfig(baseEnv()).env.trustProxy).toBe(0)
    expect(loadConfig({ ...baseEnv(), TRUST_PROXY: '0' }).env.trustProxy).toBe(0)
    expect(loadConfig({ ...baseEnv(), TRUST_PROXY: 'false' }).env.trustProxy).toBe(0)
    expect(loadConfig({ ...baseEnv(), TRUST_PROXY: '1' }).env.trustProxy).toBe(1)
    expect(loadConfig({ ...baseEnv(), TRUST_PROXY: 'true' }).env.trustProxy).toBe(1)
    expect(loadConfig({ ...baseEnv(), TRUST_PROXY: '3' }).env.trustProxy).toBe(3)
    expect(typeof loadConfig({ ...baseEnv(), TRUST_PROXY: 'true' }).env.trustProxy).toBe('number')
  })

  it('refuses a TRUST_PROXY that is neither a boolean nor an integer', () => {
    // Silently defaulting to 0 would be a misconfiguration nobody notices; silently defaulting
    // to "trust everything" would hand the lockout key to the caller.
    expect(() => loadConfig({ ...baseEnv(), TRUST_PROXY: 'yes' })).toThrow(ConfigError)
    expect(() => loadConfig({ ...baseEnv(), TRUST_PROXY: 'yes' })).toThrow(/TRUST_PROXY/)
    expect(() => loadConfig({ ...baseEnv(), TRUST_PROXY: '-1' })).toThrow(ConfigError)
    expect(() => loadConfig({ ...baseEnv(), TRUST_PROXY: '1.5' })).toThrow(ConfigError)
  })

  it('rejects a path mapping whose container is not absolute, or is the filesystem root', () => {
    const withMappings = (m: unknown) => {
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ pathMappings: [m] }))
      return () => loadConfig(baseEnv())
    }
    expect(withMappings({ role: 'library', jellyfin: '/media/M', container: 'media', qbit: null })).toThrow(/absolute/i)
    expect(withMappings({ role: 'library', jellyfin: '/media/M', container: '/', qbit: null })).toThrow(/filesystem root/i)
    expect(withMappings({ role: 'library', jellyfin: 'media/M', container: '/mnt/m', qbit: null })).toThrow(/absolute/i)
    expect(withMappings({ role: 'download', jellyfin: null, container: '/mnt/d', qbit: 'downloads' })).toThrow(/absolute/i)
  })

  it('reuses an existing .session-secret rather than minting a second one', () => {
    const first = loadConfig(baseEnv()).env.sessionSecret
    const second = loadConfig(baseEnv()).env.sessionSecret
    expect(second).toBe(first)
    expect(readFileSync(join(dir, '.session-secret'), 'utf8').trim()).toBe(first)
  })

  it('creates .session-secret exclusively, so a concurrent loader cannot mint a second one', () => {
    // The loser of an existsSync-then-write race would silently invalidate every live session.
    const preexisting = 'f'.repeat(64)
    writeFileSync(join(dir, '.session-secret'), preexisting)
    expect(loadConfig(baseEnv()).env.sessionSecret).toBe(preexisting)
    expect(readFileSync(join(dir, '.session-secret'), 'utf8')).toBe(preexisting)
  })

  it('reports malformed config.json as a ConfigError, not a raw SyntaxError', () => {
    writeFileSync(join(dir, 'config.json'), '{ not valid json')
    let caught: unknown
    try { loadConfig(baseEnv()) } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(ConfigError)
    expect((caught as ConfigError).message).toMatch(/not valid JSON/)
  })
})

describe('saveConfig', () => {
  it('persists a patch and leaves other keys at their prior values', () => {
    saveConfig(dir, { scanCron: '0 5 * * *' })
    saveConfig(dir, { trash: { maxBytes: 500, retentionDays: 7 } })
    const written = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
    expect(written.scanCron).toBe('0 5 * * *')
    expect(written.trash.maxBytes).toBe(500)
  })

  it('replaces config.json by rename rather than writing it in place', () => {
    // Observe the MECHANISM, not just that a value round-trips — a plain writeFileSync would
    // round-trip too, while leaving a window in which config.json is truncated. A rename swaps
    // in a different inode; an in-place write keeps the same one.
    saveConfig(dir, { scanCron: '0 6 * * *' })
    const before = statSync(join(dir, 'config.json')).ino
    saveConfig(dir, { scanCron: '0 7 * * *' })
    const after = statSync(join(dir, 'config.json')).ino
    expect(after).not.toBe(before)
    expect(loadConfig(baseEnv()).file.scanCron).toBe('0 7 * * *')
    // Nothing is left behind for the next reader to trip over.
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('uses a temp filename unique per call, not merely per process', () => {
    // Worker threads share a pid, so a pid-only temp name would have two concurrent savers
    // writing the same temp file and renaming a torn copy into place.
    const a = tempConfigPath(dir)
    const b = tempConfigPath(dir)
    expect(a).not.toBe(b)
    expect(a).toMatch(/\.tmp$/)
  })

  it('rejects an invalid patch as a ConfigError, not a raw ZodError', () => {
    expect(() => saveConfig(dir, {
      pathMappings: [{ role: 'library', jellyfin: null, container: '/mnt/m', qbit: null }],
    } as never)).toThrow(ConfigError)
  })
})
