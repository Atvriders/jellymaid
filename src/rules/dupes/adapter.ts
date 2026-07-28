import type { Finding, Subject } from '../../core/types.js'
import { findingId } from '../../core/types.js'
import type { DupeLink, DupeRule, Rule, RuleContext, SubRun } from '../types.js'
import { DUPE_RULES } from './index.js'
import { buildDupeGroups } from '../grouping.js'
import { DEFAULT_KEEPER_WEIGHTS, pickKeeper, type MemberFacts } from '../keeper.js'

interface MemberRow {
  id: string; name: string; container_path: string | null; size_bytes: number | null
  height: number | null; bitrate: number | null; video_codec: string | null
  audio_channels: number | null; library_name: string | null
}

/**
 * The exact shape `run()` writes into a `dupe.group` finding's `evidence`, and the shape
 * `persist()` reads back out of it. `Finding.evidence` itself is necessarily typed as
 * `Record<string, unknown>` (every rule's evidence is a different shape), so nothing stops the two
 * ends from drifting apart silently — this interface is the seam that turns that drift into a
 * compile error instead of a runtime bind mistake. `scores` is tied directly to `pickKeeper`'s own
 * return type rather than hand-copied, so a future change to the scoring result shape in
 * `keeper.ts` flows through here automatically instead of needing to be kept in sync by hand.
 */
interface DupeGroupEvidence extends Record<string, unknown> {
  groupId: string
  keeperId: string
  scores: ReturnType<typeof pickKeeper>['scores']
  matchedBy: string[]
  links: DupeLink[]
  crossLibrary: boolean
}

function hasHashes(ctx: RuleContext): boolean {
  const row = ctx.db.prepare('SELECT COUNT(*) c FROM fs_entries WHERE quick_hash IS NOT NULL').get() as { c: number }
  return row.c > 0
}

/** The two matchers with a config `enabled` flag; every other matcher id has none. */
function configEnabled(ctx: RuleContext, ruleId: string): boolean | null {
  switch (ruleId) {
    case 'dupe.runtime': return ctx.config.rules['dupe.runtime'].enabled
    case 'dupe.fuzzy-title': return ctx.config.rules['dupe.fuzzy-title'].enabled
    default: return null
  }
}

/**
 * Why a matcher would contribute nothing this pass, or `null` if there's no known reason it
 * shouldn't run. Shared by `run()` (which silently skips an unavailable matcher's links) and
 * `subRuns()` (which reports the same judgement as a `rule_runs` row) so the two can never
 * disagree about which matchers actually ran.
 */
function unavailableReason(ctx: RuleContext, matcher: DupeRule): string | null {
  if (matcher.requires.includes('hashes') && !hasHashes(ctx)) {
    return 'no fs_entries row has a quick_hash yet — hashing is disabled or has not completed'
  }
  if (configEnabled(ctx, matcher.id) === false) return 'disabled in config'
  return null
}

/**
 * One rule that runs every duplicate matcher, groups the links, scores keepers, and emits a
 * single finding per group. Registered as `dupe.group`.
 *
 * `run()` is read-only, as every rule must be: it only ever SELECTs. The `dupe_groups` table is
 * a dedicated mirror the duplicates UI reads directly (group/member/keeper structure the flat
 * `findings` row doesn't fit), and used to be written here — but the runner puts the connection
 * into `PRAGMA query_only` for the exact duration of `run()`, so that write would throw
 * SQLITE_READONLY every pass. Rather than weaken that enforcement, the group data a write would
 * need (memberIds, tier, keeperId, scores) is carried entirely inside each finding's `evidence`
 * (see `DupeGroupEvidence`) and `confidence`/`subjects`, and `persist()` below — which the runner
 * calls separately, only after `run()` has already succeeded and query_only is back off — reads it
 * back out of those findings and writes `dupe_groups` from them. No second pass over the database,
 * no recomputation: `persist()` is a pure reshape of what `run()` already produced.
 */
