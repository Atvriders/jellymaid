import type { Phase } from './types.js'
import type { Db } from '../../index/db.js'
import { runRules } from '../../rules/runner.js'
import type { SourceName } from '../../rules/types.js'

/** Sources are derived from what actually landed in the index, not from what was configured. */
function availableSources(db: Db): Set<SourceName> {
  const has = (sql: string) => (db.prepare(sql).get() as { c: number }).c > 0
  const sources = new Set<SourceName>()
  if (has('SELECT COUNT(*) c FROM jellyfin_items')) sources.add('jellyfin')
  if (has('SELECT COUNT(*) c FROM fs_entries')) sources.add('filesystem')
  if (has('SELECT COUNT(*) c FROM torrents')) sources.add('qbittorrent')
  if (has('SELECT COUNT(*) c FROM arr_records')) sources.add('arr')
  if (has('SELECT COUNT(*) c FROM fs_entries WHERE quick_hash IS NOT NULL')) sources.add('hashes')
  return sources
}

export const rulesPhase: Phase = {
  name: 'rules',
  async run(ctx) {
    const summary = runRules({
      db: ctx.db,
      config: ctx.deps.config,
      scanId: ctx.scanId,
      availableSources: availableSources(ctx.db),
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
