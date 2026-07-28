import type { Finding, Subject } from '../../core/types.js'
import { findingId } from '../../core/types.js'
import type { Rule, RuleContext } from '../types.js'
import { DUPE_RULES } from './index.js'
import { buildDupeGroups } from '../grouping.js'
import { DEFAULT_KEEPER_WEIGHTS, pickKeeper, type MemberFacts } from '../keeper.js'

interface MemberRow {
  id: string; name: string; container_path: string | null; size_bytes: number | null
  height: number | null; bitrate: number | null; video_codec: string | null
  audio_channels: number | null; library_name: string | null
}

function hasHashes(ctx: RuleContext): boolean {
  const row = ctx.db.prepare('SELECT COUNT(*) c FROM fs_entries WHERE quick_hash IS NOT NULL').get() as { c: number }
  return row.c > 0
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
 * and `confidence`/`subjects`, and `persist()` below — which the runner calls separately, only
 * after `run()` has already succeeded and query_only is back off — reads it back out of those
 * findings and writes `dupe_groups` from them. No second pass over the database, no recomputation:
 * `persist()` is a pure reshape of what `run()` already produced.
 */
export const dupeGroupRule: Rule = {
  id: 'dupe.group',
  class: 'duplicate',
  requires: ['jellyfin'],
  run(ctx: RuleContext): Finding[] {
    const links = DUPE_RULES.flatMap((rule) => {
      // A matcher whose extra sources are absent contributes nothing rather than failing the group rule.
      if (rule.requires.includes('hashes') && !hasHashes(ctx)) return []
      try { return rule.link(ctx) } catch { return [] }
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

      findings.push({
        id: findingId('dupe.group', group.memberIds),
        ruleId: 'dupe.group',
        class: 'duplicate',
        severity: group.tier === 'exact' ? 'warning' : 'info',
        confidence: group.tier,
        subjects,
        evidence: {
          groupId: group.id,
          keeperId,
          scores,
          matchedBy: [...new Set(group.links.map((l) => l.ruleId))],
          links: group.links,
          crossLibrary: new Set(rows.map((r) => r.library_name)).size > 1,
        },
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
      const memberIds = f.subjects
        .filter((s): s is Extract<Subject, { kind: 'item' }> => s.kind === 'item')
        .map((s) => s.id)
      insertGroup.run(
        f.evidence.groupId,
        f.confidence,
        JSON.stringify(memberIds),
        f.evidence.keeperId,
        JSON.stringify(f.evidence.scores),
        'open',
      )
    }
  },
}
