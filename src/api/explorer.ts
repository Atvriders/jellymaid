import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Db } from '../index/db.js'
import type { ConfigStore } from '../config/store.js'
import { requireSession } from './auth.js'

/**
 * Maps the filesystem-class rule ids that carry a `path` subject onto the flag vocabulary this
 * screen renders. Deliberately NOT every rule id — metadata/quality/duplicate findings are not
 * filesystem facts about a single entry, so `flagMap` below also restricts its query to
 * `class = 'filesystem'` rather than relying on this map alone to filter them out.
 */
const FLAG_BY_RULE: Record<string, string> = {
  'fs.orphan-media': 'orphan',
  'fs.junk': 'junk',
  'fs.stray-sidecar': 'junk',
  'fs.empty-folder': 'empty',
  'fs.missing-file': 'missing',
}

/**
 * How many children a directory listing returns per page. Finding MAJOR 1: the child query used
 * to have no LIMIT at all, so a directory at or beyond SQLite's own bind-variable ceiling (see
 * `FLAG_QUERY_BATCH_SIZE` below) shipped every row as one JSON response — 30+ MB for a flat
 * downloads directory or a large music library. `MAX_PAGE_SIZE` is a ceiling on what an
 * authenticated caller may explicitly request, not the common case; `DEFAULT_PAGE_SIZE` is what an
 * unparameterized request gets, comfortably above what any reasonably-organized library directory
 * holds.
 *
 * The ceiling is 1,000 (C12), not the 50,000 it used to be: the screen pages with `offset`/`limit`
 * and shows `total`, so nothing needs a whole directory in one response, and a ceiling this low
 * keeps the slowest part of a listing — a rollup subquery per subdirectory on the page — bounded by
 * a number rather than by however large a directory a caller names. A larger `limit` is a 400, like
 * every other malformed query on this route, not a quietly shorter page the caller did not ask for.
 */
const DEFAULT_PAGE_SIZE = 500
const MAX_PAGE_SIZE = 1000

/** A plain non-negative integer in decimal — rejects arrays, floats, and non-numeric junk alike,
 * the same "SHAPE matters" discipline `path` documents below, rather than coercing and hoping. */
const numericParam = (min: number, max: number) =>
  z.string().regex(/^\d+$/, 'must be a non-negative integer').transform(Number).pipe(z.number().int().min(min).max(max))

const explorerQuery = z.object({
  // No `.min(1)`: an explicit `?path=` and an absent `path` are treated identically below (both
  // mean "show the configured roots") rather than one of them 400ing as "invalid". What zod
  // guards here is SHAPE — Fastify turns a repeated `?path=a&path=b` into an array, and this must
  // refuse that rather than silently picking one of the two the caller might have meant.
  path: z.string().optional(),
  limit: numericParam(1, MAX_PAGE_SIZE).optional(),
  offset: numericParam(0, Number.MAX_SAFE_INTEGER).optional(),
})

