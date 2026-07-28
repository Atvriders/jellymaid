// tests/rules/metadata.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../src/index/db.js'
import { METADATA_RULES } from '../../src/rules/metadata/index.js'
import { fileConfigSchema } from '../../src/config/schema.js'

let db: Db
const config = fileConfigSchema.parse({})
const ctx = () => ({ db, config, scanId: 1, now: 'T' })
const rule = (id: string) => METADATA_RULES.find((r) => r.id === id)!

function item(over: Record<string, unknown> = {}) {
  const row = {
    id: 'i1', type: 'Movie', name: 'Heat', year: 1995, provider_ids_json: '{"tmdb":"949"}',
    jf_path: '/media/Movies/Heat (1995)/Heat (1995).mkv', container_path: '/mnt/m/Heat.mkv',
    has_primary_image: 1, series_id: null, season_no: null, episode_no: null, library_name: 'Movies',
    ...over,
  }
  db.prepare(`INSERT INTO jellyfin_items (id, scan_id, type, name, year, provider_ids_json, jf_path,
    container_path, has_primary_image, series_id, season_no, episode_no, library_name)
    VALUES (@id,1,@type,@name,@year,@provider_ids_json,@jf_path,@container_path,@has_primary_image,
            @series_id,@season_no,@episode_no,@library_name)`).run(row)
}

beforeEach(() => { db = openDb(join(mkdtempSync(join(tmpdir(), 'jm-meta-')), 'db.sqlite')) })

describe('meta.unidentified', () => {
  it('reports an item with no provider ids', () => {
    item({ provider_ids_json: '{}' })
    expect(rule('meta.unidentified').run(ctx())).toHaveLength(1)
  })
  it('ignores an identified item', () => {
    item()
    expect(rule('meta.unidentified').run(ctx())).toHaveLength(0)
  })
  it('ignores Season rows, which never carry provider ids', () => {
    item({ type: 'Season', provider_ids_json: '{}' })
    expect(rule('meta.unidentified').run(ctx())).toHaveLength(0)
  })
})

describe('meta.missing-artwork', () => {
  it('reports an item with no primary image', () => {
    item({ has_primary_image: 0 })
    expect(rule('meta.missing-artwork').run(ctx())).toHaveLength(1)
  })
})

describe('meta.missing-year', () => {
  it('reports a movie with no production year', () => {
    item({ year: null })
    expect(rule('meta.missing-year').run(ctx())).toHaveLength(1)
  })
  it('does not report episodes, which inherit the series year', () => {
    item({ type: 'Episode', year: null, series_id: 's1', season_no: 1, episode_no: 1 })
    expect(rule('meta.missing-year').run(ctx())).toHaveLength(0)
  })
})

describe('meta.episode-no-season', () => {
  it('reports an episode with a null season number', () => {
    item({ id: 'e1', type: 'Episode', series_id: 's1', season_no: null, episode_no: 3 })
    expect(rule('meta.episode-no-season').run(ctx())).toHaveLength(1)
  })
  it('reports an episode with no series at all', () => {
    item({ id: 'e2', type: 'Episode', series_id: null, season_no: 1, episode_no: 3 })
    expect(rule('meta.episode-no-season').run(ctx())).toHaveLength(1)
  })
})

describe('meta.mixed-content', () => {
  it('reports a library holding both movies and episodes', () => {
    item({ id: 'a', type: 'Movie', library_name: 'Media' })
    item({ id: 'b', type: 'Episode', library_name: 'Media', series_id: 's', season_no: 1, episode_no: 1 })
    expect(rule('meta.mixed-content').run(ctx())).toHaveLength(1)
  })
  it('does not report clean single-type libraries', () => {
    item({ id: 'a', type: 'Movie', library_name: 'Movies' })
    item({ id: 'b', type: 'Episode', library_name: 'TV', series_id: 's', season_no: 1, episode_no: 1 })
    expect(rule('meta.mixed-content').run(ctx())).toHaveLength(0)
  })
})

describe('meta.bad-naming', () => {
  it('reports a movie whose folder omits the year', () => {
    item({ jf_path: '/media/Movies/Heat/Heat.mkv' })
    expect(rule('meta.bad-naming').run(ctx())).toHaveLength(1)
  })
  it('accepts the conventional "Title (Year)" folder', () => {
    item({ jf_path: '/media/Movies/Heat (1995)/Heat (1995).mkv' })
    expect(rule('meta.bad-naming').run(ctx())).toHaveLength(0)
  })
  it('reports an episode file with no SxxEyy token', () => {
    item({ id: 'e', type: 'Episode', series_id: 's', season_no: 1, episode_no: 1, jf_path: '/media/TV/Show/ep1.mkv' })
    expect(rule('meta.bad-naming').run(ctx())).toHaveLength(1)
  })
  it('accepts a conventional episode filename', () => {
    item({ id: 'e', type: 'Episode', series_id: 's', season_no: 1, episode_no: 1, jf_path: '/media/TV/Show/Season 01/Show - S01E01.mkv' })
    expect(rule('meta.bad-naming').run(ctx())).toHaveLength(0)
  })
})
