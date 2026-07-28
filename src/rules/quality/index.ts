import type { Finding } from '../../core/types.js'
import { findingId } from '../../core/types.js'
import type { Rule, RuleContext } from '../types.js'

interface Row {
  id: string; type: string; name: string; height: number | null; bitrate: number | null
  container: string | null; video_codec: string | null; audio_codec: string | null
  runtime_ticks: number | null; size_bytes: number | null; container_path: string | null
}

const ALL = `SELECT id, type, name, height, bitrate, container, video_codec, audio_codec,
  runtime_ticks, size_bytes, container_path FROM jellyfin_items WHERE type IN ('Movie','Episode')`

function itemFinding(ctx: RuleContext, ruleId: string, row: Row, evidence: Record<string, unknown>, severity: Finding['severity'] = 'info'): Finding {
  return {
    id: findingId(ruleId, row.id),
    ruleId,
    class: 'quality',
    severity,
    confidence: 'strong',
    subjects: [{ kind: 'item', id: row.id, label: row.name, path: row.container_path ?? undefined }],
    evidence,
    reclaimableBytes: null,
    status: 'open',
    firstSeen: ctx.now,
    lastSeen: ctx.now,
  }
}

/** Picks the configured floor whose height bucket is closest at or below the item's height. */
function floorFor(height: number, floors: Record<string, number>): number | null {
  const buckets = Object.keys(floors).map(Number).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b)
  let chosen: number | null = null
  for (const b of buckets) if (height >= b) chosen = b
  return chosen === null ? null : floors[String(chosen)] ?? null
}

const lowBitrate: Rule = {
  id: 'quality.low-bitrate', class: 'quality', requires: ['jellyfin'],
  run(ctx) {
    const cfg = ctx.config.rules['quality.low-bitrate']
    if (!cfg.enabled) return []
    return (ctx.db.prepare(ALL).all() as Row[])
      .filter((r) => {
        if (r.bitrate === null || r.height === null) return false
        const floorKbps = floorFor(r.height, cfg.floorsKbpsByHeight)
        return floorKbps !== null && r.bitrate / 1000 < floorKbps
      })
      .map((r) => itemFinding(ctx, 'quality.low-bitrate', r, {
        bitrateKbps: Math.round((r.bitrate ?? 0) / 1000),
        floorKbps: floorFor(r.height!, cfg.floorsKbpsByHeight),
        height: r.height,
      }))
  },
}

const tinyFile: Rule = {
  id: 'quality.tiny-file', class: 'quality', requires: ['jellyfin'],
  run(ctx) {
    const cfg = ctx.config.rules['quality.tiny-file']
    if (!cfg.enabled) return []
    const rows = (ctx.db.prepare(ALL).all() as Row[]).filter((r) => r.size_bytes && r.height)
    const byHeight = new Map<number, Row[]>()
    for (const r of rows) {
      const list = byHeight.get(r.height!)
      if (list) list.push(r); else byHeight.set(r.height!, [r])
    }
    const out: Finding[] = []
    for (const peers of byHeight.values()) {
      if (peers.length < cfg.minPeers) continue
      const sizes = peers.map((p) => p.size_bytes!).sort((a, b) => a - b)
      const median = sizes[Math.floor(sizes.length / 2)]!
      for (const r of peers) {
        if (r.size_bytes! < median * cfg.peerRatio) {
          out.push(itemFinding(ctx, 'quality.tiny-file', r, {
            sizeBytes: r.size_bytes, peerMedianBytes: median, ratio: Number((r.size_bytes! / median).toFixed(3)),
          }, 'warning'))
        }
      }
    }
    return out
  },
}

const transcodeRisk: Rule = {
  id: 'quality.transcode-risk', class: 'quality', requires: ['jellyfin'],
  run(ctx) {
    const cfg = ctx.config.rules['quality.transcode-risk']
    if (!cfg.enabled) return []
    const codecs = new Set(cfg.allowedVideoCodecs.map((c) => c.toLowerCase()))
    const containers = new Set(cfg.allowedContainers.map((c) => c.toLowerCase()))
    return (ctx.db.prepare(ALL).all() as Row[])
      .filter((r) => {
        const codecBad = r.video_codec !== null && !codecs.has(r.video_codec.toLowerCase())
        const containerBad = r.container !== null && !containers.has(r.container.toLowerCase())
        return codecBad || containerBad
      })
      .map((r) => itemFinding(ctx, 'quality.transcode-risk', r, {
        videoCodec: r.video_codec, container: r.container,
        allowedVideoCodecs: cfg.allowedVideoCodecs, allowedContainers: cfg.allowedContainers,
      }))
  },
}

