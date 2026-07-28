import { randomUUID } from 'node:crypto'
import type { Db } from '../index/db.js'
import type { ActionType, GuardId, GuardVerdict, ActionStatus } from '../core/types.js'
import type { FileConfig } from '../config/schema.js'
import { resolveTarget, snapshotInventory, type ResolveDeps, type Resolution } from './resolve.js'
import { evaluateGuards, isBlocked } from './guards.js'

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
  dryRun: { deleteCount: number; bytesFreed: number; torrentsRemoved: number; blockedCount: number }
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

export async function buildPlan(deps: PlannerDeps, request: PlanRequest): Promise<PlanView> {
  const planId = randomUUID()
  const createdAt = new Date().toISOString()

  const ordered = [...request.actions].sort((a, b) => ORDER[a.type] - ORDER[b.type])

  for (const action of ordered) {
    if (action.type === 'merge-versions' && (action.itemIds?.length ?? 0) < 2) {
      throw new Error('merge-versions requires at least two item ids')
    }
  }

  // Every path this plan proposes to remove, so `guard.torrent-scope` can tell "this torrent backs
  // exactly what we asked for" from "this torrent also holds eleven files nobody named". Built from
  // the REQUEST, not from guard outcomes, which is what keeps it free of circularity — a path stays
  // in the plan's scope whether or not its own action ends up blocked.
  const plannedPaths = new Set(
    ordered.filter((a) => a.type === 'delete-media' || a.type === 'delete-junk-file')
      .map((a) => a.targetPath).filter((p): p is string => p !== undefined),
  )

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
    let verdicts: GuardVerdict[] = []
    let resolution: Resolution | undefined
    let status: ActionStatus = 'pending'

    if (action.targetPath) {
      const root = deps.pathMap.rootFor(action.targetPath)
      if (!root || !deps.pathMap.isWithinRoot(action.targetPath, root)) {
        throw new Error(`refusing to plan an action outside every configured root: ${action.targetPath}`)
      }
      resolution = await resolveTarget(resolveDeps, action.targetPath)
      verdicts = evaluateGuards(resolution, deps.config, {
        plannedPaths, removesTorrentData: action.type !== 'remove-empty-folder',
      })
      if (isBlocked(verdicts, action.overrides ?? []).blocked) status = 'blocked'
    }

    resolved.push({ action, resolution, verdicts, status })
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

  const dryRun = { deleteCount, bytesFreed, torrentsRemoved: torrentHashes.size, blockedCount }

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
