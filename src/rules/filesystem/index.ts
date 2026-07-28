import type { Finding } from '../../core/types.js'
import { findingId } from '../../core/types.js'
import type { Rule, RuleContext } from '../types.js'

function finding(
  ctx: RuleContext, ruleId: string, key: string, path: string,
  severity: Finding['severity'], evidence: Record<string, unknown>, reclaimable: number | null,
): Finding {
  return {
    id: findingId(ruleId, key),
    ruleId,
    class: 'filesystem',
    severity,
    confidence: 'exact',
    subjects: [{ kind: 'path', path, label: path }],
    evidence,
    reclaimableBytes: reclaimable,
    status: 'open',
    firstSeen: ctx.now,
    lastSeen: ctx.now,
  }
}

/**
 * "Empty" means recursively empty of anything worth keeping: a folder whose entire subtree holds
 * no file other than ones the operator has declared ignorable (`config.ignorableFiles`) is exactly
 * as reclaimable as a literally-empty one, e.g. a chain of nested folders holding nothing but a
 * leftover `Thumbs.db` three levels down.
 *
 * A naive version of this check runs one query per directory (`WHERE container_path LIKE ? ||
 * '/%'`) to find everything under it. That is a correlated-subquery-per-row shape in application
 * clothing: LIKE with a bound prefix does not use `fs_entries`' PRIMARY KEY index here (SQLite's
 * LIKE-to-range optimization only fires when it can prove no ASCII case-folding applies, which it
 * cannot for arbitrary media filenames), so each call is a full table scan. Over a 100k-row index
 * with even a few thousand directories that is a table-scan multiplied by directory count —
 * pathological. Instead this loads `fs_entries` exactly twice (once for directories, once for
 * files) and answers "is everything under me ignorable-or-absent" with a single memoized bottom-up
 * walk of the directory tree, using the already-stored `parent_path` column rather than
 * re-deriving a parent by slicing `container_path` — no repeated scans, no re-parsing of paths.
 */
const emptyFolderRule: Rule = {
  id: 'fs.empty-folder',
  class: 'filesystem',
  requires: ['filesystem'],
  run(ctx) {
    const ignorable = new Set(ctx.config.ignorableFiles.map((s) => s.toLowerCase()))
    const dirs = ctx.db.prepare(
      'SELECT container_path, parent_path, library_root FROM fs_entries WHERE is_dir = 1',
    ).all() as Array<{ container_path: string; parent_path: string; library_root: string | null }>
    const files = ctx.db.prepare(
      'SELECT parent_path, name, ext FROM fs_entries WHERE is_dir = 0',
    ).all() as Array<{ parent_path: string; name: string; ext: string | null }>

    // A directory that directly holds at least one non-ignorable file can never be "empty",
    // regardless of what its subdirectories look like.
    const hasDirectMeaningfulFile = new Set<string>()
    for (const f of files) {
      const ignoredByName = ignorable.has(f.name.toLowerCase())
      const ignoredByExt = ignorable.has((f.ext ?? '').toLowerCase())
      if (!ignoredByName && !ignoredByExt) hasDirectMeaningfulFile.add(f.parent_path)
    }

    const parentOf = new Map<string, string>()
    const childDirsOf = new Map<string, string[]>()
    const libraryRoots = new Set<string>()
    for (const d of dirs) {
      parentOf.set(d.container_path, d.parent_path)
      if (d.container_path === d.library_root) libraryRoots.add(d.container_path)
      const siblings = childDirsOf.get(d.parent_path)
      if (siblings) siblings.push(d.container_path)
      else childDirsOf.set(d.parent_path, [d.container_path])
    }

    // Bottom-up, memoized: a directory is empty iff it holds no direct meaningful file AND every
    // one of its subdirectories is itself empty. The walker never emits symlinked directories (see
    // src/fs/walker.ts), so parent/child edges here form a forest, not a graph — no cycle guard
    // needed.
    const emptyMemo = new Map<string, boolean>()
    function isRecursivelyEmpty(path: string): boolean {
      const cached = emptyMemo.get(path)
      if (cached !== undefined) return cached
      let empty = !hasDirectMeaningfulFile.has(path)
      if (empty) {
        for (const child of childDirsOf.get(path) ?? []) {
          if (!isRecursivelyEmpty(child)) { empty = false; break }
        }
      }
      emptyMemo.set(path, empty)
      return empty
    }

    const emptyPaths = new Set<string>()
    for (const d of dirs) {
      if (libraryRoots.has(d.container_path)) continue // never propose deleting a configured root
      if (isRecursivelyEmpty(d.container_path)) emptyPaths.add(d.container_path)
    }

    // Report only the topmost empty ancestor: nine nested rows for one dead folder is noise. A
    // folder's own parent — read from the stored column, not re-sliced from its path string — is
    // in emptyPaths exactly when it is itself fully empty, so this correctly collapses any chain,
    // including one interrupted partway by a sibling subtree that still holds real content (that
    // interruption already stopped the ancestor from being marked empty in the walk above, so its
    // still-empty descendant surfaces here as its own topmost report instead of being swallowed).
    const topmost = [...emptyPaths].filter((p) => !emptyPaths.has(parentOf.get(p) ?? ''))

    return topmost.sort().map((p) => finding(ctx, 'fs.empty-folder', p, p, 'info', { path: p }, 0))
  },
}

