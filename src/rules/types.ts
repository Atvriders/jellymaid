import type { Db } from '../index/db.js'
import type { FileConfig } from '../config/schema.js'
import type { Finding, FindingClass, RuleId } from '../core/types.js'

export type SourceName = 'jellyfin' | 'filesystem' | 'qbittorrent' | 'arr' | 'hashes'

export interface RuleContext {
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
