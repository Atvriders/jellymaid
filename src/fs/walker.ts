import { opendir, lstat } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { extname, join } from 'node:path'
import type { PathMapping, PathRole } from '../core/types.js'

export const TRASH_DIR_NAME = '.jellymaid-trash'

export interface FsEntry {
  containerPath: string
  parentPath: string
  name: string
  ext: string | null
  isDir: boolean
  sizeBytes: number
  mtime: number
  /**
   * NULL when the entry could not be stat'd. Never 0: `(0, 0)` is a matchable value on
   * the correlation index, so every unstattable row would collide with every other, and
   * `nlink = 1` is indistinguishable from "only link, deleting reclaims the full size" —
   * the exact input Plan 4's hardlink guard trusts.
   */
  dev: number | null
  inode: number | null
  nlink: number | null
  isMedia: boolean
  libraryRoot: string
  rootRole: PathRole
}

export interface WalkOptions {
  root: PathMapping
  mediaExtensions: string[]
  batchSize?: number
  signal?: AbortSignal
  onError?: (err: { path: string; reason: string }) => void
  /**
   * Injectable for tests only — the unknown-stat path is otherwise awkward to provoke portably.
   * Narrowed to `(path: string) => Promise<Stats>` (rather than the full overloaded `typeof
   * lstat`, which also accepts `Buffer`/`URL` and can return `BigIntStats`): every call site in
   * this file passes a `string`, and a plain string-in/`Stats`-out function is the minimal shape
   * a test double needs to implement.
   */
  lstatImpl?: (path: string) => Promise<Stats>
}

export async function* walkRoot(opts: WalkOptions): AsyncGenerator<FsEntry[]> {
  const batchSize = opts.batchSize ?? 500
  const statOf: (path: string) => Promise<Stats> = opts.lstatImpl ?? lstat
  const media = new Set(opts.mediaExtensions.map((e) => e.toLowerCase()))
  const stack: string[] = [opts.root.container]
  let batch: FsEntry[] = []

  while (stack.length) {
    if (opts.signal?.aborted) break
    const current = stack.pop()!
    let dir
    try {
      dir = await opendir(current)
    } catch (err) {
      opts.onError?.({ path: current, reason: (err as Error).message })
      continue
    }
    try {
      for await (const dirent of dir) {
        if (opts.signal?.aborted) break
        if (dirent.name === TRASH_DIR_NAME) continue
        const full = join(current, dirent.name)
        // lstat, never stat: a symlink must not be followed out of the root.
        let st
        try {
          st = await statOf(full)
        } catch (err) {
          // readdir listed it, so the path exists — we just cannot describe it. Emit a
          // row with unknown stat rather than skipping: a missing row reads as "this file
          // is gone", which would make the filesystem rules report on a healthy file.
          opts.onError?.({ path: full, reason: (err as Error).message })
          batch.push({
            containerPath: full,
            parentPath: current,
            name: dirent.name,
            ext: extname(dirent.name).toLowerCase() || null,
            isDir: false,
            sizeBytes: 0,
            mtime: 0,
            dev: null,
            inode: null,
            nlink: null,
            isMedia: false,
            libraryRoot: opts.root.container,
            rootRole: opts.root.role,
          })
          if (batch.length >= batchSize) {
            yield batch
            batch = []
            if (opts.signal?.aborted) return
          }
          continue
        }
        if (st.isSymbolicLink()) continue
        const isDir = st.isDirectory()
        if (isDir) stack.push(full)
        const ext = isDir ? null : extname(dirent.name).toLowerCase() || null
        batch.push({
          containerPath: full,
          parentPath: current,
          name: dirent.name,
          ext,
          isDir,
          sizeBytes: isDir ? 0 : st.size,
          mtime: Math.floor(st.mtimeMs),
          dev: Number(st.dev),
          inode: Number(st.ino),
          nlink: st.nlink,
          isMedia: !isDir && ext !== null && media.has(ext),
          libraryRoot: opts.root.container,
          rootRole: opts.root.role,
        })
        if (batch.length >= batchSize) {
          yield batch
          batch = []
          if (opts.signal?.aborted) return
        }
      }
    } catch (err) {
      opts.onError?.({ path: current, reason: (err as Error).message })
    }
  }
  if (batch.length) yield batch
}
