import { statSync } from 'node:fs'
import { join, sep } from 'node:path'
import type { Db } from '../index/db.js'
import type { PathMap } from '../fs/pathmap.js'
import type { PathMapping } from '../core/types.js'
import type { QbitClient, Torrent, PrivacySource } from '../connectors/qbittorrent.js'
import type { ArrClient, ArrInventory } from '../connectors/arr.js'

/** How many unmappable *arr paths to carry as examples; the count is always exact. */
const UNMAPPABLE_SAMPLES = 5

export interface TorrentFileSet {
  /**
   * How many files the torrent owns IN TOTAL, including any whose path no mapping covers.
   * Understating this is what would let "remove the torrent with its data" quietly take files
   * nobody counted, so the count comes from the file list itself, never from `paths.length`.
   */
  count: number
  /** Container paths for the files that could be mapped; never longer than `count`. */
  paths: string[]
}

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
  /**
   * How this torrent was tied to the target, weakest last:
   *  - 'inode' — the same bytes, whatever the paths say. Authoritative.
   *  - 'file'  — the target is literally one of the torrent's files, per the file list.
   *  - 'path'  — no file list could RULE THE TARGET OUT, so containment under the torrent's own
   *    content path is the only evidence left. That covers three cases, not just the first: the
   *    list could not be read at all; it was read but is incomplete (it counts more files than it
   *    can name, because some path no mapping covers); or the only complete list available came
   *    from the INDEX — a scan-time claim about a torrent that may have been moved since — and
   *    qBittorrent could not be reached to confirm it live. See `matchTorrent`: only a complete,
   *    live-confirmed list ends the search with "not this torrent's file". qBittorrent reports
   *    `content_path === save_path` for a multi-file torrent with no common root folder, which
   *    makes containment a bare directory prefix, so this is a fallback and is labelled as one.
   */
  matchedBy: 'inode' | 'file' | 'path'
  /** Every file this torrent owns, or null when the list could not be read at all. */
  files: TorrentFileSet | null
}

export interface ArrMatch {
  kind: 'radarr' | 'sonarr'
  instance: string
  remoteId: number
  title: string
  /** The container path this record resolves to — the path Jellymaid would delete. */
  path: string
  /**
   * The path EXACTLY as the *arr itself reported it, before the path map translated it. Both
   * connectors' `unmonitorByPath` match on this string (`x.rec.arrPath === path`), and the two
   * namespaces routinely differ — Radarr says `/movies/Heat.mkv`, the container sees
   * `/mnt/media/movies/Heat.mkv`. Handing the container path to `unmonitorByPath` would find no
   * record, return `not-managed`, and read as "nothing to unmonitor" for a file that is very much
   * monitored: the file gets deleted and the *arr re-grabs it. Carried verbatim rather than
   * reversed through the path map, because `fromContainer` can legitimately pick a different
   * mapping than `toContainer` came in on when two mappings share a container root.
   */
  arrPath: string
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
  /** A directory, so link counts and byte totals do not mean what they mean for a file. */
  isDirectory: boolean
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
  /**
   * *arr records whose reported path NO mapping could translate. `PathMapping` has no *arr field —
   * *arr paths are translated through the Jellyfin prefix — so an *arr whose namespace the operator
   * never mapped produces no `ArrMatch` for anything, while `complete` stays true. Without this
   * count, "absent from a complete inventory" reads as "genuinely not managed", the unmonitor step
   * never runs, and the *arr re-grabs what was just deleted. Counted globally rather than per
   * target for exactly that reason: the record that would have named THIS file is precisely the one
   * that could not be translated, so there is nothing target-specific left to look at.
   */
  arrUnmappable: { count: number; samples: string[] }
}

