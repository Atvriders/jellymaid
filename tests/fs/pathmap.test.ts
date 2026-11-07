import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readdirSync, statSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createPathMap, verifyMappings, autoDetectMappings, normalizeMappings, mappingsHash,
} from '../../src/fs/pathmap.js'
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
  { role: 'library', jellyfin: '/media/Movies', container: '/mnt/media/Movies', qbit: '/downloads/movies', qbitInstance: 'box-a' },
  { role: 'library', jellyfin: '/media/TV', container: '/mnt/media/TV', qbit: null, qbitInstance: null },
  { role: 'download', jellyfin: null, container: '/mnt/downloads', qbit: '/downloads', qbitInstance: 'box-a' },
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
      { role: 'library', jellyfin: '/media', container: '/mnt/a', qbit: null, qbitInstance: null },
      { role: 'library', jellyfin: '/media/Movies', container: '/mnt/b', qbit: null, qbitInstance: null },
    ])
    expect(m.toContainer('/media/Movies/x.mkv')).toBe('/mnt/b/x.mkv')
  })

  it('does not match a partial path segment', () => {
    expect(map.toContainer('/media/MoviesArchive/x.mkv')).toBeNull()
  })

  it('translates qbittorrent content paths, longest prefix first', () => {
    expect(map.qbitToContainer('box-a', '/downloads/movies/Heat/Heat.mkv')).toBe('/mnt/media/Movies/Heat/Heat.mkv')
    expect(map.qbitToContainer('box-a', '/downloads/other/x.mkv')).toBe('/mnt/downloads/other/x.mkv')
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
    const libRoot: PathMapping = { role: 'library', jellyfin: '/media/Movies', container: join(base, 'Movies'), qbit: null, qbitInstance: null }
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
    const libRoot: PathMapping = { role: 'library', jellyfin: '/media/Movies', container: join(base, 'Movies'), qbit: null, qbitInstance: null }
    mkdirSync(libRoot.container, { recursive: true })
    symlinkSync(join(base, 'does-not-exist-anywhere'), join(libRoot.container, 'dangling-escape'))
    const m = createPathMap([libRoot])
    expect(m.isWithinRoot(join(libRoot.container, 'dangling-escape'), libRoot)).toBe(false)
  })

  it('treats a plain not-yet-existing path under a real root as within it', () => {
    const base = mkdtempSync(join(tmpdir(), 'jm-pm-future-'))
    const libRoot: PathMapping = { role: 'library', jellyfin: '/media/TV', container: join(base, 'TV'), qbit: null, qbitInstance: null }
    mkdirSync(libRoot.container, { recursive: true })
    const m = createPathMap([libRoot])
    expect(m.isWithinRoot(join(libRoot.container, 'Show', 'Season 01', 'new.mkv'), libRoot)).toBe(true)
  })

  // Final review m4. The PathMap lives as long as its mappings do (ConfigStore memoizes it), so a
  // failure kept here outlived the hiccup that caused it: one ESTALE or EACCES on an NFS root made
  // every delete in that root "outside every configured root" until a restart.
  it('tries a root that could not be resolved again on the next call, instead of failing it for good', () => {
    const base = mkdtempSync(join(tmpdir(), 'jm-pm-retry-'))
    const share = join(base, 'share')
    // The root is a symlink to a share that is not there: it cannot be resolved, so nothing is within it.
    const libRoot: PathMapping = { role: 'library', jellyfin: '/media/Movies', container: join(base, 'Movies'), qbit: null, qbitInstance: null }
    symlinkSync(share, libRoot.container)
    const elsewhere = join(base, 'elsewhere.mkv')
    writeFileSync(elsewhere, 'x')
    const m = createPathMap([libRoot])
    // The target resolves, so this call does reach the root, and finds it unresolvable.
    expect(m.isWithinRoot(elsewhere, libRoot)).toBe(false)
    // The share comes back.
    mkdirSync(share)
    writeFileSync(join(share, 'Heat.mkv'), 'x')
    expect(m.isWithinRoot(join(libRoot.container, 'Heat.mkv'), libRoot)).toBe(true)
  })

  it('keeps a root it did resolve: a later call reuses it rather than resolving it again', () => {
    const base = mkdtempSync(join(tmpdir(), 'jm-pm-memo-'))
    const first = join(base, 'first')
    const second = join(base, 'second')
    for (const dir of [first, second]) {
      mkdirSync(dir)
      writeFileSync(join(dir, 'Heat.mkv'), 'x')
    }
    const libRoot: PathMapping = { role: 'library', jellyfin: '/media/Movies', container: join(base, 'Movies'), qbit: null, qbitInstance: null }
    symlinkSync(first, libRoot.container)
    const m = createPathMap([libRoot])
    expect(m.isWithinRoot(join(libRoot.container, 'Heat.mkv'), libRoot)).toBe(true)
    // Repointed behind its back, the root is still the one it resolved the first time.
    rmSync(libRoot.container)
    symlinkSync(second, libRoot.container)
    expect(m.isWithinRoot(join(second, 'Heat.mkv'), libRoot)).toBe(false)
    expect(m.isWithinRoot(join(first, 'Heat.mkv'), libRoot)).toBe(true)
  })

  it('confirms an ordinary existing file under the root is within it', () => {
    const base = mkdtempSync(join(tmpdir(), 'jm-pm-real-'))
    const libRoot: PathMapping = { role: 'library', jellyfin: '/media/Movies', container: join(base, 'Movies'), qbit: null, qbitInstance: null }
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
      mappings: [{ role: 'library', jellyfin: '/media/Movies', container: join(dir, 'Movies'), qbit: null, qbitInstance: null }],
      sampleItems: async () => [{ id: 'i1', jfPath: '/media/Movies/Heat.mkv' }],
    })
    expect(report.sampled).toBe(1)
    expect(report.resolved).toBe(1)
    expect(report.failures).toEqual([])
  })

  it('reports the unmapped path as a failure with a reason', async () => {
    const report = await verifyMappings({
      mappings: [{ role: 'library', jellyfin: '/media/Movies', container: join(dir, 'Movies'), qbit: null, qbitInstance: null }],
      sampleItems: async () => [{ id: 'i2', jfPath: '/other/Heat.mkv' }],
    })
    expect(report.resolved).toBe(0)
    expect(report.failures[0]!.reason).toMatch(/no mapping/i)
  })

  it('reports a mapped-but-missing file distinctly from an unmapped path', async () => {
    const report = await verifyMappings({
      mappings: [{ role: 'library', jellyfin: '/media/Movies', container: join(dir, 'Movies'), qbit: null, qbitInstance: null }],
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
      { role: 'library', jellyfin: '/media/Movies', container: join(dir, 'Movies'), qbit: null, qbitInstance: null },
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
      { role: 'library', jellyfin: '/media/TV', container: join(dir, 'diskA', 'TV'), qbit: null, qbitInstance: null },
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
      { role: 'library', jellyfin: '/media/library/Movies', container: join(dir, 'Movies'), qbit: null, qbitInstance: null },
      { role: 'library', jellyfin: '/media/library/Shows', container: join(other, 'Shows'), qbit: null, qbitInstance: null },
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
      { role: 'library', jellyfin: '/movies', container: dir, qbit: null, qbitInstance: null },
    ])
  })
})

