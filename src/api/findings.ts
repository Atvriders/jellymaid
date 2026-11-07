import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Db } from '../index/db.js'
import type { ConfigStore } from '../config/store.js'
import type { FileConfig, KeeperPolicy } from '../config/schema.js'
import { isCompanionFile } from '../core/companions.js'
import { torrentKey } from '../core/types.js'
import { editionOf, isMultiEpisodeFile } from '../rules/normalize.js'
import type { PathMap } from '../fs/pathmap.js'
import { requireSession } from './auth.js'
import type { SessionPayload } from '../auth/session.js'

const listQuery = z.object({
  class: z.string().optional(),
  severity: z.string().optional(),
  confidence: z.string().optional(),
  status: z.string().default('open'),
  ruleId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
})

const dismissBody = z.object({ reason: z.string().min(1) })
// A group is dismissed from the Duplicates screen in one click; the reason is welcome, not required.
const dismissGroupBody = z.object({ reason: z.string().min(1).optional() })

interface FindingRow {
  id: string; rule_id: string; class: string; severity: string; confidence: string
  subjects_json: string; evidence_json: string; reclaimable_bytes: number | null
  status: string; first_seen: string; last_seen: string
  dismissed_reason: string | null; dismissed_by: string | null
}

const hydrate = (r: FindingRow) => ({
  id: r.id, ruleId: r.rule_id, class: r.class, severity: r.severity, confidence: r.confidence,
  subjects: JSON.parse(r.subjects_json), evidence: JSON.parse(r.evidence_json),
  reclaimableBytes: r.reclaimable_bytes, status: r.status,
  firstSeen: r.first_seen, lastSeen: r.last_seen,
  dismissedReason: r.dismissed_reason, dismissedBy: r.dismissed_by,
})

const sessionOf = (req: FastifyRequest) => (req as FastifyRequest & { session: SessionPayload }).session

