import type { Phase, PhaseResult } from './types.js'
import { describeError } from './types.js'

const PAGE = 500

export const jellyfinPhase: Phase = {
  name: 'jellyfin',
  async run(ctx): Promise<PhaseResult> {
    const jf = ctx.deps.jellyfin
    if (!jf) return { status: 'skipped', reason: 'jellyfin client not configured', counts: {} }

    const insert = ctx.db.prepare(`INSERT OR REPLACE INTO jellyfin_items (
      id, scan_id, type, name, sort_name, year, series_id, series_name, season_no, episode_no,
      provider_ids_json, jf_path, container_path, size_bytes, runtime_ticks, container,
      video_codec, audio_codec, audio_channels, width, height, bitrate, has_primary_image,
      library_id, library_name, date_created, media_source_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)

    let libraryByLocation: Array<{ id: string; name: string; location: string }> = []
    try {
      const folders = await jf.virtualFolders()
      libraryByLocation = folders.flatMap((f) => f.locations.map((l) => ({ id: f.id, name: f.name, location: l })))
        .sort((a, b) => b.location.length - a.location.length)
    } catch (err) {
      return { status: 'skipped', reason: describeError(err), counts: {} }
    }

    let startIndex = typeof ctx.cursor.startIndex === 'number' ? ctx.cursor.startIndex : 0
    let written = 0
    let unmapped = 0
    let total: number | null = null

    const writeBatch = ctx.db.transaction((rows: unknown[][]) => { for (const r of rows) insert.run(...r) })

    while (true) {
      if (ctx.signal.aborted) return { status: 'cancelled', counts: { items: written, unmapped } }
      let page
      try {
        page = await jf.items({ startIndex, limit: PAGE })
      } catch (err) {
        return { status: 'skipped', reason: describeError(err), counts: { items: written, unmapped } }
      }
      total = page.totalRecordCount
      if (!page.items.length) break

      const rows = page.items.map((i) => {
        const lib = i.jfPath ? libraryByLocation.find((l) => i.jfPath!.startsWith(l.location)) : undefined
        // An item Jellyfin gave a path for that no mapping covers lands here with a NULL
        // container_path — indistinguishable, downstream, from an item that never had a path at
        // all (a Series or Season row). Counted so Plans 3-4 can tell a degraded index from an
        // empty one. Items with no jfPath are not counted: there was nothing to translate.
        let containerPath: string | null = null
        if (i.jfPath) {
          containerPath = ctx.deps.pathMap.toContainer(i.jfPath)
          if (containerPath === null) unmapped += 1
        }
        return [
          i.id, ctx.scanId, i.type, i.name, i.sortName, i.year, i.seriesId, i.seriesName, i.seasonNo, i.episodeNo,
          JSON.stringify(i.providerIds), i.jfPath, containerPath,
          i.sizeBytes, i.runtimeTicks, i.container, i.videoCodec, i.audioCodec, i.audioChannels,
          i.width, i.height, i.bitrate, i.hasPrimaryImage ? 1 : 0,
          lib?.id ?? null, lib?.name ?? null, i.dateCreated, i.mediaSourceId,
        ]
      })
      writeBatch(rows)
      written += rows.length
      startIndex += page.items.length
      ctx.saveCursor({ startIndex })
      ctx.progress(written, total)
      if (startIndex >= total) break
    }

    // `startIndex`, not `written`: on a resumed scan it already carries the offset the earlier
    // attempt reached, and that attempt's rows carry THIS scan_id, so they are part of the same
    // snapshot. Measuring completeness by `written` alone would under-count a resume and refuse
    // an otherwise legitimate sweep.
    const fetched = startIndex

    // The sweep is a wholesale DELETE of everything this scan did not write, so it may only run
    // on a provably COMPLETE fetch. A short page — what a restarting or mid-library-scan Jellyfin
    // returns — is "couldn't check", not "checked and found nothing"; sweeping on it erases the
    // entire item snapshot and makes every media file on disk read as an orphan. total === 0 is
    // deliberately not complete either: an empty library and a Jellyfin that has not finished
    // starting look identical from here, and only one of them justifies deleting the snapshot.
    if (ctx.signal.aborted) return { status: 'cancelled', counts: { items: written, unmapped } }
    if (total === null || total <= 0 || fetched < total) {
      return {
        status: 'skipped',
        reason: `jellyfin returned ${fetched} of ${total ?? 'an unknown number of'} items; index left intact`,
        counts: { items: written, unmapped },
      }
    }

    // Items Jellyfin no longer returns were removed from the library; drop their rows so
    // the duplicate and metadata rules do not reason about entries that no longer exist.
    const stale = ctx.db.prepare('DELETE FROM jellyfin_items WHERE scan_id != ?').run(ctx.scanId).changes
    return { status: 'completed', counts: { items: written, stale, unmapped } }
  },
}
