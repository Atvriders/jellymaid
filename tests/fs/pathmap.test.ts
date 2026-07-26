import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readdirSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPathMap, verifyMappings, autoDetectMappings } from '../../src/fs/pathmap.js'
import type { PathMapping } from '../../src/core/types.js'

/** Stands in for the production walk so the test can count how often each mount is enumerated. */
function walkDirsForTest(root: string, maxDepth: number, depth = 0): string[] {
  if (depth > maxDepth || !existsSync(root)) return []
  const out = [root]
  for (const name of readdirSync(root)) {
    if (name.startsWith('.')) continue
    const child = join(root, name)
    if (statSync(child).isDirectory()) out.push(...walkDirsForTest(child, maxDepth, depth + 1))
  }
  return out
}

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

describe('isWithinRoot — resolution edge cases', () => {
  it('fails closed on a dangling symlink inside the root (target does not exist at all)', () => {
    const base = mkdtempSync(join(tmpdir(), 'jm-pm-dangling-'))
    const libRoot: PathMapping = { role: 'library', jellyfin: '/media/Movies', container: join(base, 'Movies'), qbit: null }
    mkdirSync(libRoot.container, { recursive: true })
    symlinkSync(join(base, 'does-not-exist-anywhere'), join(libRoot.container, 'dangling-escape'))
    const m = createPathMap([libRoot])
    expect(m.isWithinRoot(join(libRoot.container, 'dangling-escape'), libRoot)).toBe(false)
  })

  it('treats a plain not-yet-existing path under a real root as within it', () => {
    const base = mkdtempSync(join(tmpdir(), 'jm-pm-future-'))
    const libRoot: PathMapping = { role: 'library', jellyfin: '/media/TV', container: join(base, 'TV'), qbit: null }
    mkdirSync(libRoot.container, { recursive: true })
    const m = createPathMap([libRoot])
    expect(m.isWithinRoot(join(libRoot.container, 'Show', 'Season 01', 'new.mkv'), libRoot)).toBe(true)
  })

  it('confirms an ordinary existing file under the root is within it', () => {
    const base = mkdtempSync(join(tmpdir(), 'jm-pm-real-'))
    const libRoot: PathMapping = { role: 'library', jellyfin: '/media/Movies', container: join(base, 'Movies'), qbit: null }
    mkdirSync(libRoot.container, { recursive: true })
    writeFileSync(join(libRoot.container, 'Heat.mkv'), 'x')
    const m = createPathMap([libRoot])
    expect(m.isWithinRoot(join(libRoot.container, 'Heat.mkv'), libRoot)).toBe(true)
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

  it('proposes NOTHING for a jellyfin root two items place in different containers', async () => {
    // Both items agree the Jellyfin root is /media/Movies but corroborate different containers.
    // At most one can be right, and a wrong mapping is far more dangerous than an absent one.
    const dir = mkdtempSync(join(tmpdir(), 'jm-ad-conflict-'))
    mkdirSync(join(dir, 'diskA', 'Movies', 'Heat (1995)'), { recursive: true })
    writeFileSync(join(dir, 'diskA', 'Movies', 'Heat (1995)', 'Heat.mkv'), 'x')
    mkdirSync(join(dir, 'diskB', 'Movies', 'Alien (1979)'), { recursive: true })
    writeFileSync(join(dir, 'diskB', 'Movies', 'Alien (1979)', 'Alien.mkv'), 'x')

    const proposed = await autoDetectMappings({
      mountRoots: [join(dir, 'diskA'), join(dir, 'diskB')],
      sampleItems: async () => [
        { id: 'i1', jfPath: '/media/Movies/Heat (1995)/Heat.mkv' },
        { id: 'i2', jfPath: '/media/Movies/Alien (1979)/Alien.mkv' },
      ],
    })
    expect(proposed).toEqual([])
  })

  it('keeps an unrelated root when a different root is conflicted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jm-ad-conflict2-'))
    mkdirSync(join(dir, 'diskA', 'Movies', 'Heat (1995)'), { recursive: true })
    writeFileSync(join(dir, 'diskA', 'Movies', 'Heat (1995)', 'Heat.mkv'), 'x')
    mkdirSync(join(dir, 'diskB', 'Movies', 'Alien (1979)'), { recursive: true })
    writeFileSync(join(dir, 'diskB', 'Movies', 'Alien (1979)', 'Alien.mkv'), 'x')
    mkdirSync(join(dir, 'diskA', 'TV', 'Show'), { recursive: true })
    writeFileSync(join(dir, 'diskA', 'TV', 'Show', 'S01E01.mkv'), 'x')

    const proposed = await autoDetectMappings({
      mountRoots: [join(dir, 'diskA'), join(dir, 'diskB')],
      sampleItems: async () => [
        { id: 'i1', jfPath: '/media/Movies/Heat (1995)/Heat.mkv' },
        { id: 'i2', jfPath: '/media/Movies/Alien (1979)/Alien.mkv' },
        { id: 'i3', jfPath: '/media/TV/Show/S01E01.mkv' },
      ],
    })
    expect(proposed).toEqual([
      { role: 'library', jellyfin: '/media/TV', container: join(dir, 'diskA', 'TV'), qbit: null },
    ])
  })

  it('stays conflicted even if a later item agrees with the first container', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jm-ad-conflict3-'))
    mkdirSync(join(dir, 'diskA', 'Movies', 'Heat (1995)'), { recursive: true })
    writeFileSync(join(dir, 'diskA', 'Movies', 'Heat (1995)', 'Heat.mkv'), 'x')
    mkdirSync(join(dir, 'diskB', 'Movies', 'Alien (1979)'), { recursive: true })
    writeFileSync(join(dir, 'diskB', 'Movies', 'Alien (1979)', 'Alien.mkv'), 'x')
    mkdirSync(join(dir, 'diskA', 'Movies', 'Ronin (1998)'), { recursive: true })
    writeFileSync(join(dir, 'diskA', 'Movies', 'Ronin (1998)', 'Ronin.mkv'), 'x')

    const proposed = await autoDetectMappings({
      mountRoots: [join(dir, 'diskA'), join(dir, 'diskB')],
      sampleItems: async () => [
        { id: 'i1', jfPath: '/media/Movies/Heat (1995)/Heat.mkv' },
        { id: 'i2', jfPath: '/media/Movies/Alien (1979)/Alien.mkv' },
        { id: 'i3', jfPath: '/media/Movies/Ronin (1998)/Ronin.mkv' },
      ],
    })
    expect(proposed).toEqual([])
  })

  it('walks each mount exactly once per call, however many items and splits are tried', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jm-ad-walk-'))
    for (let i = 0; i < 12; i += 1) {
      mkdirSync(join(dir, 'Movies', `Film ${i} (2000)`), { recursive: true })
      writeFileSync(join(dir, 'Movies', `Film ${i} (2000)`, `Film${i}.mkv`), 'x')
    }
    const other = mkdtempSync(join(tmpdir(), 'jm-ad-walk2-'))
    for (let i = 0; i < 12; i += 1) {
      mkdirSync(join(other, 'Shows', `Show ${i}`), { recursive: true })
      writeFileSync(join(other, 'Shows', `Show ${i}`, `S01E0${i % 10}.mkv`), 'x')
    }
    const walked: string[] = []
    const proposed = await autoDetectMappings({
      mountRoots: [dir, other],
      // Deep jfPaths so several candidate splits are tried per item — each of which used to
      // re-enumerate the whole mount synchronously, freezing the event loop for seconds. Items
      // land on both mounts, so both are enumerated, and each must be enumerated only once.
      sampleItems: async () => [
        ...Array.from({ length: 12 }, (_, i) => ({
          id: `m${i}`, jfPath: `/media/library/Movies/Film ${i} (2000)/Film${i}.mkv`,
        })),
        ...Array.from({ length: 12 }, (_, i) => ({
          id: `s${i}`, jfPath: `/media/library/Shows/Show ${i}/S01E0${i % 10}.mkv`,
        })),
      ],
      walk: (root, maxDepth) => { walked.push(root); return walkDirsForTest(root, maxDepth) },
    })
    expect([...walked].sort()).toEqual([dir, other].sort())
    expect(proposed).toEqual([
      { role: 'library', jellyfin: '/media/library/Movies', container: join(dir, 'Movies'), qbit: null },
      { role: 'library', jellyfin: '/media/library/Shows', container: join(other, 'Shows'), qbit: null },
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

  it('proposes a 1-segment root for a single-bind-mount layout, the most common real deployment shape', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jm-ad3-'))
    mkdirSync(join(dir, 'Heat (1995)'), { recursive: true })
    writeFileSync(join(dir, 'Heat (1995)', 'Heat.mkv'), 'x')
    const proposed = await autoDetectMappings({
      mountRoots: [dir],
      sampleItems: async () => [{ id: 'i1', jfPath: '/movies/Heat (1995)/Heat.mkv' }],
    })
    expect(proposed).toEqual([
      { role: 'library', jellyfin: '/movies', container: dir, qbit: null },
    ])
  })
})
