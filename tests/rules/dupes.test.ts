import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../src/index/db.js'
import { DUPE_RULES } from '../../src/rules/dupes/index.js'
import { dupeGroupRule } from '../../src/rules/dupes/adapter.js'
import { fileConfigSchema } from '../../src/config/schema.js'
import type { SourceName } from '../../src/rules/types.js'

let db: Db
const config = fileConfigSchema.parse({})
const ALL_SOURCES = new Set<SourceName>(['jellyfin', 'filesystem', 'qbittorrent', 'arr', 'hashes'])
const ctx = () => ({ db, config, scanId: 1, now: 'T', availableSources: ALL_SOURCES })
const rule = (id: string) => DUPE_RULES.find((r) => r.id === id)!

function item(over: Partial<Record<string, unknown>> = {}) {
  const base = {
    id: 'i1', scan_id: 1, type: 'Movie', name: 'Heat', year: 1995, provider_ids_json: '{}',
    jf_path: '/media/Movies/Heat.mkv', container_path: '/mnt/m/Heat.mkv', size_bytes: 100,
    runtime_ticks: 106_920_000_000, series_id: null, season_no: null, episode_no: null,
    has_primary_image: 1,
  }
  const row = { ...base, ...over }
  db.prepare(`INSERT INTO jellyfin_items
    (id, scan_id, type, name, year, provider_ids_json, jf_path, container_path, size_bytes,
     runtime_ticks, series_id, season_no, episode_no, has_primary_image)
    VALUES (@id,@scan_id,@type,@name,@year,@provider_ids_json,@jf_path,@container_path,
            @size_bytes,@runtime_ticks,@series_id,@season_no,@episode_no,@has_primary_image)`).run(row)
  return row
}

beforeEach(() => { db = openDb(join(mkdtempSync(join(tmpdir(), 'jm-dupe-')), 'db.sqlite')) })

describe('dupe.provider-id', () => {
  it('links two items sharing a tmdb id', () => {
    item({ id: 'a', provider_ids_json: '{"tmdb":"949"}' })
    item({ id: 'b', provider_ids_json: '{"tmdb":"949"}' })
    const links = rule('dupe.provider-id').link(ctx())
    expect(links).toHaveLength(1)
    expect([links[0]!.a, links[0]!.b].sort()).toEqual(['a', 'b'])
    expect(links[0]!.confidence).toBe('exact')
  })

  it('does not link across different provider namespaces with equal numbers', () => {
    item({ id: 'a', provider_ids_json: '{"tmdb":"1"}' })
    item({ id: 'b', provider_ids_json: '{"tvdb":"1"}' })
    expect(rule('dupe.provider-id').link(ctx())).toHaveLength(0)
  })

  it('ignores items with no provider ids', () => {
    item({ id: 'a' }); item({ id: 'b' })
    expect(rule('dupe.provider-id').link(ctx())).toHaveLength(0)
  })

  it('links all pairs in a triple', () => {
    for (const id of ['a', 'b', 'c']) item({ id, provider_ids_json: '{"imdb":"tt1"}' })
    expect(rule('dupe.provider-id').link(ctx())).toHaveLength(3)
  })

  it('provider-id ignores tmdbcollection and *collection* keys', () => {
    // Every film of a TMDB collection carries the collection's id. Read as an identity, it made
    // every Alien film an "exact" duplicate of every other.
    item({ id: 'alien', name: 'Alien', provider_ids_json: '{"tmdb":"348","tmdbcollection":"8091"}' })
    item({ id: 'aliens', name: 'Aliens', provider_ids_json: '{"tmdb":"679","tmdbcollection":"8091"}' })
    // A legacy row whose keys were never lowercased, and other collection-style namespaces.
    item({ id: 'alien3', name: 'Alien 3', provider_ids_json: '{"Tmdb":"8077","TmdbCollection":"8091","boxsetcollection":"7"}' })
    item({ id: 'resurrection', name: 'Alien Resurrection', provider_ids_json: '{"tmdb":"8078","collectionid":"8091","boxsetcollection":"7"}' })
    expect(rule('dupe.provider-id').link(ctx())).toEqual([])

    // A real identity still links, and only through its own namespace.
    item({ id: 'alien-4k', name: 'Alien', provider_ids_json: '{"Tmdb":"348","TmdbCollection":"8091"}' })
    const links = rule('dupe.provider-id').link(ctx())
    expect(links).toHaveLength(1)
    expect([links[0]!.a, links[0]!.b].sort()).toEqual(['alien', 'alien-4k'])
    expect(links[0]!.evidence).toMatchObject({ providerId: 'tmdb:348' })
  })

  it('uses only the tmdb, imdb and tvdb namespaces as identities', () => {
    item({ id: 'a', provider_ids_json: '{"tvrage":"5","tvmaze":"9","zap2it":"EP1"}' })
    item({ id: 'b', provider_ids_json: '{"tvrage":"5","tvmaze":"9","zap2it":"EP1"}' })
    expect(rule('dupe.provider-id').link(ctx())).toEqual([])
  })

  it('provider-id links only items of the same type', () => {
    // A TV film can be listed as a Movie in one library and an Episode in another, carrying the
    // same imdb id. A movie file and an episode file are not copies of one another.
    item({ id: 'movie', type: 'Movie', provider_ids_json: '{"imdb":"tt0123"}' })
    item({ id: 'episode', type: 'Episode', provider_ids_json: '{"imdb":"tt0123"}', series_id: 's1', season_no: 1, episode_no: 1 })
    expect(rule('dupe.provider-id').link(ctx())).toEqual([])

    item({ id: 'episode-2', type: 'Episode', provider_ids_json: '{"imdb":"tt0123"}', series_id: 's2', season_no: 1, episode_no: 1 })
    const links = rule('dupe.provider-id').link(ctx())
    expect(links).toHaveLength(1)
    expect([links[0]!.a, links[0]!.b].sort()).toEqual(['episode', 'episode-2'])
  })

  it('never links an item to itself when a legacy row spells one namespace twice', () => {
    item({ id: 'a', provider_ids_json: '{"Tmdb":"1","tmdb":"1"}' })
    item({ id: 'b', provider_ids_json: '{"tmdb":"1"}' })
    const links = rule('dupe.provider-id').link(ctx())
    expect(links).toHaveLength(1)
    expect(links[0]!.a).not.toBe(links[0]!.b)
  })
})

