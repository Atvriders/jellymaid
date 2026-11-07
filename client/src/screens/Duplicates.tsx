import { useEffect, useMemo, useState } from 'react'
import type { Api, Confidence, DupeGroupView, DupeMemberView, KeeperPolicy, RequestedAction, TorrentFactsView } from '../api.js'
import { useAsync } from '../hooks.js'
import { Bytes, ConfirmBox, EmptyState, NotEvaluatedNotice, Pager } from '../components/index.js'
import {
  HASH_MATCHER, NO_FILTERS, PAGE_SIZE, filterGroups, groupHeading, isHashVerified, memberBox, planBulkQueue,
  resolveKeeper, sortGroups, unqueueableReason,
} from './duplicatesModel.js'
import type { DupeFilters, HnrFilter, SortKey } from './duplicatesModel.js'

type DuplicatesApi = Pick<Api, 'duplicates' | 'mergeGroup' | 'dismissDuplicate' | 'reopenDuplicate'>

function formatResolution(height: number | null | undefined): string {
  if (height === null || height === undefined) return '—'
  return `${height}p`
}

function formatBitrate(bitrate: number | null | undefined): string {
  if (bitrate === null || bitrate === undefined) return '—'
  return `${(bitrate / 1_000_000).toFixed(1)} Mbps`
}

