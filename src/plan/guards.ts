import type { GuardId, GuardVerdict, TorrentRef } from '../core/types.js'
import type { FileConfig } from '../config/schema.js'
import { companionFlags } from '../core/companions.js'
import type { Resolution } from './resolve.js'

// A torrent in any of these states is mid-operation: qBittorrent is actively reading or writing
// its files (or about to). Removing the underlying bytes out from under that operation can corrupt
// the torrent's on-disk state or crash the client, so these always block regardless of privacy,
// ratio, or category — the same reasoning `guard.protected`'s config-driven categories/tags apply,
// just derived from live state instead of operator configuration.
const BUSY_STATES = new Set([
  'downloading', 'metaDL', 'stalledDL', 'checkingDL', 'checkingUP', 'checkingResumeData',
  'allocating', 'moving', 'forcedDL',
  // Not a real qBittorrent state — the connector's own fallback (`t.state ?? 'unknown'`) when a
  // torrent's state field is missing or unparseable (API version skew, malformed response). An
  // unrecognized value must not silently read as "not busy": the same "unknown state fails closed"
  // reasoning the global constraints apply to source-unavailability applies here one level down,
  // to a single torrent whose own reported state IS the unknown.
  'unknown',
])

const pass = (guard: GuardId, reason: string, evidence: Record<string, unknown> = {}): GuardVerdict =>
  ({ guard, outcome: 'pass', overridable: false, reason, evidence })

export interface GuardContext {
  /**
   * Every container path the plan will remove. `guard.torrent-scope` needs it to answer "would
   * removing this torrent take files nobody named?", and only the plan knows the answer. Defaults
   * to the target alone, which is the honest reading of a lone action.
   */
  plannedPaths?: Iterable<string>
  /**
   * Whether this action removes matched torrents WITH THEIR DATA. False for `remove-empty-folder`,
   * which only ever calls `rmdir` — an empty directory holds no torrent data by definition, so
   * blocking its cleanup with "this would also delete 11 files" would be both wrong and the kind of
   * noise that teaches operators to override on reflex. The other three torrent guards still apply.
   */
  removesTorrentData?: boolean
  /**
   * Executor only: the files of torrents THIS RUN has already removed with their data, by container
   * path, each with the identity its bytes had just before the removal. See `untracked`.
   */
  removedThisRun?: ReadonlyMap<string, RemovedTorrentFile>
}

/** A file of a torrent the current run removed with its data, as it stood just before the removal. */
export interface RemovedTorrentFile {
  /** The removed torrents that owned it, each with the instance it was removed from. */
  torrents: TorrentRef[]
  /** Its bytes just before the removal; null when nothing was there to remove. */
  identity: { dev: number; inode: number; sizeBytes: number } | null
}

/**
 * Runs all six safety guards over a resolved target. Guards are pure functions of `Resolution`,
 * `FileConfig` and the plan's own scope — no I/O, no network — so every branch here is
 * exhaustively testable, which matters because the caller treats a passing guard set as license to
 * permanently delete bytes or remove a torrent with its data.
 */
export function evaluateGuards(r: Resolution, config: FileConfig, context: GuardContext = {}): GuardVerdict[] {
  return [
    privateRatio(r, config), crossSeed(r), hardlink(r), protectedState(r, config), torrentScope(r, config, context),
    untracked(r, context),
  ]
}

