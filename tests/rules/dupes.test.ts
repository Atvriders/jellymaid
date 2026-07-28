import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../src/index/db.js'
import { DUPE_RULES } from '../../src/rules/dupes/index.js'
import { fileConfigSchema } from '../../src/config/schema.js'

let db: Db
const config = fileConfigSchema.parse({})
const ctx = () => ({ db, config, scanId: 1, now: 'T' })
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
