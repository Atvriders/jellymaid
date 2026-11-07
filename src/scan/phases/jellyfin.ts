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
      video_codec, audio_codec, audio_channels, width, height, bitrate, video_range, has_subtitles,
      has_primary_image, library_id, library_name, date_created, media_source_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    // One row per physical file behind an item (see 003_jellyfin_item_paths.sql) — every
    // MediaSources[] path, not just the primary `jf_path` already carried on jellyfin_items.
    // Keyed on (item_id, jf_path): an item legitimately has more than one path once versions are
    // merged.
    const insertPath = ctx.db.prepare(`INSERT OR REPLACE INTO jellyfin_item_paths
      (item_id, scan_id, jf_path, container_path) VALUES (?,?,?,?)`)

    let libraryByLocation: Array<{ id: string; name: string; location: string }> = []
    try {
      const folders = await jf.virtualFolders()
      libraryByLocation = folders.flatMap((f) => f.locations.map((l) => ({ id: f.id, name: f.name, location: l })))
        .sort((a, b) => b.location.length - a.location.length)
    } catch (err) {
      return { status: 'skipped', reason: describeError(err), counts: {} }
    }

    let startIndex = typeof ctx.cursor.startIndex === 'number' ? ctx.cursor.startIndex : 0
    // The total the FIRST page of this scan reported. An earlier, since-cancelled attempt at THIS
    // scan saved it in the cursor, so a resume compares against what the scan started with, not
    // against whatever its own first page says after the gap. A cursor saved before `firstTotal`
    // existed only has `total`, the last page's count — the best record of the start it has.
    const carriedTotal = typeof ctx.cursor.firstTotal === 'number' ? ctx.cursor.firstTotal
      : typeof ctx.cursor.total === 'number' ? ctx.cursor.total : null
    let firstTotal = carriedTotal
    let written = 0
    let unmapped = 0
    let total: number | null = null

    const writeBatch = ctx.db.transaction((rows: unknown[][], pathRows: unknown[][]) => {
      for (const r of rows) insert.run(...r)
      for (const r of pathRows) insertPath.run(...r)
    })

    while (true) {
      if (ctx.signal.aborted) return { status: 'cancelled', counts: { items: written, unmapped } }
      let page
      try {
        page = await jf.items({ startIndex, limit: PAGE })
      } catch (err) {
        return { status: 'skipped', reason: describeError(err), counts: { items: written, unmapped } }
      }
      total = page.totalRecordCount
      if (firstTotal === null) firstTotal = total
      if (!page.items.length) break

      const rows: unknown[][] = []
      const pathRows: unknown[][] = []
      for (const i of page.items) {
        const lib = i.jfPath ? libraryByLocation.find((l) => i.jfPath!.startsWith(l.location)) : undefined

        // Every DISTINCT jf_path behind this item, translated exactly once. `mediaSourcePaths`
        // deliberately includes the primary source (see the connector), so for an ordinary
        // single-version item `jfPath` and its one media source are usually the identical string.
        // Translating that string twice — once here, once again inside a second loop over
        // `mediaSourcePaths` — would count one real unmapped file as two. Building the distinct
        // set up front and translating each member once, rather than skipping only the "is this
        // literally the primary" case, also gets a merged item's genuinely-repeated alternate
        // paths right without needing a second special case.
        const distinctPaths = new Set<string>()
        if (i.jfPath) distinctPaths.add(i.jfPath)
        // Test doubles built directly (not through the real connector) may omit this field
        // entirely; treat absent exactly like empty rather than throwing on `undefined`.
        for (const p of i.mediaSourcePaths ?? []) distinctPaths.add(p)

        // An item Jellyfin gave a path for that no mapping covers lands here with a NULL
        // container_path — indistinguishable, downstream, from an item that never had a path at
        // all (a Series or Season row). Counted so Plans 3-4 can tell a degraded index from an
        // empty one. Items with no jfPath are not counted: there was nothing to translate.
        const containerPathByJfPath = new Map<string, string | null>()
        for (const p of distinctPaths) {
          const resolved = ctx.deps.pathMap.toContainer(p)
          containerPathByJfPath.set(p, resolved)
          if (resolved === null) unmapped += 1
        }

        const containerPath = i.jfPath ? containerPathByJfPath.get(i.jfPath)! : null
        rows.push([
          i.id, ctx.scanId, i.type, i.name, i.sortName, i.year, i.seriesId, i.seriesName, i.seasonNo, i.episodeNo,
          JSON.stringify(i.providerIds), i.jfPath, containerPath,
          i.sizeBytes, i.runtimeTicks, i.container, i.videoCodec, i.audioCodec, i.audioChannels,
          i.width, i.height, i.bitrate,
          // Both are real reported signals or nothing at all — see 004_item_quality_signals.sql.
          // A test double (or an older Jellyfin) that omits videoRange stores NULL rather than a
          // codec-derived guess, and the keeper score reads NULL as "no HDR evidence", not "HDR".
          i.videoRange ?? null, i.hasSubtitles ? 1 : 0,
          i.hasPrimaryImage ? 1 : 0,
          lib?.id ?? null, lib?.name ?? null, i.dateCreated, i.mediaSourceId,
        ])
        for (const jfPath of i.mediaSourcePaths ?? []) {
          pathRows.push([i.id, ctx.scanId, jfPath, containerPathByJfPath.get(jfPath)!])
        }
      }
      writeBatch(rows, pathRows)
      written += rows.length
      startIndex += page.items.length
      ctx.saveCursor({ startIndex, total, firstTotal })
      ctx.progress(written, total)
      if (startIndex >= total) break
    }

    // The sweep is a wholesale DELETE of everything this scan did not write, so it may only run
    // on a provably COMPLETE fetch. A short page — what a restarting or mid-library-scan Jellyfin
    // returns — is "couldn't check", not "checked and found nothing"; sweeping on it erases the
    // entire item snapshot and makes every media file on disk read as an orphan. total === 0 is
    // deliberately not complete either: an empty library and a Jellyfin that has not finished
    // starting look identical from here, and only one of them justifies deleting the snapshot.
    if (ctx.signal.aborted) return { status: 'cancelled', counts: { items: written, unmapped } }

    // Counted in the table, not in this attempt's memory: a resumed attempt's predecessor wrote
    // its pages under this same scan_id, and they are part of the same pass. The primary key is
    // the item id, so an item served twice is one row.
    const unique = (ctx.db.prepare('SELECT COUNT(*) c FROM jellyfin_items WHERE scan_id = ?').get(ctx.scanId) as { c: number }).c

    if (total === null || total <= 0) {
      return {
        status: 'skipped',
        reason: `jellyfin returned ${unique} of ${total ?? 'an unknown number of'} items; index left intact`,
        counts: { items: written, unmapped },
      }
    }

    // Paging by offset is only a complete read of a library that held still. An item added or
    // removed mid-pass shifts every item after it by one place, so a page boundary repeats one
    // item and skips another — and which ones depends on the server's sort order, which this
    // phase does not get to assume. The offset can still reach the total, so reaching it proves
    // nothing. Two things must hold instead: the count did not move between the first page and
    // the last (across a resume too), and the distinct items this scan wrote are exactly that
    // count.
    if (firstTotal !== total) {
      const resumed = carriedTotal !== null ? ' (this scan was resumed in between)' : ''
      return {
        status: 'skipped',
        reason: `jellyfin's item count changed from ${firstTotal} to ${total} while it was being paged${resumed}; items may have shifted between pages, so the index was left intact`,
        counts: { items: written, unmapped },
      }
    }
    if (unique !== total) {
      return {
        status: 'skipped',
        reason: `jellyfin returned ${unique} of ${total} items (counted by unique id); index left intact`,
        counts: { items: written, unmapped },
      }
    }

    // Items Jellyfin no longer returns were removed from the library; drop their rows so
    // the duplicate and metadata rules do not reason about entries that no longer exist.
    //
    // Both deletes run inside ONE transaction, not as two independent autocommit statements: a
    // crash between them would otherwise leave jellyfin_item_paths rows whose parent item is
    // already gone — exactly the "path present, item absent" shape that would make an orphaned
    // file's path still resolve via jellyfin_item_paths and suppress a genuine fs.orphan-media
    // finding until the next fully-completed scan swept it too. The gate above already licenses
    // sweeping both tables together (same completeness checks, no second licence); this
    // just makes the two deletes land together as well, restoring the single-statement atomicity
    // that existed before jellyfin_item_paths was introduced.
    const { stale, deletedPathsCleared } = ctx.db.transaction(() => {
      const changes = ctx.db.prepare('DELETE FROM jellyfin_items WHERE scan_id != ?').run(ctx.scanId).changes
      ctx.db.prepare('DELETE FROM jellyfin_item_paths WHERE scan_id != ?').run(ctx.scanId)
      // A plan records every path it deletes in deleted_paths, and the Duplicates list hides those
      // members until Jellyfin itself has forgotten them (it drops an item about a minute after
      // the path notification). Both tables now hold exactly what Jellyfin lists, so a recorded
      // path in neither is one Jellyfin has forgotten, and its row has done its job. Licensed by
      // the same complete pass as the sweep: on a partial pass, "not listed" may only mean "not
      // reached yet", and clearing the row would bring the deleted copy back into the list.
      const cleared = ctx.db.prepare(`DELETE FROM deleted_paths
        WHERE NOT EXISTS (SELECT 1 FROM jellyfin_items i WHERE i.container_path = deleted_paths.container_path)
          AND NOT EXISTS (SELECT 1 FROM jellyfin_item_paths p WHERE p.container_path = deleted_paths.container_path)`)
        .run().changes
      return { stale: changes, deletedPathsCleared: cleared }
    })()
    return { status: 'completed', counts: { items: written, stale, unmapped, deletedPathsCleared } }
  },
}
