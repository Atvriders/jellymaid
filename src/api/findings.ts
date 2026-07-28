import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Db } from '../index/db.js'
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

export function registerFindingsRoutes(app: FastifyInstance, deps: { db: Db; sessionSecret: string }): void {
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

  app.post('/api/findings/:id/dismiss', guard, async (req, reply) => {
    const parsed = dismissBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'a dismiss reason is required' })
    const { id } = req.params as { id: string }
    const info = deps.db.prepare(
      "UPDATE findings SET status='dismissed', dismissed_reason=?, dismissed_by=?, dismissed_at=? WHERE id=?",
    ).run(parsed.data.reason, sessionOf(req).username, new Date().toISOString(), id)
    if (info.changes === 0) return reply.code(404).send({ error: 'no such finding' })
    return reply.send({ ok: true })
  })

  app.post('/api/findings/:id/reopen', guard, async (req, reply) => {
    const { id } = req.params as { id: string }
    const info = deps.db.prepare(
      "UPDATE findings SET status='open', dismissed_reason=NULL, dismissed_by=NULL, dismissed_at=NULL WHERE id=?",
    ).run(id)
    if (info.changes === 0) return reply.code(404).send({ error: 'no such finding' })
    return reply.send({ ok: true })
  })

  app.get('/api/duplicates', guard, async (_req, reply) => {
    const groups = deps.db.prepare("SELECT * FROM dupe_groups WHERE status = 'open' ORDER BY tier, id")
      .all() as Array<{ id: string; tier: string; members_json: string; keeper_item_id: string | null; scores_json: string }>

    // Finding 6a: `dupe_groups` never stored WHICH matcher(s) agreed on a group — `tier` alone
    // cannot distinguish a byte-verified match from two items that merely share a TMDB id
    // (dupe.provider-id and dupe.series-episode both emit 'exact' from pure metadata). That list
    // — `matchedBy` — is only ever persisted in the `dupe.group` finding's `evidence_json`
    // (src/rules/dupes/adapter.ts), keyed there by `evidence.groupId`, which is the same value as
    // `dupe_groups.id`. Joined here rather than added to `dupe_groups` itself (a migration) — the
    // data already exists, so a join is all this needs. Only `status = 'open'` findings are
    // eligible, matching every other read of this table: a dismissed finding's stale evidence must
    // never be attributed to a group that has since been re-evaluated.
    const matchedByRows = deps.db.prepare(
      "SELECT evidence_json AS evidenceJson FROM findings WHERE rule_id = 'dupe.group' AND class = 'duplicate' AND status = 'open'",
    ).all() as Array<{ evidenceJson: string }>
    const matchedByGroup = new Map<string, string[]>()
    for (const row of matchedByRows) {
      const evidence = JSON.parse(row.evidenceJson) as { groupId?: string; matchedBy?: string[] }
      if (evidence.groupId && Array.isArray(evidence.matchedBy)) matchedByGroup.set(evidence.groupId, evidence.matchedBy)
    }

    const detail = groups.map((g) => {
      const memberIds = JSON.parse(g.members_json) as string[]
      const placeholders = memberIds.map(() => '?').join(',')
      // Finding 6b: video_range and has_subtitles (004_item_quality_signals.sql) already live on
      // this exact table this query already reads from — the two column names below are the whole
      // fix for surfacing the real signals behind the keeper score's HDR/subtitles weights,
      // instead of leaving the operator to trust a bare number with nothing to corroborate it.
      const members = deps.db.prepare(
        `SELECT id, name, container_path, size_bytes, height, bitrate, video_codec, audio_channels,
                container, library_name, video_range, has_subtitles
         FROM jellyfin_items WHERE id IN (${placeholders})`,
      ).all(...memberIds)
      return {
        id: g.id, tier: g.tier, keeperItemId: g.keeper_item_id,
        scores: JSON.parse(g.scores_json), members,
        matchedBy: matchedByGroup.get(g.id) ?? [],
      }
    })
    return reply.send({ groups: detail })
  })
}
