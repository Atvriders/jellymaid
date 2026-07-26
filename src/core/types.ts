import { createHash } from 'node:crypto'

export const FINDING_CLASSES = ['duplicate', 'filesystem', 'metadata', 'quality'] as const
export type FindingClass = (typeof FINDING_CLASSES)[number]

export const SEVERITIES = ['critical', 'warning', 'info'] as const
export type Severity = (typeof SEVERITIES)[number]

export const CONFIDENCES = ['exact', 'strong', 'possible'] as const
export type Confidence = (typeof CONFIDENCES)[number]

export type RuleId = string

/** A rule either ran, or could not run. There is no third state, and "ran with no results" is `evaluated`. */
export const EVALUATION_STATUSES = ['evaluated', 'not-evaluated'] as const
export type EvaluationStatus = (typeof EVALUATION_STATUSES)[number]

export type Subject =
  | { kind: 'item'; id: string; label: string; path?: string }
  | { kind: 'path'; path: string; label: string }

export interface Finding {
  id: string
  ruleId: RuleId
  class: FindingClass
  severity: Severity
  confidence: Confidence
  subjects: Subject[]
  evidence: Record<string, unknown>
  reclaimableBytes: number | null
  status: 'open' | 'dismissed' | 'resolved'
  firstSeen: string
  lastSeen: string
}

export const ACTION_TYPES = [
  'merge-versions', 'split-versions', 'delete-media', 'remove-empty-folder', 'delete-junk-file',
] as const
export type ActionType = (typeof ACTION_TYPES)[number]

export const ACTION_STATUSES = ['pending', 'running', 'done', 'failed', 'skipped', 'blocked'] as const
export type ActionStatus = (typeof ACTION_STATUSES)[number]

export const GUARD_IDS = [
  'guard.private-ratio', 'guard.cross-seed', 'guard.hardlink', 'guard.protected',
] as const
export type GuardId = (typeof GUARD_IDS)[number]

export interface GuardVerdict {
  guard: GuardId
  outcome: 'pass' | 'warn' | 'block'
  overridable: boolean
  reason: string
  evidence: Record<string, unknown>
}

export type PathRole = 'library' | 'download'

export interface PathMapping {
  role: PathRole
  /** null for download-only roots that have no Jellyfin equivalent. */
  jellyfin: string | null
  container: string
  qbit: string | null
}

/**
 * Stable identity for a finding. Must not change across rescans, or dismissals
 * would resurrect. Arrays are sorted so subject ordering cannot perturb the id.
 */
export function findingId(ruleId: RuleId, subjectKey: string | string[]): string {
  const key = Array.isArray(subjectKey) ? [...subjectKey].sort().join(' ') : subjectKey
  return createHash('sha256').update(`${ruleId} ${key}`).digest('hex').slice(0, 32)
}
