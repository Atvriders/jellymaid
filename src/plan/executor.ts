import { existsSync, lstatSync, readdirSync, rmdirSync, unlinkSync, type Stats } from 'node:fs'
import { dirname } from 'node:path'
import type { Db } from '../index/db.js'
import type { FileConfig } from '../config/schema.js'
import type { ConfigStore } from '../config/store.js'
import type { PathMap } from '../fs/pathmap.js'
import type { ActivityKind, ActivityLock } from '../core/activity.js'
import { torrentKey, type ActionStatus, type ActionType, type GuardVerdict, type PathMapping, type TorrentRef } from '../core/types.js'
import type { JellyfinClient } from '../connectors/jellyfin.js'
import type { QbitClient } from '../connectors/qbittorrent.js'
import type { ArrClient } from '../connectors/arr.js'
import {
  createTorrentListCache, resolveTarget, snapshotInventory,
  type ArrMatch, type ResolveDeps, type Resolution, type TorrentListCache, type TorrentMatch,
} from './resolve.js'
import { evaluateGuards, isBlocked, type RemovedTorrentFile } from './guards.js'
import { creditTorrentFiles, getPlan, type PlanActionView, type PlanView } from './planner.js'
import { moveToTrash } from './trash.js'
import { canSweepInto, MAX_SWEEP_DEPTH, samePath } from './sweep.js'
import { writeAudit } from './audit.js'
import { verificationBlocker } from '../scan/verification.js'

export interface ExecutorDeps {
  db: Db
  configStore: ConfigStore           // one file()/pathMap() snapshot per run
  qbittorrents: ReadonlyMap<string, Pick<QbitClient, 'instanceId' | 'torrents' | 'files' | 'deleteWithData' | 'awaitGone'>>
  radarr: Pick<ArrClient, 'inventory' | 'unmonitorByPath'> | null
  sonarr: Pick<ArrClient, 'inventory' | 'unmonitorByPath'> | null
  /**
   * Notify, merge and split: nothing else. Jellyfin is never asked to delete an item — its item
   * delete removes the item's files when they still exist, the folder around them included — nor to
   * rescan the library. It is told which paths are gone, and forgets them itself.
   */
  jellyfin: Pick<JellyfinClient, 'notifyPathsDeleted' | 'mergeVersions' | 'splitVersions'>
  activity: ActivityLock
}

export interface ExecutorOptions {
  /**
   * Step 3: how long to wait for qBittorrent's asynchronous delete to take the target and the plan's
   * other files of the torrents it removed, and how often to look. qBittorrent answers
   * torrents/delete before the files are gone, and an NFS client can go on seeing a removed file for
   * a while after.
   */
  goneTimeoutMs?: number
  gonePollMs?: number
  /** How long a run may judge an instance from one torrent list; re-read at once after it deletes. */
  torrentListMaxAgeMs?: number
}

const DEFAULT_GONE_TIMEOUT_MS = 30_000
const DEFAULT_GONE_POLL_MS = 500
const DEFAULT_TORRENT_LIST_MAX_AGE_MS = 10_000

/** One instance's client, as the executor holds it. */
type InstanceClient = ExecutorDeps['qbittorrents'] extends ReadonlyMap<string, infer C> ? C : never

export interface ExecutionSummary {
  planId: string
  status: 'completed' | 'failed'
  done: number
  failed: number
  skipped: number
  blocked: number
  bytesFreed: number
}

/**
 * Why a run did not start: 'busy' (a plan or a scan is running), 'not-found', 'not-approved',
 * 'verification' (the path mappings are not verified as they stand now), or 'error' (the run could
 * not be set up — config.json unreadable, say). Nothing was claimed.
 */
export type RefusalCode = 'busy' | 'not-found' | 'not-approved' | 'verification' | 'error'

export class ExecutionRefused extends Error {
  constructor(readonly code: RefusalCode, message: string) {
    super(message)
    this.name = 'ExecutionRefused'
  }
}

export type StartResult = { ok: true } | { ok: false; error: RefusalCode; reason: string }

/** Everything an action needs from the run it belongs to, rather than from module state. */
interface RunContext {
  planId: string
  /**
   * The run's ONE view of the live configuration, read when the run starts: every action is
   * confined, guarded, trashed and swept against the same thresholds and the same mapping set, even
   * if config.json is edited mid-run.
   */
  config: FileConfig
  pathMap: PathMap
  /** `deps` with the *arr inventory snapshotted for this run. Never used for the unmonitor call. */
  resolveDeps: ResolveDeps
  /** The torrent lists `resolveDeps` reads; an instance's is dropped the moment it deletes something. */
  torrentLists: TorrentListCache
  /** Every file this run has credited as freed, so no torrent's bytes are counted twice. */
  credited: Set<string>
  /**
   * The plan's files that a torrent removal earlier in THIS run took with it, by container path. A
   * later action naming one finds its torrent gone from the fresh list while qBittorrent may still
   * be deleting the file; this is how it knows the file is the rest of that delete (see
   * guard.untracked and `deleteTarget`) rather than a file no torrent owns.
   */
  removedThisRun: Map<string, TakenFile>
}

/** A file the run's own torrent removal took, with the full identity the unlink check compares. */
interface TakenFile extends RemovedTorrentFile {
  identity: { dev: number; inode: number; sizeBytes: number; mtimeMs: number } | null
}

/** A run that has been claimed: the plan is `running`, the activity lock and the mutex are held. */
interface ClaimedRun { plan: PlanView; config: FileConfig; pathMap: PathMap }

/** Thrown out of a run that `requestStop` halted between actions; its unfinished actions stay pending. */
class ExecutionStopped extends Error {
  constructor(planId: string) {
    super(`execution of plan ${planId} was stopped before it finished; its remaining actions are still pending — execute it again to continue`)
    this.name = 'ExecutionStopped'
  }
}

type TerminalStatus = Extract<ActionStatus, 'done' | 'failed' | 'skipped' | 'blocked'>

type Disposition = 'unlinked' | 'trashed' | 'removed-by-qbittorrent' | 'already-gone'

interface ActionOutcome {
  status: TerminalStatus
  bytesFreed: number
  error?: string
  detail: Record<string, unknown>
  /** The LIVE verdicts this action was judged on, not the ones stored at plan time. */
  verdicts?: GuardVerdict[]
}

