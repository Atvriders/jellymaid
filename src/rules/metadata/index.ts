import type { Finding } from '../../core/types.js'
import { findingId } from '../../core/types.js'
import type { Rule, RuleContext } from '../types.js'

interface Row {
  id: string; type: string; name: string; year: number | null; provider_ids_json: string
  jf_path: string | null; container_path: string | null; has_primary_image: number
  series_id: string | null; season_no: number | null; episode_no: number | null
  library_name: string | null
}

const ALL = `SELECT id, type, name, year, provider_ids_json, jf_path, container_path,
  has_primary_image, series_id, season_no, episode_no, library_name FROM jellyfin_items`

function itemFinding(
  ctx: RuleContext, ruleId: string, row: Row, severity: Finding['severity'], evidence: Record<string, unknown>,
): Finding {
  return {
    id: findingId(ruleId, row.id),
    ruleId,
    class: 'metadata',
    severity,
    confidence: 'exact',
    subjects: [{ kind: 'item', id: row.id, label: row.name, path: row.container_path ?? undefined }],
    evidence,
    reclaimableBytes: null,
    status: 'open',
    firstSeen: ctx.now,
    lastSeen: ctx.now,
  }
}

const PLAYABLE = new Set(['Movie', 'Episode'])

const unidentified: Rule = {
  id: 'meta.unidentified', class: 'metadata', requires: ['jellyfin'],
  run(ctx) {
    return (ctx.db.prepare(ALL).all() as Row[])
      .filter((r) => PLAYABLE.has(r.type) && Object.keys(JSON.parse(r.provider_ids_json) as object).length === 0)
      .map((r) => itemFinding(ctx, 'meta.unidentified', r, 'warning', { path: r.jf_path }))
  },
}

const missingArtwork: Rule = {
  id: 'meta.missing-artwork', class: 'metadata', requires: ['jellyfin'],
  run(ctx) {
    return (ctx.db.prepare(ALL).all() as Row[])
      .filter((r) => r.has_primary_image === 0)
      .map((r) => itemFinding(ctx, 'meta.missing-artwork', r, 'info', { type: r.type }))
  },
}

const missingYear: Rule = {
  id: 'meta.missing-year', class: 'metadata', requires: ['jellyfin'],
  run(ctx) {
    return (ctx.db.prepare(ALL).all() as Row[])
      .filter((r) => (r.type === 'Movie' || r.type === 'Series') && r.year === null)
      .map((r) => itemFinding(ctx, 'meta.missing-year', r, 'info', { type: r.type }))
  },
}

const episodeNoSeason: Rule = {
  id: 'meta.episode-no-season', class: 'metadata', requires: ['jellyfin'],
  run(ctx) {
    return (ctx.db.prepare(ALL).all() as Row[])
      .filter((r) => r.type === 'Episode' && (r.season_no === null || r.series_id === null))
      .map((r) => itemFinding(ctx, 'meta.episode-no-season', r, 'warning', {
        seriesId: r.series_id, seasonNo: r.season_no, episodeNo: r.episode_no,
      }))
  },
}

const mixedContent: Rule = {
  id: 'meta.mixed-content', class: 'metadata', requires: ['jellyfin'],
  run(ctx) {
    const rows = ctx.db.prepare(
      `SELECT library_name, type, COUNT(*) c FROM jellyfin_items
       WHERE library_name IS NOT NULL AND type IN ('Movie','Episode') GROUP BY library_name, type`,
    ).all() as Array<{ library_name: string; type: string; c: number }>
    const byLibrary = new Map<string, Record<string, number>>()
    for (const r of rows) {
      const entry = byLibrary.get(r.library_name) ?? {}
      entry[r.type] = r.c
      byLibrary.set(r.library_name, entry)
    }
    const out: Finding[] = []
    for (const [library, counts] of byLibrary) {
      if (Object.keys(counts).length < 2) continue
      out.push({
        id: findingId('meta.mixed-content', library),
        ruleId: 'meta.mixed-content',
        class: 'metadata',
        severity: 'warning',
        confidence: 'exact',
        subjects: [{ kind: 'path', path: library, label: library }],
        evidence: { library, counts },
        reclaimableBytes: null,
        status: 'open',
        firstSeen: ctx.now,
        lastSeen: ctx.now,
      })
    }
    return out
  },
}

const badNaming: Rule = {
  id: 'meta.bad-naming', class: 'metadata', requires: ['jellyfin'],
  run(ctx) {
    const cfg = ctx.config.rules['meta.bad-naming']
    if (!cfg.enabled) return []
    // Compiled per pass from config, not module-level constants: the expected naming scheme is a
    // house style, not a fact about media (see the schema entry). A pattern that does not compile
    // throws here and the runner records the rule not-evaluated with the RegExp error — visible,
    // rather than a silently disabled check or a scan-wide crash.
    const MOVIE_FOLDER = new RegExp(cfg.moviePattern)
    const EPISODE_TOKEN = new RegExp(cfg.episodePattern, 'i')
    const out: Finding[] = []
    for (const r of ctx.db.prepare(ALL).all() as Row[]) {
      if (!r.jf_path) continue
      if (r.type === 'Movie' && !MOVIE_FOLDER.test(r.jf_path)) {
        out.push(itemFinding(ctx, 'meta.bad-naming', r, 'info', {
          path: r.jf_path, expected: 'Movie Title (Year)/Movie Title (Year).ext',
        }))
      } else if (r.type === 'Episode' && !EPISODE_TOKEN.test(r.jf_path)) {
        out.push(itemFinding(ctx, 'meta.bad-naming', r, 'info', {
          path: r.jf_path, expected: 'Series/Season 01/Series - S01E01.ext',
        }))
      }
    }
    return out
  },
}

export const METADATA_RULES: Rule[] = [
  unidentified, missingArtwork, missingYear, episodeNoSeason, mixedContent, badNaming,
]