/**
 * `guard.untracked` — a file under a torrent-backed root that no torrent owns. Nothing in the plan
 * would remove it except a raw unlink, in a root an instance saves its torrents straight into. Either
 * it is a leftover (a torrent removed without its data, a stray copy), or a torrent IS seeding it and
 * nothing tied the two together — a mapping that translates the instance's paths wrongly, an index
 * written before the torrent was added. The second is the anti-goal "a raw unlink of a file a torrent
 * is seeding", so the guard blocks, and its override says in so many words "this is a leftover;
 * delete it from disk".
 *
 * It answers only for a root with a known instance that was actually asked. A root with no
 * determinable instance, or an instance that could not be reached, is `guard.protected`'s to block —
 * without an override — and an overridable block beside it would only invite an override that
 * cannot clear anything. A path that is already gone, or a directory, is no file to unlink.
 *
 * One case is no hole at all: the torrent that owned the file was removed WITH ITS DATA a moment ago,
 * by an earlier action of this same run. qBittorrent answers torrents/delete before its files are
 * gone, so the next episode of a fully queued pack can still be on disk when its own action re-reads
 * the list — which no longer has the torrent. That file is the rest of a delete the operator approved
 * and this run started; blocking it would leave it to vanish anyway, unrecorded and never reported to
 * Jellyfin. It passes only while the bytes there are the very bytes that torrent owned (`identity`,
 * taken just before the removal): anything written at the path since is judged like any other file.
 */
function untracked(r: Resolution, context: GuardContext): GuardVerdict {
  const source = r.torrentSource
  if (source.kind === 'none') return pass('guard.untracked', 'this root is not torrent-backed')
  if (source.kind === 'unknown') {
    return pass('guard.untracked', 'no qBittorrent instance can be determined here; guard.protected answers for that')
  }
  if (r.sourcesUnavailable.includes(`qbittorrent:${source.instanceId}`)) {
    return pass('guard.untracked', `qBittorrent instance ${source.instanceId} could not be asked; guard.protected answers for that`)
  }
  if (!r.exists || r.isDirectory) return pass('guard.untracked', 'no file here for a raw unlink to remove')
  if (r.torrents.length > 0) return pass('guard.untracked', 'a torrent owns this file')
  const removed = context.removedThisRun?.get(r.path)
  if (removed?.identity && removed.identity.dev === r.dev && removed.identity.inode === r.inode
    && removed.identity.sizeBytes === r.sizeBytes) {
    return pass(
      'guard.untracked',
      `the torrent that owned this file (${removed.torrents.map((t) => `${t.hash} on ${t.instanceId}`).join(', ')}) was `
        + 'removed with its data earlier in this run; qBittorrent is still deleting it',
      { removedTorrents: removed.torrents },
    )
  }
  return {
    guard: 'guard.untracked',
    outcome: 'block',
    overridable: true,
    reason: `${r.path} lies under a root qBittorrent instance ${source.instanceId} saves torrents into, but no torrent `
      + `on ${source.instanceId} owns it, so only a raw unlink would remove it. Override only if it is a leftover to `
      + 'delete from disk; if a torrent should own it, fix the path mapping and verify it instead',
    evidence: { instanceId: source.instanceId, root: r.root?.container ?? null },
  }
}

/** 'qbittorrent' (no instance could be determined) or 'qbittorrent:<id>' (that instance failed). */
const isQbitLabel = (s: string) => s === 'qbittorrent' || s.startsWith('qbittorrent:')

/**
 * Private trackers enforce ratio and seed-time rules that Jellymaid cannot see or negotiate with;
 * deleting the data out from under a private torrent that hasn't met them can get the operator's
 * account banned. Public torrents carry no such obligation, so they are exempt regardless of ratio.
 * Overridable: the operator may know better (e.g. an account they're abandoning anyway).
 */
