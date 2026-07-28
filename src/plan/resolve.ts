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

export interface JellyfinOwnership {
  /** The owning item's id, found in either `jellyfin_items.container_path` (the primary path) or
   * `jellyfin_item_paths.container_path` (an alternate version). `null` when this path belongs to
   * no Jellyfin item at all. */
  itemId: string | null
  /**
   * True when this path is a merged item's ALTERNATE version — present in `jellyfin_item_paths`
   * but not the item's own primary `container_path` — never true for the primary path itself.
   * After a Jellyfin "Merge Versions", the alternate no longer has its own `jellyfin_items` row;
   * it survives only inside the surviving item's MediaSources[]. Deleting it is therefore NOT a
   * normal single-item delete: the executor must refresh (re-scan) the surviving item so Jellyfin
   * drops the now-dead MediaSource reference, rather than deleting `itemId` outright — the
   * surviving item is the version the operator chose to KEEP, and the primary is very often one
   * of `siblingPaths`, so treating this like an ordinary delete would remove the wrong copy's
   * metadata (or none at all, leaving Jellyfin holding a stale reference to deleted bytes).
   */
  isAlternateVersion: boolean
  /** The item's other known container paths (primary and/or alternates), excluding this one. */
  siblingPaths: string[]
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
  jellyfin: JellyfinOwnership
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
        // NULL, never the raw *arr path as a stand-in — same invariant `scan/phases/arr.ts`
        // documents for this same data. A raw, untranslated path can coincidentally collide with
        // a real container path under a DIFFERENT mapping (e.g. the target's own path, if the
        // *arr path happens to equal it as a bare string); treating that collision as a match
        // would flip `monitored: false` on an unrelated title and report a false "arr-managed"
        // hit in the dry run. An unmapped record produces no match at all, not a guess.
        const mapped = record.arrPath ? deps.pathMap.toContainer(record.arrPath) : null
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
    jellyfin: resolveJellyfinOwnership(deps.db, containerPath),
    root: deps.pathMap.rootFor(containerPath),
    sourcesUnavailable,
  }
}

/**
 * Looks the path up in `jellyfin_items.container_path` (the primary path) first, then in
 * `jellyfin_item_paths.container_path` (an alternate version) — the same two-table shape
 * `003_jellyfin_item_paths.sql` introduced so a merged item's alternate is distinguishable from a
 * genuine orphan. Runs regardless of whether the path currently exists on disk: this is Jellyfin's
 * OWN view of ownership, not a filesystem fact.
 */
function resolveJellyfinOwnership(db: Db, containerPath: string): JellyfinOwnership {
  const primary = db.prepare('SELECT id FROM jellyfin_items WHERE container_path = ?').get(containerPath) as
    | { id: string }
    | undefined
  if (primary) {
    const siblings = (db.prepare(
      'SELECT DISTINCT container_path FROM jellyfin_item_paths WHERE item_id = ? AND container_path IS NOT NULL AND container_path != ?',
    ).all(primary.id, containerPath) as Array<{ container_path: string }>).map((r) => r.container_path)
    return { itemId: primary.id, isAlternateVersion: false, siblingPaths: siblings.sort() }
  }

  const alt = db.prepare('SELECT item_id FROM jellyfin_item_paths WHERE container_path = ? LIMIT 1').get(containerPath) as
    | { item_id: string }
    | undefined
  if (!alt) return { itemId: null, isAlternateVersion: false, siblingPaths: [] }

  // Gathered from BOTH tables, not just jellyfin_item_paths: the primary path is expected to also
  // appear there (the jellyfin phase writes every MediaSources[] path, including the primary), but
  // reading it from jellyfin_items directly as well means a sibling is never missed if that ever
  // isn't the case (an older row predating this table, or a source that omitted it).
  const primaryRow = db.prepare('SELECT container_path FROM jellyfin_items WHERE id = ?').get(alt.item_id) as
    | { container_path: string | null }
    | undefined
  const otherRows = (db.prepare(
    'SELECT DISTINCT container_path FROM jellyfin_item_paths WHERE item_id = ? AND container_path IS NOT NULL AND container_path != ?',
  ).all(alt.item_id, containerPath) as Array<{ container_path: string }>).map((r) => r.container_path)

  const siblings = new Set(otherRows)
  if (primaryRow?.container_path && primaryRow.container_path !== containerPath) siblings.add(primaryRow.container_path)

  return { itemId: alt.item_id, isAlternateVersion: true, siblingPaths: [...siblings].sort() }
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
