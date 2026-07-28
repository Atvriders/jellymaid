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
 * strongest evidence, never its weakest. Two things fall out of that which this screen leans on
 * directly:
 *
 *   - `tier === 'exact'` means at least one pairwise link was byte-verified (provider id, series
 *     episode key, or identical file hash — the only three matchers in `src/rules/dupes/index.ts`
 *     that ever emit `'exact'`).
 *   - `tier === 'possible'` means NO link in the group reached `'strong'` or `'exact'` — and
 *     `dupe.fuzzy-title` is the only matcher that ever emits `'possible'` — so a `possible` group
 *     is, by construction, matched by title-similarity alone. That is a structural fact of the
 *     rule set, not the (unavailable) per-link `matchedBy` data — see the note on
 *     `/api/duplicates`'s response shape below.
 *
 * This screen never trusts the shared `<TierBadge>` for this tag: that component renders
 * `possible` with the same quiet, muted tint as an unrelated "info" severity — visually calmer
 * than `strong`, even though `possible` is the LEAST confirmed of the three tiers. Escalating
 * rather than de-escalating, `possible` gets the same warning weight as `strong` here; only
 * `exact` — actual byte/ID proof — earns the calm, positive tag.
 */
function tierTagClass(tier: string): string {
  if (tier === 'exact') return 'tag tag-ok'
  return 'tag tag-warn'
}

/**
 * A non-exact tier's plain-language caveat, shown next to the tag so the operator reads it before
 * ever reaching the delete controls. Worded per the reasoning in `tierTagClass` above: `possible`
 * can be named exactly ("title similarity only") because that is the only rule that ever produces
 * it; `strong` cannot be narrowed to one matcher (title/year and runtime both emit it, and a group
 * can carry links from either or both), so its caveat stays general rather than guessing.
 *
 * Note on `matchedBy`: `src/rules/dupes/adapter.ts` computes a per-finding `matchedBy` list, but
 * `/api/duplicates` (src/api/findings.ts) reads from the separate `dupe_groups` table, which only
 * ever stores `id, tier, members_json, keeper_item_id, scores_json, status` — `matchedBy` never
 * reaches this screen. Rather than inventing a field the wire shape does not carry, this caveat is
 * derived only from `tier`, which the client does have and which — per the reasoning above — is
 * itself sufficient to say what it says truthfully.
 */
function tierCaveat(tier: string): string | null {
  if (tier === 'possible') {
    return 'Matched by title similarity only (dupe.fuzzy-title) — a hypothesis, not a confirmed duplicate. Verify manually before deleting anything.'
  }
  if (tier === 'strong') {
    return 'Matched by title/year proximity or runtime similarity, not a provider ID or file hash — verify before deleting.'
  }
  return null
}

function tierAckLabel(tier: string): string {
  const suffix = tier === 'possible' ? 'title-similarity guess' : 'title/runtime coincidence'
  return `I have verified this is a real duplicate, not just a ${suffix}.`
}

interface QueuedConfirmation {
  selectionKey: string
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
 *   4. A less-than-exact tier requires an explicit, separate acknowledgement before Delete
 *      non-keepers can be clicked at all, on top of the per-row checkboxes: confidence and consent
 *      to delete are gated independently, since a fuzzy title match is a much weaker basis for a
 *      permanent action than a provider-id or file-hash match.
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

  // A fresh fetch — the initial load, or any later reload — must never carry forward a stale
  // per-row selection, tier acknowledgement, or "already queued" guard from a previous render of
  // (possibly different) groups. `list.data` is a new object on every successful fetch even when
  // its contents are unchanged, so keying off it here also satisfies "no box checked right after a
  // data refresh", not just at first mount.
  useEffect(() => {
    setDeleteSelections({})
    setTierAck({})
    setQueuedFor({})
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

  function handleDeleteNonKeepers(group: DupeGroup, targets: DupeMember[], skipped: number, selectionKey: string) {
    const actions: RequestedAction[] = targets.map((m) => ({
      type: 'delete-media',
      // `targets` is always built from members whose `container_path` was already checked
      // non-null (see `queueableNonKeepers` below) — never from `deleteSelections` directly — so
      // this can never silently coerce a missing path into the action list.
      targetPath: m.container_path as string,
    }))
    onQueue(actions)
    setQueuedFor((prev) => ({
      ...prev,
      [group.id]: { selectionKey, paths: targets.map(memberDisplayPath), skipped },
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
                All {allGroups.length} duplicate group{allGroups.length === 1 ? '' : 's'} are hidden for this session.{' '}
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
              const selectionKey = checkedQueueable.map((m) => m.id).sort().join(',')
              const needsAck = group.tier !== 'exact'
              const ackGiven = tierAck[group.id] === true
              const caveat = tierCaveat(group.tier)
              const queuedHere = queuedFor[group.id]
              const alreadyQueuedForSelection = selectionKey !== '' && queuedHere?.selectionKey === selectionKey
              const canDelete = checkedQueueable.length > 0 && (!needsAck || ackGiven) && !alreadyQueuedForSelection
              const deleteLabel = alreadyQueuedForSelection
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
                      {tierAckLabel(group.tier)}
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
                        onClick={() => handleDeleteNonKeepers(group, checkedQueueable, unqueueableCount, selectionKey)}
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
