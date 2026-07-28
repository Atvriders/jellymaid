import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Db } from '../index/db.js'
import type { PathMap } from '../fs/pathmap.js'
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

const explorerQuery = z.object({
  // No `.min(1)`: an explicit `?path=` and an absent `path` are treated identically below (both
  // mean "show the configured roots") rather than one of them 400ing as "invalid". What zod
  // guards here is SHAPE — Fastify turns a repeated `?path=a&path=b` into an array, and this must
  // refuse that rather than silently picking one of the two the caller might have meant.
  path: z.string().optional(),
})

export function registerExplorerRoutes(
  app: FastifyInstance,
  deps: { db: Db; sessionSecret: string; pathMap: PathMap },
): void {
  app.get('/api/explorer', { preHandler: requireSession(deps.sessionSecret) }, async (req, reply) => {
    const parsed = explorerQuery.safeParse(req.query)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid query' })
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

    if (!requested) {
      // The top level of the tree: every configured mount (library AND download roots — an
      // operator inspecting "why did this not get cleaned up" needs to see the download side
      // too), not live-stat'd, just the index's rollup for each.
      return reply.send({
        path: '',
        parent: null,
        entries: deps.pathMap.all().map((m) => ({
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
    const root = deps.pathMap.rootFor(requested)
    if (!root || !deps.pathMap.isWithinRoot(requested, root)) {
      return reply.code(400).send({ error: 'path is outside every configured root' })
    }

    const rows = deps.db.prepare(
      'SELECT container_path, name, is_dir, size_bytes, is_media FROM fs_entries WHERE parent_path = ? ORDER BY is_dir DESC, name',
    ).all(requested) as Array<{ container_path: string; name: string; is_dir: number; size_bytes: number; is_media: number }>

    const flags = flagMap(deps.db, rows.map((r) => r.container_path))

    return reply.send({
      path: requested,
      parent: requested === root.container ? null : (requested.slice(0, requested.lastIndexOf('/')) || '/'),
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
 */
const descendantBounds = (prefix: string): [string, string] => [`${prefix}/`, `${prefix}0`]

const rollupSize = (db: Db, prefix: string): number => {
  const [lo, hi] = descendantBounds(prefix)
  return (db.prepare(
    'SELECT COALESCE(SUM(size_bytes),0) s FROM fs_entries WHERE is_dir = 0 AND container_path > ? AND container_path < ?',
  ).get(lo, hi) as { s: number }).s
}

const rollupCount = (db: Db, prefix: string): number => {
  const [lo, hi] = descendantBounds(prefix)
  return (db.prepare(
    'SELECT COUNT(*) c FROM fs_entries WHERE is_dir = 0 AND container_path > ? AND container_path < ?',
  ).get(lo, hi) as { c: number }).c
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
 */
function flagMap(db: Db, paths: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  if (!paths.length) return out
  const placeholders = paths.map(() => '?').join(',')
  const rows = db.prepare(
    `SELECT DISTINCT f.rule_id AS rule_id, json_extract(je.value, '$.path') AS path
     FROM findings f, json_each(f.subjects_json) je
     WHERE f.status = 'open' AND f.class = 'filesystem'
       AND json_extract(je.value, '$.path') IN (${placeholders})`,
  ).all(...paths) as Array<{ rule_id: string; path: string | null }>
  for (const row of rows) {
    const flag = FLAG_BY_RULE[row.rule_id]
    if (!flag || !row.path) continue
    const list = out.get(row.path) ?? []
    if (!list.includes(flag)) list.push(flag)
    out.set(row.path, list)
  }
  return out
}
