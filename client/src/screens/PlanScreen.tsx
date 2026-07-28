import { useEffect, useState } from 'react'
import type { Api, ExecutionSummary, GuardId, PlanActionView, PlanView, RequestedAction } from '../api.js'
import { Bytes, EmptyState, GuardVerdictList } from '../components/index.js'

type PlanApi = Pick<Api, 'createPlan' | 'getPlan' | 'approvePlan' | 'executePlan'>

const ACTION_TYPE_LABEL: Record<PlanActionView['type'], string> = {
  'merge-versions': 'Merge versions',
  'split-versions': 'Split versions',
  'delete-media': 'Delete media file',
  'delete-junk-file': 'Delete junk file',
  'remove-empty-folder': 'Remove empty folder',
}

/** Same escalating-weight tag vocabulary as everywhere else in the app: a terminal failure or a
 * block reads as loud as a guard block does, `running`/`skipped` get the warn tint (something is
 * unresolved or did not go as planned, not necessarily wrong), and `pending`/`done` are quiet.
 * ACTION statuses only — see `planStatusTagClass` below for the PLAN's own, different vocabulary. */
function statusTagClass(status: string): string {
  if (status === 'blocked' || status === 'failed') return 'tag tag-block'
  if (status === 'skipped' || status === 'running') return 'tag tag-warn'
  if (status === 'done') return 'tag tag-ok'
  return 'tag tag-quiet' // pending
}

/** A plan's own status vocabulary (draft/approved/running/completed/failed) is a different scale
 * from an action's — a plan is never itself "blocked" or "skipped" — so it gets its own mapping
 * rather than being read through `statusTagClass` above. Kept identical to History's own
 * `planStatusTagClass` (client/src/screens/History.tsx), which explains the same reasoning: an
 * `approved` plan — armed, pre-authorised, and the one state that shows the red Execute button —
 * must not render as the quietest tag on the screen. */
function planStatusTagClass(status: string): string {
  if (status === 'completed') return 'tag tag-ok'
  if (status === 'failed') return 'tag tag-block'
  if (status === 'running' || status === 'approved') return 'tag tag-warn'
  return 'tag tag-quiet' // draft
}

/** "Execution completed" must not headline a run that did nothing: `summary.status` is only
 * `'failed'` when at least one action actually failed (src/plan/executor.ts), so a plan every one
 * of whose remaining actions was blocked or skipped still reports `'completed'` — honest about the
 * word, misleading about the tone. This reads as a caution (the `alert alert-warn` treatment
 * already used elsewhere on this screen) rather than a plain, quiet paragraph whenever nothing was
 * actually done and something held it back. */
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

function targetLabel(payload: RequestedAction): string {
  if (payload.targetPath) return payload.targetPath
  if (payload.itemIds?.length) return payload.itemIds.join(', ')
  return '—'
}

/**
 * Rebuilding sends exactly what the operator queued PLUS whatever overrides they have selected
 * for each row — never anything read off `payload.resolution` (the executor/planner's internal,
 * server-computed detail that rides along on `getPlan`/`createPlan` responses) and never a
 * `overrides` key at all for a row with nothing selected, so a fresh build and a "rebuild with no
 * overrides chosen" produce identical requests.
 */
function toRequestedAction(action: PlanActionView, overrides: string[]): RequestedAction {
  const req: RequestedAction = { type: action.type }
  if (action.payload.targetPath !== undefined) req.targetPath = action.payload.targetPath
  if (action.payload.itemIds !== undefined) req.itemIds = action.payload.itemIds
  // Every string collected here came from a real GuardVerdict.guard on THIS action (see
  // toggleOverride below), which is already typed GuardId server-side — this cast merely restores
  // that fact after it was widened to `string` by GuardVerdictList's own generic prop shape.
  if (overrides.length > 0) req.overrides = overrides as GuardId[]
  return req
}

