import { afterAll, describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  autoDetectQbitMappings, createPathMap, verifyQbitMappings, type QbitMappingProposal, type QbitSampleSource,
} from '../../src/fs/pathmap.js'
import type { PathMapping } from '../../src/core/types.js'
import type { Torrent } from '../../src/connectors/qbittorrent.js'

// Every directory a test makes is removed afterwards: these run on shared machines whose disks fill up.
const made: string[] = []
afterAll(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }) })
const tmp = (label: string) => {
  const dir = mkdtempSync(join(tmpdir(), `jm-pmqbit-${label}-`))
  made.push(dir)
  return dir
}

/** A completed torrent; every test overrides only what it is about. */
function torrent(over: Partial<Torrent> & Pick<Torrent, 'instanceId' | 'hash'>): Torrent {
  return {
    name: over.hash, savePath: null, contentPath: null, rootPath: null, category: null, tags: [],
    state: 'stalledUP', ratio: 1, seedingTimeSeconds: 0, isPrivate: false, privacySource: 'flag',
    trackerHost: null, sizeBytes: 0, progress: 1, addedOn: null,
    ...over,
  }
}

const source = (id: string, torrents: Torrent[]): QbitSampleSource => ({ id, torrents: async () => torrents })

/**
 * Two boxes that each call their own library `/movies`, as the owner's two instances do. Each
 * box's files live under its own container root, which is the only thing telling them apart.
 */
function twoBoxes() {
  const base = tmp('boxes')
  const a = join(base, 'a', 'movies')
  const b = join(base, 'b', 'movies')
  mkdirSync(join(a, 'Heat (1995)'), { recursive: true })
  writeFileSync(join(a, 'Heat (1995)', 'Heat.mkv'), 'x')
  mkdirSync(join(b, 'Alien (1979)'), { recursive: true })
  writeFileSync(join(b, 'Alien (1979)', 'Alien.mkv'), 'x')
  const mappings: PathMapping[] = [
    { role: 'library', jellyfin: '/data/a/movies', container: a, qbit: '/movies', qbitInstance: 'box-a' },
    { role: 'library', jellyfin: '/data/b/movies', container: b, qbit: '/movies', qbitInstance: 'box-b' },
  ]
  return { base, a, b, mappings, pathMap: createPathMap(mappings) }
}

