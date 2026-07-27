import type { Phase, PhaseResult } from './types.js'
import { describeError } from './types.js'
import type { ArrClient } from '../../connectors/arr.js'

export const arrPhase: Phase = {
  name: 'arr',
  async run(ctx): Promise<PhaseResult> {
    const clients: Array<[string, ArrClient]> = []
    if (ctx.deps.radarr) clients.push(['radarr', ctx.deps.radarr])
    if (ctx.deps.sonarr) clients.push(['sonarr', ctx.deps.sonarr])
    if (!clients.length) return { status: 'skipped', reason: 'radarr and sonarr are not configured', counts: {} }

    const insert = ctx.db.prepare(`INSERT OR REPLACE INTO arr_records (
      id, kind, instance, remote_id, title, arr_path, container_path, monitored,
      series_id, episode_id, episode_file_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)

    let written = 0
    let unmapped = 0
    const problems: string[] = []

    for (const [label, client] of clients) {
      if (ctx.signal.aborted) return { status: 'cancelled', counts: { records: written, unmapped } }
      let records
      try {
        records = await client.inventory()
      } catch (err) {
        problems.push(`${label}: ${describeError(err)}`)
        continue
      }
      const write = ctx.db.transaction(() => {
        // Wholesale replace per instance: this is a full inventory fetch, so anything not
        // in it is gone. Scoped to the instance so one *arr being down cannot wipe the other.
        ctx.db.prepare('DELETE FROM arr_records WHERE kind = ? AND instance = ?').run(label, label)
        for (const r of records) {
          // NULL, never the raw *arr path as a stand-in. `container_path` is what joins these
          // records to fs_entries and jellyfin_items; an *arr-side path written into it looks
          // authoritative and joins to nothing, so the record silently stops matching the file it
          // describes. NULL says "not translatable", which is the truth, and the tally below says
          // how often — so a degraded map is distinguishable from an *arr with nothing in it.
          const containerPath = r.arrPath ? ctx.deps.pathMap.toContainer(r.arrPath) : null
          if (r.arrPath && containerPath === null) unmapped += 1
          insert.run(
            `${r.kind}:${r.instance}:${r.remoteId}`, r.kind, r.instance, r.remoteId, r.title,
            r.arrPath, containerPath,
            r.monitored ? 1 : 0, r.seriesId, r.episodeId, r.episodeFileId,
          )
          written += 1
        }
      })
      write()
    }

    if (problems.length === clients.length) {
      return { status: 'skipped', reason: problems.join('; '), counts: { records: written, unmapped } }
    }
    return { status: 'completed', counts: { records: written, unmapped } }
  },
}