function formatAudioChannels(channels: number | null | undefined): string {
  if (channels === null || channels === undefined) return '—'
  return String(channels)
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

// Friendly display names for src/rules/keeper.ts's breakdown keys. Deliberately worded so none of
// them collides with this screen's own member-table column headers ("Res.", "Bit rate", "Video
// codec", "Audio ch.", "File size") — both tables can be visible at once, and a duplicated literal
// string between them would make the two impossible to tell apart by a screen reader or a test
// alike. Falls back to the raw key for anything not in this map, so an unrecognised weight still
// renders rather than silently vanishing from the audit trail.
const SCORE_LABELS: Record<string, string> = {
  resolution: 'Resolution score',
  hdr: 'HDR',
  bitrate: 'Bitrate score',
  codec: 'Codec score',
  audioChannels: 'Audio channels',
  subtitles: 'Subtitles',
  size: 'Size score',
}

const KEEPER_POLICY_LABEL: Record<KeeperPolicy, string> = {
  'best-quality': 'best quality',
  smallest: 'smallest file',
  none: 'none',
}

function memberDisplayPath(m: DupeMemberView): string {
  return m.containerPath ?? m.name
}

/**
 * A group's `tier` is the MAXIMUM confidence over every link in it (see `buildDupeGroups` in
 * src/rules/grouping.ts), so this is a statement about the group's strongest evidence, never its
 * weakest — and never a statement about what kind of evidence that was. In particular
 * `tier === 'exact'` does NOT mean any bytes were ever compared: `dupe.provider-id` (shared
 * TMDB/IMDB/TVDB id) and `dupe.series-episode` (shared series/season/episode key) both emit
 * `'exact'` from pure metadata, and `dupe.identical-file` — the only matcher that ever looks at
 * file content — only ever hashes a SAMPLE (head + tail, `src/fs/hasher.ts`), never the whole
 * file. `dupe.fuzzy-title` is the only matcher that ever emits `'possible'`, so a `possible` group
 * is, by construction, matched by title-similarity alone.
 *
 * `matchedBy` is what actually answers "what kind of match is this": the deduplicated set of
 * matcher ids that contributed a link anywhere in this group. It gates the acknowledgement below
 * on real evidence instead of the tier label, and is always shown to the operator directly.
 *
 * This screen never uses the shared `<TierBadge>` for the tier tag: that component renders
 * `possible` with the same quiet tint as an "info" severity — calmer than `strong`, even though
 * `possible` is the LEAST confirmed tier. Escalating rather than de-escalating, `possible` gets the
 * same warning weight as `strong` here.
 */
function tierTagClass(tier: string): string {
  if (tier === 'exact') return 'tag tag-ok'
  return 'tag tag-warn'
}

/** Friendly display names for `matchedBy` entries (`src/rules/dupes/index.ts` rule ids). Falls
 * back to the raw id for anything unmapped, same policy as `SCORE_LABELS` above. */
const MATCHER_LABELS: Record<string, string> = {
  'dupe.provider-id': 'provider ID',
  'dupe.series-episode': 'series & episode',
  'dupe.identical-file': 'file hash',
  'dupe.title-year': 'title & year',
  'dupe.runtime': 'runtime',
  'dupe.fuzzy-title': 'fuzzy title similarity',
}

function matcherLabel(ruleId: string): string {
  return MATCHER_LABELS[ruleId] ?? ruleId
}

/**
 * Plain-fact line always shown when there is `matchedBy` data: which matcher(s) actually produced
 * this group, so an operator sees a weak link riding along a strong one that the tier badge alone
 * hides. When a file-hash match is among them, the sampling caveat is spelled out here rather than
 * assumed, since "file hash" alone reads as a full comparison.
 */
function matchedByLine(matchedBy: string[]): string | null {
  if (matchedBy.length === 0) return null
  const labels = matchedBy.map(matcherLabel).join(', ')
  const hashNote = matchedBy.includes(HASH_MATCHER)
    ? ' File hash here means a sampled hash of each file\'s first and last portion, not the whole file — strong evidence, but not proof of a full byte-for-byte match.'
    : ''
  return `Matched by: ${labels}.${hashNote}`
}

/**
 * A caveat for whichever tier/evidence combination requires the acknowledgement (see `needsAck`
 * below) — shown next to the tag so the operator reads it before ever reaching the delete
 * controls. `exact` reaching this function at all means it was NOT hash-verified, so its caveat is
 * derived from `matchedBy`, never asserted from the tier label.
 */
function evidenceCaveat(tier: string, matchedBy: string[]): string {
  if (tier === 'possible') {
    return 'Matched by title similarity only (dupe.fuzzy-title) — a hypothesis, not a confirmed duplicate. Verify manually before deleting anything.'
  }
  if (tier === 'strong') {
    return 'Matched by title/year proximity or runtime similarity, not a provider ID or file hash — verify before deleting.'
  }
  const labels = matchedBy.length > 0 ? matchedBy.map(matcherLabel).join(', ') : 'no recorded matcher'
  return matchedBy.includes(HASH_MATCHER)
    ? `Matched by ${labels} — a file-hash link exists somewhere in this group, but at least one member was pulled in by a weaker match that never compared file content. Verify manually before deleting anything.`
    : `Matched by ${labels} — shared metadata, not a file comparison, so this is not the byte-verified proof an "exact" tier might otherwise suggest. Verify manually before deleting anything.`
}

/** Mirrors `evidenceCaveat`'s reasoning for the acknowledgement checkbox's own label text. */
function ackSuffix(tier: string, matchedBy: string[]): string {
  if (tier === 'possible') return 'title-similarity guess'
  if (tier === 'strong') return 'title/runtime coincidence'
  const labels = matchedBy.length > 0 ? matchedBy.map(matcherLabel).join(' + ') : 'metadata-only'
  return `${labels} match with no file comparison behind it`
}

function tierAckLabel(tier: string, matchedBy: string[]): string {
  return `I have verified this is a real duplicate, not just a ${ackSuffix(tier, matchedBy)}.`
}

/** Who picked the keeper, said plainly — or that nobody has yet. */
function keeperLine(group: DupeGroupView, keeperId: string | null, overridden: boolean): string {
  if (keeperId === null) {
    return group.keeperItemId === null
      ? 'No keeper pre-selected — choose which copy to keep.'
      : 'The recommended keeper is no longer in this group — choose which copy to keep.'
  }
  if (overridden) return 'Keeper chosen by you.'
  return `Keeper picked by the ${KEEPER_POLICY_LABEL[group.keeperPolicy] ?? group.keeperPolicy} policy.`
}

/**
 * The H&R rule (spec decision 2): a private torrent may go only once it has BOTH the minimum
 * ratio and the minimum seeding time. `hnrMet` is computed by the server under the CURRENT
 * thresholds; a `false` is shown as blocked even for a torrent reported public, because the server
 * is the authority and unknown is treated as blocked.
 */
function HnrBadge({ t }: { t: TorrentFactsView }) {
  if (!t.hnrMet) return <span className="tag tag-warn">H&amp;R: blocked</span>
  if (t.isPrivate) return <span className="tag tag-ok">H&amp;R: met</span>
  return <span className="tag tag-quiet">H&amp;R: n/a</span>
}

function TorrentFacts({ m }: { m: DupeMemberView }) {
  const t = m.torrent
  if (!t) return <span className="tag tag-quiet" title="No torrent in the index owns this file">no torrent</span>
  return (
    <div className="dupe-torrent">
      {/* A torrent name is whatever its creator chose — a text node only, never markup. */}
      <span className="subject-path">{t.name}</span>
      <span className="dupe-torrent-facts">
        <span className="tag tag-quiet">{t.state}</span>
        <span className={t.isPrivate ? 'tag tag-warn' : 'tag tag-quiet'}>{t.isPrivate ? 'private' : 'public'}</span>
        <HnrBadge t={t} />
        <span className="dupe-fact">ratio {t.ratio.toFixed(2)}</span>
        <span className="dupe-fact">{t.seedingDays.toFixed(1)} days seeding</span>
        {m.torrentCount > 1 ? (
          <span className="tag tag-warn" title="More than one torrent owns this file (cross-seeded)">{m.torrentCount} torrents</span>
        ) : null}
      </span>
    </div>
  )
}

interface QueuedConfirmation {
  paths: string[]
  skipped: number
}

/**
 * The highest-stakes screen in the app: an operator picks which copy of a film survives and which
 * gets permanently deleted along with its torrent data, now across hundreds of groups. Things this
 * screen must never blur together:
 *
 *   1. Merge and delete are different operations with different reversibility. Merge Versions is
 *      a reversible Jellyfin metadata change (`POST /api/duplicates/:id/merge`) and asks first;
 *      "Delete non-keepers" and the bulk queue only ever QUEUE `delete-media` actions for the Plan
 *      screen — nothing is touched until that plan is built, approved and executed. Each button
 *      carries its own reversibility note via `aria-describedby`, and only the delete controls get
 *      the app's one reserved destructive button style.
 *   2. The keeper is a recommendation, not a verdict — every row is a radio the operator can move,
 *      and "Why" reveals the score breakdown behind it. With no keeper (policy `none`, or a
 *      recommended keeper that has left the group) nothing is pre-selected and nothing can be
 *      queued until the operator picks one (`resolveKeeper`).
 *   3. Per group, deletion is per-row opt-in: each non-keeper carries its own unchecked checkbox,
 *      and Delete non-keepers acts only on rows the operator checked, behind an acknowledgement
 *      unless every matcher compared file content. The bulk path is the deliberate exception for
 *      scale, and it pays for it with a confirmation that states counts and bytes, skips
 *      `possible` and different-edition groups unless explicitly included, and never touches a
 *      group without a keeper.
 *   4. A path already queued — from this group, from the bulk queue, or from App's persisted queue
 *      (`queued`) — is never handed to `onQueue` again.
 *   5. Dismiss is persisted on the server (`POST /api/duplicates/:id/dismiss`), and the last one
 *      can be undone (`/reopen`) — never a session-only hide that silently comes back.
 */
export function Duplicates({ api, onQueue, queued = [] }: {
  api: DuplicatesApi
  onQueue: (actions: RequestedAction[]) => void
  /** App's queue, so a copy queued on an earlier visit, or before a reload, still reads as queued. */
  queued?: RequestedAction[]
}) {
  const list = useAsync(api.duplicates)

  const [keeperOverrides, setKeeperOverrides] = useState<Record<string, string>>({})
  const [whyOpen, setWhyOpen] = useState<Set<string>>(new Set())
  const [mergingId, setMergingId] = useState<string | null>(null)
  const [confirmMergeId, setConfirmMergeId] = useState<string | null>(null)
  const [mergeErrors, setMergeErrors] = useState<Record<string, string>>({})
  const [deleteSelections, setDeleteSelections] = useState<Record<string, Set<string>>>({})
  const [tierAck, setTierAck] = useState<Record<string, boolean>>({})
  const [queuedFor, setQueuedFor] = useState<Record<string, QueuedConfirmation>>({})
  // Every path this group has ever handed to `onQueue` (per-group button or bulk), so a later click
  // that ALSO includes an already-queued path never re-sends it: `deleteCount` is incremented per
  // action, so a resend overstates the plan, lists the same path twice for approval, and fails
  // execution the second time on a file the first attempt already removed.
  const [queuedPathsByGroup, setQueuedPathsByGroup] = useState<Record<string, Set<string>>>({})

  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set())
  const [dismissingId, setDismissingId] = useState<string | null>(null)
  const [dismissErrors, setDismissErrors] = useState<Record<string, string>>({})
  const [lastDismissed, setLastDismissed] = useState<{ id: string; heading: string } | null>(null)
  const [undoError, setUndoError] = useState<string | null>(null)

  const [filters, setFilters] = useState<DupeFilters>(NO_FILTERS)
  const [sort, setSort] = useState<SortKey>('reclaimable')
  const [offset, setOffset] = useState(0)
  const [includePossible, setIncludePossible] = useState(false)
  const [includeEditions, setIncludeEditions] = useState(false)
  const [includeMultiEpisode, setIncludeMultiEpisode] = useState(false)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkReceipt, setBulkReceipt] = useState<{ files: number; groups: number } | null>(null)

  // A fresh fetch — the initial load, or any later reload — must never carry forward a stale
  // per-row selection, tier acknowledgement, or "already queued" guard from a previous render of
  // (possibly different) groups. `list.data` is a new object on every successful fetch.
  useEffect(() => {
    setDeleteSelections({})
    setTierAck({})
    setQueuedFor({})
    setQueuedPathsByGroup({})
    setBulkOpen(false)
  }, [list.data])

  const allGroups = list.data?.groups ?? []
  const liveGroups = useMemo(() => allGroups.filter((g) => !dismissedIds.has(g.id)), [allGroups, dismissedIds])
  const visible = useMemo(
    () => sortGroups(filterGroups(liveGroups, filters, (g) => resolveKeeper(g, keeperOverrides[g.id])), sort),
    [liveGroups, filters, sort, keeperOverrides],
  )
  // A dismissal or a narrower filter can leave the current page past the end; show the last page.
  const pageOffset = offset < visible.length ? offset : Math.max(0, Math.floor((visible.length - 1) / PAGE_SIZE) * PAGE_SIZE)
  const pageGroups = visible.slice(pageOffset, pageOffset + PAGE_SIZE)
  const boxes = useMemo(() => {
    const ids = new Set<string>()
    for (const g of allGroups) for (const m of g.members) { const b = memberBox(m); if (b) ids.add(b) }
    return [...ids].sort()
  }, [allGroups])

  const queuedPaths = useMemo(() => {
    const paths = new Set<string>()
    for (const a of queued) if (a.type === 'delete-media' && a.targetPath) paths.add(a.targetPath)
    for (const set of Object.values(queuedPathsByGroup)) for (const p of set) paths.add(p)
    return paths
  }, [queued, queuedPathsByGroup])

  const bulk = bulkOpen
    ? planBulkQueue(visible, {
      includePossible, includeEditions, includeMultiEpisode, keeperOf: (g) => resolveKeeper(g, keeperOverrides[g.id]), queuedPaths,
    })
    : null

  function updateFilters(patch: Partial<DupeFilters>) {
    setFilters((prev) => ({ ...prev, ...patch }))
    setOffset(0)
    setBulkOpen(false)
  }

  function forgetGroupEntry<T>(setter: (fn: (prev: Record<string, T>) => Record<string, T>) => void, groupId: string) {
    setter((prev) => {
      if (!(groupId in prev)) return prev
      const next = { ...prev }
      delete next[groupId]
      return next
    })
  }

  function chooseKeeper(group: DupeGroupView, memberId: string) {
    setKeeperOverrides((prev) => ({ ...prev, [group.id]: memberId }))
    // Moving the keeper changes who "non-keeper" even refers to. A confirmation naming the
    // previous non-keeper set (which may now include the very copy just promoted to keeper) would
    // be actively misleading, so both the pending selection and any prior "queued" receipt for
    // this group are cleared rather than left to describe a keeper choice that no longer holds.
    forgetGroupEntry(setDeleteSelections, group.id)
    forgetGroupEntry(setQueuedFor, group.id)
    setBulkOpen(false)
  }

  function toggleWhy(groupId: string) {
    setWhyOpen((prev) => {
      const next = new Set(prev)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }

  function toggleDeleteSelection(groupId: string, memberId: string) {
    setDeleteSelections((prev) => {
      const next = new Set(prev[groupId] ?? [])
      if (next.has(memberId)) next.delete(memberId)
      else next.add(memberId)
      return { ...prev, [groupId]: next }
    })
  }

  function toggleTierAck(groupId: string) {
    setTierAck((prev) => ({ ...prev, [groupId]: !prev[groupId] }))
  }

  async function dismiss(group: DupeGroupView) {
    setDismissingId(group.id)
    forgetGroupEntry(setDismissErrors, group.id)
    try {
      await api.dismissDuplicate(group.id)
      setDismissedIds((prev) => new Set(prev).add(group.id))
      setLastDismissed({ id: group.id, heading: groupHeading(group) })
      setUndoError(null)
      setBulkOpen(false)
    } catch (err) {
      setDismissErrors((prev) => ({ ...prev, [group.id]: err instanceof Error ? err.message : 'failed to dismiss' }))
    } finally {
      setDismissingId(null)
    }
  }

  async function undoDismiss() {
    if (!lastDismissed) return
    const { id } = lastDismissed
    try {
      await api.reopenDuplicate(id)
      setDismissedIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      setLastDismissed(null)
      setUndoError(null)
    } catch (err) {
      setUndoError(err instanceof Error ? err.message : 'failed to reopen the group')
    }
  }

  async function handleMerge(group: DupeGroupView) {
    setConfirmMergeId(null)
    setMergingId(group.id)
    forgetGroupEntry(setMergeErrors, group.id)
    try {
      await api.mergeGroup(group.id)
      list.reload()
    } catch (err) {
      setMergeErrors((prev) => ({ ...prev, [group.id]: err instanceof Error ? err.message : 'failed to merge versions' }))
    } finally {
      setMergingId(null)
    }
  }

  function rememberQueued(pathsByGroup: Record<string, string[]>) {
    setQueuedPathsByGroup((prev) => {
      const next = { ...prev }
      for (const [groupId, paths] of Object.entries(pathsByGroup)) {
        const set = new Set(next[groupId] ?? [])
        for (const p of paths) set.add(p)
        next[groupId] = set
      }
      return next
    })
  }

  /**
   * `notYetQueued` is always the not-yet-queued difference for this group — never the raw checked
   * selection — so a click that includes a path already sent to `onQueue` is never sent again.
   * Typed with `containerPath` narrowed to `string` rather than cast, so a missing path can never
   * silently reach the action list.
   */
  function handleDeleteNonKeepers(
    group: DupeGroupView,
    notYetQueued: Array<DupeMemberView & { containerPath: string }>,
    skipped: number,
  ) {
    onQueue(notYetQueued.map((m) => ({ type: 'delete-media', targetPath: m.containerPath })))
    rememberQueued({ [group.id]: notYetQueued.map((m) => m.containerPath) })
    setQueuedFor((prev) => ({
      ...prev,
      [group.id]: { paths: notYetQueued.map(memberDisplayPath), skipped },
    }))
  }

  function confirmBulk() {
    if (!bulk || bulk.actions.length === 0) return
    onQueue(bulk.actions)
    rememberQueued(bulk.pathsByGroup)
    setBulkReceipt({ files: bulk.actions.length, groups: bulk.groupCount })
    setBulkOpen(false)
  }

  if (!list.data) {
    return (
      <div className="duplicates">
        {list.error ? <p className="alert" role="alert"><span>{list.error}</span></p> : <EmptyState>Loading duplicate groups…</EmptyState>}
      </div>
    )
  }

  const data = list.data
  const pager = (
    <Pager offset={pageOffset} limit={PAGE_SIZE} total={visible.length} noun={['group', 'groups']} onOffset={setOffset} />
  )

  return (
    <div className="duplicates">
      {/* A reload that fails (e.g. right after a successful merge) must not erase the last-good
          groups still sitting in `list.data` — the error is shown ABOVE them, not instead of them. */}
      {list.error ? <p className="alert" role="alert"><span>{list.error}</span></p> : null}

      {/* "Degraded means not evaluated, never zero": groups from an older scan may still be listed,
          but an empty list here is not a clean bill of health. */}
      {!data.evaluated ? (
        <NotEvaluatedNotice items={[{ ruleId: 'dupe.group', reason: data.reason ?? 'duplicate matching did not run in the latest scan' }]} />
      ) : null}

      {lastDismissed ? (
        <p className="alert alert-ok dupe-dismissed-notice" role="status">
          <span>Dismissed {lastDismissed.heading}. It stays hidden after later scans while its copies stay the same.</span>
          <button type="button" className="btn btn-quiet" onClick={() => void undoDismiss()}>Undo</button>
        </p>
      ) : null}
      {undoError ? <p className="alert" role="alert"><span>{undoError}</span></p> : null}

      {allGroups.length === 0 ? (
        data.evaluated ? <EmptyState>No duplicate groups found.</EmptyState> : null
      ) : liveGroups.length === 0 ? (
        <EmptyState>Every duplicate group listed here has been dismissed.</EmptyState>
      ) : (
        <>
          <section className="panel dupe-toolbar">
            <form className="filters" onSubmit={(e) => e.preventDefault()}>
              <div className="field">
                <label htmlFor="dupe-search">Search</label>
                <input
                  id="dupe-search"
                  type="search"
                  value={filters.search}
                  placeholder="title, path or torrent"
                  onChange={(e) => updateFilters({ search: e.target.value })}
                />
              </div>
              <div className="field">
                <label htmlFor="dupe-sort">Sort by</label>
                <select id="dupe-sort" value={sort} onChange={(e) => { setSort(e.target.value as SortKey); setOffset(0) }}>
                  <option value="reclaimable">Reclaimable space</option>
                  <option value="title">Title</option>
                  <option value="tier">Tier</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="dupe-tier">Tier</label>
                <select id="dupe-tier" value={filters.tier} onChange={(e) => updateFilters({ tier: e.target.value as Confidence | '' })}>
                  <option value="">All tiers</option>
                  <option value="exact">Exact</option>
                  <option value="strong">Strong</option>
                  <option value="possible">Possible</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="dupe-box">Box</label>
                <select id="dupe-box" value={filters.box} onChange={(e) => updateFilters({ box: e.target.value })}>
                  <option value="">All boxes</option>
                  {boxes.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="dupe-hnr">H&amp;R</label>
                <select id="dupe-hnr" value={filters.hnr} onChange={(e) => updateFilters({ hnr: e.target.value as HnrFilter })}>
                  <option value="">Any</option>
                  <option value="blocked">Blocked</option>
                  <option value="clear">Not blocked</option>
                </select>
              </div>
              <label className="dupe-toggle">
                <input type="checkbox" checked={filters.crossBoxOnly} onChange={(e) => updateFilters({ crossBoxOnly: e.target.checked })} />
                Cross-box only
              </label>
            </form>

            <div className="dupe-bulk">
              <label className="dupe-toggle">
                <input type="checkbox" checked={includePossible} onChange={(e) => { setIncludePossible(e.target.checked); setBulkOpen(false) }} />
                Include possible-tier groups
              </label>
              <label className="dupe-toggle">
                <input type="checkbox" checked={includeEditions} onChange={(e) => { setIncludeEditions(e.target.checked); setBulkOpen(false) }} />
                Include groups whose editions differ
              </label>
              <label className="dupe-toggle">
                <input type="checkbox" checked={includeMultiEpisode} onChange={(e) => { setIncludeMultiEpisode(e.target.checked); setBulkOpen(false) }} />
                Include groups holding a multi-episode file
              </label>
              <div className="dupe-action">
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={visible.length === 0}
                  aria-describedby="dupe-bulk-note"
                  onClick={() => { setBulkReceipt(null); setBulkOpen(true) }}
                >
                  Queue non-keepers for {plural(visible.length, 'visible group', 'visible groups')}
                </button>
                <span id="dupe-bulk-note" className="dupe-action-note tag tag-block">queues file and torrent deletes for the Plan screen</span>
              </div>
            </div>

            {bulk ? (
              <ConfirmBox
                title={`Queue non-keepers for ${plural(visible.length, 'visible group', 'visible groups')}?`}
                confirmLabel={`Queue ${plural(bulk.actions.length, 'file', 'files')}`}
                confirmClassName="btn btn-danger"
                disabled={bulk.actions.length === 0}
                onConfirm={confirmBulk}
                onCancel={() => setBulkOpen(false)}
              >
                <p>
                  {plural(bulk.actions.length, 'file', 'files')} from {plural(bulk.groupCount, 'group', 'groups')} —{' '}
                  <Bytes value={bulk.bytes} />
                  {bulk.unknownSizes > 0 ? `, plus ${plural(bulk.unknownSizes, 'file', 'files')} of unknown size` : ''}. They
                  join the queue for the Plan screen; nothing is deleted until a plan is built, approved and executed.
                </p>
                {bulk.metadataOnlyGroups > 0 ? (
                  <p>
                    {plural(bulk.metadataOnlyGroups, 'of these groups was', 'of these groups were')} matched by metadata
                    alone, not by comparing files. Each card shows its evidence.
                  </p>
                ) : null}
                <ul className="confirm-list">
                  {bulk.skipped.possible > 0 ? <li>Skipped {plural(bulk.skipped.possible, 'possible-tier group', 'possible-tier groups')} — tick “Include possible-tier groups” to add them.</li> : null}
                  {bulk.skipped.editionsDiffer > 0 ? <li>Skipped {plural(bulk.skipped.editionsDiffer, 'group whose editions differ', 'groups whose editions differ')} — tick “Include groups whose editions differ” to add them.</li> : null}
                  {bulk.skipped.multiEpisode > 0 ? <li>Skipped {plural(bulk.skipped.multiEpisode, 'group holding a multi-episode file', 'groups holding a multi-episode file')} — tick “Include groups holding a multi-episode file” to add them.</li> : null}
                  {bulk.skipped.noKeeper > 0 ? <li>Skipped {plural(bulk.skipped.noKeeper, 'group with no keeper', 'groups with no keeper')} — choose a keeper on the card first.</li> : null}
                  {bulk.skipped.alreadyQueued > 0 ? <li>Left out {bulk.skipped.alreadyQueued} already queued.</li> : null}
                  {bulk.skipped.noPath > 0 ? <li>{plural(bulk.skipped.noPath, 'copy has', 'copies have')} no known path and cannot be queued.</li> : null}
                  {bulk.skipped.sameFileAsKeeper > 0 ? <li>{plural(bulk.skipped.sameFileAsKeeper, 'copy is', 'copies are')} the same file as the keeper and cannot be queued.</li> : null}
                </ul>
              </ConfirmBox>
            ) : null}

            {bulkReceipt ? (
              <p className="dupe-queued-note" role="status">
                Queued {plural(bulkReceipt.files, 'file', 'files')} from {plural(bulkReceipt.groups, 'group', 'groups')} for the Plan screen.
              </p>
            ) : null}

            {data.scanId !== null ? (
              <p className="dupe-provenance">
                From scan {data.scanId}{data.scanFinishedAt ? `, finished ${data.scanFinishedAt}` : ''}.
              </p>
            ) : null}
            {pager}
          </section>

          {visible.length === 0 ? <EmptyState>No duplicate groups match these filters.</EmptyState> : null}

          {pageGroups.map((group) => {
            const override = keeperOverrides[group.id]
            const keeperId = resolveKeeper(group, override)
            const keeper = group.members.find((m) => m.id === keeperId)
            const heading = groupHeading(group)
            const libraries = [...new Set(group.members.map((m) => m.libraryName ?? '—'))]
            const crossLibrary = libraries.length > 1
            const isWhyOpen = whyOpen.has(group.id)
            const scoreKeys = [
              ...new Set(group.members.flatMap((m) => Object.keys(group.scores[m.id]?.breakdown ?? {}))),
            ]
            const isMerging = mergingId === group.id
            const mergeError = mergeErrors[group.id]
            const dismissError = dismissErrors[group.id]

            const nonKeepers = keeperId === null ? [] : group.members.filter((m) => m.id !== keeperId)
            const queueableNonKeepers = nonKeepers.filter(
              (m): m is DupeMemberView & { containerPath: string } => unqueueableReason(m, keeper) === null,
            )
            const unqueueableCount = nonKeepers.length - queueableNonKeepers.length
            const selected = deleteSelections[group.id] ?? new Set<string>()
            const checkedQueueable = queueableNonKeepers.filter((m) => selected.has(m.id))
            const reclaimable = keeperId === null ? null : nonKeepers.reduce((sum, m) => sum + (m.sizeBytes ?? 0), 0)
            // `matchedBy` is not guaranteed non-empty at runtime — defaulted rather than trusted.
            const matchedBy = group.matchedBy ?? []
            // The acknowledgement gate is evidence-based, never inferred from the tier label alone:
            // `exact` may skip it ONLY when every contributing matcher compared file content.
            const needsAck = group.tier !== 'exact' || !isHashVerified(matchedBy)
            const ackGiven = tierAck[group.id] === true
            const caveat = needsAck ? evidenceCaveat(group.tier, matchedBy) : null
            const matchedByText = matchedByLine(matchedBy)
            const queuedHere = queuedFor[group.id]
            const notYetQueued = checkedQueueable.filter((m) => !queuedPaths.has(m.containerPath))
            const allCheckedAlreadyQueued = checkedQueueable.length > 0 && notYetQueued.length === 0
            const canDelete = keeperId !== null && notYetQueued.length > 0 && (!needsAck || ackGiven)
            const deleteLabel = allCheckedAlreadyQueued
              ? 'Queued for deletion'
              : checkedQueueable.length > 0
                ? `Delete non-keepers (${checkedQueueable.length})`
                : 'Delete non-keepers'
            const editions = [...new Set(group.members.map((m) => m.edition).filter((e): e is string => e !== null))]

            const mergeNoteId = `dupe-merge-note-${group.id}`
            const deleteNoteId = `dupe-delete-note-${group.id}`

            return (
              <section className="panel dupe-group" key={group.id}>
                <header className="dupe-group-header">
                  <span className={tierTagClass(group.tier)}>{group.tier}</span>
                  {/* A title comes straight from Jellyfin metadata — a text node only. */}
                  <h3>{heading}</h3>
                  {group.crossInstance ? <span className="tag tag-quiet" title="Copies live on more than one qBittorrent box">cross-box</span> : null}
                  {group.editionsDiffer ? <span className="tag tag-warn">editions differ</span> : null}
                  {group.multiEpisode ? <span className="tag tag-warn">multi-episode</span> : null}
                  <span className="dupe-reclaimable"><Bytes value={reclaimable} /> reclaimable</span>
                </header>

                {matchedByText ? <p className="dupe-matched-by">{matchedByText}</p> : null}
                <p className="dupe-matched-by">{keeperLine(group, keeperId, override !== undefined && override === keeperId)}</p>

                {crossLibrary ? (
                  <p className="alert alert-warn" role="status">
                    These copies live across libraries: {libraries.join(', ')}.
                  </p>
                ) : null}

                {group.editionsDiffer ? (
                  <p className="alert alert-warn" role="status">
                    These copies are different editions{editions.length > 0 ? ` (${editions.join(', ')})` : ''} — possibly
                    different cuts rather than duplicates. The bulk queue skips this group unless you include it.
                  </p>
                ) : null}

                {group.multiEpisode ? (
                  <p className="alert alert-warn" role="status">
                    One of these copies is a file that holds more than one episode (for example S01E01E02). Deleting it
                    deletes every episode in it, not only this one — keep it unless another copy has the rest. The bulk
                    queue skips this group unless you include it.
                  </p>
                ) : null}

                {caveat ? <p className="alert alert-warn" role="status">{caveat}</p> : null}

                {/* Eleven columns: on a narrow window the table scrolls inside its card instead of
                    squeezing the path column or widening the whole page. */}
                <div className="table-scroll">
                  <table className="table dupe-table">
                    <thead>
                      <tr>
                        <th scope="col">Keep</th>
                        <th scope="col">Delete</th>
                        <th scope="col">Path</th>
                        <th scope="col">Box</th>
                        <th scope="col">Torrent</th>
                        <th scope="col">Res.</th>
                        <th scope="col">Bit rate</th>
                        <th scope="col">Video codec</th>
                        <th scope="col">Audio ch.</th>
                        <th scope="col">File size</th>
                        <th scope="col">Library</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.members.map((m) => {
                        const isKeeper = m.id === keeperId
                        const blockedReason = keeperId === null || isKeeper ? null : unqueueableReason(m, keeper)
                        const isQueued = m.containerPath !== null && queuedPaths.has(m.containerPath)
                        return (
                          <tr key={m.id} data-keeper={isKeeper ? 'true' : 'false'}>
                            <td>
                              <label className="dupe-keeper-radio">
                                <input
                                  type="radio"
                                  name={`keeper-${group.id}`}
                                  checked={isKeeper}
                                  onChange={() => chooseKeeper(group, m.id)}
                                  aria-label={`Keep ${memberDisplayPath(m)}`}
                                />
                                <span className={isKeeper ? 'tag tag-ok' : 'tag tag-quiet'}>
                                  {isKeeper ? 'keeper' : keeperId === null ? 'undecided' : 'non-keeper'}
                                </span>
                              </label>
                            </td>
                            <td>
                              {isKeeper || keeperId === null ? null : blockedReason ? (
                                <span className="tag tag-quiet">{blockedReason}</span>
                              ) : (
                                <label className="dupe-delete-checkbox">
                                  <input
                                    type="checkbox"
                                    checked={selected.has(m.id)}
                                    onChange={() => toggleDeleteSelection(group.id, m.id)}
                                    aria-label={`Delete ${memberDisplayPath(m)}`}
                                  />
                                  {isQueued ? <span className="tag tag-ok">queued</span> : null}
                                </label>
                              )}
                            </td>
                            {/* containerPath (or, absent that, name) is a value from the scanned
                                library — a text node only, never markup. */}
                            <td className="subject-path">
                              {memberDisplayPath(m)}
                              {m.edition ? <> <span className="tag tag-quiet">{m.edition}</span></> : null}
                            </td>
                            <td className="dupe-box">{memberBox(m) ?? '—'}</td>
                            <td><TorrentFacts m={m} /></td>
                            <td>{formatResolution(m.height)}</td>
                            <td>{formatBitrate(m.bitrate)}</td>
                            <td>{m.videoCodec ?? '—'}</td>
                            <td>{formatAudioChannels(m.audioChannels)}</td>
                            <td><Bytes value={m.sizeBytes ?? null} /></td>
                            <td>{m.libraryName ?? '—'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>

                <button type="button" className="btn btn-quiet" onClick={() => toggleWhy(group.id)}>
                  Why?
                </button>

                {isWhyOpen ? (
                  <table className="table dupe-why-table">
                    <caption>Keeper score breakdown — highest total wins.</caption>
                    <thead>
                      <tr>
                        <th scope="col">Copy</th>
                        <th scope="col">Total</th>
                        {scoreKeys.map((k) => <th key={k} scope="col">{SCORE_LABELS[k] ?? k}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {group.members.map((m) => {
                        const score = group.scores[m.id]
                        return (
                          <tr key={m.id}>
                            <td className="subject-path">{memberDisplayPath(m)}</td>
                            <td>{score ? score.total.toFixed(0) : '—'}</td>
                            {scoreKeys.map((k) => {
                              const value = score?.breakdown[k]
                              return <td key={k}>{value === undefined ? '—' : value.toFixed(0)}</td>
                            })}
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                ) : null}

                {mergeError ? <p className="alert" role="alert"><span>{mergeError}</span></p> : null}
                {dismissError ? <p className="alert" role="alert"><span>{dismissError}</span></p> : null}

                {needsAck && keeperId !== null ? (
                  <label className="dupe-tier-ack">
                    <input type="checkbox" checked={ackGiven} onChange={() => toggleTierAck(group.id)} />
                    {tierAckLabel(group.tier, matchedBy)}
                  </label>
                ) : null}

                <div className="dupe-actions">
                  <div className="dupe-action">
                    <button
                      type="button"
                      className="btn btn-danger"
                      disabled={!canDelete}
                      aria-describedby={deleteNoteId}
                      onClick={() => handleDeleteNonKeepers(group, notYetQueued, unqueueableCount)}
                    >
                      {deleteLabel}
                    </button>
                    <span id={deleteNoteId} className="dupe-action-note tag tag-block">permanent — deletes files and torrent data</span>
                  </div>
                  <div className="dupe-action">
                    <button
                      type="button"
                      className="btn btn-quiet"
                      disabled={isMerging}
                      aria-busy={isMerging}
                      aria-describedby={mergeNoteId}
                      onClick={() => setConfirmMergeId(group.id)}
                    >
                      Merge versions
                    </button>
                    <span id={mergeNoteId} className="dupe-action-note tag tag-ok">reversible — Jellyfin merge</span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-quiet"
                    disabled={dismissingId === group.id}
                    aria-busy={dismissingId === group.id}
                    onClick={() => void dismiss(group)}
                  >
                    Dismiss
                  </button>
                </div>

                {confirmMergeId === group.id ? (
                  <ConfirmBox
                    title={`Merge ${group.members.length} copies of ${heading} into one Jellyfin item?`}
                    confirmLabel="Confirm merge"
                    busy={isMerging}
                    onConfirm={() => void handleMerge(group)}
                    onCancel={() => setConfirmMergeId(null)}
                  >
                    <p>
                      Jellyfin will list them as versions of a single title. No file is touched, and History can
                      split them apart again.
                    </p>
                  </ConfirmBox>
                ) : null}

                {queuedHere ? (
                  <p className="dupe-queued-note" role="status">
                    Queued {queuedHere.paths.length} file{queuedHere.paths.length === 1 ? '' : 's'} for deletion:{' '}
                    {queuedHere.paths.join(', ')}.
                    {queuedHere.skipped > 0
                      ? ` Skipped ${queuedHere.skipped} member${queuedHere.skipped === 1 ? '' : 's'} that cannot be queued.`
                      : ''}
                  </p>
                ) : null}
              </section>
            )
          })}

          {visible.length > PAGE_SIZE ? pager : null}
        </>
      )}
    </div>
  )
}