describe('dupe.series-episode', () => {
  it('links two files of the same episode', () => {
    item({ id: 'a', type: 'Episode', series_id: 's1', season_no: 1, episode_no: 1 })
    item({ id: 'b', type: 'Episode', series_id: 's1', season_no: 1, episode_no: 1 })
    expect(rule('dupe.series-episode').link(ctx())).toHaveLength(1)
  })

  it('does not link different episodes or different series', () => {
    item({ id: 'a', type: 'Episode', series_id: 's1', season_no: 1, episode_no: 1 })
    item({ id: 'b', type: 'Episode', series_id: 's1', season_no: 1, episode_no: 2 })
    item({ id: 'c', type: 'Episode', series_id: 's2', season_no: 1, episode_no: 1 })
    expect(rule('dupe.series-episode').link(ctx())).toHaveLength(0)
  })

  it('ignores episodes with a null season', () => {
    item({ id: 'a', type: 'Episode', series_id: 's1', season_no: null, episode_no: 1 })
    item({ id: 'b', type: 'Episode', series_id: 's1', season_no: null, episode_no: 1 })
    expect(rule('dupe.series-episode').link(ctx())).toHaveLength(0)
  })

  /** A Series row as the Jellyfin phase writes it: no path of its own to compare, keys lowercased. */
  const series = (id: string, providerIds: Record<string, string>) => item({
    id, type: 'Series', name: 'The Beverly Hillbillies', year: 1962, provider_ids_json: JSON.stringify(providerIds),
    jf_path: null, container_path: null, size_bytes: null, runtime_ticks: null,
  })
  const episode = (id: string, seriesId: string, seasonNo: number, episodeNo: number, file = `${id}.mkv`) => item({
    id, type: 'Episode', name: 'Getting Settled', year: null, provider_ids_json: '{}', series_id: seriesId,
    season_no: seasonNo, episode_no: episodeNo, jf_path: `/media/tv/${file}`, container_path: `/mnt/tv/${file}`,
  })

  it('series-episode matches the same show across two Series items via series tvdb id', () => {
    // Jellyfin lists the same show in two library roots (box A's tv, box B's tv) as two Series
    // items with two ids, so keying on series_id alone never matched box A's pack episode against
    // box B's single episode.
    series('series-box-a', { imdb: 'tt0055662', tmdb: '1930', tvdb: '71471' })
    series('series-box-b', { imdb: 'tt0055662', tmdb: '1930', tvdb: '71471' })
    episode('pack-e01', 'series-box-a', 1, 1)
    episode('pack-e02', 'series-box-a', 1, 2)
    episode('single-e02', 'series-box-b', 1, 2)

    const links = rule('dupe.series-episode').link(ctx())
    expect(links).toHaveLength(1)
    expect([links[0]!.a, links[0]!.b].sort()).toEqual(['pack-e02', 'single-e02'])
    expect(links[0]!.confidence).toBe('exact')
    expect(links[0]!.evidence).toMatchObject({ episodeKey: 'tvdb:71471|1|2' })
  })

  it('keys a show on tvdb, then tmdb, then imdb', () => {
    // No tvdb on either side: the two Series items still agree on tmdb.
    series('s-a', { tmdb: '1930', imdb: 'tt0055662' })
    series('s-b', { Tmdb: '1930' })
    episode('a', 's-a', 1, 2)
    episode('b', 's-b', 1, 2)
    expect(rule('dupe.series-episode').link(ctx())[0]!.evidence).toMatchObject({ episodeKey: 'tmdb:1930|1|2' })

    // tvdb outranks tmdb: two shows tvdb calls different are different, whatever tmdb says.
    series('s-c', { tvdb: '1', tmdb: '77' })
    series('s-d', { tvdb: '2', tmdb: '77' })
    episode('c', 's-c', 3, 4)
    episode('d', 's-d', 3, 4)
    const keys = rule('dupe.series-episode').link(ctx()).map((l) => [l.a, l.b].sort().join('+'))
    expect(keys).toEqual(['a+b'])
  })

  it('multi-episode file links strong, not exact', () => {
    // Jellyfin numbers a two-part file by its first episode, so S01E01E02 lands on S01E01's key.
    // It is not a copy of S01E01 — it also holds S01E02 — so it never makes an exact group.
    series('show', { tvdb: '71471' })
    episode('single', 'show', 1, 1, 'Show.S01E01.1080p.mkv')
    episode('double', 'show', 1, 1, 'Show.S01E01E02.720p.mkv')
    const links = rule('dupe.series-episode').link(ctx())
    expect(links).toHaveLength(1)
    expect(links[0]!.confidence).toBe('strong')
    expect(links[0]!.evidence).toMatchObject({ multiEpisode: true })

    // The episodes' own provider ids (both carry the first episode's id) do not make it exact either.
    db.prepare(`UPDATE jellyfin_items SET provider_ids_json = '{"tvdb":"297788"}' WHERE id IN ('single','double')`).run()
    expect(rule('dupe.provider-id').link(ctx()).map((l) => l.confidence)).toEqual(['strong'])
    const groups = dupeGroupRule.run(ctx())
    expect(groups).toHaveLength(1)
    expect(groups[0]!.confidence).toBe('strong')
  })

  it.each(['Show.S01E01-E02.mkv', 'Show.S01E01-02.mkv'])('also links %s strong', (file) => {
    series('show', { tvdb: '71471' })
    episode('single', 'show', 1, 1, 'Show.S01E01.mkv')
    episode('double', 'show', 1, 1, file)
    expect(rule('dupe.series-episode').link(ctx()).map((l) => l.confidence)).toEqual(['strong'])
  })

  it('still links two single-episode files exact', () => {
    series('show', { tvdb: '71471' })
    episode('a', 'show', 1, 1, 'Show.S01E01.1080p.mkv')
    episode('b', 'show', 1, 1, 'Show.S01E01.720p.mkv')
    const links = rule('dupe.series-episode').link(ctx())
    expect(links.map((l) => l.confidence)).toEqual(['exact'])
    expect(links[0]!.evidence).toMatchObject({ multiEpisode: false })
  })

  it('falls back to series_id when the Series row is absent or has no identity id', () => {
    series('unidentified', { tmdbcollection: '9' })
    episode('a', 'unidentified', 1, 1)
    episode('b', 'unidentified', 1, 1)
    episode('c', 'not-in-index', 1, 1)
    episode('d', 'not-in-index', 1, 1)
    const links = rule('dupe.series-episode').link(ctx())
    expect(links.map((l) => [l.a, l.b].sort().join('+')).sort()).toEqual(['a+b', 'c+d'])
  })
})