export function registerFindingsRoutes(
  app: FastifyInstance,
  deps: {
    db: Db
    sessionSecret: string
    /**
     * The LIVE path map and thresholds: which box a copy sits on, and whether a private torrent has
     * met its minimums, are answered with the config in force when the page is loaded, not the one
     * the last scan ran under.
     */
    configStore: Pick<ConfigStore, 'file' | 'pathMap'>
  },
): void {
  const guard = { preHandler: requireSession(deps.sessionSecret) }

  app.get('/api/findings', guard, async (req, reply) => {
    const parsed = listQuery.safeParse(req.query)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid query' })
    const q = parsed.data

    const where: string[] = ['status = ?']
    const params: unknown[] = [q.status]
    for (const [column, value] of [['class', q.class], ['severity', q.severity], ['confidence', q.confidence], ['rule_id', q.ruleId]] as const) {
      if (value) { where.push(`${column} = ?`); params.push(value) }
    }
    const clause = `WHERE ${where.join(' AND ')}`

    const total = (deps.db.prepare(`SELECT COUNT(*) c FROM findings ${clause}`).get(...params) as { c: number }).c
    const rows = deps.db.prepare(
      `SELECT * FROM findings ${clause} ORDER BY severity, rule_id, id LIMIT ? OFFSET ?`,
    ).all(...params, q.limit, q.offset) as FindingRow[]
    return reply.send({ findings: rows.map(hydrate), total })
  })

  app.get('/api/findings/summary', guard, async (_req, reply) => {
    const byClassRows = deps.db.prepare(
      "SELECT class, COUNT(*) c FROM findings WHERE status = 'open' GROUP BY class",
    ).all() as Array<{ class: string; c: number }>
    const byClass: Record<string, number> = {}
    for (const r of byClassRows) byClass[r.class] = r.c

    const reclaimable = (deps.db.prepare(
      "SELECT COALESCE(SUM(reclaimable_bytes), 0) s FROM findings WHERE status = 'open'",
    ).get() as { s: number }).s

    // "The latest scan" is the wrong anchor for a not-evaluated list. A scan that failed or was
    // cancelled before it ever reached the rules phase has no `rule_runs` rows at all, so anchoring
    // here would return an empty `notEvaluated` — rendering identically to a clean, fully evaluated
    // pass — while `byClass` and `reclaimableBytes` above quietly keep showing the LAST SUCCESSFUL
    // pass's findings. The summary would then say "everything is fine" about a scan that never
    // checked anything. Anchor instead on the latest scan that actually reached the rules phase
    // (`EXISTS` a rule_runs row), report which scan that was, and report a newer attempt separately
    // so a consumer can say "these results are from scan 41; scan 42 failed".
    const basedOnRow = deps.db.prepare(
      `SELECT s.id, s.status, s.finished_at FROM scans s
       WHERE EXISTS (SELECT 1 FROM rule_runs r WHERE r.scan_id = s.id)
       ORDER BY s.id DESC LIMIT 1`,
    ).get() as { id: number; status: string; finished_at: string | null } | undefined

    const latestRow = deps.db.prepare(
      'SELECT id, status FROM scans ORDER BY id DESC LIMIT 1',
    ).get() as { id: number; status: string } | undefined

    const notEvaluated = basedOnRow
      ? (deps.db.prepare(
          "SELECT rule_id AS ruleId, reason FROM rule_runs WHERE scan_id = ? AND status = 'not-evaluated'",
        ).all(basedOnRow.id) as Array<{ ruleId: string; reason: string }>)
      : []

    return reply.send({
      // Explicit, rather than inferred from an empty `notEvaluated`: false means no scan has ever
      // completed a rules pass, so the counts below describe nothing at all.
      evaluated: Boolean(basedOnRow),
      basedOn: basedOnRow
        ? { scanId: basedOnRow.id, status: basedOnRow.status, finishedAt: basedOnRow.finished_at }
        : null,
      // Only when it differs from `basedOn` — i.e. there is a newer attempt whose results are not
      // what is being reported here.
      latestAttempt: latestRow && latestRow.id !== basedOnRow?.id
        ? { scanId: latestRow.id, status: latestRow.status }
        : null,
      byClass,
      reclaimableBytes: reclaimable,
      notEvaluated,
    })
  })

  /**
   * The group a `dupe.group` finding describes, or null for any other finding. The Findings screen
   * dismisses and reopens duplicate groups through the two routes below, and /api/duplicates lists
   * groups by `dupe_groups.status`: changing the finding alone left a dismissed group on the
   * Duplicates screen, where the bulk queue could take a different cut the operator had just said
   * to keep (final review I2). So each route mirrors its change onto the group, in the same
   * transaction, as the duplicates routes do in the other direction. A merged group is never
   * touched: flipping its status would make it mergeable again (see the duplicates dismiss route).
   */
  const groupOfFinding = (id: string): string | null => {
    const row = deps.db.prepare(
      "SELECT json_extract(evidence_json, '$.groupId') AS groupId FROM findings WHERE id = ? AND rule_id = 'dupe.group' AND class = 'duplicate'",
    ).get(id) as { groupId: unknown } | undefined
    return row && typeof row.groupId === 'string' ? row.groupId : null
  }

  app.post('/api/findings/:id/dismiss', guard, async (req, reply) => {
    const parsed = dismissBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'a dismiss reason is required' })
    const { id } = req.params as { id: string }
    const actor = sessionOf(req).username
    const found = deps.db.transaction((): boolean => {
      const info = deps.db.prepare(
        "UPDATE findings SET status='dismissed', dismissed_reason=?, dismissed_by=?, dismissed_at=? WHERE id=?",
      ).run(parsed.data.reason, actor, new Date().toISOString(), id)
      if (info.changes === 0) return false
      const groupId = groupOfFinding(id)
      if (groupId !== null) deps.db.prepare("UPDATE dupe_groups SET status = 'dismissed' WHERE id = ? AND status = 'open'").run(groupId)
      return true
    }).immediate()
    if (!found) return reply.code(404).send({ error: 'no such finding' })
    return reply.send({ ok: true })
  })

  app.post('/api/findings/:id/reopen', guard, async (req, reply) => {
    const { id } = req.params as { id: string }
    const found = deps.db.transaction((): boolean => {
      const info = deps.db.prepare(
        "UPDATE findings SET status='open', dismissed_reason=NULL, dismissed_by=NULL, dismissed_at=NULL WHERE id=?",
      ).run(id)
      if (info.changes === 0) return false
      const groupId = groupOfFinding(id)
      if (groupId !== null) deps.db.prepare("UPDATE dupe_groups SET status = 'open' WHERE id = ? AND status = 'dismissed'").run(groupId)
      return true
    }).immediate()
    if (!found) return reply.code(404).send({ error: 'no such finding' })
    return reply.send({ ok: true })
  })

  app.get('/api/duplicates', guard, async (_req, reply) => {
    // One snapshot of the config for the whole response, so every member is judged by the same
    // mappings and thresholds.
    return reply.send(buildDuplicates(deps.db, deps.configStore.file(), deps.configStore.pathMap()))
  })

  /**
   * Dismissing a group hides it from /api/duplicates AND dismisses its `dupe.group` finding. The
   * finding is the half that lasts: a rescan upserts it keeping `dismissed` (src/rules/runner.ts),
   * so a group that forms again with the same members stays dismissed. Both change in one
   * transaction, or the two could disagree about whether the operator dismissed it.
   *
   * A merged group is refused. Merging is a Jellyfin-side change this product cannot undo, and
   * flipping its status here would make it mergeable again (plans.ts claims a group by
   * `status != 'merged'`).
   *
   * Idempotent: dismissing a dismissed group changes nothing, and in particular keeps the first
   * dismissal's reason and author.
   */
  app.post('/api/duplicates/:groupId/dismiss', guard, async (req, reply) => {
    const parsed = dismissGroupBody.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: 'reason, when given, must be a non-empty string' })
    const { groupId } = req.params as { groupId: string }
    const actor = sessionOf(req).username
    const outcome = deps.db.transaction((): 'ok' | 'missing' | 'merged' => {
      const row = deps.db.prepare('SELECT status FROM dupe_groups WHERE id = ?').get(groupId) as { status: string } | undefined
      if (!row) return 'missing'
      if (row.status === 'merged') return 'merged'
      deps.db.prepare("UPDATE dupe_groups SET status = 'dismissed' WHERE id = ? AND status = 'open'").run(groupId)
      // `status != 'dismissed'`, not `= 'open'`: a finding that had been resolved must become
      // dismissed too, or the next scan would re-open it and the dismissal would not stick.
      deps.db.prepare(
        `UPDATE findings SET status = 'dismissed', dismissed_reason = ?, dismissed_by = ?, dismissed_at = ?
         WHERE rule_id = 'dupe.group' AND class = 'duplicate' AND status != 'dismissed'
           AND json_extract(evidence_json, '$.groupId') = ?`,
      ).run(parsed.data.reason ?? null, actor, new Date().toISOString(), groupId)
      return 'ok'
    }).immediate()
    return answerGroupChange(reply, outcome, groupId)
  })

  app.post('/api/duplicates/:groupId/reopen', guard, async (req, reply) => {
    const { groupId } = req.params as { groupId: string }
    const outcome = deps.db.transaction((): 'ok' | 'missing' | 'merged' => {
      const row = deps.db.prepare('SELECT status FROM dupe_groups WHERE id = ?').get(groupId) as { status: string } | undefined
      if (!row) return 'missing'
      if (row.status === 'merged') return 'merged'
      deps.db.prepare("UPDATE dupe_groups SET status = 'open' WHERE id = ? AND status = 'dismissed'").run(groupId)
      deps.db.prepare(
        `UPDATE findings SET status = 'open', dismissed_reason = NULL, dismissed_by = NULL, dismissed_at = NULL
         WHERE rule_id = 'dupe.group' AND class = 'duplicate' AND status = 'dismissed'
           AND json_extract(evidence_json, '$.groupId') = ?`,
      ).run(groupId)
      return 'ok'
    }).immediate()
    return answerGroupChange(reply, outcome, groupId)
  })
}