const outcome = (
  status: TerminalStatus,
  over: Partial<ActionOutcome> = {},
): ActionOutcome => ({ status, bytesFreed: 0, detail: {}, ...over })

const failure = (error: string, detail: Record<string, unknown> = {}) => outcome('failed', { error, detail })
const skip = (error: string, detail: Record<string, unknown> = {}) => outcome('skipped', { error, detail })

const nowIso = () => new Date().toISOString()

const holderName = (holder: { kind: ActivityKind; id: string }) => `${holder.kind === 'scan' ? 'a scan' : 'plan'} (${holder.id})`

/** The torrents a resolution matched, once each: the same match can be reached more than one way. */
function distinctTorrents(torrents: TorrentMatch[]): TorrentMatch[] {
  const seen = new Map<string, TorrentMatch>()
  for (const t of torrents) if (!seen.has(torrentKey(t))) seen.set(torrentKey(t), t)
  return [...seen.values()]
}

/** "<hash> on <instance>": a hash alone does not say which box's torrent it is. */
const describeRefs = (refs: TorrentRef[]) => refs.map((r) => `${r.hash} on ${r.instanceId}`).join(', ')

/** The file's own lstat, or null when there is nothing at the path. Any other failure is not "gone". */
function lstatIfPresent(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw err
  }
}

/**
 * Whether removing `torrents` is expected to take the target ITSELF, rather than another name of
 * the same bytes. In the *arr layout the torrent owns /downloads/Heat.mkv and the target is the
 * library's /media/Heat.mkv: qBittorrent never touches the target, and waiting for it to vanish would
 * only cost every hardlinked delete the whole timeout. Anything this cannot rule out — a list that
 * could not be read, a file no mapping covers, a match on path containment — counts as "yes":
 * waiting costs seconds, not bytes.
 */
function qbittorrentTakes(torrents: TorrentMatch[], target: string): boolean {
  return torrents.some((t) => t.files === null || t.matchedBy === 'path'
    || t.files.entries.some((e) => e.containerPath === target || e.containerPath === null))
}

/**
 * The plan's OTHER files that removing `torrents` takes with it — entries the plan still means to
 * delete, other than the target — each with the torrents that own it. Their own actions run later in
 * this run, against a torrent list that no longer has those torrents. A hardlink of the target that is
 * itself a torrent file the plan names counts too: it is a path its own action will judge.
 */
function plannedFilesTaken(torrents: TorrentMatch[], target: string, plannedPaths: Set<string>): Map<string, TorrentRef[]> {
  const taken = new Map<string, TorrentRef[]>()
  for (const t of torrents) {
    for (const e of t.files?.entries ?? []) {
      const path = e.containerPath
      if (!path || path === target || !plannedPaths.has(path)) continue
      const owners = taken.get(path) ?? []
      if (!owners.some((o) => torrentKey(o) === torrentKey(t))) owners.push({ instanceId: t.instanceId, hash: t.hash })
      taken.set(path, owners)
    }
  }
  return taken
}

/** The regular file at `path` as an identity check compares it; null when there is none, or no look. */
function fileIdentity(path: string): TakenFile['identity'] {
  try {
    const st = lstatIfPresent(path)
    if (!st || !st.isFile()) return null
    return { dev: Number(st.dev), inode: Number(st.ino), sizeBytes: st.size, mtimeMs: st.mtimeMs }
  } catch {
    return null
  }
}

/**
 * Runs an approved plan. Everything dangerous in Jellymaid happens inside this file, in one fixed
 * order, behind one guard gate:
 *
 *   1. *arr unmonitor — fail-closed, so nothing can re-grab the title mid-delete
 *   2. qBittorrent delete-with-data, confirmed gone — each torrent through the instance that
 *      reported it, with that instance's own hashes, and never through any other
 *   3. up to 30 s for qBittorrent's asynchronous delete to take the file, and the plan's other files
 *      of the torrents it removed (whose own actions come later); then whatever is left at the
 *      path — this path's own link — trashed or unlinked, identity-checked. A later action whose
 *      file such a removal took finishes that delete: it is not judged as a file no torrent owns
 *   4. the now-empty parent directories, never above the mapped root
 *   5. the path recorded in deleted_paths
 *   6. Jellyfin last: ONE notification after the run, of every path the plan deleted that is gone
 *
 * The approved plan is an immutable snapshot of what the operator agreed to; it is never treated
 * as a licence to act on the facts that were true when they agreed. Every action re-resolves its
 * target against live services and re-runs the guards immediately before touching anything.
 */
