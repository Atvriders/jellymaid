import type { Db } from '../index/db.js'
import type { FileConfig } from '../config/schema.js'
import type { Finding, FindingClass, RuleId } from '../core/types.js'

export type SourceName = 'jellyfin' | 'filesystem' | 'qbittorrent' | 'arr' | 'hashes'

export interface RuleContext {
  /**
   * The index database. Rules are pure and read-only — the runner enforces this rather than
   * merely documenting it: this connection is put into `PRAGMA query_only` mode for the duration
   * of `run()`, so a rule that attempts a write throws and is isolated exactly like any other
   * throwing rule (recorded `not-evaluated`), instead of silently mutating state the runner has
   * not reconciled yet.
   */
  db: Db
  config: FileConfig
  scanId: number
  now: string
}

export interface Rule {
  id: RuleId
  class: FindingClass
  requires: SourceName[]
  run(ctx: RuleContext): Finding[]
}

/** Duplicate rules emit links; grouping is a separate concern. */
export interface DupeLink {
  ruleId: RuleId
  a: string
  b: string
  confidence: 'exact' | 'strong' | 'possible'
  evidence: Record<string, unknown>
}

export interface DupeRule {
  id: RuleId
  requires: SourceName[]
  link(ctx: RuleContext): DupeLink[]
}
