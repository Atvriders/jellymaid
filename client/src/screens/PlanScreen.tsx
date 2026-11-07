import { useEffect, useMemo, useState } from 'react'
import type { Api, GuardId, PlanActionView, PlanView, RequestedAction, TorrentMatchView } from '../api.js'
import { ApiError } from '../api.js'
import { Bytes, ConfirmBox, EmptyState, GuardVerdictList } from '../components/index.js'

type PlanApi = Pick<Api, 'createPlan' | 'getPlan' | 'approvePlan' | 'executePlan'>

/** How often a plan that is running in the background is read again. */
const PLAN_POLL_MS = 2_000

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
 * `planStatusTagClass` (client/src/screens/History.tsx): an `approved` plan — armed,
 * pre-authorised, and the one state that shows the red Execute button — must not render as the
 * quietest tag on the screen. */
function planStatusTagClass(status: string): string {
  if (status === 'completed') return 'tag tag-ok'
  if (status === 'failed') return 'tag tag-block'
  if (status === 'running' || status === 'approved') return 'tag tag-warn'
  return 'tag tag-quiet' // draft
}

function isTerminal(plan: PlanView): boolean {
  return plan.status === 'completed' || plan.status === 'failed'
}

/**
 * What a finished run did, read from the plan's own action statuses. Execution runs in the
 * background (POST /execute answers 202), so there is no summary response any more — the plan the
 * server reports IS the record. Bytes actually freed are not part of that record, so this line
 * never claims a number; the dry run's figure above is the plan's estimate and is labelled so.
 */
