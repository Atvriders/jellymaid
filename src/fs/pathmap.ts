import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { PathMapping } from '../core/types.js'

const strip = (p: string) => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p)

/**
 * Resolves symlinks when the path exists, so a symlink planted inside a root cannot be used
 * to point back out of it. `resolve()` alone is purely lexical and cannot see symlinks — it
 * would treat `<root>/link -> /etc` as staying under `<root>`. Falls back to lexical `resolve`
 * (still ".."-safe) for paths that do not exist yet.
 */
function resolveReal(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
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
    isWithinRoot(containerPath, root) {
      const target = resolveReal(containerPath)
      const base = resolveReal(root.container)
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

/**
 * Proposes mappings by taking sampled Jellyfin paths and searching the mounts for a
 * directory whose contents corroborate a suffix of the path. Two floors keep a lone
 * coincidence from becoming a proposal:
 *  - the Jellyfin root must keep at least two path segments (e.g. `/media/Movies`), so
 *    we never propose a bare mount point like `/media`, which could span several
 *    unrelated libraries with different real mappings;
 *  - at least two trailing segments must be corroborated on disk, so a lone matching
 *    filename (or a movie's own item folder) is never mistaken for a library root.
 * The first candidate directory that satisfies both floors wins; nothing else is tried
 * for that item. Proposes nothing when no candidate satisfies both — a wrong mapping is
 * far more dangerous than an absent one.
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
    const minStart = 2
    const maxStart = parts.length - 2
    if (minStart > maxStart) continue

    let found: PathMapping | undefined
    for (const mount of deps.mountRoots) {
      for (const candidateDir of walkDirs(mount, maxDepth)) {
        // Prefer the longest corroborated suffix (smallest start) within the allowed range.
        for (let start = minStart; start <= maxStart; start += 1) {
          const suffix = parts.slice(start)
          const probe = join(candidateDir, ...suffix)
          if (!existsSync(probe)) continue
          found = {
            role: 'library', jellyfin: `/${parts.slice(0, start).join('/')}`, container: candidateDir, qbit: null,
          }
          break
        }
        if (found) break
      }
      if (found) break
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
