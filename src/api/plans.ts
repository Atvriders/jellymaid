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

const sessionOf = (req: FastifyRequest) => (req as FastifyRequest & { session: SessionPayload }).session

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
    // mergeVersions has no defined behaviour for that. status='merged' is set only once, in the
    // same transaction as the audit row below, so this check and that write can never disagree.
    if (row.status === 'merged') {
      return reply.code(409).send({ error: `duplicate group ${groupId} was already merged` })
    }
    const ids = JSON.parse(row.members_json) as string[]
    if (ids.length < 2) return reply.code(409).send({ error: 'group has fewer than two members' })
    await deps.jellyfin.mergeVersions(ids)
    const actor = sessionOf(req).username
    // The status flip and the audit row land together or not at all — the same pairing the
    // executor's own `settle`+`writeAudit` uses — so this merge can never succeed with zero trace
    // in the audit log, and the log can never claim a merge that did not actually take.
    deps.db.transaction(() => {
      deps.db.prepare("UPDATE dupe_groups SET status='merged' WHERE id=?").run(groupId)
      writeAudit(deps.db, {
        actor,
        actionType: 'merge-versions',
        subject: groupId,
        after: { mergedItemIds: ids },
        outcome: 'done',
      })
    })()
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
}