// ---------------------------------------------------------------------------------------------
// Duplicates read model (C12)
// ---------------------------------------------------------------------------------------------

function answerGroupChange(reply: FastifyReply, outcome: 'ok' | 'missing' | 'merged', groupId: string) {
  if (outcome === 'missing') return reply.code(404).send({ error: 'no such duplicate group' })
  if (outcome === 'merged') return reply.code(409).send({ error: `duplicate group ${groupId} was already merged` })
  return reply.code(204).send()
}

export interface TorrentFactsView {
  instanceId: string; hash: string; name: string; state: string; ratio: number; seedingDays: number
  isPrivate: boolean; trackerHost: string | null; sizeBytes: number; fileCount: number; mediaFileCount: number
  /** `!isPrivate || (ratio >= minRatio && seedingDays >= minSeedTimeDays)`, under the thresholds in force now. */
  hnrMet: boolean
}

export interface DupeMemberView {
  id: string; name: string; containerPath: string | null; sizeBytes: number | null
  width: number | null; height: number | null; bitrate: number | null; videoCodec: string | null
  audioChannels: number | null; container: string | null; libraryName: string | null
  videoRange: string | null; hasSubtitles: boolean; edition: string | null
  /** `torrentSourceFor(containerPath).instanceId`, else null. */
  instanceId: string | null
  /** The first torrent owning `containerPath` per the index. */
  torrent: TorrentFactsView | null
  /** Torrents owning this file (> 1 = cross-seed). */
  torrentCount: number
}

