// tests/rules/quality.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../src/index/db.js'
import { QUALITY_RULES } from '../../src/rules/quality/index.js'
import { fileConfigSchema } from '../../src/config/schema.js'
import type { Subject } from '../../src/core/types.js'

let db: Db
const ctx = (config = fileConfigSchema.parse({})) => ({ db, config, scanId: 1, now: 'T' })
const rule = (id: string) => QUALITY_RULES.find((r) => r.id === id)!
// `Subject` is a discriminated union ('item' | 'path'); only the 'item' arm carries `id`. Narrow
// explicitly rather than casting, so a rule that ever emitted a bare path subject here would fail
// this test loudly instead of silently reading `undefined`.
const itemId = (s: Subject): string => { if (s.kind !== 'item') throw new Error('expected an item subject'); return s.id }

function item(over: Record<string, unknown> = {}) {
  const row = {
    id: 'i1', type: 'Movie', name: 'Heat', height: 1080, bitrate: 8_000_000, container: 'mkv',
    video_codec: 'h264', audio_codec: 'aac', runtime_ticks: 60_000_000_000, size_bytes: 5_000_000_000,
    container_path: '/mnt/m/Heat.mkv', ...over,
  }
  db.prepare(`INSERT INTO jellyfin_items (id, scan_id, type, name, height, bitrate, container,
    video_codec, audio_codec, runtime_ticks, size_bytes, container_path, has_primary_image)
    VALUES (@id,1,@type,@name,@height,@bitrate,@container,@video_codec,@audio_codec,
            @runtime_ticks,@size_bytes,@container_path,1)`).run(row)
}

function fsEntry(over: Record<string, unknown> = {}) {
  const row = {
    container_path: '/mnt/m/Heat.mkv', parent_path: '/mnt/m', name: 'Heat.mkv', ext: '.mkv', is_dir: 0,
    ...over,
  }
  db.prepare(`INSERT INTO fs_entries (container_path, scan_id, parent_path, name, ext, is_dir, size_bytes, mtime)
    VALUES (@container_path,1,@parent_path,@name,@ext,@is_dir,0,0)`).run(row)
}

beforeEach(() => { db = openDb(join(mkdtempSync(join(tmpdir(), 'jm-qual-')), 'db.sqlite')) })

describe('quality.low-bitrate', () => {
  it('reports a 1080p file below the configured floor', () => {
    item({ height: 1080, bitrate: 1_000_000 })
    const f = rule('quality.low-bitrate').run(ctx())
    expect(f).toHaveLength(1)
    expect(f[0]!.severity).toBe('info')
  })
  it('accepts a file above the floor', () => {
    item({ height: 1080, bitrate: 9_000_000 })
    expect(rule('quality.low-bitrate').run(ctx())).toHaveLength(0)
  })
  it('uses the nearest configured height bucket', () => {
    item({ height: 2160, bitrate: 6_000_000 })
    expect(rule('quality.low-bitrate').run(ctx())).toHaveLength(1)
  })
  it('skips items with no bitrate rather than treating null as zero', () => {
    item({ bitrate: null })
    expect(rule('quality.low-bitrate').run(ctx())).toHaveLength(0)
  })
})

describe('quality.tiny-file', () => {
  it('reports a file far smaller than its same-resolution peers', () => {
    item({ id: 'a', size_bytes: 20_000_000_000 })
    item({ id: 'b', size_bytes: 18_000_000_000 })
    item({ id: 'c', size_bytes: 300_000_000 })
    const f = rule('quality.tiny-file').run(ctx())
    expect(f.map((x) => itemId(x.subjects[0]!))).toEqual(['c'])
  })
  it('reports nothing when there are too few peers to compare', () => {
    item({ id: 'a', size_bytes: 100 })
    expect(rule('quality.tiny-file').run(ctx())).toHaveLength(0)
  })
})

describe('quality.transcode-risk', () => {
  it('reports a codec outside the allowed list', () => {
    item({ video_codec: 'mpeg2video' })
    expect(rule('quality.transcode-risk').run(ctx())).toHaveLength(1)
  })
  it('reports a container outside the allowed list', () => {
    item({ container: 'avi' })
    expect(rule('quality.transcode-risk').run(ctx())).toHaveLength(1)
  })
  it('accepts an allowed codec and container', () => {
    item({ video_codec: 'hevc', container: 'mkv' })
    expect(rule('quality.transcode-risk').run(ctx())).toHaveLength(0)
  })
})

describe('quality.missing-subs', () => {
  it('reports a video file with no subtitle sidecar next to it', () => {
    item({ container_path: '/mnt/m/Heat.mkv' })
    fsEntry({ container_path: '/mnt/m/Heat.mkv' })
    expect(rule('quality.missing-subs').run(ctx())).toHaveLength(1)
  })
  it('does not report a video file with a sidecar in the same folder', () => {
    item({ container_path: '/mnt/m/Heat.mkv' })
    fsEntry({ container_path: '/mnt/m/Heat.mkv' })
    fsEntry({ container_path: '/mnt/m/Heat.srt', name: 'Heat.srt', ext: '.srt' })
    expect(rule('quality.missing-subs').run(ctx())).toHaveLength(0)
  })
  it('skips an item whose own file is not in the filesystem index, rather than treating an unknown folder as empty', () => {
    // No fsEntry() at all for this container_path: we cannot even locate the item's own
    // directory, so we cannot judge whether a sidecar is missing from it.
    item({ container_path: '/mnt/m/Ghost.mkv' })
    expect(rule('quality.missing-subs').run(ctx())).toHaveLength(0)
  })
})

describe('quality.biggest', () => {
  it('reports the top N largest items as one informational finding', () => {
    for (let i = 0; i < 5; i += 1) item({ id: `i${i}`, size_bytes: i * 1_000_000_000 })
    const f = rule('quality.biggest').run(ctx(fileConfigSchema.parse({ rules: { 'quality.biggest': { topN: 3 } } })))
    expect(f).toHaveLength(1)
    expect((f[0]!.evidence.items as unknown[]).length).toBe(3)
  })
  it('has a stable id so it never accumulates duplicates across scans', () => {
    item()
    const a = rule('quality.biggest').run(ctx())[0]!
    const b = rule('quality.biggest').run(ctx())[0]!
    expect(a.id).toBe(b.id)
  })
})
