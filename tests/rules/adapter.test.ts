import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../src/index/db.js'
import { dupeGroupRule, isHdrRange } from '../../src/rules/dupes/adapter.js'
import { DUPE_RULES } from '../../src/rules/dupes/index.js'
import { runRules } from '../../src/rules/runner.js'
import { fileConfigSchema } from '../../src/config/schema.js'
import type { SourceName } from '../../src/rules/types.js'

let db: Db
const config = fileConfigSchema.parse({})
const ALL_SOURCES = new Set<SourceName>(['jellyfin', 'filesystem', 'qbittorrent', 'arr', 'hashes'])
const ctx = (availableSources: Set<SourceName> = ALL_SOURCES) => ({ db, config, scanId: 1, now: 'T', availableSources })

function item(over: Record<string, unknown>) {
  const row = {
    id: 'i1', type: 'Movie', name: 'Heat', year: 1995, provider_ids_json: '{}',
    container_path: null, size_bytes: null, height: null, bitrate: null,
    video_codec: null, audio_channels: null, library_name: 'Movies', has_primary_image: 1,
    video_range: null, has_subtitles: 0,
    ...over,
  }
  db.prepare(`INSERT INTO jellyfin_items (id, scan_id, type, name, year, provider_ids_json,
    container_path, size_bytes, height, bitrate, video_codec, audio_channels, library_name,
    has_primary_image, video_range, has_subtitles)
    VALUES (@id,1,@type,@name,@year,@provider_ids_json,@container_path,@size_bytes,@height,@bitrate,
      @video_codec,@audio_channels,@library_name,@has_primary_image,@video_range,@has_subtitles)`).run(row)
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

  it('reports dupe.identical-file as evaluated once hashes are an available source', () => {
    item({ id: 'a', container_path: '/mnt/m/a.mkv' })
    db.prepare(`INSERT INTO fs_entries (container_path, scan_id, parent_path, name, ext, is_dir,
      size_bytes, mtime, dev, inode, nlink, is_media, library_root, root_role, quick_hash)
      VALUES ('/mnt/m/a.mkv',1,'/mnt/m','a.mkv','.mkv',0,100,0,1,1,1,1,'/mnt/m','library','deadbeef')`).run()

    dupeGroupRule.run(ctx())
    const subRuns = dupeGroupRule.subRuns!(ctx())
    const identical = subRuns.find((s) => s.ruleId === 'dupe.identical-file')
    expect(identical?.status).toBe('evaluated')
  })

  it('names the source that is actually missing, not hashing, when the filesystem phase produced nothing at all', () => {
    item({ id: 'a', container_path: '/mnt/m/a.mkv' })

    runRules({
      db, config, scanId: 6, rules: [dupeGroupRule],
      availableSources: new Set<SourceName>(['jellyfin']),
      sourceReasons: { filesystem: 'the filesystem phase skipped: every root failed to open' },
    })

    const identical = db.prepare(
      "SELECT reason FROM rule_runs WHERE scan_id = 6 AND rule_id = 'dupe.identical-file'",
    ).get() as { reason: string }
    expect(identical.reason).toMatch(/filesystem/)
    expect(identical.reason).toMatch(/every root failed to open/)
  })

  it('reports not-evaluated, never a zero, for a matcher subRuns was asked about without a preceding run()', () => {
    item({ id: 'a', provider_ids_json: '{"tmdb":"1"}', container_path: '/mnt/m/a.mkv' })
    item({ id: 'b', provider_ids_json: '{"tmdb":"1"}', container_path: '/mnt/m/b.mkv' })

    const subRuns = dupeGroupRule.subRuns!(ctx())
    for (const s of subRuns) {
      expect(s.status).toBe('not-evaluated')
      expect(s.found ?? 0).toBe(0)
      expect(s.reason).toMatch(/did not run/)
    }
  })

  it('invokes each matcher exactly once across a run() + subRuns() pair', () => {
    item({ id: 'a', provider_ids_json: '{"tmdb":"1"}', container_path: '/mnt/m/a.mkv' })
    item({ id: 'b', provider_ids_json: '{"tmdb":"1"}', container_path: '/mnt/m/b.mkv' })

    const calls = new Map<string, number>()
    const spies = DUPE_RULES.map((matcher) => {
      const original = matcher.link.bind(matcher)
      const spy = vi.spyOn(matcher, 'link').mockImplementation((c) => {
        calls.set(matcher.id, (calls.get(matcher.id) ?? 0) + 1)
        return original(c)
      })
      return spy
    })
    try {
      const c = ctx()
      const findings = dupeGroupRule.run(c)
      const subRuns = dupeGroupRule.subRuns!(c)

      expect(findings).toHaveLength(1)
      for (const matcher of DUPE_RULES) expect(calls.get(matcher.id) ?? 0).toBe(1)
      // ...and the counts subRuns reports are the ones run() observed, not zeros.
      expect(subRuns.find((s) => s.ruleId === 'dupe.provider-id'))
        .toMatchObject({ status: 'evaluated', found: 1 })
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })

  it('reports a matcher that threw as not-evaluated with what it threw, rather than as zero links', () => {
    item({ id: 'a', provider_ids_json: '{"tmdb":"1"}', container_path: '/mnt/m/a.mkv' })
    item({ id: 'b', provider_ids_json: '{"tmdb":"1"}', container_path: '/mnt/m/b.mkv' })

    const runtime = DUPE_RULES.find((r) => r.id === 'dupe.runtime')!
    const spy = vi.spyOn(runtime, 'link').mockImplementation(() => { throw new Error('boom') })
    try {
      const c = ctx()
      dupeGroupRule.run(c)
      const entry = dupeGroupRule.subRuns!(c).find((s) => s.ruleId === 'dupe.runtime')
      expect(entry?.status).toBe('not-evaluated')
      expect(entry?.reason).toMatch(/boom/)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('isHdrRange', () => {
  it('is false for every spelling of "no HDR evidence"', () => {
    for (const v of [null, '', '   ', 'SDR', 'sdr', ' Sdr ', 'Unknown', 'unknown']) {
      expect(isHdrRange(v)).toBe(false)
    }
  })
  it('is true for every real HDR flavour, whatever the casing', () => {
    for (const v of ['HDR', 'HDR10', 'HDR10+', 'hlg', 'Dolby Vision', 'DOVI']) {
      expect(isHdrRange(v)).toBe(true)
    }
  })
})

describe('keeper signals come from what jellyfin reported', () => {
  const groupScores = () => {
    const findings = dupeGroupRule.run(ctx())
    expect(findings).toHaveLength(1)
    const evidence = findings[0]!.evidence as {
      keeperId: string
      scores: Record<string, { total: number; breakdown: Record<string, number> }>
    }
    return evidence
  }

  it('gives an SDR 4K HEVC copy no HDR bonus (it is not HDR, it is 4K HEVC)', () => {
    item({
      id: 'sdr4k', provider_ids_json: '{"tmdb":"1"}', height: 2160, video_codec: 'hevc',
      video_range: 'SDR', size_bytes: 10,
    })
    item({ id: 'other', provider_ids_json: '{"tmdb":"1"}', height: 1080, video_codec: 'h264', size_bytes: 5 })
    expect(groupScores().scores.sdr4k!.breakdown.hdr).toBe(0)
  })

  it('gives a genuinely HDR 1080p copy the HDR bonus, even though it is neither 4K nor HEVC', () => {
    item({
      id: 'hdr1080', provider_ids_json: '{"tmdb":"1"}', height: 1080, video_codec: 'h264',
      video_range: 'HDR10', size_bytes: 10,
    })
    item({ id: 'other', provider_ids_json: '{"tmdb":"1"}', height: 1080, video_codec: 'h264', size_bytes: 5 })
    expect(groupScores().scores.hdr1080!.breakdown.hdr).toBeGreaterThan(0)
  })

  it('treats a NULL video_range as no evidence rather than inferring HDR from a 4K HEVC codec', () => {
    item({
      id: 'unknown4k', provider_ids_json: '{"tmdb":"1"}', height: 2160, video_codec: 'hevc',
      video_range: null, size_bytes: 10,
    })
    item({ id: 'other', provider_ids_json: '{"tmdb":"1"}', height: 1080, video_codec: 'h264', size_bytes: 5 })
    expect(groupScores().scores.unknown4k!.breakdown.hdr).toBe(0)
  })

  it("treats jellyfin's literal 'Unknown' range as absent, not as not-SDR", () => {
    item({
      id: 'unk', provider_ids_json: '{"tmdb":"1"}', height: 2160, video_codec: 'hevc',
      video_range: 'Unknown', size_bytes: 10,
    })
    item({ id: 'other', provider_ids_json: '{"tmdb":"1"}', height: 1080, video_codec: 'h264', size_bytes: 5 })
    expect(groupScores().scores.unk!.breakdown.hdr).toBe(0)
  })

  it('picks the subtitled copy when two members differ only in subtitles', () => {
    const shared = {
      provider_ids_json: '{"tmdb":"1"}', height: 1080, video_codec: 'h264', bitrate: 5_000_000,
      audio_channels: 6, size_bytes: 1_000, video_range: 'SDR',
    }
    item({ id: 'aaa-no-subs', ...shared, has_subtitles: 0 })
    item({ id: 'bbb-subs', ...shared, has_subtitles: 1 })
    const evidence = groupScores()
    expect(evidence.keeperId).toBe('bbb-subs')
    expect(evidence.scores['bbb-subs']!.breakdown.subtitles).toBeGreaterThan(0)
    expect(evidence.scores['aaa-no-subs']!.breakdown.subtitles).toBe(0)
  })
})