function privateRatio(r: Resolution, config: FileConfig): GuardVerdict {
  const minSeedSeconds = config.guards.minSeedTimeDays * 86_400
  const offenders = r.torrents.filter(
    (t) => t.isPrivate && (t.ratio < config.guards.minRatio || t.seedingTimeSeconds < minSeedSeconds),
  )
  if (!offenders.length) {
    return pass('guard.private-ratio', 'no private torrent is below its seeding minimums')
  }
  const detail = offenders.map((t) => ({
    instanceId: t.instanceId, hash: t.hash, name: t.name, ratio: t.ratio,
    seedingDays: Number((t.seedingTimeSeconds / 86_400).toFixed(1)),
    trackerHost: t.trackerHost,
    // Surfaced so an operator can tell "this really is a private tracker" from "qBittorrent did
    // not report privacy, so Jellymaid assumed the worst" (see `PrivacySource` in
    // connectors/qbittorrent.ts). The latter is fixed by listing the tracker in
    // privateTrackerHosts or upgrading qBittorrent, not by overriding this guard.
    privacySource: t.privacySource,
  }))
  const reasons: string[] = []
  if (offenders.some((t) => t.ratio < config.guards.minRatio)) reasons.push(`ratio below ${config.guards.minRatio}`)
  if (offenders.some((t) => t.seedingTimeSeconds < minSeedSeconds)) reasons.push(`seed time below ${config.guards.minSeedTimeDays} days`)
  return {
    guard: 'guard.private-ratio',
    outcome: 'block',
    overridable: true,
    reason: `private tracker torrent with ${reasons.join(' and ')}`,
    evidence: { offenders: detail, minRatio: config.guards.minRatio, minSeedTimeDays: config.guards.minSeedTimeDays },
  }
}

/**
 * More than one torrent backing the same bytes (cross-seeded) means removing one torrent WITH
 * its data breaks every other torrent pointed at the same file. Overridable: an operator who
 * intends to drop all of them, or who accepts breaking the others, may proceed.
 */
function crossSeed(r: Resolution): GuardVerdict {
  if (r.torrents.length < 2) return pass('guard.cross-seed', 'at most one torrent backs this file')
  return {
    guard: 'guard.cross-seed',
    outcome: 'block',
    overridable: true,
    reason: `${r.torrents.length} torrents share these bytes; removing one with data breaks the others`,
    evidence: {
      hashes: r.torrents.map((t) => t.hash).sort(),
      names: r.torrents.map((t) => t.name),
      // The same infohash on two boxes is two torrents: a hash alone cannot say which box to look at.
      torrents: r.torrents.map((t) => ({ instanceId: t.instanceId, hash: t.hash, name: t.name })),
    },
  }
}

/**
 * A hardlinked file's bytes are not freed until every link is gone. This is informational, not a
 * safety concern for THIS path's own deletion — the file being deleted is still removed correctly
 * — so it warns rather than blocking, but it must never overstate what space comes back: reporting
 * `sizeBytes` as reclaimed while other links survive would be a lie the trash-accounting math
 * would repeat every time this guard fires.
 */
function hardlink(r: Resolution): GuardVerdict {
  // Every directory has nlink >= 2 (its own entry plus `.`, and one more per subdirectory), which
  // is not two links to any bytes. Reporting it as one would put "2 links point at these bytes" in
  // the audit trail of every empty-folder removal.
  if (r.isDirectory) {
    return pass('guard.hardlink', 'target is a directory; its link count does not describe reclaimable bytes', {
      bytesReclaimed: 0, otherLinks: [], nlink: r.nlink,
    })
  }
  const others = r.hardlinks.filter((p) => p !== r.path)
  // `nlink` is the authoritative live-stat fact; `hardlinks` is only as complete as the last scan's
  // fs_entries index. The two can disagree: a sibling link created (or living under a root not yet
  // scanned) since the last index means nlink says 2 while the index can only name this one path.
  // The pass branch must key off `nlink` alone — falling through to "single link" just because
  // `others` happens to be empty would report a full-size reclaim for a file that provably still
  // has another link on disk right now.
  if (r.nlink <= 1) {
    return pass('guard.hardlink', 'file has a single link', { bytesReclaimed: r.sizeBytes, otherLinks: [] })
  }
  const unresolvedLinks = Math.max(0, r.nlink - 1 - others.length)
  return {
    guard: 'guard.hardlink',
    outcome: 'warn',
    overridable: false,
    reason: unresolvedLinks > 0
      ? `${r.nlink} links point at these bytes; only ${others.length} of ${r.nlink - 1} other link(s) are indexed — removing this path frees nothing`
      : `${r.nlink} links point at these bytes; removing only this path frees nothing`,
    // Space is reclaimed only when the last link goes, so the honest number here is zero.
    evidence: { otherLinks: others, nlink: r.nlink, bytesReclaimed: 0, bytesIfAllLinksRemoved: r.sizeBytes, unresolvedLinks },
  }
}