/**
 * The approval gate the whole product funnels through. Two things this screen must never blur,
 * both the direct result of code review findings against the planner/executor (see src/plan/
 * guards.ts and src/plan/executor.ts) — and both checked here against the ACTUAL code, not just
 * paraphrased, since the second is easy to get backwards:
 *
 *   1. A guard verdict shown here is a SNAPSHOT from when the plan was (re)built. `approvePlan`
 *      (src/plan/planner.ts) is a synchronous status flip with no I/O at all — it does NOT re-run
 *      guards against live state; it only confirms the plan still has at least one action that
 *      was not already blocked when it was built. The ONLY re-check against live state happens
 *      once, immediately before each action executes (src/plan/executor.ts's `runPathAction`).
 *      So the true gap an operator is trusting is "build/rebuild time" all the way through to the
 *      moment execute actually reaches that action — approving does not shrink it. This screen
 *      says so in plain language rather than letting a row full of quiet tags imply a freshness
 *      check that does not exist.
 *   2. An override only ever pre-authorises a guard that is ACTUALLY BLOCKING THE ACTION IT NAMES
 *      in the plan being approved. The executor intersects a stored override with the guard set
 *      that was blocking in THAT approved snapshot — never with whatever blocks at execute time —
 *      so an override can never silently clear a DIFFERENT guard that starts blocking later.
 *      Checking a box here is not a blanket "proceed no matter what" for this row.
 */
