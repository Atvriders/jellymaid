import type { Phase, PhaseContext, PhaseName, PhaseResult } from './types.js'
import type { Db } from '../../index/db.js'
import { runRules } from '../../rules/runner.js'
import type { SourceName, SourceReasons } from '../../rules/types.js'

/** The phase that observes each source, and the table its observation lands in. */
const SOURCE_PHASES: Record<Exclude<SourceName, 'hashes'>, { phase: PhaseName; table: string }> = {
  jellyfin: { phase: 'jellyfin', table: 'jellyfin_items' },
  filesystem: { phase: 'filesystem', table: 'fs_entries' },
  qbittorrent: { phase: 'qbittorrent', table: 'torrents' },
  arr: { phase: 'arr', table: 'arr_records' },
}

function describePhase(phase: PhaseName, result: PhaseResult | undefined): string {
  if (!result) return `the ${phase} phase did not run in this scan`
  const detail = result.reason ? `: ${result.reason}` : ''
  return `the ${phase} phase ${result.status}${detail}`
}

export interface SourceAvailability {
  sources: Set<SourceName>
  reasons: SourceReasons
}

/**
 * Which sources this scan may be trusted to have OBSERVED — deliberately not "which tables have
 * rows in them".
 *
 * Row count alone is the wrong question, and dangerously so. A phase that skipped (Jellyfin
 * unreachable, a library root unreadable) is still pushed onto the orchestrator's `completed` list
 * and the rules phase still runs; and by design a phase only sweeps its table on a COMPLETE
 * observation, so a skipped phase leaves the PREVIOUS scan's rows exactly where they were. Judged
 * by `COUNT(*) > 0` those stale rows look like a fresh, authoritative snapshot. Feed that to
 * `fs.orphan-media` — whose whole job is "this file is on disk and Jellyfin has never heard of it"
 * — and any file imported into Jellyfin since the last successful sweep is reported as an orphan,
 * at full size reclaimable, on the strength of a snapshot that predates it. Plan 4 turns those
 * findings into a delete queue. "Couldn't check" must never render as "checked and found nothing".
 *
 * So a source counts as available only when BOTH hold:
 *  - its phase reported `completed` in THIS scan (skipped/cancelled/never-ran all disqualify it,
 *    no matter how full the table is), and
 *  - the table actually holds rows (a completed phase that observed an empty source genuinely has
 *    nothing for a rule to reason about).
 *
 * `hashes` is not a phase of its own: it is a property of the filesystem observation, so it needs
 * the filesystem phase to have completed AND at least one row to actually carry a `quick_hash`
 * (hashing is opt-in per root, so a perfectly complete filesystem phase can legitimately produce
 * none).
 *
 * Every unavailable source carries the reason it is unavailable, naming the phase and repeating
 * what that phase said, so the `rule_runs` row an operator reads says "the jellyfin phase skipped:
 * unreachable" rather than the bare word "jellyfin".
 */
export function availableSources(
  db: Db,
  priorResults: Partial<Record<PhaseName, PhaseResult>>,
): SourceAvailability {
  const rowCount = (table: string) =>
    (db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c

  const sources = new Set<SourceName>()
  const reasons: SourceReasons = {}

  for (const [source, { phase, table }] of Object.entries(SOURCE_PHASES) as Array<
    [Exclude<SourceName, 'hashes'>, { phase: PhaseName; table: string }]
  >) {
    const result = priorResults[phase]
    if (result?.status !== 'completed') {
      reasons[source] = describePhase(phase, result)
      continue
    }
    if (rowCount(table) === 0) {
      reasons[source] = `the ${phase} phase completed but ${table} is empty`
      continue
    }
    sources.add(source)
  }

  const fsResult = priorResults.filesystem
  if (fsResult?.status !== 'completed') {
    reasons.hashes = describePhase('filesystem', fsResult)
  } else if ((db.prepare(
    'SELECT COUNT(*) c FROM fs_entries WHERE quick_hash IS NOT NULL',
  ).get() as { c: number }).c === 0) {
    reasons.hashes = 'no fs_entries row has a quick_hash yet — hashing is disabled or has not completed'
  } else {
    sources.add('hashes')
  }

  return { sources, reasons }
}

export const rulesPhase: Phase = {
  name: 'rules',
  async run(ctx: PhaseContext): Promise<PhaseResult> {
    const availability = availableSources(ctx.db, ctx.priorResults)
    const summary = runRules({
      db: ctx.db,
      config: ctx.deps.config,
      scanId: ctx.scanId,
      availableSources: availability.sources,
      sourceReasons: availability.reasons,
    })
    return {
      status: 'completed',
      counts: {
        created: summary.created,
        resolved: summary.resolved,
        reopened: summary.reopened,
        notEvaluated: summary.notEvaluated.length,
      },
    }
  },
}
