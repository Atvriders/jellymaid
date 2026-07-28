import { statSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from '../index/db.js'
import type { PathMap } from '../fs/pathmap.js'
import type { PathMapping } from '../core/types.js'
import type { QbitClient, Torrent, PrivacySource } from '../connectors/qbittorrent.js'
import type { ArrClient } from '../connectors/arr.js'

export interface TorrentMatch {
  hash: string
  name: string
  category: string | null
  tags: string[]
  state: string
  ratio: number
  seedingTimeSeconds: number
  isPrivate: boolean
  /** Carried through from `Torrent` so a guard can tell a genuine private tracker apart from a
   * privacy signal that could not be determined and was forced to `true` (fail safe). */
  privacySource: PrivacySource
  trackerHost: string | null
  matchedBy: 'inode' | 'path'
}

export interface ArrMatch {
  kind: 'radarr' | 'sonarr'
  instance: string
  remoteId: number
  title: string
  path: string
}

export interface Resolution {
  path: string
  exists: boolean
  sizeBytes: number
  dev: number
  inode: number
  nlink: number
  hardlinks: string[]
  torrents: TorrentMatch[]
  arr: ArrMatch[]
  root: PathMapping | null
  /**
   * Every source this resolution could NOT verify, by label ('qbittorrent', 'radarr', 'sonarr').
   * A source lands here on outright failure (unreachable, threw) AND on a partial result it
   * cannot vouch for as complete (a Sonarr fetch that skipped a series). Downstream guards read
   * this to fail closed: an empty `torrents`/`arr` list must never be trusted as "nothing found"
   * when the source that would have reported it could not be trusted either.
   */
  sourcesUnavailable: string[]
}

export interface ResolveDeps {
  db: Db
  pathMap: PathMap
  /** Mandatory in real config (see `envConfigSchema`); `null` only as a defensive fallback, and
   * treated the same as "unreachable" — never as "no torrents exist". */
  qbittorrent: Pick<QbitClient, 'torrents'> | null
  /** Legitimately absent for an install that does not run Radarr/Sonarr — unlike qBittorrent,
   * `null` here is NOT reported as unavailable, only a failed or incomplete fetch is. */
  radarr: Pick<ArrClient, 'inventory'> | null
  sonarr: Pick<ArrClient, 'inventory'> | null
}

/**
 * The single place that turns a path into the whole truth about it. Everything downstream —
 * guards, dry-run totals, the executor — reads this and nothing else, so there is exactly one
 * definition of "what will deleting this actually touch".
 */
export async function resolveTarget(deps: ResolveDeps, containerPath: string): Promise<Resolution> {
  const sourcesUnavailable: string[] = []

  let dev = 0
  let inode = 0
  let nlink = 0
  let sizeBytes = 0
  let exists = false
  try {
    const st = statSync(containerPath)
    exists = true
    dev = Number(st.dev)
    inode = Number(st.ino)
    nlink = st.nlink
    sizeBytes = st.size
  } catch { /* missing (or unstattable) file: exists stays false */ }

  // (dev, inode) is the correlation key, sourced from THIS live stat, never from a DB row that
  // might itself carry a NULL dev/inode for a file the walker could not stat. The extra
  // `IS NOT NULL` guard below is defense in depth for that invariant: SQL already refuses to
  // match a bound integer against a NULL column, but a NULL row must never even be considered a
  // candidate, so the intent is explicit rather than resting on an implicit NULL-comparison rule.
  const hardlinks = exists && nlink > 1
    ? (deps.db.prepare('SELECT container_path FROM fs_entries WHERE dev IS NOT NULL AND inode IS NOT NULL AND dev = ? AND inode = ?')
        .all(dev, inode) as Array<{ container_path: string }>).map((r) => r.container_path)
    : []
  if (exists && !hardlinks.includes(containerPath)) hardlinks.push(containerPath)

  const inodeSet = new Set(hardlinks)

  let torrents: TorrentMatch[] = []
  if (deps.qbittorrent) {
    try {
      const all = await deps.qbittorrent.torrents()
      torrents = all.flatMap((t) => matchTorrent(t, deps.pathMap, containerPath, inodeSet, dev, inode))
    } catch {
      sourcesUnavailable.push('qbittorrent')
    }
  } else {
    // Mandatory in real config; a missing client is a configuration/wiring failure, not proof
    // there are no torrents. Fails the same way an unreachable client does.
    sourcesUnavailable.push('qbittorrent')
  }

  const arr: ArrMatch[] = []
  for (const [label, client] of [['radarr', deps.radarr], ['sonarr', deps.sonarr]] as const) {
    if (!client) continue // legitimately not configured — never "unavailable"
    try {
      const { records, complete } = await client.inventory()
      // A partial inventory (e.g. a Sonarr series whose per-series fetch was skipped) may still
      // be missing the very record that would prove this file is *arr-managed. An empty result
      // from it must not read as "confirmed not managed" — it reads as "could not verify" — so
      // the source is marked unavailable even though some records DID come back.
      if (!complete) sourcesUnavailable.push(label)
      for (const record of records) {
        const mapped = record.arrPath ? deps.pathMap.toContainer(record.arrPath) ?? record.arrPath : null
        if (mapped && (mapped === containerPath || inodeSet.has(mapped))) {
          arr.push({ kind: record.kind, instance: record.instance, remoteId: record.remoteId, title: record.title, path: mapped })
        }
      }
    } catch {
      sourcesUnavailable.push(label)
    }
  }

  return {
    path: containerPath,
    exists,
    sizeBytes,
    dev,
    inode,
    nlink,
    hardlinks: hardlinks.sort(),
    torrents,
    arr,
    root: deps.pathMap.rootFor(containerPath),
    sourcesUnavailable,
  }
}

function matchTorrent(
  t: Torrent, pathMap: PathMap, target: string, inodeSet: Set<string>, dev: number, inode: number,
): TorrentMatch[] {
  const base = {
    hash: t.hash, name: t.name, category: t.category, tags: t.tags, state: t.state,
    ratio: t.ratio, seedingTimeSeconds: t.seedingTimeSeconds, isPrivate: t.isPrivate,
    privacySource: t.privacySource, trackerHost: t.trackerHost,
  }
  const contentContainer = t.contentPath ? pathMap.qbitToContainer(t.contentPath) : null
  const saveContainer = t.savePath ? pathMap.qbitToContainer(t.savePath) : null

  // Inode is authoritative: the same bytes under a different path string still match. `inode !==
  // 0` excludes the case where the resolved target itself could not be stat'd (dev/inode both
  // default to 0, never a real inode) — without it, two unrelated unstattable paths would look
  // like a match on the sentinel value alone.
  for (const candidate of [contentContainer, saveContainer]) {
    if (!candidate) continue
    if (inodeSet.has(candidate)) return [{ ...base, matchedBy: 'inode' }]
    try {
      const st = statSync(candidate)
      if (Number(st.dev) === dev && Number(st.ino) === inode && inode !== 0) {
        return [{ ...base, matchedBy: 'inode' }]
      }
    } catch { /* not present on disk right now */ }
  }

  if (contentContainer === target) return [{ ...base, matchedBy: 'path' }]
  if (saveContainer && target.startsWith(join(saveContainer, ''))) return [{ ...base, matchedBy: 'path' }]
  return []
}
