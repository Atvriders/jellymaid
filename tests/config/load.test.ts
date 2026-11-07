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

  it('reports every missing required setting in one error', () => {
    let caught: unknown
    try { loadConfig({ DATA_DIR: dir }) } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(ConfigError)
    const msg = (caught as ConfigError).message
    for (const k of ['JELLYFIN_URL', 'JELLYFIN_API_KEY', 'QBIT_INSTANCES', 'QBIT_URL']) {
      expect(msg).toContain(k)
    }
    // qBittorrent credentials are optional now: an instance that bypasses auth for this host needs none.
    expect(msg).not.toContain('QBIT_USER is required')
    expect(msg).not.toContain('QBIT_PASS is required')
  })

  it('defaults the keeper policy to best-quality, bad-naming to off, and qBittorrent to 4 concurrent / 25ms', () => {
    const cfg = loadConfig(baseEnv())
    expect(cfg.file.keeper).toEqual({ policy: 'best-quality' })
    expect(cfg.file.rules['meta.bad-naming'].enabled).toBe(false)
    expect(cfg.file.rateLimits.qbittorrent).toEqual({ concurrency: 4, minDelayMs: 25 })
  })

  it('reads a mapping without qbitInstance as qbitInstance null', () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      pathMappings: [{ role: 'download', jellyfin: null, container: '/path/to/dl', qbit: '/downloads' }],
    }))
    expect(loadConfig(baseEnv()).file.pathMappings[0]!.qbitInstance).toBeNull()
  })

  it('rejects a qbitInstance without a qbit prefix, and an instance id that breaks the id pattern', () => {
    const withMapping = (m: unknown) => {
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ pathMappings: [m] }))
      return () => loadConfig(baseEnv())
    }
    expect(withMapping({ role: 'download', jellyfin: null, container: '/path/to/dl', qbit: null, qbitInstance: 'box-a' }))
      .toThrow(/qbitInstance/)
    expect(withMapping({ role: 'download', jellyfin: null, container: '/path/to/dl', qbit: '/downloads', qbitInstance: 'Box_A' }))
      .toThrow(ConfigError)
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

  it('rejects a container that is textually absolute but NORMALIZES to the filesystem root', () => {
    // The root guard used to be a plain `container === '/'` string comparison, while `absolutePath`
    // only checks `startsWith('/')`. "/..", "//", and "/mnt/../.." all pass that check and then
    // resolve to "/" — putting the entire filesystem inside a later plan's delete-sweep boundary.
    const withMappings = (container: string) => {
      writeFileSync(join(dir, 'config.json'), JSON.stringify({
        pathMappings: [{ role: 'library', jellyfin: '/media/M', container, qbit: null }],
      }))
      return () => loadConfig(baseEnv())
    }
    expect(withMappings('/..')).toThrow(/filesystem root/i)
    expect(withMappings('//')).toThrow(/filesystem root/i)
    expect(withMappings('/mnt/../..')).toThrow(/filesystem root/i)
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

  it('writes .session-secret via a temp file plus rename, leaving nothing behind', () => {
    // A plain create-then-write ('wx') is not atomic to a concurrent reader: the loser of the
    // race could read an empty or torn file mid-write. Writing the full secret to a temp file
    // and renaming it into place closes that window entirely — a reader only ever sees "absent"
    // or "fully written".
    loadConfig(baseEnv())
    const entries = readdirSync(dir)
    expect(entries).toContain('.session-secret')
    expect(entries.filter((f) => f.includes('.session-secret.') && f.endsWith('.tmp'))).toEqual([])
    expect(readFileSync(join(dir, '.session-secret'), 'utf8').trim().length).toBeGreaterThanOrEqual(16)
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

  it('merges guards one level deep, so patching one threshold keeps its siblings', () => {
    saveConfig(dir, { guards: { minRatio: 1, minSeedTimeDays: 30, privateTrackerHosts: ['t.example'], protectedCategories: [], protectedTags: [] } })
    const saved = saveConfig(dir, { guards: { minRatio: 2 } } as never)
    expect(saved.guards.minRatio).toBe(2)
    expect(saved.guards.minSeedTimeDays).toBe(30)
    expect(saved.guards.privateTrackerHosts).toEqual(['t.example'])
    expect(loadConfig(baseEnv()).file.guards.minSeedTimeDays).toBe(30)
  })

  it('merges trash, keeper, rateLimits and rules one level deep too, with arrays and nested objects replaced', () => {
    saveConfig(dir, { rules: { 'fs.junk': { namePatterns: ['x'], extensions: ['.part'], directoryNames: ['proof'], zeroByteIsJunk: false } } } as never)
    const saved = saveConfig(dir, {
      trash: { retentionDays: 7 },
      keeper: { policy: 'smallest' },
      rateLimits: { qbittorrent: { concurrency: 1, minDelayMs: 500 } },
      rules: { 'quality.biggest': { enabled: false, topN: 10 } },
    } as never)
    expect(saved.trash).toEqual({ maxBytes: 1_073_741_824, retentionDays: 7 })
    expect(saved.keeper).toEqual({ policy: 'smallest' })
    expect(saved.rateLimits.qbittorrent).toEqual({ concurrency: 1, minDelayMs: 500 })
    expect(saved.rateLimits.jellyfin).toEqual({ concurrency: 4, minDelayMs: 50 })
    // One level deep: the earlier fs.junk edit survives a patch that names only quality.biggest.
    expect(saved.rules['fs.junk'].zeroByteIsJunk).toBe(false)
    expect(saved.rules['quality.biggest']).toEqual({ enabled: false, topN: 10 })
  })

  it('replaces every other key wholesale, pathMappings included', () => {
    saveConfig(dir, { pathMappings: [{ role: 'library', jellyfin: '/media/A', container: '/path/to/a', qbit: null, qbitInstance: null }] })
    const saved = saveConfig(dir, { pathMappings: [{ role: 'library', jellyfin: '/media/B', container: '/path/to/b', qbit: null, qbitInstance: null }] })
    expect(saved.pathMappings.map((m) => m.container)).toEqual(['/path/to/b'])
  })

  it('rejects an invalid patch as a ConfigError, not a raw ZodError', () => {
    expect(() => saveConfig(dir, {
      pathMappings: [{ role: 'library', jellyfin: null, container: '/mnt/m', qbit: null }],
    } as never)).toThrow(ConfigError)
  })
})