/**
 * Two boxes that each call their own library `/movies`, as the owner's two qBittorrent instances
 * do. The container namespace is what tells them apart: one mount per box.
 */
const TWO_BOXES: PathMapping[] = [
  { role: 'library', jellyfin: '/data/a/movies', container: '/path/to/a/movies', qbit: '/movies', qbitInstance: 'box-a' },
  { role: 'library', jellyfin: '/data/b/movies', container: '/path/to/b/movies', qbit: '/movies', qbitInstance: 'box-b' },
]

describe('qbitToContainer — per instance', () => {
  const map = createPathMap(TWO_BOXES)

  it("translates a path through the asking instance's own mapping only", () => {
    expect(map.qbitToContainer('box-b', '/movies/X/X.mkv')).toBe('/path/to/b/movies/X/X.mkv')
    expect(map.qbitToContainer('box-a', '/movies/X/X.mkv')).toBe('/path/to/a/movies/X/X.mkv')
  })

  it('answers null for an instance no mapping names, rather than borrowing another box\'s prefix', () => {
    expect(map.qbitToContainer('box-c', '/movies/X/X.mkv')).toBeNull()
  })

  it('never uses a mapping whose qbit prefix has no instance', () => {
    const legacy = createPathMap([{ role: 'download', jellyfin: null, container: '/path/to/dl', qbit: '/downloads', qbitInstance: null }])
    expect(legacy.qbitToContainer('box-a', '/downloads/x.mkv')).toBeNull()
  })
})

