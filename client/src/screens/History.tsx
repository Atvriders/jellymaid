import { useState } from 'react'
import type { Api, ExecutionSummary, RequestedAction } from '../api.js'
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
 * rather than overloading `outcomeTagClass` with a status that vocabulary does not use. Kept
 * identical to PlanScreen's own `planStatusTagClass` (client/src/screens/PlanScreen.tsx) — an
 * `approved` plan must read the same way, armed and pre-authorised, wherever it is shown. */
function planStatusTagClass(status: string): string {
  if (status === 'completed') return 'tag tag-ok'
  if (status === 'failed') return 'tag tag-block'
  if (status === 'running' || status === 'approved') return 'tag tag-warn'
  return 'tag tag-quiet' // draft
}

/** Same "did this run actually do anything" honesty check PlanScreen applies to its own execution
 * summary (see PlanScreen.tsx's `isHollowExecution`), duplicated here rather than imported: Resume
 * runs the identical executor and can return the identical shape, and a resume where every
 * remaining action was blocked or skipped must not read as an ordinary clean "completed" pass
 * either. */
function isHollowExecution(summary: ExecutionSummary): boolean {
  return summary.done === 0 && summary.blocked + summary.skipped > 0
}

function ExecutionSummaryLine({ summary }: { summary: ExecutionSummary }) {
  const text = (
    <>
      Execution {summary.status}: {summary.done} done, {summary.failed} failed,{' '}
      {summary.skipped} skipped, {summary.blocked} blocked — <Bytes value={summary.bytesFreed} /> freed.
    </>
  )
  return isHollowExecution(summary)
    ? <p className="alert alert-warn" role="status">{text}</p>
    : <p className="plan-execution-summary" role="status">{text}</p>
}

/**
 * The record of what Jellymaid has actually done, and the three ways an operator can act on that
 * record after the fact: undoing a reversible merge, restoring something from the trash, and
 * nudging a plan a crashed process left stuck mid-run. The first two are never a fresh destructive
 * action in their own right; Resume is the one exception, and this screen must not undersell it —
 *
 *   - "Undo merge" only ever QUEUES a `split-versions` action (same queue-then-plan discipline as
 *     Findings/Duplicates/Explorer); it does not call Jellyfin directly from here.
 *   - "Restore" calls the one route built for exactly this (`POST /api/trash/:id/restore`), which
 *     itself refuses a replay or a missing file rather than doing anything destructive.
 *   - "Resume" is the documented crash-recovery path (`POST /api/plans/:id/resume`) for a plan
 *     stuck `running` — offered ONLY for that status, since resuming anything else either does
 *     nothing (already-terminal plans) or races a run that is not actually dead. It is NOT a
 *     passive nudge: the route flips the plan back to `approved` and calls the SAME executor
 *     `POST /api/plans/:id/execute` uses, which runs `deleteWithData` and `unlinkSync` for every
 *     action still `pending` — a real, files-and-torrents-gone destructive tail, not a status
 *     flip. Its returned `ExecutionSummary` is rendered exactly as PlanScreen renders one
 *     (`ExecutionSummaryLine` above), never discarded after a bare `plans.reload()`.
 *   - "Open" is not destructive at all — it hands a plan's id up to the shell (`onOpenPlan`) so
 *     the Plan screen can load and render it via `api.getPlan`. It is the only way back into a
 *     plan once its own screen has been navigated away from and returned to (see App.tsx's
 *     `planId`), and the only way to reach an `approved` plan at all: Resume's server semantics
 *     are `running`-only (src/api/plans.ts), so offering it for `approved` would just 400.
 *
 * Every non-`done` audit outcome still shows whatever bytes it froze: a per-action failure does
 * not abort the plan (src/plan/executor.ts runs every action regardless of an earlier one's
 * outcome), and a `failed`/`skipped` row can carry real freed bytes (e.g. "the file was deleted,
 * but the Jellyfin item could not be removed" reports `failed` with a nonzero `bytesFreed`) — this
 * screen must never let a non-`done` label read as "nothing happened" when the audit row itself
 * says otherwise.
 */
export function History({ api, onQueue, onOpenPlan }: {
  api: HistoryApi
  onQueue: (actions: RequestedAction[]) => void
  onOpenPlan: (id: string) => void
}) {
  const audit = useAsync(() => api.audit())
  const plans = useAsync(() => api.plans())
  const trash = useAsync(() => api.trash())

  const [resumingId, setResumingId] = useState<string | null>(null)
  const [resumeError, setResumeError] = useState<string | null>(null)
  const [resumeSummary, setResumeSummary] = useState<ExecutionSummary | null>(null)

  const [restoringId, setRestoringId] = useState<string | null>(null)
  const [restoreNotes, setRestoreNotes] = useState<Record<string, string>>({})

  const [queuedUndos, setQueuedUndos] = useState<Set<string>>(new Set())

  async function resume(id: string) {
    setResumingId(id)
    setResumeError(null)
    setResumeSummary(null)
    try {
      // MAJOR finding: this used to discard the returned ExecutionSummary entirely and only
      // reload the plans list — a resume that ran a real destructive tail (deleteWithData,
      // unlinkSync for every still-pending action) reported NONE of it: not what ran, not what
      // failed, not what was freed. Render it exactly as PlanScreen does.
      const result = await api.resumePlan(id)
      setResumeSummary(result)
      plans.reload()
      // A resume writes new audit rows for every action in its unfinished tail — the audit trail
      // above must not go on showing the pre-resume record until an unrelated action reloads it.
      audit.reload()
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
        {resumeSummary ? <ExecutionSummaryLine summary={resumeSummary} /> : null}
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
                <th scope="col">Actions</th>
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
                    <div className="history-plan-actions">
                      {/* The only route back into a plan once this screen has been navigated away
                          from — including an `approved` one, which Resume (below) cannot reach at
                          all: its server semantics are `running`-only. Hands the id up to the
                          shell, which switches to Plan and lets it load via `api.getPlan`. */}
                      <button type="button" className="btn btn-quiet" onClick={() => onOpenPlan(p.id)}>
                        Open
                      </button>
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
                    </div>
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
                {/* MINOR finding: `purgeAfter` is on the wire (api.ts's TrashEntry) and, until now,
                    never rendered — the one screen that says a file is recoverable never said when
                    that stops being true. */}
                <th scope="col">Recoverable until</th>
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
                  <td className="subject-path">{t.purgeAfter}</td>
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