export function registerExplorerRoutes(
  app: FastifyInstance,
  deps: { db: Db; sessionSecret: string; configStore: Pick<ConfigStore, 'pathMap'> },
): void {
  app.get('/api/explorer', { preHandler: requireSession(deps.sessionSecret) }, async (req, reply) => {
    const parsed = explorerQuery.safeParse(req.query)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid query' })
    // The live path map — the same one the planner and executor read — so the containment check
    // below is the identical `isWithinRoot` every destructive path trusts, never a copy of the
    // mappings from before the last edit.
    const pathMap = deps.configStore.pathMap()
    // A trailing slash names the same directory as its slash-less form (`/mnt/m/` === `/mnt/m`),
    // but neither the root-equality check just below nor the child query's exact `parent_path`
    // match treats them as equal strings — normalize it away once, up front, so both agree on one
    // canonical form. Without this, `?path=/mnt/m/` at a root of `/mnt/m` fails the `===` check
    // (reporting a parent that points right back at itself) AND binds `parent_path = '/mnt/m/'`
    // against rows stored as `/mnt/m/Something` (never `/mnt/m/`), so a populated root reports
    // zero entries. A lone "/" is left alone: stripping it would leave an empty string, which this
    // route already treats as "no path" (see explorerQuery's comment above), not as the root.
    let requested = parsed.data.path
    if (requested && requested.length > 1 && requested.endsWith('/')) requested = requested.slice(0, -1)

    const limit = parsed.data.limit ?? DEFAULT_PAGE_SIZE
    const offset = parsed.data.offset ?? 0

    if (!requested) {
      // The top level of the tree: every configured mount (library AND download roots — an
      // operator inspecting "why did this not get cleaned up" needs to see the download side
      // too), not live-stat'd, just the index's rollup for each.
      //
      // Paged by the same `offset`/`limit` as a directory, so `total`, `offset` and `limit` mean
      // the same thing on every response and a client's pager has no top-level special case. A
      // handful of mounts never reach the default page, so this only ever slices when asked to.
      const roots = pathMap.all()
      return reply.send({
        path: '',
        parent: null,
        total: roots.length,
        limit,
        offset,
        entries: roots.slice(offset, offset + limit).map((m) => ({
          name: m.container,
          path: m.container,
          isDir: true,
          sizeBytes: rollupSize(deps.db, m.container),
          fileCount: rollupCount(deps.db, m.container),
          isMedia: false,
          flags: [] as string[],
        })),
      })
    }

    // Containment is a security boundary, not a convenience: `rootFor` is a lexical prefix check
    // (fast, but a symlink or a literal `..` segment can lexically sit "under" a root while
    // resolving somewhere else entirely), and `isWithinRoot` (src/fs/pathmap.ts) is what actually
    // resolves symlinks and fails closed on anything it cannot resolve. Both must pass — reusing
    // that one function rather than re-deriving a second containment check here.
    const root = pathMap.rootFor(requested)
    if (!root || !pathMap.isWithinRoot(requested, root)) {
      return reply.code(400).send({ error: 'path is outside every configured root' })
    }

    // The total sibling count independent of the page below — a caller must be able to tell "500
    // of 33,000" from "all 500 there are" without ever pulling all 33,000 rows into one response.
    const total = (deps.db.prepare(
      'SELECT COUNT(*) c FROM fs_entries WHERE parent_path = ?',
    ).get(requested) as { c: number }).c

    const rows = deps.db.prepare(
      'SELECT container_path, name, is_dir, size_bytes, is_media FROM fs_entries WHERE parent_path = ? ORDER BY is_dir DESC, name LIMIT ? OFFSET ?',
    ).all(requested, limit, offset) as Array<{ container_path: string; name: string; is_dir: number; size_bytes: number; is_media: number }>

    const flags = flagMap(deps.db, rows.map((r) => r.container_path))

    return reply.send({
      path: requested,
      parent: requested === root.container ? null : (requested.slice(0, requested.lastIndexOf('/')) || '/'),
      total,
      limit,
      offset,
      entries: rows.map((r) => ({
        name: r.name,
        path: r.container_path,
        isDir: r.is_dir === 1,
        sizeBytes: r.is_dir === 1 ? rollupSize(deps.db, r.container_path) : r.size_bytes,
        fileCount: r.is_dir === 1 ? rollupCount(deps.db, r.container_path) : 0,
        isMedia: r.is_media === 1,
        flags: flags.get(r.container_path) ?? [],
      })),
    })
  })
}

/**
 * Reads the INDEX, never the live filesystem — this is what keeps the screen fast at 100k+
 * entries (see the task brief). A bounded range scan on `fs_entries.container_path`'s own PRIMARY
 * KEY, not a LIKE-prefix scan: `container_path` is `TEXT PRIMARY KEY` under SQLite's default
 * BINARY collation (src/index/migrations/001_init.sql), so every true descendant of `prefix` —
 * one level down or a hundred — sorts strictly between `prefix + '/'` and `prefix + '0'`. `/` is
 * 0x2F and `0` is 0x30, the very next byte, so nothing that isn't a descendant can fall in that
 * gap and nothing that is one can fall outside it; the directory row itself (bare `prefix`, with
 * nothing appended) sorts below the lower bound, so it is never double-counted.
 *
 * This used to be `LIKE ? || '/%' ESCAPE '\'` with a hand-escaped prefix (`%`/`_`/`\` are LIKE
 * metacharacters, and scene-release naming makes `_` routine in real directory names). That was a
 * full table scan on every call: SQLite's LIKE-to-range optimization refuses to fire once a LIKE
 * declares an ESCAPE clause, and this table's default collation made escaping the pattern
 * mandatory for correctness. Comparing `container_path` directly with `>`/`<` needs no escaping at
 * all — a `%`, `_`, or literal `\` inside a directory NAME is just three ordinary bytes to a plain
 * comparison — and SQLite proves the bound directly against the PK's index
 * (`sqlite_autoindex_fs_entries_1`), turning what was a full scan per directory into an index
 * range seek. Measured on 100,500 rows / 500 sibling directories: the old query took ~13.5s for a
 * single listing; this one takes ~22ms (see fixwave-server-report.md for the full before/after).
 *
 * Finding MINOR 6: a root of exactly `/` breaks the `+ '/'` / `+ '0'` trick above — a child of `/`
 * is spelled `/name`, not `//name`, so `prefix + '/'` ('//') sits ABOVE every real child rather
 * than below it, and nothing sorts below `prefix + '0'` ('/0') either once you account for that;
 * the range ends up matching only literal double-slash paths, which this table never holds. `/`
 * is also the one prefix with no meaningful "next byte" upper bound to reach for: it has no
 * siblings to exclude, because every absolute path in this table already starts with it. `null`
 * here means "no upper bound", not "zero rows" — the caller drops the upper-bound clause entirely
 * rather than trying to invent a sentinel string that could collide with a real path.
 */