describe('dupe.title-year', () => {
  it('links items whose normalized title and year agree', () => {
    item({ id: 'a', name: 'The Matrix', year: 1999 })
    item({ id: 'b', name: 'Matrix, The (1999)', year: 1999 })
    expect(rule('dupe.title-year').link(ctx())[0]!.confidence).toBe('strong')
  })

  it('does not link the same title in different years', () => {
    item({ id: 'a', name: 'Dune', year: 1984 })
    item({ id: 'b', name: 'Dune', year: 2021 })
    expect(rule('dupe.title-year').link(ctx())).toHaveLength(0)
  })

  it('skips items with no year rather than grouping every yearless item together', () => {
    item({ id: 'a', name: 'Dune', year: null })
    item({ id: 'b', name: 'Dune', year: null })
    expect(rule('dupe.title-year').link(ctx())).toHaveLength(0)
  })
})

describe('dupe.runtime', () => {
  it('links same-title items within the tolerance', () => {
    item({ id: 'a', name: 'Heat', year: null, runtime_ticks: 106_920_000_000 })
    item({ id: 'b', name: 'Heat', year: null, runtime_ticks: 106_930_000_000 })
    expect(rule('dupe.runtime').link(ctx())).toHaveLength(1)
  })

  it('does not link when runtimes differ beyond the tolerance', () => {
    item({ id: 'a', name: 'Heat', runtime_ticks: 106_920_000_000 })
    item({ id: 'b', name: 'Heat', runtime_ticks: 206_920_000_000 })
    expect(rule('dupe.runtime').link(ctx())).toHaveLength(0)
  })

  it('does not link same-titled episodes of different series, even within tolerance', () => {
    // Unrelated shows reuse generic episode titles ("Pilot") that normalize identically, and
    // standard broadcast slot lengths mean two unrelated episodes can land inside the runtime
    // tolerance too. Episode duplicates are dupe.series-episode's job, not this rule's.
    item({
      id: 'a', type: 'Episode', name: 'Pilot', year: null,
      series_id: 's1', season_no: 1, episode_no: 1, runtime_ticks: 13_200_000_000,
    })
    item({
      id: 'b', type: 'Episode', name: 'Pilot', year: null,
      series_id: 's2', season_no: 1, episode_no: 1, runtime_ticks: 13_210_000_000,
    })
    expect(rule('dupe.runtime').link(ctx())).toHaveLength(0)
  })
})