export function createExecutor(deps: ExecutorDeps, options: ExecutorOptions = {}) {
  const goneTimeoutMs = options.goneTimeoutMs ?? DEFAULT_GONE_TIMEOUT_MS
  const gonePollMs = options.gonePollMs ?? DEFAULT_GONE_POLL_MS
  const torrentListMaxAgeMs = options.torrentListMaxAgeMs ?? DEFAULT_TORRENT_LIST_MAX_AGE_MS

  let running = false
  /** Checked between actions, never inside one: an action is the unit that is safe to stop after. */
  let stopRequested = false
  /** The run in flight, if any, for `idle()` to wait on. */
  let active: Promise<ExecutionSummary> | null = null

  function markRunning(actionId: string) {
    deps.db.prepare("UPDATE plan_actions SET status='running', started_at=?, error=NULL WHERE id=?")
      .run(nowIso(), actionId)
  }

  function settle(actionId: string, result: ActionOutcome) {
    deps.db.prepare('UPDATE plan_actions SET status=?, finished_at=?, error=?, result_json=? WHERE id=?').run(
      result.status,
      nowIso(),
      result.error ?? null,
      // `guard_verdicts_json` deliberately keeps the APPROVED snapshot — the verdicts the operator
      // signed off on. The verdicts this run actually judged the action by live in result_json and
      // in the audit row, so both are recoverable and neither overwrites the other.
      JSON.stringify({
        status: result.status, bytesFreed: result.bytesFreed, error: result.error ?? null,
        detail: result.detail, liveGuardVerdicts: result.verdicts ?? [],
      }),
      actionId,
    )
  }

  /**
   * The paths this plan is still going to remove, read fresh from the action statuses each time it
   * is asked. `guard.torrent-scope` reads it, and "named in the plan" is emphatically not the same
   * as "will actually be deleted": if E01's *arr unmonitor could not be confirmed, its delete is
   * skipped precisely so nothing takes E01's bytes — and if E02 still counted E01 as planned, E02's
   * delete-with-data would remove the whole torrent and destroy E01 anyway, silently undoing the
   * fail-closed protection. So `skipped`, `blocked` and `failed` actions drop out, and because this
   * is recomputed per action rather than once up front, an action skipped moments ago is already
   * gone from the set. `done` and `pending` both stay: a resumed plan still targets what its first
   * attempt removed.
   */
  function eligiblePaths(planId: string): Set<string> {
    const rows = deps.db.prepare(
      `SELECT payload_json FROM plan_actions
       WHERE plan_id = ? AND type IN ('delete-media','delete-junk-file')
         AND status NOT IN ('skipped','blocked','failed')`,
    ).all(planId) as Array<{ payload_json: string }>
    const paths = new Set<string>()
    for (const row of rows) {
      const payload = JSON.parse(row.payload_json) as { targetPath?: string }
      if (payload.targetPath) paths.add(payload.targetPath)
    }
    return paths
  }

  /**
   * Takes everything a run holds, or nothing: the in-process mutex, the activity lock and the
   * database claim — and only for a mapping set verified as it stands. Entirely synchronous, so a
   * caller that gets a claim back knows the plan is already `running` — which is what lets `start`
   * answer 202 honestly — and a refusal leaves nothing behind.
   */
  function claim(planId: string): ClaimedRun {
    // The mutex is claimed before ANY other work, including the validating reads, so that no later
    // edit which introduces an await into validation can open a window for a second run.
    if (running) throw new ExecutionRefused('busy', 'a plan is already running')
    running = true
    let locked = false
    try {
      const plan = getPlan(deps.db, planId)
      if (!plan) throw new ExecutionRefused('not-found', `plan ${planId} does not exist`)
      if (plan.status !== 'approved') {
        throw new ExecutionRefused('not-approved', `plan ${planId} is not approved (status: ${plan.status})`)
      }

      // Plans and scans never run at once. A scan rewrites and sweeps the index every action here
      // resolves against, and forgets torrents this run is about to act on.
      const lock = deps.activity.tryAcquire('plan', planId)
      if (!lock.ok) {
        throw new ExecutionRefused('busy', `${holderName(lock.heldBy)} is running; plans and scans never run at once — try again when it has finished`)
      }
      locked = true

      // Read before the claim below, so an unreadable config.json refuses the run without leaving
      // the plan marked as running. See RunContext.config.
      let config: FileConfig
      let pathMap: PathMap
      let current: { mappingsHash: string; instanceIds: string[] }
      try {
        config = deps.configStore.file()
        pathMap = deps.configStore.pathMap()
        current = { mappingsHash: deps.configStore.mappingsHash(), instanceIds: deps.configStore.instanceIds() }
      } catch (err) {
        throw new ExecutionRefused('error', `the configuration could not be read: ${(err as Error).message}`)
      }

      // Spec §2's gate, held at the step that deletes as well as at the build. Approval vouches for
      // the plan's actions, not for the mapping set they will run under: every action re-resolves
      // against the CURRENT mappings, which decide which instance a torrent is asked about and which
      // container path its files are. A set edited since its last Verify — two roots' instances
      // swapped, say — would delete one box's torrent and then unlink a file the other box is still
      // seeding. So a plan runs only under a set verified exactly as it stands, read in this same
      // synchronous stretch as the snapshot above, so the set vouched for is the set used. Refused,
      // it stays `approved`, ready to run once Verify passes.
      const blocker = verificationBlocker(deps.db, current)
      if (blocker) {
        throw new ExecutionRefused('verification', `${blocker}; plan ${planId} was not started and is still approved`)
      }

      // The in-process mutex only binds THIS executor instance. This binds the database, so a second
      // process (or a second executor built by mistake) cannot delete concurrently with the first.
      // Check and claim are ONE immediate transaction — BEGIN IMMEDIATE takes the write lock before
      // the SELECT, so two connections cannot both read "nothing is running" and then both claim. A
      // plan left `running` by a crash holds the lock until an operator resumes it, which is the
      // point: its actions are in an unknown half-done state.
      const dbClaim = deps.db.transaction((): string | null => {
        const busy = deps.db.prepare("SELECT id FROM plans WHERE status = 'running' AND id != ? LIMIT 1")
          .get(planId) as { id: string } | undefined
        if (busy) return busy.id
        // `AND status='approved'` so losing the race is visible as zero rows changed rather than
        // stomping a state some other writer moved on from. The error of an earlier run that was
        // stopped or crashed is cleared: it describes that run, not this one.
        const claimed = deps.db.prepare(
          "UPDATE plans SET status='running', started_at=?, finished_at=NULL, error=NULL WHERE id=? AND status='approved'",
        ).run(nowIso(), planId)
        return claimed.changes === 1 ? null : planId
      })
      const heldBy = dbClaim.immediate()
      if (heldBy) throw new ExecutionRefused('busy', `plan ${heldBy} is already running; resume or finish it first`)

      // A stop asked of an EARLIER run must not halt this one before its first action.
      stopRequested = false
      return { plan, config, pathMap }
    } catch (err) {
      running = false
      if (locked) deps.activity.release('plan', planId)
      throw err
    }
  }

  /** Runs a claimed plan to its end and gives everything back, however it ends. */
  function launch(claimed: ClaimedRun, actor: string): Promise<ExecutionSummary> {
    const run = runClaimed(claimed, actor).finally(() => {
      running = false
      active = null
      deps.activity.release('plan', claimed.plan.id)
    })
    active = run
    return run
  }

  async function execute(planId: string, actor: string): Promise<ExecutionSummary> {
    return launch(claim(planId), actor)
  }

  /**
   * Fire-and-forget `execute`, for a caller that will not hold a request open for a whole plan.
   * Refusals come back at once, with nothing claimed; `{ ok: true }` means the plan is already
   * `running`. A run that then fails or is stopped records why in `plans.error` itself — the only
   * place anyone will see it — so there is nothing left for this handler to do.
   */
  function start(planId: string, actor: string): StartResult {
    let claimed: ClaimedRun
    try {
      claimed = claim(planId)
    } catch (err) {
      return err instanceof ExecutionRefused
        ? { ok: false, error: err.code, reason: err.message }
        : { ok: false, error: 'error', reason: (err as Error).message }
    }
    launch(claimed, actor).catch(() => { /* recorded in plans.error by the run itself */ })
    return { ok: true }
  }

  /** Lets the action in flight finish, then stops; the rest stay `pending` and the plan resumable. */
  function requestStop(): void {
    stopRequested = true
  }

  /** Resolves once no run is in flight. */
  async function idle(): Promise<void> {
    while (active) await active.then(() => undefined, () => undefined)
  }

  async function runClaimed(claimed: ClaimedRun, actor: string): Promise<ExecutionSummary> {
    const { plan, config, pathMap } = claimed
    const planId = plan.id
    // One *arr inventory for the whole run rather than one per action, and torrent lists reused for
    // a few seconds at most; see snapshotInventory and TorrentListCache. The unmonitor call is never
    // served from a snapshot.
    const torrentLists = createTorrentListCache({ maxAgeMs: torrentListMaxAgeMs })
    const resolveDeps: ResolveDeps = {
      db: deps.db,
      pathMap,
      qbittorrents: deps.qbittorrents,
      radarr: snapshotInventory(deps.radarr),
      sonarr: snapshotInventory(deps.sonarr),
      torrentLists,
    }
    const context: RunContext = {
      planId, config, pathMap, resolveDeps, torrentLists, credited: new Set(), removedThisRun: new Map(),
    }
    const summary: ExecutionSummary = {
      planId, status: 'completed', done: 0, failed: 0, skipped: 0, blocked: 0, bytesFreed: 0,
    }

    let ending: { kind: 'finished' } | { kind: 'stopped' } | { kind: 'crashed'; error: unknown }
    try {
      ending = await runActions(plan, context, actor, summary)
    } catch (error) {
      ending = { kind: 'crashed', error }
    }

    // However the run ended — finished, stopped between actions, or crashed — Jellyfin is told about
    // what the plan has deleted. A stop must not leave Jellyfin holding items whose files are gone.
    await notifyJellyfin(planId, actor, pathMap)

    if (ending.kind === 'crashed') {
      // A throw from OUTSIDE an action's own try — the bookkeeping writes, say, or a SQLite fault.
      // Sticky-by-design is the right answer for a process that died mid-plan, but not for a fault
      // in a process that is still alive: leaving the row `running` would make every later execute
      // on this database fail with "already running" until an operator noticed, and an operator
      // polling a background run would watch it run forever. The run ends `failed`, with the reason
      // in plans.error; the unfinished action returns to `pending` (it never reached a terminal
      // state), and the error propagates.
      const message = ending.error instanceof Error ? ending.error.message : String(ending.error)
      try {
        deps.db.prepare("UPDATE plan_actions SET status='pending' WHERE plan_id=? AND status='running'").run(planId)
        deps.db.prepare("UPDATE plans SET status='failed', finished_at=?, error=? WHERE id=? AND status='running'")
          .run(nowIso(), message, planId)
      } catch { /* the database itself is the fault: leave the row for the resume route */ }
      throw ending.error
    }

    if (ending.kind === 'stopped') {
      // Handed back as `approved`, not `running`, so it can simply be executed again rather than
      // waiting out the resume route's staleness check; the error says why it is not finished.
      const stopped = new ExecutionStopped(planId)
      try {
        deps.db.prepare("UPDATE plan_actions SET status='pending' WHERE plan_id=? AND status='running'").run(planId)
        deps.db.prepare("UPDATE plans SET status='approved', error=? WHERE id=? AND status='running'").run(stopped.message, planId)
      } catch { /* the database itself is the fault: leave the row for the resume route */ }
      throw stopped
    }

    if (summary.failed > 0) summary.status = 'failed'
    deps.db.prepare('UPDATE plans SET status=?, finished_at=? WHERE id=?').run(summary.status, nowIso(), planId)
    return summary
  }

  async function runActions(
    plan: PlanView, context: RunContext, actor: string, summary: ExecutionSummary,
  ): Promise<{ kind: 'finished' } | { kind: 'stopped' }> {
    // Actions run in `seq` order — the order the planner fixed (merges first) and the operator
    // approved. The executor never re-sorts and never skips ahead.
    for (const action of plan.actions) {
      // Idempotence: an action that already reached a terminal state is not re-run. A resume hands
      // back only the unfinished tail (the API route flips `running` rows back to `pending`).
      if (action.status !== 'pending') continue
      // Between actions, never inside one.
      if (stopRequested) return { kind: 'stopped' }

      markRunning(action.id)
      let result: ActionOutcome
      try {
        result = await runAction(action, context)
      } catch (err) {
        result = failure((err as Error).message)
      }

      summary.bytesFreed += result.bytesFreed
      if (result.status === 'done') summary.done += 1
      else if (result.status === 'skipped') summary.skipped += 1
      else if (result.status === 'blocked') summary.blocked += 1
      else summary.failed += 1

      // The terminal status and its audit row land together or not at all. The audit log is the
      // only record of what was done to an operator's files, so an action must never be able to
      // reach `done` with nothing written about it — if this throws, the row stays `running` and
      // the run's crash handling hands it back as `pending`.
      deps.db.transaction(() => {
        settle(action.id, result)
        writeAudit(deps.db, {
          actor,
          actionType: action.type,
          subject: subjectOf(action),
          before: { guardVerdicts: result.verdicts ?? [], overrides: action.payload.overrides ?? [] },
          after: { status: result.status, bytesFreed: result.bytesFreed, error: result.error ?? null, ...result.detail },
          outcome: result.status,
          planId: context.planId,
          planActionId: action.id,
        })
      })()
    }
    return { kind: 'finished' }
  }

  /**
   * Step 6: ONE `notifyPathsDeleted` for the run, after every action has settled, never per action.
   *
   * The list comes from `deleted_paths` for the WHOLE plan, not from this run's memory, so a run that
   * was stopped, or a resume after one, still tells Jellyfin about what an earlier run of the same
   * plan deleted. Each path is re-checked first: only a path whose file is confirmed gone is sent —
   * told about a file that still exists, Jellyfin does nothing, but a re-downloaded file is not
   * "deleted" and must not be reported as one. Paths are sent in Jellyfin's own spelling
   * (`fromContainer`); a path in a root Jellyfin does not see has none, and is not sent.
   *
   * Never throws. The bytes are already gone; a Jellyfin that could not be told is a stale index the
   * next library scan corrects, so the outcome is audited rather than allowed to fail the plan — a
   * list of deleted paths that could not even be read included: Jellyfin was not told, and the audit
   * is the only place that says so.
   */
  async function notifyJellyfin(planId: string, actor: string, pathMap: PathMap): Promise<void> {
    const audit = (outcomeName: string, after: Record<string, unknown>) => {
      try {
        writeAudit(deps.db, { actor, actionType: 'notify-jellyfin', subject: planId, outcome: outcomeName, after, planId })
      } catch { /* a database fault is already the run's own failure; it is reported there */ }
    }
    let deleted: string[]
    try {
      deleted = (deps.db.prepare('SELECT container_path FROM deleted_paths WHERE plan_id = ? ORDER BY container_path')
        .all(planId) as Array<{ container_path: string }>).map((r) => r.container_path)
    } catch (err) {
      audit('failed', { error: `the plan's deleted_paths could not be read, so Jellyfin was not told: ${(err as Error).message}` })
      return
    }
    if (deleted.length === 0) return

    const jellyfinPaths: string[] = []
    const stillPresent: string[] = []
    const notInJellyfin: string[] = []
    for (const path of deleted) {
      let gone: boolean
      try {
        gone = lstatIfPresent(path) === null
      } catch {
        gone = false // could not look, so not confirmed gone
      }
      if (!gone) {
        stillPresent.push(path)
        continue
      }
      const jellyfinPath = pathMap.fromContainer(path)
      if (jellyfinPath) jellyfinPaths.push(jellyfinPath)
      else notInJellyfin.push(path)
    }
    const after = { jellyfinPaths, stillPresent, notInJellyfin }
    if (jellyfinPaths.length === 0) {
      audit('skipped', after)
      return
    }
    try {
      await deps.jellyfin.notifyPathsDeleted(jellyfinPaths)
      audit('done', after)
    } catch (err) {
      audit('failed', { ...after, error: (err as Error).message })
    }
  }

  async function runAction(action: PlanActionView, context: RunContext): Promise<ActionOutcome> {
    const type: string = action.type
    switch (action.type) {
      case 'merge-versions': {
        const ids = action.payload.itemIds ?? []
        if (ids.length < 2) return failure('merge-versions requires at least two item ids')
        await deps.jellyfin.mergeVersions(ids)
        return outcome('done', { detail: { merged: ids } })
      }
      case 'split-versions': {
        const id = action.payload.itemIds?.[0]
        if (!id) return failure('split-versions requires an item id')
        await deps.jellyfin.splitVersions(id)
        return outcome('done', { detail: { split: id } })
      }
      case 'delete-media':
      case 'delete-junk-file':
      case 'remove-empty-folder':
        return runPathAction(action, context)
      default:
        return failure(`unknown action type ${type}`)
    }
  }

  /**
   * The single gate every filesystem-touching action passes through. Confinement, live resolution
   * and the guards happen HERE, once, so there is no way to reach `unlinkSync`/`rmdirSync`/
   * `deleteWithData` without them: the three primitives are only ever called downstream of this
   * function.
   */
  async function runPathAction(action: PlanActionView, context: RunContext): Promise<ActionOutcome> {
    const target = action.payload.targetPath
    if (!target) return failure('action carries no target path')

    // Re-checked here rather than inherited from plan time: `isWithinRoot` resolves symlinks, and
    // a symlink can be swapped between approval and execution.
    const root = context.pathMap.rootFor(target)
    if (!root || !context.pathMap.isWithinRoot(target, root)) {
      return failure(`refusing to act on a path outside every configured root: ${target}`)
    }

    const plannedPaths = eligiblePaths(context.planId)
    const resolution = await resolveTarget(context.resolveDeps, target, context.config)
    const verdicts = evaluateGuards(resolution, context.config, {
      plannedPaths,
      // rmdir takes nothing but an empty directory; only the delete actions reach deleteWithData.
      removesTorrentData: action.type !== 'remove-empty-folder',
      removedThisRun: context.removedThisRun,
    })

    // An override is a PRE-AUTHORISATION, and an operator can only pre-authorise something the plan
    // actually put in front of them. The guards below are re-run against LIVE state, so a guard
    // that passed at plan time can block here — a `sample.mkv` whose single-file torrent owns
    // eleven episodes by the time the plan runs is the concrete case — and honouring an override
    // for a guard that was GREEN at approval would clear that block on the strength of a question
    // nobody was ever asked. The audit row would read "overrode guard.torrent-scope", which is true
    // and useless. So the overrides that count are the intersection with the APPROVED snapshot:
    // `action.guardVerdicts` is `guard_verdicts_json`, which `settle` deliberately never overwrites.
    // (`buildPlan` also drops such an override before storing anything; this is the second line,
    // and the one that holds for a plan written by anything else.)
    const requestedOverrides = action.payload.overrides ?? []
    const blockedAtApproval = new Set(
      action.guardVerdicts.filter((v) => v.outcome === 'block').map((v) => v.guard),
    )
    const honoured = requestedOverrides.filter((g) => blockedAtApproval.has(g))
    const ignoredOverrides = requestedOverrides.filter((g) => !blockedAtApproval.has(g))

    const blocked = isBlocked(verdicts, honoured)
    if (blocked.blocked) {
      const why = verdicts.filter((v) => blocked.by.includes(v.guard)).map((v) => `${v.guard}: ${v.reason}`)
      // Naming the ignored override matters: without it this reads as a guard the operator thought
      // they had already answered for, and the remedy (re-plan, so the block is on screen) is not
      // obvious from the block alone.
      const stale = ignoredOverrides.filter((g) => blocked.by.includes(g))
      const note = stale.length
        ? `; the override of ${stale.join(', ')} was ignored — ${stale.length > 1 ? 'those guards were' : 'that guard was'} `
          + 'not blocking when this plan was approved, so nothing about this was shown to the approver. Re-plan to decide it.'
        : ''
      return outcome('blocked', {
        verdicts,
        error: `blocked by ${why.join('; ')}${note}`,
        detail: { path: target, ignoredOverrides },
      })
    }

    let result: ActionOutcome
    if (action.type === 'remove-empty-folder') {
      result = removeEmptyFolder(target, root, context.pathMap)
    } else if (action.type === 'delete-media' || action.type === 'delete-junk-file') {
      result = await deleteTarget(action.type, target, root, resolution, plannedPaths, context)
    } else {
      // Unreachable: `runAction` only routes the three path actions here. Spelled out rather than
      // cast, so adding a sixth action type is a compile error at the guard gate, not a silent
      // fall-through into the delete path.
      result = failure(`${action.type} is not a path action`)
    }
    return { ...result, verdicts }
  }

  function removeEmptyFolder(target: string, root: PathMapping, pathMap: PathMap): ActionOutcome {
    if (samePath(target, root.container)) {
      return failure(`refusing to remove a configured root itself: ${target}`)
    }
    if (!existsSync(target)) return outcome('done', { detail: { alreadyGone: true } })
    // lstat, not stat: a symlink pointing at a directory is not a directory to remove, and
    // rmdir would fail on it anyway. Refusing outright says so honestly.
    if (!lstatSync(target).isDirectory()) return failure(`target is not a directory: ${target}`)
    if (readdirSync(target).length > 0) return skip('folder is no longer empty')

    rmdirSync(target)
    const swept = sweepEmptyParents(dirname(target), root, pathMap)
    return outcome('done', { detail: { removed: [target, ...swept] } })
  }

  /**
   * Confirms every *arr record for one path is unmonitored, fail-closed: anything short of a
   * confirmed flip returns the skip that stops the delete, and nothing is deleted on a maybe.
   * `where` is empty for this action's own target and names the file otherwise, so a refusal on a
   * SIBLING's account says which sibling — the operator needs to know which title to look at, and
   * "delete skipped" with no path is not an answer.
   */
  async function confirmUnmonitored(records: ArrMatch[], where: string): Promise<ActionOutcome | null> {
    for (const record of records) {
      const client = record.kind === 'radarr' ? deps.radarr : deps.sonarr
      if (!client) {
        // Unreachable by construction (the same client produced the match), and still not treated
        // as "nothing to unmonitor" — that assumption is exactly what re-downloads a deleted file.
        return skip(`${record.kind} has no client configured, so ${record.title}${where} cannot be unmonitored; delete skipped`)
      }
      let unmonitor
      try {
        // The *arr-NATIVE path, which is what both connectors match on. See ArrMatch.arrPath.
        unmonitor = await client.unmonitorByPath(record.arrPath)
      } catch (err) {
        return skip(`${record.kind} unmonitor threw (${(err as Error).message})${where}; delete skipped so it cannot re-grab the title`)
      }
      if (unmonitor.outcome !== 'unmonitored') {
        // 'lookup-failed' is "I could not look". 'not-managed' here contradicts the inventory that
        // produced this very match, so the flip provably did not happen for a file that IS
        // managed. Both mean the same thing to a delete: not safe.
        return skip(
          `${record.kind} did not confirm unmonitoring ${record.title}${where} (${unmonitor.outcome}); delete skipped`,
          { arrPath: record.arrPath },
        )
      }
    }
    return null
  }

  /**
   * The OTHER files this action's torrent removal would destroy — restricted to paths this plan
   * still intends to delete, which after `guard.torrent-scope` has passed is all of its media.
   *
   * The target's own path and every hardlink to it are excluded: those are the same inode under
   * another name (the standard *arr layout), already covered by the target's own `resolution.arr`.
   * A file the plan does NOT name is excluded too — `guard.torrent-scope` is what answers for those
   * and it blocks unless the operator explicitly overrode it (or the file is a companion of the
   * release, which no *arr manages), at which point they have said in so many words that the rest
   * of the torrent may go.
   */
  function siblingsToUnmonitor(resolution: Resolution, plannedPaths: Set<string>): string[] {
    const mine = new Set([resolution.path, ...resolution.hardlinks])
    const siblings = new Set<string>()
    for (const t of resolution.torrents) {
      for (const e of t.files?.entries ?? []) {
        if (e.containerPath && !mine.has(e.containerPath) && plannedPaths.has(e.containerPath)) siblings.add(e.containerPath)
      }
    }
    return [...siblings].sort()
  }

  async function deleteTarget(
    type: Extract<ActionType, 'delete-media' | 'delete-junk-file'>,
    target: string,
    root: PathMapping,
    resolution: Resolution,
    plannedPaths: Set<string>,
    context: RunContext,
  ): Promise<ActionOutcome> {
    // The identity of the bytes the guards just cleared, captured before anything is touched and
    // re-checked immediately before the unlink. Steps 1 and 2 below talk to two services and can
    // take a minute; an *arr upgrade importing a replacement file into this exact path in that
    // window is a real event, not a hypothetical. `dev`/`ino` alone would not catch it — a
    // freshly created file routinely REUSES the inode number just freed — so size and mtime are
    // part of the identity. `ctime` deliberately is not: removing a sibling hardlink in step 2
    // bumps it legitimately.
    let identity: { dev: number; ino: number; size: number; mtimeMs: number; nlink: number } | null = null
    if (existsSync(target)) {
      const st = lstatSync(target)
      if (st.isSymbolicLink()) {
        return skip(`${target} is a symlink; unlinking it would free nothing and leave the real file`)
      }
      if (!st.isFile()) return failure(`${target} is not a regular file`)
      if (!resolution.exists || Number(st.dev) !== resolution.dev || Number(st.ino) !== resolution.inode) {
        return skip(`${target} changed identity between the guard check and the delete`)
      }
      identity = { dev: Number(st.dev), ino: Number(st.ino), size: st.size, mtimeMs: st.mtimeMs, nlink: st.nlink }
    }

    const torrents = distinctTorrents(resolution.torrents)
    // Recorded with the instance each torrent was removed from: the same infohash on two boxes is
    // two torrents, and a bare hash cannot say which box lost its copy.
    const refs: TorrentRef[] = torrents.map((t) => ({ instanceId: t.instanceId, hash: t.hash }))
    const named = describeRefs(refs)

    // A file an EARLIER action of this run took when it removed the torrent owning it — the next
    // episode of a fully queued pack — which qBittorrent may still be deleting. No live torrent owns
    // it now, so there is no torrent left to remove: this action finishes that delete. That holds
    // only for the very bytes the torrent owned. In a torrent-backed root guard.untracked has already
    // refused a different dev, inode or size; the whole identity, mtime included (a Resolution does
    // not carry it), is re-checked here whatever the root, so nothing else is ever settled this way.
    const earlier = context.removedThisRun.get(target)
    const was = earlier?.identity
    if (was && torrents.length === 0 && identity !== null && (identity.dev !== was.dev || identity.ino !== was.inode
      || identity.size !== was.sizeBytes || identity.mtimeMs !== was.mtimeMs)) {
      return skip(`${target} changed identity after the torrent that owned it was removed; nothing here was deleted`)
    }
    const finishingEarlierRemoval = earlier?.identity != null && torrents.length === 0

    // ---- 1. *arr unmonitor. Fail-closed: anything short of a confirmed flip skips the delete.
    //
    // Not only this action's own target. Step 2 removes each matched torrent WITH ALL OF ITS DATA,
    // and `guard.torrent-scope` passes precisely when the torrent's OTHER media files are named by
    // other actions in this same plan — actions whose *arr step has not happened yet. Unmonitoring
    // the target alone and then removing the torrent takes twelve episodes while eleven of them are
    // still monitored in Sonarr; the first of those to fail its own unmonitor a moment later would
    // report `skipped` — "delete skipped so it cannot re-grab the title" — with its bytes already
    // gone and Sonarr free to re-grab it. The constraint would be satisfied on paper and violated
    // in fact. So the whole set is confirmed BEFORE the torrent goes, and if any ONE of them cannot
    // be confirmed the torrent is not removed at all and every one of those files stays put. Their
    // own actions then run normally later, or are skipped on their own merits.
    const targetFailure = await confirmUnmonitored(resolution.arr, '')
    if (targetFailure) return targetFailure

    for (const sibling of torrents.length > 0 ? siblingsToUnmonitor(resolution, plannedPaths) : []) {
      const also = `, a file torrent ${named} would also destroy`
      let siblingResolution: Resolution
      try {
        siblingResolution = await resolveTarget(context.resolveDeps, sibling, context.config)
      } catch (err) {
        return skip(
          `${sibling}${also}, could not be resolved (${(err as Error).message}); delete skipped`,
          { sibling, torrents: refs },
        )
      }
      // The same fail-closed rule `guard.protected` applies to the target: an empty `arr` list from
      // a source that could not be verified is "unknown", not "not managed", and unknown is never
      // permission to take this sibling's bytes.
      const unverifiable = siblingResolution.sourcesUnavailable.filter((s) => s === 'radarr' || s === 'sonarr')
      if (unverifiable.length) {
        return skip(
          `${unverifiable.join(' and ')} could not be verified for ${sibling}${also}, so it cannot be `
          + 'confirmed unmonitored; delete skipped',
          { sibling, torrents: refs },
        )
      }
      const siblingFailure = await confirmUnmonitored(siblingResolution.arr, ` for ${sibling}${also}`)
      if (siblingFailure) {
        return { ...siblingFailure, detail: { ...siblingFailure.detail, sibling, torrents: refs } }
      }
    }

    // ---- 2. qBittorrent removes its own data, and must confirm it — per instance. Two boxes can
    // seed the same infohash over different bytes, so a hash means nothing without the instance
    // that reported it: each instance's client is handed only its own hashes, and no client is
    // ever asked about another instance's torrent.
    const byInstance = new Map<string, string[]>()
    for (const ref of refs) byInstance.set(ref.instanceId, [...(byInstance.get(ref.instanceId) ?? []), ref.hash])
    // Every client is found BEFORE any instance deletes anything, so a missing one cannot leave
    // this file half-removed: one box's torrent gone, the other's still seeding it.
    const routed: Array<{ instanceId: string; client: InstanceClient; hashes: string[] }> = []
    for (const [instanceId, hashes] of byInstance) {
      const client = deps.qbittorrents.get(instanceId)
      if (!client) {
        return failure(`torrents on qBittorrent instance ${instanceId} back this file, but that instance has no client; nothing was deleted`)
      }
      routed.push({ instanceId, client, hashes })
    }
    // The plan's other files these torrents own, as they stand before the removal: what a later
    // action of this run must recognise as the rest of this delete, and nothing written there since.
    const taken = plannedFilesTaken(torrents, target, plannedPaths)
    const takenBefore = new Map([...taken.keys()].map((path) => [path, fileIdentity(path)] as const))
    const confirmedRemoved: TorrentRef[] = []
    for (const { instanceId, client, hashes } of routed) {
      try {
        await client.deleteWithData(hashes)
        if (!await client.awaitGone(hashes)) {
          return failure(`qBittorrent instance ${instanceId} did not confirm removal of ${hashes.join(', ')}; the file was left alone`)
        }
      } finally {
        // That instance has (or may have) just changed: no later action may be judged from a list
        // read before the delete, so its next resolution reads it again.
        context.torrentLists.invalidate(instanceId)
      }
      // Confirmed gone from this instance, so from here on its files are this run's delete to finish
      // — recorded per instance, so a later instance's failure cannot unrecord what this one removed.
      confirmedRemoved.push(...refs.filter((r) => r.instanceId === instanceId))
      for (const [path, owners] of taken) {
        const removedOwners = owners.filter((o) => confirmedRemoved.some((r) => torrentKey(r) === torrentKey(o)))
        if (removedOwners.length) context.removedThisRun.set(path, { torrents: removedOwners, identity: takenBefore.get(path) ?? null })
      }
    }

    // ---- 3. Whatever qBittorrent leaves at this path. It deletes asynchronously — torrents/delete
    // answers before the files are gone, and an NFS client can see a removed file for a while after
    // — so when the torrent owns this path it gets up to goneTimeoutMs to take it. The same wait, on
    // the same clock, covers the plan's other files the removal took: their own actions come next,
    // and each should find its file gone rather than race qBittorrent for it. A file an earlier
    // action's removal took is waited on the same way. Only then is anything here touched, and only
    // through the identity check.
    const waitFor: string[] = []
    if (identity !== null && (finishingEarlierRemoval || (torrents.length > 0 && qbittorrentTakes(torrents, target)))) {
      waitFor.push(target)
    }
    for (const [path, before] of takenBefore) if (before !== null) waitFor.push(path)
    await waitUntilGone(waitFor)

    let disposition: Disposition = 'already-gone'
    /** Whether this target's own bytes are reclaimed: its last link went, and not into the trash. */
    let targetFreed = false
    const detail: Record<string, unknown> = { path: target, torrents: refs }
    if (finishingEarlierRemoval) detail.removedWith = earlier!.torrents

    const live = lstatIfPresent(target)
    if (live) {
      // Different bytes are sitting at this path than the ones the guards cleared (or a file has
      // appeared where there was none). Nothing here has been judged, so nothing here is deleted.
      if (
        !identity || live.isSymbolicLink() || !live.isFile()
        || Number(live.dev) !== identity.dev || Number(live.ino) !== identity.ino
        || live.size !== identity.size || live.mtimeMs !== identity.mtimeMs
      ) {
        return skip(`${target} changed identity between the guard check and the delete`)
      }

      // `nlink` is read HERE, after qBittorrent removed its own link, not from the pre-delete
      // resolution: in the standard hardlinked *arr setup that is the difference between honestly
      // reporting the reclaimed bytes and reporting zero for every torrent-backed file.
      const lastLink = live.nlink <= 1
      const unlinkHere = () => {
        try {
          unlinkSync(target)
          disposition = 'unlinked'
          targetFreed = lastLink
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
          // Gone between the look and the unlink. With a torrent removed a moment ago — by this
          // action, or by an earlier one that took this file with it — that is qBittorrent finishing
          // its own delete: not a failure, and not this action's unlink. With no torrent involved,
          // something else entirely took it.
          disposition = torrents.length > 0 || finishingEarlierRemoval ? 'removed-by-qbittorrent' : 'already-gone'
          targetFreed = torrents.length > 0 && lastLink
        }
      }
      // Trash covers non-torrent files only. qBittorrent owns the bytes of anything it seeds, and
      // pre-moving them would defeat the point of reclaiming the space. A file whose torrent an
      // earlier action removed with its data is a torrent file qBittorrent is deleting, not one to keep.
      if (type === 'delete-junk-file' && torrents.length === 0 && !finishingEarlierRemoval) {
        const trashed = moveToTrash(
          { db: deps.db, config: context.config, pathMap: context.pathMap },
          { path: target, planId: context.planId, sizeBytes: live.size },
        )
        if (trashed.trashed) {
          // Deliberately not `targetFreed`: a trashed file still occupies every byte it did before.
          disposition = 'trashed'
          detail.trashPath = trashed.trashPath
        } else {
          detail.trashRefused = trashed.reason
          unlinkHere()
        }
      } else {
        unlinkHere()
      }
    } else if (identity !== null && torrents.length > 0) {
      // It was still there when this action fingerprinted it, and there WAS a torrent to remove, so
      // step 2 is what took it. Both halves matter: a file that vanished during the guard phase —
      // or with no torrent involved at all — was taken by something else entirely, and crediting
      // this action for the bytes would claim space nothing here freed.
      disposition = 'removed-by-qbittorrent'
      targetFreed = identity.nlink <= 1
    } else if (finishingEarlierRemoval) {
      // Gone before this action looked, or during its wait: the earlier action's removal finished.
      disposition = 'removed-by-qbittorrent'
    }

    // Bytes are credited per torrent removed, not per action: the torrent took every file it owned,
    // companions included, and a second action naming the same pack finds its file already gone.
    // Each file is credited once per run (see creditTorrentFiles). Only when this target's own bytes
    // were reclaimed, though — a torrent whose files have another link outside this plan freed nothing.
    // A file an earlier action's removal took is that torrent's, credited (or not) by that action, so
    // finishing its delete here credits nothing, whoever's unlink got there.
    let bytesFreed = 0
    if (targetFreed && !finishingEarlierRemoval) {
      bytesFreed = torrents.length > 0
        ? [...creditTorrentFiles(torrents, context.credited).values()].reduce((sum, b) => sum + b, 0)
        : (live?.size ?? 0)
    }
    detail.disposition = disposition
    detail.bytesFreed = bytesFreed

    // ---- 4. The now-empty parents, and not one directory above the root.
    if (disposition !== 'already-gone') {
      detail.sweptDirectories = sweepEmptyParents(dirname(target), root, context.pathMap)
    }

    // ---- 5. The path is gone, whoever took it: recorded, so the read models can hide it at once and
    // the run's end can tell Jellyfin (step 6). Upserted: a path a later plan deletes again (a
    // re-download removed once more) belongs to that plan from then on.
    deps.db.prepare(`INSERT INTO deleted_paths (container_path, plan_id, deleted_at) VALUES (?,?,?)
      ON CONFLICT(container_path) DO UPDATE SET plan_id = excluded.plan_id, deleted_at = excluded.deleted_at`)
      .run(target, context.planId, nowIso())
    detail.jellyfinPath = context.pathMap.fromContainer(target)

    return outcome('done', { bytesFreed, detail })
  }

  /**
   * Step 3's wait: until every one of `paths` is gone, or goneTimeoutMs has passed — one budget for
   * all of them, not one each. A path that cannot be looked at is not waited on; the target's own
   * look straight after the wait reports that failure.
   */
  async function waitUntilGone(paths: string[]): Promise<void> {
    const deadline = Date.now() + goneTimeoutMs
    const present = (path: string) => {
      try {
        return lstatIfPresent(path) !== null
      } catch {
        return false
      }
    }
    let waiting = paths.filter(present)
    while (waiting.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, gonePollMs))
      waiting = waiting.filter(present)
    }
  }

  /**
   * Walks upward removing directories that are now empty, and stops dead at the root. The three
   * independent stops that have to agree before each step upward live in `canSweepInto`, shared
   * with the planner's dry-run preview so the two cannot drift on where the sweep ends.
   */
  function sweepEmptyParents(from: string, root: PathMapping, pathMap: PathMap): string[] {
    const removed: string[] = []
    let current = from
    for (let depth = 0; depth < MAX_SWEEP_DEPTH; depth += 1) {
      if (!canSweepInto(current, root, pathMap)) break
      try {
        if (!existsSync(current)) break
        if (!lstatSync(current).isDirectory()) break
        if (readdirSync(current).length > 0) break
        rmdirSync(current)
      } catch {
        break
      }
      removed.push(current)
      current = dirname(current)
    }
    return removed
  }

  return { execute, start, requestStop, idle, isRunning: () => running }
}

function subjectOf(action: PlanActionView): string {
  return action.payload.targetPath ?? (action.payload.itemIds ?? []).join(',')
}
