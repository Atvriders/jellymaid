import { useEffect, useState } from 'react'
import type { Api, DupeGroup, DupeMember, RequestedAction } from '../api.js'
import { useAsync } from '../hooks.js'
import { Bytes, EmptyState } from '../components/index.js'

type DuplicatesApi = Pick<Api, 'duplicates' | 'mergeGroup'>

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

/**
 * The server's recommended keeper is trusted only as long as it names a real member of this
 * group. It always should (src/rules/keeper.ts's `pickKeeper` only ever returns one of the ids it
 * was given), but this is the one screen where trusting that blindly is the wrong trade: if a
 * stale or malformed `keeperItemId` ever failed to match anyone, every row would read as a
 * "non-keeper" and Delete non-keepers would queue the entire group — including the only good copy
 * — for permanent deletion. Falling back to the first member instead means there is always exactly
 * one keeper, never zero.
 */
function resolveKeeper(group: DupeGroup, override: string | undefined): string | null {
  const memberIds = group.members.map((m) => m.id)
  const candidate = override ?? group.keeperItemId ?? undefined
  if (candidate !== undefined && memberIds.includes(candidate)) return candidate
  return memberIds[0] ?? null
}

function memberDisplayPath(m: DupeMember): string {
  return m.container_path ?? m.name
}

/**
 * A group's `tier` is the MAXIMUM confidence over every link in it (see `buildDupeGroups` in
 * src/rules/grouping.ts) after transitive union-find, so this is a statement about the group's
 * strongest evidence, never its weakest — and never a statement about what kind of evidence that
 * was. In particular `tier === 'exact'` does NOT mean any bytes were ever compared:
 * `dupe.provider-id` (shared TMDB/IMDB id) and `dupe.series-episode` (shared series/season/episode
 * key) both emit `'exact'` from pure metadata, and `dupe.identical-file` — the only matcher that
 * ever looks at file content — only ever hashes a SAMPLE (head + tail, `src/fs/hasher.ts`), never
 * the whole file. `tier === 'possible'` is the one tier this screen can still narrow exactly:
 * `dupe.fuzzy-title` is the only matcher that ever emits `'possible'`, so a `possible` group is, by
 * construction, matched by title-similarity alone.
 *
 * `matchedBy` (`/api/duplicates`, joined from the `dupe.group` finding's evidence — see
 * src/api/findings.ts) is what actually answers "what kind of match is this": the deduplicated set
 * of matcher ids that contributed a link anywhere in this group. It is used below to gate the
 * acknowledgement on real evidence instead of the tier label, and is always shown to the operator
 * directly (`matchedByLine`) rather than left implicit in a badge that cannot carry it.
 *
 * This screen never trusts the shared `<TierBadge>` for the tier tag itself: that component
 * renders `possible` with the same quiet, muted tint as an unrelated "info" severity — visually
 * calmer than `strong`, even though `possible` is the LEAST confirmed of the three tiers.
 * Escalating rather than de-escalating, `possible` gets the same warning weight as `strong` here.
 * `exact` still keeps the calm tag — it remains an accurate report of the tier the server computed
 * — but, per the acknowledgement gate below, is no longer trusted to mean the match was verified.
 */
function tierTagClass(tier: string): string {
  if (tier === 'exact') return 'tag tag-ok'
  return 'tag tag-warn'
}

/** Friendly display names for `matchedBy` entries (`src/rules/dupes/index.ts` rule ids). Falls
 * back to the raw id for anything unmapped, so an unrecognised matcher still renders rather than
 * silently vanishing from the audit trail — same policy as `SCORE_LABELS` above. */
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

/** The one matcher that ever compares file content — `src/rules/dupes/index.ts`'s
 * `dupe.identical-file`, bucketing on `size|quick_hash`. `quick_hash` samples the first and last
 * megabyte of the file (`src/fs/hasher.ts`), so even this is strong evidence, not proof of an exact
 * byte-for-byte match — see `matchedByLine` below for the wording shown to the operator. */
const HASH_MATCHER = 'dupe.identical-file'

/**
 * True only when EVERY matcher that contributed a link to this group was `dupe.identical-file`.
 * Any other matcher present — even alongside a hash match — means at least one pairwise link in
 * this component is metadata-only or a title-similarity guess, which is exactly how
 * `buildDupeGroups`'s max-confidence tier can drag an unrelated title into a component this screen
 * would otherwise still call `exact`. An empty `matchedBy` (no corresponding open `dupe.group`
 * finding to join against) is treated as unverified, never as a free pass.
 */