export const dupeGroupRule: Rule = {
  id: 'dupe.group',
  class: 'duplicate',
  requires: ['jellyfin'],
  run(ctx: RuleContext): Finding[] {
    const links = DUPE_RULES.flatMap((matcher) => {
      // A matcher whose extra sources are absent contributes nothing rather than failing the group rule.
      if (unavailableReason(ctx, matcher)) return []
      try { return matcher.link(ctx) } catch { return [] }
    })
    const groups = buildDupeGroups(links)
    if (!groups.length) return []

    const findings: Finding[] = []
    for (const group of groups) {
      const placeholders = group.memberIds.map(() => '?').join(',')
      const rows = ctx.db.prepare(`SELECT id, name, container_path, size_bytes, height, bitrate,
        video_codec, audio_channels, library_name FROM jellyfin_items WHERE id IN (${placeholders})`)
        .all(...group.memberIds) as MemberRow[]
      if (rows.length < 2) continue

      const facts: MemberFacts[] = rows.map((r) => ({
        itemId: r.id,
        height: r.height,
        bitrate: r.bitrate,
        videoCodec: r.video_codec,
        audioChannels: r.audio_channels,
        isHdr: (r.video_codec ?? '').toLowerCase().includes('hevc') && (r.height ?? 0) >= 2160,
        hasSubtitles: false,
        sizeBytes: r.size_bytes,
      }))
      const { keeperId, scores } = pickKeeper(facts, DEFAULT_KEEPER_WEIGHTS)

      const subjects: Subject[] = rows.map((r) => ({
        kind: 'item', id: r.id, label: r.name, path: r.container_path ?? undefined,
      }))
      const reclaimable = rows
        .filter((r) => r.id !== keeperId)
        .reduce((sum, r) => sum + (r.size_bytes ?? 0), 0)

      const evidence: DupeGroupEvidence = {
        groupId: group.id,
        keeperId,
        scores,
        matchedBy: [...new Set(group.links.map((l) => l.ruleId))],
        links: group.links,
        crossLibrary: new Set(rows.map((r) => r.library_name)).size > 1,
      }

      findings.push({
        id: findingId('dupe.group', group.memberIds),
        ruleId: 'dupe.group',
        class: 'duplicate',
        severity: group.tier === 'exact' ? 'warning' : 'info',
        confidence: group.tier,
        subjects,
        evidence,
        reclaimableBytes: reclaimable,
        status: 'open',
        firstSeen: ctx.now,
        lastSeen: ctx.now,
      })
    }
    return findings
  },

  persist(ctx: RuleContext, findings: Finding[]): void {
    // Full replace: dupe_groups mirrors exactly this pass's groups. A group that no longer forms
    // (because a duplicate was deleted, or its links stopped matching) simply isn't among
    // `findings` and its old row is dropped along with everyone else's, in the same DELETE.
    ctx.db.prepare('DELETE FROM dupe_groups').run()
    const insertGroup = ctx.db.prepare(
      'INSERT OR REPLACE INTO dupe_groups (id, tier, members_json, keeper_item_id, scores_json, status) VALUES (?,?,?,?,?,?)',
    )
    for (const f of findings) {
      if (f.ruleId !== 'dupe.group') continue
      const evidence = f.evidence as DupeGroupEvidence
      const memberIds = f.subjects
        .filter((s): s is Extract<Subject, { kind: 'item' }> => s.kind === 'item')
        .map((s) => s.id)
      insertGroup.run(
        evidence.groupId,
        f.confidence,
        JSON.stringify(memberIds),
        evidence.keeperId,
        JSON.stringify(evidence.scores),
        'open',
      )
    }
  },

  /**
   * `dupe.group` is the only registered `Rule` for all six duplicate matchers, so without this,
   * `rule_runs` can never distinguish "dupe.identical-file ran and found nothing" from "hashing is
   * off, dupe.identical-file never ran" — the exact ambiguity `rule_runs` exists to prevent. One
   * entry per matcher, using the same `unavailableReason` judgement `run()` itself acts on, so the
   * two can't disagree; an available matcher reports the number of links it actually produced.
   */
  subRuns(ctx: RuleContext): SubRun[] {
    return DUPE_RULES.map((matcher): SubRun => {
      const reason = unavailableReason(ctx, matcher)
      if (reason) return { ruleId: matcher.id, status: 'not-evaluated', reason }
      try {
        return { ruleId: matcher.id, status: 'evaluated', found: matcher.link(ctx).length }
      } catch (err) {
        return { ruleId: matcher.id, status: 'not-evaluated', reason: `matcher threw: ${(err as Error).message}` }
      }
    })
  },
}
