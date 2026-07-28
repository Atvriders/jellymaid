import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../src/index/db.js'
import { dupeGroupRule } from '../../src/rules/dupes/adapter.js'
import { runRules } from '../../src/rules/runner.js'
import { fileConfigSchema } from '../../src/config/schema.js'

let db: Db
const config = fileConfigSchema.parse({})
const ctx = () => ({ db, config, scanId: 1, now: 'T' })

function item(over: Record<string, unknown>) {
  const row = {
    id: 'i1', type: 'Movie', name: 'Heat', year: 1995, provider_ids_json: '{}',
    container_path: null, size_bytes: null, height: null, bitrate: null,
    video_codec: null, audio_channels: null, library_name: 'Movies', has_primary_image: 1,
    ...over,
  }
  db.prepare(`INSERT INTO jellyfin_items (id, scan_id, type, name, year, provider_ids_json,
    container_path, size_bytes, height, bitrate, video_codec, audio_channels, library_name, has_primary_image)
    VALUES (@id,1,@type,@name,@year,@provider_ids_json,@container_path,@size_bytes,@height,@bitrate,
      @video_codec,@audio_channels,@library_name,@has_primary_image)`).run(row)
}

beforeEach(() => { db = openDb(join(mkdtempSync(join(tmpdir(), 'jm-adapter-')), 'db.sqlite')) })

describe('dupeGroupRule.run() + persist()', () => {
  it('writes a dupe_groups row with the right tier, members, keeper and scores, and reclaimableBytes equals the non-keeper size', () => {
    item({
      id: 'bad', provider_ids_json: '{"tmdb":"949"}', container_path: '/mnt/m/bad.mkv',
      size_bytes: 500_000_000, height: 1080, bitrate: 3_000_000, video_codec: 'h264', audio_channels: 2,
    })
    item({
      id: 'good', provider_ids_json: '{"tmdb":"949"}', container_path: '/mnt/m/good.mkv',
      size_bytes: 20_000_000_000, height: 2160, bitrate: 30_000_000, video_codec: 'hevc', audio_channels: 8,
    })

    const findings = dupeGroupRule.run(ctx())
    expect(findings).toHaveLength(1)
    const finding = findings[0]!
    expect(finding.confidence).toBe('exact')
    expect(finding.reclaimableBytes).toBe(500_000_000)

    dupeGroupRule.persist!(ctx(), findings)

    const row = db.prepare('SELECT * FROM dupe_groups').get() as {
      id: string; tier: string; members_json: string; keeper_item_id: string; scores_json: string; status: string
    }
    expect(row.tier).toBe('exact')
    expect((JSON.parse(row.members_json) as string[]).sort()).toEqual(['bad', 'good'])
    expect(row.keeper_item_id).toBe('good')
    expect(row.status).toBe('open')

    const scores = JSON.parse(row.scores_json) as Record<string, { total: number }>
    expect(scores.good!.total).toBeGreaterThan(scores.bad!.total)
  })

  it('writes nothing to dupe_groups when there are no groups', () => {
    item({ id: 'solo', container_path: '/mnt/m/solo.mkv' })
    const findings = dupeGroupRule.run(ctx())
    expect(findings).toHaveLength(0)
    dupeGroupRule.persist!(ctx(), findings)
    expect(db.prepare('SELECT COUNT(*) c FROM dupe_groups').get()).toEqual({ c: 0 })
  })
})

describe('dupeGroupRule.subRuns', () => {
  it('records dupe.identical-file as not-evaluated (reason mentioning hashes) in rule_runs when no hashes exist, while the other matchers are evaluated', () => {
    item({ id: 'a', provider_ids_json: '{"tmdb":"1"}', container_path: '/mnt/m/a.mkv' })
    item({ id: 'b', provider_ids_json: '{"tmdb":"1"}', container_path: '/mnt/m/b.mkv' })

    runRules({ db, config, scanId: 5, availableSources: new Set(['jellyfin']), rules: [dupeGroupRule] })

    const runs = db.prepare('SELECT rule_id, status, reason FROM rule_runs WHERE scan_id = 5').all() as
      Array<{ rule_id: string; status: string; reason: string | null }>
    const byId = new Map(runs.map((r) => [r.rule_id, r]))

    expect(byId.get('dupe.group')?.status).toBe('evaluated')

    const identical = byId.get('dupe.identical-file')
    expect(identical?.status).toBe('not-evaluated')
    expect(identical?.reason).toMatch(/hash/i)

    for (const id of ['dupe.provider-id', 'dupe.series-episode', 'dupe.title-year', 'dupe.runtime', 'dupe.fuzzy-title']) {
      expect(byId.get(id)?.status).toBe('evaluated')
    }
  })

  it('reports dupe.identical-file as evaluated once a hash exists', () => {
    item({ id: 'a', container_path: '/mnt/m/a.mkv' })
    db.prepare(`INSERT INTO fs_entries (container_path, scan_id, parent_path, name, ext, is_dir,
      size_bytes, mtime, dev, inode, nlink, is_media, library_root, root_role, quick_hash)
      VALUES ('/mnt/m/a.mkv',1,'/mnt/m','a.mkv','.mkv',0,100,0,1,1,1,1,'/mnt/m','library','deadbeef')`).run()

    const subRuns = dupeGroupRule.subRuns!(ctx())
    const identical = subRuns.find((s) => s.ruleId === 'dupe.identical-file')
    expect(identical?.status).toBe('evaluated')
  })
})
