import { useState } from 'react'
import type { Api, RequestedAction } from '../api.js'
import { useAsync } from '../hooks.js'
import { Bytes, EmptyState } from '../components/index.js'

type HistoryApi = Pick<Api, 'audit' | 'plans' | 'trash' | 'restoreTrash' | 'resumePlan'>

interface AuditAfter {
  bytesFreed?: number
  /** The Duplicates screen's direct merge shortcut (POST /api/duplicates/:id/merge) writes this key. */
  mergedItemIds?: string[]
  /** The executor's OWN merge-versions action (a queued-and-approved plan) writes this one instead —
   * see src/plan/executor.ts's `detail: { merged: ids }` vs src/api/plans.ts's `after: { mergedItemIds: ids }`.
   * Both name the same fact; History must recognise either shape, not just whichever path is more common today. */
  merged?: string[]
}

function parseAfter(json: string | null): AuditAfter {
  if (!json) return {}
  try {
    const parsed: unknown = JSON.parse(json)
    return typeof parsed === 'object' && parsed !== null ? (parsed as AuditAfter) : {}
  } catch {
    return {}
  }
}

/** Same escalating-weight tag vocabulary as the rest of the app, applied to an audit row's outcome
 * (pending/running/done/failed/skipped/blocked — the same ACTION_STATUSES the executor writes,
 * plus 'done' for the two non-executor audit sources: the duplicate-merge shortcut and the batched
 * refresh). A skip or a block is a caution, not a clean pass, and a failure is as loud as a guard
 * block — never softened just because the action already ran. */
function outcomeTagClass(outcome: string): string {
  if (outcome === 'done') return 'tag tag-ok'
  if (outcome === 'failed' || outcome === 'blocked') return 'tag tag-block'
  if (outcome === 'skipped' || outcome === 'running') return 'tag tag-warn'
  return 'tag tag-quiet'
}

/** A plan's own status vocabulary (draft/approved/running/completed/failed) is a different scale
 * from an action's — a plan is never itself "blocked" or "skipped" — so it gets its own mapping
 * rather than overloading `outcomeTagClass` with a status that vocabulary does not use. */
function planStatusTagClass(status: string): string {
  if (status === 'completed') return 'tag tag-ok'
  if (status === 'failed') return 'tag tag-block'
  if (status === 'running' || status === 'approved') return 'tag tag-warn'
  return 'tag tag-quiet' // draft
}

/**
 * The record of what Jellymaid has actually done, and the two ways an operator can act on that
 * record after the fact: undoing a reversible merge, restoring something from the trash, and
 * nudging a plan a crashed process left stuck mid-run. None of these three is a fresh destructive
 * action in its own right —
 *
 *   - "Undo merge" only ever QUEUES a `split-versions` action (same queue-then-plan discipline as
 *     Findings/Duplicates/Explorer); it does not call Jellyfin directly from here.
 *   - "Restore" calls the one route built for exactly this (`POST /api/trash/:id/restore`), which
 *     itself refuses a replay or a missing file rather than doing anything destructive.
 *   - "Resume" is the documented crash-recovery path (`POST /api/plans/:id/resume`) for a plan
 *     stuck `running` — offered ONLY for that status, since resuming anything else either does
 *     nothing (already-terminal plans) or races a run that is not actually dead.
 *
 * Every non-`done` audit outcome still shows whatever bytes it froze: a per-action failure does
 * not abort the plan (src/plan/executor.ts runs every action regardless of an earlier one's
 * outcome), and a `failed`/`skipped` row can carry real freed bytes (e.g. "the file was deleted,
 * but the Jellyfin item could not be removed" reports `failed` with a nonzero `bytesFreed`) — this
 * screen must never let a non-`done` label read as "nothing happened" when the audit row itself
 * says otherwise.
 */
