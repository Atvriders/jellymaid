import type { DupeLink, DupeRule, RuleContext } from '../types.js'
import { isMultiEpisodeFile, normalizeTitle, trigramSimilarity } from '../normalize.js'

interface ItemRow {
  id: string
  type: string
  name: string
  year: number | null
  provider_ids_json: string
  jf_path: string | null
  container_path: string | null
  size_bytes: number | null
  runtime_ticks: number | null
  series_id: string | null
  season_no: number | null
  episode_no: number | null
}

const loadItems = (ctx: RuleContext): ItemRow[] =>
  ctx.db.prepare(`SELECT id, type, name, year, provider_ids_json, jf_path, container_path, size_bytes,
    runtime_ticks, series_id, season_no, episode_no
    FROM jellyfin_items WHERE type IN ('Movie','Episode')`).all() as ItemRow[]

/**
 * An episode pair with a multi-episode file on either side links `strong`, never `exact`. Jellyfin
 * numbers `S01E01E02` by its first episode and gives it the first episode's provider ids, so it lands
 * on S01E01's key — but it is not a copy of S01E01: it also holds S01E02. Exact claims "these are
 * the same thing"; here they are not, whatever the keys agree on.
 */
function episodePair(a: ItemRow, b: ItemRow): { confidence: 'exact' | 'strong'; multiEpisode: boolean } {
  const multi = (r: ItemRow) => [r.container_path, r.jf_path].some((p) => p !== null && isMultiEpisodeFile(p))
  const multiEpisode = multi(a) || multi(b)
  return { confidence: multiEpisode ? 'strong' : 'exact', multiEpisode }
}

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

/** Files a row under every key `keysOf` returns (deduplicated), so a row lands in a bucket at most once. */
function bucketMany<T>(rows: T[], keysOf: (row: T) => string[]): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const row of rows) {
    for (const key of new Set(keysOf(row))) {
      const list = map.get(key)
      if (list) list.push(row); else map.set(key, [row])
    }
  }
  return map
}

function bucket<T>(rows: T[], keyOf: (row: T) => string | null): Map<string, T[]> {
  return bucketMany(rows, (row) => {
    const key = keyOf(row)
    return key === null ? [] : [key]
  })
}

/**
 * The only provider namespaces that name ONE work. Everything else Jellyfin stores beside them is
 * either a grouping or a foreign catalogue nobody here can vouch for: `tmdbcollection` is shared by
 * every film of a franchise (read as an identity, it made every Alien film an "exact" duplicate of
 * every other), and any key containing "collection" is the same kind of box set. An allow-list, not
 * a deny-list, so a namespace a future plugin invents can never become an identity by accident.
 */
const IDENTITY_NAMESPACES = new Set(['tmdb', 'imdb', 'tvdb'])

/**
 * A row's identity ids, namespace -> value. Keys are lowercased here as well as in the connector: a
 * row written before the connector lowercased them would otherwise spell `Tmdb` and miss its twin.
 */
function identityIds(providerIdsJson: string): Map<string, string> {
  const ids = JSON.parse(providerIdsJson) as Record<string, unknown>
  const out = new Map<string, string>()
  for (const [rawNs, value] of Object.entries(ids)) {
    const ns = rawNs.toLowerCase()
    if (!IDENTITY_NAMESPACES.has(ns) || typeof value !== 'string' || !value) continue
    out.set(ns, value)
  }
  return out
}

/** Which of a show's identity ids names it, in order of preference. */
const SERIES_KEY_ORDER = ['tvdb', 'tmdb', 'imdb'] as const

/**
 * Series id -> the show's identity key (`tvdb:71471`): its tvdb id, else tmdb, else imdb. A Series
 * row with none of them is left out, and its episodes fall back to the bare `series_id`.
 */
function loadSeriesKeys(ctx: RuleContext): Map<string, string> {
  const rows = ctx.db.prepare("SELECT id, provider_ids_json FROM jellyfin_items WHERE type = 'Series'")
    .all() as Array<{ id: string; provider_ids_json: string }>
  const out = new Map<string, string>()
  for (const row of rows) {
    const ids = identityIds(row.provider_ids_json)
    const ns = SERIES_KEY_ORDER.find((n) => ids.has(n))
    if (ns) out.set(row.id, `${ns}:${ids.get(ns)!}`)
  }
  return out
}

const providerIdRule: DupeRule = {
  id: 'dupe.provider-id',
  requires: ['jellyfin'],
  link(ctx) {
    const out: DupeLink[] = []
    const keysOf = (r: ItemRow) => [...identityIds(r.provider_ids_json)].map(([ns, value]) => `${ns}:${value}`)
    // Only items of the same type: a TV film can be a Movie in one library and an Episode in
    // another under one imdb id, and a movie file is not a copy of an episode file.
    for (const sameType of bucket(loadItems(ctx), (r) => r.type).values()) {
      // A pair sharing two provider namespaces (e.g. both tmdb and imdb agree) lands in two
      // buckets and is intentionally emitted twice, once per namespace: each occurrence is
      // corroborating evidence, not noise, and collapsing them would silently drop whichever
      // namespace's evidence was deduplicated away.
      out.push(...pairsWithin(bucketMany(sameType, keysOf), (a, b, key): DupeLink => {
        if (a.type !== 'Episode') {
          return { ruleId: 'dupe.provider-id', a: a.id, b: b.id, confidence: 'exact', evidence: { providerId: key } }
        }
        const { confidence, multiEpisode } = episodePair(a, b)
        return { ruleId: 'dupe.provider-id', a: a.id, b: b.id, confidence, evidence: { providerId: key, multiEpisode } }
      }))
    }
    return out
  },
}

/**
 * Same show, same season, same episode number. The show is named by its Series row's identity id
 * (see `loadSeriesKeys`), not by `series_id`: Jellyfin lists one show found in two library roots —
 * box A's tv and box B's tv — as two Series items with two ids, so a series_id key never matched a
 * season-pack episode on one box against the single episode on the other. `series_id` remains the
 * fallback for a show with no identity id, prefixed so it can never collide with a provider key.
 */
const seriesEpisodeRule: DupeRule = {
  id: 'dupe.series-episode',
  requires: ['jellyfin'],
  link(ctx) {
    const seriesKeys = loadSeriesKeys(ctx)
    const rows = loadItems(ctx).filter(
      (r) => r.type === 'Episode' && r.series_id && r.season_no !== null && r.episode_no !== null,
    )
    return pairsWithin(
      bucket(rows, (r) => `${seriesKeys.get(r.series_id!) ?? `series:${r.series_id}`}|${r.season_no}|${r.episode_no}`),
      (a, b, key) => {
        const { confidence, multiEpisode } = episodePair(a, b)
        return { ruleId: 'dupe.series-episode', a: a.id, b: b.id, confidence, evidence: { episodeKey: key, multiEpisode } }
      },
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
