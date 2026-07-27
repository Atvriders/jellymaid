import type { Phase, PhaseResult } from './types.js'
import { describeError } from './types.js'
import { walkRoot } from '../../fs/walker.js'

export const filesystemPhase: Phase = {
  name: 'filesystem',
  async run(ctx): Promise<PhaseResult> {
    const roots = ctx.deps.pathMap.all()
    if (!roots.length) return { status: 'skipped', reason: 'no path mappings configured', counts: {} }

    const hashedRoots = new Set(ctx.deps.config.hashedLibraryRoots)
    const insert = ctx.db.prepare(`INSERT OR REPLACE INTO fs_entries (
      container_path, scan_id, parent_path, name, ext, is_dir, size_bytes, mtime,
      dev, inode, nlink, is_media, library_root, root_role, quick_hash
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    const writeBatch = ctx.db.transaction((rows: unknown[][]) => { for (const r of rows) insert.run(...r) })

    const done = new Set((ctx.cursor.completedRoots as string[] | undefined) ?? [])
    const errors: Array<{ path: string; reason: string }> = []
    let written = 0
    let stale = 0

    for (const root of roots) {
      if (done.has(root.container)) continue
      if (ctx.signal.aborted) return { status: 'cancelled', counts: { entries: written } }
      const shouldHash = hashedRoots.has(root.container) && ctx.deps.hasher !== null

      // Set when the root's own top-level directory could never be opened at all (mount down,
      // permissions, deleted). Distinct from a deep subdirectory failing partway through: that
      // still leaves us knowing the root existed, so its remaining rows are swept as usual. An
      // unopenable root tells us nothing — treating "we saw nothing" as "there is nothing" would
      // wipe this root's entire prior index and tell every filesystem rule every file in it just
      // vanished, when in fact we just failed to look.
      let rootUnreachable = false

      try {
        for await (const batch of walkRoot({
          root,
          mediaExtensions: ctx.deps.config.mediaExtensions,
          batchSize: 1000,
          signal: ctx.signal,
          onError: (e) => {
            errors.push(e)
            if (e.path === root.container) rootUnreachable = true
          },
        })) {
          const rows: unknown[][] = []
          for (const e of batch) {
            let hash: string | null = null
            // A file the walker could not stat has NULL dev/inode/ctime and cannot be hashed.
            if (shouldHash && e.isMedia && ctx.deps.hasher && e.dev !== null && e.inode !== null && e.ctime !== null) {
              try {
                hash = await ctx.deps.hasher.quickHash(e.containerPath, {
                  dev: e.dev, inode: e.inode, mtime: e.mtime, ctime: e.ctime, size: e.sizeBytes,
                })
              } catch (err) {
                errors.push({ path: e.containerPath, reason: describeError(err) })
              }
            }
            rows.push([
              e.containerPath, ctx.scanId, e.parentPath, e.name, e.ext, e.isDir ? 1 : 0,
              e.sizeBytes, e.mtime, e.dev, e.inode, e.nlink, e.isMedia ? 1 : 0,
              e.libraryRoot, e.rootRole, hash,
            ])
          }
          writeBatch(rows)
          written += rows.length
          ctx.progress(written, null)
        }
      } catch (err) {
        errors.push({ path: root.container, reason: describeError(err) })
        rootUnreachable = true
      }

      if (rootUnreachable) {
        done.add(root.container)
        ctx.saveCursor({ completedRoots: [...done] })
        continue
      }

      // Sweep this root's ghosts: rows written by an earlier scan that this pass did not
      // see are files that no longer exist. Leaving them makes fs.orphan-media and
      // fs.missing-file report on paths that are gone.
      const swept = ctx.db.prepare(
        'DELETE FROM fs_entries WHERE library_root = ? AND scan_id != ?',
      ).run(root.container, ctx.scanId).changes
      stale += swept

      done.add(root.container)
      ctx.saveCursor({ completedRoots: [...done] })
    }
    return { status: 'completed', counts: { entries: written, stale, errors: errors.length } }
  },
}