export interface ResolveDeps {
  db: Db
  pathMap: PathMap
  /** Mandatory in real config (see `envConfigSchema`); `null` only as a defensive fallback, and
   * treated the same as "unreachable" — never as "no torrents exist". `files` is what proves which
   * files a torrent actually owns; without it every scope decision falls back to path shape. */
  qbittorrent: (Pick<QbitClient, 'torrents'> & Partial<Pick<QbitClient, 'files'>>) | null
  /** Legitimately absent for an install that does not run Radarr/Sonarr — unlike qBittorrent,
   * `null` here is NOT reported as unavailable, only a failed or incomplete fetch is. */
  radarr: Pick<ArrClient, 'inventory'> | null
  sonarr: Pick<ArrClient, 'inventory'> | null
}

/** How long one plan run may reuse a single *arr inventory read. See `snapshotInventory`. */
export const INVENTORY_TTL_MS = 30_000

/**
 * Wraps an *arr client so that `inventory()` is fetched once and reused for a short window,
 * leaving every other method untouched.
 *
 * `resolveTarget` reads the whole inventory for EVERY action, and Sonarr's inventory costs 1 + 2N
 * requests for N series — a 20-action plan against a 500-series library is tens of thousands of
 * throttled calls, made while the executor holds both its locks. One snapshot per plan run answers
 * the same question at 1/N the cost.
 *
 * Deliberately NOT applied to `unmonitorByPath`: that call re-reads the record it is about to PUT
 * back, so serving it from a snapshot would write a stale document over whatever the operator (or
 * the *arr itself) changed in between. Nor to the qBittorrent torrent list, whose state is the
 * thing the guards most need fresh. A rejected fetch is never cached — an outage must be re-tried,
 * not remembered for the rest of the window.
 */
export function snapshotInventory<T extends { inventory: () => Promise<ArrInventory> }>(
  client: T | null,
  ttlMs: number = INVENTORY_TTL_MS,
): T | null {
  if (!client) return null
  let pending: Promise<ArrInventory> | null = null
  let fetchedAt = 0
  return {
    ...client,
    inventory: () => {
      if (!pending || Date.now() - fetchedAt >= ttlMs) {
        fetchedAt = Date.now()
        pending = client.inventory().catch((err: unknown) => {
          pending = null
          throw err
        })
      }
      return pending
    },
  }
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
  let isDirectory = false
  try {
    const st = statSync(containerPath)
    exists = true
    isDirectory = st.isDirectory()
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

  // The hashes the INDEX says own these exact bytes — by path (including every known hardlink) and
  // by inode. Two indexed lookups for the whole torrent list, rather than a file-list fetch per
  // torrent, which on a real client would be thousands of calls per action.
  const ownedHashes = new Set<string>()
  if (exists) {
    const paths = [...inodeSet]
    const placeholders = paths.map(() => '?').join(',')
    for (const row of deps.db.prepare(
      `SELECT DISTINCT hash FROM torrent_files WHERE container_path IN (${placeholders})`,
    ).all(...paths) as Array<{ hash: string }>) ownedHashes.add(row.hash)
    if (inode !== 0) {
      for (const row of deps.db.prepare(
        'SELECT DISTINCT hash FROM torrent_files WHERE dev IS NOT NULL AND inode IS NOT NULL AND dev = ? AND inode = ?',
      ).all(dev, inode) as Array<{ hash: string }>) ownedHashes.add(row.hash)
    }
  }

  let torrents: TorrentMatch[] = []
  if (deps.qbittorrent) {
    try {
      const all = await deps.qbittorrent.torrents()
      const liveSets = new Map<string, TorrentFileSet | null>()
      const liveFileSetFor = async (t: Torrent): Promise<TorrentFileSet | null> => {
        const cached = liveSets.get(t.hash)
        if (cached !== undefined) return cached
        const fresh = await liveFileSet(deps, t)
        liveSets.set(t.hash, fresh)
        return fresh
      }
      const fileSets = new Map<string, LoadedFileSet>()
      const fileSetFor = async (t: Torrent): Promise<LoadedFileSet> => {
        const cached = fileSets.get(t.hash)
        if (cached !== undefined) return cached
        const resolved = await loadFileSet(deps, t, liveFileSetFor)
        fileSets.set(t.hash, resolved)
        return resolved
      }
      torrents = []
      for (const t of all) {
        const match = await matchTorrent(
          t, deps.pathMap, containerPath, inodeSet, dev, inode, ownedHashes, fileSetFor, liveFileSetFor,
        )
        if (match) torrents.push(match)
      }
    } catch {
      sourcesUnavailable.push('qbittorrent')
    }
  } else {
    // Mandatory in real config; a missing client is a configuration/wiring failure, not proof
    // there are no torrents. Fails the same way an unreachable client does.
    sourcesUnavailable.push('qbittorrent')
  }

  const arr: ArrMatch[] = []
  const unmappableArrPaths: string[] = []
  let unmappableArrCount = 0
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
        // A record with a path that no mapping covers is not evidence of anything, in either
        // direction — it is a hole in the path map, and it is counted rather than shrugged off.
        // A record with no path at all is a different thing (the *arr has nothing on disk for it)
        // and is not counted.
        if (record.arrPath && !mapped) {
          unmappableArrCount += 1
          if (unmappableArrPaths.length < UNMAPPABLE_SAMPLES) unmappableArrPaths.push(record.arrPath)
        }
        if (mapped && record.arrPath && (mapped === containerPath || inodeSet.has(mapped))) {
          arr.push({
            kind: record.kind, instance: record.instance, remoteId: record.remoteId,
            title: record.title, path: mapped, arrPath: record.arrPath,
          })
        }
      }
    } catch {
      sourcesUnavailable.push(label)
    }
  }

  return {
    path: containerPath,
    exists,
    isDirectory,
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
    arrUnmappable: { count: unmappableArrCount, samples: unmappableArrPaths },
  }
}