/**
 * The one guard with no override, by design: a torrent mid-operation, in an operator-designated
 * protected category/tag, or whose true state cannot even be determined must never be actioned no
 * matter what the operator claims to know. `sourcesUnavailable` is the fail-closed path for BOTH
 * halves of that "true state":
 *
 *  - 'qbittorrent' / 'qbittorrent:<id>' unavailable: an empty `torrents` array is NOT evidence of
 *    "no torrents", it is evidence of "unknown", and unknown is never a safe state to delete from.
 *    That holds per instance: one box being unreachable means its torrents are unknown, whatever
 *    the other box reported.
 *  - 'radarr'/'sonarr' unavailable (a partial inventory — see `resolveTarget`'s `complete: false`
 *    handling): an empty/incomplete `arr` array is likewise NOT evidence of "not *arr-managed". The
 *    real executor unmonitors via *arr before deleting BY ITERATING `resolution.arr` — if the
 *    record that would prove this file is monitored fell in the unread part of the fetch, `arr` is
 *    silently missing it, the unmonitor step never runs, and the *arr re-grabs what was just
 *    deleted. That is invisible to the operator unless something blocks BEFORE approval — which is
 *    exactly what this guard, and only this guard, already does for qBittorrent.
 *
 * Configured-but-unreachable and simply-not-configured are different states, on purpose: a `null`
 * radarr/sonarr client is a legitimate "not used" and `resolveTarget` never reports it as
 * unavailable (see `tests/plan/resolve.test.ts`, "does not flag radarr/sonarr unavailable when both
 * are simply unconfigured"), so an operator with no *arr integration at all is never blocked by
 * this branch.
 */
