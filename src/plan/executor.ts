import { existsSync, lstatSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import type { Db } from '../index/db.js'
import type { FileConfig } from '../config/schema.js'
import type { PathMap } from '../fs/pathmap.js'
import type { ActionStatus, ActionType, GuardVerdict, PathMapping } from '../core/types.js'
import type { JellyfinClient } from '../connectors/jellyfin.js'
import type { QbitClient } from '../connectors/qbittorrent.js'
import type { ArrClient } from '../connectors/arr.js'
import { resolveTarget, snapshotInventory, type ResolveDeps, type Resolution } from './resolve.js'
import { evaluateGuards, isBlocked } from './guards.js'
import { getPlan, type PlanActionView } from './planner.js'
import { moveToTrash } from './trash.js'
import { writeAudit } from './audit.js'

export interface ExecutorDeps {
  db: Db
  config: FileConfig
  pathMap: PathMap
  qbittorrent: Pick<QbitClient, 'torrents' | 'files' | 'deleteWithData' | 'awaitGone'> | null
  radarr: Pick<ArrClient, 'inventory' | 'unmonitorByPath'> | null
  sonarr: Pick<ArrClient, 'inventory' | 'unmonitorByPath'> | null
  jellyfin: Pick<JellyfinClient, 'deleteItem' | 'getItem' | 'mergeVersions' | 'splitVersions' | 'refreshLibrary'>
}

export interface ExecutionSummary {
  planId: string
  status: 'completed' | 'failed'
  done: number
  failed: number
  skipped: number
  blocked: number
  bytesFreed: number
}

/** A directory tree deeper than this below a root is a symptom, not a library. Bounds the sweep. */
const MAX_SWEEP_DEPTH = 256

/** Everything an action needs from the run it belongs to, rather than from module state. */
interface RunContext {
  planId: string
  /** `deps` with the *arr inventory snapshotted for this run. Never used for the unmonitor call. */
  resolveDeps: ResolveDeps
  /** Every container path the plan removes, for `guard.torrent-scope`. */
  plannedPaths: Set<string>
  /** Items whose merge state this plan changes, so the index no longer describes them. */
  mergedItemIds: Set<string>
}

type TerminalStatus = Extract<ActionStatus, 'done' | 'failed' | 'skipped' | 'blocked'>

interface ActionOutcome {
  status: TerminalStatus
  bytesFreed: number
  /** Whether this action changed something Jellyfin's index would now be wrong about. */
  needsRefresh: boolean
  error?: string
  detail: Record<string, unknown>
  /** The LIVE verdicts this action was judged on, not the ones stored at plan time. */
  verdicts?: GuardVerdict[]
}

const outcome = (
  status: TerminalStatus,
  over: Partial<ActionOutcome> = {},
): ActionOutcome => ({ status, bytesFreed: 0, needsRefresh: false, detail: {}, ...over })

const failure = (error: string, detail: Record<string, unknown> = {}) => outcome('failed', { error, detail })
const skip = (error: string, detail: Record<string, unknown> = {}) => outcome('skipped', { error, detail })

const nowIso = () => new Date().toISOString()

/**
 * Two paths that name the same directory, whether or not the strings agree. The lexical compare
 * catches the common case cheaply; the realpath compare catches a root reached through a symlink,
 * which is the one that matters — it is the last stop between the sweep and the root's parent.
 */
function samePath(a: string, b: string): boolean {
  if (resolvePath(a) === resolvePath(b)) return true
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

/**
 * Runs an approved plan. Everything dangerous in Jellymaid happens inside this file, in one fixed
 * order, behind one guard gate:
 *
 *   1. *arr unmonitor — fail-closed, so nothing can re-grab the title mid-delete
 *   2. qBittorrent delete-with-data, confirmed gone
 *   3. whatever qBittorrent left (this path's own link), trashed or unlinked
 *   4. the now-empty parent directories, never above the mapped root
 *   5. Jellyfin, then ONE batched refresh after the whole plan
 *
 * The approved plan is an immutable snapshot of what the operator agreed to; it is never treated
 * as a licence to act on the facts that were true when they agreed. Every action re-resolves its
 * target against live services and re-runs the guards immediately before touching anything.
 */
export function createExecutor(deps: ExecutorDeps) {
  let running = false

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

  async function execute(planId: string, actor: string): Promise<ExecutionSummary> {
    // The mutex is claimed before ANY other work, including the validating reads, so that no later
    // edit which introduces an await into validation can open a window for a second run. It is
    // released in a finally, so a rejected execution cannot wedge the executor shut.
    if (running) throw new Error('a plan is already running')
    running = true
    try {
      return await runPlan(planId, actor)
    } finally {
      running = false
    }
  }

  async function runPlan(planId: string, actor: string): Promise<ExecutionSummary> {
    const plan = getPlan(deps.db, planId)
    if (!plan) throw new Error(`plan ${planId} does not exist`)
    if (plan.status !== 'approved') throw new Error(`plan ${planId} is not approved (status: ${plan.status})`)

    // The in-process mutex above only binds THIS executor instance. This one binds the database,
    // so a second process (or a second executor built by mistake) cannot delete concurrently with
    // the first. Check and claim are ONE immediate transaction — BEGIN IMMEDIATE takes the write
    // lock before the SELECT, so two connections cannot both read "nothing is running" and then
    // both claim. A plan left `running` by a crash holds the lock until an operator resumes it,
    // which is the point: its actions are in an unknown half-done state.
    const claim = deps.db.transaction((): string | null => {
      const busy = deps.db.prepare("SELECT id FROM plans WHERE status = 'running' AND id != ? LIMIT 1")
        .get(planId) as { id: string } | undefined
      if (busy) return busy.id
      // `AND status='approved'` so losing the race is visible as zero rows changed rather than
      // stomping a state some other writer moved on from.
      const claimed = deps.db.prepare("UPDATE plans SET status='running', started_at=? WHERE id=? AND status='approved'")
        .run(nowIso(), planId)
      return claimed.changes === 1 ? null : planId
    })
    const heldBy = claim.immediate()
    if (heldBy) throw new Error(`plan ${heldBy} is already running; resume or finish it first`)

    const summary: ExecutionSummary = {
      planId, status: 'completed', done: 0, failed: 0, skipped: 0, blocked: 0, bytesFreed: 0,
    }
    let needsRefresh = false
    /**
     * Items whose merge state this plan changes, seeded from the WHOLE plan rather than from the
     * merges this particular run performs: on a resume the merge already ran in the interrupted
     * attempt, and the index is exactly as stale as if it had run a moment ago. A merge that never
     * ran at all only costs a refresh in place of an item delete, which is the safe direction.
     */
    const mergedItemIds = new Set<string>(
      plan.actions
        .filter((a) => a.type === 'merge-versions' || a.type === 'split-versions')
        .flatMap((a) => a.payload.itemIds ?? []),
    )

    /**
     * Every path this plan removes, for `guard.torrent-scope`. Taken from the whole approved plan
     * including actions already done — a resumed plan still "targets" what its first attempt
     * removed, and forgetting that would block the tail of every resumed multi-file delete.
     */
    const plannedPaths = new Set(
      plan.actions.filter((a) => a.type === 'delete-media' || a.type === 'delete-junk-file')
        .map((a) => a.payload.targetPath).filter((p): p is string => p !== undefined),
    )

    // One *arr inventory for the whole run rather than one per action; see snapshotInventory for
    // why the unmonitor call and the torrent list are deliberately left un-snapshotted.
    const resolveDeps: ResolveDeps = {
      ...deps, radarr: snapshotInventory(deps.radarr), sonarr: snapshotInventory(deps.sonarr),
    }

    const context: RunContext = { planId, resolveDeps, plannedPaths, mergedItemIds }

    try {
      // Actions run in `seq` order — the order the planner fixed (merges first) and the operator
      // approved. The executor never re-sorts and never skips ahead.
      for (const action of plan.actions) {
        // Idempotence: an action that already reached a terminal state is not re-run. A resume hands
        // back only the unfinished tail (the API route flips `running` rows back to `pending`).
        if (action.status !== 'pending') continue

        markRunning(action.id)
        let result: ActionOutcome
        try {
          result = await runAction(action, context)
        } catch (err) {
          result = failure((err as Error).message)
        }

        summary.bytesFreed += result.bytesFreed
        needsRefresh ||= result.needsRefresh
        if (result.status === 'done') summary.done += 1
        else if (result.status === 'skipped') summary.skipped += 1
        else if (result.status === 'blocked') summary.blocked += 1
        else summary.failed += 1

        // The terminal status and its audit row land together or not at all. The audit log is the
        // only record of what was done to an operator's files, so an action must never be able to
        // reach `done` with nothing written about it — if this throws, the row stays `running` and
        // the catch below hands it back as `pending` for an idempotent re-run.
        deps.db.transaction(() => {
          settle(action.id, result)
          writeAudit(deps.db, {
            actor,
            actionType: action.type,
            subject: subjectOf(action),
            before: { guardVerdicts: result.verdicts ?? [], overrides: action.payload.overrides ?? [] },
            after: { status: result.status, bytesFreed: result.bytesFreed, error: result.error ?? null, ...result.detail },
            outcome: result.status,
            planId,
            planActionId: action.id,
          })
        })()
      }

      // ONE refresh for the whole plan, after every file has settled — never per action.
      if (needsRefresh) {
        try {
          await deps.jellyfin.refreshLibrary()
          writeAudit(deps.db, { actor, actionType: 'refresh-library', subject: planId, outcome: 'done', planId })
        } catch (err) {
          // The bytes are already gone; a stale Jellyfin index is a cosmetic problem the next scan
          // or a manual refresh fixes, so this is recorded rather than allowed to fail the plan.
          writeAudit(deps.db, {
            actor, actionType: 'refresh-library', subject: planId, outcome: 'failed',
            after: { error: (err as Error).message }, planId,
          })
        }
      }

      if (summary.failed > 0) summary.status = 'failed'
      deps.db.prepare('UPDATE plans SET status=?, finished_at=? WHERE id=?').run(summary.status, nowIso(), planId)
      return summary
    } catch (err) {
      // A throw from OUTSIDE an action's own try — the bookkeeping writes, say, or a SQLite
      // hiccup. Sticky-by-design is the right answer for a process that died mid-plan, but not for
      // a transient fault in a process that is still alive: leaving the row `running` would make
      // every later execute on this database fail with "already running" until an operator noticed.
      // The claim goes back, the unfinished action returns to `pending` (it never reached a
      // terminal state, and every action is idempotent and re-guarded), and the error propagates.
      try {
        deps.db.prepare("UPDATE plan_actions SET status='pending' WHERE plan_id=? AND status='running'").run(planId)
        deps.db.prepare("UPDATE plans SET status='approved' WHERE id=? AND status='running'").run(planId)
      } catch { /* the database itself is the fault: leave the row for the resume route */ }
      throw err
    }
  }

  async function runAction(action: PlanActionView, context: RunContext): Promise<ActionOutcome> {
    const type: string = action.type
    switch (action.type) {
      case 'merge-versions': {
        const ids = action.payload.itemIds ?? []
        if (ids.length < 2) return failure('merge-versions requires at least two item ids')
        await deps.jellyfin.mergeVersions(ids)
        for (const id of ids) context.mergedItemIds.add(id)
        return outcome('done', { detail: { merged: ids } })
      }
      case 'split-versions': {
        const id = action.payload.itemIds?.[0]
        if (!id) return failure('split-versions requires an item id')
        await deps.jellyfin.splitVersions(id)
        context.mergedItemIds.add(id)
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
    const root = deps.pathMap.rootFor(target)
    if (!root || !deps.pathMap.isWithinRoot(target, root)) {
      return failure(`refusing to act on a path outside every configured root: ${target}`)
    }

    const resolution = await resolveTarget(context.resolveDeps, target)
    const verdicts = evaluateGuards(resolution, deps.config, {
      plannedPaths: context.plannedPaths,
      // rmdir takes nothing but an empty directory; only the delete actions reach deleteWithData.
      removesTorrentData: action.type !== 'remove-empty-folder',
    })
    const blocked = isBlocked(verdicts, action.payload.overrides ?? [])
    if (blocked.blocked) {
      const why = verdicts.filter((v) => blocked.by.includes(v.guard)).map((v) => `${v.guard}: ${v.reason}`)
      return outcome('blocked', { verdicts, error: `blocked by ${why.join('; ')}`, detail: { path: target } })
    }

    let result: ActionOutcome
    if (action.type === 'remove-empty-folder') {
      result = removeEmptyFolder(target, root)
    } else if (action.type === 'delete-media' || action.type === 'delete-junk-file') {
      result = await deleteTarget(action.type, target, root, resolution, context)
    } else {
      // Unreachable: `runAction` only routes the three path actions here. Spelled out rather than
      // cast, so adding a sixth action type is a compile error at the guard gate, not a silent
      // fall-through into the delete path.
      result = failure(`${action.type} is not a path action`)
    }
    return { ...result, verdicts }
  }

  function removeEmptyFolder(target: string, root: PathMapping): ActionOutcome {
    if (samePath(target, root.container)) {
      return failure(`refusing to remove a configured root itself: ${target}`)
    }
    if (!existsSync(target)) return outcome('done', { detail: { alreadyGone: true } })
    // lstat, not stat: a symlink pointing at a directory is not a directory to remove, and
    // rmdir would fail on it anyway. Refusing outright says so honestly.
    if (!lstatSync(target).isDirectory()) return failure(`target is not a directory: ${target}`)
    if (readdirSync(target).length > 0) return skip('folder is no longer empty')

    rmdirSync(target)
    const swept = sweepEmptyParents(dirname(target), root)
    return outcome('done', { detail: { removed: [target, ...swept] } })
  }

  async function deleteTarget(
    type: Extract<ActionType, 'delete-media' | 'delete-junk-file'>,
    target: string,
    root: PathMapping,
    resolution: Resolution,
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

    // ---- 1. *arr unmonitor. Fail-closed: anything short of a confirmed flip skips the delete.
    for (const record of resolution.arr) {
      const client = record.kind === 'radarr' ? deps.radarr : deps.sonarr
      if (!client) {
        // Unreachable by construction (the same client produced the match), and still not treated
        // as "nothing to unmonitor" — that assumption is exactly what re-downloads a deleted file.
        return skip(`${record.kind} has no client configured, so ${record.title} cannot be unmonitored; delete skipped`)
      }
      let unmonitor
      try {
        // The *arr-NATIVE path, which is what both connectors match on. See ArrMatch.arrPath.
        unmonitor = await client.unmonitorByPath(record.arrPath)
      } catch (err) {
        return skip(`${record.kind} unmonitor threw (${(err as Error).message}); delete skipped so it cannot re-grab the title`)
      }
      if (unmonitor.outcome !== 'unmonitored') {
        // 'lookup-failed' is "I could not look". 'not-managed' here contradicts the inventory that
        // produced this very match, so the flip provably did not happen for a file that IS
        // managed. Both mean the same thing to a delete: not safe.
        return skip(
          `${record.kind} did not confirm unmonitoring ${record.title} (${unmonitor.outcome}); delete skipped`,
          { arrPath: record.arrPath },
        )
      }
    }

    // ---- 2. qBittorrent removes its own data, and must confirm it.
    const hashes = [...new Set(resolution.torrents.map((t) => t.hash))]
    if (hashes.length > 0) {
      if (!deps.qbittorrent) {
        return failure('torrents back this file but qBittorrent is not configured')
      }
      await deps.qbittorrent.deleteWithData(hashes)
      if (!await deps.qbittorrent.awaitGone(hashes)) {
        return failure(`qBittorrent did not confirm removal of ${hashes.join(', ')}; the file was left alone`)
      }
    }

    // ---- 3. Whatever qBittorrent left: this path's own link.
    let disposition: 'unlinked' | 'trashed' | 'removed-by-qbittorrent' | 'already-gone' = 'already-gone'
    let bytesFreed = 0
    const detail: Record<string, unknown> = { path: target, torrents: hashes }

    if (existsSync(target)) {
      const live = lstatSync(target)
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
      // Trash covers non-torrent files only. qBittorrent owns the bytes of anything it seeds, and
      // pre-moving them would defeat the point of reclaiming the space.
      if (type === 'delete-junk-file' && hashes.length === 0) {
        const trashed = moveToTrash(deps, { path: target, planId: context.planId, sizeBytes: live.size })
        if (trashed.trashed) {
          disposition = 'trashed'
          detail.trashPath = trashed.trashPath
          // Deliberately no bytesFreed: a trashed file still occupies every byte it did before.
        } else {
          detail.trashRefused = trashed.reason
          unlinkSync(target)
          disposition = 'unlinked'
          bytesFreed = lastLink ? live.size : 0
        }
      } else {
        unlinkSync(target)
        disposition = 'unlinked'
        bytesFreed = lastLink ? live.size : 0
      }
    } else if (identity !== null && hashes.length > 0) {
      // It was still there when this action fingerprinted it, and there WAS a torrent to remove, so
      // step 2 is what took it. Both halves matter: a file that vanished during the guard phase —
      // or with no torrent involved at all — was taken by something else entirely, and crediting
      // this action for the bytes would also unlock the item delete on a row that is now stale.
      disposition = 'removed-by-qbittorrent'
      bytesFreed = identity.nlink <= 1 ? identity.size : 0
    }
    detail.disposition = disposition
    detail.bytesFreed = bytesFreed

    // ---- 4. The now-empty parents, and not one directory above the root.
    if (disposition !== 'already-gone') {
      detail.sweptDirectories = sweepEmptyParents(dirname(target), root)
    }

    // ---- 5. Jellyfin last, so the item only goes once its bytes actually have.
    let needsRefresh = disposition !== 'already-gone'
    const jf = resolution.jellyfin
    if (jf.itemId) {
      const survivingSiblings = jf.siblingPaths.filter((p) => existsSync(p))
      // DELETE /Items/{id} removes the item AND every file behind it. For a merged item that
      // includes the versions the operator chose to KEEP, so it is only ever safe when this path
      // is the item's own primary, nothing else of the item survives on disk, and this action is
      // the thing that removed the bytes. Everything else gets a refresh instead, which cleans up
      // items whose files have vanished without ever asking Jellyfin to delete a file:
      //  - an alternate version, whose item is the surviving one;
      //  - a surviving sibling version;
      //  - an item this plan re-merged, so the index no longer describes it;
      //  - a path that was ALREADY gone, where `container_path` is a stale index row and the item
      //    may since have been repointed at a different file — one this plan never guarded.
      const reason = jf.isAlternateVersion ? 'alternate-version'
        : survivingSiblings.length > 0 ? 'sibling-version-survives'
          : context.mergedItemIds.has(jf.itemId) ? 'merged-in-this-plan'
            : disposition === 'already-gone' ? 'nothing-was-removed-by-this-action'
              : null
      needsRefresh = true
      // The four reasons above all read the INDEX, which is a scan-time snapshot. A Merge Versions
      // performed outside Jellymaid since that scan makes a merged item look exactly like a
      // sibling-free primary, so the last word belongs to Jellyfin itself.
      const live = reason ? null : await verifyItemIsOnlyThisFile(jf.itemId, target)
      const finalReason = reason ?? live?.reason ?? null
      if (finalReason) {
        detail.jellyfin = { itemId: jf.itemId, action: 'refresh', reason: finalReason, survivingSiblings }
      } else {
        try {
          await deps.jellyfin.deleteItem(jf.itemId)
          detail.jellyfin = { itemId: jf.itemId, action: 'delete-item' }
        } catch (err) {
          // The bytes are already gone, so the accounting stands and the batched refresh still has
          // to run — but the action did not do everything it set out to, and says so.
          detail.jellyfin = { itemId: jf.itemId, action: 'delete-item', error: (err as Error).message }
          return outcome('failed', {
            bytesFreed,
            needsRefresh: true,
            detail,
            error: `${target} was deleted, but Jellyfin item ${jf.itemId} could not be removed: ${(err as Error).message}`,
          })
        }
      }
    }

    return outcome('done', { bytesFreed, needsRefresh, detail })
  }

  /**
   * Jellyfin's own answer to "is this item nothing but the file I just removed?". `DELETE /Items`
   * deletes the item's files, so anything short of a live, unambiguous yes falls through to a
   * refresh: more than one media source (a merge Jellymaid never saw), a source pointing somewhere
   * else (the item was repointed), an item Jellyfin no longer has, or a call that failed. A refresh
   * on a healthy item is harmless; a wrong delete is not.
   *
   * Returns null when the delete may proceed, or the reason to refresh instead.
   */
  async function verifyItemIsOnlyThisFile(itemId: string, target: string): Promise<{ reason: string } | null> {
    let live
    try {
      live = await deps.jellyfin.getItem(itemId)
    } catch (err) {
      return { reason: `live-item-check-failed: ${(err as Error).message}` }
    }
    if (!live) return { reason: 'jellyfin-no-longer-has-this-item' }
    if (live.mediaSourcePaths.length !== 1) {
      return { reason: `jellyfin-reports-${live.mediaSourcePaths.length}-media-sources` }
    }
    const only = live.mediaSourcePaths[0]!
    // Jellyfin reports its own namespace; the comparison happens in container space, which is the
    // only space in which "the file I just removed" is a fact rather than a guess.
    if (deps.pathMap.toContainer(only) !== target) {
      return { reason: 'jellyfin-media-source-is-a-different-file' }
    }
    return null
  }

  /**
   * Walks upward removing directories that are now empty, and stops dead at the root. Three
   * independent stops have to agree before each step upward, because a single off-by-one here
   * deletes an operator's library root:
   *
   *  - `samePath` against the root itself, so the root is never the thing removed;
   *  - `isWithinRoot`, which resolves symlinks and fails closed — a plain `startsWith` would let
   *    `/media/lib-backup` pass as inside `/media/lib`;
   *  - the filesystem root, as a backstop if the two above were ever misconfigured away.
   */
  function sweepEmptyParents(from: string, root: PathMapping): string[] {
    const removed: string[] = []
    let current = from
    for (let depth = 0; depth < MAX_SWEEP_DEPTH; depth += 1) {
      if (samePath(current, root.container)) break
      if (!deps.pathMap.isWithinRoot(current, root)) break
      if (current === dirname(current)) break
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

  return { execute, isRunning: () => running }
}

function subjectOf(action: PlanActionView): string {
  return action.payload.targetPath ?? (action.payload.itemIds ?? []).join(',')
}
