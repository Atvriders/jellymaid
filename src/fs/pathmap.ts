import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import type { PathMapping } from '../core/types.js'

const strip = (p: string) => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p)

/**
 * Resolves symlinks in every existing ancestor of `p`, then re-appends whatever trailing
 * segments do not exist yet, lexically. `resolve()` alone is purely lexical and cannot see
 * symlinks — it would treat `<root>/link -> /etc` (or `<root>/link -> /nonexistent`) as staying
 * under `<root>`. Walks upward from `p` looking for the deepest ancestor `realpathSync` can
 * resolve; everything below that ancestor is collected and reappended in its original order.
 *
 * Fails CLOSED (returns `null`) rather than guessing, on:
 *  - any `realpathSync` failure that is not "this exact path doesn't exist yet" (EACCES, ELOOP, …);
 *  - a dangling symlink (the entry itself exists per `lstatSync`, but `realpathSync` still could
 *    not resolve it — most commonly because its target does not exist). This is the same
 *    attacker-planted-symlink escape as a symlink to a real outside path, just pointed at a
 *    missing target instead, so it gets the same answer;
 *  - reaching the filesystem root without ever finding an existing ancestor.
 * Only genuinely nonexistent-so-far path components (no entry at all, `lstatSync` itself throws
 * ENOENT) are treated as "not created yet" and walked past.
 */
function resolveReal(p: string): string | null {
  let current = resolve(p)
  const remainder: string[] = []
  for (;;) {
    try {
      const real = realpathSync(current)
      return remainder.length === 0 ? real : join(real, ...[...remainder].reverse())
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null // EACCES, ELOOP, … — fail closed

      try {
        lstatSync(current)
        // The entry exists (as a symlink or otherwise) yet realpath could not resolve it — most
        // commonly a dangling symlink. Fail closed rather than guess at what it would point to.
        return null
      } catch (lstatErr) {
        if ((lstatErr as NodeJS.ErrnoException).code !== 'ENOENT') return null
        // current genuinely does not exist yet — the normal case while probing a path that has
        // not been created. Record it and keep resolving one level up.
      }

      const parent = dirname(current)
      if (parent === current) return null // hit the filesystem root without an existing ancestor
      remainder.push(basename(current))
      current = parent
    }
  }
}

function underPrefix(path: string, prefix: string): boolean {
  const p = strip(path)
  const q = strip(prefix)
  return p === q || p.startsWith(q.endsWith('/') ? q : `${q}/`)
}

function rebase(path: string, from: string, to: string): string {
  const rest = strip(path).slice(strip(from).length)
  return `${strip(to)}${rest}`
}

export interface PathMap {
  toContainer(jellyfinPath: string): string | null
  fromContainer(containerPath: string): string | null
  qbitToContainer(qbitPath: string): string | null
  rootFor(containerPath: string): PathMapping | null
  libraryRoots(): PathMapping[]
  downloadRoots(): PathMapping[]
  isWithinRoot(containerPath: string, root: PathMapping): boolean
  all(): PathMapping[]
}

export function createPathMap(mappings: PathMapping[]): PathMap {
  const byJf = [...mappings].filter((m) => m.jellyfin).sort((a, b) => b.jellyfin!.length - a.jellyfin!.length)
  const byContainer = [...mappings].sort((a, b) => b.container.length - a.container.length)
  const byQbit = [...mappings].filter((m) => m.qbit).sort((a, b) => b.qbit!.length - a.qbit!.length)

  // A root's own resolution is repeated across many isWithinRoot calls (e.g. Plan 4's sweep
  // checks the same root against every ancestor directory it walks upward through), so it is
  // cached here rather than re-resolved via realpathSync on every call.
  const rootRealCache = new Map<string, string | null>()
  function resolveRootReal(container: string): string | null {
    let cached = rootRealCache.get(container)
    if (cached === undefined) {
      cached = resolveReal(container)
      rootRealCache.set(container, cached)
    }
    return cached
  }

  return {
    toContainer(jellyfinPath) {
      const m = byJf.find((x) => underPrefix(jellyfinPath, x.jellyfin!))
      return m ? rebase(jellyfinPath, m.jellyfin!, m.container) : null
    },
    fromContainer(containerPath) {
      const m = byContainer.find((x) => x.jellyfin && underPrefix(containerPath, x.container))
      return m ? rebase(containerPath, m.container, m.jellyfin!) : null
    },
    qbitToContainer(qbitPath) {
      const m = byQbit.find((x) => underPrefix(qbitPath, x.qbit!))
      return m ? rebase(qbitPath, m.qbit!, m.container) : null
    },
    rootFor(containerPath) {
      return byContainer.find((x) => underPrefix(containerPath, x.container)) ?? null
    },
    libraryRoots: () => mappings.filter((m) => m.role === 'library'),
    downloadRoots: () => mappings.filter((m) => m.role === 'download'),
    // Note: like any filesystem check, this is inherently time-of-check-to-time-of-use — a
    // symlink (or the target directory itself) can change immediately after this returns.
    // A caller must not treat a `true` result as a lasting guarantee; it only reflects a single
    // point in time, so re-check immediately before acting on it if the action is destructive.
    isWithinRoot(containerPath, root) {
      const target = resolveReal(containerPath)
      if (target === null) return false // unresolvable / dangling symlink — fail closed
      const base = resolveRootReal(root.container)
      if (base === null) return false
      return target === base || target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
    },
    all: () => mappings,
  }
}