/**
 * A media file under a library root that Jellyfin does not know about under ANY path. Deliberately
 * scoped to `root_role = 'library'`: files under a download root are pre-import staging, not a
 * Jellyfin gap, per the global rule that only library roots are ever compared against Jellyfin's
 * inventory.
 *
 * "Known to Jellyfin" checks two sources, not one: `jellyfin_items.container_path` (the primary
 * path of a standalone or merged item) AND `jellyfin_item_paths.container_path` (every physical
 * file behind an item, including alternate versions — see 003_jellyfin_item_paths.sql). The second
 * check exists because `jellyfin_items` stores exactly one path per item, and for a merged
 * multi-version item that is only the primary version: `/Items?Recursive=true` stops returning an
 * alternate version as its own item row the moment it's merged, so without `jellyfin_item_paths`
 * its file would be indistinguishable from a genuine orphan here — a live path to the operator
 * deleting the file they just told Jellyfin (via this app's own `merge-versions` action) to keep.
 *
 * Both checks are `NOT EXISTS` against an indexed equality (`jellyfin_items.container_path` and
 * `jellyfin_item_paths.container_path` are both indexed), not a second `LEFT JOIN`: a `LEFT JOIN`
 * against `jellyfin_item_paths` could fan out into more than one matching row per file if two
 * different (item, path) pairs ever resolved to the same container path, which would silently
 * double-count that file's finding. `NOT EXISTS` is a boolean per outer row regardless of how many
 * matches exist on the other side, so this can't happen.
 */
const orphanMediaRule: Rule = {
  id: 'fs.orphan-media',
  class: 'filesystem',
  requires: ['filesystem', 'jellyfin'],
  run(ctx) {
    const rows = ctx.db.prepare(`SELECT f.container_path AS path, f.size_bytes AS size
      FROM fs_entries f
      WHERE f.is_media = 1 AND f.root_role = 'library'
        AND NOT EXISTS (SELECT 1 FROM jellyfin_items i WHERE i.container_path = f.container_path)
        AND NOT EXISTS (SELECT 1 FROM jellyfin_item_paths p WHERE p.container_path = f.container_path)`)
      .all() as Array<{ path: string; size: number }>
    return rows.map((r) =>
      finding(ctx, 'fs.orphan-media', r.path, r.path, 'warning', { sizeBytes: r.size }, r.size))
  },
}

/**
 * A Jellyfin item none of whose known paths resolve to a file on disk — critical because the
 * primary path (`jellyfin_items.container_path`) being gone does not by itself mean the item is
 * unplayable: if an alternate version merged into the same item (`jellyfin_item_paths`) still
 * exists, Jellyfin can still serve it, and reporting "missing" here would mislead the operator.
 * Only reported when NEITHER the primary path NOR any alternate resolves — same `NOT EXISTS`
 * reasoning, and same fan-out hazard, as `fs.orphan-media` above.
 */
const missingFileRule: Rule = {
  id: 'fs.missing-file',
  class: 'filesystem',
  requires: ['filesystem', 'jellyfin'],
  run(ctx) {
    const rows = ctx.db.prepare(`SELECT i.id AS id, i.name AS name, i.container_path AS path
      FROM jellyfin_items i
      WHERE i.container_path IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM fs_entries f WHERE f.container_path = i.container_path)
        AND NOT EXISTS (
          SELECT 1 FROM jellyfin_item_paths p
          JOIN fs_entries fa ON fa.container_path = p.container_path
          WHERE p.item_id = i.id
        )`)
      .all() as Array<{ id: string; name: string; path: string }>
    return rows.map((r) => ({
      id: findingId('fs.missing-file', r.id),
      ruleId: 'fs.missing-file',
      class: 'filesystem' as const,
      severity: 'critical' as const,
      confidence: 'exact' as const,
      subjects: [{ kind: 'item' as const, id: r.id, label: r.name, path: r.path }],
      evidence: { expectedPath: r.path },
      reclaimableBytes: null,
      status: 'open' as const,
      firstSeen: ctx.now,
      lastSeen: ctx.now,
    }))
  },
}

