import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Db } from '../index/db.js'
import { requireSession } from './auth.js'
import type { SessionPayload } from '../auth/session.js'
import { ACTION_TYPES, GUARD_IDS } from '../core/types.js'
import { buildPlan, getPlan, approvePlan, type PlannerDeps } from '../plan/planner.js'
import { restoreFromTrash, type TrashDeps } from '../plan/trash.js'
import type { createExecutor } from '../plan/executor.js'
import { writeAudit } from '../plan/audit.js'

const actionSchema = z.object({
  type: z.enum(ACTION_TYPES),
  targetPath: z.string().min(1).optional(),
  itemIds: z.array(z.string().min(1)).optional(),
  // z.enum(GUARD_IDS) rejects an override naming any guard that does not exist — including
  // 'guard.torrent-scope', the fifth guard — with the same 400 every other malformed action gets.
  overrides: z.array(z.enum(GUARD_IDS)).optional(),
})
const planBody = z.object({ actions: z.array(actionSchema).min(1) })
// A malformed ?limit (non-numeric, negative) coerced by a bare `Number()` becomes NaN, and
// better-sqlite3 throws `datatype mismatch` on a NaN bound parameter — an uncaught 500 for
// something that is really the caller's fault. Validating with zod, the same way findings.ts's
// listQuery does, turns that into a clean 400 instead.
const auditQuery = z.object({ limit: z.coerce.number().int().min(1).max(1000).default(200) })

// Mirrors auditQuery above: a malformed ?limit/?offset coerced by a bare `Number()` becomes NaN,
// and better-sqlite3 throws `datatype mismatch` on a NaN bound parameter — an uncaught 500 for
// something that is really the caller's fault. `includeRestored` is spelled as an explicit
// 'true'/'false' enum rather than `z.coerce.boolean()`: zod's boolean coercion runs every non-empty
// string through the JS `Boolean()` constructor, so `?includeRestored=false` would coerce to
// `true` — the exact opposite of what the caller asked for.
const trashQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  offset: z.coerce.number().int().min(0).default(0),
  // Defaults to including restored rows: this is the pre-pagination behaviour (every row, restored
  // or not — see GET /api/trash's own doc comment below), preserved so an existing caller that
  // never learns about this flag keeps seeing exactly what it always saw.
  includeRestored: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
})

const sessionOf = (req: FastifyRequest) => (req as FastifyRequest & { session: SessionPayload }).session

/**
 * How long a plan must have been `running` before /resume will treat it as wreckage.
 *
 * `executor.isRunning()` is an IN-PROCESS mutex: it says nothing about a second process, or a
 * second container, executing the same database. To that check, a plan another executor is
 * actively holding looks exactly like the crash this route exists to recover from — and resuming
 * it would run the unfinished tail concurrently with the executor that is still working through
 * it. There is no cross-process heartbeat to consult, so age stands in for one: a plan whose
 * started_at is minutes old and still unfinished is plausibly a crash, while a plan that started
 * moments ago is overwhelmingly likely to be alive somewhere. Five minutes is comfortably longer
 * than any single action (a delete, a trash move, a Jellyfin merge) should take, so a genuinely
 * crashed plan crosses the line quickly, and the cost of the wait is only that the operator
 * recovers a few minutes later — against the cost of double-executing destructive actions.
 */
const RESUME_MIN_STALENESS_MS = 5 * 60_000

export interface PlanRoutesDeps {
  db: Db
  sessionSecret: string
  plannerDeps: () => PlannerDeps
  trashDeps: () => TrashDeps
  executor: ReturnType<typeof createExecutor>
  jellyfin: { mergeVersions(ids: string[]): Promise<void> }
}