export interface SampledItem { id: string; jfPath: string }

export interface VerifyReport {
  sampled: number
  resolved: number
  failures: Array<{ jellyfinPath: string; reason: string }>
}

export async function verifyMappings(deps: {
  mappings: PathMapping[]
  sampleItems: () => Promise<SampledItem[]>
}): Promise<VerifyReport> {
  const map = createPathMap(deps.mappings)
  const items = await deps.sampleItems()
  const failures: VerifyReport['failures'] = []
  let resolved = 0
  for (const item of items) {
    const container = map.toContainer(item.jfPath)
    if (!container) {
      failures.push({ jellyfinPath: item.jfPath, reason: 'no mapping covers this path' })
      continue
    }
    if (!existsSync(container)) {
      failures.push({ jellyfinPath: item.jfPath, reason: `mapped to ${container} but not found on disk` })
      continue
    }
    resolved += 1
  }
  return { sampled: items.length, resolved, failures }
}

/** At least this many trailing path segments must be corroborated on disk before a candidate
 * directory counts as evidence — a single matching filename is not enough (it could be any file
 * with that name), but a matching directory-plus-filename pair is. */
const MIN_CORROBORATED_SEGMENTS = 2

/**
 * Proposes mappings by taking sampled Jellyfin paths and searching the mounts for a directory
 * whose contents corroborate a suffix of the path. The only floor is
 * `MIN_CORROBORATED_SEGMENTS`: there is deliberately no floor on how many segments remain in the
 * Jellyfin root. A single bind-mounted library — Jellyfin sees `/movies/Heat (1995)/Heat.mkv`
 * with `/movies` itself as the mount, a 1-segment root — is this project's most common real
 * deployment shape (single-bind-mount Docker/Unraid setups); requiring a 2+-segment root would
 * silently propose nothing for it.
 *
 * Because every real ancestor directory of a sampled file trivially corroborates *some* suffix
 * (the whole point of it being a real ancestor), multiple candidate splits are always "valid" in
 * isolation. This resolves the ambiguity by always preferring the DEEPEST (longest) possible
 * Jellyfin root: splits are tried longest-root-first (across every mount and candidate
 * directory) and the first one satisfied wins, so shallower/coarser roots for the same item are
 * never even considered once a deeper one matches.
 *
 * Known limit, by design: a truly flat layout with fewer than `MIN_CORROBORATED_SEGMENTS`
 * segments below the root (e.g. `/movies/Heat.mkv`, where corroboration would rest on the bare
 * filename alone) still proposes nothing — not enough evidence to guess a root from.
 *
 * Proposes nothing when no candidate satisfies the floor — a wrong mapping is far more dangerous
 * than an absent one.
 */
export async function autoDetectMappings(deps: {
  mountRoots: string[]
  sampleItems: () => Promise<SampledItem[]>
  maxDepth?: number
}): Promise<PathMapping[]> {
  const maxDepth = deps.maxDepth ?? 4
  const items = await deps.sampleItems()
  const proposals = new Map<string, PathMapping>()

  for (const item of items) {
    const parts = item.jfPath.split('/').filter(Boolean)
    const maxStart = parts.length - MIN_CORROBORATED_SEGMENTS
    if (maxStart < 1) continue // not enough segments to keep both a root and the corroboration floor

    let found: PathMapping | undefined
    findDeepestRoot: for (let start = maxStart; start >= 1; start -= 1) {
      const suffix = parts.slice(start)
      for (const mount of deps.mountRoots) {
        for (const candidateDir of walkDirs(mount, maxDepth)) {
          const probe = join(candidateDir, ...suffix)
          if (!existsSync(probe)) continue
          found = {
            role: 'library', jellyfin: `/${parts.slice(0, start).join('/')}`, container: candidateDir, qbit: null,
          }
          break findDeepestRoot
        }
      }
    }
    if (found) proposals.set(found.jellyfin!, found)
  }
  return [...proposals.values()]
}

function walkDirs(root: string, maxDepth: number, depth = 0): string[] {
  if (depth > maxDepth || !existsSync(root)) return []
  const out = [root]
  let entries: string[] = []
  try { entries = readdirSync(root) } catch { return out }
  for (const name of entries) {
    if (name.startsWith('.')) continue
    const child = join(root, name)
    try { if (statSync(child).isDirectory()) out.push(...walkDirs(child, maxDepth, depth + 1)) } catch { /* unreadable */ }
  }
  return out
}
