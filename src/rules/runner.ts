import type { Db } from '../index/db.js'
import type { FileConfig } from '../config/schema.js'
import type { Rule, SourceName } from './types.js'
import { ALL_RULES } from './registry.js'

export interface RuleRunSummary {
  evaluated: string[]
  notEvaluated: Array<{ ruleId: string; reason: string }>
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
    try {
      findings = rule.run({ db, config: opts.config, scanId: opts.scanId, now })
    } catch (err) {
      const reason = `rule threw: ${(err as Error).message}`
      recordRun.run(opts.scanId, rule.id, 'not-evaluated', reason, 0, Date.now() - started)
      summary.notEvaluated.push({ ruleId: rule.id, reason })
      continue
    }

    const write = db.transaction(() => {
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
    })
    write()

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

  return summary
}
