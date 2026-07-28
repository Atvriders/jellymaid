import type { Db } from '../index/db.js'
import type { FileConfig } from '../config/schema.js'
import type { Rule, SourceName } from './types.js'
import { ALL_RULES } from './registry.js'

export interface RuleRunSummary {
  evaluated: string[]
  notEvaluated: Array<{ ruleId: string; reason: string }>
  /**
   * Every finding an evaluated rule emitted this pass, including ones that already existed and
   * were merely refreshed (bumped `last_seen`) — this is not "new since the last scan". A future
   * summary UI that wants "brand new this scan" must diff against the previous pass itself.
   */
  created: number
  resolved: number
  reopened: number
}

export function runRules(opts: {
  db: Db
  config: FileConfig
  scanId: number
  availableSources: Set<SourceName>
  rules?: Rule[]
  now?: string
}): RuleRunSummary {
  const { db } = opts
  const now = opts.now ?? new Date().toISOString()
  const rules = opts.rules ?? ALL_RULES
  const summary: RuleRunSummary = { evaluated: [], notEvaluated: [], created: 0, resolved: 0, reopened: 0 }

  const upsert = db.prepare(`INSERT INTO findings
    (id, rule_id, class, severity, confidence, subjects_json, evidence_json, reclaimable_bytes,
     status, first_seen, last_seen)
    VALUES (@id, @ruleId, @class, @severity, @confidence, @subjects, @evidence, @reclaimable,
            'open', @now, @now)
    ON CONFLICT(id) DO UPDATE SET
      last_seen = @now,
      severity = @severity,
      confidence = @confidence,
      subjects_json = @subjects,
      evidence_json = @evidence,
      reclaimable_bytes = @reclaimable,
      status = CASE findings.status WHEN 'dismissed' THEN 'dismissed' ELSE 'open' END`)

  const recordRun = db.prepare(`INSERT OR REPLACE INTO rule_runs
    (scan_id, rule_id, status, reason, found, duration_ms) VALUES (?,?,?,?,?,?)`)

  const countReopened = db.prepare(
    "SELECT COUNT(*) c FROM findings WHERE id = ? AND status = 'resolved'",
  )

  // Reconciliation must not depend on wall-clock uniqueness: `now` is millisecond-resolution and
  // two runRules() calls issued back to back (common when a caller doesn't pass an explicit `now`)
  // can produce the identical string, which would make a `last_seen != @now` staleness check see
  // every finding as "still current" even though this pass never touched it. Instead we record,
  // per pass, exactly which finding ids each evaluated rule actually emitted, in a temp table
  // (not a SQL parameter list — a rule can emit far more findings than SQLite's ~999-variable
  // statement limit), and resolve only what a rule ran this pass and did not re-emit.
  db.exec('CREATE TEMP TABLE IF NOT EXISTS _touched_findings (id TEXT PRIMARY KEY)')
  db.exec('DELETE FROM _touched_findings')
  const markTouched = db.prepare('INSERT OR IGNORE INTO _touched_findings (id) VALUES (?)')

  // The whole pass — every rule_runs insert, every finding upsert, and the trailing resolve —
  // runs as one transaction. A rule's own thrown error is still caught per-rule below (so one bad
  // rule never aborts the pass and its neighbors' work still commits); this outer transaction
  // instead guards against a genuinely unexpected failure (a crash, or a defect in the runner
  // itself) landing between two of those statements, which would otherwise leave a rule with no
  // rule_runs row at all — neither evaluated nor not-evaluated, the one state this table exists to
  // rule out. A half-written pass rolling all the way back is correct; a half-written pass
  // persisting is not.
  const pass = db.transaction(() => {
    for (const rule of rules) {
      const missing = rule.requires.filter((r) => !opts.availableSources.has(r))
      if (missing.length) {
        const reason = `required sources unavailable: ${missing.join(', ')}`
        recordRun.run(opts.scanId, rule.id, 'not-evaluated', reason, 0, 0)
        summary.notEvaluated.push({ ruleId: rule.id, reason })
        continue
      }

      const started = Date.now()
      let findings
      // Rules are pure and read-only by contract; enforce it at the connection level instead of
      // trusting it. A rule that attempts a write throws SQLITE_READONLY, which the catch below
      // isolates exactly like any other throwing rule. query_only is turned back off as the very
      // first statement of both the success path and the catch — not in a `finally` — because a
      // `finally` runs only after the catch block's own statements (including recordRun.run below)
      // have already executed, which would make that write itself fail read-only too.
      //
      // A rule's optional `persist` step runs inside this same try, immediately after query_only
      // goes back off: it is the one place a rule is allowed to write, and only after `run()` —
      // the pure part — has already succeeded. If `persist` throws, control falls into the same
      // catch as a throwing `run()` and the rule is recorded not-evaluated; that is deliberate,
      // not an oversight, so a rule's mirror-table write and its findings can never disagree
      // (findings committed but persist failed, or vice versa).
      db.pragma('query_only = ON')
      try {
        findings = rule.run({ db, config: opts.config, scanId: opts.scanId, now })
        db.pragma('query_only = OFF')
        rule.persist?.({ db, config: opts.config, scanId: opts.scanId, now }, findings)
      } catch (err) {
        db.pragma('query_only = OFF')
        const reason = `rule threw: ${(err as Error).message}`
        recordRun.run(opts.scanId, rule.id, 'not-evaluated', reason, 0, Date.now() - started)
        summary.notEvaluated.push({ ruleId: rule.id, reason })
        continue
      }

      for (const f of findings) {
        const wasResolved = (countReopened.get(f.id) as { c: number }).c > 0
        upsert.run({
          id: f.id, ruleId: f.ruleId, class: f.class, severity: f.severity, confidence: f.confidence,
          subjects: JSON.stringify(f.subjects), evidence: JSON.stringify(f.evidence),
          reclaimable: f.reclaimableBytes, now,
        })
        markTouched.run(f.id)
        if (wasResolved) summary.reopened += 1
      }

      summary.created += findings.length
      summary.evaluated.push(rule.id)
      recordRun.run(opts.scanId, rule.id, 'evaluated', null, findings.length, Date.now() - started)
    }

    // Only rules that actually ran may resolve their own stale findings. A rule that could not be
    // evaluated leaves its previous findings untouched — absence of evidence is not evidence of absence.
    // Membership in `_touched_findings` (not a timestamp comparison) decides staleness, and only
    // 'open' findings are eligible, so a 'dismissed' finding can never be un-dismissed by a rescan.
    if (summary.evaluated.length) {
      const placeholders = summary.evaluated.map(() => '?').join(',')
      const info = db.prepare(
        `UPDATE findings SET status='resolved'
         WHERE status='open' AND rule_id IN (${placeholders})
         AND id NOT IN (SELECT id FROM _touched_findings)`,
      ).run(...summary.evaluated)
      summary.resolved = info.changes
    }
  })
  pass()

  return summary
}