/**
 * "No external subtitle sidecar next to this file." Looked up entirely through indexed equality —
 * `fs_entries.container_path` is the table's PRIMARY KEY and `parent_path` has its own index
 * (`idx_fs_entries_parent`) — never by a `LIKE '<dir>/%'` prefix scan, which is the shape that made
 * the filesystem rules' original empty-folder check a full table scan per row (see
 * `src/rules/filesystem/index.ts`). A draft of this rule nested the "find my own directory" lookup
 * as a scalar subquery inside the correlated `NOT EXISTS`, i.e.
 * `f.parent_path = (SELECT parent_path FROM fs_entries WHERE container_path = i.container_path)`.
 * `EXPLAIN QUERY PLAN` showed that shape still resolves through both indexes (`SEARCH`, never
 * `SCAN fs_entries`) and a 100k-row benchmark ran it in ~330ms — so it is NOT the pathological
 * per-row-full-scan case fs.empty-folder had. It does, however, mishandle the case where the item's
 * own file has no `fs_entries` row at all (e.g. stale `jellyfin_items` data pointing at a file the
 * filesystem phase never saw this scan): the scalar subquery returns NULL, `f.parent_path = NULL`
 * never matches anything, `NOT EXISTS` becomes vacuously true, and the item is flagged as missing
 * subtitles when really its own directory is simply unknown — a "we cannot judge this" case being
 * treated as a positive finding, which violates this project's null-is-not-a-zero rule. The `JOIN
 * fs_entries mine` below requires a real match on the item's own path first (SQL NULL never joins
 * NULL), which naturally excludes exactly those unknown-directory items instead of flagging them,
 * while keeping the identical index-only query plan.
 */
const missingSubs: Rule = {
  id: 'quality.missing-subs', class: 'quality', requires: ['jellyfin', 'filesystem'],
  run(ctx) {
    const cfg = ctx.config.rules['quality.missing-subs']
    if (!cfg.enabled) return []
    // Bound placeholders, not an interpolated list: these come from operator-supplied config.
    // An empty list would make `lower(f.ext) IN ()` a syntax error, and semantically there is no
    // extension that could satisfy the check, so every item would be flagged — configure the rule
    // off instead of configuring it to match nothing.
    const extensions = cfg.extensions.map((e) => e.toLowerCase())
    if (!extensions.length) return []
    const placeholders = extensions.map(() => '?').join(',')
    const rows = ctx.db.prepare(`SELECT i.id AS id, i.type AS type, i.name AS name,
      i.container_path AS container_path, i.height AS height, i.bitrate AS bitrate,
      i.container AS container, i.video_codec AS video_codec, i.audio_codec AS audio_codec,
      i.runtime_ticks AS runtime_ticks, i.size_bytes AS size_bytes
      FROM jellyfin_items i
      JOIN fs_entries mine ON mine.container_path = i.container_path
      WHERE i.type IN ('Movie','Episode') AND i.container_path IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM fs_entries f
          WHERE f.parent_path = mine.parent_path
            AND lower(f.ext) IN (${placeholders})
        )`).all(...extensions) as Row[]
    return rows.map((r) => itemFinding(ctx, 'quality.missing-subs', r, {
      hasExternalSubtitles: false, extensions,
    }))
  },
}

const biggest: Rule = {
  id: 'quality.biggest', class: 'quality', requires: ['jellyfin'],
  run(ctx) {
    const cfg = ctx.config.rules['quality.biggest']
    if (!cfg.enabled) return []
    const rows = ctx.db.prepare(
      `SELECT id, name, container_path, size_bytes FROM jellyfin_items
       WHERE size_bytes IS NOT NULL ORDER BY size_bytes DESC LIMIT ?`,
    ).all(cfg.topN) as Array<{ id: string; name: string; container_path: string | null; size_bytes: number }>
    if (!rows.length) return []
    return [{
      id: findingId('quality.biggest', 'report'),
      ruleId: 'quality.biggest',
      class: 'quality' as const,
      severity: 'info' as const,
      confidence: 'exact' as const,
      subjects: rows.map((r) => ({ kind: 'item' as const, id: r.id, label: r.name, path: r.container_path ?? undefined })),
      evidence: { items: rows.map((r) => ({ id: r.id, name: r.name, sizeBytes: r.size_bytes })) },
      reclaimableBytes: null,
      status: 'open' as const,
      firstSeen: ctx.now,
      lastSeen: ctx.now,
    }]
  },
}

export const QUALITY_RULES: Rule[] = [lowBitrate, tinyFile, transcodeRisk, missingSubs, biggest]
