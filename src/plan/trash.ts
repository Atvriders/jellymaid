import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Db } from '../index/db.js'
import type { FileConfig } from '../config/schema.js'
import type { PathMap } from '../fs/pathmap.js'
import { TRASH_DIR_NAME } from '../fs/walker.js'

export interface TrashDeps { db: Db; config: FileConfig; pathMap: PathMap }

export function moveToTrash(
  deps: TrashDeps,
  opts: { path: string; planId: string; sizeBytes: number },
): { trashed: true; trashPath: string } | { trashed: false; reason: string } {
  if (opts.sizeBytes > deps.config.trash.maxBytes) {
    return { trashed: false, reason: `file exceeds trash.maxBytes (${opts.sizeBytes} > ${deps.config.trash.maxBytes})` }
  }
  const root = deps.pathMap.rootFor(opts.path)
  // isWithinRoot re-checks (not just trusts rootFor's prefix match) so a symlink swapped in
  // between root lookup and this call cannot smuggle the source path outside its root — the same
  // time-of-check-to-time-of-use gap pathmap.ts documents on isWithinRoot itself.
  if (!root || !deps.pathMap.isWithinRoot(opts.path, root)) {
    return { trashed: false, reason: 'path is not inside a configured root' }
  }

  const id = randomUUID()
  // The trash directory lives INSIDE the same root the file came from (root.container), never
  // some fixed global path — that is what keeps the rename same-filesystem (a cross-device
  // rename fails rather than silently falling back to a copy) and what keeps the trash target
  // itself confined to the root the walker already excludes it from.
  const trashDir = join(root.container, TRASH_DIR_NAME, opts.planId)
  // The UUID prefix is what prevents two same-named files (e.g. two different "sample.mkv" in
  // different subdirectories) from colliding once they land in the same flat trash directory.
  const trashPath = join(trashDir, `${id}-${basename(opts.path)}`)
  // `join()` collapses ".." segments lexically, regardless of what is on disk: a `planId` of
  // "../../../etc" turns `trashDir` above into a path outside `root.container` entirely, before
  // anything is ever created. `opts.planId` is caller-supplied (this module has no way to know
  // whether the caller minted it safely), so refuse rather than trust it — the same fail-closed
  // shape as the confinement check on the source path just above. This must run before mkdirSync,
  // or the traversal would already have created the escaping directory.
  if (!deps.pathMap.isWithinRoot(trashPath, root)) {
    return { trashed: false, reason: 'trash target escaped its root (invalid planId)' }
  }
  const deletedAt = new Date()
  const purgeAfter = new Date(deletedAt.getTime() + deps.config.trash.retentionDays * 86_400_000)
  // Row first, file second — and the row is committed on its own before the rename is even
  // attempted. The two cannot be made atomic (a filesystem rename cannot join a SQLite
  // transaction), so all that is left to choose is which side of the crash window is survivable,
  // and the two orphans are not equally bad:
  //
  //   orphan ROW, no file — recoverable. restoreFromTrash reports "trashed file is gone",
  //     purgeExpiredTrash treats the ENOENT as already-gone and reaps the row, and until then
  //     the row is a legible trace of what this run was in the middle of doing.
  //   orphan FILE, no row — NOT recoverable by anything here. purgeExpiredTrash only ever
  //     iterates rows and restoreFromTrash only ever looks up rows, so a file sitting under
  //     .jellymaid-trash/<planId> with no row is never purged, never restorable, and never
  //     listed. It is invisible and permanent, and it is the operator's file.
  //
  // So the window is deliberately parked on the harmless side. Note this must NOT be one
  // transaction wrapped around the INSERT and the rename: the whole point is that the row is
  // durable at the instant the file moves, which an uncommitted transaction would not give us.
  deps.db.transaction(() => {
    deps.db.prepare(
      'INSERT INTO trash (id, original_path, trash_path, size_bytes, deleted_at, purge_after, plan_id) VALUES (?,?,?,?,?,?,?)',
    ).run(id, opts.path, trashPath, opts.sizeBytes, deletedAt.toISOString(), purgeAfter.toISOString(), opts.planId)
  })()

  try {
    mkdirSync(trashDir, { recursive: true })
    // Same-filesystem rename only. A cross-device move would mean copying, which the
    // whole point of trashing small files is to avoid.
    renameSync(opts.path, trashPath)
  } catch (err) {
    try {
      // The move was refused outright, so the row describes something that never happened —
      // undo it by hand, since the INSERT is already committed and nothing will roll it back.
      deps.db.prepare('DELETE FROM trash WHERE id = ?').run(id)
    } catch {
      // A failed rollback must not replace the failure the caller actually needs to hear about
      // (a locked or unwritable database would otherwise mask "the file could not be moved").
      // The worst case of swallowing it is the benign orphan row described above.
    }
    return { trashed: false, reason: `move failed: ${(err as Error).message}` }
  }

  return { trashed: true, trashPath }
}

export function restoreFromTrash(deps: TrashDeps, trashId: string): { restored: boolean; reason?: string } {
  // restored_at IS NULL is the replay guard: once an entry is restored this WHERE clause can
  // never match it again, so calling restoreFromTrash twice with the same id is a no-op on the
  // second call ("no such trash entry") rather than a second file-system move.
  const row = deps.db.prepare('SELECT * FROM trash WHERE id = ? AND restored_at IS NULL').get(trashId) as
    { id: string; original_path: string; trash_path: string } | undefined
  if (!row) return { restored: false, reason: 'no such trash entry' }
  if (!existsSync(row.trash_path)) return { restored: false, reason: 'trashed file is gone' }
  if (existsSync(row.original_path)) return { restored: false, reason: 'a file already exists at the original path' }
  try {
    mkdirSync(dirname(row.original_path), { recursive: true })
    renameSync(row.trash_path, row.original_path)
  } catch (err) {
    return { restored: false, reason: (err as Error).message }
  }
  deps.db.prepare('UPDATE trash SET restored_at = ? WHERE id = ?').run(new Date().toISOString(), trashId)
  return { restored: true }
}

export interface PurgeFailure { id: string; path: string; reason: string }
export interface PurgeResult { purged: number; failed: PurgeFailure[] }

export function purgeExpiredTrash(deps: TrashDeps, now = new Date()): PurgeResult {
  const rows = deps.db.prepare('SELECT id, trash_path FROM trash WHERE restored_at IS NULL AND purge_after <= ?')
    .all(now.toISOString()) as Array<{ id: string; trash_path: string }>
  let purged = 0
  const failed: PurgeFailure[] = []
  for (const row of rows) {
    try {
      rmSync(row.trash_path)
    } catch (err) {
      // ENOENT is the only failure that means "already gone" — the legitimate case this
      // function exists to clean up after. Anything else (EACCES, EBUSY, a read-only mount, …)
      // means the file is still sitting on disk, and the trash row is the ONLY record that it
      // exists. Deleting that row here would erase the one trace of an untracked file — leave
      // the row in place, do not count it as purged, and surface the failure instead of
      // discarding it, since the trash table and audit log are the sole record of what happened.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        failed.push({ id: row.id, path: row.trash_path, reason: (err as Error).message })
        continue
      }
    }
    deps.db.prepare('DELETE FROM trash WHERE id = ?').run(row.id)
    purged += 1
  }
  return { purged, failed }
}