function protectedState(r: Resolution, config: FileConfig): GuardVerdict {
  const unverifiable = r.sourcesUnavailable.filter((s) => isQbitLabel(s) || s === 'radarr' || s === 'sonarr')
  if (unverifiable.length || r.arrUnmappable.count > 0) {
    const parts: string[] = []
    if (r.arrUnmappable.count > 0) {
      // The same fail-closed reasoning as a partial inventory, one layer earlier: the inventory
      // arrived complete, but its paths live in a namespace no path mapping covers, so no record
      // could ever match this file and "absent" cannot be read as "not managed".
      //
      // This blocks the whole install on a single record, with no override, so the reason has to
      // carry its own remedy — and the remedy is genuinely non-obvious. *arr paths are translated
      // through the JELLYFIN prefix of a `PathMapping` (there is no *arr field on it today), so
      // "add a mapping" means adding one whose `jellyfin` prefix is really the *arr's prefix.
      // Radarr also reports the movie FOLDER for a movie that has no file yet, so one decommissioned
      // or second root folder is enough to wedge every delete until a mapping covers it.
      parts.push(
        `${r.arrUnmappable.count} *arr record(s) report paths that no path mapping can translate `
        + `(e.g. ${r.arrUnmappable.samples.join(', ')}). Add a path mapping whose jellyfin prefix covers that `
        + '*arr namespace — *arr paths are translated through the jellyfin prefix — and re-scan. Until then '
        + 'Jellymaid cannot confirm whether this file is *arr-managed and cannot guarantee it will be '
        + 'unmonitored before deletion',
      )
    }
    if (unverifiable.includes('qbittorrent')) {
      // No instance can be determined: a root with a qbit prefix and no instance. Without the
      // mapping's own words the operator cannot tell which row to fix.
      parts.push(r.torrentSource.kind === 'unknown'
        ? `qBittorrent is unavailable for this path: no instance can be determined (${r.torrentSource.reason}), `
          + 'so torrent state cannot be verified; set the qBittorrent instance on that path mapping and verify it'
        : 'qBittorrent is unavailable for a root these bytes lie under: no instance can be determined for it, so '
          + 'torrent state cannot be verified')
    }
    const instances = unverifiable.filter((s) => s.startsWith('qbittorrent:')).map((s) => s.slice('qbittorrent:'.length))
    if (instances.length) {
      parts.push(
        `qBittorrent instance${instances.length > 1 ? 's' : ''} ${instances.join(', ')} `
        + `${instances.length > 1 ? 'are' : 'is'} unavailable (unreachable, or not configured), so torrent state cannot be verified`,
      )
    }
    const arrUnavailable = unverifiable.filter((s) => s === 'radarr' || s === 'sonarr')
    if (arrUnavailable.length) {
      parts.push(
        `${arrUnavailable.join(' and ')} could not be verified, so Jellymaid cannot confirm whether this file is `
        + '*arr-managed and cannot guarantee it will be unmonitored before deletion',
      )
    }
    return {
      guard: 'guard.protected',
      outcome: 'block',
      overridable: false,
      reason: parts.join('; '),
      evidence: { sourcesUnavailable: r.sourcesUnavailable, arrUnmappable: r.arrUnmappable },
    }
  }
  const categories = new Set(config.guards.protectedCategories.map((c) => c.toLowerCase()))
  const tags = new Set(config.guards.protectedTags.map((t) => t.toLowerCase()))
  const offenders: Array<{ instanceId: string; hash: string; why: string }> = []
  for (const t of r.torrents) {
    const at = { instanceId: t.instanceId, hash: t.hash }
    if (BUSY_STATES.has(t.state)) offenders.push({ ...at, why: `state ${t.state}` })
    else if (t.category && categories.has(t.category.toLowerCase())) offenders.push({ ...at, why: `protected category ${t.category}` })
    else {
      const tag = t.tags.find((x) => tags.has(x.toLowerCase()))
      if (tag) offenders.push({ ...at, why: `protected tag ${tag}` })
    }
  }
  if (!offenders.length) return pass('guard.protected', 'no torrent is busy or protected')
  return {
    guard: 'guard.protected',
    outcome: 'block',
    overridable: false,
    reason: offenders.map((o) => o.why).join('; '),
    evidence: { offenders },
  }
}

/**
 * Removing a torrent takes ALL of its data, not just the file that was named. `delete-junk-file`
 * makes that concrete: a `sample.mkv` inside a season pack resolves to the pack's torrent, and step
 * 2 of the executor removes it with data — every episode beside it goes too, with nothing in the
 * dry run saying so (`torrentsRemoved: 1` is technically true and completely uninformative).
 *
 * No other guard covers it: cross-seed needs a SECOND torrent, private-ratio needs a private
 * tracker, protected needs a busy state or a protect-list hit. So this one does, and it blocks
 * OVERRIDABLY — the operator chose "remove the torrent with its data" on the assumption that one
 * torrent backs one file, and when that does not hold only they can decide whether the pack goes.
 *
 * An unreadable file list blocks too. "How many other files would this take" is unanswerable then,
 * and unanswerable is not permission — the same fail-closed rule `guard.protected` applies to an
 * unverifiable source.
 *
 * Companion files do not count (`companionFlags`). The owner's torrents are saved straight into the
 * library, so every film arrives with its .nfo, subtitles and sample, and a scope rule that counted
 * those blocked nearly every delete — the reflexive-override habit this guard must not teach. A
 * film's own sidecars going with it is what "remove the torrent with its data" means. Only MEDIA the
 * plan does not name blocks: the other episodes of a pack, or a film whose name merely looks like a
 * sample (Ruling 11 keeps a media-sized "sample" on the media side).
 */