/**
 * Every threshold and ignorable-file list here comes from config (`ctx.config.rules['fs.junk']`),
 * not a hardcoded constant: a bare `/sample/i` name pattern would flag a real title like "Sample
 * City" for every operator with no way to turn it off. Defaults match what used to be hardcoded
 * exactly, so an unconfigured install behaves identically to before.
 */
const junkRule: Rule = {
  id: 'fs.junk',
  class: 'filesystem',
  requires: ['filesystem'],
  run(ctx) {
    const cfg = ctx.config.rules['fs.junk']
    const namePatterns = cfg.namePatterns.map((p) => new RegExp(p, 'i'))
    const junkExt = new Set(cfg.extensions.map((e) => e.toLowerCase()))
    const junkDir = new Set(cfg.directoryNames.map((d) => d.toLowerCase()))

    const rows = ctx.db.prepare(
      'SELECT container_path, name, ext, is_dir, is_media, size_bytes FROM fs_entries',
    ).all() as Array<{ container_path: string; name: string; ext: string | null; is_dir: number; is_media: number; size_bytes: number }>

    const out: Finding[] = []
    for (const r of rows) {
      const ext = (r.ext ?? '').toLowerCase()
      let reason: string | null = null
      if (r.is_dir === 1 && junkDir.has(r.name.toLowerCase())) reason = 'junk directory'
      else if (r.is_dir === 0 && junkExt.has(ext)) reason = `incomplete download (${ext})`
      else if (r.is_dir === 0 && namePatterns.some((re) => re.test(r.name))) reason = 'sample file'
      else if (r.is_dir === 0 && cfg.zeroByteIsJunk && r.is_media === 1 && r.size_bytes === 0) reason = 'zero-byte media file'
      if (!reason) continue
      out.push(finding(ctx, 'fs.junk', r.container_path, r.container_path, 'warning',
        { reason, sizeBytes: r.size_bytes }, r.size_bytes))
    }
    return out
  },
}

const straySidecarRule: Rule = {
  id: 'fs.stray-sidecar',
  class: 'filesystem',
  requires: ['filesystem'],
  run(ctx) {
    const sidecarExt = new Set(ctx.config.rules['fs.stray-sidecar'].extensions.map((e) => e.toLowerCase()))
    const rows = ctx.db.prepare(
      'SELECT container_path, parent_path, ext FROM fs_entries WHERE is_dir = 0',
    ).all() as Array<{ container_path: string; parent_path: string; ext: string | null }>
    const mediaByParent = new Map<string, number>()
    for (const r of ctx.db.prepare(
      'SELECT parent_path, COUNT(*) c FROM fs_entries WHERE is_media = 1 GROUP BY parent_path',
    ).all() as Array<{ parent_path: string; c: number }>) mediaByParent.set(r.parent_path, r.c)

    return rows
      .filter((r) => sidecarExt.has((r.ext ?? '').toLowerCase()) && !(mediaByParent.get(r.parent_path) ?? 0))
      .map((r) => finding(ctx, 'fs.stray-sidecar', r.container_path, r.container_path, 'info',
        { ext: r.ext }, 0))
  },
}

const permissionRule: Rule = {
  id: 'fs.permission',
  class: 'filesystem',
  requires: ['filesystem'],
  run(ctx) {
    const row = ctx.db.prepare("SELECT value_json FROM kv WHERE key = 'scan.fsErrors'").get() as
      { value_json: string } | undefined
    if (!row) return []
    const errors = JSON.parse(row.value_json) as Array<{ path: string; reason: string }>
    return errors.map((e) =>
      finding(ctx, 'fs.permission', e.path, e.path, 'warning', { reason: e.reason }, null))
  },
}

export const FILESYSTEM_RULES: Rule[] = [
  emptyFolderRule, orphanMediaRule, missingFileRule, junkRule, straySidecarRule, permissionRule,
]
