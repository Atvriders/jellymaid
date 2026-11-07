import type { Confidence, DupeGroupView, DupeMemberView, RequestedAction } from '../api.js'

/**
 * The Duplicates screen's pure logic: who the keeper is, which groups a filter leaves visible, in
 * what order, and exactly what a bulk queue would send. Kept apart from the component so the
 * rules that decide what gets queued for deletion read as rules, not as render code.
 */

/** Groups rendered per page — the owner's library produces hundreds of groups. */
export const PAGE_SIZE = 50

export type SortKey = 'reclaimable' | 'title' | 'tier'
/** '' = any; 'blocked' = some copy that would go is held back by H&R; 'clear' = none is. */
export type HnrFilter = '' | 'blocked' | 'clear'

export interface DupeFilters {
  search: string
  tier: Confidence | ''
  /** An instance id, or '' for every box. */
  box: string
  crossBoxOnly: boolean
  hnr: HnrFilter
}

export const NO_FILTERS: DupeFilters = { search: '', tier: '', box: '', crossBoxOnly: false, hnr: '' }

const pad2 = (n: number) => String(n).padStart(2, '0')

/** "Heat (1995)" for a film; "The Beverly Hillbillies S01E02" for an episode. */
export function groupHeading(g: Pick<DupeGroupView, 'kind' | 'title' | 'year' | 'seriesName' | 'seasonNo' | 'episodeNo'>): string {
  if (g.kind === 'episode') {
    const series = g.seriesName ?? g.title
    if (g.seasonNo !== null && g.episodeNo !== null) return `${series} S${pad2(g.seasonNo)}E${pad2(g.episodeNo)}`
    return series === g.title ? series : `${series} — ${g.title}`
  }
  return g.year !== null ? `${g.title} (${g.year})` : g.title
}

/** The box a copy lives on: its mapping's instance, else the instance of the torrent that owns it. */
export function memberBox(m: DupeMemberView): string | null {
  return m.instanceId ?? m.torrent?.instanceId ?? null
}

/**
 * The copy that stays: the operator's own pick when they made one, else the scan's recommendation
 * — and only ever a CURRENT member of the group. `null` means nobody is the keeper yet: keeper
 * policy `none` leaves `keeperItemId` null on purpose, and a recommended keeper whose copy was
 * since deleted has left the group. Neither case may promote some arbitrary member to keeper —
 * with no keeper there is no such thing as a non-keeper, so nothing in the group can be queued
 * until the operator chooses.
 */
export function resolveKeeper(g: DupeGroupView, override: string | undefined): string | null {
  const ids = new Set(g.members.map((m) => m.id))
  if (override !== undefined && ids.has(override)) return override
  if (g.keeperItemId !== null && ids.has(g.keeperItemId)) return g.keeperItemId
  return null
}

/**
 * Why a non-keeper cannot be queued, or null when it can. A copy at the SAME path as the keeper is
 * the keeper's own file (two Jellyfin items over one file, e.g. one folder in two libraries), so
 * deleting it would delete the copy being kept.
 */
export function unqueueableReason(m: DupeMemberView, keeper: DupeMemberView | undefined): string | null {
  if (!m.containerPath) return 'no known path — cannot be queued'
  if (keeper?.containerPath === m.containerPath) return 'same file as the keeper — cannot be queued'
  return null
}

/**
 * True when some copy that would be deleted is held back by the private-tracker H&R rule. The
 * keeper is never deleted, so its own H&R state does not count; with no keeper yet, every copy is
 * still a candidate and so every copy counts.
 */
export function isHnrBlocked(g: DupeGroupView, keeperId: string | null): boolean {
  return g.members.some((m) => m.id !== keeperId && m.torrent?.hnrMet === false)
}

function matchesSearch(g: DupeGroupView, needle: string): boolean {
  if (needle === '') return true
  const haystack = [groupHeading(g), g.title, g.seriesName ?? '']
  for (const m of g.members) haystack.push(m.name, m.containerPath ?? '', m.torrent?.name ?? '')
  return haystack.some((s) => s.toLowerCase().includes(needle))
}

export function filterGroups(groups: DupeGroupView[], f: DupeFilters, keeperOf: (g: DupeGroupView) => string | null): DupeGroupView[] {
  const needle = f.search.trim().toLowerCase()
  return groups.filter((g) => {
    if (f.tier !== '' && g.tier !== f.tier) return false
    if (f.box !== '' && !g.members.some((m) => memberBox(m) === f.box)) return false
    if (f.crossBoxOnly && !g.crossInstance) return false
    if (f.hnr !== '' && isHnrBlocked(g, keeperOf(g)) !== (f.hnr === 'blocked')) return false
    return matchesSearch(g, needle)
  })
}