/**
 * A file list may only be used to prove a torrent does NOT own a path when it is complete: every
 * file it counts is a file it can name. `paths` holds only the MAPPABLE subset, so a shorter
 * `paths` than `count` means the list cannot answer the question — and a `count` of zero is
 * qBittorrent saying nothing at all, not saying "no files".
 */
const isCompleteFileSet = (s: TorrentFileSet | null): s is TorrentFileSet =>
  s !== null && s.count > 0 && s.paths.length === s.count

type FileSetSource = 'index' | 'live' | 'none'
interface LoadedFileSet { set: TorrentFileSet | null; source: FileSetSource }

/** The torrent's files exactly as the last scan translated them; null when it indexed none. */
function indexedFileSet(deps: ResolveDeps, hash: string): TorrentFileSet | null {
  const rows = deps.db.prepare('SELECT container_path FROM torrent_files WHERE hash = ?')
    .all(hash) as Array<{ container_path: string | null }>
  if (rows.length === 0) return null
  // `count` is rows.length, not the mapped subset: a file whose path no mapping covers is still a
  // file that "delete with data" would take, and it must not shrink the total.
  return { count: rows.length, paths: rows.map((r) => r.container_path).filter((p): p is string => p !== null) }
}

/** The torrent's files as qBittorrent reports them right now; null when it could not be asked. */
async function liveFileSet(deps: ResolveDeps, t: Torrent): Promise<TorrentFileSet | null> {
  if (!deps.qbittorrent?.files) return null
  try {
    const list = await deps.qbittorrent.files(t.hash)
    // Same translation the scan phase performs: file names are relative to the torrent's savePath.
    // An unmappable savePath yields no paths at all, which `isCompleteFileSet` then refuses to
    // treat as an answer rather than reading it as "owns nothing".
    const base = t.savePath ? deps.pathMap.qbitToContainer(t.savePath) : null
    return { count: list.length, paths: base ? list.map((f) => join(base, f.relPath)) : [] }
  } catch {
    return null
  }
}

/**
 * The best file list available for a torrent: the index first (already translated by the scan
 * phase, no network), a live fetch when the indexed one cannot answer. Whichever is returned, the
 * `source` says where it came from, because "the index does not name this file" is a scan-time
 * claim that deserves a second opinion and "qBittorrent does not name this file" is not.
 */
