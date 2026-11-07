import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, configPath, ConfigError } from '../../src/config/load.js'
import { createConfigStore } from '../../src/config/store.js'
import { mappingsHash, normalizeMappings } from '../../src/fs/pathmap.js'

let dir: string

function envFor(instances = 'box-a=http://198.51.100.10:8080') {
  return loadConfig({
    DATA_DIR: dir, JELLYFIN_URL: 'http://198.51.100.20:8096', JELLYFIN_API_KEY: 'k', QBIT_INSTANCES: instances,
  }).env
}

const legacyDownload = { role: 'download', jellyfin: null, container: '/path/to/dl', qbit: '/downloads' }

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'jm-store-')) })

describe('createConfigStore', () => {
  it('sees an edit to config.json without a restart, and rebuilds the path map from it', () => {
    const store = createConfigStore(envFor())
    expect(store.file().scanCron).toBe('0 3 * * *')
    expect(store.pathMap().all()).toEqual([])

    writeFileSync(configPath(dir), JSON.stringify({ scanCron: '0 5 * * *', pathMappings: [legacyDownload] }))
    expect(store.file().scanCron).toBe('0 5 * * *')
    expect(store.pathMap().qbitToContainer('box-a', '/downloads/Heat.mkv')).toBe('/path/to/dl/Heat.mkv')

    writeFileSync(configPath(dir), JSON.stringify({ scanCron: '15 5 * * *' }))
    expect(store.file().scanCron).toBe('15 5 * * *')
    expect(store.pathMap().all()).toEqual([])
  })

  it('throws ConfigError for an invalid edit, and recovers once the file is fixed', () => {
    const store = createConfigStore(envFor())
    store.file()
    writeFileSync(configPath(dir), '{ not json')
    expect(() => store.file()).toThrow(ConfigError)
    writeFileSync(configPath(dir), JSON.stringify({ pathMappings: [{ role: 'library', jellyfin: null, container: '/path/to/m', qbit: null }] }))
    expect(() => store.file()).toThrow(ConfigError)
    expect(() => store.pathMap()).toThrow(ConfigError)
    writeFileSync(configPath(dir), JSON.stringify({ scanCron: '0 6 * * *' }))
    expect(store.file().scanCron).toBe('0 6 * * *')
  })

  it('serves the cached config and path map while the file is unchanged', () => {
    writeFileSync(configPath(dir), JSON.stringify({ pathMappings: [legacyDownload] }))
    const store = createConfigStore(envFor())
    expect(store.file()).toBe(store.file())
    expect(store.pathMap()).toBe(store.pathMap())
  })

  it('keeps the same path map across an edit that leaves the mappings alone', () => {
    writeFileSync(configPath(dir), JSON.stringify({ pathMappings: [legacyDownload] }))
    const store = createConfigStore(envFor())
    const before = store.pathMap()
    writeFileSync(configPath(dir), JSON.stringify({ scanCron: '45 1 * * *', pathMappings: [legacyDownload] }))
    expect(store.file().scanCron).toBe('45 1 * * *')
    expect(store.pathMap()).toBe(before)
  })

  it('fills a legacy mapping with the only instance, and reports nothing', () => {
    writeFileSync(configPath(dir), JSON.stringify({ pathMappings: [legacyDownload] }))
    const store = createConfigStore(envFor())
    expect(store.pathMap().all()[0]!.qbitInstance).toBe('box-a')
    expect(store.mappingProblems()).toEqual([])
  })

  it('leaves a legacy mapping unfilled, and reports it, when two instances could own it', () => {
    writeFileSync(configPath(dir), JSON.stringify({ pathMappings: [legacyDownload] }))
    const store = createConfigStore(envFor('box-a=http://198.51.100.10:8080,box-b=http://198.51.100.11:8080'))
    expect(store.pathMap().all()[0]!.qbitInstance).toBeNull()
    expect(store.pathMap().qbitToContainer('box-a', '/downloads/Heat.mkv')).toBeNull()
    expect(store.pathMap().qbitToContainer('box-b', '/downloads/Heat.mkv')).toBeNull()
    expect(store.mappingProblems()).toHaveLength(1)
  })

  it('hashes the NORMALIZED mappings', () => {
    writeFileSync(configPath(dir), JSON.stringify({ pathMappings: [legacyDownload] }))
    const store = createConfigStore(envFor())
    const normalized = normalizeMappings(store.file().pathMappings, ['box-a']).mappings
    expect(store.mappingsHash()).toBe(mappingsHash(normalized))
    expect(store.mappingsHash()).not.toBe(mappingsHash(store.file().pathMappings))
  })

  it('lists the configured instance ids in environment order', () => {
    const store = createConfigStore(envFor('box-b=http://198.51.100.11:8080,box-a=http://198.51.100.10:8080'))
    expect(store.instanceIds()).toEqual(['box-b', 'box-a'])
    expect(store.env.qbittorrents.map((i) => i.id)).toEqual(['box-b', 'box-a'])
  })

  it('save() writes through to config.json and is visible at once', () => {
    const store = createConfigStore(envFor())
    store.file()
    const saved = store.save({ scanCron: '0 2 * * *', pathMappings: [{ ...legacyDownload, role: 'download', qbitInstance: null }] as never })
    expect(saved.scanCron).toBe('0 2 * * *')
    expect(store.file().scanCron).toBe('0 2 * * *')
    expect(JSON.parse(readFileSync(configPath(dir), 'utf8')).scanCron).toBe('0 2 * * *')
    expect(store.pathMap().qbitToContainer('box-a', '/downloads/x.mkv')).toBe('/path/to/dl/x.mkv')
  })

  it('save() keeps the siblings of a partially patched subtree', () => {
    const store = createConfigStore(envFor())
    store.save({ guards: { minRatio: 2 } } as never)
    expect(store.file().guards.minRatio).toBe(2)
    expect(store.file().guards.minSeedTimeDays).toBe(14)
  })
})