function isHashVerified(matchedBy: string[]): boolean {
  return matchedBy.length > 0 && matchedBy.every((id) => id === HASH_MATCHER)
}

/**
 * Plain-fact line always shown when there is `matchedBy` data: which matcher(s) actually produced
 * this group, so an operator sees a case like "matched by provider ID, fuzzy title similarity" —
 * a weak link riding along a strong one — that the tier badge alone hides (see the module doc
 * comment's `matchedBy` paragraph). When a file-hash match is among them, the sampling caveat is
 * spelled out here rather than assumed, since "file hash" alone reads as a full comparison.
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
 * controls. `possible` and `strong` are unaffected by the `matchedBy` fix: `dupe.fuzzy-title` is
 * the only matcher that ever emits `'possible'`, and `dupe.title-year`/`dupe.runtime` are the only
 * two that ever emit `'strong'`, so both caveats can still be worded exactly from `tier` alone.
 * `exact` reaching this function at all means (per `needsAck`) it was NOT hash-verified — either no
 * matcher touched file content, or one did but a weaker link also rode along — so its caveat is
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

interface QueuedConfirmation {
  paths: string[]
  skipped: number
}

/**
 * The highest-stakes screen in the app: an operator picks which copy of a film survives and which
 * gets permanently deleted along with its torrent data. Things this screen must never blur
 * together (see the task brief's server truths, and the review that hardened this file):
 *
 *   1. Merge and delete are different operations with different reversibility. Merge Versions is
 *      a reversible Jellyfin metadata change (`POST /api/duplicates/:id/merge`, see
 *      src/api/plans.ts); "Delete non-keepers" only ever QUEUES `delete-media` actions for the
 *      Plan screen — the file itself is not touched until that plan is later built, approved and
 *      executed. Both buttons carry their own reversibility label right next to them via
 *      `aria-describedby` (not merely nearby in the DOM, and never in a tooltip), and only Delete
 *      gets the app's one reserved destructive button style.
 *   2. The keeper is a recommendation, not a verdict — every row is a radio the operator can move,
 *      and "Why" reveals the actual score breakdown that produced the recommendation, so the
 *      choice is auditable rather than asserted.
 *   3. Deletion is per-row opt-in, never "everything that isn't the keeper" by default: each
 *      non-keeper with a known path carries its own unchecked checkbox, and Delete non-keepers
 *      acts only on rows the operator explicitly checked. That is what makes the cross-library
 *      warning below actionable — an operator can delete one stray copy while explicitly keeping
 *      another that lives in a different, intentional library — instead of merely advisory.
 *   4. Deletion requires an explicit, separate acknowledgement before Delete non-keepers can be
 *      clicked at all, on top of the per-row checkboxes — UNLESS `matchedBy` shows every
 *      contributing matcher was `dupe.identical-file` (`isHashVerified`). The tier label alone
 *      never grants that: `tier === 'exact'` also covers `dupe.provider-id` and
 *      `dupe.series-episode`, both pure metadata, so confidence and consent to delete are gated on
 *      the actual evidence, not on how confident the grouping algorithm's strongest link was.
 *   5. A path already handed to `onQueue` for a group is never handed to it again from that group,
 *      even after the operator adds more rows and clicks Delete non-keepers a second time: only the
 *      not-yet-queued difference is sent (`queuedPathsByGroup`), tracked by path rather than by the
 *      checked-selection as a whole.
 */