describe('torrentSourceFor', () => {
  const map = createPathMap([
    ...TWO_BOXES,
    { role: 'library', jellyfin: '/data/plain', container: '/path/to/plain', qbit: null, qbitInstance: null },
    { role: 'library', jellyfin: '/data/legacy', container: '/path/to/legacy', qbit: '/legacy', qbitInstance: null },
    // A non-torrent folder nested inside box A's torrent-backed root: the deepest root wins.
    { role: 'library', jellyfin: '/data/a/movies/Home Videos', container: '/path/to/a/movies/Home Videos', qbit: null, qbitInstance: null },
  ])

  it('names the instance for a root with a qbit prefix and an instance', () => {
    expect(map.torrentSourceFor('/path/to/b/movies/X/X.mkv')).toEqual({ kind: 'instance', instanceId: 'box-b' })
    expect(map.torrentSourceFor('/path/to/a/movies/X/X.mkv')).toEqual({ kind: 'instance', instanceId: 'box-a' })
  })

  it('answers none for a root explicitly marked as not torrent-backed', () => {
    expect(map.torrentSourceFor('/path/to/plain/Y.mkv')).toEqual({ kind: 'none' })
  })

  it('uses the deepest root containing the path', () => {
    expect(map.torrentSourceFor('/path/to/a/movies/Home Videos/2019.mp4')).toEqual({ kind: 'none' })
  })

  it('answers unknown for a root with a qbit prefix but no instance', () => {
    expect(map.torrentSourceFor('/path/to/legacy/Z.mkv')).toMatchObject({ kind: 'unknown' })
  })

  it('answers unknown when two mappings for the same root disagree on who owns it, rather than picking one', () => {
    const tied = createPathMap([
      { role: 'library', jellyfin: '/data/s', container: '/path/to/shared', qbit: '/movies', qbitInstance: 'box-a' },
      { role: 'library', jellyfin: '/data/s', container: '/path/to/shared', qbit: '/films', qbitInstance: 'box-b' },
    ])
    expect(tied.torrentSourceFor('/path/to/shared/X.mkv')).toMatchObject({ kind: 'unknown' })
    const agreeing = createPathMap([
      { role: 'library', jellyfin: '/data/s', container: '/path/to/shared', qbit: '/movies', qbitInstance: 'box-a' },
      { role: 'download', jellyfin: null, container: '/path/to/shared', qbit: '/dl', qbitInstance: 'box-a' },
    ])
    expect(agreeing.torrentSourceFor('/path/to/shared/X.mkv')).toEqual({ kind: 'instance', instanceId: 'box-a' })
  })

  it('answers unknown for a path no root covers', () => {
    const source = map.torrentSourceFor('/elsewhere/Z.mkv')
    expect(source.kind).toBe('unknown')
    expect((source as { reason: string }).reason.length).toBeGreaterThan(0)
  })
})