export function PlanScreen({ api, queued, onClear, planId, onPlanIdChange }: {
  api: PlanApi
  queued: RequestedAction[]
  onClear: () => void
  /** The plan App already knows about, if any — set once a build has happened THIS session (in
   * this mount or an earlier one) or once History has handed one over via "Open". `null` means
   * there is genuinely nothing to load yet, not that loading failed. */
  planId: string | null
  onPlanIdChange: (id: string | null) => void
}) {
  const [plan, setPlan] = useState<PlanView | null>(null)
  const [building, setBuilding] = useState(false)
  const [buildError, setBuildError] = useState<string | null>(null)

  // Starts `true` exactly when there is something to fetch, so the FIRST render of a remount that
  // was handed a `planId` never flashes the "nothing queued" empty state before the effect below
  // has had a chance to run.
  const [loadingPlan, setLoadingPlan] = useState(planId !== null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [overridesByAction, setOverridesByAction] = useState<Record<string, string[]>>({})

  const [approving, setApproving] = useState(false)
  const [approveError, setApproveError] = useState<string | null>(null)

  const [executing, setExecuting] = useState(false)
  const [executeError, setExecuteError] = useState<string | null>(null)
  const [summary, setSummary] = useState<ExecutionSummary | null>(null)

  /**
   * CRITICAL finding: this screen used to hold `plan`/`summary` in state with nothing outside it
   * remembering which plan that was, so switching nav tabs (which unmounts this component — see
   * App.tsx) threw both away. An operator who built, approved and even EXECUTED a plan, then
   * glanced at another screen and came back, found "nothing queued" again — inviting a second,
   * redundant `createPlan` against files the first plan had already removed, and leaving an
   * approved-but-unexecuted plan with no way back into view at all.
   *
   * `planId` is now lifted to App beside `queued`, and this effect loads whatever it names ONCE,
   * on this fresh mount — not on every later change to `planId` within the same mount. A
   * build/rebuild that happens while already mounted updates `plan` locally and lifts the new id
   * via `onPlanIdChange` itself; re-running this fetch off that same change would race a stale GET
   * against whatever the operator does next (approve, execute) and could overwrite newer state
   * with the draft snapshot the plan started as.
   */
  useEffect(() => {
    if (!planId) return
    let cancelled = false
    api.getPlan(planId)
      .then((loaded) => {
        if (cancelled) return
        if (loaded) setPlan(loaded)
        else setLoadError(`plan ${planId} could not be found`)
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'failed to load plan')
      })
      .finally(() => { if (!cancelled) setLoadingPlan(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function toggleOverride(actionId: string, guard: string) {
    setOverridesByAction((prev) => {
      const current = prev[actionId] ?? []
      const next = current.includes(guard) ? current.filter((g) => g !== guard) : [...current, guard]
      return { ...prev, [actionId]: next }
    })
  }

  async function submit(actions: RequestedAction[]) {
    setBuilding(true)
    setBuildError(null)
    try {
      const built = await api.createPlan(actions)
      setPlan(built)
      onPlanIdChange(built.id)
      // The queue's job is done the moment it is baked into a built plan — whether this build came
      // from the queue itself or from a rebuild (which reads `plan.actions`, never `queued`; see
      // `rebuild` below). Nothing is lost by clearing it: `rebuild` never reads it, and a build
      // FROM the queue has, by definition, already sent everything in it.
      onClear()
      setOverridesByAction({})
      setSummary(null)
      setApproveError(null)
      setExecuteError(null)
    } catch (err) {
      setBuildError(err instanceof Error ? err.message : 'failed to build plan')
    } finally {
      setBuilding(false)
    }
  }

  function buildFromQueue() {
    void submit(queued)
  }

  function rebuild() {
    if (!plan) return
    void submit(plan.actions.map((a) => toRequestedAction(a, overridesByAction[a.id] ?? [])))
  }

  async function approve() {
    if (!plan) return
    setApproving(true)
    setApproveError(null)
    try {
      setPlan(await api.approvePlan(plan.id))
    } catch (err) {
      setApproveError(err instanceof Error ? err.message : 'failed to approve plan')
    } finally {
      setApproving(false)
    }
  }

  async function execute() {
    if (!plan) return
    setExecuting(true)
    setExecuteError(null)
    try {
      const result = await api.executePlan(plan.id)
      setSummary(result)
      try {
        // The executor updates every action's status as it runs; a screen that kept showing the
        // pre-execute snapshot after this point would leave every row reading "pending" even for
        // an action that just ran and failed, skipped or was blocked — which is indistinguishable
        // from "nothing happened yet". Refetch so the rows below report what actually occurred.
        const refreshed = await api.getPlan(plan.id)
        if (refreshed) setPlan(refreshed)
      } catch {
        // The headline summary above is already authoritative; losing the per-row refresh only
        // costs detail, not the fact of what was reported.
      }
    } catch (err) {
      setExecuteError(err instanceof Error ? err.message : 'failed to execute plan')
    } finally {
      setExecuting(false)
    }
  }

  const hasOverridesSelected = Object.values(overridesByAction).some((list) => list.length > 0)
  const hasExecutableAction = plan?.actions.some((a) => a.status === 'pending') ?? false

  if (loadingPlan) {
    return <EmptyState>Loading plan…</EmptyState>
  }

  if (loadError) {
    return <p className="alert" role="alert"><span>{loadError}</span></p>
  }

  if (queued.length === 0 && !plan) {
    return <EmptyState>Nothing queued. Add actions from Findings, Duplicates or Explorer first, then come back here to build a plan.</EmptyState>
  }

  return (
    <div className="plan-screen">
      {!plan ? (
        <section className="panel plan-queue">
          <h2>Queued actions</h2>
          <p>{queued.length} action{queued.length === 1 ? '' : 's'} queued, not yet planned.</p>
          <ul className="plan-queue-list">
            {queued.map((a, i) => (
              // Index is stable for the lifetime of this unbuilt queue (it only ever changes by a
              // full replace from the screens that feed it), and a queued request carries no id of
              // its own to key on instead.
              <li key={i} className="subject-path">
                <code>{a.type}</code> {targetLabel(a)}
              </li>
            ))}
          </ul>
          <div className="plan-queue-actions">
            <button type="button" className="btn btn-primary" disabled={building} aria-busy={building} onClick={buildFromQueue}>
              Build plan
            </button>
            <button type="button" className="btn btn-quiet" onClick={onClear}>
              Clear queue
            </button>
          </div>
        </section>
      ) : null}

      {buildError ? <p className="alert" role="alert"><span>{buildError}</span></p> : null}

      {plan ? (
        <>
          <section className="panel plan-summary">
            <h2>Plan <code>{plan.id}</code> — <span className={planStatusTagClass(plan.status)}>{plan.status}</span></h2>

            <p className="plan-caution" role="note">
              Guard verdicts below reflect state at the moment this plan was built or last
              rebuilt. Approving does not refresh them — it only confirms something here is still
              not refused. The one and only re-check against live state happens immediately before
              each action runs at execution — a guard that passes now can still refuse then. An
              override selected here only ever clears a guard that is actually refusing the action
              it names right now; it can never clear a different guard that starts refusing later.
              If that happens, the affected action does not run, and this plan must be rebuilt to
              see and decide on the new refusal.
            </p>
            {/*
              MAJOR finding: the old text here disclosed only 2 of the executor's 5 steps
              (*arr-unmonitor and torrent removal), leaving the other 3 — each materially
              surprising — undisclosed: a junk file's own delete can be recoverable from the trash
              while a media file's cannot, under the identical "Delete" label; the sweep below
              removes parent folders the operator never named; and Jellyfin's own item is removed
              or refreshed at the very end. This is the ACTUAL order src/plan/executor.ts runs,
              read from the code, not paraphrased from memory of what it used to say.
            */}
            <div className="plan-note">
              <p>Executing an approved plan runs these steps, in this exact order, for every delete action it contains:</p>
              <ol>
                <li>
                  Unmonitor the file in Radarr/Sonarr where one manages it — the show or movie
                  record itself is never deleted, only unmonitored — so nothing can re-grab the
                  title while the rest of this runs.
                </li>
                <li>
                  Remove the file's torrent, with its data, from qBittorrent, and confirm
                  qBittorrent has actually let it go before continuing.
                </li>
                <li>
                  Remove whatever qBittorrent left behind — this path's own remaining hardlink. A
                  junk file with no torrent behind it is trashed (recoverable later from History)
                  when there is room; a media file, or any file a torrent backs, is unlinked
                  directly here and cannot be recovered — one "Delete" vocabulary covering two
                  different outcomes.
                </li>
                <li>
                  Sweep away the parent directories this now leaves empty, one level at a time,
                  never past the configured library root. "Directories swept" below counts these —
                  folders the operator never named directly, removed as a consequence of approving
                  the file(s) inside them.
                </li>
                <li>
                  Remove the item from Jellyfin — or, if anything about it survived this action
                  (another version, a sibling file, a merge), refresh it instead — then run ONE
                  batched library refresh after every action in the whole plan has finished, never
                  one refresh per file.
                </li>
              </ol>
            </div>

            <dl className="plan-dry-run">
              <div><dt>Deletes planned</dt><dd>{plan.dryRun.deleteCount}</dd></div>
              <div><dt>Bytes freed</dt><dd><Bytes value={plan.dryRun.bytesFreed} /></dd></div>
              <div>
                <dt>Torrents removed</dt>
                <dd>{plan.dryRun.torrentsRemoved} torrent{plan.dryRun.torrentsRemoved === 1 ? '' : 's'} removed</dd>
              </div>
              <div><dt>Guard-stopped</dt><dd>{plan.dryRun.blockedCount}</dd></div>
              {/* `directoriesSwept` is undefined, not zero, on a plan persisted before this field
                  existed — rendering "0" or "undefined" for that case would both be lies about a
                  number Jellymaid never actually computed for this plan. */}
              {plan.dryRun.directoriesSwept !== undefined ? (
                <div>
                  <dt title="Now-empty parent folders removed after the file(s) inside them are gone, one level at a time, never above the configured library root">
                    Directories swept
                  </dt>
                  <dd>{plan.dryRun.directoriesSwept}</dd>
                </div>
              ) : null}
            </dl>

            {plan.status === 'draft' && !hasExecutableAction ? (
              <p className="alert alert-warn" role="status">
                A guard stopped every action in this plan — there is nothing left to approve. Clear
                an override or fix the underlying condition, then rebuild.
              </p>
            ) : null}

            {approveError ? <p className="alert" role="alert"><span>{approveError}</span></p> : null}
            {executeError ? <p className="alert" role="alert"><span>{executeError}</span></p> : null}

            <div className="plan-actions-bar">
              {plan.status === 'draft' ? (
                <>
                  <button
                    type="button"
                    className="btn btn-quiet"
                    disabled={building || !hasOverridesSelected}
                    aria-busy={building}
                    onClick={rebuild}
                  >
                    Rebuild
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={approving || !hasExecutableAction}
                    aria-busy={approving}
                    onClick={() => void approve()}
                  >
                    Approve
                  </button>
                </>
              ) : null}
              {plan.status === 'approved' ? (
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={executing}
                  aria-busy={executing}
                  onClick={() => void execute()}
                >
                  Execute plan
                </button>
              ) : null}
            </div>

            {summary ? <ExecutionSummaryLine summary={summary} /> : null}
          </section>

          <table className="table plan-actions-table">
            <thead>
              <tr>
                <th scope="col">Action</th>
                <th scope="col">Target</th>
                <th scope="col">Status</th>
                <th scope="col">Guards</th>
              </tr>
            </thead>
            <tbody>
              {plan.actions.map((a) => (
                <tr key={a.id}>
                  <td>{ACTION_TYPE_LABEL[a.type]} <code>{a.type}</code></td>
                  <td className="subject-path">{targetLabel(a.payload)}</td>
                  <td><span className={statusTagClass(a.status)}>{a.status}</span></td>
                  <td>
                    <GuardVerdictList
                      verdicts={a.guardVerdicts}
                      overrides={overridesByAction[a.id] ?? []}
                      onToggleOverride={(g) => toggleOverride(a.id, g)}
                    />
                    {a.error ? <p className="alert" role="alert"><span>{a.error}</span></p> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </div>
  )
}