export function Duplicates({ api, onQueue }: { api: DuplicatesApi; onQueue: (actions: RequestedAction[]) => void }) {
  const list = useAsync(api.duplicates)

  const [keeperOverrides, setKeeperOverrides] = useState<Record<string, string>>({})
  const [whyOpen, setWhyOpen] = useState<Set<string>>(new Set())
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [mergingId, setMergingId] = useState<string | null>(null)
  const [mergeErrors, setMergeErrors] = useState<Record<string, string>>({})
  const [deleteSelections, setDeleteSelections] = useState<Record<string, Set<string>>>({})
  const [tierAck, setTierAck] = useState<Record<string, boolean>>({})
  const [queuedFor, setQueuedFor] = useState<Record<string, QueuedConfirmation>>({})
  // Every path this group has ever handed to `onQueue`, across however many Delete non-keepers
  // clicks — the MINOR 2 fix. Keyed by group id, not by a snapshot of the checked selection, so a
  // later click that ALSO includes an already-queued path never re-sends it (see `handleDelete
  // NonKeepers` below): `buildPlan` tolerates a repeated path for byte accounting, but
  // `deleteCount` is incremented per action, so a resend overstates the plan's file count, lists
  // the same path twice for approval, and fails execution the second time on a file the first
  // attempt already removed.
  const [queuedPathsByGroup, setQueuedPathsByGroup] = useState<Record<string, Set<string>>>({})

  // A fresh fetch — the initial load, or any later reload — must never carry forward a stale
  // per-row selection, tier acknowledgement, or "already queued" guard from a previous render of
  // (possibly different) groups. `list.data` is a new object on every successful fetch even when
  // its contents are unchanged, so keying off it here also satisfies "no box checked right after a
  // data refresh", not just at first mount.
  useEffect(() => {
    setDeleteSelections({})
    setTierAck({})
    setQueuedFor({})
    setQueuedPathsByGroup({})
  }, [list.data])

  function chooseKeeper(group: DupeGroup, memberId: string) {
    setKeeperOverrides((prev) => ({ ...prev, [group.id]: memberId }))
    // Moving the keeper changes who "non-keeper" even refers to. A confirmation naming the
    // previous non-keeper set (which may now include the very copy just promoted to keeper) would
    // be actively misleading, so both the pending selection and any prior "queued" receipt for
    // this group are cleared rather than left to describe a keeper choice that no longer holds.
    setDeleteSelections((prev) => {
      if (!(group.id in prev)) return prev
      const next = { ...prev }
      delete next[group.id]
      return next
    })
    setQueuedFor((prev) => {
      if (!(group.id in prev)) return prev
      const next = { ...prev }
      delete next[group.id]
      return next
    })
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

  function dismissGroup(groupId: string) {
    // There is no persisted per-group dismiss on the server: `dupe_groups.status` only ever holds
    // 'open' or 'merged' (src/index/migrations/001_init.sql), and the Finding this group was built
    // from has a DIFFERENT id (a hash over the rule id, see `findingId` in src/core/types.ts) than
    // this group's own id (a hash over just the member ids, see `buildDupeGroups` in
    // src/rules/grouping.ts). `/api/findings?class=duplicate&ruleId=dupe.group` does return each
    // finding's `evidence`, and `evidence.groupId` (src/rules/dupes/adapter.ts) IS this screen's
    // `group.id` — so the two ids CAN be joined client-side. The blocker isn't the join; it's that
    // dismissing that finding would do nothing here: `/api/duplicates` filters on
    // `dupe_groups.status = 'open'` (src/api/findings.ts), a column a findings dismissal never
    // touches, so the group would simply reappear on the next load anyway. So this only hides the
    // card for the current session — the button is labelled and the empty state worded to say
    // exactly that, and a "Show hidden" control (see `unhideAll`) undoes it — rather than claiming
    // a persistence this screen cannot deliver.
    setDismissed((prev) => new Set(prev).add(groupId))
  }

  function unhideAll() {
    setDismissed(new Set())
  }

  async function handleMerge(group: DupeGroup) {
    setMergingId(group.id)
    setMergeErrors((prev) => {
      if (!(group.id in prev)) return prev
      const next = { ...prev }
      delete next[group.id]
      return next
    })
    try {
      await api.mergeGroup(group.id)
      list.reload()
    } catch (err) {
      setMergeErrors((prev) => ({ ...prev, [group.id]: err instanceof Error ? err.message : 'failed to merge versions' }))
    } finally {
      setMergingId(null)
    }
  }

  /**
   * `notYetQueued` is always the not-yet-queued difference for this group (see `notYetQueued`
   * below, computed from `queuedPathsByGroup`) — never the raw checked selection — so a click that
   * includes a path already sent to `onQueue` on an earlier click for this same group never sends
   * it again. Typed with `container_path` narrowed to `string` (via `queueableNonKeepers`'s type
   * predicate) rather than cast, so a missing path can never silently reach the action list.
   */
  function handleDeleteNonKeepers(
    group: DupeGroup,
    notYetQueued: Array<DupeMember & { container_path: string }>,
    skipped: number,
  ) {
    const actions: RequestedAction[] = notYetQueued.map((m) => ({
      type: 'delete-media',
      targetPath: m.container_path,
    }))
    onQueue(actions)
    setQueuedPathsByGroup((prev) => {
      const next = new Set(prev[group.id] ?? [])
      for (const m of notYetQueued) next.add(m.container_path)
      return { ...prev, [group.id]: next }
    })
    setQueuedFor((prev) => ({
      ...prev,
      [group.id]: { paths: notYetQueued.map(memberDisplayPath), skipped },
    }))
  }

  const allGroups = list.data?.groups ?? []
  const hiddenCount = allGroups.filter((g) => dismissed.has(g.id)).length
  const groups = allGroups.filter((g) => !dismissed.has(g.id))

  return (
    <div className="duplicates">
      {!list.data ? (
        list.error ? (
          <p className="alert" role="alert"><span>{list.error}</span></p>
        ) : (
          <EmptyState>Loading duplicate groups…</EmptyState>
        )
      ) : (
        <>
          {/* A reload that fails (e.g. right after a successful merge) must not erase the last-good
              groups still sitting in `list.data` — the error is shown ABOVE them, not instead of
              them, so a transient failure can never look like "there is nothing here". */}
          {list.error ? (
            <p className="alert" role="alert"><span>{list.error}</span></p>
          ) : null}

          {groups.length === 0 ? (
            hiddenCount > 0 ? (
              // Every remaining group is hidden this session — say exactly that (never the plain
              // "No duplicate groups found.", which would read as a clean bill of health) and give
              // the one control that undoes it, in the same message rather than a separate banner
              // that would otherwise duplicate this sentence.
              <p className="alert alert-warn dupe-hidden-notice" role="status">
                All {allGroups.length} duplicate group{allGroups.length === 1 ? '' : 's'} {allGroups.length === 1 ? 'is' : 'are'} hidden for this session.{' '}
                <button type="button" className="btn btn-quiet" onClick={unhideAll}>Show hidden</button>
              </p>
            ) : (
              <EmptyState>No duplicate groups found.</EmptyState>
            )
          ) : (
            <>
              {hiddenCount > 0 ? (
                <p className="alert alert-warn dupe-hidden-notice" role="status">
                  {hiddenCount} duplicate group{hiddenCount === 1 ? '' : 's'} hidden for this session.{' '}
                  <button type="button" className="btn btn-quiet" onClick={unhideAll}>Show hidden</button>
                </p>
              ) : null}
              {groups.map((group) => {
              const keeperId = resolveKeeper(group, keeperOverrides[group.id])
              const libraries = [...new Set(group.members.map((m) => m.library_name ?? '—'))]
              const crossLibrary = libraries.length > 1
              const isWhyOpen = whyOpen.has(group.id)
              const scoreKeys = [
                ...new Set(group.members.flatMap((m) => Object.keys(group.scores[m.id]?.breakdown ?? {}))),
              ]
              const isMerging = mergingId === group.id
              const mergeError = mergeErrors[group.id]

              const nonKeepers = group.members.filter((m) => m.id !== keeperId)
              const queueableNonKeepers = nonKeepers.filter((m): m is DupeMember & { container_path: string } => Boolean(m.container_path))
              const unqueueableCount = nonKeepers.length - queueableNonKeepers.length
              const selected = deleteSelections[group.id] ?? new Set<string>()
              const checkedQueueable = queueableNonKeepers.filter((m) => selected.has(m.id))
              // `matchedBy` is not guaranteed non-empty at runtime (an older group with no
              // corresponding open `dupe.group` finding reports it empty) — defaulted here rather
              // than trusted, same policy as `resolveKeeper` above.
              const matchedBy = group.matchedBy ?? []
              // MAJOR 1: the acknowledgement gate is evidence-based, never inferred from the tier
              // label alone. `possible`/`strong` are unaffected (dupe.fuzzy-title always emits
              // 'possible'; dupe.title-year/dupe.runtime always emit 'strong' — neither ever
              // touches file content) and still always require it. `tier === 'exact'` also covers
              // pure-metadata matchers (dupe.provider-id, dupe.series-episode), so it may ONLY skip
              // the acknowledgement when `matchedBy` shows every contributing matcher was a genuine
              // file-hash match (`isHashVerified`).
              const needsAck = group.tier !== 'exact' || !isHashVerified(matchedBy)
              const ackGiven = tierAck[group.id] === true
              const caveat = needsAck ? evidenceCaveat(group.tier, matchedBy) : null
              const matchedByText = matchedByLine(matchedBy)
              const queuedHere = queuedFor[group.id]
              // MINOR 2: only the not-yet-queued difference is ever sent to `onQueue` — a path this
              // group has already queued (`queuedPathsByGroup`) is never re-sent just because a
              // later click's checked selection happens to be a superset that still includes it.
              const alreadyQueuedPaths = queuedPathsByGroup[group.id] ?? new Set<string>()
              const notYetQueued = checkedQueueable.filter((m) => !alreadyQueuedPaths.has(m.container_path))
              const allCheckedAlreadyQueued = checkedQueueable.length > 0 && notYetQueued.length === 0
              const canDelete = notYetQueued.length > 0 && (!needsAck || ackGiven)
              const deleteLabel = allCheckedAlreadyQueued
                ? 'Queued for deletion'
                : checkedQueueable.length > 0
                  ? `Delete non-keepers (${checkedQueueable.length})`
                  : 'Delete non-keepers'

              const mergeNoteId = `dupe-merge-note-${group.id}`
              const deleteNoteId = `dupe-delete-note-${group.id}`

              return (
                <section className="panel dupe-group" key={group.id}>
                  <header className="dupe-group-header">
                    <span className={tierTagClass(group.tier)}>{group.tier}</span>
                    {/* A title comes straight from Jellyfin metadata — a text node only. */}
                    <h3>{group.members[0]?.name ?? group.id}</h3>
                  </header>

                  {matchedByText ? (
                    <p className="dupe-matched-by">{matchedByText}</p>
                  ) : null}

                  {crossLibrary ? (
                    <p className="alert alert-warn" role="status">
                      These copies live across libraries: {libraries.join(', ')}.
                    </p>
                  ) : null}

                  {caveat ? (
                    <p className="alert alert-warn" role="status">{caveat}</p>
                  ) : null}

                  <table className="table dupe-table">
                    <thead>
                      <tr>
                        <th scope="col">Keep</th>
                        <th scope="col">Delete</th>
                        <th scope="col">Path</th>
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
                                  {isKeeper ? 'keeper' : 'non-keeper'}
                                </span>
                              </label>
                            </td>
                            <td>
                              {isKeeper ? null : m.container_path ? (
                                <label className="dupe-delete-checkbox">
                                  <input
                                    type="checkbox"
                                    checked={selected.has(m.id)}
                                    onChange={() => toggleDeleteSelection(group.id, m.id)}
                                    aria-label={`Delete ${memberDisplayPath(m)}`}
                                  />
                                </label>
                              ) : (
                                <span className="tag tag-quiet">no known path — cannot be queued</span>
                              )}
                            </td>
                            {/* container_path (or, absent that, name) is a value from the scanned
                                library — a text node only, never markup. */}
                            <td className="subject-path">{memberDisplayPath(m)}</td>
                            <td>{formatResolution(m.height)}</td>
                            <td>{formatBitrate(m.bitrate)}</td>
                            <td>{m.video_codec ?? '—'}</td>
                            <td>{formatAudioChannels(m.audio_channels)}</td>
                            <td><Bytes value={m.size_bytes ?? null} /></td>
                            <td>{m.library_name ?? '—'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>

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

                  {mergeError ? (
                    <p className="alert" role="alert"><span>{mergeError}</span></p>
                  ) : null}

                  {needsAck ? (
                    <label className="dupe-tier-ack">
                      <input type="checkbox" checked={ackGiven} onChange={() => toggleTierAck(group.id)} />
                      {tierAckLabel(group.tier, matchedBy)}
                    </label>
                  ) : null}

                  <div className="dupe-actions">
                    <div className="dupe-action">
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={isMerging}
                        aria-busy={isMerging}
                        aria-describedby={mergeNoteId}
                        onClick={() => void handleMerge(group)}
                      >
                        Merge versions
                      </button>
                      <span id={mergeNoteId} className="dupe-action-note tag tag-ok">reversible — Jellyfin merge</span>
                    </div>
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
                    <button type="button" className="btn btn-quiet" onClick={() => dismissGroup(group.id)}>
                      Hide for this session
                    </button>
                  </div>

                  {queuedHere ? (
                    <p className="dupe-queued-note" role="status">
                      Queued {queuedHere.paths.length} file{queuedHere.paths.length === 1 ? '' : 's'} for deletion:{' '}
                      {queuedHere.paths.join(', ')}.
                      {queuedHere.skipped > 0
                        ? ` Skipped ${queuedHere.skipped} member${queuedHere.skipped === 1 ? '' : 's'} with no known path.`
                        : ''}
                    </p>
                  ) : null}
                </section>
                )
              })}
            </>
          )}
        </>
      )}
    </div>
  )
}