export function History({ api, onQueue }: { api: HistoryApi; onQueue: (actions: RequestedAction[]) => void }) {
  const audit = useAsync(() => api.audit())
  const plans = useAsync(() => api.plans())
  const trash = useAsync(() => api.trash())

  const [resumingId, setResumingId] = useState<string | null>(null)
  const [resumeError, setResumeError] = useState<string | null>(null)

  const [restoringId, setRestoringId] = useState<string | null>(null)
  const [restoreNotes, setRestoreNotes] = useState<Record<string, string>>({})

  const [queuedUndos, setQueuedUndos] = useState<Set<string>>(new Set())

  async function resume(id: string) {
    setResumingId(id)
    setResumeError(null)
    try {
      await api.resumePlan(id)
      plans.reload()
    } catch (err) {
      setResumeError(err instanceof Error ? err.message : 'failed to resume plan')
    } finally {
      setResumingId(null)
    }
  }

  async function restore(id: string) {
    setRestoringId(id)
    try {
      const result = await api.restoreTrash(id)
      setRestoreNotes((prev) => ({
        ...prev,
        // `restoreFromTrash` always explains a refusal (`reason`); a success carries none because
        // none is needed, so the row's own now-set `restoredAt` (after the reload below) is what
        // says so.
        [id]: result.restored ? '' : (result.reason ?? 'could not be restored'),
      }))
      trash.reload()
    } catch (err) {
      setRestoreNotes((prev) => ({ ...prev, [id]: err instanceof Error ? err.message : 'failed to restore' }))
    } finally {
      setRestoringId(null)
    }
  }

  function undoMerge(key: string, itemIds: string[]) {
    const primary = itemIds[0]
    if (!primary) return
    // Splitting the PRIMARY item back apart is what Jellyfin's own `/Videos/{id}/AlternateSources`
    // DELETE expects (see src/connectors/jellyfin.ts and src/plan/executor.ts's split-versions
    // case, which only ever reads `itemIds[0]`) — undoing a merge is not "split every merged id",
    // it is "split the one item that now holds every version as a MediaSource".
    onQueue([{ type: 'split-versions', itemIds: [primary] }])
    setQueuedUndos((prev) => new Set(prev).add(key))
  }

  return (
    <div className="history">
      <section className="panel history-section history-audit">
        <h2>Audit trail</h2>
        {audit.error ? (
          <p className="alert" role="alert"><span>{audit.error}</span></p>
        ) : !audit.data ? (
          <EmptyState>Loading audit trail…</EmptyState>
        ) : audit.data.entries.length === 0 ? (
          <EmptyState>Nothing has been done yet.</EmptyState>
        ) : (
          <table className="table history-audit-table">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Actor</th>
                <th scope="col">Action</th>
                <th scope="col">Subject</th>
                <th scope="col">Outcome</th>
                <th scope="col">Bytes freed</th>
                <th scope="col">Undo</th>
              </tr>
            </thead>
            <tbody>
              {audit.data.entries.map((e, i) => {
                const after = parseAfter(e.afterJson)
                const mergedItemIds = after.mergedItemIds ?? after.merged
                const key = `${e.ts}-${i}`
                const canUndoMerge = e.actionType === 'merge-versions' && e.outcome === 'done' && (mergedItemIds?.length ?? 0) > 0
                const alreadyQueued = queuedUndos.has(key)
                return (
                  <tr key={key}>
                    {/* Every field here — actor, subject, the raw action/outcome strings — is
                        either a Jellymaid-internal identifier or text carried straight from a
                        scanned filesystem/torrent; all render as text nodes only. */}
                    <td className="subject-path">{e.ts}</td>
                    <td>{e.actor}</td>
                    <td><code>{e.actionType}</code></td>
                    <td className="subject-path">{e.subject}</td>
                    <td><span className={outcomeTagClass(e.outcome)}>{e.outcome}</span></td>
                    <td>{after.bytesFreed !== undefined ? <Bytes value={after.bytesFreed} /> : '—'}</td>
                    <td>
                      {canUndoMerge ? (
                        <button
                          type="button"
                          className="btn btn-quiet"
                          disabled={alreadyQueued}
                          onClick={() => undoMerge(key, mergedItemIds!)}
                        >
                          {alreadyQueued ? 'Queued' : 'Undo merge'}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel history-section history-plans">
        <h2>Plans</h2>
        {resumeError ? <p className="alert" role="alert"><span>{resumeError}</span></p> : null}
        {plans.error ? (
          <p className="alert" role="alert"><span>{plans.error}</span></p>
        ) : !plans.data ? (
          <EmptyState>Loading plans…</EmptyState>
        ) : plans.data.plans.length === 0 ? (
          <EmptyState>No plans have been built yet.</EmptyState>
        ) : (
          <table className="table history-plans-table">
            <thead>
              <tr>
                <th scope="col">Plan</th>
                <th scope="col">Created</th>
                <th scope="col">By</th>
                <th scope="col">Status</th>
                <th scope="col">Bytes freed</th>
                <th scope="col">Resume</th>
              </tr>
            </thead>
            <tbody>
              {plans.data.plans.map((p) => (
                <tr key={p.id}>
                  <td><code>{p.id}</code></td>
                  <td className="subject-path">{p.createdAt}</td>
                  <td>{p.createdBy}</td>
                  <td><span className={planStatusTagClass(p.status)}>{p.status}</span></td>
                  <td><Bytes value={p.dryRun.bytesFreed} /></td>
                  <td>
                    {/* Offered ONLY for `running` — the crash-recovery path (spec §13). Anything
                        else either has nothing left to resume (draft/approved/completed/failed) or
                        risks racing a run that is not actually dead. */}
                    {p.status === 'running' ? (
                      <button
                        type="button"
                        className="btn btn-danger"
                        disabled={resumingId === p.id}
                        aria-busy={resumingId === p.id}
                        onClick={() => void resume(p.id)}
                      >
                        Resume
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel history-section history-trash">
        <h2>Trash</h2>
        {trash.error ? (
          <p className="alert" role="alert"><span>{trash.error}</span></p>
        ) : !trash.data ? (
          <EmptyState>Loading trash…</EmptyState>
        ) : trash.data.entries.length === 0 ? (
          <EmptyState>Nothing is in the trash.</EmptyState>
        ) : (
          <table className="table history-trash-table">
            <thead>
              <tr>
                <th scope="col">Path</th>
                <th scope="col">Size</th>
                <th scope="col">Deleted</th>
                <th scope="col">Status</th>
                <th scope="col">Restore</th>
              </tr>
            </thead>
            <tbody>
              {trash.data.entries.map((t) => (
                <tr key={t.id}>
                  <td className="subject-path">{t.originalPath}</td>
                  <td><Bytes value={t.sizeBytes} /></td>
                  <td className="subject-path">{t.deletedAt}</td>
                  <td>
                    <span className={t.restoredAt ? 'tag tag-ok' : 'tag tag-quiet'}>
                      {t.restoredAt ? 'restored' : 'trashed'}
                    </span>
                    {restoreNotes[t.id] ? <p className="history-restore-note">{restoreNotes[t.id]}</p> : null}
                  </td>
                  <td>
                    {/* `restored_at IS NULL` is the server's own replay guard (src/plan/trash.ts) —
                        mirrored here so a second click is never even offered once one restore has
                        succeeded, rather than relying on the server to refuse a redundant one. */}
                    {t.restoredAt === null ? (
                      <button
                        type="button"
                        className="btn btn-quiet"
                        disabled={restoringId === t.id}
                        aria-busy={restoringId === t.id}
                        onClick={() => void restore(t.id)}
                      >
                        Restore
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