const TIER_RANK: Record<string, number> = { exact: 0, strong: 1, possible: 2 }

/** Reclaimable bytes (largest first) by default; title A–Z; or tier (exact first). Ties fall back
 * to reclaimable, then title, then id, so the order never depends on the order the server sent. */
export function sortGroups(groups: DupeGroupView[], key: SortKey): DupeGroupView[] {
  const byTitle = (a: DupeGroupView, b: DupeGroupView) =>
    groupHeading(a).localeCompare(groupHeading(b)) || a.id.localeCompare(b.id)
  const byReclaimable = (a: DupeGroupView, b: DupeGroupView) => b.reclaimableBytes - a.reclaimableBytes || byTitle(a, b)
  const byTier = (a: DupeGroupView, b: DupeGroupView) =>
    (TIER_RANK[a.tier] ?? 3) - (TIER_RANK[b.tier] ?? 3) || byReclaimable(a, b)
  return [...groups].sort(key === 'title' ? byTitle : key === 'tier' ? byTier : byReclaimable)
}

/** The one matcher that compares file content (a sampled head+tail hash, src/fs/hasher.ts). */
export const HASH_MATCHER = 'dupe.identical-file'

/** True only when EVERY matcher behind the group compared file content. An empty list is unverified. */
export function isHashVerified(matchedBy: string[]): boolean {
  return matchedBy.length > 0 && matchedBy.every((id) => id === HASH_MATCHER)
}

export interface BulkQueuePlan {
  actions: RequestedAction[]
  /** Paths queued per group id, so each card can show what the bulk queue took from it. */
  pathsByGroup: Record<string, string[]>
  groupCount: number
  /** Sum of the known sizes; `unknownSizes` counts the files whose size is not known. */
  bytes: number
  unknownSizes: number
  /** Contributing groups whose match never compared file content. */
  metadataOnlyGroups: number
  skipped: {
    possible: number
    editionsDiffer: number
    multiEpisode: number
    noKeeper: number
    noPath: number
    sameFileAsKeeper: number
    alreadyQueued: number
  }
}

/**
 * Exactly what "Queue non-keepers for N visible groups" would send. `possible`-tier groups (a
 * title-similarity guess), groups whose members are different editions, and groups holding a
 * multi-episode file (deleting `S01E01E02` as a copy of S01E01 also loses E02) are skipped unless
 * the operator ticked the box including them; a group with no keeper is always skipped — never
 * "queue every copy". Paths already queued, or already taken from an earlier group in this same
 * pass, are not sent twice.
 */
export function planBulkQueue(groups: DupeGroupView[], opts: {
  includePossible: boolean
  includeEditions: boolean
  includeMultiEpisode: boolean
  keeperOf: (g: DupeGroupView) => string | null
  queuedPaths: ReadonlySet<string>
}): BulkQueuePlan {
  const plan: BulkQueuePlan = {
    actions: [], pathsByGroup: {}, groupCount: 0, bytes: 0, unknownSizes: 0, metadataOnlyGroups: 0,
    skipped: { possible: 0, editionsDiffer: 0, multiEpisode: 0, noKeeper: 0, noPath: 0, sameFileAsKeeper: 0, alreadyQueued: 0 },
  }
  const taken = new Set<string>()
  for (const g of groups) {
    if (g.tier === 'possible' && !opts.includePossible) { plan.skipped.possible += 1; continue }
    if (g.editionsDiffer && !opts.includeEditions) { plan.skipped.editionsDiffer += 1; continue }
    // `!== false`: a group from a server that does not say is treated as holding one.
    if (g.multiEpisode !== false && !opts.includeMultiEpisode) { plan.skipped.multiEpisode += 1; continue }
    const keeperId = opts.keeperOf(g)
    if (keeperId === null) { plan.skipped.noKeeper += 1; continue }
    const keeper = g.members.find((m) => m.id === keeperId)

    const paths: string[] = []
    for (const m of g.members) {
      if (m.id === keeperId) continue
      if (!m.containerPath) { plan.skipped.noPath += 1; continue }
      if (unqueueableReason(m, keeper) !== null) { plan.skipped.sameFileAsKeeper += 1; continue }
      if (opts.queuedPaths.has(m.containerPath) || taken.has(m.containerPath)) { plan.skipped.alreadyQueued += 1; continue }
      taken.add(m.containerPath)
      paths.push(m.containerPath)
      plan.actions.push({ type: 'delete-media', targetPath: m.containerPath })
      if (m.sizeBytes === null) plan.unknownSizes += 1
      else plan.bytes += m.sizeBytes
    }
    if (paths.length > 0) {
      plan.pathsByGroup[g.id] = paths
      plan.groupCount += 1
      if (!isHashVerified(g.matchedBy)) plan.metadataOnlyGroups += 1
    }
  }
  return plan
}
