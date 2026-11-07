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
  'guard.private-ratio', 'guard.cross-seed', 'guard.hardlink', 'guard.protected', 'guard.torrent-scope',
  'guard.untracked',
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
  /** The root prefix exactly as qBittorrent instance `qbitInstance` reports it. */
  qbit: string | null
  /**
   * Instance id owning `qbit`. Both null = this root is explicitly NOT torrent-backed.
   *
   * Two instances can spell different roots identically — both boxes call their library `/movies`
   * — so a qbit prefix alone does not say whose torrents live under this root. A `qbit` with no
   * instance is therefore a hole in the map, not a default: it fails closed (see
   * `PathMap.torrentSourceFor`), and is filled in automatically only when exactly one instance
   * exists (see `normalizeMappings`).
   */
  qbitInstance: string | null
}

/** A torrent's identity. The same infohash on two instances is two torrents with two lives. */
export interface TorrentRef { instanceId: string; hash: string }

/**
 * NUL-joined, hash lowercased. NUL occurs in neither an instance id (`QBIT_INSTANCE_ID_PATTERN`) nor
 * a hex infohash, so no two refs can collide; lowercasing means the casing one source happened to
 * report cannot split one torrent into two.
 */
export function torrentKey(ref: TorrentRef): string {
  return `${ref.instanceId}\0${ref.hash.toLowerCase()}`
}

/**
 * Which qBittorrent instance may own a container path, per the root it lies under:
 *  - 'instance': the root is torrent-backed by exactly this instance;
 *  - 'none': the root is explicitly not torrent-backed (no qbit prefix, no instance);
 *  - 'unknown': no root covers the path, or the root names a qbit prefix without an instance.
 *    Unknown is never "no torrents" — every consumer treats it as unverifiable.
 */
export type TorrentSource =
  | { kind: 'instance'; instanceId: string }
  | { kind: 'none' }
  | { kind: 'unknown'; reason: string }

/**
 * Stable identity for a finding. Must not change across rescans, or dismissals
 * would resurrect. Arrays are sorted so subject ordering cannot perturb the id.
 * EVERY join uses a NUL byte, including the ruleId-to-key join, because any separator that can
 * occur inside an element collides: with a space, findingId('a', 'b c') and findingId('a b', 'c')
 * hash the same string, exactly as ['x', 'y z'] and ['x y', 'z'] would.
 */
export function findingId(ruleId: RuleId, subjectKey: string | string[]): string {
  const key = Array.isArray(subjectKey) ? [...subjectKey].sort().join('\0') : subjectKey
  return createHash('sha256').update(`${ruleId}\0${key}`).digest('hex').slice(0, 32)
}
