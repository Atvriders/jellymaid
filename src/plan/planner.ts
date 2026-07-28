import { randomUUID } from 'node:crypto'
import type { Db } from '../index/db.js'
import type { ActionType, GuardId, GuardVerdict, ActionStatus } from '../core/types.js'
import type { FileConfig } from '../config/schema.js'
import { resolveTarget, snapshotInventory, type ResolveDeps, type Resolution } from './resolve.js'
import { evaluateGuards, isBlocked } from './guards.js'
import { previewSweptDirectories } from './sweep.js'

export interface RequestedAction {
  type: ActionType
  targetPath?: string
  itemIds?: string[]
  overrides?: GuardId[]
}

export interface PlanRequest { createdBy: string; actions: RequestedAction[] }

export interface PlanActionView {
  id: string
  seq: number
  type: ActionType
  status: ActionStatus
  payload: RequestedAction & { resolution?: Resolution }
  guardVerdicts: GuardVerdict[]
  error: string | null
  /**
   * Surfaced from `payload.resolution.jellyfin.isAlternateVersion` so an operator reading the plan
   * — and Task 5's executor, which must refresh the surviving item rather than delete `itemId`
   * outright for one of these — can see it without drilling into the raw resolution. `null` for an
   * action that carries no resolution at all (e.g. `merge-versions`, which has no `targetPath`).
   */
  isAlternateVersion: boolean | null
}

export interface PlanView {
  id: string
  status: string
  createdBy: string
  createdAt: string
  approvedBy: string | null
  actions: PlanActionView[]
  dryRun: {
    deleteCount: number
    bytesFreed: number
    torrentsRemoved: number
    blockedCount: number
    /**
     * How many now-empty parent directories the executor's sweep would take along with the files.
     * The executor removes the target's whole empty parent chain, stopping at the mapped root, so
     * an operator approving one episode is really approving `Show/Season 01/` and possibly `Show/`
     * as well — and nothing else in this dry run said so. Computed by the same stop conditions the
     * real sweep uses; see `previewSweptDirectories`.
     */
    directoriesSwept: number
  }
}

export interface PlannerDeps extends ResolveDeps {
  config: FileConfig
}

/** Merges are library-only and cheap; running them first means a failed delete never leaves a half-merged group. */
const ORDER: Record<ActionType, number> = {
  'merge-versions': 0,
  'split-versions': 1,
  'delete-media': 2,
  'delete-junk-file': 3,
  'remove-empty-folder': 4,
}

interface ResolvedAction {
  action: RequestedAction
  resolution?: Resolution
  verdicts: GuardVerdict[]
  status: ActionStatus
}

/** The delete targets of every action not (yet) blocked — the plan's real scope. */
function deletePathsOf(resolved: ResolvedAction[]): Set<string> {
  return new Set(
    resolved
      .filter((r) => (r.action.type === 'delete-media' || r.action.type === 'delete-junk-file') && r.status !== 'blocked')
      .map((r) => r.action.targetPath)
      .filter((p): p is string => p !== undefined),
  )
}