function RunSummaryLine({ plan }: { plan: PlanView }) {
  const count = (status: string) => plan.actions.filter((a) => a.status === status).length
  const done = count('done')
  const failed = count('failed')
  const skipped = count('skipped')
  const blocked = count('blocked')
  const text = `Execution ${plan.status}: ${done} done, ${failed} failed, ${skipped} skipped, ${blocked} blocked.`
    + (done > 0 ? ' Jellyfin drops deleted items within about a minute.' : '')
  // "Execution completed" must not headline a run that did nothing: a plan every one of whose
  // actions was blocked or skipped still reports `completed` — honest about the word, misleading
  // about the tone — so that case reads as a caution, not a plain, quiet paragraph.
  return done === 0 && blocked + skipped > 0
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
 * for each row — never anything read off `payload.resolution` (the planner's server-computed
 * detail) and never an `overrides` key at all for a row with nothing selected, so a fresh build
 * and a "rebuild with no overrides chosen" produce identical requests.
 */
function toRequestedAction(action: PlanActionView, overrides: GuardId[]): RequestedAction {
  const req: RequestedAction = { type: action.type }
  if (action.payload.targetPath !== undefined) req.targetPath = action.payload.targetPath
  if (action.payload.itemIds !== undefined) req.itemIds = action.payload.itemIds
  if (overrides.length > 0) req.overrides = overrides
  return req
}

function isOverridableBlock(action: PlanActionView, guard: string): boolean {
  return action.guardVerdicts.some((v) => v.guard === guard && v.outcome === 'block' && v.overridable)
}

/**
 * The overrides a (re)built plan carries, as its stored request shows them — this is what makes a
 * rebuild KEEP earlier overrides instead of silently starting over. Only overrides that still
 * have a visible, ticked checkbox are kept: one for a guard that no longer blocks the row (the
 * planner reports those in `droppedOverrides`) would otherwise ride along on every later rebuild
 * with no control anywhere on screen to see or clear it.
 */
function seedOverrides(plan: PlanView): Record<string, GuardId[]> {
  const out: Record<string, GuardId[]> = {}
  for (const a of plan.actions) {
    const kept = (a.payload.overrides ?? []).filter((g) => isOverridableBlock(a, g))
    if (kept.length > 0) out[a.id] = kept
  }
  return out
}

/** True when the ticks on screen differ, for any action, from the overrides the built plan stores.
 * Ticks reach the server only on a rebuild, so approving in that state would approve something
 * other than what the screen shows. */
function overridesDiffer(plan: PlanView, ticked: Record<string, GuardId[]>, built: Record<string, GuardId[]>): boolean {
  return plan.actions.some((a) => {
    const mine = new Set(ticked[a.id] ?? [])
    const theirs = new Set(built[a.id] ?? [])
    return mine.size !== theirs.size || [...mine].some((g) => !theirs.has(g))
  })
}

/** The torrents a delete would remove, from the resolution stored with the plan. A plan built
 * before Plan 7 stored an older shape, so every field below is read as possibly missing. */
function actionTorrents(action: PlanActionView): TorrentMatchView[] {
  const torrents = action.payload.resolution?.torrents
  return Array.isArray(torrents) ? torrents : []
}

function companionText(count: number | null | undefined): string {
  if (typeof count !== 'number') return 'companion files unknown'
  return `${count} companion file${count === 1 ? '' : 's'}`
}

function TorrentList({ torrents }: { torrents: TorrentMatchView[] }) {
  if (torrents.length === 0) return <>—</>
  return (
    <ul className="plan-torrents">
      {torrents.map((t, i) => (
        // eslint-disable-next-line react/no-array-index-key -- the same hash can sit on two boxes
        <li key={`${t.instanceId ?? ''}-${t.hash}-${i}`}>
          <span className="tag tag-quiet" title="qBittorrent instance that owns this torrent">{t.instanceId ?? '—'}</span>
          {/* A torrent name is whatever its creator chose — a text node only. */}
          <span className="subject-path">{t.name}</span>
          <span className="plan-torrent-fact">ratio {typeof t.ratio === 'number' ? t.ratio.toFixed(2) : '—'}</span>
          <span className="plan-torrent-fact">
            {typeof t.seedingTimeSeconds === 'number' ? (t.seedingTimeSeconds / 86_400).toFixed(1) : '—'} days seeding
          </span>
          <span className="plan-torrent-fact">{companionText(t.companionCount)}</span>
        </li>
      ))}
    </ul>
  )
}

/** A 412 is the plan build refusing an unverified or stale path map; the fix lives in Settings. */
function describeBuildError(err: unknown): string {
  if (err instanceof ApiError && err.status === 412) {
    return `${err.message}. Verify the path mappings in Settings, then build the plan again.`
  }
  return err instanceof Error ? err.message : 'failed to build plan'
}

/**
 * The body of the bulk "Override <guard> for all N blocked rows" confirmation (final review m5). Two
 * guards stand in front of more than a row seems to say, so their confirmation says plainly what the
 * override deletes:
 *  - `guard.untracked` blocks a raw unlink of a file no torrent owns. Overriding it deletes those
 *    files from disk, and if a torrent IS seeding one (a wrong path mapping hides it), nothing else
 *    stands in the way;
 *  - `guard.torrent-scope` blocks removing a torrent with its data while the plan names only some of
 *    its media. Overriding it deletes the rest of each torrent too.
 * Every other guard gets the generic text. Each override still takes effect only on a rebuild, and
 * clears that one guard only.
 */
function OverrideAllWarning({ guard, count }: { guard: GuardId; count: number }) {
  const after = 'The override takes effect once you rebuild and approve the plan. Read the reason on each row below '
    + 'first. This clears no other guard: anything else that refuses a row still stops it.'
  if (guard === 'guard.untracked') {
    return (
      <p>
        {count} {count === 1 ? 'file' : 'files'} that no torrent owns will be deleted from disk. Only do this
        for leftovers you are sure are not seeding. If a torrent should own any of them, fix the path mapping
        and verify it instead. {after}
      </p>
    )
  }
  if (guard === 'guard.torrent-scope') {
    const one = count === 1
    return (
      <p>
        {one ? 'This row removes its torrent' : `These ${count} rows remove their torrents`} with the data, so
        the other files in {one ? 'that torrent' : 'those torrents'} will be deleted too: the media files this
        plan does not name (the other episodes of a pack, for example), and, for a torrent whose file list
        qBittorrent could not give, whatever else it holds. {after}
      </p>
    )
  }
  return (
    <p>
      Each of these {count} actions will be allowed past {guard} once you rebuild and approve the plan. Read the
      reason on each row below first. This clears no other guard: anything else that refuses a row still stops it.
    </p>
  )
}

/**
 * The approval gate the whole product funnels through. Two things this screen must never blur:
 *
 *   1. A guard verdict shown here is a SNAPSHOT from when the plan was (re)built. Approving is a
 *      status flip that re-runs nothing; the ONLY re-check against live state happens once,
 *      immediately before each action executes. So the gap an operator is trusting runs from
 *      build/rebuild time to the moment execution reaches that action, and this screen says so
 *      rather than letting a row of quiet tags imply a freshness check that does not exist.
 *   2. An override only ever pre-authorises a guard that is ACTUALLY BLOCKING THE ACTION IT NAMES
 *      in the plan being approved. The executor intersects a stored override with the guard set
 *      that was blocking in THAT approved snapshot — never with whatever blocks at execute time —
 *      so an override can never silently clear a DIFFERENT guard that starts blocking later. The
 *      bulk "Override <guard> for all N blocked rows" ticks exactly that guard on exactly the rows
 *      it blocks, after a confirmation, and a rebuild keeps what was ticked (`seedOverrides`).
 *      Ticks reach the server ONLY on a rebuild, so Approve is withheld while they differ from the
 *      overrides the built plan stores, and past draft the rows show the stored overrides, never
 *      the ticks — the approval gate must show exactly what the executor will honour.
 *
 * Execution runs in the background: POST /execute answers 202, and this screen reads the plan
 * again straight away and then every `PLAN_POLL_MS` while it is `running` — including a running
 * plan it was handed on mount — until it reaches `completed` or `failed`.
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

  const [overridesByAction, setOverridesByAction] = useState<Record<string, GuardId[]>>({})
  const [confirmGuard, setConfirmGuard] = useState<GuardId | null>(null)

  const [approving, setApproving] = useState(false)
  const [approveError, setApproveError] = useState<string | null>(null)

  const [executing, setExecuting] = useState(false)
  const [executeError, setExecuteError] = useState<string | null>(null)
  const [pollError, setPollError] = useState<string | null>(null)
  // Bumped after a failed poll, so the polling effect below re-arms even though `plan` (its other
  // trigger) did not change — a transient network error must not freeze the progress display.
  const [pollTick, setPollTick] = useState(0)

  /**
   * `planId` is lifted to App beside `queued`, so navigating away and back (which unmounts this
   * screen) never loses a built, approved or executed plan. This effect loads whatever it names
   * ONCE, on this fresh mount — not on every later change to `planId` within the same mount: a
   * build/rebuild while mounted updates `plan` locally and lifts the new id itself, and re-running
   * this fetch off that change would race a stale GET against whatever the operator does next.
   */
  useEffect(() => {
    if (!planId) return
    let cancelled = false
    api.getPlan(planId)
      .then((loaded) => {
        if (cancelled) return
        if (loaded) {
          setPlan(loaded)
          setOverridesByAction(seedOverrides(loaded))
        } else {
          setLoadError(`plan ${planId} could not be found`)
        }
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'failed to load plan')
      })
      .finally(() => { if (!cancelled) setLoadingPlan(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Polls a running plan: one GET `PLAN_POLL_MS` after the last answer, never overlapping, until
  // the plan leaves `running`. Every fresh `plan` (or a failed poll's `pollTick`) re-arms it.
  const runningId = plan?.status === 'running' ? plan.id : null
  useEffect(() => {
    if (!runningId) return
    let cancelled = false
    const timer = setTimeout(() => {
      api.getPlan(runningId)
        .then((next) => {
          if (cancelled) return
          setPollError(null)
          if (next) setPlan(next)
          else setPollTick((t) => t + 1)
        })
        .catch((err) => {
          if (cancelled) return
          setPollError(err instanceof Error ? err.message : 'failed to read the plan')
          setPollTick((t) => t + 1)
        })
    }, PLAN_POLL_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [api, runningId, plan, pollTick])

  /** Every overridable guard that blocks at least one row, with the rows it blocks. */
  const overrideTargets = useMemo(() => {
    if (!plan || plan.status !== 'draft') return []
    const byGuard = new Map<GuardId, string[]>()
    for (const a of plan.actions) {
      for (const v of a.guardVerdicts) {
        if (v.outcome !== 'block' || !v.overridable) continue
        const ids = byGuard.get(v.guard) ?? []
        if (!ids.includes(a.id)) ids.push(a.id)
        byGuard.set(v.guard, ids)
      }
    }
    return [...byGuard.entries()].map(([guard, actionIds]) => ({ guard, actionIds }))
  }, [plan])

  function toggleOverride(actionId: string, guard: string) {
    setOverridesByAction((prev) => {
      const current = prev[actionId] ?? []
      // Every string reaching here came from a real GuardVerdict.guard on THIS action (see
      // GuardVerdictList), which is already a GuardId server-side — the cast only restores that
      // fact after GuardVerdictList's own prop type widened it to `string`.
      const next = current.includes(guard as GuardId) ? current.filter((g) => g !== guard) : [...current, guard as GuardId]
      return { ...prev, [actionId]: next }
    })
  }

  function overrideAll(guard: GuardId) {
    const target = overrideTargets.find((t) => t.guard === guard)
    setConfirmGuard(null)
    if (!target) return
    setOverridesByAction((prev) => {
      const next = { ...prev }
      for (const id of target.actionIds) {
        const current = next[id] ?? []
        if (!current.includes(guard)) next[id] = [...current, guard]
      }
      return next
    })
  }

  async function submit(actions: RequestedAction[]) {
    setBuilding(true)
    setBuildError(null)
    setConfirmGuard(null)
    try {
      const built = await api.createPlan(actions)
      setPlan(built)
      setOverridesByAction(seedOverrides(built))
      onPlanIdChange(built.id)
      // The queue's job is done the moment it is baked into a built plan — whether this build came
      // from the queue itself or from a rebuild (which reads `plan.actions`, never `queued`).
      onClear()
      setApproveError(null)
      setExecuteError(null)
      setPollError(null)
    } catch (err) {
      setBuildError(describeBuildError(err))
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
    const id = plan.id
    setExecuting(true)
    setExecuteError(null)
    try {
      await api.executePlan(id)
    } catch (err) {
      setExecuteError(err instanceof Error ? err.message : 'failed to execute plan')
      setExecuting(false)
      return
    }
    // 202: the run is going. Show it as running at once (so Execute cannot be offered again), then
    // read its real state; the polling effect takes over from there.
    setPlan((p) => (p && p.id === id ? { ...p, status: 'running' } : p))
    try {
      const fresh = await api.getPlan(id)
      if (fresh) setPlan(fresh)
    } catch (err) {
      setPollError(err instanceof Error ? err.message : 'failed to read the plan')
    } finally {
      setExecuting(false)
    }
  }

  const hasExecutableAction = plan?.actions.some((a) => a.status === 'pending') ?? false

  /** The overrides the plan in view actually stores — what the executor will honour. Past draft
   * this is the ONLY source the rows show; in a draft it is what the ticks are compared against. */
  const builtOverrides = useMemo(() => (plan ? seedOverrides(plan) : {}), [plan])
  const unappliedOverrides = plan?.status === 'draft' && overridesDiffer(plan, overridesByAction, builtOverrides)

  /**
   * A plan that reached `completed` or `failed` never changes again and has no controls left, so
   * the queue panel must still render beside it when something new was queued — otherwise a newly
   * queued action would be invisible and unbuildable. A `draft`/`approved`/`running` plan does NOT
   * get this treatment: a stray "Build plan" click must not blow away a plan with undecided work.
   */
  const planIsTerminal = plan !== null && isTerminal(plan)
  const showQueuePanel = queued.length > 0 && (!plan || planIsTerminal)

  if (loadingPlan) {
    return <EmptyState>Loading plan…</EmptyState>
  }

  if (loadError) {
    return <p className="alert" role="alert"><span>{loadError}</span></p>
  }

  if (queued.length === 0 && !plan) {
    return <EmptyState>Nothing queued. Add actions from Findings, Duplicates or Explorer first, then come back here to build a plan.</EmptyState>
  }

  const dropped = plan?.droppedOverrides ?? []
  const confirmTarget = confirmGuard ? overrideTargets.find((t) => t.guard === confirmGuard) : undefined
  const rowsWord = (n: number) => `${n} blocked row${n === 1 ? '' : 's'}`

  return (
    <div className="plan-screen">
      {showQueuePanel ? (
        <section className="panel plan-queue">
          <h2>Queued actions</h2>
          <p>
            {queued.length} action{queued.length === 1 ? '' : 's'} queued, not yet planned.
            {plan ? ' Building starts a new plan — it does not change the one below.' : ''}
          </p>
          <ul className="plan-queue-list">
            {queued.map((a, i) => (
              // Index is stable for the lifetime of this unbuilt queue, and a queued request carries
              // no id of its own to key on instead.
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
              The executor's actual order of operations for a delete (C11), read from the plan
              contract rather than paraphrased: qBittorrent deletes the torrent with its data on the
              box that owns it, Jellymaid removes only what is left, and Jellyfin is told once,
              after the last action, which paths are gone. Jellyfin is never asked to delete
              anything — with the file still present, a Jellyfin delete would remove the item's
              whole folder itself.
            */}
            <div className="plan-note">
              <p>Executing an approved plan runs these steps, in this exact order, for every delete action it contains:</p>
              <ol>
                <li>
                  Re-check every guard against live state. An action a guard now refuses does not run.
                </li>
                <li>
                  Unmonitor the file in Radarr/Sonarr where one manages it — the show or movie
                  record itself is never deleted, only unmonitored — so nothing can re-grab the
                  title while the rest of this runs.
                </li>
                <li>
                  Remove the file's torrent, with its data, through the qBittorrent instance that
                  owns it and no other box, taking the release's companion files (.nfo, subtitles,
                  samples) with it, and confirm qBittorrent has let the torrent go.
                </li>
                <li>
                  Wait up to 30 seconds for qBittorrent's own delete to reach the disk, then remove
                  whatever is left of this path — its own remaining hardlink. A junk file with no
                  torrent behind it is trashed (recoverable later from History) when there is room;
                  a media file, or any file a torrent backs, is unlinked directly here and cannot be
                  recovered.
                </li>
                <li>
                  Sweep away the parent directories this now leaves empty, one level at a time,
                  never past the configured library root. "Directories swept" below counts these —
                  folders the operator never named directly, removed as a consequence of approving
                  the file(s) inside them.
                </li>
                <li>
                  After the last action, tell Jellyfin once which of these paths are now gone.
                  Jellyfin drops deleted items within about a minute. Jellymaid never asks Jellyfin
                  to delete anything itself.
                </li>
              </ol>
            </div>

            <dl className="plan-dry-run">
              <div><dt>Deletes planned</dt><dd>{plan.dryRun.deleteCount}</dd></div>
              <div><dt>Bytes freed (planned)</dt><dd><Bytes value={plan.dryRun.bytesFreed} /></dd></div>
              <div>
                <dt>Torrents removed</dt>
                <dd>{plan.dryRun.torrentsRemoved} torrent{plan.dryRun.torrentsRemoved === 1 ? '' : 's'} removed</dd>
              </div>
              <div><dt>Guard-stopped</dt><dd>{plan.dryRun.blockedCount}</dd></div>
              {/* Each optional figure is undefined, not zero, on a plan persisted before it existed —
                  rendering "0" or "undefined" for that case would both be lies about a number
                  Jellymaid never computed for this plan. */}
              {plan.dryRun.directoriesSwept !== undefined ? (
                <div>
                  <dt title="Now-empty parent folders removed after the file(s) inside them are gone, one level at a time, never above the configured library root">
                    Directories swept
                  </dt>
                  <dd>{plan.dryRun.directoriesSwept}</dd>
                </div>
              ) : null}
              {plan.dryRun.companionFiles !== undefined ? (
                <div>
                  <dt title="Files that travel with a release (.nfo, subtitles, samples) and go with its torrent">Companion files</dt>
                  <dd>{plan.dryRun.companionFiles}</dd>
                </div>
              ) : null}
              {Object.entries(plan.dryRun.byInstance ?? {}).map(([instanceId, given]) => (
                <div key={instanceId}>
                  <dt title="What this qBittorrent instance gives up">{instanceId}</dt>
                  <dd>{given.torrents} torrent{given.torrents === 1 ? '' : 's'} · <Bytes value={given.bytes} /></dd>
                </div>
              ))}
            </dl>

            {dropped.length > 0 ? (
              <div className="alert alert-warn" role="status">
                <span>
                  {dropped.length === 1 ? 'An override was' : `${dropped.length} overrides were`} dropped because that
                  guard no longer blocks the action:{' '}
                  {dropped.map((d) => {
                    const target = plan.actions.find((a) => a.seq === d.seq)
                    return `${d.guard} on ${target ? targetLabel(target.payload) : `action ${d.seq}`}`
                  }).join('; ')}.
                </span>
              </div>
            ) : null}

            {plan.status === 'draft' && !hasExecutableAction ? (
              <p className="alert alert-warn" role="status">
                A guard stopped every action in this plan — there is nothing left to approve. Clear
                an override or fix the underlying condition, then rebuild.
              </p>
            ) : null}

            {plan.error ? <p className="alert" role="alert"><span>The run stopped: {plan.error}</span></p> : null}
            {approveError ? <p className="alert" role="alert"><span>{approveError}</span></p> : null}
            {executeError ? <p className="alert" role="alert"><span>{executeError}</span></p> : null}

            {plan.status === 'draft' && overrideTargets.length > 0 ? (
              <div className="plan-override-all">
                {overrideTargets.map(({ guard, actionIds }) => (
                  <button
                    key={guard}
                    type="button"
                    className="btn btn-quiet"
                    disabled={building || actionIds.every((id) => (overridesByAction[id] ?? []).includes(guard))}
                    onClick={() => setConfirmGuard(guard)}
                  >
                    Override {guard} for all {rowsWord(actionIds.length)}
                  </button>
                ))}
              </div>
            ) : null}

            {confirmTarget ? (
              <ConfirmBox
                title={`Override ${confirmTarget.guard} for all ${rowsWord(confirmTarget.actionIds.length)}?`}
                confirmLabel="Override all"
                confirmClassName="btn btn-danger"
                onConfirm={() => overrideAll(confirmTarget.guard)}
                onCancel={() => setConfirmGuard(null)}
              >
                <OverrideAllWarning guard={confirmTarget.guard} count={confirmTarget.actionIds.length} />
              </ConfirmBox>
            ) : null}

            {unappliedOverrides ? (
              <p id="plan-unapplied-overrides" className="alert alert-warn" role="status">
                The override ticks below are not in this plan yet — overrides only take effect when the
                plan is rebuilt. Rebuild to apply them, then approve.
              </p>
            ) : null}

            <div className="plan-actions-bar">
              {plan.status === 'draft' ? (
                <>
                  <button
                    type="button"
                    className="btn btn-quiet"
                    disabled={building}
                    aria-busy={building}
                    onClick={rebuild}
                  >
                    Rebuild
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={approving || !hasExecutableAction || unappliedOverrides}
                    aria-busy={approving}
                    aria-describedby={unappliedOverrides ? 'plan-unapplied-overrides' : undefined}
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

            {plan.status === 'running' ? (
              <div className="plan-progress" role="status">
                <progress
                  aria-label="Execution progress"
                  max={Math.max(plan.progress?.total ?? plan.actions.length, 1)}
                  value={plan.progress?.finished ?? 0}
                />
                <span>
                  {plan.progress?.finished ?? 0} of {plan.progress?.total ?? plan.actions.length} actions finished.
                  Running in the background — this page checks every {PLAN_POLL_MS / 1000} seconds, and the run
                  carries on if you leave it.
                </span>
              </div>
            ) : null}
            {pollError && plan.status === 'running' ? (
              <p className="alert alert-warn" role="status">Could not read the plan ({pollError}) — still trying.</p>
            ) : null}

            {planIsTerminal ? <RunSummaryLine plan={plan} /> : null}
          </section>

          <table className="table plan-actions-table">
            <thead>
              <tr>
                <th scope="col">Action</th>
                <th scope="col">Target</th>
                <th scope="col">Torrents</th>
                <th scope="col">Status</th>
                <th scope="col">Guards</th>
              </tr>
            </thead>
            <tbody>
              {plan.actions.map((a) => (
                <tr key={a.id}>
                  <td>{ACTION_TYPE_LABEL[a.type]} <code>{a.type}</code></td>
                  <td className="subject-path">{targetLabel(a.payload)}</td>
                  <td><TorrentList torrents={actionTorrents(a)} /></td>
                  <td><span className={statusTagClass(a.status)}>{a.status}</span></td>
                  <td>
                    {/* Past draft the rows show what the plan STORES — the overrides the executor
                        will honour — never this screen's ticks, which only a rebuild would send. */}
                    <GuardVerdictList
                      verdicts={a.guardVerdicts}
                      overrides={(plan.status === 'draft' ? overridesByAction[a.id] : builtOverrides[a.id]) ?? []}
                      onToggleOverride={(g) => toggleOverride(a.id, g)}
                      readOnly={plan.status !== 'draft'}
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
