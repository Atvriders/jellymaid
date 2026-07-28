import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import type { PathMap } from '../fs/pathmap.js'
import type { PathMapping } from '../core/types.js'

/** A directory tree deeper than this below a root is a symptom, not a library. Bounds the sweep. */
export const MAX_SWEEP_DEPTH = 256

/**
 * Two paths that name the same directory, whether or not the strings agree. The lexical compare
 * catches the common case cheaply; the realpath compare catches a root reached through a symlink,
 * which is the one that matters — it is the last stop between the sweep and the root's parent.
 */
export function samePath(a: string, b: string): boolean {
  if (resolvePath(a) === resolvePath(b)) return true
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

/**
 * The three independent stops that must ALL agree before the sweep may climb into `current`,
 * because a single off-by-one here deletes an operator's library root:
 *
 *  - `samePath` against the root itself, so the root is never the thing removed;
 *  - `isWithinRoot`, which resolves symlinks and fails closed — a plain `startsWith` would let
 *    `/media/lib-backup` pass as inside `/media/lib`;
 *  - the filesystem root, as a backstop if the two above were ever misconfigured away.
 *
 * Lives here, shared, so the planner's dry-run preview and the executor's real sweep cannot drift
 * apart on where the sweep stops — which is the only part of "which directories go" an operator
 * approving a plan has no way to check for themselves.
 */
export function canSweepInto(current: string, root: PathMapping, pathMap: PathMap): boolean {
  if (samePath(current, root.container)) return false
  if (!pathMap.isWithinRoot(current, root)) return false
  if (current === dirname(current)) return false
  return true
}

/**
 * Which directories the executor's sweep WOULD remove if `paths` all went away — read-only, and
 * deciding by the same stops the real sweep uses.
 *
 * A dry run that reports only files understates what an operator is approving: deleting one
 * episode routinely takes `Show/Season 01/` and `Show/` with it, because the executor walks upward
 * removing every parent the delete just emptied. That is the intended behaviour, and it is exactly
 * the kind of thing that should be on screen BEFORE the approval rather than discovered in the
 * audit log afterwards.
 *
 * `paths` is the plan's whole executable set, not one target, so two files sharing a directory
 * correctly empty it between them. The set grows as directories are swept, which is what lets a
 * chain collapse several levels the way the real sweep does. A directory is counted at most once
 * however many planned paths lead to it.
 *
 * Deliberately optimistic in one direction, and only one: a `remove-empty-folder` target that is no
 * longer empty by execute time is counted here anyway. The preview's job is to warn that a chain
 * MAY go, and over-warning about a directory the executor will refuse to touch is the harmless side.
 */
export function previewSweptDirectories(pathMap: PathMap, paths: Iterable<string>): string[] {
  const removed = new Set(paths)
  const swept = new Set<string>()
  // Snapshotted before the loop, which then adds swept directories to `removed` as it goes.
  for (const path of [...removed].sort()) {
    const root = pathMap.rootFor(path)
    if (!root) continue
    let current = dirname(path)
    for (let depth = 0; depth < MAX_SWEEP_DEPTH; depth += 1) {
      if (swept.has(current)) break // already counted, by a sibling path that got here first
      if (!canSweepInto(current, root, pathMap)) break
      let entries: string[]
      try {
        if (!existsSync(current)) break
        if (!lstatSync(current).isDirectory()) break
        entries = readdirSync(current).map((name) => join(current, name))
      } catch {
        break
      }
      // Anything still here that the plan is not taking keeps this directory — and therefore every
      // directory above it — exactly where it is.
      if (entries.some((e) => !removed.has(e) && !swept.has(e))) break
      swept.add(current)
      removed.add(current)
      current = dirname(current)
    }
  }
  return [...swept].sort()
}
