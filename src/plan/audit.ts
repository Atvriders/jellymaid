import type { Db } from '../index/db.js'

export interface AuditEntry {
  actor: string
  actionType: string
  subject: string
  before?: unknown
  after?: unknown
  outcome: string
  planId?: string
  planActionId?: string
}

export function writeAudit(db: Db, entry: AuditEntry): void {
  db.prepare(`INSERT INTO audit (ts, actor, action_type, subject, before_json, after_json, outcome, plan_id, plan_action_id)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    new Date().toISOString(),
    entry.actor,
    entry.actionType,
    entry.subject,
    entry.before === undefined ? null : JSON.stringify(entry.before),
    entry.after === undefined ? null : JSON.stringify(entry.after),
    entry.outcome,
    entry.planId ?? null,
    entry.planActionId ?? null,
  )
}