describe('dupe.identical-file', () => {
  it('links items whose files share size and quick hash', () => {
    item({ id: 'a', container_path: '/mnt/m/A.mkv', size_bytes: 100 })
    item({ id: 'b', container_path: '/mnt/n/B.mkv', size_bytes: 100 })
    for (const [p, h] of [['/mnt/m/A.mkv', 'deadbeef'], ['/mnt/n/B.mkv', 'deadbeef']] as const) {
      db.prepare(`INSERT INTO fs_entries (container_path, scan_id, parent_path, name, is_dir, size_bytes, quick_hash, is_media)
        VALUES (?,1,'/','x',0,100,?,1)`).run(p, h)
    }
    expect(rule('dupe.identical-file').link(ctx())[0]!.confidence).toBe('exact')
  })

  it('does not link when hashes differ despite equal size', () => {
    item({ id: 'a', container_path: '/mnt/m/A.mkv', size_bytes: 100 })
    item({ id: 'b', container_path: '/mnt/n/B.mkv', size_bytes: 100 })
    for (const [p, h] of [['/mnt/m/A.mkv', 'aaa'], ['/mnt/n/B.mkv', 'bbb']] as const) {
      db.prepare(`INSERT INTO fs_entries (container_path, scan_id, parent_path, name, is_dir, size_bytes, quick_hash, is_media)
        VALUES (?,1,'/','x',0,100,?,1)`).run(p, h)
    }
    expect(rule('dupe.identical-file').link(ctx())).toHaveLength(0)
  })

  it('declares hashes as a required source', () => {
    expect(rule('dupe.identical-file').requires).toContain('hashes')
  })
})

describe('dupe.fuzzy-title', () => {
  it('links near-identical but non-identical titles above the configured similarity', () => {
    // Deliberately NOT an exact-key pair: identical keys belong to dupe.title-year,
    // and the fuzzy rule skips them so the same pair is not reported twice.
    item({ id: 'a', name: 'The Hobbit', year: 2012 })
    item({ id: 'b', name: 'The Hobbits', year: 2012 })
    const links = rule('dupe.fuzzy-title').link({ ...ctx(), config: fileConfigSchema.parse({ rules: { 'dupe.fuzzy-title': { similarity: 0.7 } } }) })
    expect(links[0]!.confidence).toBe('possible')
  })

  it('respects a raised threshold', () => {
    item({ id: 'a', name: 'Alien' })
    item({ id: 'b', name: 'Aliens' })
    const strict = fileConfigSchema.parse({ rules: { 'dupe.fuzzy-title': { similarity: 0.99 } } })
    expect(rule('dupe.fuzzy-title').link({ ...ctx(), config: strict })).toHaveLength(0)
  })

  it('can be disabled entirely', () => {
    item({ id: 'a', name: 'Alien' }); item({ id: 'b', name: 'Aliens' })
    const off = fileConfigSchema.parse({ rules: { 'dupe.fuzzy-title': { enabled: false } } })
    expect(rule('dupe.fuzzy-title').link({ ...ctx(), config: off })).toHaveLength(0)
  })
})