function torrentScope(r: Resolution, config: FileConfig, context: GuardContext): GuardVerdict {
  if (context.removesTorrentData === false) {
    return pass('guard.torrent-scope', 'this action does not remove any torrent, so no other file can go with it')
  }
  // A torrent file that is a HARDLINK of a path this plan removes is not a file the plan overlooked
  // — it is the same bytes under another name, which is the standard *arr layout: the torrent owns
  // /downloads/Heat.mkv, the library holds /media/Heat.mkv, one inode. Counting those as
  // "untargeted" would block essentially every hardlinked delete this product exists to perform.
  const planned = new Set([...(context.plannedPaths ?? [r.path]), r.path, ...r.hardlinks])
  const offenders: Array<Record<string, unknown>> = []
  let companionsAlong = 0
  for (const t of r.torrents) {
    // No list, or a list of nothing. A `files()` that returns [] is qBittorrent declining to say
    // (most often a hash it no longer has), never a torrent that owns zero files — and reading it
    // as zero makes `filesNotInPlan` zero, which would pass the guard and remove the torrent with
    // its data on the strength of an empty answer.
    if (!t.files || t.files.count === 0) {
      offenders.push({
        instanceId: t.instanceId,
        hash: t.hash,
        name: t.name,
        reason: t.files ? 'qBittorrent reported no files for this torrent' : 'file list could not be read',
      })
      continue
    }
    const companion = companionFlags(t.files.entries, config)
    companionsAlong += companion.filter(Boolean).length
    // A file whose path no mapping covers (null containerPath) cannot be one this plan targets, so a
    // MEDIA file like that belongs on the untargeted side of the ledger.
    const untargetedMedia = t.files.entries.filter((e, i) =>
      !companion[i] && (e.containerPath === null || !planned.has(e.containerPath)))
    if (untargetedMedia.length > 0) {
      offenders.push({
        instanceId: t.instanceId,
        hash: t.hash,
        name: t.name,
        fileCount: t.files.count,
        filesNotInPlan: untargetedMedia.length,
        examples: untargetedMedia.slice(0, 5).map((e) => e.containerPath ?? e.relPath),
      })
    }
  }
  if (!offenders.length) {
    return pass('guard.torrent-scope', 'every media file of every matched torrent is in this plan', {
      companionFiles: companionsAlong,
    })
  }
  const unreadable = offenders.filter((o) => 'reason' in o)
  const unreadableDetail = unreadable.map((o) => `${String(o.name)} (${String(o.reason)})`)
  const wider = offenders.filter((o) => 'filesNotInPlan' in o)
  const reasons: string[] = []
  if (wider.length) {
    reasons.push(wider.map((o) => `removing ${String(o.name)} would also delete ${String(o.filesNotInPlan)} media file(s) this plan does not name`).join('; '))
  }
  if (unreadable.length) {
    reasons.push(`${unreadableDetail.join(', ')}: the scope of the delete is unknown`)
  }
  return {
    guard: 'guard.torrent-scope',
    outcome: 'block',
    overridable: true,
    reason: reasons.join('; '),
    evidence: { offenders },
  }
}

/**
 * Collapses a guard set to a single go/no-go, honoring only overrides for guards that actually
 * allow one — passing a non-overridable guard's id in `overrides` has no effect, silently, which
 * is the point: an executor cannot accidentally clear `guard.protected` by including its id in a
 * blanket override list gathered from elsewhere.
 */
export function isBlocked(verdicts: GuardVerdict[], overrides: GuardId[]): { blocked: boolean; by: GuardId[] } {
  const overrideSet = new Set(overrides)
  const by = verdicts
    .filter((v) => v.outcome === 'block' && !(v.overridable && overrideSet.has(v.guard)))
    .map((v) => v.guard)
  return { blocked: by.length > 0, by }
}
