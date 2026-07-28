import { useState } from 'react'
import type { Api, DupeGroup, DupeMember, RequestedAction } from '../api.js'
import { useAsync } from '../hooks.js'
import { Bytes, EmptyState, TierBadge } from '../components/index.js'

type DuplicatesApi = Pick<Api, 'duplicates' | 'mergeGroup'>

function formatResolution(height: number | null | undefined): string {
  if (height === null || height === undefined) return '—'
  return `${height}p`
}

function formatBitrate(bitrate: number | null | undefined): string {
  if (bitrate === null || bitrate === undefined) return '—'
  return `${(bitrate / 1_000_000).toFixed(1)} Mbps`
}

// Friendly display names for src/rules/keeper.ts's breakdown keys. Deliberately worded so none of
// them collides with this screen's own member-table column headers ("Res.", "Bit rate", "Video
// codec", "File size") — both tables can be visible at once, and a duplicated literal string
// between them would make the two impossible to tell apart by a screen reader or a test alike.
// Falls back to the raw key for anything not in this map, so an unrecognised weight still renders
// rather than silently vanishing from the audit trail.
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
 * The highest-stakes screen in the app: an operator picks which copy of a film survives and which
 * gets permanently deleted along with its torrent data. Two things this screen must never blur
 * together (see the task brief's server truths):
 *
 *   1. Merge and delete are different operations with different reversibility. Merge Versions is
 *      a reversible Jellyfin metadata change (`POST /api/duplicates/:id/merge`, see
 *      src/api/plans.ts); "Delete non-keepers" only ever QUEUES a `delete-media` action for the
 *      Plan screen — the file itself is not touched until that plan is later built, approved and
 *      executed. Both buttons carry their own reversibility label right next to them, not in a
 *      tooltip, and only Delete gets the app's one reserved destructive button style.
 *   2. The keeper is a recommendation, not a verdict — every row is a radio the operator can move,
 *      and "Why" reveals the actual score breakdown that produced the recommendation, so the
 *      choice is auditable rather than asserted.
 */
export function Duplicates({ api, onQueue }: { api: DuplicatesApi; onQueue: (actions: RequestedAction[]) => void }) {
  const list = useAsync(api.duplicates)

  const [keeperOverrides, setKeeperOverrides] = useState<Record<string, string>>({})
  const [whyOpen, setWhyOpen] = useState<Set<string>>(new Set())
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [mergingId, setMergingId] = useState<string | null>(null)
  const [mergeErrors, setMergeErrors] = useState<Record<string, string>>({})

  function chooseKeeper(group: DupeGroup, memberId: string) {
    setKeeperOverrides((prev) => ({ ...prev, [group.id]: memberId }))
  }

  function toggleWhy(groupId: string) {
    setWhyOpen((prev) => {
      const next = new Set(prev)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }

  function dismissGroup(groupId: string) {
    // There is no persisted per-group dismiss on the server: `dupe_groups.status` only ever holds
    // 'open' or 'merged' (src/index/migrations/001_init.sql), and the Finding this group was built
    // from has a DIFFERENT id (a hash over the rule id, see `findingId` in src/core/types.ts) than
    // this group's own id (a hash over just the member ids, see `buildDupeGroups` in
    // src/rules/grouping.ts) — there is no way to recover the finding id from what this screen was
    // sent without duplicating the server's private hashing scheme. Calling `dismissFinding` with
    // this group's id would silently 404 against an unrelated (nonexistent) finding. So this only
    // hides the card for the current session; it does not claim to persist anything it can't.
    setDismissed((prev) => new Set(prev).add(groupId))
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

  function handleDeleteNonKeepers(group: DupeGroup) {
    const keeperId = resolveKeeper(group, keeperOverrides[group.id])
    const actions: RequestedAction[] = []
    for (const m of group.members) {
      if (m.id === keeperId) continue
      // A member with no known filesystem path cannot be turned into a `delete-media` target —
      // skipped rather than queuing an action the executor could never carry out.
      if (!m.container_path) continue
      actions.push({ type: 'delete-media', targetPath: m.container_path })
    }
    onQueue(actions)
  }

  const groups = (list.data?.groups ?? []).filter((g) => !dismissed.has(g.id))

  return (
    <div className="duplicates">
      {list.error ? (
        <p className="alert" role="alert"><span>{list.error}</span></p>
      ) : !list.data ? (
        <EmptyState>Loading duplicate groups…</EmptyState>
      ) : groups.length === 0 ? (
        <EmptyState>No duplicate groups found.</EmptyState>
      ) : (
        groups.map((group) => {
          const keeperId = resolveKeeper(group, keeperOverrides[group.id])
          const libraries = [...new Set(group.members.map((m) => m.library_name ?? '—'))]
          const crossLibrary = libraries.length > 1
          const isWhyOpen = whyOpen.has(group.id)
          const scoreKeys = [
            ...new Set(group.members.flatMap((m) => Object.keys(group.scores[m.id]?.breakdown ?? {}))),
          ]
          const isMerging = mergingId === group.id
          const mergeError = mergeErrors[group.id]

          return (
            <section className="panel dupe-group" key={group.id}>
              <header className="dupe-group-header">
                <TierBadge tier={group.tier} />
                {/* A title comes straight from Jellyfin metadata — a text node only. */}
                <h3>{group.members[0]?.name ?? group.id}</h3>
              </header>

              {crossLibrary ? (
                <p className="alert alert-warn" role="status">
                  These copies live across libraries: {libraries.join(', ')}.
                </p>
              ) : null}

              <table className="table dupe-table">
                <thead>
                  <tr>
                    <th scope="col">Keep</th>
                    <th scope="col">Path</th>
                    <th scope="col">Res.</th>
                    <th scope="col">Bit rate</th>
                    <th scope="col">Video codec</th>
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
                        {/* container_path is a filesystem path from the scanned library — a text
                            node only, never markup. */}
                        <td className="subject-path">{m.container_path ?? '—'}</td>
                        <td>{formatResolution(m.height)}</td>
                        <td>{formatBitrate(m.bitrate)}</td>
                        <td>{m.video_codec ?? '—'}</td>
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

              <div className="dupe-actions">
                <div className="dupe-action">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={isMerging}
                    aria-busy={isMerging}
                    onClick={() => void handleMerge(group)}
                  >
                    Merge versions
                  </button>
                  <span className="dupe-action-note tag tag-ok">reversible — Jellyfin merge</span>
                </div>
                <div className="dupe-action">
                  <button type="button" className="btn btn-danger" onClick={() => handleDeleteNonKeepers(group)}>
                    Delete non-keepers
                  </button>
                  <span className="dupe-action-note tag tag-block">permanent — deletes files and torrent data</span>
                </div>
                <button type="button" className="btn btn-quiet" onClick={() => dismissGroup(group.id)}>
                  Dismiss
                </button>
              </div>
            </section>
          )
        })
      )}
    </div>
  )
}