describe('normalizeMappings', () => {
  const legacy: PathMapping = { role: 'download', jellyfin: null, container: '/path/to/dl', qbit: '/downloads', qbitInstance: null }

  it('fills a legacy mapping with the instance when exactly one instance exists', () => {
    const { mappings, problems } = normalizeMappings([legacy], ['box-a'])
    expect(mappings).toEqual([{ ...legacy, qbitInstance: 'box-a' }])
    expect(problems).toEqual([])
  })

  it('leaves it unfilled and reports one problem when two instances could own it', () => {
    const { mappings, problems } = normalizeMappings([legacy], ['box-a', 'box-b'])
    expect(mappings).toEqual([legacy])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('/path/to/dl')
  })

  it('reports a qbitInstance that is not a configured instance', () => {
    const { problems } = normalizeMappings([{ ...legacy, qbitInstance: 'nope' }], ['box-a'])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('nope')
  })

  it('leaves a root that is not torrent-backed alone and reports nothing', () => {
    const plain: PathMapping = { role: 'library', jellyfin: '/data/m', container: '/path/to/m', qbit: null, qbitInstance: null }
    expect(normalizeMappings([plain], ['box-a', 'box-b'])).toEqual({ mappings: [plain], problems: [] })
  })

  it('never mutates its input', () => {
    const input = [{ ...legacy }]
    const snapshot = JSON.stringify(input)
    const { mappings } = normalizeMappings(input, ['box-a'])
    expect(JSON.stringify(input)).toBe(snapshot)
    expect(mappings[0]).not.toBe(input[0])
  })

  // Final re-review N1. Both of the owner's boxes report `/movies`. Box B's row labelled `box-a` leaves
  // box-a with two `/movies` rows, of which only one can ever translate a path.
  describe('one instance mapping the same qBittorrent prefix to two folders (final re-review N1)', () => {
    const row = (container: string, qbit: string, qbitInstance: string | null, over: Partial<PathMapping> = {}): PathMapping =>
      ({ role: 'library', jellyfin: `/data${container}`, container, qbit, qbitInstance, ...over })

    it("reports box B's /movies row labelled box-a, naming the instance, the prefix and both folders", () => {
      const { problems } = normalizeMappings([
        row('/path/to/a/movies', '/movies', 'box-a'),
        row('/path/to/b/movies', '/movies', 'box-a'), // box B's row, mislabelled
        row('/path/to/b/tv', '/tv', 'box-b'),
      ], ['box-a', 'box-b'])
      expect(problems).toEqual([
        expect.stringMatching(/^box-a maps \/movies to two folders \(\/path\/to\/a\/movies, \/path\/to\/b\/movies\); one of them probably belongs to another box/),
      ])
    })

    it('reports each shadowed prefix once when every row is labelled box-a', () => {
      const { problems } = normalizeMappings([
        row('/path/to/a/movies', '/movies', 'box-a'),
        row('/path/to/a/tv', '/tv', 'box-a'),
        row('/path/to/b/movies', '/movies', 'box-a'),
        row('/path/to/b/tv', '/tv', 'box-a'),
      ], ['box-a', 'box-b'])
      expect(problems).toHaveLength(2)
      expect(problems[0]).toMatch(/^box-a maps \/movies to two folders \(\/path\/to\/a\/movies, \/path\/to\/b\/movies\)/)
      expect(problems[1]).toMatch(/^box-a maps \/tv to two folders \(\/path\/to\/a\/tv, \/path\/to\/b\/tv\)/)
    })

    it('treats a trailing slash as the same prefix, counts a download row like a library row, and names three folders', () => {
      const { problems } = normalizeMappings([
        row('/path/to/one', '/movies', 'box-a'),
        row('/path/to/two', '/movies/', 'box-a', { role: 'download', jellyfin: null }),
        row('/path/to/three', '/movies//', 'box-a'),
      ], ['box-a'])
      expect(problems).toEqual([
        expect.stringMatching(/^box-a maps \/movies to 3 folders \(\/path\/to\/one, \/path\/to\/two, \/path\/to\/three\); all but one of them probably belong to another box/),
      ])
    })

    it('reports a legacy row that, once filled in with the only instance, shadows another', () => {
      const { problems } = normalizeMappings([
        row('/path/to/a/movies', '/movies', 'box-a'),
        row('/path/to/old/movies', '/movies', null),
      ], ['box-a'])
      expect(problems).toEqual([expect.stringMatching(/^box-a maps \/movies to two folders \(\/path\/to\/a\/movies, \/path\/to\/old\/movies\)/)])
    })

    it('reports nothing for the correct two-box layout: each box maps /movies and /tv once', () => {
      expect(normalizeMappings([
        row('/path/to/a/movies', '/movies', 'box-a'),
        row('/path/to/a/tv', '/tv', 'box-a'),
        row('/path/to/b/movies', '/movies', 'box-b'),
        row('/path/to/b/tv', '/tv', 'box-b'),
      ], ['box-a', 'box-b']).problems).toEqual([])
    })

    it('reports nothing for two rows that name the same folder, whatever else differs', () => {
      expect(normalizeMappings([
        row('/path/to/a/movies', '/movies', 'box-a'),
        row('/path/to/a/movies', '/movies/', 'box-a', { role: 'download', jellyfin: null }),
      ], ['box-a']).problems).toEqual([])
    })

    // Not ambiguous: `qbitToContainer` takes the DEEPEST prefix, so every path under /data/movies has
    // exactly one translation (the nested row's) and every other path under /data the parent's. A box
    // whose qBittorrent mounts a second share inside its first is spelled exactly like this.
    it('reports nothing for nested prefixes of one instance, even when their folders are unrelated', () => {
      expect(normalizeMappings([
        row('/path/to/downloads', '/data', 'box-a', { role: 'download', jellyfin: null }),
        row('/path/to/movies', '/data/movies', 'box-a'),
      ], ['box-a']).problems).toEqual([])
    })
  })
})

describe('mappingsHash', () => {
  it('is 16 hex characters', () => {
    expect(mappingsHash(TWO_BOXES)).toMatch(/^[0-9a-f]{16}$/)
  })

  it('is stable under reordering', () => {
    expect(mappingsHash([...TWO_BOXES].reverse())).toBe(mappingsHash(TWO_BOXES))
  })

  it('changes when any field of any mapping changes', () => {
    const base = mappingsHash(TWO_BOXES)
    expect(mappingsHash([TWO_BOXES[0]!, { ...TWO_BOXES[1]!, qbitInstance: 'box-c' }])).not.toBe(base)
    expect(mappingsHash([TWO_BOXES[0]!, { ...TWO_BOXES[1]!, qbit: '/films' }])).not.toBe(base)
    expect(mappingsHash([TWO_BOXES[0]!])).not.toBe(base)
  })

  it('does not depend on the key order a mapping object happens to have', () => {
    const reordered = TWO_BOXES.map((m) => ({
      qbitInstance: m.qbitInstance, qbit: m.qbit, container: m.container, jellyfin: m.jellyfin, role: m.role,
    }))
    expect(mappingsHash(reordered)).toBe(mappingsHash(TWO_BOXES))
  })
})