export interface DupeGroupView {
  id: string; tier: 'exact' | 'strong' | 'possible'; matchedBy: string[]
  keeperItemId: string | null; keeperPolicy: KeeperPolicy
  title: string; year: number | null; kind: 'movie' | 'episode'
  seriesName: string | null; seasonNo: number | null; episodeNo: number | null
  editionsDiffer: boolean
  /**
   * A member's file holds more than one episode (`S01E01E02`), so deleting it loses more than this
   * group's episode. The bulk queue skips such a group unless the operator includes it, as it does
   * an `editionsDiffer` one.
   */
  multiEpisode: boolean
  crossInstance: boolean
  /** Sum of the non-keeper members' sizes; 0 when there is no keeper. */
  reclaimableBytes: number
  scores: Record<string, { total: number; breakdown: Record<string, number> }>
  members: DupeMemberView[]
}

export interface DuplicatesResponse {
  evaluated: boolean
  reason: string | null
  scanId: number | null
  scanFinishedAt: string | null
  groups: DupeGroupView[]
}

const KEEPER_POLICIES: ReadonlySet<string> = new Set(['best-quality', 'smallest', 'none'] satisfies KeeperPolicy[])
const isKeeperPolicy = (v: unknown): v is KeeperPolicy => typeof v === 'string' && KEEPER_POLICIES.has(v)

/**
 * Rows per `IN (...)` list. SQLite refuses a statement with more than its bind-variable ceiling
 * (32,766 in this project's better-sqlite3 build; see the same note in explorer.ts), and a library
 * with thousands of duplicate groups has more members than that.
 */
const IN_LIST_BATCH = 500

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

interface GroupRow { id: string; tier: string; members_json: string; keeper_item_id: string | null; scores_json: string }

interface ItemRow {
  id: string; type: string; name: string; year: number | null
  series_name: string | null; season_no: number | null; episode_no: number | null
  jf_path: string | null; container_path: string | null; size_bytes: number | null
  width: number | null; height: number | null; bitrate: number | null
  video_codec: string | null; audio_channels: number | null; container: string | null
  library_name: string | null; video_range: string | null; has_subtitles: number
}

/** One torrent that lists a container path among its files, as the index recorded it. */
interface OwnerRow {
  container_path: string
  instance_id: string; hash: string; name: string; state: string | null
  ratio: number | null; seeding_time: number | null; is_private: number | null
  tracker_host: string | null; size_bytes: number | null
}

/**
 * What the `dupe.group` rule recorded in a group's finding (src/rules/dupes/adapter.ts). It is JSON
 * written by whichever scan last ran, possibly an older version of the rule, so every field is
 * checked rather than trusted: a value of the wrong type is the same as a value that is absent.
 */
interface GroupEvidence {
  matchedBy: string[]
  keeperPolicy: KeeperPolicy | null
  /** Null when the finding never said (an older rule, or a value of the wrong type): unknown, not "no". */
  editionsDiffer: boolean | null
  /** Likewise null when the finding never said. */
  multiEpisode: boolean | null
  /** Only the ids the rule said something about; `null` means "looked, no edition". */
  editions: Map<string, string | null>
}

function readEvidence(raw: unknown): GroupEvidence {
  const e = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const editions = new Map<string, string | null>()
  if (typeof e.editions === 'object' && e.editions !== null && !Array.isArray(e.editions)) {
    for (const [id, edition] of Object.entries(e.editions)) {
      if (edition === null || typeof edition === 'string') editions.set(id, edition)
    }
  }
  return {
    matchedBy: Array.isArray(e.matchedBy) ? e.matchedBy.filter((m): m is string => typeof m === 'string') : [],
    keeperPolicy: isKeeperPolicy(e.keeperPolicy) ? e.keeperPolicy : null,
    editionsDiffer: typeof e.editionsDiffer === 'boolean' ? e.editionsDiffer : null,
    multiEpisode: typeof e.multiEpisode === 'boolean' ? e.multiEpisode : null,
    editions,
  }
}