async function loadFileSet(
  deps: ResolveDeps, t: Torrent, live: (t: Torrent) => Promise<TorrentFileSet | null>,
): Promise<LoadedFileSet> {
  const indexed = indexedFileSet(deps, t.hash)
  if (isCompleteFileSet(indexed)) return { set: indexed, source: 'index' }
  const fresh = await live(t)
  if (isCompleteFileSet(fresh)) return { set: fresh, source: 'live' }
  // Neither can answer. Whatever partial list exists is still worth carrying as evidence — the
  // count feeds `guard.torrent-scope` — but nothing derived from it is authoritative.
  if (indexed) return { set: indexed, source: 'index' }
  return { set: fresh, source: fresh ? 'live' : 'none' }
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

async function matchTorrent(
  t: Torrent, pathMap: PathMap, target: string, inodeSet: Set<string>, dev: number, inode: number,
  ownedHashes: Set<string>,
  fileSetFor: (t: Torrent) => Promise<LoadedFileSet>,
  liveFileSetFor: (t: Torrent) => Promise<TorrentFileSet | null>,
): Promise<TorrentMatch | null> {
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
    if (inodeSet.has(candidate)) return { ...base, matchedBy: 'inode', files: (await fileSetFor(t)).set }
    try {
      const st = statSync(candidate)
      if (Number(st.dev) === dev && Number(st.ino) === inode && inode !== 0) {
        return { ...base, matchedBy: 'inode', files: (await fileSetFor(t)).set }
      }
    } catch { /* not present on disk right now */ }
  }

  // The torrent's own file list, per the index: it names the files this torrent owns, which is the
  // question — not what the paths happen to look like.
  if (ownedHashes.has(t.hash)) return { ...base, matchedBy: 'file', files: (await fileSetFor(t)).set }

  // Containment is the LAST resort, and only when there is no file list to consult. `contentPath`
  // looks authoritative but is not: qBittorrent reports `content_path === save_path` for a
  // multi-file torrent with no single common root folder, at which point containment is a bare
  // directory prefix and every unrelated file in that directory resolves to this torrent — which
  // the executor removes WITH ITS DATA. The separator is explicit for the same reason
  // `isWithinRoot` insists on one: a plain `startsWith` makes `/downloads/heat-extras.mkv` look
  // like it lives inside `/downloads/heat`.
  const contained = contentContainer
    ? target === contentContainer || target.startsWith(`${contentContainer}${sep}`)
    // `savePath` alone is only the DIRECTORY the torrent was saved into, which every torrent saved
    // beside it shares; it stands in only for a torrent whose contentPath is missing or unmappable.
    : Boolean(saveContainer && target.startsWith(`${saveContainer}${sep}`))
  if (!contained) return null

  const loaded = await fileSetFor(t)
  if (loaded.set?.paths.includes(target)) return { ...base, matchedBy: 'file', files: loaded.set }

  // The list in hand does not name the target — which only means "not this torrent's file" if the
  // list could name every file it counts. An INCOMPLETE list names none of the files whose paths no
  // mapping covered (the qBittorrent phase writes NULL container_path for a torrent whose savePath
  // did not map, and their NULL dev/inode keeps the inode join from rescuing them either), and an
  // indexed list is in any case a scan-time claim about a torrent that may have been moved since.
  // Getting this wrong in this direction is the expensive one: an over-match is caught by
  // `guard.torrent-scope`, while a miss unlinks a file qBittorrent is actively seeding with no
  // guard in the chain ever running. So only a complete, LIVE-confirmed list ends it here.
  let authoritative = loaded.source === 'live' && isCompleteFileSet(loaded.set)
  if (loaded.source === 'index') {
    const fresh = await liveFileSetFor(t)
    if (fresh?.paths.includes(target)) return { ...base, matchedBy: 'file', files: fresh }
    if (isCompleteFileSet(fresh)) authoritative = true
  }
  if (authoritative) return null
  return { ...base, matchedBy: 'path', files: loaded.set }
}
