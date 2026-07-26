import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPathMap, verifyMappings, autoDetectMappings } from '../../src/fs/pathmap.js'
import type { PathMapping } from '../../src/core/types.js'

const MAPPINGS: PathMapping[] = [
  { role: 'library', jellyfin: '/media/Movies', container: '/mnt/media/Movies', qbit: '/downloads/movies' },
  { role: 'library', jellyfin: '/media/TV', container: '/mnt/media/TV', qbit: null },
  { role: 'download', jellyfin: null, container: '/mnt/downloads', qbit: '/downloads' },
]

describe('createPathMap', () => {
  const map = createPathMap(MAPPINGS)

  it('translates a jellyfin path to a container path', () => {
    expect(map.toContainer('/media/Movies/Heat (1995)/Heat.mkv')).toBe('/mnt/media/Movies/Heat (1995)/Heat.mkv')
  })

  it('translates back', () => {
    expect(map.fromContainer('/mnt/media/TV/Show/S01E01.mkv')).toBe('/media/TV/Show/S01E01.mkv')
  })

  it('returns null for a path under no mapping rather than guessing', () => {
    expect(map.toContainer('/somewhere/else/x.mkv')).toBeNull()
  })

  it('prefers the longest matching prefix', () => {
    const m = createPathMap([
      { role: 'library', jellyfin: '/media', container: '/mnt/a', qbit: null },
      { role: 'library', jellyfin: '/media/Movies', container: '/mnt/b', qbit: null },
    ])
    expect(m.toContainer('/media/Movies/x.mkv')).toBe('/mnt/b/x.mkv')
  })

  it('does not match a partial path segment', () => {
    expect(map.toContainer('/media/MoviesArchive/x.mkv')).toBeNull()
  })

  it('translates qbittorrent content paths, longest prefix first', () => {
    expect(map.qbitToContainer('/downloads/movies/Heat/Heat.mkv')).toBe('/mnt/media/Movies/Heat/Heat.mkv')
    expect(map.qbitToContainer('/downloads/other/x.mkv')).toBe('/mnt/downloads/other/x.mkv')
  })

  it('separates library roots from download roots', () => {
    expect(map.libraryRoots()).toHaveLength(2)
    expect(map.downloadRoots()).toHaveLength(1)
  })

  it('confines paths to their root', () => {
    const root = MAPPINGS[0]!
    expect(map.isWithinRoot('/mnt/media/Movies/a/b.mkv', root)).toBe(true)
    expect(map.isWithinRoot('/mnt/media/Movies', root)).toBe(true)
    expect(map.isWithinRoot('/mnt/media', root)).toBe(false)
    expect(map.isWithinRoot('/mnt/media/MoviesOther/x', root)).toBe(false)
    expect(map.isWithinRoot('/mnt/media/Movies/../../etc', root)).toBe(false)
  })

  it('resolves a symlink planted inside the root, so it cannot be used to point back out', () => {
    const base = mkdtempSync(join(tmpdir(), 'jm-pm-symlink-'))
    const libRoot: PathMapping = { role: 'library', jellyfin: '/media/Movies', container: join(base, 'Movies'), qbit: null }
    mkdirSync(libRoot.container, { recursive: true })
    mkdirSync(join(base, 'secret'), { recursive: true })
    symlinkSync(join(base, 'secret'), join(libRoot.container, 'escape-link'))
    const m = createPathMap([libRoot])
    expect(m.isWithinRoot(join(libRoot.container, 'escape-link'), libRoot)).toBe(false)
  })
})

describe('verifyMappings', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jm-pm-'))
    mkdirSync(join(dir, 'Movies'), { recursive: true })
    writeFileSync(join(dir, 'Movies', 'Heat.mkv'), 'x')
  })

  it('reports full success when every sampled item resolves', async () => {
    const report = await verifyMappings({
      mappings: [{ role: 'library', jellyfin: '/media/Movies', container: join(dir, 'Movies'), qbit: null }],
      sampleItems: async () => [{ id: 'i1', jfPath: '/media/Movies/Heat.mkv' }],
    })
    expect(report.sampled).toBe(1)
    expect(report.resolved).toBe(1)
    expect(report.failures).toEqual([])
  })

  it('reports the unmapped path as a failure with a reason', async () => {
    const report = await verifyMappings({
      mappings: [{ role: 'library', jellyfin: '/media/Movies', container: join(dir, 'Movies'), qbit: null }],
      sampleItems: async () => [{ id: 'i2', jfPath: '/other/Heat.mkv' }],
    })
    expect(report.resolved).toBe(0)
    expect(report.failures[0]!.reason).toMatch(/no mapping/i)
  })

  it('reports a mapped-but-missing file distinctly from an unmapped path', async () => {
    const report = await verifyMappings({
      mappings: [{ role: 'library', jellyfin: '/media/Movies', container: join(dir, 'Movies'), qbit: null }],
      sampleItems: async () => [{ id: 'i3', jfPath: '/media/Movies/Gone.mkv' }],
    })
    expect(report.failures[0]!.reason).toMatch(/not found on disk/i)
  })
})

describe('autoDetectMappings', () => {
  it('proposes a mapping by locating a sampled file under the mount roots', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jm-ad-'))
    mkdirSync(join(dir, 'Movies', 'Heat (1995)'), { recursive: true })
    writeFileSync(join(dir, 'Movies', 'Heat (1995)', 'Heat.mkv'), 'x')
    const proposed = await autoDetectMappings({
      mountRoots: [dir],
      sampleItems: async () => [{ id: 'i1', jfPath: '/media/Movies/Heat (1995)/Heat.mkv' }],
    })
    expect(proposed).toEqual([
      { role: 'library', jellyfin: '/media/Movies', container: join(dir, 'Movies'), qbit: null },
    ])
  })

  it('returns an empty proposal rather than a wrong one when nothing matches', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jm-ad2-'))
    const proposed = await autoDetectMappings({
      mountRoots: [dir],
      sampleItems: async () => [{ id: 'i1', jfPath: '/media/Movies/Nope.mkv' }],
    })
    expect(proposed).toEqual([])
  })
})
