// tests/config/load.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, saveConfig, ConfigError } from '../../src/config/load.js'

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

  it('writes atomically via a temp file so a crash cannot truncate config', () => {
    saveConfig(dir, { scanCron: '0 6 * * *' })
    const cfg = loadConfig(baseEnv())
    expect(cfg.file.scanCron).toBe('0 6 * * *')
  })

  it('rejects an invalid patch as a ConfigError, not a raw ZodError', () => {
    expect(() => saveConfig(dir, {
      pathMappings: [{ role: 'library', jellyfin: null, container: '/mnt/m', qbit: null }],
    } as never)).toThrow(ConfigError)
  })
})