/**
 * Whether duplicate matching ran, from the latest COMPLETED scan's `rule_runs` row for `dupe.group`.
 * A scan that failed or is still running says nothing about the rule, and an empty group list from
 * a rule that did not run is not "no duplicates" — that is the one thing this exists to keep apart.
 */
function dupeEvaluation(db: Db): Pick<DuplicatesResponse, 'evaluated' | 'reason' | 'scanId' | 'scanFinishedAt'> {
  const scan = db.prepare(
    "SELECT id, finished_at FROM scans WHERE status = 'completed' ORDER BY id DESC LIMIT 1",
  ).get() as { id: number; finished_at: string | null } | undefined
  if (!scan) {
    return { evaluated: false, reason: 'no scan has completed yet, so duplicate matching has not run', scanId: null, scanFinishedAt: null }
  }
  const run = db.prepare("SELECT status, reason FROM rule_runs WHERE scan_id = ? AND rule_id = 'dupe.group'")
    .get(scan.id) as { status: string; reason: string | null } | undefined
  const base = { scanId: scan.id, scanFinishedAt: scan.finished_at }
  if (!run) return { ...base, evaluated: false, reason: `duplicate matching did not run in scan ${scan.id}` }
  if (run.status !== 'evaluated') {
    return { ...base, evaluated: false, reason: run.reason ?? `duplicate matching was not evaluated in scan ${scan.id}` }
  }
  return { ...base, evaluated: true, reason: null }
}

function loadItems(db: Db, ids: string[]): Map<string, ItemRow> {
  const out = new Map<string, ItemRow>()
  for (const batch of chunk([...new Set(ids)], IN_LIST_BATCH)) {
    const rows = db.prepare(
      `SELECT id, type, name, year, series_name, season_no, episode_no, jf_path, container_path, size_bytes, width, height,
              bitrate, video_codec, audio_channels, container, library_name, video_range, has_subtitles
       FROM jellyfin_items WHERE id IN (${batch.map(() => '?').join(',')})`,
    ).all(...batch) as ItemRow[]
    for (const row of rows) out.set(row.id, row)
  }
  return out
}

/**
 * Every torrent in the index that lists each of `paths` among its files, in a stable order (by
 * instance, then hash) so "the first torrent" is the same one on every load. Keyed by the container
 * path the scan resolved the file to, which already accounts for each instance's own spelling of its
 * roots. DISTINCT: one torrent that lists a path twice is still one owner.
 */
function loadOwners(db: Db, paths: string[]): Map<string, OwnerRow[]> {
  const out = new Map<string, OwnerRow[]>()
  for (const batch of chunk([...new Set(paths)], IN_LIST_BATCH)) {
    const rows = db.prepare(
      `SELECT DISTINCT tf.container_path AS container_path, t.instance_id AS instance_id, t.hash AS hash,
              t.name AS name, t.state AS state, t.ratio AS ratio, t.seeding_time AS seeding_time,
              t.is_private AS is_private, t.tracker_host AS tracker_host, t.size_bytes AS size_bytes
       FROM torrent_files tf
       JOIN torrents t ON t.instance_id = tf.instance_id AND t.hash = tf.hash
       WHERE tf.container_path IN (${batch.map(() => '?').join(',')})
       ORDER BY t.instance_id, t.hash`,
    ).all(...batch) as OwnerRow[]
    for (const row of rows) {
      const list = out.get(row.container_path)
      if (list) list.push(row); else out.set(row.container_path, [row])
    }
  }
  return out
}

/**
 * What the `dupe.group` findings say about each group, by group id, whatever their status. Every
 * rescan rewrites a finding's evidence, a dismissed one included (src/rules/runner.ts), so reading
 * only open findings did not avoid stale evidence — it turned a dismissal into "nothing is known
 * about this group": no matchers, and `editionsDiffer` false (final review I2). Where two findings
 * name one group, the one seen most recently speaks for it; `dismissed` is true if ANY of them was
 * dismissed, so the operator's dismissal is never outvoted.
 */