export function registerPlanRoutes(app: FastifyInstance, deps: PlanRoutesDeps): void {
  const guard = { preHandler: requireSession(deps.sessionSecret) }

  app.post('/api/plans', guard, async (req, reply) => {
    const parsed = planBody.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid plan', issues: parsed.error.issues.map((i) => i.message) })
    }
    try {
      const plan = await buildPlan(deps.plannerDeps(), {
        createdBy: sessionOf(req).username,
        actions: parsed.data.actions,
      })
      return reply.code(201).send(plan)
    } catch (err) {
      // A refusal to plan (outside a root, too few merge ids) is the caller's fault, not a server fault.
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  app.get('/api/plans', guard, async (_req, reply) => {
    const rows = deps.db.prepare(
      'SELECT id, created_at, created_by, status, dry_run_json FROM plans ORDER BY created_at DESC LIMIT 50',
    ).all() as Array<{ id: string; created_at: string; created_by: string; status: string; dry_run_json: string }>
    return reply.send({
      plans: rows.map((r) => ({
        id: r.id, createdAt: r.created_at, createdBy: r.created_by, status: r.status,
        dryRun: JSON.parse(r.dry_run_json),
      })),
    })
  })

  app.get('/api/plans/:id', guard, async (req, reply) => {
    const plan = getPlan(deps.db, (req.params as { id: string }).id)
    return plan ? reply.send(plan) : reply.code(404).send({ error: 'no such plan' })
  })

  app.post('/api/plans/:id/approve', guard, async (req, reply) => {
    try {
      return reply.send(approvePlan(deps.db, (req.params as { id: string }).id, sessionOf(req).username))
    } catch (err) {
      const message = (err as Error).message
      return reply.code(message.includes('does not exist') ? 404 : 409).send({ error: message })
    }
  })

  app.post('/api/plans/:id/execute', guard, async (req, reply) => {
    const { id } = req.params as { id: string }
    // Checked HERE, against the database, rather than left entirely to whatever executor is
    // injected: the approval gate is the product's core safety promise, and a route that only
    // forwards to the executor's own check has no defence left if that check is ever weakened,
    // swapped out, or — as a test executor may legitimately do — stubbed out entirely.
    const plan = getPlan(deps.db, id)
    if (!plan) return reply.code(404).send({ error: 'no such plan' })
    if (plan.status !== 'approved') {
      return reply.code(409).send({ error: `plan ${id} is not approved (status: ${plan.status})` })
    }
    try {
      return reply.send(await deps.executor.execute(id, sessionOf(req).username))
    } catch (err) {
      const message = (err as Error).message
      return reply.code(message.includes('does not exist') ? 404 : 409).send({ error: message })
    }
  })

  /**
   * Spec §13 crash recovery. A process killed mid-execution leaves the plan stuck in
   * `running`, which `execute` rightly refuses — every later execute on this database would
   * otherwise fail with "already running" forever. Resuming is an explicit operator decision,
   * never automatic — actions already `done` are skipped by the executor's own idempotence check,
   * so only the unfinished tail runs. `running` plan_actions rows (an action that was mid-flight
   * when the process died — its own state unknown) are flipped back to `pending` HERE, before the
   * executor sees them, so it re-resolves and re-guards them rather than treating an unknown
   * half-done action as if it had already reached a terminal state.
   */
  app.post('/api/plans/:id/resume', guard, async (req, reply) => {
    const { id } = req.params as { id: string }
    // A live executor that still thinks it is running (the in-process mutex) means this is not a
    // crash at all — some other request on THIS process is mid-execute — so resuming now would
    // race it rather than recover from it.
    if (deps.executor.isRunning()) return reply.code(409).send({ error: 'a plan is already running' })
    const plan = getPlan(deps.db, id)
    if (!plan) return reply.code(404).send({ error: 'no such plan' })
    if (plan.status !== 'running') {
      return reply.code(409).send({ error: `plan is ${plan.status}, not an interrupted run` })
    }
    // getPlan's PlanView does not carry started_at, so read it directly. NULL means the plan never
    // actually entered the executor (a row forced to 'running' by hand, say) — there is no evidence
    // anything is running it, so there is nothing to wait for and it stays resumable. Likewise an
    // unparseable timestamp: it is not evidence of a live run, and refusing on it would strand the
    // plan with no way back.
    const startedAt = (deps.db.prepare('SELECT started_at FROM plans WHERE id = ?').get(id) as
      { started_at: string | null } | undefined)?.started_at ?? null
    const startedMs = startedAt === null ? Number.NaN : Date.parse(startedAt)
    const ageMs = Date.now() - startedMs
    if (!Number.isNaN(startedMs) && ageMs < RESUME_MIN_STALENESS_MS) {
      const ago = ageMs < 0 ? 'in the future' : `${Math.round(ageMs / 1000)}s ago`
      return reply.code(409).send({
        error: `plan ${id} started recently (started_at ${startedAt}, ${ago}), so it is more likely still `
          + `running — possibly in another process — than crashed. Wait until it has been running for at `
          + `least ${Math.round(RESUME_MIN_STALENESS_MS / 60_000)} minutes, or confirm the executor holding `
          + `it is really dead, before resuming; resuming a live run would execute its remaining actions twice.`,
      })
    }
    deps.db.prepare("UPDATE plans SET status='approved' WHERE id=?").run(id)
    deps.db.prepare("UPDATE plan_actions SET status='pending' WHERE plan_id=? AND status='running'").run(id)
    try {
      return reply.send(await deps.executor.execute(id, sessionOf(req).username))
    } catch (err) {
      // Symmetric with /execute above: a throw here can only come from the same `execute`
      // function (the cross-process DB claim, since the in-process mutex was just checked), so it
      // gets the same caller-facing mapping rather than falling through to a generic 500.
      const message = (err as Error).message
      return reply.code(message.includes('does not exist') ? 404 : 409).send({ error: message })
    }
  })

  /**
   * A direct shortcut around the plan/approve/execute flow: Merge Versions is a reversible
   * Jellyfin metadata change, not a filesystem delete, so it does not need a dry run an operator
   * signs off on first. It still needs the same two things every OTHER state-changing route in
   * this file gets for free from the plan/execute path: a permanent record of who did it, and
   * safety against being replayed.
   */
  app.post('/api/duplicates/:groupId/merge', guard, async (req, reply) => {
    const { groupId } = req.params as { groupId: string }
    const row = deps.db.prepare('SELECT members_json, status FROM dupe_groups WHERE id = ?').get(groupId) as
      { members_json: string; status: string } | undefined
    if (!row) return reply.code(404).send({ error: 'no such duplicate group' })
    // A double-click or a client retry after a timeout must not re-issue the merge: the ids in
    // members_json may no longer name independent items once the first attempt succeeded, and
    // mergeVersions has no defined behaviour for that.
    if (row.status === 'merged') {
      return reply.code(409).send({ error: `duplicate group ${groupId} was already merged` })
    }
    const ids = JSON.parse(row.members_json) as string[]
    // The cheap validations run BEFORE the claim below, so a malformed group is never claimed and
    // never has to be released.
    if (ids.length < 2) return reply.code(409).send({ error: 'group has fewer than two members' })
    /**
     * Claim the group BEFORE calling Jellyfin, not after. Reading status and then awaiting
     * mergeVersions leaves the whole network round-trip between the check and the write: two
     * concurrent requests — the double-click named above — both read 'open', both pass, and
     * Jellyfin gets merged twice with ids that no longer name independent items. The UPDATE's own
     * `AND status != 'merged'` is the check, evaluated atomically with the write by SQLite, so
     * exactly one of any number of racers sees changes === 1; every loser gets the same 409 a
     * plain replay gets.
     */
    const claimed = deps.db.transaction(() =>
      deps.db.prepare("UPDATE dupe_groups SET status='merged' WHERE id = ? AND status != 'merged'")
        .run(groupId).changes,
    ).immediate()
    if (claimed !== 1) {
      return reply.code(409).send({ error: `duplicate group ${groupId} was already merged` })
    }
    try {
      await deps.jellyfin.mergeVersions(ids)
    } catch (err) {
      // Release the claim: nothing was merged, so the group must stay mergeable. Without this a
      // transient Jellyfin outage would wedge it as permanently un-mergeable, with no route that
      // can undo a status the operator never asked for.
      deps.db.prepare('UPDATE dupe_groups SET status = ? WHERE id = ?').run(row.status, groupId)
      throw err
    }
    const actor = sessionOf(req).username
    /**
     * The merge really happened, so record it. Claiming first trades one exposure for another:
     * before, a failed bookkeeping write left the group re-mergeable with no audit trace; now it
     * leaves the group claimed with no audit trace. That is the safer direction — a replayed merge
     * against ids that no longer name independent items is unrecoverable, while a missing audit row
     * for a merge that visibly took is a gap in the record, not damage to the library.
     */
    writeAudit(deps.db, {
      actor,
      actionType: 'merge-versions',
      subject: groupId,
      after: { mergedItemIds: ids },
      outcome: 'done',
    })
    return reply.send({ merged: ids })
  })

  app.get('/api/audit', guard, async (req, reply) => {
    const parsed = auditQuery.safeParse(req.query)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid query' })
    const entries = deps.db.prepare(
      'SELECT ts, actor, action_type AS actionType, subject, outcome, plan_id AS planId, after_json AS afterJson FROM audit ORDER BY id DESC LIMIT ?',
    ).all(parsed.data.limit)
    return reply.send({ entries })
  })

  app.post('/api/trash/:id/restore', guard, async (req, reply) => {
    const result = restoreFromTrash(deps.trashDeps(), (req.params as { id: string }).id)
    return result.restored ? reply.send(result) : reply.code(409).send(result)
  })

  /**
   * History (Plan 5, Task 6) needs somewhere to read the trash back from: `restoreFromTrash` only
   * ever takes an id it is handed, and until now nothing handed the operator one. Every row,
   * restored or not, is eligible by default — a restored entry's Restore button is not offered a
   * second time (the same `restored_at IS NULL` replay guard `restoreFromTrash` itself enforces),
   * but hiding it entirely would erase the one record that a file was ever moved there and later
   * put back. `includeRestored=false` lets a caller narrow to only what is still restorable.
   *
   * Finding 4: this used to be a bare `ORDER BY deleted_at DESC LIMIT 200` with no offset and no
   * restored filter — anything past row 200 (and every slot an already-restored row still
   * occupied) was permanently unreachable, forever, on a library that trashes more than 200 files
   * in its lifetime. `limit`/`offset` mirror `auditQuery` above; `total` — counted under the SAME
   * `includeRestored` filter as the page itself — is what lets a caller say "showing N of M"
   * instead of silently truncating.
   */
  app.get('/api/trash', guard, async (req, reply) => {
    const parsed = trashQuery.safeParse(req.query)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid query' })
    const { limit, offset, includeRestored } = parsed.data
    const restrictClause = includeRestored ? '' : 'WHERE restored_at IS NULL'
    const total = (deps.db.prepare(`SELECT COUNT(*) c FROM trash ${restrictClause}`).get() as { c: number }).c
    const entries = deps.db.prepare(
      `SELECT id, original_path AS originalPath, size_bytes AS sizeBytes, deleted_at AS deletedAt,
              purge_after AS purgeAfter, restored_at AS restoredAt, plan_id AS planId
       FROM trash ${restrictClause} ORDER BY deleted_at DESC LIMIT ? OFFSET ?`,
    ).all(limit, offset)
    return reply.send({ entries, total })
  })

  /**
   * Read-only, and deliberately narrow: only the numbers Settings needs to explain WHY a guard
   * fired (min ratio / seed days, the protected category and tag lists) or why a delete went to
   * the trash instead of being unlinked outright (the trash size ceiling and retention window).
   * Nothing here can be written back through this route — editing these values is a config-file
   * change, not a Jellymaid API call — so there is no risk of this becoming a second, competing
   * way to set what `evaluateGuards`/`moveToTrash` actually enforce.
   *
   * `config.guards` also carries `privateTrackerHosts` — the operator's private-tracker list, and
   * not something this read-only settings display has any business publishing. Deliberately NOT
   * destructured into a local `guards`/`trash` object the way this route used to: a `const {
   * guards, trash } = ...config` sitting in scope is an invitation for some future edit to shortcut
   * a new field with `...guards`, silently republishing the whole object, host list included.
   * Reading each field off `deps.plannerDeps().config` directly leaves no such object lying around
   * to spread.
   */
  app.get('/api/config/thresholds', guard, async (_req, reply) => {
    const config = deps.plannerDeps().config
    return reply.send({
      minRatio: config.guards.minRatio,
      minSeedTimeDays: config.guards.minSeedTimeDays,
      protectedCategories: config.guards.protectedCategories,
      protectedTags: config.guards.protectedTags,
      trashMaxBytes: config.trash.maxBytes,
      trashRetentionDays: config.trash.retentionDays,
    })
  })
}