export async function buildPlan(deps: PlannerDeps, request: PlanRequest): Promise<PlanView> {
  const planId = randomUUID()
  const createdAt = new Date().toISOString()

  const ordered = [...request.actions].sort((a, b) => ORDER[a.type] - ORDER[b.type])

  for (const action of ordered) {
    if (action.type === 'merge-versions' && (action.itemIds?.length ?? 0) < 2) {
      throw new Error('merge-versions requires at least two item ids')
    }
  }

  // One *arr inventory for the whole build, not one per action. See snapshotInventory.
  const resolveDeps: ResolveDeps = {
    ...deps, radarr: snapshotInventory(deps.radarr), sonarr: snapshotInventory(deps.sonarr),
  }

  // Pass 1: resolve every target against LIVE state and evaluate its guards, for every action,
  // before any byte accounting happens. This has to be a separate pass — not folded into the
  // accounting loop below — because whether one action's hardlinked sibling will actually run
  // (not merely was requested) depends on THAT SIBLING'S OWN guard verdict, and every
  // `RequestedAction` carries its own `overrides`, so two actions naming the very same inode can
  // land on different verdicts (one cleared by its override, the other not).
  const resolved: ResolvedAction[] = []
  for (const action of ordered) {
    let resolution: Resolution | undefined

    if (action.targetPath) {
      const root = deps.pathMap.rootFor(action.targetPath)
      if (!root || !deps.pathMap.isWithinRoot(action.targetPath, root)) {
        throw new Error(`refusing to plan an action outside every configured root: ${action.targetPath}`)
      }
      resolution = await resolveTarget(resolveDeps, action.targetPath)
    }

    resolved.push({ action, resolution, verdicts: [], status: 'pending' })
  }

  // Pass 2: judge every resolution. `guard.torrent-scope` asks "would removing this torrent take
  // files nobody named", which depends on which OTHER actions will actually run — and that depends
  // on their own verdicts, this one included. Guards are pure functions of an already-fetched
  // resolution, so the knot is untied by iterating to a fixed point instead of guessing: start
  // optimistic (every delete counts), re-judge with whatever survived, and repeat. Each pass can
  // only remove paths, never add them, so it converges in at most one iteration per action, and the
  // set it converges on is exactly `executablePaths` — the same "will actually run" set the byte
  // accounting below uses. Reading the RAW REQUEST here instead would let a blocked sibling vouch
  // for a torrent's scope on behalf of a delete that is never going to happen.
  let plannedPaths = deletePathsOf(resolved)
  for (let pass = 0; pass <= resolved.length; pass += 1) {
    for (const entry of resolved) {
      if (!entry.resolution) continue
      entry.verdicts = evaluateGuards(entry.resolution, deps.config, {
        plannedPaths,
        removesTorrentData: entry.action.type !== 'remove-empty-folder',
      })
      entry.status = isBlocked(entry.verdicts, entry.action.overrides ?? []).blocked ? 'blocked' : 'pending'
    }
    const next = deletePathsOf(resolved)
    if (next.size === plannedPaths.size) break
    plannedPaths = next
  }

  // An override is a PRE-AUTHORISATION, and an operator can only pre-authorise something the plan
  // actually put in front of them. An override naming a guard that does not block THIS action is at
  // best noise and at worst a blank cheque: the executor re-runs every guard against live state,
  // and a guard that passes here can block there — a `sample.mkv` whose single-file torrent owns
  // eleven episodes by execute time is the concrete case — at which point a pre-granted override
  // would clear a block nobody ever saw. Refused here, at build time, so the operator is asked
  // again with the block actually on screen rather than having answered a question nobody put to
  // them. (The executor intersects with the approved snapshot too; this is the half that gives the
  // caller a 400 and a reason instead of a silently useless override.)
  for (const entry of resolved) {
    const requested = entry.action.overrides ?? []
    if (requested.length === 0) continue
    const blocking = new Set(entry.verdicts.filter((v) => v.outcome === 'block').map((v) => v.guard))
    const unearned = requested.filter((g) => !blocking.has(g))
    if (unearned.length > 0) {
      throw new Error(
        `refusing to pre-authorise ${unearned.join(', ')} for `
        + `${entry.action.targetPath ?? entry.action.type}: ${unearned.length > 1 ? 'those guards do' : 'that guard does'} `
        + 'not block this action, so there is nothing for the override to clear and it would only '
        + 'stand ready to clear a block this plan never showed you',
      )
    }
  }

  // Only a path whose OWN action will actually run belongs in "this link goes away in this plan":
  // a blocked sibling's link survives execution no matter how many OTHER actions in the plan also
  // name its inode, so it must not count as one of the links being removed.
  const executablePaths = new Set(
    resolved.filter((r): r is ResolvedAction & { action: { targetPath: string } } =>
      r.action.targetPath !== undefined && r.status !== 'blocked').map((r) => r.action.targetPath),
  )

  let bytesFreed = 0
  let deleteCount = 0
  let blockedCount = 0
  const torrentHashes = new Set<string>()
  // Keyed by the inode's own identity (dev:inode — the same correlation key `fs_entries` and
  // `resolveTarget` use elsewhere), not by comparing target-path strings: two actions can name the
  // exact same path twice, which ties on any path-string comparison and would double-pay a single
  // link if "the lexicographically smallest participating path pays" were used instead.
  const countedInodes = new Set<string>()

  const rows: Array<{
    id: string; seq: number; type: ActionType; payload: RequestedAction & { resolution?: Resolution }
    verdicts: GuardVerdict[]; status: ActionStatus
  }> = []

  resolved.forEach(({ action, resolution, verdicts, status }, index) => {
    if (status === 'blocked') blockedCount += 1

    if (resolution && (action.type === 'delete-media' || action.type === 'delete-junk-file')) {
      deleteCount += 1
      // A blocked action never runs, so it can never free bytes or remove a torrent — only a
      // pending action's own resolution contributes to either total.
      if (status !== 'blocked') {
        // Space is reclaimed only when EVERY link to the inode goes away in this same plan.
        // Comparing the count of links THIS PLAN will actually remove against `nlink` — the
        // live-stat fact — rather than against the discovered link list matters twice over: if the
        // index knows about fewer links than the inode actually has, the honest answer is zero
        // (an untracked link cannot be proven to be part of this plan); and if a sibling link's own
        // action is blocked, that link is not going anywhere either, honest or not.
        const linksInPlan = resolution.hardlinks.filter((p) => executablePaths.has(p)).length
        const allLinksIncluded = resolution.nlink <= linksInPlan
        if (allLinksIncluded) {
          // Count the inode once, no matter how many executable actions in this plan name it
          // (whether via distinct hardlinked paths or the same path listed more than once).
          const inodeKey = `${resolution.dev}:${resolution.inode}`
          if (!countedInodes.has(inodeKey)) {
            countedInodes.add(inodeKey)
            bytesFreed += resolution.sizeBytes
          }
        }
        for (const t of resolution.torrents) torrentHashes.add(t.hash)
      }
    }

    rows.push({
      id: randomUUID(),
      seq: index,
      type: action.type,
      payload: { ...action, resolution },
      verdicts,
      status,
    })
  })

  const dryRun = {
    deleteCount,
    bytesFreed,
    torrentsRemoved: torrentHashes.size,
    blockedCount,
    // Every path an action will actually act on, deletes and folder removals alike — the sweep does
    // not care which kind emptied the directory, and neither should the number the operator reads.
    directoriesSwept: previewSweptDirectories(deps.pathMap, executablePaths).length,
  }

  const write = deps.db.transaction(() => {
    deps.db.prepare(
      'INSERT INTO plans (id, created_at, created_by, status, dry_run_json) VALUES (?,?,?,?,?)',
    ).run(planId, createdAt, request.createdBy, 'draft', JSON.stringify(dryRun))
    const insert = deps.db.prepare(`INSERT INTO plan_actions
      (id, plan_id, seq, type, payload_json, guard_verdicts_json, status, override_by, override_reason)
      VALUES (?,?,?,?,?,?,?,?,?)`)
    for (const r of rows) {
      const overrides = r.payload.overrides ?? []
      insert.run(
        r.id, planId, r.seq, r.type, JSON.stringify(r.payload), JSON.stringify(r.verdicts), r.status,
        overrides.length ? request.createdBy : null,
        overrides.length ? `overrode ${overrides.join(', ')}` : null,
      )
    }
  })
  write()

  return getPlan(deps.db, planId)!
}