describe('verifyQbitMappings', () => {
  it('verify resolves box-a and box-b torrents through their own prefixes', async () => {
    const { pathMap } = twoBoxes()
    const reports = await verifyQbitMappings({
      pathMap,
      instances: [
        source('box-a', [torrent({ instanceId: 'box-a', hash: 'a1', contentPath: '/movies/Heat (1995)', rootPath: '/movies/Heat (1995)' })]),
        source('box-b', [torrent({ instanceId: 'box-b', hash: 'b1', contentPath: '/movies/Alien (1979)', rootPath: '/movies/Alien (1979)' })]),
      ],
    })
    expect(reports).toEqual([
      { instanceId: 'box-a', sampled: 1, resolved: 1, failures: [] },
      { instanceId: 'box-b', sampled: 1, resolved: 1, failures: [] },
    ])
  })

  it("never borrows another box's prefix: box-b's torrent for a release only box-a holds fails", async () => {
    const { pathMap, b } = twoBoxes()
    const [report] = await verifyQbitMappings({
      pathMap,
      // Both boxes spell the path `/movies/Heat (1995)`. It exists under box A's root, so a lookup
      // through the wrong box's prefix would pass; through box B's own it does not exist.
      instances: [source('box-b', [torrent({ instanceId: 'box-b', hash: 'b1', contentPath: '/movies/Heat (1995)', rootPath: '/movies/Heat (1995)' })])],
    })
    expect(report).toMatchObject({ instanceId: 'box-b', sampled: 1, resolved: 0 })
    expect(report!.failures).toEqual([
      { qbitPath: '/movies/Heat (1995)', reason: `mapped to ${join(b, 'Heat (1995)')} but not found on disk` },
    ])
  })

  it('verify fails a single-file torrent whose on-disk size differs', async () => {
    const { a, pathMap } = twoBoxes()
    writeFileSync(join(a, 'Same.mkv'), 'x'.repeat(10))
    writeFileSync(join(a, 'Other.mkv'), 'x'.repeat(10))
    const [report] = await verifyQbitMappings({
      pathMap,
      instances: [source('box-a', [
        torrent({ instanceId: 'box-a', hash: 'a1', contentPath: '/movies/Same.mkv', rootPath: '', sizeBytes: 10 }),
        // The path exists, but the file there is not the one this torrent is made of.
        torrent({ instanceId: 'box-a', hash: 'a2', contentPath: '/movies/Other.mkv', rootPath: '', sizeBytes: 999 }),
      ])],
    })
    expect(report).toMatchObject({ instanceId: 'box-a', sampled: 2, resolved: 1 })
    expect(report!.failures).toHaveLength(1)
    expect(report!.failures[0]!.qbitPath).toBe('/movies/Other.mkv')
    expect(report!.failures[0]!.reason).toMatch(/10 bytes/)
    expect(report!.failures[0]!.reason).toMatch(/999 bytes/)
  })

  it('does not size-check a multi-file torrent, whose content path is a directory', async () => {
    const { pathMap } = twoBoxes()
    const [report] = await verifyQbitMappings({
      pathMap,
      instances: [source('box-a', [
        // 4 GB of torrent against whatever size the directory entry itself reports.
        torrent({ instanceId: 'box-a', hash: 'a1', contentPath: '/movies/Heat (1995)', rootPath: '/movies/Heat (1995)', sizeBytes: 4_000_000_000 }),
      ])],
    })
    expect(report).toEqual({ instanceId: 'box-a', sampled: 1, resolved: 1, failures: [] })
  })

  it('does not size-check a multi-file torrent saved with no folder of its own', async () => {
    // qBittorrent reports an empty root path for these too, but its content path is the save
    // directory, not a file: there is no "the file" whose size could be compared.
    const { pathMap } = twoBoxes()
    const [report] = await verifyQbitMappings({
      pathMap,
      instances: [source('box-a', [
        torrent({ instanceId: 'box-a', hash: 'a1', contentPath: '/movies/Heat (1995)', rootPath: '', sizeBytes: 4_000_000_000 }),
      ])],
    })
    expect(report).toEqual({ instanceId: 'box-a', sampled: 1, resolved: 1, failures: [] })
  })

  it("fails an instance whose own prefix covers none of its completed torrents, and ignores the ones outside it", async () => {
    const { pathMap } = twoBoxes()
    const [, report] = await verifyQbitMappings({
      pathMap,
      instances: [
        source('box-a', [torrent({ instanceId: 'box-a', hash: 'a1', contentPath: '/movies/Heat (1995)', rootPath: '/movies/Heat (1995)' })]),
        // Box B's mapping says /movies, but every torrent it reports lives under /downloads: the
        // mapping translates nothing, which is a wrong prefix, not a box with nothing to check.
        source('box-b', [
          torrent({ instanceId: 'box-b', hash: 'b1', contentPath: '/downloads/One', rootPath: '/downloads/One' }),
          torrent({ instanceId: 'box-b', hash: 'b2', contentPath: '/downloads/Two.mkv', rootPath: '' }),
        ]),
      ],
    })
    expect(report).toEqual({
      instanceId: 'box-b', sampled: 0, resolved: 0,
      failures: [{ qbitPath: '/movies', reason: 'no completed torrent of "box-b" reports a path under /movies — check the qBittorrent path' }],
      ignored: { count: 2, examples: ['/downloads/One', '/downloads/Two.mkv'] },
    })
  })

  it('passes an instance no mapping names, whose completed torrents all lie outside every mapped folder, and reports them ignored', async () => {
    const { pathMap } = twoBoxes()
    const [report] = await verifyQbitMappings({
      pathMap,
      instances: [source('box-c', [
        torrent({ instanceId: 'box-c', hash: 'c1', contentPath: '/music/Album', rootPath: '/music/Album', savePath: '/music' }),
        torrent({ instanceId: 'box-c', hash: 'c2', contentPath: '/books/Novel.epub', rootPath: '', savePath: '/books' }),
      ])],
    })
    // No mapping of its own means no path of the library is ever attributed to it, so there is
    // nothing of it to translate. Its torrents are counted, not failed.
    expect(report).toEqual({
      instanceId: 'box-c', sampled: 0, resolved: 0, failures: [],
      ignored: { count: 2, examples: ['/music/Album', '/books/Novel.epub'] },
    })
  })

  it('reports a mapped path that is not on disk', async () => {
    const { pathMap, a } = twoBoxes()
    const [report] = await verifyQbitMappings({
      pathMap,
      instances: [source('box-a', [torrent({ instanceId: 'box-a', hash: 'a1', contentPath: '/movies/Gone', rootPath: '/movies/Gone' })])],
    })
    expect(report!.failures).toEqual([{ qbitPath: '/movies/Gone', reason: `mapped to ${join(a, 'Gone')} but not found on disk` }])
  })

  it('treats a completed torrent that reports no content path as a failure', async () => {
    const { pathMap } = twoBoxes()
    const [report] = await verifyQbitMappings({
      pathMap,
      instances: [source('box-a', [torrent({ instanceId: 'box-a', hash: 'a1', contentPath: null, savePath: '/movies' })])],
    })
    expect(report).toMatchObject({ sampled: 1, resolved: 0 })
    expect(report!.failures).toEqual([{ qbitPath: '/movies', reason: 'qBittorrent reported no content path for this torrent' }])
  })

  it('records a failure, never a pass, for an instance whose torrent list cannot be fetched', async () => {
    const { pathMap } = twoBoxes()
    const [report] = await verifyQbitMappings({
      pathMap,
      instances: [{ id: 'box-a', torrents: async () => { throw new Error('[qbittorrent] unreachable: HTTP 502') } }],
    })
    // sampled 0 with no failures would read as "this instance has no completed torrents" and pass.
    expect(report).toMatchObject({ instanceId: 'box-a', sampled: 0, resolved: 0 })
    expect(report!.failures).toEqual([{ qbitPath: '', reason: 'could not list torrents: [qbittorrent] unreachable: HTTP 502' }])
  })

  it('reports an instance with no completed torrents as sampled 0 with no failures', async () => {
    const { pathMap } = twoBoxes()
    const [report] = await verifyQbitMappings({
      pathMap,
      instances: [source('box-a', [
        torrent({ instanceId: 'box-a', hash: 'a1', contentPath: '/nowhere/At/All', progress: 0.4, state: 'downloading' }),
        torrent({ instanceId: 'box-a', hash: 'a2', contentPath: '/nowhere/Else', progress: 0, state: 'metaDL' }),
      ])],
    })
    // An unfinished torrent proves nothing about the mapping, so it is not sampled — and an
    // instance that has none finished has nothing to translate yet.
    expect(report).toEqual({ instanceId: 'box-a', sampled: 0, resolved: 0, failures: [] })
  })

  it('reports the instances in the order it was given them', async () => {
    const { pathMap } = twoBoxes()
    const reports = await verifyQbitMappings({ pathMap, instances: [source('box-b', []), source('box-a', []), source('box-c', [])] })
    expect(reports.map((r) => r.instanceId)).toEqual(['box-b', 'box-a', 'box-c'])
  })

  describe('which torrents are sampled', () => {
    /**
     * Torrents under box-a's own /movies whose files are not on disk: every one fails, so the failure
     * list IS the list of torrents that were checked.
     */
    const unmapped = (count: number, over: Partial<Torrent> = {}) =>
      Array.from({ length: count }, (_, i) => {
        const hash = `${String(i).padStart(4, '0')}${'f'.repeat(36)}`
        return torrent({ instanceId: 'box-a', hash, contentPath: `/movies/${hash}`, rootPath: '', ...over })
      })

    it('checks at most 20 completed torrents by default, spread across the whole hash range', async () => {
      const { pathMap } = twoBoxes()
      const all = unmapped(200)
      const [report] = await verifyQbitMappings({ pathMap, instances: [source('box-a', all)] })
      expect(report).toMatchObject({ sampled: 20, resolved: 0 })
      const checked = report!.failures.map((f) => f.qbitPath.replace('/movies/', '')).sort()
      expect(new Set(checked).size).toBe(20)
      const hashes = all.map((t) => t.hash).sort()
      // Spread, not a prefix: it reaches both ends of the hash order rather than the first twenty.
      expect(checked[0]).toBe(hashes[0])
      expect(hashes.indexOf(checked[19]!)).toBeGreaterThanOrEqual(hashes.length - Math.ceil(hashes.length / 20))
    })

    it('honours sampleSize, and checks every completed torrent when there are fewer than that', async () => {
      const { pathMap } = twoBoxes()
      const [few] = await verifyQbitMappings({ pathMap, sampleSize: 5, instances: [source('box-a', unmapped(50))] })
      expect(few!.sampled).toBe(5)
      const [all] = await verifyQbitMappings({ pathMap, instances: [source('box-a', unmapped(7))] })
      expect(all!.sampled).toBe(7)
    })

    it('chooses the same torrents whatever order the instance lists them in', async () => {
      const { pathMap } = twoBoxes()
      const all = unmapped(60)
      const [forward] = await verifyQbitMappings({ pathMap, instances: [source('box-a', all)] })
      const [backward] = await verifyQbitMappings({ pathMap, instances: [source('box-a', [...all].reverse())] })
      expect(backward!.failures.map((f) => f.qbitPath).sort()).toEqual(forward!.failures.map((f) => f.qbitPath).sort())
    })

    it('never samples a torrent that has not finished', async () => {
      const { pathMap } = twoBoxes()
      const unfinished = unmapped(5, { progress: 0.99 })
        .map((t, i) => ({ ...t, hash: `e${i}${'0'.repeat(38)}`, contentPath: `/movies/unfinished-${i}` }))
      const [report] = await verifyQbitMappings({ pathMap, instances: [source('box-a', [...unmapped(5), ...unfinished])] })
      expect(report!.sampled).toBe(5)
      expect(report!.failures.some((f) => f.qbitPath.includes('unfinished'))).toBe(false)
    })
  })

  // Task 4 minor 4: qBittorrent itself says these torrents' files are not where it put them. Sampling
  // one failed every Verify, every time, with "not found on disk" — a reason pointing at the mapping,
  // for a torrent no mapping can ever fix.
  describe('torrents qBittorrent reports in an error state', () => {
    it('leaves missingFiles and error torrents out of the sample', async () => {
      const { pathMap } = twoBoxes()
      const [report] = await verifyQbitMappings({
        pathMap,
        instances: [source('box-a', [
          torrent({ instanceId: 'box-a', hash: 'a1', contentPath: '/movies/Heat (1995)', rootPath: '/movies/Heat (1995)' }),
          torrent({ instanceId: 'box-a', hash: 'a2', contentPath: '/movies/Gone (2001)', rootPath: '/movies/Gone (2001)', state: 'missingFiles' }),
          torrent({ instanceId: 'box-a', hash: 'a3', contentPath: '/movies/Broken (2002)', rootPath: '/movies/Broken (2002)', state: 'error' }),
        ])],
      })
      expect(report).toEqual({ instanceId: 'box-a', sampled: 1, resolved: 1, failures: [] })
    })

    it('fails, naming the states, when every completed torrent of an instance is in one', async () => {
      const { pathMap } = twoBoxes()
      const [report] = await verifyQbitMappings({
        pathMap,
        instances: [source('box-a', [
          torrent({ instanceId: 'box-a', hash: 'a2', contentPath: '/movies/Gone (2001)', state: 'missingFiles' }),
          torrent({ instanceId: 'box-a', hash: 'a3', contentPath: '/movies/Broken (2002)', state: 'error' }),
          torrent({ instanceId: 'box-a', hash: 'a4', contentPath: '/movies/Half', state: 'downloading', progress: 0.5 }),
        ])],
      })
      // Nothing that could be checked is not "nothing to check": the gate must not read it as clean.
      expect(report).toMatchObject({ instanceId: 'box-a', sampled: 0, resolved: 0 })
      expect(report!.failures).toHaveLength(1)
      expect(report!.failures[0]!.reason).toMatch(/every completed torrent/i)
      expect(report!.failures[0]!.reason).toMatch(/missingFiles/)
      expect(report!.failures[0]!.reason).toMatch(/error/)
    })
  })

  // Final review I1. A root marked "none (not torrent-backed)" is one no instance is ever asked about,
  // so a torrent seeding there is invisible to every guard. The sample cannot be trusted to land on
  // such a torrent; every completed torrent is checked against those roots.
  describe('roots marked not torrent-backed', () => {
    /** box-a's movies are mapped; its tv root was left "none". */
    function forgottenTv() {
      const base = tmp('none')
      const movies = join(base, 'movies')
      const tv = join(base, 'tv')
      mkdirSync(join(movies, 'Heat (1995)'), { recursive: true })
      writeFileSync(join(movies, 'Heat (1995)', 'Heat.mkv'), 'x')
      mkdirSync(join(tv, 'Show', 'Season 01'), { recursive: true })
      writeFileSync(join(tv, 'Show', 'Season 01', 'Show.S01E01.mkv'), 'x'.repeat(50))
      const mappings: PathMapping[] = [
        { role: 'library', jellyfin: '/data/movies', container: movies, qbit: '/movies', qbitInstance: 'box-a' },
        { role: 'library', jellyfin: '/data/tv', container: tv, qbit: null, qbitInstance: null },
      ]
      return { base, movies, tv, mappings, pathMap: createPathMap(mappings) }
    }
    const heat = torrent({ instanceId: 'box-a', hash: 'a1', contentPath: '/movies/Heat (1995)', rootPath: '/movies/Heat (1995)' })

    it('fails when an unmapped torrent of the instance is found under a root marked not torrent-backed', async () => {
      const { tv, pathMap } = forgottenTv()
      const [report] = await verifyQbitMappings({
        pathMap,
        sampleSize: 1, // the sample is heat alone: the full pass is what must find the episode
        instances: [source('box-a', [heat, torrent({
          instanceId: 'box-a', hash: 'f1', contentPath: '/data/tv/Show/Season 01/Show.S01E01.mkv', rootPath: '', sizeBytes: 50,
        })])],
      })
      expect(report).toMatchObject({ sampled: 1, resolved: 1 })
      expect(report!.failures).toHaveLength(1)
      expect(report!.failures[0]!.qbitPath).toBe('/data/tv/Show/Season 01/Show.S01E01.mkv')
      expect(report!.failures[0]!.reason).toContain(tv)
      expect(report!.failures[0]!.reason).toMatch(/not torrent-backed/)
      expect(report!.failures[0]!.reason).toContain('box-a')
    })

    it('finds a multi-file torrent there too', async () => {
      const { pathMap } = forgottenTv()
      const [report] = await verifyQbitMappings({
        pathMap,
        sampleSize: 1,
        instances: [source('box-a', [heat, torrent({ instanceId: 'box-a', hash: 'f1', contentPath: '/tv/Show', rootPath: '/tv/Show' })])],
      })
      expect(report!.failures.map((f) => f.qbitPath)).toEqual(['/tv/Show'])
    })

    it('fails when a mapping translates the torrent into a not-torrent-backed root nested inside its own', async () => {
      const base = tmp('nested-none')
      const media = join(base, 'media')
      mkdirSync(join(media, 'home', 'Trip'), { recursive: true })
      writeFileSync(join(media, 'home', 'Trip', 'Trip.mkv'), 'x')
      const pathMap = createPathMap([
        { role: 'library', jellyfin: '/data/media', container: media, qbit: '/media', qbitInstance: 'box-a' },
        { role: 'library', jellyfin: '/data/media/home', container: join(media, 'home'), qbit: null, qbitInstance: null },
      ])
      const [report] = await verifyQbitMappings({
        pathMap,
        instances: [source('box-a', [torrent({ instanceId: 'box-a', hash: 'f1', contentPath: '/media/home/Trip', rootPath: '/media/home/Trip' })])],
      })
      expect(report!.failures).toHaveLength(1)
      expect(report!.failures[0]!.reason).toContain(join(media, 'home'))
      expect(report!.failures[0]!.reason).toMatch(/not torrent-backed/)
    })

    it('leaves alone an unmapped torrent that lands under no such root, and one whose same-named file is a different size', async () => {
      const { pathMap } = forgottenTv()
      const [report] = await verifyQbitMappings({
        pathMap,
        sampleSize: 1,
        instances: [source('box-a', [
          heat,
          // Music the box seeds outside every library: nothing Jellymaid could ever delete.
          torrent({ instanceId: 'box-a', hash: 'f1', contentPath: '/music/Album', rootPath: '/music/Album' }),
          // A single file of the same name but another size is not this torrent's file.
          torrent({ instanceId: 'box-a', hash: 'f2', contentPath: '/tv/Show/Season 01/Show.S01E01.mkv', rootPath: '', sizeBytes: 49 }),
          // Unfinished: it seeds nothing yet.
          torrent({ instanceId: 'box-a', hash: 'f3', contentPath: '/tv/Show', rootPath: '/tv/Show', progress: 0.5, state: 'downloading' }),
        ])],
      })
      // The two completed ones lie outside box-a's only mapped folder (/movies): counted, not failed.
      expect(report).toEqual({
        instanceId: 'box-a', sampled: 1, resolved: 1, failures: [],
        ignored: { count: 2, examples: ['/music/Album', '/tv/Show/Season 01/Show.S01E01.mkv'] },
      })
    })

    it('still finds a torrent in an error state there: its files coming back would seed again', async () => {
      const { pathMap } = forgottenTv()
      const [report] = await verifyQbitMappings({
        pathMap,
        sampleSize: 1,
        instances: [source('box-a', [heat, torrent({ instanceId: 'box-a', hash: 'f1', contentPath: '/tv/Show', rootPath: '/tv/Show', state: 'missingFiles' })])],
      })
      expect(report!.failures.map((f) => f.qbitPath)).toEqual(['/tv/Show'])
    })

    it('judges each instance by its own torrents, and names the instance that seeds there', async () => {
      const { pathMap } = forgottenTv()
      const [a, b] = await verifyQbitMappings({
        pathMap,
        instances: [
          source('box-a', [heat]),
          source('box-b', [torrent({ instanceId: 'box-b', hash: 'b1', contentPath: '/tv/Show', rootPath: '/tv/Show' })]),
        ],
      })
      expect(a).toEqual({ instanceId: 'box-a', sampled: 1, resolved: 1, failures: [] })
      // box-b has no mapping at all, so the sample ignores its torrent as outside every mapped folder;
      // the full pass is what finds it in the tv root and names the root.
      expect(b!.ignored).toEqual({ count: 1, examples: ['/tv/Show'] })
      expect(b!.failures).toHaveLength(1)
      expect(b!.failures[0]!.reason).toMatch(/not torrent-backed/)
      expect(b!.failures[0]!.reason).toContain('box-b')
    })

    it('lists at most 20 such torrents, then says how many more there are', async () => {
      const { tv, pathMap } = forgottenTv()
      const episodes = Array.from({ length: 25 }, (_, i) => {
        const name = `Show.S01E${String(i + 2).padStart(2, '0')}.mkv`
        writeFileSync(join(tv, 'Show', 'Season 01', name), 'x')
        return torrent({ instanceId: 'box-a', hash: `f${String(i).padStart(3, '0')}`, contentPath: `/tv/Show/Season 01/${name}`, rootPath: '', sizeBytes: 1 })
      })
      const [report] = await verifyQbitMappings({ pathMap, sampleSize: 1, instances: [source('box-a', [heat, ...episodes])] })
      const named = report!.failures.filter((f) => f.qbitPath !== '')
      expect(named).toHaveLength(20)
      const summary = report!.failures.filter((f) => f.qbitPath === '')
      expect(summary).toHaveLength(1)
      expect(summary[0]!.reason).toMatch(/5 more/)
    })
  })

  // Final fix wave, part 2. A box seeds into folders Jellymaid has nothing to do with (music, books, a
  // downloads folder). Sampling all of its torrents failed Verify on whichever of those it landed on,
  // so the gate stayed shut unless every share was mounted. Only torrents under one of the instance's
  // own mapped prefixes are sampled; the rest are counted, and a prefix that holds none of its
  // completed torrents is what fails.
  describe('torrents outside every mapped folder', () => {
    /** One completed torrent per name under `prefix`, hashes in `tag`'s order: `<tag><i>000…`. */
    const under = (prefix: string, tag: string, count: number, over: Partial<Torrent> = {}) =>
      Array.from({ length: count }, (_, i) => {
        const hash = `${tag}${String(i).padStart(3, '0')}`.padEnd(40, '0')
        return torrent({ instanceId: 'box-a', hash, contentPath: `${prefix}/${tag}${i}`, rootPath: '', ...over })
      })

    it('passes a box with /movies mapped and /music, /books and a downloads folder not, counting those as ignored', async () => {
      const { pathMap } = twoBoxes()
      const music = Array.from({ length: 40 }, (_, i) => torrent({
        instanceId: 'box-b', hash: String(i).padStart(2, '0').padEnd(40, '0'),
        contentPath: `/music/Album ${i}`, rootPath: `/music/Album ${i}`, savePath: '/music',
      }))
      const [report] = await verifyQbitMappings({
        pathMap,
        sampleSize: 5,
        instances: [source('box-b', [
          ...music,
          torrent({ instanceId: 'box-b', hash: 'b'.repeat(40), contentPath: '/books/Novel.epub', rootPath: '', savePath: '/books' }),
          // Its own trouble in qBittorrent does not matter either: Jellymaid never looks there.
          torrent({ instanceId: 'box-b', hash: 'd'.repeat(40), contentPath: '/downloads/Stray', rootPath: '/downloads/Stray', savePath: '/downloads', state: 'missingFiles' }),
          torrent({ instanceId: 'box-b', hash: 'f'.repeat(40), contentPath: '/movies/Alien (1979)', rootPath: '/movies/Alien (1979)', savePath: '/movies' }),
        ])],
      })
      // The one torrent under the mapped folder is the whole sample, however few the sample takes.
      expect(report).toEqual({
        instanceId: 'box-b', sampled: 1, resolved: 1, failures: [],
        // One example per folder first, then the rest in hash order; never more than five.
        ignored: { count: 42, examples: ['/music/Album 0', '/books/Novel.epub', '/downloads/Stray', '/music/Album 1', '/music/Album 2'] },
      })
    })

    it("fails a typo'd prefix that no completed torrent lies under, and still checks the instance's other folders", async () => {
      const base = tmp('typo')
      const movies = join(base, 'movies')
      const tv = join(base, 'tv')
      release(movies, 'Heat (1995)')
      release(tv, 'Show')
      const pathMap = createPathMap([
        // The box reports /movies; the row says /move.
        { role: 'library', jellyfin: '/data/movies', container: movies, qbit: '/move', qbitInstance: 'box-a' },
        { role: 'library', jellyfin: '/data/tv', container: tv, qbit: '/tv', qbitInstance: 'box-a' },
      ])
      const [report] = await verifyQbitMappings({
        pathMap,
        instances: [source('box-a', [
          torrent({ instanceId: 'box-a', hash: 'a1', contentPath: '/movies/Heat (1995)', rootPath: '/movies/Heat (1995)' }),
          torrent({ instanceId: 'box-a', hash: 'a2', contentPath: '/tv/Show', rootPath: '/tv/Show' }),
        ])],
      })
      expect(report).toEqual({
        instanceId: 'box-a', sampled: 1, resolved: 1,
        failures: [{ qbitPath: '/move', reason: 'no completed torrent of "box-a" reports a path under /move — check the qBittorrent path' }],
        ignored: { count: 1, examples: ['/movies/Heat (1995)'] },
      })
    })

    it('fails a mapped folder that holds only unfinished torrents while the instance has completed ones elsewhere', async () => {
      const { pathMap } = twoBoxes()
      const [report] = await verifyQbitMappings({
        pathMap,
        instances: [source('box-a', [
          torrent({ instanceId: 'box-a', hash: 'a1', contentPath: '/movies/Heat (1995)', rootPath: '/movies/Heat (1995)', progress: 0.5, state: 'downloading' }),
          torrent({ instanceId: 'box-a', hash: 'a2', contentPath: '/music/Album', rootPath: '/music/Album' }),
        ])],
      })
      expect(report).toMatchObject({ instanceId: 'box-a', sampled: 0, resolved: 0, ignored: { count: 1 } })
      expect(report!.failures).toEqual([
        { qbitPath: '/movies', reason: 'no completed torrent of "box-a" reports a path under /movies — check the qBittorrent path' },
      ])
    })

    it('samples every mapped prefix, round-robin, up to sampleSize in total', async () => {
      const base = tmp('strata')
      const pathMap = createPathMap(['anime', 'movies', 'tv'].map((name): PathMapping => (
        { role: 'library', jellyfin: `/data/${name}`, container: join(base, name), qbit: `/${name}`, qbitInstance: 'box-a' }
      )))
      // Nothing is on disk, so every sampled torrent fails and the failures ARE the sample.
      const torrents = [...under('/movies', 'm', 100), ...under('/tv', 't', 2), ...under('/anime', 'a', 1)]
      const perPrefix = (failures: Array<{ qbitPath: string }>) => {
        const counts: Record<string, number> = {}
        for (const f of failures) {
          const prefix = f.qbitPath.split('/')[1]!
          counts[prefix] = (counts[prefix] ?? 0) + 1
        }
        return counts
      }
      const [five] = await verifyQbitMappings({ pathMap, sampleSize: 5, instances: [source('box-a', torrents)] })
      // A spread over the instance's whole hash order would have taken /anime and four films: /tv,
      // two torrents among 103, would never have been looked at.
      expect(five).toMatchObject({ sampled: 5, resolved: 0 })
      expect(perPrefix(five!.failures)).toEqual({ anime: 1, movies: 2, tv: 2 })
      const [twenty] = await verifyQbitMappings({ pathMap, instances: [source('box-a', torrents)] })
      expect(twenty).toMatchObject({ sampled: 20, resolved: 0 })
      expect(perPrefix(twenty!.failures)).toEqual({ anime: 1, movies: 17, tv: 2 })
      expect(twenty!.ignored).toBeUndefined()
    })

    it('fails a mapped folder whose completed torrents are all missingFiles or error, while the other folders pass', async () => {
      const base = tmp('folder-errors')
      const movies = join(base, 'movies')
      const tv = join(base, 'tv')
      release(movies, 'Heat (1995)')
      mkdirSync(tv, { recursive: true })
      const pathMap = createPathMap([
        { role: 'library', jellyfin: '/data/movies', container: movies, qbit: '/movies', qbitInstance: 'box-a' },
        { role: 'library', jellyfin: '/data/tv', container: tv, qbit: '/tv', qbitInstance: 'box-a' },
      ])
      const [report] = await verifyQbitMappings({
        pathMap,
        instances: [source('box-a', [
          torrent({ instanceId: 'box-a', hash: 'a1', contentPath: '/movies/Heat (1995)', rootPath: '/movies/Heat (1995)' }),
          torrent({ instanceId: 'box-a', hash: 'a2', contentPath: '/tv/Show', rootPath: '/tv/Show', state: 'missingFiles' }),
          torrent({ instanceId: 'box-a', hash: 'a3', contentPath: '/tv/Other', rootPath: '/tv/Other', state: 'error' }),
        ])],
      })
      // Nothing under /tv could be checked, which is not "nothing to check" there.
      expect(report).toMatchObject({ instanceId: 'box-a', sampled: 1, resolved: 1 })
      expect(report!.failures).toHaveLength(1)
      expect(report!.failures[0]!.qbitPath).toBe('/tv')
      expect(report!.failures[0]!.reason).toMatch(/every completed torrent under \/tv/i)
      expect(report!.failures[0]!.reason).toMatch(/error, missingFiles/)
    })

    it('places a torrent with no content path by its save path, and fails one that reports neither', async () => {
      const { pathMap } = twoBoxes()
      const heat = torrent({ instanceId: 'box-a', hash: 'a1', contentPath: '/movies/Heat (1995)', rootPath: '/movies/Heat (1995)' })
      const [outside] = await verifyQbitMappings({
        pathMap,
        instances: [source('box-a', [heat, torrent({ instanceId: 'box-a', hash: 'a2', contentPath: null, savePath: '/music' })])],
      })
      expect(outside).toEqual({ instanceId: 'box-a', sampled: 1, resolved: 1, failures: [], ignored: { count: 1, examples: ['/music'] } })
      // Nothing says where it is, so nothing says it is outside every mapped folder.
      const [nowhere] = await verifyQbitMappings({
        pathMap,
        instances: [source('box-a', [heat, torrent({ instanceId: 'box-a', hash: 'a2', contentPath: null, savePath: null })])],
      })
      expect(nowhere).toMatchObject({ instanceId: 'box-a', sampled: 1, resolved: 1 })
      expect(nowhere!.ignored).toBeUndefined()
      expect(nowhere!.failures).toEqual([{ qbitPath: '', reason: expect.stringMatching(/1 completed torrent reports neither a content path nor a save path/) }])
    })
  })

  /**
   * Final re-review N1. The owner's two boxes both report `/movies` and `/tv`. When box B's row is
   * labelled `box-a`, box-a holds two `/movies` rows and only one of them ever translates; box-b's
   * movies lie under none of its own prefixes and are merely ignored. Without a check of its own,
   * Verify passed both boxes — and a delete of box B's seeded film then met only the overridable
   * guard.untracked.
   */
  describe('one instance mapping one prefix to two folders (final re-review N1)', () => {
    /** The owner's layout on disk: `<box>-<kind>/<tag><i>.mkv`, each box's files a size of their own. */
    function ownerLayout() {
      const base = tmp('n1')
      const roots = { aMovies: join(base, 'a-movies'), aTv: join(base, 'a-tv'), bMovies: join(base, 'b-movies'), bTv: join(base, 'b-tv') }
      for (const dir of Object.values(roots)) mkdirSync(dir, { recursive: true })
      const fill = (instanceId: string, root: string, prefix: string, tag: string, count: number, size: number) =>
        Array.from({ length: count }, (_, i) => {
          writeFileSync(join(root, `${tag}${i}.mkv`), 'x'.repeat(size))
          return torrent({
            instanceId, hash: `${tag}${String(i).padStart(3, '0')}`.padEnd(40, '0'),
            contentPath: `${prefix}/${tag}${i}.mkv`, rootPath: '', savePath: prefix, sizeBytes: size,
          })
        })
      const a = [...fill('box-a', roots.aMovies, '/movies', 'am', 15, 10), ...fill('box-a', roots.aTv, '/tv', 'at', 15, 11)]
      const b = [...fill('box-b', roots.bMovies, '/movies', 'bm', 15, 12), ...fill('box-b', roots.bTv, '/tv', 'bt', 15, 13)]
      const row = (container: string, qbit: string, qbitInstance: string): PathMapping =>
        ({ role: 'library', jellyfin: `/data${container}`, container, qbit, qbitInstance })
      return { roots, a, b, row, instances: [source('box-a', a), source('box-b', b)] }
    }

    it("fails box-a when box B's /movies row is labelled box-a, naming both folders, however well the sample resolves", async () => {
      const { roots, row, instances } = ownerLayout()
      const pathMap = createPathMap([
        row(roots.aMovies, '/movies', 'box-a'), row(roots.aTv, '/tv', 'box-a'),
        row(roots.bMovies, '/movies', 'box-a'), // box B's row, mislabelled
        row(roots.bTv, '/tv', 'box-b'),
      ])
      const [boxA, boxB] = await verifyQbitMappings({ pathMap, instances })
      // Everything the sample looks at checks out: box-a's own /movies row is the one that translates.
      expect(boxA).toMatchObject({ instanceId: 'box-a', sampled: 20, resolved: 20 })
      expect(boxA!.failures).toEqual([{
        qbitPath: '/movies',
        reason: expect.stringMatching(/^box-a maps \/movies to two folders \(.+\); one of them probably belongs to another box/),
      }])
      expect(boxA!.failures[0]!.reason).toContain(`(${roots.aMovies}, ${roots.bMovies})`)
      // box-b on its own still reads clean — which is why the failure has to be box-a's.
      expect(boxB).toMatchObject({ instanceId: 'box-b', sampled: 15, resolved: 15, failures: [], ignored: { count: 15 } })
    })

    it('fails box-a once per shadowed prefix when every row is labelled box-a', async () => {
      const { roots, row, instances } = ownerLayout()
      const pathMap = createPathMap([
        row(roots.aMovies, '/movies', 'box-a'), row(roots.aTv, '/tv', 'box-a'),
        row(roots.bMovies, '/movies', 'box-a'), row(roots.bTv, '/tv', 'box-a'),
      ])
      const [boxA, boxB] = await verifyQbitMappings({ pathMap, instances })
      expect(boxA!.failures.map((f) => f.qbitPath)).toEqual(['/movies', '/tv'])
      expect(boxA!.failures[1]!.reason).toContain(`box-a maps /tv to two folders (${roots.aTv}, ${roots.bTv})`)
      // box-b has no mapping at all: nothing of it is translated, so it has nothing to fail.
      expect(boxB).toEqual({ instanceId: 'box-b', sampled: 0, resolved: 0, failures: [], ignored: expect.objectContaining({ count: 30 }) })
    })

    it('fails it whatever the torrents say: with no completed torrent at all, and with a list that cannot be fetched', async () => {
      const { roots, row } = ownerLayout()
      const pathMap = createPathMap([row(roots.aMovies, '/movies', 'box-a'), row(roots.bMovies, '/movies/', 'box-a')])
      const [idle, unreachable] = await verifyQbitMappings({
        pathMap,
        instances: [
          source('box-a', [torrent({ instanceId: 'box-a', hash: 'a1', contentPath: '/movies/x', progress: 0.5 })]),
          { id: 'box-a', torrents: async () => { throw new Error('connect ECONNREFUSED') } },
        ],
      })
      expect(idle).toEqual({
        instanceId: 'box-a', sampled: 0, resolved: 0,
        failures: [{ qbitPath: '/movies', reason: expect.stringMatching(/^box-a maps \/movies to two folders/) }],
      })
      expect(unreachable!.failures).toEqual([
        { qbitPath: '/movies', reason: expect.stringMatching(/^box-a maps \/movies to two folders/) },
        { qbitPath: '', reason: 'could not list torrents: connect ECONNREFUSED' },
      ])
    })

    it('passes the correct two-box layout, where each box maps /movies and /tv once', async () => {
      const { roots, row, instances } = ownerLayout()
      const pathMap = createPathMap([
        row(roots.aMovies, '/movies', 'box-a'), row(roots.aTv, '/tv', 'box-a'),
        row(roots.bMovies, '/movies', 'box-b'), row(roots.bTv, '/tv', 'box-b'),
      ])
      expect(await verifyQbitMappings({ pathMap, instances })).toEqual([
        { instanceId: 'box-a', sampled: 20, resolved: 20, failures: [] },
        { instanceId: 'box-b', sampled: 20, resolved: 20, failures: [] },
      ])
    })

    // The deepest prefix translates its own subtree and the parent the rest: one answer per path.
    it('passes nested prefixes of one instance whose folders are unrelated', async () => {
      const base = tmp('n1-nested')
      const downloads = join(base, 'downloads')
      const movies = join(base, 'movies')
      mkdirSync(downloads, { recursive: true })
      mkdirSync(movies, { recursive: true })
      writeFileSync(join(downloads, 'Stray.mkv'), 'x'.repeat(3))
      writeFileSync(join(movies, 'Heat.mkv'), 'x'.repeat(4))
      const pathMap = createPathMap([
        { role: 'download', jellyfin: null, container: downloads, qbit: '/data', qbitInstance: 'box-a' },
        { role: 'library', jellyfin: '/data/movies', container: movies, qbit: '/data/movies', qbitInstance: 'box-a' },
      ])
      const [report] = await verifyQbitMappings({
        pathMap,
        instances: [source('box-a', [
          torrent({ instanceId: 'box-a', hash: 'a1', contentPath: '/data/Stray.mkv', rootPath: '', sizeBytes: 3 }),
          torrent({ instanceId: 'box-a', hash: 'a2', contentPath: '/data/movies/Heat.mkv', rootPath: '', sizeBytes: 4 }),
        ])],
      })
      expect(report).toEqual({ instanceId: 'box-a', sampled: 2, resolved: 2, failures: [] })
    })
  })
})

