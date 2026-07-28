import type { Db } from '../index/db.js'
import type { FileConfig } from '../config/schema.js'
import type { Finding, FindingClass, RuleId } from '../core/types.js'

export type SourceName = 'jellyfin' | 'filesystem' | 'qbittorrent' | 'arr' | 'hashes'

/**
 * Why a source is not usable this pass, keyed by source. Only unavailable sources appear. Carried
 * alongside the availability set (never derived from it) so the operator-facing `rule_runs.reason`
 * can name the phase that failed and what it said, rather than the bare source name — "couldn't
 * check" is only useful if it also says why.
 */
export type SourceReasons = Partial<Record<SourceName, string>>

/**
 * The one place the "which sources may a rule trust this pass" sentence is written, shared by the
 * runner (which gates whole rules) and by `dupe.group`'s adapter (which gates individual matchers
 * inside one rule). Sharing the function, not just the convention, is what stops those two from
 * ever disagreeing about whether a source counts, or phrasing the same verdict two different ways.
 */
export function unavailableSourcesReason(
  requires: SourceName[],
  available: Set<SourceName>,
  reasons?: SourceReasons,
): string | null {
  const missing = requires.filter((r) => !available.has(r))
  if (!missing.length) return null
  const described = missing.map((m) => (reasons?.[m] ? `${m} (${reasons[m]})` : m))
  return `required sources unavailable: ${described.join(', ')}`
}

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
  /**
   * The sources THIS scan actually observed — not what happens to be sitting in the index. A phase
   * that skipped leaves the previous scan's rows in place (phases only sweep on a complete
   * observation), so "the table has rows" answers a different question than "we looked this time".
   * A rule reads this only to gate sub-units of work it runs internally; the runner has already
   * gated the rule itself on its own `requires`.
   */
  availableSources: Set<SourceName>
  /** Why each unavailable source is unavailable; see `SourceReasons`. */
  sourceReasons?: SourceReasons
}

/**
 * A pure reporting entry for a sub-unit of work inside a rule that itself only registers once in
 * `ALL_RULES` — e.g. `dupe.group` internally runs six duplicate matchers but emits one finding
 * shape per group, not one finding-rule per matcher. Without this, an operator staring at
 * `rule_runs` cannot tell "no identical files" (matcher ran, found nothing) apart from "hashing is
 * off, this matcher never ran" — exactly the ambiguity `rule_runs` exists to rule out for
 * top-level rules. `found` is a link/item count, not a finding count: these are not findings, just
 * visibility into whether the underlying check ran at all.
 */
export interface SubRun {
  ruleId: string
  status: 'evaluated' | 'not-evaluated'
  reason?: string
  found?: number
}

export interface Rule {
  id: RuleId
  class: FindingClass
  requires: SourceName[]
  run(ctx: RuleContext): Finding[]
  /**
   * Optional side-effect step for a rule whose result needs a dedicated mirror table beyond the
   * generic `findings` row — e.g. `dupe.group`'s `dupe_groups`, which the duplicates UI queries
   * directly for group/member/keeper structure that doesn't fit the flat findings shape. The
   * runner calls this only after `run()` has returned successfully and `query_only` has been
   * turned back OFF (see runner.ts) — never while the read-only pragma is active — so `run()`
   * itself stays pure and this cannot be used to smuggle a write into the part of the pass that
   * must stay read-only. It receives exactly the findings this rule's own `run()` just produced,
   * so it never needs to re-derive anything `run()` already worked out; if it throws, the runner
   * isolates it exactly like a `run()` failure (recorded not-evaluated, nothing from this rule
   * persisted this pass) rather than leaving generic findings committed with no matching mirror
   * rows.
   */
  persist?(ctx: RuleContext, findings: Finding[]): void
  /**
   * Optional per-sub-unit visibility (see `SubRun`). Pure and read-only, exactly like `run()`:
   * the runner calls it under the same `query_only = ON` window, immediately after `run()`
   * succeeds, and each returned entry lands as its own `rule_runs` row alongside the rule's own —
   * but only once the whole rule (including `persist`) has succeeded, so a failure anywhere in
   * the rule's pass never leaves a partial set of sub-run rows behind.
   */
  subRuns?(ctx: RuleContext): SubRun[]
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