function groupFindings(db: Db): Map<string, { evidence: GroupEvidence; dismissed: boolean }> {
  const rows = db.prepare(
    `SELECT evidence_json AS evidenceJson, status FROM findings WHERE rule_id = 'dupe.group' AND class = 'duplicate'
     ORDER BY last_seen, id`,
  ).all() as Array<{ evidenceJson: string; status: string }>
  const out = new Map<string, { evidence: GroupEvidence; dismissed: boolean }>()
  for (const row of rows) {
    const evidence = JSON.parse(row.evidenceJson) as { groupId?: unknown }
    if (typeof evidence.groupId !== 'string') continue
    const dismissed = row.status === 'dismissed' || (out.get(evidence.groupId)?.dismissed ?? false)
    out.set(evidence.groupId, { evidence: readEvidence(evidence), dismissed })
  }
  return out
}

const SECONDS_PER_DAY = 86_400

function buildDuplicates(db: Db, config: FileConfig, pathMap: PathMap): DuplicatesResponse {
  const evaluation = dupeEvaluation(db)

  const findingsByGroup = groupFindings(db)
  // A group whose finding was dismissed is hidden even if its row still reads open — a dismissal
  // made before the findings routes mirrored it onto the group is caught up only by the next scan's
  // persist(), and until then the operator's word on the finding counts.
  const groupRows = (db.prepare(
    "SELECT id, tier, members_json, keeper_item_id, scores_json FROM dupe_groups WHERE status = 'open'",
  ).all() as GroupRow[]).filter((g) => findingsByGroup.get(g.id)?.dismissed !== true)
  const memberIds = new Map(groupRows.map((g) => [g.id, JSON.parse(g.members_json) as string[]]))
  const items = loadItems(db, [...memberIds.values()].flat())

  // A path a plan has deleted is gone from disk the moment the plan ran, but Jellyfin keeps listing
  // the item until its own library update catches up, and the index until the next scan. Hiding it
  // here is what stops the screen offering to delete a copy that no longer exists.
  const deleted = new Set(
    (db.prepare('SELECT container_path FROM deleted_paths').all() as Array<{ container_path: string }>).map((r) => r.container_path),
  )

  const candidates = groupRows.flatMap((row) => {
    const visible = (memberIds.get(row.id) ?? []).flatMap((id) => {
      const item = items.get(id)
      return item && !(item.container_path !== null && deleted.has(item.container_path)) ? [item] : []
    })
    // Fewer than two copies left is no longer a duplicate, whatever the last scan recorded.
    return visible.length >= 2 ? [{ row, visible }] : []
  })

  const owners = loadOwners(db, candidates.flatMap((c) => c.visible.flatMap((m) => (m.container_path ? [m.container_path] : []))))

  // Per request: a season pack owns files in many groups, and its file list is read and classified once.
  const listStatement = db.prepare('SELECT rel_path FROM torrent_files WHERE instance_id = ? AND hash = ?')
  const factsByTorrent = new Map<string, TorrentFactsView>()
  const factsOf = (owner: OwnerRow): TorrentFactsView => {
    const key = torrentKey({ instanceId: owner.instance_id, hash: owner.hash })
    const known = factsByTorrent.get(key)
    if (known) return known
    const files = listStatement.all(owner.instance_id, owner.hash) as Array<{ rel_path: string }>
    // Not "!== 1": a torrent whose privacy the index does not know is treated as private, the same
    // direction the guard fails in.
    const isPrivate = owner.is_private !== 0
    const ratio = owner.ratio ?? 0
    const seedingSeconds = owner.seeding_time ?? 0
    const facts: TorrentFactsView = {
      instanceId: owner.instance_id,
      hash: owner.hash,
      name: owner.name,
      state: owner.state ?? 'unknown',
      ratio,
      seedingDays: seedingSeconds / SECONDS_PER_DAY,
      isPrivate,
      trackerHost: owner.tracker_host,
      sizeBytes: owner.size_bytes ?? 0,
      fileCount: files.length,
      mediaFileCount: files.filter((f) => !isCompanionFile(f.rel_path, config)).length,
      // Compared in seconds, as guard.private-ratio does (src/plan/guards.ts), so this can never
      // say "met" for a torrent the guard is about to block, or the reverse, over rounding.
      hnrMet: !isPrivate || (ratio >= config.guards.minRatio && seedingSeconds >= config.guards.minSeedTimeDays * SECONDS_PER_DAY),
    }
    factsByTorrent.set(key, facts)
    return facts
  }

  const groups = candidates.map(({ row, visible }): DupeGroupView => {
    const evidence = findingsByGroup.get(row.id)?.evidence
    // A keeper that is no longer among the visible copies (it was the one deleted) is no keeper at
    // all: reading "every other member is a non-keeper" off it would offer to queue the last copies.
    const keeperItemId = visible.some((m) => m.id === row.keeper_item_id) ? row.keeper_item_id : null
    const ordered = [...visible].sort((a, b) =>
      Number(b.id === keeperItemId) - Number(a.id === keeperItemId)
      || (b.size_bytes ?? 0) - (a.size_bytes ?? 0)
      || (a.id < b.id ? -1 : 1))
    const lead = ordered[0]!
    const firstOf = <T>(pick: (m: ItemRow) => T | null): T | null => {
      for (const m of ordered) {
        const value = pick(m)
        if (value !== null) return value
      }
      return null
    }

    const members = ordered.map((m): DupeMemberView => {
      const source = m.container_path === null ? null : pathMap.torrentSourceFor(m.container_path)
      const owning = m.container_path === null ? [] : (owners.get(m.container_path) ?? [])
      return {
        id: m.id,
        name: m.name,
        containerPath: m.container_path,
        sizeBytes: m.size_bytes,
        width: m.width,
        height: m.height,
        bitrate: m.bitrate,
        videoCodec: m.video_codec,
        audioChannels: m.audio_channels,
        container: m.container,
        libraryName: m.library_name,
        videoRange: m.video_range,
        hasSubtitles: m.has_subtitles === 1,
        // What the rule recorded for this member wins, so the badge on a copy and the group's
        // `editionsDiffer` come from the same reading of the names. A finding from before editions
        // were recorded falls back to reading the same input the rule reads (src/rules/dupes/adapter.ts):
        // the path first, since a release folder often carries the edition its file name does not.
        edition: evidence?.editions.has(m.id)
          ? evidence.editions.get(m.id)!
          : editionOf(m.container_path ?? m.jf_path ?? m.name),
        instanceId: source?.kind === 'instance' ? source.instanceId : null,
        torrent: owning[0] ? factsOf(owning[0]) : null,
        torrentCount: owning.length,
      }
    })

    const allScores = JSON.parse(row.scores_json) as DupeGroupView['scores']
    return {
      id: row.id,
      tier: row.tier as DupeGroupView['tier'],
      matchedBy: evidence?.matchedBy ?? [],
      keeperItemId,
      // The policy the keeper was chosen under, recorded by the scan that chose it; the current
      // setting only for a group scanned before that was recorded. A change to the setting takes
      // effect at the next scan, so the two can legitimately differ.
      keeperPolicy: evidence?.keeperPolicy ?? config.keeper.policy,
      title: lead.name,
      year: firstOf((m) => m.year),
      kind: lead.type === 'Episode' ? 'episode' : 'movie',
      seriesName: firstOf((m) => m.series_name),
      seasonNo: firstOf((m) => m.season_no),
      episodeNo: firstOf((m) => m.episode_no),
      // Never a bare `false` for "the finding did not say": that is how a dismissed or pre-editions
      // group lost the flag and the bulk queue took a different cut (final review I2). The members'
      // editions (the finding's own reading, else `editionOf` their paths) are read as the duplicate
      // rule reads them, an unnamed copy counting as one more edition; either reading of "they
      // differ" is enough.
      editionsDiffer: evidence?.editionsDiffer === true || new Set(members.map((m) => m.edition)).size > 1,
      // As for editions: the finding's word, or the members' own file names, read as the rule reads them.
      multiEpisode: evidence?.multiEpisode === true
        || ordered.some((m) => [m.container_path, m.jf_path].some((p) => p !== null && isMultiEpisodeFile(p))),
      crossInstance: new Set(members.flatMap((m) => (m.instanceId === null ? [] : [m.instanceId]))).size > 1,
      reclaimableBytes: keeperItemId === null
        ? 0
        : ordered.filter((m) => m.id !== keeperItemId).reduce((sum, m) => sum + (m.size_bytes ?? 0), 0),
      scores: Object.fromEntries(ordered.flatMap((m) => (allScores[m.id] ? [[m.id, allScores[m.id]!]] : []))),
      members,
    }
  })

  // The most worth reclaiming first — the order the screen opens in — then by name, so ties are stable.
  groups.sort((a, b) => b.reclaimableBytes - a.reclaimableBytes || a.title.localeCompare(b.title) || (a.id < b.id ? -1 : 1))
  return { ...evaluation, groups }
}
