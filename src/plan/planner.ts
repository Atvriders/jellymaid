import { randomUUID } from 'node:crypto'
import type { Db } from '../index/db.js'
import { torrentKey, type ActionType, type GuardId, type GuardVerdict, type ActionStatus } from '../core/types.js'
import type { ConfigStore } from '../config/store.js'
import type { ActivityLock } from '../core/activity.js'
import { verificationBlocker } from '../scan/verification.js'
import {
  createTorrentListCache, resolveTarget, snapshotInventory, type ResolveDeps, type Resolution, type TorrentMatch,
} from './resolve.js'
import { evaluateGuards, isBlocked } from './guards.js'
import { previewSweptDirectories } from './sweep.js'

export interface RequestedAction {
  type: ActionType
  targetPath?: string
  itemIds?: string[]
  overrides?: GuardId[]
}

export interface PlanRequest { createdBy: string; actions: RequestedAction[] }

/** What a plan stores per action: the request (overrides reduced to the ones that answer a block),
 * the resolution it was judged on, and the overrides the build dropped. */
export type PlanActionPayload = RequestedAction & { resolution?: Resolution; droppedOverrides?: GuardId[] }

export interface PlanActionView {
  id: string
  seq: number
  type: ActionType
  status: ActionStatus
  payload: PlanActionPayload
  guardVerdicts: GuardVerdict[]
  error: string | null
  /**
   * Surfaced from `payload.resolution.jellyfin.isAlternateVersion` so an operator reading the plan
   * can see that the file is a merged item's alternate version — the item survives on its other
   * version, and Jellyfin is only told this one path is gone — without drilling into the raw
   * resolution. `null` for an action that carries no resolution at all (e.g. `merge-versions`, which
   * has no `targetPath`).
   */
  isAlternateVersion: boolean | null
}

export type PlanStatus = 'draft' | 'approved' | 'running' | 'completed' | 'failed'

export interface PlanDryRun {
  deleteCount: number
  /**
   * What the plan reclaims. A delete that removes torrents is credited with every file those
   * torrents take — each file once across the plan, however many actions name it or how many
   * cross-seeded torrents share it — and a delete that removes no torrent with its own file. Either
   * only when every link to the target's bytes goes in this plan; see `creditTorrentFiles`.
   */
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
  directoriesSwept?: number
  /** Companion files (sidecars, samples) the removed torrents take with them, each torrent once. */
  companionFiles: number
  /** Per qBittorrent instance: the torrents it will remove, and the bytes credited to them. */
  byInstance: Record<string, { torrents: number; bytes: number }>
}

export interface PlanView {
  id: string
  status: PlanStatus
  createdBy: string
  createdAt: string
  approvedBy: string | null
  /** Why the last run of this plan stopped short (crashed, or was stopped); null otherwise. */
  error: string | null
  actions: PlanActionView[]
  dryRun: PlanDryRun
  /** Actions in an end state (done, failed, skipped, blocked) out of all of them. */
  progress: { total: number; finished: number }
  /** Overrides the build dropped because the guard they name was not blocking that action. */
  droppedOverrides: Array<{ seq: number; guard: GuardId }>
}

/**
 * Why a build was refused before anything was resolved: the path map is not verified as it stands
 * ('verification'), or a scan or a plan run holds the activity lock ('busy'). Every other refusal
 * (a target outside every root, a merge with one id) is the request's own fault and a plain Error.
 */
export class PlanRefusal extends Error {
  constructor(readonly code: 'verification' | 'busy', message: string) {
    super(message)
    this.name = 'PlanRefusal'
  }
}

/**
 * No `config` and no `pathMap` of its own: both come from the live config store, read ONCE at the
 * start of a build, so a build judges every action against the same thresholds and the same
 * mapping set while still seeing an edit saved a moment before it started.
 *
 * Any `torrentLists` passed in is not used: a build takes its own snapshot of every torrent list
 * (see `buildPlan`), so it can never be judged from a list an earlier build or run read.
 */
export interface PlannerDeps extends Omit<ResolveDeps, 'pathMap'> { configStore: ConfigStore; activity: ActivityLock }

/** Merges are library-only and cheap; running them first means a failed delete never leaves a half-merged group. */
const ORDER: Record<ActionType, number> = {
  'merge-versions': 0,
  'split-versions': 1,
  'delete-media': 2,
  'delete-junk-file': 3,
  'remove-empty-folder': 4,
}