const descendantBounds = (prefix: string): [string, string | null] =>
  prefix === '/' ? ['/', null] : [`${prefix}/`, `${prefix}0`]

const rollupSize = (db: Db, prefix: string): number => {
  const [lo, hi] = descendantBounds(prefix)
  const row = hi === null
    ? db.prepare('SELECT COALESCE(SUM(size_bytes),0) s FROM fs_entries WHERE is_dir = 0 AND container_path > ?').get(lo)
    : db.prepare('SELECT COALESCE(SUM(size_bytes),0) s FROM fs_entries WHERE is_dir = 0 AND container_path > ? AND container_path < ?').get(lo, hi)
  return (row as { s: number }).s
}

const rollupCount = (db: Db, prefix: string): number => {
  const [lo, hi] = descendantBounds(prefix)
  const row = hi === null
    ? db.prepare('SELECT COUNT(*) c FROM fs_entries WHERE is_dir = 0 AND container_path > ?').get(lo)
    : db.prepare('SELECT COUNT(*) c FROM fs_entries WHERE is_dir = 0 AND container_path > ? AND container_path < ?').get(lo, hi)
  return (row as { c: number }).c
}

/**
 * Only `status = 'open'` findings count — a dismissed or resolved finding must not keep marking
 * an entry as suspect on the one screen an operator falls back to for ground truth.
 *
 * Scoped to exactly `paths` (the directory being listed), not every open filesystem finding in the
 * database: this used to load ALL of them and `JSON.parse` every `subjects_json`, unbounded by
 * what was actually being shown. That cost was negligible next to the rollup scan finding 1 fixed,
 * but with that scan now an index seek, an unscoped load-and-parse-everything pass would become
 * the dominant cost on a large, heavily-flagged library. `json_each`/`json_extract` (SQLite's
 * built-in JSON1, bundled with better-sqlite3) push both the "does this finding even mention one of
 * these paths" filter and the path extraction into SQL, so only rows that actually match come back
 * to be walked in JS at all — the shape already used for member-id lookups elsewhere in this file's
 * neighboring routes (see e.g. the placeholder-list pattern in findings.ts's /api/duplicates).
 *
 * Finding MAJOR 1: `paths` used to be bound as one `?` placeholder per entry in a single `IN (...)`
 * list, with no ceiling. SQLite refuses a statement carrying more than `SQLITE_MAX_VARIABLE_NUMBER`
 * bound parameters — measured at exactly 32,766 on this project's better-sqlite3 build (32,767
 * throws `SQLITE_ERROR: too many SQL variables`) — so a single flat directory with that many
 * children (a downloads folder, a large music library) 500'd on every listing. Batching `paths`
 * into chunks well under that ceiling and merging the per-batch results keeps this correct at any
 * directory size, independent of whatever page size the route above happens to be configured with.
 */
const FLAG_QUERY_BATCH_SIZE = 500

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function flagMap(db: Db, paths: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  if (!paths.length) return out
  for (const batch of chunk(paths, FLAG_QUERY_BATCH_SIZE)) {
    const placeholders = batch.map(() => '?').join(',')
    const rows = db.prepare(
      `SELECT DISTINCT f.rule_id AS rule_id, json_extract(je.value, '$.path') AS path
       FROM findings f, json_each(f.subjects_json) je
       WHERE f.status = 'open' AND f.class = 'filesystem'
         AND json_extract(je.value, '$.path') IN (${placeholders})`,
    ).all(...batch) as Array<{ rule_id: string; path: string | null }>
    for (const row of rows) {
      const flag = FLAG_BY_RULE[row.rule_id]
      if (!flag || !row.path) continue
      const list = out.get(row.path) ?? []
      if (!list.includes(flag)) list.push(flag)
      out.set(row.path, list)
    }
  }
  return out
}