interface PlanRow {
  id: string; created_at: string; created_by: string; status: string
  dry_run_json: string; approved_by: string | null
}
interface ActionRow {
  id: string; seq: number; type: ActionType; payload_json: string
  guard_verdicts_json: string; status: ActionStatus; error: string | null
}

export function getPlan(db: Db, id: string): PlanView | null {
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as PlanRow | undefined
  if (!plan) return null
  const actions = db.prepare('SELECT * FROM plan_actions WHERE plan_id = ? ORDER BY seq').all(id) as ActionRow[]
  return {
    id: plan.id,
    status: plan.status,
    createdBy: plan.created_by,
    createdAt: plan.created_at,
    approvedBy: plan.approved_by,
    dryRun: JSON.parse(plan.dry_run_json),
    actions: actions.map((a) => {
      const payload = JSON.parse(a.payload_json) as RequestedAction & { resolution?: Resolution }
      return {
        id: a.id,
        seq: a.seq,
        type: a.type,
        status: a.status,
        payload,
        guardVerdicts: JSON.parse(a.guard_verdicts_json),
        error: a.error,
        isAlternateVersion: payload.resolution ? payload.resolution.jellyfin.isAlternateVersion : null,
      }
    }),
  }
}

export function approvePlan(db: Db, id: string, approvedBy: string): PlanView {
  const plan = getPlan(db, id)
  if (!plan) throw new Error(`plan ${id} does not exist`)
  if (plan.status !== 'draft') throw new Error(`plan ${id} is not a draft (status: ${plan.status})`)
  if (!plan.actions.some((a) => a.status === 'pending')) {
    throw new Error('plan has no executable actions — every action is blocked')
  }
  db.prepare("UPDATE plans SET status='approved', approved_at=?, approved_by=? WHERE id=?")
    .run(new Date().toISOString(), approvedBy, id)
  return getPlan(db, id)!
}
