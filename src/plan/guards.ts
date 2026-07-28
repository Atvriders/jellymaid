import type { GuardId, GuardVerdict } from '../core/types.js'
import type { FileConfig } from '../config/schema.js'
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

/**
 * Runs all four safety guards over a resolved target. Guards are pure functions of `Resolution`
 * and `FileConfig` — no I/O, no network — so every branch here is exhaustively testable, which
 * matters because the caller treats a passing guard set as license to permanently delete bytes or
 * remove a torrent with its data.
 */
export function evaluateGuards(r: Resolution, config: FileConfig): GuardVerdict[] {
  return [privateRatio(r, config), crossSeed(r), hardlink(r), protectedState(r, config)]
}

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
    hash: t.hash, name: t.name, ratio: t.ratio,
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
 *  - 'qbittorrent' unavailable: an empty `torrents` array is NOT evidence of "no torrents", it is
 *    evidence of "unknown", and unknown is never a safe state to delete from.
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
  const unverifiable = r.sourcesUnavailable.filter((s) => s === 'qbittorrent' || s === 'radarr' || s === 'sonarr')
  if (unverifiable.length) {
    const parts: string[] = []
    if (unverifiable.includes('qbittorrent')) {
      parts.push('qBittorrent is unavailable, so torrent state cannot be verified')
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
      evidence: { sourcesUnavailable: r.sourcesUnavailable },
    }
  }
  const categories = new Set(config.guards.protectedCategories.map((c) => c.toLowerCase()))
  const tags = new Set(config.guards.protectedTags.map((t) => t.toLowerCase()))
  const offenders: Array<{ hash: string; why: string }> = []
  for (const t of r.torrents) {
    if (BUSY_STATES.has(t.state)) offenders.push({ hash: t.hash, why: `state ${t.state}` })
    else if (t.category && categories.has(t.category.toLowerCase())) offenders.push({ hash: t.hash, why: `protected category ${t.category}` })
    else {
      const tag = t.tags.find((x) => tags.has(x.toLowerCase()))
      if (tag) offenders.push({ hash: t.hash, why: `protected tag ${tag}` })
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
