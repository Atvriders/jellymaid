import type { DupeLink, DupeRule, RuleContext } from '../types.js'
import { normalizeTitle, trigramSimilarity } from '../normalize.js'

interface ItemRow {
  id: string
  type: string
  name: string
  year: number | null
  provider_ids_json: string
  container_path: string | null
  size_bytes: number | null
  runtime_ticks: number | null
  series_id: string | null
  season_no: number | null
  episode_no: number | null
}

const loadItems = (ctx: RuleContext): ItemRow[] =>
  ctx.db.prepare(`SELECT id, type, name, year, provider_ids_json, container_path, size_bytes,
    runtime_ticks, series_id, season_no, episode_no
    FROM jellyfin_items WHERE type IN ('Movie','Episode')`).all() as ItemRow[]

/** Emits every pair inside each bucket of two or more. */
function pairsWithin<T>(buckets: Map<string, T[]>, make: (a: T, b: T, key: string) => DupeLink): DupeLink[] {
  const out: DupeLink[] = []
  for (const [key, group] of buckets) {
    if (group.length < 2) continue
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) out.push(make(group[i]!, group[j]!, key))
    }
  }
  return out
}

function bucket<T>(rows: T[], keyOf: (row: T) => string | null): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const row of rows) {
    const key = keyOf(row)
    if (key === null) continue
    const list = map.get(key)
    if (list) list.push(row); else map.set(key, [row])
  }
  return map
}

const providerIdRule: DupeRule = {
  id: 'dupe.provider-id',
  requires: ['jellyfin'],
  link(ctx) {
    const rows = loadItems(ctx)
    const buckets = new Map<string, ItemRow[]>()
    for (const row of rows) {
      const ids = JSON.parse(row.provider_ids_json) as Record<string, string>
      for (const [ns, value] of Object.entries(ids)) {
        if (!value) continue
        const key = `${ns}:${value}`
        const list = buckets.get(key)
        if (list) list.push(row); else buckets.set(key, [row])
      }
    }
    // A pair sharing two provider namespaces (e.g. both tmdb and imdb agree) lands in two
    // buckets and is intentionally emitted twice, once per namespace: each occurrence is
    // corroborating evidence, not noise, and collapsing them would silently drop whichever
    // namespace's evidence was deduplicated away.
    return pairsWithin(buckets, (a, b, key) => ({
      ruleId: 'dupe.provider-id', a: a.id, b: b.id, confidence: 'exact', evidence: { providerId: key },
    }))
  },
}

const seriesEpisodeRule: DupeRule = {
  id: 'dupe.series-episode',
  requires: ['jellyfin'],
  link(ctx) {
    const rows = loadItems(ctx).filter(
      (r) => r.type === 'Episode' && r.series_id && r.season_no !== null && r.episode_no !== null,
    )
    return pairsWithin(
      bucket(rows, (r) => `${r.series_id}|${r.season_no}|${r.episode_no}`),
      (a, b, key) => ({ ruleId: 'dupe.series-episode', a: a.id, b: b.id, confidence: 'exact', evidence: { episodeKey: key } }),
    )
  },
}

const titleYearRule: DupeRule = {
  id: 'dupe.title-year',
  requires: ['jellyfin'],
  link(ctx) {
    const rows = loadItems(ctx).filter((r) => r.type === 'Movie' && r.year !== null)
    return pairsWithin(
      bucket(rows, (r) => {
        const t = normalizeTitle(r.name)
        return t ? `${t}|${r.year}` : null
      }),
      (a, b, key) => ({ ruleId: 'dupe.title-year', a: a.id, b: b.id, confidence: 'strong', evidence: { titleYear: key } }),
    )
  },
}

const TICKS_PER_SECOND = 10_000_000

const runtimeRule: DupeRule = {
  id: 'dupe.runtime',
  requires: ['jellyfin'],
  link(ctx) {
    const cfg = ctx.config.rules['dupe.runtime']
    if (!cfg.enabled) return []
    const tolerance = cfg.toleranceSeconds * TICKS_PER_SECOND
    // Movies only, matching dupe.title-year and dupe.fuzzy-title. Unrelated shows reuse generic
    // episode titles ("Pilot", "Reunion", "Part 1") that normalize identically, and broadcast
    // content is authored to standard slot lengths — so two episodes of different series can
    // easily share a normalized title and a runtime within tolerance, especially once an
    // operator raises toleranceSeconds to catch re-encodes. Episode duplicates are already
    // covered exactly by dupe.series-episode (same series/season/episode) and by
    // dupe.identical-file, so nothing is lost by excluding them here. Do not add Episode back.
    const rows = loadItems(ctx).filter((r) => r.type === 'Movie' && r.runtime_ticks !== null)
    const out: DupeLink[] = []
    for (const [, group] of bucket(rows, (r) => normalizeTitle(r.name) || null)) {
      for (let i = 0; i < group.length; i += 1) {
        for (let j = i + 1; j < group.length; j += 1) {
          const a = group[i]!; const b = group[j]!
          const delta = Math.abs(a.runtime_ticks! - b.runtime_ticks!)
          if (delta <= tolerance) {
            out.push({
              ruleId: 'dupe.runtime', a: a.id, b: b.id, confidence: 'strong',
              evidence: { runtimeDeltaSeconds: delta / TICKS_PER_SECOND },
            })
          }
        }
      }
    }
    return out
  },
}

const identicalFileRule: DupeRule = {
  id: 'dupe.identical-file',
  requires: ['jellyfin', 'filesystem', 'hashes'],
  link(ctx) {
    const rows = ctx.db.prepare(`SELECT i.id AS id, f.quick_hash AS hash, f.size_bytes AS size
      FROM jellyfin_items i
      JOIN fs_entries f ON f.container_path = i.container_path
      WHERE f.quick_hash IS NOT NULL`).all() as Array<{ id: string; hash: string; size: number }>
    return pairsWithin(
      bucket(rows, (r) => `${r.size}|${r.hash}`),
      (a, b, key) => ({ ruleId: 'dupe.identical-file', a: a.id, b: b.id, confidence: 'exact', evidence: { sizeAndHash: key } }),
    )
  },
}

const fuzzyTitleRule: DupeRule = {
  id: 'dupe.fuzzy-title',
  requires: ['jellyfin'],
  link(ctx) {
    const cfg = ctx.config.rules['dupe.fuzzy-title']
    if (!cfg.enabled) return []
    const rows = loadItems(ctx)
      .filter((r) => r.type === 'Movie')
      .map((r) => ({ id: r.id, key: normalizeTitle(r.name) }))
      .filter((r) => r.key.length >= cfg.minTitleLength)
    // Bucket by first letter to keep this O(n²) pass tractable on a 100k library.
    const byLetter = bucket(rows, (r) => r.key[0] ?? null)
    const out: DupeLink[] = []
    for (const group of byLetter.values()) {
      for (let i = 0; i < group.length; i += 1) {
        for (let j = i + 1; j < group.length; j += 1) {
          const a = group[i]!; const b = group[j]!
          if (a.key === b.key) continue   // exact matches belong to title-year, not fuzzy
          const score = trigramSimilarity(a.key, b.key)
          if (score >= cfg.similarity) {
            out.push({
              ruleId: 'dupe.fuzzy-title', a: a.id, b: b.id, confidence: 'possible',
              evidence: { similarity: Number(score.toFixed(3)), a: a.key, b: b.key },
            })
          }
        }
      }
    }
    return out
  },
}

export const DUPE_RULES: DupeRule[] = [
  providerIdRule, seriesEpisodeRule, identicalFileRule, titleYearRule, runtimeRule, fuzzyTitleRule,
]
