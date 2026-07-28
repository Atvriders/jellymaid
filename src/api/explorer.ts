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
    const requested = parsed.data.path

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
 * `%` and `_` are SQL LIKE wildcards, not just directory-name characters — and scene-release
 * naming makes `_` routine in real media directory names (`Movie_Name_2020`). Left unescaped,
 * `LIKE '/mnt/m/Movie_Name/%'` also matches a completely unrelated sibling like
 * `/mnt/m/MovieXName/...` (`_` matching any one character), silently pulling another folder's
 * bytes into this one's rollup on the one screen an operator trusts as ground truth. Every
 * occurrence of the escape character itself, then of `%` and `_`, is prefixed with `\` before the
 * prefix is bound, and the query declares `\` as the escape character to match.
 */
function escapeLikePrefix(raw: string): string {
  return raw.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/** Reads the INDEX, never the live filesystem — this is what keeps the screen fast at 100k+
 * entries (see the task brief). `LIKE prefix || '/%'` matches true descendants only, never the
 * directory row itself, so a directory never counts its own (always-0) size_bytes twice. */
const rollupSize = (db: Db, prefix: string): number =>
  (db.prepare(
    "SELECT COALESCE(SUM(size_bytes),0) s FROM fs_entries WHERE is_dir = 0 AND container_path LIKE ? || '/%' ESCAPE '\\'",
  ).get(escapeLikePrefix(prefix)) as { s: number }).s

const rollupCount = (db: Db, prefix: string): number =>
  (db.prepare(
    "SELECT COUNT(*) c FROM fs_entries WHERE is_dir = 0 AND container_path LIKE ? || '/%' ESCAPE '\\'",
  ).get(escapeLikePrefix(prefix)) as { c: number }).c

/** Only `status = 'open'` findings count — a dismissed or resolved finding must not keep marking
 * an entry as suspect on the one screen an operator falls back to for ground truth. */
function flagMap(db: Db, paths: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  if (!paths.length) return out
  const rows = db.prepare(
    "SELECT rule_id, subjects_json FROM findings WHERE status = 'open' AND class = 'filesystem'",
  ).all() as Array<{ rule_id: string; subjects_json: string }>
  const wanted = new Set(paths)
  for (const row of rows) {
    const flag = FLAG_BY_RULE[row.rule_id]
    if (!flag) continue
    for (const subject of JSON.parse(row.subjects_json) as Array<{ path?: string }>) {
      if (!subject.path || !wanted.has(subject.path)) continue
      const list = out.get(subject.path) ?? []
      if (!list.includes(flag)) list.push(flag)
      out.set(subject.path, list)
    }
  }
  return out
}