/** A mapping whose torrent side is not set yet: all Auto-detect is given to work from is where the root is. */
const bare = (container: string): PathMapping => ({ role: 'library', jellyfin: `/data${container}`, container, qbit: null, qbitInstance: null })

/** Writes `<container>/<folder>/<folder>.mkv`, the shape of a multi-file release with one video in it. */
function release(container: string, folder: string, bytes = 1) {
  mkdirSync(join(container, folder), { recursive: true })
  writeFileSync(join(container, folder, `${folder}.mkv`), 'x'.repeat(bytes))
}

/** A multi-file torrent: its content path is the release folder. */
const folderTorrent = (instanceId: string, hash: string, qbitPath: string, over: Partial<Torrent> = {}) =>
  torrent({ instanceId, hash, contentPath: qbitPath, rootPath: qbitPath, ...over })

describe('autoDetectQbitMappings', () => {
  it("detect proposes {qbit:'/movies', qbitInstance:'box-b'} for the container holding box-b's files, and nothing when two instances both fit", async () => {
    const base = tmp('detect')
    const a = join(base, 'a', 'movies')
    const b = join(base, 'b', 'movies')
    release(a, 'Heat (1995)')
    release(b, 'Alien (1979)')
    const instances = [
      source('box-a', [folderTorrent('box-a', 'a1', '/movies/Heat (1995)')]),
      source('box-b', [folderTorrent('box-b', 'b1', '/movies/Alien (1979)')]),
    ]

    // Each box's files are under its own root only, so each root has exactly one owner.
    const proposals = await autoDetectQbitMappings({ mappings: [bare(a), bare(b)], instances })
    expect(proposals).toEqual<QbitMappingProposal[]>([
      { container: a, qbitInstance: 'box-a', qbit: '/movies', support: 1 },
      { container: b, qbitInstance: 'box-b', qbit: '/movies', support: 1 },
    ])

    // A root holding BOTH boxes' releases cannot be told apart: no proposal for it, and the roots
    // that are unambiguous keep theirs.
    const shared = join(base, 'shared', 'movies')
    release(shared, 'Heat (1995)')
    release(shared, 'Alien (1979)')
    expect(await autoDetectQbitMappings({ mappings: [bare(shared)], instances })).toEqual([])
    expect(await autoDetectQbitMappings({ mappings: [bare(a), bare(shared), bare(b)], instances })).toEqual([
      { container: a, qbitInstance: 'box-a', qbit: '/movies', support: 1 },
      { container: b, qbitInstance: 'box-b', qbit: '/movies', support: 1 },
    ])
  })

  it('detect does not block the event loop', async () => {
    const base = tmp('loop')
    const a = join(base, 'a', 'movies')
    const b = join(base, 'b', 'movies')
    const count = 120
    const torrentsFor = (id: string, root: string) => Array.from({ length: count }, (_, i) => {
      const folder = `${id} Film ${String(i).padStart(3, '0')} (2000)`
      release(root, folder)
      return folderTorrent(id, `${id}${String(i).padStart(4, '0')}`.padEnd(40, '0'), `/movies/${folder}`)
    })
    const events: string[] = []
    // The timer is armed from inside the last thing detect awaits before it starts working through
    // the torrents, so nothing that happens earlier can be what gives it its turn: only the search itself can.
    const armedOnList = (id: string, list: Torrent[]): QbitSampleSource => ({
      id,
      torrents: async () => { if (events.length === 0) setTimeout(() => events.push('timer'), 0); return list },
    })
    const instances = [armedOnList('box-a', torrentsFor('a', a)), source('box-b', torrentsFor('b', b))]

    const proposals = await autoDetectQbitMappings({ mappings: [bare(a), bare(b)], instances, sampleSize: count })
    events.push('detect finished')

    // Hundreds of torrents against two roots, searched inside one turn of the event loop, would hold
    // the server for the whole search: the timer — due since the first millisecond — fires before
    // detect is done only if detect hands the loop back while it works.
    expect(events).toEqual(['timer', 'detect finished'])
    expect(proposals.map((p) => [p.qbitInstance, p.support])).toEqual([['box-a', count], ['box-b', count]])
  })

  it('ignores a torrent both instances report: the file system cannot say whose copy a shared release is', async () => {
    const base = tmp('shared-hash')
    const a = join(base, 'a', 'movies')
    const b = join(base, 'b', 'movies')
    // The same release is cross-seeded from both boxes, so BOTH libraries hold it ...
    release(a, 'Cross Seeded (2001)')
    release(b, 'Cross Seeded (2001)')
    // ... and each box also holds a release of its own.
    release(a, 'Only On A (2002)')
    release(b, 'Only On B (2003)')
    const crossHash = 'c'.repeat(40)
    const proposals = await autoDetectQbitMappings({
      mappings: [bare(a), bare(b)],
      instances: [
        source('box-a', [folderTorrent('box-a', crossHash, '/movies/Cross Seeded (2001)'), folderTorrent('box-a', 'a'.repeat(40), '/movies/Only On A (2002)')]),
        source('box-b', [folderTorrent('box-b', crossHash, '/movies/Cross Seeded (2001)'), folderTorrent('box-b', 'b'.repeat(40), '/movies/Only On B (2003)')]),
      ],
    })
    // Counted, the shared release would put each box's evidence under BOTH roots and leave both ambiguous.
    expect(proposals).toEqual([
      { container: a, qbitInstance: 'box-a', qbit: '/movies', support: 1 },
      { container: b, qbitInstance: 'box-b', qbit: '/movies', support: 1 },
    ])
  })

  it('proposes nothing for a root whose only evidence is a shared torrent', async () => {
    const base = tmp('only-shared')
    const a = join(base, 'a', 'movies')
    release(a, 'Cross Seeded (2001)')
    const hash = 'c'.repeat(40)
    const proposals = await autoDetectQbitMappings({
      mappings: [bare(a)],
      instances: [source('box-a', [folderTorrent('box-a', hash, '/movies/Cross Seeded (2001)')]), source('box-b', [folderTorrent('box-b', hash, '/films/Cross Seeded (2001)')])],
    })
    expect(proposals).toEqual([])
  })

  it('finds a deeper prefix when the box nests its root under a longer path', async () => {
    const base = tmp('deep')
    const lib = join(base, 'lib')
    release(lib, 'Heat (1995)')
    release(lib, 'Alien (1979)')
    const proposals = await autoDetectQbitMappings({
      mappings: [bare(lib)],
      instances: [source('box-a', [
        folderTorrent('box-a', '1'.repeat(40), '/data/torrents/movies/Heat (1995)'),
        folderTorrent('box-a', '2'.repeat(40), '/data/torrents/movies/Alien (1979)'),
      ])],
    })
    expect(proposals).toEqual([{ container: lib, qbitInstance: 'box-a', qbit: '/data/torrents/movies', support: 2 }])
  })

  it('takes the prefix most torrents agree on over a coincidental match from one', async () => {
    const base = tmp('vote')
    const lib = join(base, 'lib')
    release(lib, 'One (2000)')
    release(lib, 'Two (2001)')
    release(lib, 'Three (2002)')
    // A decoy: `lib/movies/Three (2002)/...` exists too, so for ONE torrent the shorter prefix /data also fits.
    release(join(lib, 'movies'), 'Three (2002)')
    const proposals = await autoDetectQbitMappings({
      mappings: [bare(lib)],
      instances: [source('box-a', [
        folderTorrent('box-a', '1'.repeat(40), '/data/movies/One (2000)'),
        folderTorrent('box-a', '2'.repeat(40), '/data/movies/Two (2001)'),
        folderTorrent('box-a', '3'.repeat(40), '/data/movies/Three (2002)'),
      ])],
    })
    // Two torrents back /data/movies; the decoy torrent's own vote went to /data, and loses 2 to 1.
    expect(proposals).toEqual([{ container: lib, qbitInstance: 'box-a', qbit: '/data/movies', support: 2 }])
  })

  it('proposes nothing when the evidence is split evenly between two prefixes', async () => {
    const base = tmp('split')
    const lib = join(base, 'lib')
    release(lib, 'One (2000)')
    release(lib, 'Two (2001)')
    const proposals = await autoDetectQbitMappings({
      mappings: [bare(lib)],
      instances: [source('box-a', [
        folderTorrent('box-a', '1'.repeat(40), '/movies/One (2000)'),
        folderTorrent('box-a', '2'.repeat(40), '/films/Two (2001)'),
      ])],
    })
    expect(proposals).toEqual([])
  })

  it("never proposes '/' as a prefix, however well the files line up under it", async () => {
    const base = tmp('rootprefix')
    const lib = join(base, 'lib')
    release(join(lib, 'movies'), 'Heat (1995)')
    // The box's whole file system IS this container, so only a prefix of "/" would translate it —
    // and "/" is not a prefix a mapping can express (rebasing "/x" onto it drops the separator).
    const proposals = await autoDetectQbitMappings({
      mappings: [bare(lib)],
      instances: [source('box-a', [folderTorrent('box-a', '1'.repeat(40), '/movies/Heat (1995)')])],
    })
    expect(proposals).toEqual([])
  })

  it("checks a single-file torrent's size before counting its file as evidence", async () => {
    const base = tmp('size')
    const lib = join(base, 'lib')
    mkdirSync(lib, { recursive: true })
    writeFileSync(join(lib, 'Film.mkv'), 'x'.repeat(10))
    const single = (sizeBytes: number) =>
      torrent({ instanceId: 'box-a', hash: '1'.repeat(40), contentPath: '/movies/Film.mkv', rootPath: '', sizeBytes })
    expect(await autoDetectQbitMappings({ mappings: [bare(lib)], instances: [source('box-a', [single(999)])] })).toEqual([])
    expect(await autoDetectQbitMappings({ mappings: [bare(lib)], instances: [source('box-a', [single(10)])] })).toEqual([
      { container: lib, qbitInstance: 'box-a', qbit: '/movies', support: 1 },
    ])
  })

  it('does not let one box claim two roots with the same prefix: the root with the most evidence keeps it', async () => {
    const base = tmp('claims')
    const lib = join(base, 'lib')
    const archive = join(base, 'archive')
    release(lib, 'One (2000)')
    release(lib, 'Two (2001)')
    release(lib, 'Three (2002)')
    release(archive, 'One (2000)') // a same-named copy, so box A's torrent coincidentally "fits" here too
    const proposals = await autoDetectQbitMappings({
      mappings: [bare(archive), bare(lib)],
      instances: [source('box-a', [
        folderTorrent('box-a', '1'.repeat(40), '/movies/One (2000)'),
        folderTorrent('box-a', '2'.repeat(40), '/movies/Two (2001)'),
        folderTorrent('box-a', '3'.repeat(40), '/movies/Three (2002)'),
      ])],
    })
    expect(proposals).toEqual([{ container: lib, qbitInstance: 'box-a', qbit: '/movies', support: 3 }])
  })

  it('drops both roots when two claim the same prefix with equal evidence', async () => {
    const base = tmp('claims-tie')
    const one = join(base, 'one')
    const two = join(base, 'two')
    release(one, 'Film (2000)')
    release(two, 'Film (2000)')
    const proposals = await autoDetectQbitMappings({
      mappings: [bare(one), bare(two)],
      instances: [source('box-a', [folderTorrent('box-a', '1'.repeat(40), '/movies/Film (2000)')])],
    })
    expect(proposals).toEqual([])
  })

  it('lets the other boxes propose when one cannot be asked', async () => {
    const base = tmp('down')
    const b = join(base, 'b', 'movies')
    release(b, 'Alien (1979)')
    const proposals = await autoDetectQbitMappings({
      mappings: [bare(b)],
      instances: [
        { id: 'box-a', torrents: async () => { throw new Error('unreachable') } },
        source('box-b', [folderTorrent('box-b', '1'.repeat(40), '/movies/Alien (1979)')]),
      ],
    })
    expect(proposals).toEqual([{ container: b, qbitInstance: 'box-b', qbit: '/movies', support: 1 }])
  })

  it('looks at no more than sampleSize torrents per instance', async () => {
    const base = tmp('sample')
    const lib = join(base, 'lib')
    const torrents = Array.from({ length: 12 }, (_, i) => {
      release(lib, `Film ${i} (2000)`)
      return folderTorrent('box-a', `${String(i).padStart(2, '0')}`.padEnd(40, '0'), `/movies/Film ${i} (2000)`)
    })
    const [few] = await autoDetectQbitMappings({ mappings: [bare(lib)], instances: [source('box-a', torrents)], sampleSize: 4 })
    expect(few!.support).toBe(4)
    const [def] = await autoDetectQbitMappings({ mappings: [bare(lib)], instances: [source('box-a', torrents)] })
    expect(def!.support).toBe(12)
  })

  it('ignores torrents that are unfinished, have no content path, or whose path cannot be a prefix-relative one', async () => {
    const base = tmp('junk')
    const lib = join(base, 'lib')
    release(lib, 'Heat (1995)')
    release(lib, 'Alien (1979)')
    const proposals = await autoDetectQbitMappings({
      mappings: [bare(lib)],
      instances: [source('box-a', [
        folderTorrent('box-a', '1'.repeat(40), '/movies/Heat (1995)', { progress: 0.5 }),
        torrent({ instanceId: 'box-a', hash: '2'.repeat(40), contentPath: null }),
        folderTorrent('box-a', '3'.repeat(40), 'movies/Heat (1995)'), // relative
        folderTorrent('box-a', '4'.repeat(40), 'D:\\movies\\Heat (1995)'), // another OS's spelling
        folderTorrent('box-a', '5'.repeat(40), '/movies/../movies/Heat (1995)'), // not a normalized path
        folderTorrent('box-a', '6'.repeat(40), '/movies/Alien (1979)'),
      ])],
    })
    expect(proposals).toEqual([{ container: lib, qbitInstance: 'box-a', qbit: '/movies', support: 1 }])
  })

  it('proposes nothing for a root that is not on disk, and tolerates a root listed twice', async () => {
    const base = tmp('missing')
    const lib = join(base, 'lib')
    release(lib, 'Heat (1995)')
    const proposals = await autoDetectQbitMappings({
      mappings: [bare(join(base, 'nope')), bare(lib), bare(lib)],
      instances: [source('box-a', [folderTorrent('box-a', '1'.repeat(40), '/movies/Heat (1995)')])],
    })
    expect(proposals).toEqual([{ container: lib, qbitInstance: 'box-a', qbit: '/movies', support: 1 }])
  })

  it('asks no instance for its torrents when there is no root on disk to place them against', async () => {
    let asked = 0
    const counting: QbitSampleSource = { id: 'box-a', torrents: async () => { asked += 1; return [] } }
    expect(await autoDetectQbitMappings({ mappings: [], instances: [counting] })).toEqual([])
    expect(await autoDetectQbitMappings({ mappings: [bare(join(tmp('absent'), 'nope'))], instances: [counting] })).toEqual([])
    expect(asked).toBe(0)
  })

  it('proposes nothing when there is nobody to ask or nothing to place', async () => {
    const lib = join(tmp('none'), 'lib')
    mkdirSync(lib)
    expect(await autoDetectQbitMappings({ mappings: [bare(lib)], instances: [] })).toEqual([])
    expect(await autoDetectQbitMappings({ mappings: [], instances: [source('box-a', [])] })).toEqual([])
    expect(await autoDetectQbitMappings({ mappings: [bare(lib)], instances: [source('box-a', [])] })).toEqual([])
  })
})
