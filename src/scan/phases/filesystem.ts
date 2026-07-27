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
    // Root-level open failures only (mount down, deleted, permissions) — not subtree errors.
    // Used to tell "every root failed outright" from "every root walked, some imperfectly".
    const rootOpenFailures: Array<{ path: string; reason: string }> = []
    let written = 0
    let stale = 0
    let sweepSkipped = 0
    let anyRootWalked = false

    for (const root of roots) {
      if (done.has(root.container)) continue
      if (ctx.signal.aborted) return { status: 'cancelled', counts: { entries: written } }
      const shouldHash = hashedRoots.has(root.container) && ctx.deps.hasher !== null

      // Any error during this root's walk — top-level or a subtree partway through — means this
      // pass did not see the whole root. A stale row under an unread subtree is not a proven
      // ghost, only an unobserved one; sweeping it would tell every filesystem rule the file
      // vanished, and "missing" is an input to a delete decision. Stale rows are the safer
      // failure: the executor already treats a finding for a vanished path as already-gone.
      let rootHadErrors = false
      // Narrower: the root's own top-level directory could never be opened at all (mount down,
      // permissions, deleted). Distinct from a deep subdirectory failing partway through: that
      // still leaves us knowing the root existed. An unopenable root tells us nothing — treating
      // "we saw nothing" as "there is nothing" would wipe this root's entire prior index and
      // tell every filesystem rule every file in it just vanished, when in fact we just failed
      // to look. Also feeds whether the PHASE can claim it walked anything at all.
      let rootOpenFailed = false

      try {
        for await (const batch of walkRoot({
          root,
          mediaExtensions: ctx.deps.config.mediaExtensions,
          batchSize: 1000,
          signal: ctx.signal,
          onError: (e) => {
            errors.push(e)
            rootHadErrors = true
            if (e.path === root.container) {
              rootOpenFailed = true
              rootOpenFailures.push(e)
            }
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
        const failure = { path: root.container, reason: describeError(err) }
        errors.push(failure)
        rootHadErrors = true
        rootOpenFailed = true
        rootOpenFailures.push(failure)
      }

      if (!rootOpenFailed) anyRootWalked = true

      if (rootHadErrors) {
        // Do not sweep: some part of this root was not actually observed this pass, so its
        // remaining prior-scan rows are not proven gone. Recorded, not silently dropped.
        sweepSkipped += 1
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

    if (!anyRootWalked && errors.length) {
      // Every configured root failed before it could even be opened — this is a total
      // filesystem-connectivity failure disguised as "nothing found" unless it says so. Name
      // every failed root so an operator knows which mount is down.
      const reason = `every configured root failed to open: ${rootOpenFailures.map((f) => `${f.path} (${f.reason})`).join('; ')}`
      return { status: 'skipped', reason, counts: { entries: written, stale, errors: errors.length, sweepSkipped } }
    }

    return { status: 'completed', counts: { entries: written, stale, errors: errors.length, sweepSkipped } }
  },
}