/** Statuses an action never leaves, as far as one run is concerned. */
const FINISHED: ReadonlySet<ActionStatus> = new Set(['done', 'failed', 'skipped', 'blocked'])

interface ResolvedAction {
  action: RequestedAction
  resolution?: Resolution
  verdicts: GuardVerdict[]
  status: ActionStatus
}

const isDelete = (type: ActionType) => type === 'delete-media' || type === 'delete-junk-file'

/** The delete targets of every action not (yet) blocked — the plan's real scope. */
function deletePathsOf(resolved: ResolvedAction[]): Set<string> {
  return new Set(
    resolved
      .filter((r) => isDelete(r.action.type) && r.status !== 'blocked')
      .map((r) => r.action.targetPath)
      .filter((p): p is string => p !== undefined),
  )
}

/**
 * The bytes removing `torrents` reclaims, crediting each file at most once into `credited`: by its
 * container path, so two cross-seeded torrents over one file free it once and two actions naming
 * one season pack credit the pack once. A file no mapping covers has no path to dedupe on and is
 * keyed by its torrent instead; a torrent whose list could not be read is credited its reported
 * size, once. Shared with the executor, which credits what it actually removed the same way.
 */
export function creditTorrentFiles(torrents: TorrentMatch[], credited: Set<string>): Map<string, number> {
  const byTorrent = new Map<string, number>()
  for (const t of torrents) {
    const key = torrentKey(t)
    let bytes = 0
    const credit = (fileKey: string, size: number) => {
      if (credited.has(fileKey)) return
      credited.add(fileKey)
      bytes += size
    }
    if (t.files) {
      for (const e of t.files.entries) credit(e.containerPath ?? `${key}\0${e.relPath}`, e.sizeBytes)
    } else {
      credit(key, t.sizeBytes)
    }
    byTorrent.set(key, (byTorrent.get(key) ?? 0) + bytes)
  }
  return byTorrent
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

  // Spec §2: a plan is only ever built against a mapping set that was verified exactly as it stands.
  // Unlike a scan, it cannot be forced — a plan is the step that deletes. The gate reads the store
  // in the same synchronous stretch as the snapshot below, so the set it vouches for is the set used.
  const blocker = verificationBlocker(deps.db, {
    mappingsHash: deps.configStore.mappingsHash(),
    instanceIds: deps.configStore.instanceIds(),
  })
  if (blocker) throw new PlanRefusal('verification', blocker)
  // A scan rewrites and sweeps the very index a build resolves against, and a running plan is
  // deleting what a build would be judging. Neither waits for the other; the build is refused.
  const holder = deps.activity.current()
  if (holder) {
    throw new PlanRefusal('busy', `a ${holder.kind === 'scan' ? 'scan' : 'plan run'} (${holder.id}) is in progress; `
      + 'build the plan once it has finished')
  }

  // One snapshot of the live configuration for the whole build. See PlannerDeps.
  const config = deps.configStore.file()
  const pathMap = deps.configStore.pathMap()

  // One *arr inventory and one torrent list per instance for the whole build, not one per action:
  // every action is judged against the same picture of the world, and a 30-action plan asks each
  // instance once. See snapshotInventory and TorrentListCache.
  const resolveDeps: ResolveDeps = {
    db: deps.db,
    pathMap,
    qbittorrents: deps.qbittorrents,
    radarr: snapshotInventory(deps.radarr),
    sonarr: snapshotInventory(deps.sonarr),
    torrentLists: createTorrentListCache({ maxAgeMs: Number.POSITIVE_INFINITY }),
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
      const root = pathMap.rootFor(action.targetPath)
      if (!root || !pathMap.isWithinRoot(action.targetPath, root)) {
        throw new Error(`refusing to plan an action outside every configured root: ${action.targetPath}`)
      }
      resolution = await resolveTarget(resolveDeps, action.targetPath, config)
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
      entry.verdicts = evaluateGuards(entry.resolution, config, {
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
  // would clear a block nobody ever saw. So it is DROPPED: never stored, so no executor can honour
  // it, and listed in `droppedOverrides` so the operator sees it no longer applies. Dropped rather
  // than refused, because the screen resubmits every override it holds on a rebuild, and a guard
  // that stopped blocking since (a torrent that finished seeding) must not turn a rebuild into an
  // error. (The executor also intersects with the approved snapshot; that holds for a plan written
  // by anything else.) Dropping cannot change a status: an override of a guard that does not block
  // has nothing to clear.
  const keptOverrides = new Map<ResolvedAction, GuardId[]>()
  const droppedByAction = new Map<ResolvedAction, GuardId[]>()
  for (const entry of resolved) {
    const requested = [...new Set(entry.action.overrides ?? [])]
    const blocking = new Set(entry.verdicts.filter((v) => v.outcome === 'block').map((v) => v.guard))
    keptOverrides.set(entry, requested.filter((g) => blocking.has(g)))
    // Stored per action (payload.droppedOverrides); getPlan lists them plan-wide by seq.
    droppedByAction.set(entry, requested.filter((g) => !blocking.has(g)))
  }

  // Only a path whose OWN action will actually run belongs in "this link goes away in this plan":
  // a blocked sibling's link survives execution no matter how many OTHER actions in the plan also
  // name its inode, so it must not count as one of the links being removed.
  const executablePaths = new Set(
    resolved.filter((r): r is ResolvedAction & { action: { targetPath: string } } =>
      r.action.targetPath !== undefined && r.status !== 'blocked').map((r) => r.action.targetPath),
  )

  // The torrents this plan removes with their data — those of every delete that will run — keyed by
  // torrentKey: the same infohash on two instances is two torrents, removed twice. Their files go
  // with them, so a link that is one of their files goes in this plan too.
  const removedTorrents = new Map<string, TorrentMatch>()
  for (const r of resolved) {
    if (!r.resolution || !isDelete(r.action.type) || r.status === 'blocked') continue
    for (const t of r.resolution.torrents) if (!removedTorrents.has(torrentKey(t))) removedTorrents.set(torrentKey(t), t)
  }
  const removedTorrentFiles = new Set<string>()
  for (const t of removedTorrents.values()) {
    for (const e of t.files?.entries ?? []) if (e.containerPath) removedTorrentFiles.add(e.containerPath)
  }

  let bytesFreed = 0
  let deleteCount = 0
  let blockedCount = 0
  const credited = new Set<string>()
  const torrentBytes = new Map<string, number>()
  // Keyed by the inode's own identity (dev:inode — the same correlation key `fs_entries` and
  // `resolveTarget` use elsewhere), not by comparing target-path strings: two actions can name the
  // exact same path twice, which ties on any path-string comparison and would double-pay a single
  // link if "the lexicographically smallest participating path pays" were used instead.
  const countedInodes = new Set<string>()

  const rows: Array<{
    id: string; seq: number; type: ActionType; payload: PlanActionPayload
    verdicts: GuardVerdict[]; status: ActionStatus; overrides: GuardId[]
  }> = []

  resolved.forEach((entry, index) => {
    const { action, resolution, verdicts, status } = entry
    if (status === 'blocked') blockedCount += 1

    if (resolution && isDelete(action.type)) {
      deleteCount += 1
      // A blocked action never runs, so it can never free bytes or remove a torrent — only a
      // pending action's own resolution contributes to either total.
      if (status !== 'blocked') {
        // Space is reclaimed only when EVERY link to the inode goes away in this same plan.
        // Comparing the count of links THIS PLAN will actually remove against `nlink` — the
        // live-stat fact — rather than against the discovered link list matters twice over: if the
        // index knows about fewer links than the inode actually has, the honest answer is zero
        // (an untracked link cannot be proven to be part of this plan); and if a sibling link's own
        // action is blocked, that link is not going anywhere either, honest or not. A link that is
        // a file of a torrent this plan removes goes with that torrent.
        const linksGone = resolution.hardlinks.filter((p) => executablePaths.has(p) || removedTorrentFiles.has(p)).length
        const allLinksGo = resolution.exists && resolution.nlink <= linksGone
        if (resolution.torrents.length > 0) {
          // Bytes are credited per torrent removed, not per action: the torrent takes every file it
          // owns, companions included, and two actions naming one pack must not pay for it twice.
          if (allLinksGo) {
            for (const [key, bytes] of creditTorrentFiles(resolution.torrents, credited)) {
              bytesFreed += bytes
              torrentBytes.set(key, (torrentBytes.get(key) ?? 0) + bytes)
            }
          }
        } else if (allLinksGo) {
          // Count the inode once, no matter how many executable actions in this plan name it
          // (whether via distinct hardlinked paths or the same path listed more than once).
          const inodeKey = `${resolution.dev}:${resolution.inode}`
          if (!countedInodes.has(inodeKey)) {
            countedInodes.add(inodeKey)
            bytesFreed += resolution.sizeBytes
          }
        }
      }
    }

    const overrides = keptOverrides.get(entry) ?? []
    const dropped = droppedByAction.get(entry) ?? []
    rows.push({
      id: randomUUID(),
      seq: index,
      type: action.type,
      payload: {
        ...action,
        ...(action.overrides ? { overrides } : {}),
        resolution,
        ...(dropped.length ? { droppedOverrides: dropped } : {}),
      },
      verdicts,
      status,
      overrides,
    })
  })

  const byInstance: PlanDryRun['byInstance'] = {}
  let companionFiles = 0
  for (const [key, t] of removedTorrents) {
    const slot = byInstance[t.instanceId] ?? { torrents: 0, bytes: 0 }
    slot.torrents += 1
    slot.bytes += torrentBytes.get(key) ?? 0
    byInstance[t.instanceId] = slot
    companionFiles += t.companionCount ?? 0
  }

  const dryRun: PlanDryRun = {
    deleteCount,
    bytesFreed,
    torrentsRemoved: removedTorrents.size,
    blockedCount,
    // Every path an action will actually act on, deletes and folder removals alike — the sweep does
    // not care which kind emptied the directory, and neither should the number the operator reads.
    directoriesSwept: previewSweptDirectories(pathMap, executablePaths).length,
    companionFiles,
    byInstance,
  }

  const write = deps.db.transaction(() => {
    deps.db.prepare(
      'INSERT INTO plans (id, created_at, created_by, status, dry_run_json) VALUES (?,?,?,?,?)',
    ).run(planId, createdAt, request.createdBy, 'draft', JSON.stringify(dryRun))
    const insert = deps.db.prepare(`INSERT INTO plan_actions
      (id, plan_id, seq, type, payload_json, guard_verdicts_json, status, override_by, override_reason)
      VALUES (?,?,?,?,?,?,?,?,?)`)
    for (const r of rows) {
      insert.run(
        r.id, planId, r.seq, r.type, JSON.stringify(r.payload), JSON.stringify(r.verdicts), r.status,
        r.overrides.length ? request.createdBy : null,
        r.overrides.length ? `overrode ${r.overrides.join(', ')}` : null,
      )
    }
  })
  write()

  return getPlan(deps.db, planId)!
}

interface PlanRow {
  id: string; created_at: string; created_by: string; status: string
  dry_run_json: string; approved_by: string | null; error: string | null
}
interface ActionRow {
  id: string; seq: number; type: ActionType; payload_json: string
  guard_verdicts_json: string; status: ActionStatus; error: string | null
}

/** A stored dry run, with the fields a plan written before they existed reads as empty. */
export function parseDryRun(json: string): PlanDryRun {
  return { companionFiles: 0, byInstance: {}, ...(JSON.parse(json) as Partial<PlanDryRun>) } as PlanDryRun
}

export function getPlan(db: Db, id: string): PlanView | null {
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as PlanRow | undefined
  if (!plan) return null
  const actions = db.prepare('SELECT * FROM plan_actions WHERE plan_id = ? ORDER BY seq').all(id) as ActionRow[]
  const views = actions.map((a): PlanActionView => {
    const payload = JSON.parse(a.payload_json) as PlanActionPayload
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
  })
  return {
    id: plan.id,
    status: plan.status as PlanStatus,
    createdBy: plan.created_by,
    createdAt: plan.created_at,
    approvedBy: plan.approved_by,
    error: plan.error ?? null,
    dryRun: parseDryRun(plan.dry_run_json),
    actions: views,
    progress: { total: views.length, finished: views.filter((a) => FINISHED.has(a.status)).length },
    droppedOverrides: views.flatMap((a) => (a.payload.droppedOverrides ?? []).map((guard) => ({ seq: a.seq, guard }))),
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
