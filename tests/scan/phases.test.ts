import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../src/index/db.js'
import { jellyfinPhase } from '../../src/scan/phases/jellyfin.js'
import { filesystemPhase } from '../../src/scan/phases/filesystem.js'
import { qbittorrentPhase } from '../../src/scan/phases/qbittorrent.js'
import { arrPhase } from '../../src/scan/phases/arr.js'
import { createPathMap } from '../../src/fs/pathmap.js'
import { fileConfigSchema } from '../../src/config/schema.js'
import type { PhaseContext } from '../../src/scan/phases/types.js'

let db: Db
let dir: string

function ctx(
  deps: Partial<PhaseContext['deps']>,
  cursor: Record<string, unknown> = {},
  over: Partial<Pick<PhaseContext, 'signal' | 'saveCursor' | 'progress' | 'scanId'>> = {},
): PhaseContext {
  let saved = cursor
  return {
    db, scanId: over.scanId ?? 1, cursor: saved, signal: over.signal ?? new AbortController().signal,
    priorResults: {},
    saveCursor: over.saveCursor ?? ((c) => { saved = c }),
    progress: over.progress ?? (() => {}),
    deps: {
      config: fileConfigSchema.parse({}),
      pathMap: createPathMap([]),
      jellyfin: null, qbittorrents: new Map(), radarr: null, sonarr: null,
      hasher: null,
      ...deps,
    } as PhaseContext['deps'],
  }
}

/** One qBittorrent instance, 'box-a', serving the given double. */
const one = (client: Record<string, unknown>, id = 'box-a') => new Map([[id, { instanceId: id, ...client }]]) as never

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jm-phase-'))
  db = openDb(join(dir, 'db.sqlite'))
  db.prepare("INSERT INTO scans (id, started_at, status) VALUES (1, 't', 'running')").run()
})

describe('jellyfinPhase', () => {
  const pages = (total: number) => ({
    items: async ({ startIndex, limit }: { startIndex: number; limit: number }) => ({
      totalRecordCount: total,
      items: Array.from({ length: Math.max(0, Math.min(limit, total - startIndex)) }, (_v, i) => ({
        id: `i${startIndex + i}`, type: 'Movie', name: `M${startIndex + i}`, sortName: null, year: 2000,
        seriesId: null, seriesName: null, seasonNo: null, episodeNo: null,
        providerIds: { tmdb: String(startIndex + i) }, jfPath: `/media/Movies/M${startIndex + i}.mkv`,
        sizeBytes: 10, runtimeTicks: 1, container: 'mkv', videoCodec: 'h264', audioCodec: 'aac',
        audioChannels: 2, width: 1920, height: 1080, bitrate: 100, hasPrimaryImage: true,
        dateCreated: null, mediaSourceId: 'ms',
      })),
    }),
    virtualFolders: async () => [{ id: 'lib1', name: 'Movies', collectionType: 'movies', locations: ['/media/Movies'] }],
  })

  it('writes every item and records the total', async () => {
    const c = ctx({ jellyfin: pages(5) as never })
    const res = await jellyfinPhase.run(c)
    expect(res.status).toBe('completed')
    expect(db.prepare('SELECT COUNT(*) c FROM jellyfin_items').get()).toEqual({ c: 5 })
  })

  it('translates jellyfin paths to container paths using the map', async () => {
    const c = ctx({
      jellyfin: pages(1) as never,
      pathMap: createPathMap([{ role: 'library', jellyfin: '/media/Movies', container: '/mnt/m', qbit: null, qbitInstance: null }]),
    })
    await jellyfinPhase.run(c)
    const row = db.prepare('SELECT container_path FROM jellyfin_items').get() as { container_path: string }
    expect(row.container_path).toBe('/mnt/m/M0.mkv')
  })

  it('stores the reported video range and subtitle presence, and NULL rather than a guess when the range is absent', async () => {
    const jf = {
      virtualFolders: async () => [],
      items: async () => ({
        totalRecordCount: 2,
        items: [
          {
            id: 'hdr', type: 'Movie', name: 'H', sortName: null, year: 2000, seriesId: null, seriesName: null,
            seasonNo: null, episodeNo: null, providerIds: {}, jfPath: '/media/Movies/H.mkv',
            mediaSourcePaths: [], sizeBytes: 1, runtimeTicks: 1, container: 'mkv', videoCodec: 'hevc',
            audioCodec: 'aac', audioChannels: 2, width: 3840, height: 2160, bitrate: 1,
            videoRange: 'HDR10', hasSubtitles: true, hasPrimaryImage: true, dateCreated: null, mediaSourceId: 'm',
          },
          {
            id: 'unknown', type: 'Movie', name: 'U', sortName: null, year: 2000, seriesId: null, seriesName: null,
            seasonNo: null, episodeNo: null, providerIds: {}, jfPath: '/media/Movies/U.mkv',
            mediaSourcePaths: [], sizeBytes: 1, runtimeTicks: 1, container: 'mkv', videoCodec: 'hevc',
            audioCodec: 'aac', audioChannels: 2, width: 3840, height: 2160, bitrate: 1,
            videoRange: null, hasSubtitles: false, hasPrimaryImage: true, dateCreated: null, mediaSourceId: 'm',
          },
        ],
      }),
    }
    await jellyfinPhase.run(ctx({ jellyfin: jf as never }))
    const rows = db.prepare('SELECT id, video_range, has_subtitles FROM jellyfin_items ORDER BY id').all() as
      Array<{ id: string; video_range: string | null; has_subtitles: number }>
    expect(rows).toEqual([
      { id: 'hdr', video_range: 'HDR10', has_subtitles: 1 },
      { id: 'unknown', video_range: null, has_subtitles: 0 },
    ])
  })

  it('skips with a reason when jellyfin is unreachable, and writes no rows', async () => {
    const c = ctx({ jellyfin: { virtualFolders: async () => { throw Object.assign(new Error('x'), { kind: 'unreachable' }) } } as never })
    const res = await jellyfinPhase.run(c)
    expect(res.status).toBe('skipped')
    expect(res.reason).toMatch(/unreachable/)
    expect(db.prepare('SELECT COUNT(*) c FROM jellyfin_items').get()).toEqual({ c: 0 })
  })

  it('resumes from a saved startIndex instead of refetching page one', async () => {
    const seen: number[] = []
    const jf = {
      virtualFolders: async () => [],
      items: async ({ startIndex, limit }: { startIndex: number; limit: number }) => {
        seen.push(startIndex)
        return { totalRecordCount: 4, items: Array.from({ length: Math.max(0, Math.min(limit, 4 - startIndex)) }, (_v, i) => ({
          id: `r${startIndex + i}`, type: 'Movie', name: 'x', sortName: null, year: null,
          seriesId: null, seriesName: null, seasonNo: null, episodeNo: null, providerIds: {},
          jfPath: null, sizeBytes: null, runtimeTicks: null, container: null, videoCodec: null,
          audioCodec: null, audioChannels: null, width: null, height: null, bitrate: null,
          hasPrimaryImage: false, dateCreated: null, mediaSourceId: null,
        })) }
      },
    }
    await jellyfinPhase.run(ctx({ jellyfin: jf as never }, { startIndex: 2 }))
    expect(seen[0]).toBe(2)
  })

  /** Mirrors what an earlier scan left behind, so a sweep is observable in both directions. */
  const seedPriorItem = (id = 'old') => {
    db.prepare(`INSERT INTO jellyfin_items (id, scan_id, type, name, jf_path, container_path)
                VALUES (?,?,?,?,?,?)`).run(id, 0, 'Movie', 'Old', '/media/Movies/Old.mkv', '/mnt/m/Old.mkv')
  }

  it('does not sweep — and reports skipped — when the first page comes back empty but the library reports items', async () => {
    // What a restarting or mid-library-scan Jellyfin does: reachable, honest about its total,
    // but not yet serving items. Sweeping here erases the whole snapshot and makes every media
    // file on disk read as an orphan.
    seedPriorItem()
    const jf = {
      virtualFolders: async () => [],
      items: async () => ({ totalRecordCount: 50_000, items: [] }),
    }
    const res = await jellyfinPhase.run(ctx({ jellyfin: jf as never }))
    expect(res.status).toBe('skipped')
    expect(res.reason).toMatch(/0 of 50000/)
    expect(db.prepare('SELECT COUNT(*) c FROM jellyfin_items').get()).toEqual({ c: 1 })
    expect(res.counts.stale ?? 0).toBe(0)
  })

  it('does not sweep when the pager stops short of totalRecordCount', async () => {
    seedPriorItem()
    let call = 0
    const jf = {
      virtualFolders: async () => [],
      items: async () => {
        call += 1
        return call === 1
          ? { totalRecordCount: 10, items: [{
              id: 'a', type: 'Movie', name: 'A', sortName: null, year: null, seriesId: null,
              seriesName: null, seasonNo: null, episodeNo: null, providerIds: {}, jfPath: null,
              sizeBytes: null, runtimeTicks: null, container: null, videoCodec: null, audioCodec: null,
              audioChannels: null, width: null, height: null, bitrate: null, hasPrimaryImage: false,
              dateCreated: null, mediaSourceId: null,
            }] }
          : { totalRecordCount: 10, items: [] }
      },
    }
    const res = await jellyfinPhase.run(ctx({ jellyfin: jf as never }))
    expect(res.status).toBe('skipped')
    expect(res.reason).toMatch(/1 of 10/)
    // The one item it did return is still indexed; the prior snapshot is left intact alongside it.
    expect(db.prepare('SELECT COUNT(*) c FROM jellyfin_items').get()).toEqual({ c: 2 })
  })

  it('counts items whose path no mapping covers, rather than leaving a silent NULL', async () => {
    // A NULL container_path is indistinguishable from a Series/Season row that never had a path.
    // Plans 3-4 need to tell a degraded index from an empty one.
    const res = await jellyfinPhase.run(ctx({
      jellyfin: pages(2) as never,
      pathMap: createPathMap([{ role: 'library', jellyfin: '/somewhere-else', container: '/mnt/x', qbit: null, qbitInstance: null }]),
    }))
    expect(res.counts.unmapped).toBe(2)
    expect(db.prepare('SELECT COUNT(*) c FROM jellyfin_items WHERE container_path IS NULL').get()).toEqual({ c: 2 })
  })

  it('sweeps prior-scan rows only once the whole library has actually been fetched', async () => {
    seedPriorItem()
    const res = await jellyfinPhase.run(ctx({ jellyfin: pages(3) as never }))
    expect(res.status).toBe('completed')
    expect(res.counts.stale).toBe(1)
    expect(db.prepare('SELECT COUNT(*) c FROM jellyfin_items WHERE scan_id = 1').get()).toEqual({ c: 3 })
    expect(db.prepare("SELECT COUNT(*) c FROM jellyfin_items WHERE id = 'old'").get()).toEqual({ c: 0 })
  })

  it('writes one jellyfin_item_paths row per media source, translated through the path map like the primary path', async () => {
    // Merged versions: /Items returns one item whose MediaSources[] lists both the primary and
    // the alternate physical file. fs.orphan-media needs BOTH container paths recorded here, or
    // the alternate reads as an orphan even though Jellyfin still knows and can play it.
    const jf = {
      virtualFolders: async () => [{ id: 'lib1', name: 'Movies', collectionType: 'movies', locations: ['/media/Movies'] }],
      items: async () => ({
        totalRecordCount: 1,
        items: [{
          id: 'merged1', type: 'Movie', name: 'Heat', sortName: null, year: 1995,
          seriesId: null, seriesName: null, seasonNo: null, episodeNo: null, providerIds: {},
          jfPath: '/media/Movies/Heat.mkv',
          mediaSourcePaths: ['/media/Movies/Heat.mkv', '/media/Movies/Heat.2160p.mkv', '/unmapped/Heat.alt.mkv'],
          sizeBytes: 10, runtimeTicks: 1, container: 'mkv', videoCodec: 'h264', audioCodec: 'aac',
          audioChannels: 2, width: 1920, height: 1080, bitrate: 100, hasPrimaryImage: true,
          dateCreated: null, mediaSourceId: 'ms1',
        }],
      }),
    }
    const res = await jellyfinPhase.run(ctx({
      jellyfin: jf as never,
      pathMap: createPathMap([{ role: 'library', jellyfin: '/media/Movies', container: '/mnt/m', qbit: null, qbitInstance: null }]),
    }))
    expect(res.status).toBe('completed')
    const rows = db.prepare('SELECT jf_path, container_path FROM jellyfin_item_paths WHERE item_id = ? ORDER BY jf_path')
      .all('merged1') as Array<{ jf_path: string; container_path: string | null }>
    expect(rows).toEqual([
      { jf_path: '/media/Movies/Heat.2160p.mkv', container_path: '/mnt/m/Heat.2160p.mkv' },
      { jf_path: '/media/Movies/Heat.mkv', container_path: '/mnt/m/Heat.mkv' },
      { jf_path: '/unmapped/Heat.alt.mkv', container_path: null },
    ])
    // The unmapped alternate path is counted in the SAME tally as an unmapped primary path —
    // no separate counter was invented for this table.
    expect(res.counts.unmapped).toBe(1)
  })

  it('does not double-count an ordinary single-version item\'s one unmapped path as two', async () => {
    // mediaSourcePaths deliberately includes the primary source, so for a normal item with a
    // single version, jfPath and its one media source are the identical string. Translating that
    // string twice (once for the item row, once inside the media-source loop) must not increment
    // `unmapped` twice for what is, on disk, one real unmapped file.
    const jf = {
      virtualFolders: async () => [],
      items: async () => ({
        totalRecordCount: 1,
        items: [{
          id: 'solo1', type: 'Movie', name: 'Heat', sortName: null, year: 1995,
          seriesId: null, seriesName: null, seasonNo: null, episodeNo: null, providerIds: {},
          jfPath: '/media/Movies/Heat.mkv', mediaSourcePaths: ['/media/Movies/Heat.mkv'],
          sizeBytes: 10, runtimeTicks: 1, container: 'mkv', videoCodec: 'h264', audioCodec: 'aac',
          audioChannels: 2, width: 1920, height: 1080, bitrate: 100, hasPrimaryImage: true,
          dateCreated: null, mediaSourceId: 'ms1',
        }],
      }),
    }
    // No path mapping configured at all — the primary (and its one, identical media source) is
    // genuinely unmapped.
    const res = await jellyfinPhase.run(ctx({ jellyfin: jf as never }))
    expect(res.status).toBe('completed')
    expect(res.counts.unmapped).toBe(1)
  })

  it('counts a merged item\'s two distinct unmapped alternate paths as two, not more', async () => {
    const jf = {
      virtualFolders: async () => [],
      items: async () => ({
        totalRecordCount: 1,
        items: [{
          id: 'merged2', type: 'Movie', name: 'Heat', sortName: null, year: 1995,
          seriesId: null, seriesName: null, seasonNo: null, episodeNo: null, providerIds: {},
          jfPath: '/media/Movies/Heat.mkv',
          mediaSourcePaths: ['/media/Movies/Heat.mkv', '/media/Movies/Heat.2160p.mkv'],
          sizeBytes: 10, runtimeTicks: 1, container: 'mkv', videoCodec: 'h264', audioCodec: 'aac',
          audioChannels: 2, width: 1920, height: 1080, bitrate: 100, hasPrimaryImage: true,
          dateCreated: null, mediaSourceId: 'ms1',
        }],
      }),
    }
    const res = await jellyfinPhase.run(ctx({ jellyfin: jf as never }))
    expect(res.status).toBe('completed')
    expect(res.counts.unmapped).toBe(2)
  })

  it('sweeps jellyfin_item_paths under the exact same completeness gate as jellyfin_items — never a separate licence', async () => {
    seedPriorItem()
    db.prepare(`INSERT INTO jellyfin_item_paths (item_id, scan_id, jf_path, container_path)
                VALUES ('old', 0, '/media/Movies/Old.mkv', '/mnt/m/Old.mkv')`).run()

    // A short fetch: the same gate that leaves jellyfin_items untouched must leave
    // jellyfin_item_paths untouched too.
    let call = 0
    const shortFetch = {
      virtualFolders: async () => [],
      items: async () => {
        call += 1
        return call === 1
          ? { totalRecordCount: 10, items: [{
              id: 'a', type: 'Movie', name: 'A', sortName: null, year: null, seriesId: null,
              seriesName: null, seasonNo: null, episodeNo: null, providerIds: {}, jfPath: null,
              mediaSourcePaths: [], sizeBytes: null, runtimeTicks: null, container: null,
              videoCodec: null, audioCodec: null, audioChannels: null, width: null, height: null,
              bitrate: null, hasPrimaryImage: false, dateCreated: null, mediaSourceId: null,
            }] }
          : { totalRecordCount: 10, items: [] }
      },
    }
    const shortRes = await jellyfinPhase.run(ctx({ jellyfin: shortFetch as never }))
    expect(shortRes.status).toBe('skipped')
    expect(db.prepare("SELECT COUNT(*) c FROM jellyfin_item_paths WHERE item_id = 'old'").get()).toEqual({ c: 1 })

    // A complete fetch by a later scan: now both tables sweep together. (A later scan, because
    // completeness counts the distinct items written under the scan's own id, and the short pass
    // above wrote one under scan 1.)
    const res = await jellyfinPhase.run(ctx({ jellyfin: pages(3) as never }, {}, { scanId: 2 }))
    expect(res.status).toBe('completed')
    expect(db.prepare("SELECT COUNT(*) c FROM jellyfin_item_paths WHERE item_id = 'old'").get()).toEqual({ c: 0 })
  })

  it('sweeps jellyfin_items and jellyfin_item_paths atomically — a failure sweeping paths rolls the items sweep back too', async () => {
    // Without a shared transaction, a crash between the two DELETEs would leave a
    // jellyfin_item_paths row whose parent item is already gone — "path present, item absent" —
    // which would keep resolving an orphaned file's path via jellyfin_item_paths and suppress a
    // genuine fs.orphan-media finding until some later, fully-completed scan swept it too.
    seedPriorItem()
    db.prepare(`INSERT INTO jellyfin_item_paths (item_id, scan_id, jf_path, container_path)
                VALUES ('old', 0, '/media/Movies/Old.mkv', '/mnt/m/Old.mkv')`).run()

    const realPrepare = db.prepare.bind(db)
    const spy = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      if (sql.includes('DELETE FROM jellyfin_item_paths')) throw new Error('boom')
      return realPrepare(sql)
    }) as typeof db.prepare)

    await expect(jellyfinPhase.run(ctx({ jellyfin: pages(3) as never }))).rejects.toThrow('boom')
    spy.mockRestore()

    // Neither delete took effect, even though the items delete ran first and succeeded before the
    // paths delete threw: the whole sweep rolled back as one unit.
    expect(db.prepare("SELECT COUNT(*) c FROM jellyfin_items WHERE id = 'old'").get()).toEqual({ c: 1 })
    expect(db.prepare("SELECT COUNT(*) c FROM jellyfin_item_paths WHERE item_id = 'old'").get()).toEqual({ c: 1 })
  })

  it('does not sweep when a resumed fetch reports a total lower than the cursor recorded — the library shrank during the gap', async () => {
    // Cursor left behind by a cancelled attempt: it had reached offset 1000 out of a
    // then-reported 5000. Between that cancel and this resume, items below offset 1000 were
    // deleted from Jellyfin, so items that shift down into [0, 1000) are observed by neither
    // attempt — yet startIndex (now the smaller library's own total) would still satisfy
    // `startIndex >= total`, which is exactly the loophole this guards against.
    seedPriorItem()
    const jf = {
      virtualFolders: async () => [],
      items: async ({ startIndex, limit }: { startIndex: number; limit: number }) => {
        const total = 4000
        const count = Math.max(0, Math.min(limit, total - startIndex))
        return {
          totalRecordCount: total,
          items: Array.from({ length: count }, (_v, i) => ({
            id: `r${startIndex + i}`, type: 'Movie', name: 'x', sortName: null, year: null,
            seriesId: null, seriesName: null, seasonNo: null, episodeNo: null, providerIds: {},
            jfPath: null, sizeBytes: null, runtimeTicks: null, container: null, videoCodec: null,
            audioCodec: null, audioChannels: null, width: null, height: null, bitrate: null,
            hasPrimaryImage: false, dateCreated: null, mediaSourceId: null,
          })),
        }
      },
    }
    const res = await jellyfinPhase.run(ctx({ jellyfin: jf as never }, { startIndex: 1000, total: 5000 }))
    expect(res.status).toBe('skipped')
    expect(res.reason).toMatch(/shrank|resum|stale/i)
    expect(res.counts.stale ?? 0).toBe(0)
    // Nothing was swept: the prior snapshot survives untouched.
    expect(db.prepare("SELECT COUNT(*) c FROM jellyfin_items WHERE id = 'old'").get()).toEqual({ c: 1 })
  })

  /** A bare item: only the id matters to the completeness gate. */
  const bare = (id: string) => ({
    id, type: 'Movie', name: id, sortName: null, year: null, seriesId: null, seriesName: null,
    seasonNo: null, episodeNo: null, providerIds: {}, jfPath: null, mediaSourcePaths: [], sizeBytes: null,
    runtimeTicks: null, container: null, videoCodec: null, audioCodec: null, audioChannels: null, width: null,
    height: null, bitrate: null, hasPrimaryImage: false, dateCreated: null, mediaSourceId: null,
  })
  /** Serves the scripted pages in order, whatever startIndex is asked for. */
  const scripted = (script: Array<{ total: number; ids: string[] }>) => {
    let call = 0
    return {
      virtualFolders: async () => [],
      items: async () => {
        const page = script[Math.min(call, script.length - 1)]!
        call += 1
        return { totalRecordCount: page.total, items: page.ids.map(bare) }
      },
    }
  }
  const range = (from: number, to: number) => Array.from({ length: to - from }, (_v, i) => `i${from + i}`)

  it('jellyfin phase does not sweep when TotalRecordCount changes between first and last page or unique ids < total', async () => {
    // i500 is a live item an earlier scan indexed. Each pass below reaches startIndex >= total —
    // the old completeness test — without having seen every item, because the library moved under
    // the pager. Sweeping on any of them deletes rows for items Jellyfin still has.
    const cases = [
      // Grew: an item arrived mid-pass. Whatever sorting the server applies, the newcomer may have
      // landed in a page already passed, pushing an item this pass never saw into the next one.
      { name: 'grew', script: [{ total: 600, ids: range(0, 500) }, { total: 601, ids: range(501, 601).concat('new') }] },
      // Shrank: an item was removed mid-pass, shifting every later item down one place.
      { name: 'shrank', script: [{ total: 600, ids: range(0, 500) }, { total: 599, ids: range(501, 600) }] },
      // Same total, but a page boundary repeated i499 and skipped i500.
      { name: 'repeated', script: [{ total: 600, ids: range(0, 500) }, { total: 600, ids: ['i499', ...range(501, 600)] }] },
    ]
    for (const { name, script } of cases) {
      db.prepare('DELETE FROM jellyfin_items').run()
      db.prepare(`INSERT INTO jellyfin_items (id, scan_id, type, name) VALUES ('i500', 0, 'Movie', 'live')`).run()
      const res = await jellyfinPhase.run(ctx({ jellyfin: scripted(script) as never }))
      expect(res.status, name).toBe('skipped')
      expect(res.counts.stale ?? 0, name).toBe(0)
      expect(db.prepare("SELECT scan_id FROM jellyfin_items WHERE id = 'i500'").get(), name).toEqual({ scan_id: 0 })
    }
  })

  it('names a changed total and a short unique count in its reason', async () => {
    const grew = await jellyfinPhase.run(ctx({
      jellyfin: scripted([{ total: 600, ids: range(0, 500) }, { total: 601, ids: range(500, 601) }]) as never,
    }))
    expect(grew.reason).toMatch(/600/)
    expect(grew.reason).toMatch(/601/)
    expect(grew.reason).toMatch(/changed/)

    db.prepare('DELETE FROM jellyfin_items').run()
    const repeated = await jellyfinPhase.run(ctx({
      jellyfin: scripted([{ total: 600, ids: range(0, 500) }, { total: 600, ids: ['i499', ...range(501, 600)] }]) as never,
    }))
    expect(repeated.reason).toMatch(/599 of 600/)
  })

  it('counts unique ids across a resume, so a resumed pass whose first attempt saw the rest still sweeps', async () => {
    // The earlier attempt wrote i0..i499 under this scan's id and saved a cursor at 500 of 600.
    const write = db.prepare("INSERT INTO jellyfin_items (id, scan_id, type, name) VALUES (?, 1, 'Movie', 'x')")
    for (const id of range(0, 500)) write.run(id)
    seedPriorItem()
    const res = await jellyfinPhase.run(ctx(
      { jellyfin: scripted([{ total: 600, ids: range(500, 600) }]) as never },
      { startIndex: 500, total: 600, firstTotal: 600 },
    ))
    expect(res.status).toBe('completed')
    expect(res.counts.stale).toBe(1)
  })

  it('carries the first page\'s total across a resume and compares the last page against it', async () => {
    const saves: Array<Record<string, unknown>> = []
    const controller = new AbortController()
    // First attempt: cancelled after one page.
    await jellyfinPhase.run(ctx(
      { jellyfin: scripted([{ total: 600, ids: range(0, 500) }]) as never },
      {},
      { signal: controller.signal, saveCursor: (s) => { saves.push(s); controller.abort() } },
    ))
    expect(saves.at(-1)).toMatchObject({ startIndex: 500, firstTotal: 600 })
    // Resume: the library grew by one between the cancel and now. The resumed attempt's own
    // first page already reports the new total, so only the carried-over first total can tell.
    seedPriorItem()
    const res = await jellyfinPhase.run(ctx(
      { jellyfin: scripted([{ total: 601, ids: range(500, 601) }]) as never },
      saves.at(-1)!,
    ))
    expect(res.status).toBe('skipped')
    expect(res.reason).toMatch(/resum/)
    expect(db.prepare("SELECT COUNT(*) c FROM jellyfin_items WHERE id = 'old'").get()).toEqual({ c: 1 })
  })

  it('jellyfin phase clears deleted_paths rows Jellyfin no longer lists', async () => {
    const jf = {
      virtualFolders: async () => [],
      items: async () => ({
        totalRecordCount: 1,
        items: [{
          ...bare('keep'), jfPath: '/media/Movies/Keep.mkv',
          mediaSourcePaths: ['/media/Movies/Keep.mkv', '/media/Movies/Keep.2160p.mkv'],
        }],
      }),
    }
    const pathMap = createPathMap([{ role: 'library', jellyfin: '/media/Movies', container: '/mnt/m', qbit: null, qbitInstance: null }])
    const record = db.prepare("INSERT INTO deleted_paths (container_path, plan_id, deleted_at) VALUES (?, 'p1', 't')")
    record.run('/mnt/m/Keep.mkv') // still Jellyfin's primary path for an item
    record.run('/mnt/m/Keep.2160p.mkv') // still listed, as a merged version's path only
    record.run('/mnt/m/Gone.mkv') // Jellyfin has forgotten it
    const remaining = () => (db.prepare('SELECT container_path FROM deleted_paths ORDER BY container_path').all() as
      Array<{ container_path: string }>).map((r) => r.container_path)

    // A pass that could not see the whole library proves nothing about what Jellyfin forgot.
    const short = await jellyfinPhase.run(ctx({
      jellyfin: { virtualFolders: async () => [], items: async () => ({ totalRecordCount: 5, items: [] }) } as never,
      pathMap,
    }))
    expect(short.status).toBe('skipped')
    expect(remaining()).toEqual(['/mnt/m/Gone.mkv', '/mnt/m/Keep.2160p.mkv', '/mnt/m/Keep.mkv'])

    const res = await jellyfinPhase.run(ctx({ jellyfin: jf as never, pathMap }))
    expect(res.status).toBe('completed')
    expect(res.counts.deletedPathsCleared).toBe(1)
    expect(remaining()).toEqual(['/mnt/m/Keep.2160p.mkv', '/mnt/m/Keep.mkv'])
  })
})

describe('filesystemPhase', () => {
  beforeEach(() => {
    mkdirSync(join(dir, 'lib', 'Heat'), { recursive: true })
    writeFileSync(join(dir, 'lib', 'Heat', 'Heat.mkv'), 'x'.repeat(50))
  })

  it('writes entries for every walked root', async () => {
    const c = ctx({
      pathMap: createPathMap([{ role: 'library', jellyfin: '/media', container: join(dir, 'lib'), qbit: null, qbitInstance: null }]),
    })
    const res = await filesystemPhase.run(c)
    expect(res.status).toBe('completed')
    const rows = db.prepare('SELECT container_path, is_media, root_role FROM fs_entries').all() as Array<{ container_path: string; is_media: number; root_role: string }>
    expect(rows.some((r) => r.container_path.endsWith('Heat.mkv') && r.is_media === 1 && r.root_role === 'library')).toBe(true)
  })

  it('hashes only roots listed in hashedLibraryRoots', async () => {
    const root = join(dir, 'lib')
    const c = ctx({
      pathMap: createPathMap([{ role: 'library', jellyfin: '/media', container: root, qbit: null, qbitInstance: null }]),
      config: fileConfigSchema.parse({ hashedLibraryRoots: [] }),
    })
    await filesystemPhase.run(c)
    expect((db.prepare('SELECT COUNT(*) c FROM fs_entries WHERE quick_hash IS NOT NULL').get() as { c: number }).c).toBe(0)

    db.prepare('DELETE FROM fs_entries').run()
    const c2 = ctx({
      pathMap: createPathMap([{ role: 'library', jellyfin: '/media', container: root, qbit: null, qbitInstance: null }]),
      config: fileConfigSchema.parse({ hashedLibraryRoots: [root] }),
      hasher: { quickHash: async () => 'deadbeef' } as never,
    })
    await filesystemPhase.run(c2)
    expect((db.prepare('SELECT COUNT(*) c FROM fs_entries WHERE quick_hash IS NOT NULL').get() as { c: number }).c).toBe(1)
  })

  it('skips when no roots are configured rather than walking the whole container', async () => {
    const res = await filesystemPhase.run(ctx({}))
    expect(res.status).toBe('skipped')
    expect(res.reason).toMatch(/no path mappings/i)
  })

  it('reports skipped, with a reason naming the root, when every configured root fails to open', async () => {
    const missing = join(dir, 'does-not-exist')
    db.prepare(`INSERT INTO fs_entries (container_path, scan_id, parent_path, name, is_dir, library_root, root_role)
                VALUES (?,?,?,?,?,?,?)`).run(join(missing, 'Old.mkv'), 0, missing, 'Old.mkv', 0, missing, 'library')
    const c = ctx({
      pathMap: createPathMap([{ role: 'library', jellyfin: '/media', container: missing, qbit: null, qbitInstance: null }]),
    })
    const res = await filesystemPhase.run(c)
    // A totally unreachable filesystem is a connector failure, not "nothing found" — the same
    // property arrPhase already honours when every configured instance fails.
    expect(res.status).toBe('skipped')
    expect(res.reason).toContain(missing)
    // The root itself could never be opened — an unreadable root is not an empty one. Sweeping
    // here would have deleted the prior row and told every filesystem rule the file vanished.
    expect(db.prepare('SELECT COUNT(*) c FROM fs_entries').get()).toEqual({ c: 1 })
  })

  it('does not sweep a root when a subtree inside it could not be read', async () => {
    const root = join(dir, 'lib')
    const locked = join(root, 'locked')
    mkdirSync(locked)
    writeFileSync(join(locked, 'Ghost.mkv'), 'x')
    chmodSync(locked, 0o000)
    // A stale row from a prior scan, under the READABLE part of the root — a file that may or
    // may not still exist, but this pass cannot tell, because 'locked' errored elsewhere in the
    // same root.
    const staleFile = join(root, 'Heat', 'OldVersion.mkv')
    db.prepare(`INSERT INTO fs_entries (container_path, scan_id, parent_path, name, is_dir, library_root, root_role)
                VALUES (?,?,?,?,?,?,?)`).run(staleFile, 0, join(root, 'Heat'), 'OldVersion.mkv', 0, root, 'library')
    try {
      const c = ctx({
        pathMap: createPathMap([{ role: 'library', jellyfin: '/media', container: root, qbit: null, qbitInstance: null }]),
      })
      const res = await filesystemPhase.run(c)
      // The root itself opened fine and Heat.mkv was seen, so this is not a total failure.
      expect(res.status).toBe('completed')
      expect(res.counts.errors).toBeGreaterThan(0)
      expect(res.counts.sweepSkipped).toBeGreaterThan(0)
      // The stale row survives: sweeping it would have been the dangerous direction of the bug
      // — a live file reported as missing, which is an input to a delete decision.
      const stale = db.prepare('SELECT scan_id FROM fs_entries WHERE container_path = ?').get(staleFile) as { scan_id: number } | undefined
      expect(stale).toBeDefined()
      expect(stale!.scan_id).toBe(0)
      // The genuinely readable file was still refreshed normally under the current scan.
      const fresh = db.prepare('SELECT scan_id FROM fs_entries WHERE container_path = ?')
        .get(join(root, 'Heat', 'Heat.mkv')) as { scan_id: number }
      expect(fresh.scan_id).toBe(1)
    } finally {
      chmodSync(locked, 0o755)
    }
  })

  it('cancels without sweeping, and without marking the root complete, when the walk is aborted partway', async () => {
    // The walker terminates NORMALLY on abort — it breaks and flushes its trailing batch rather
    // than throwing — so a cancelled walk looks exactly like a finished one to the `for await`
    // that drives it. Without an explicit post-walk abort check, the sweep runs against a
    // half-seen root and erases every file the walk never reached, and the root is then recorded
    // as completed so a resume never repairs it.
    const root = join(dir, 'big')
    mkdirSync(root)
    const paths: string[] = []
    for (let i = 0; i < 1200; i += 1) {
      const p = join(root, `f${String(i).padStart(4, '0')}.mkv`)
      writeFileSync(p, 'x')
      paths.push(p)
    }
    // Every one of those files was already indexed by a previous scan.
    const seed = db.prepare(`INSERT INTO fs_entries (container_path, scan_id, parent_path, name, ext, is_dir, library_root, root_role)
                             VALUES (?,?,?,?,?,?,?,?)`)
    db.transaction(() => { for (const p of paths) seed.run(p, 0, root, p.split('/').pop()!, '.mkv', 0, root, 'library') })()

    const controller = new AbortController()
    const saves: Array<Record<string, unknown>> = []
    const c = ctx(
      { pathMap: createPathMap([{ role: 'library', jellyfin: '/media', container: root, qbit: null, qbitInstance: null }]) },
      {},
      {
        signal: controller.signal,
        saveCursor: (s) => { saves.push(s) },
        // The phase batches at 1000 entries, so this fires with the root only partly walked.
        progress: (done) => { if (done >= 1000) controller.abort() },
      },
    )
    const res = await filesystemPhase.run(c)

    expect(res.status).toBe('cancelled')
    // Nothing was swept: every previously indexed file is still described by the index, including
    // the ~200 the cancelled walk never reached.
    expect((db.prepare('SELECT COUNT(*) c FROM fs_entries').get() as { c: number }).c).toBe(1200)
    expect((db.prepare('SELECT COUNT(*) c FROM fs_entries WHERE scan_id = 0').get() as { c: number }).c)
      .toBeGreaterThan(0)
    // And the half-walked root must NOT be recorded as done, or a resume would skip it forever.
    const completed = saves.flatMap((s) => (s.completedRoots as string[] | undefined) ?? [])
    expect(completed).not.toContain(root)
  })

  it('sweeps exactly the rows a clean walk did not see, and nothing outside that root', async () => {
    const root = join(dir, 'lib')
    const otherRoot = join(dir, 'other')
    const keep = join(otherRoot, 'Keep.mkv')
    mkdirSync(otherRoot)
    writeFileSync(keep, 'x')
    const ghost = join(root, 'Heat', 'Deleted.mkv')
    const insert = db.prepare(`INSERT INTO fs_entries (container_path, scan_id, parent_path, name, is_dir, library_root, root_role)
                               VALUES (?,?,?,?,?,?,?)`)
    // A file that genuinely vanished since the last scan …
    insert.run(ghost, 0, join(root, 'Heat'), 'Deleted.mkv', 0, root, 'library')
    // … and a still-present file under a DIFFERENT configured root.
    insert.run(keep, 0, otherRoot, 'Keep.mkv', 0, otherRoot, 'library')

    const res = await filesystemPhase.run(ctx({
      pathMap: createPathMap([
        { role: 'library', jellyfin: '/media', container: root, qbit: null, qbitInstance: null },
        { role: 'library', jellyfin: '/other', container: otherRoot, qbit: null, qbitInstance: null },
      ]),
    }))

    expect(res.status).toBe('completed')
    // Exactly one row swept: the ghost. Not the other root's row, not the live files.
    expect(res.counts.stale).toBe(1)
    expect(db.prepare('SELECT COUNT(*) c FROM fs_entries WHERE container_path = ?').get(ghost)).toEqual({ c: 0 })
    expect(db.prepare('SELECT scan_id FROM fs_entries WHERE container_path = ?').get(keep)).toEqual({ scan_id: 1 })
    expect(db.prepare('SELECT COUNT(*) c FROM fs_entries WHERE container_path = ?')
      .get(join(root, 'Heat', 'Heat.mkv'))).toEqual({ c: 1 })
  })

  it('drops rows belonging to a mapping that has since been removed from the config', async () => {
    // The per-root sweep is scoped `WHERE library_root = ?` and only runs for roots still in the
    // config, so nothing else can ever reach these rows: they would describe a mount that may no
    // longer be attached, indefinitely.
    const root = join(dir, 'lib')
    const removed = join(dir, 'was-mapped')
    db.prepare(`INSERT INTO fs_entries (container_path, scan_id, parent_path, name, is_dir, library_root, root_role)
                VALUES (?,?,?,?,?,?,?)`).run(join(removed, 'Old.mkv'), 0, removed, 'Old.mkv', 0, removed, 'library')

    const res = await filesystemPhase.run(ctx({
      pathMap: createPathMap([{ role: 'library', jellyfin: '/media', container: root, qbit: null, qbitInstance: null }]),
    }))
    expect(res.status).toBe('completed')
    expect(res.counts.pruned).toBe(1)
    expect(db.prepare('SELECT COUNT(*) c FROM fs_entries WHERE library_root = ?').get(removed)).toEqual({ c: 0 })
  })

  it('keeps rows for an unconfigured root when any configured root failed — unreadable is not removed', async () => {
    // With a root erroring, "this mapping was removed" and "this mapping is temporarily
    // unreadable" are indistinguishable, and in the second case these rows are the live index
    // for a mount that is merely down.
    const missing = join(dir, 'does-not-exist')
    const removed = join(dir, 'was-mapped')
    const insert = db.prepare(`INSERT INTO fs_entries (container_path, scan_id, parent_path, name, is_dir, library_root, root_role)
                               VALUES (?,?,?,?,?,?,?)`)
    insert.run(join(removed, 'Old.mkv'), 0, removed, 'Old.mkv', 0, removed, 'library')

    const res = await filesystemPhase.run(ctx({
      pathMap: createPathMap([
        { role: 'library', jellyfin: '/media', container: join(dir, 'lib'), qbit: null, qbitInstance: null },
        { role: 'library', jellyfin: '/down', container: missing, qbit: null, qbitInstance: null },
      ]),
    }))
    expect(res.counts.pruned).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM fs_entries WHERE library_root = ?').get(removed)).toEqual({ c: 1 })
  })

  /** Rows an earlier scan wrote for `root` — what the index knows about a share before it drops. */
  const seedIndexed = (root: string, names: string[]) => {
    const insert = db.prepare(`INSERT INTO fs_entries (container_path, scan_id, parent_path, name, ext, is_dir, is_media, library_root, root_role)
                               VALUES (?,?,?,?,?,?,?,?,?)`)
    for (const n of names) insert.run(join(root, n), 0, root, n, '.mkv', 0, 1, root, 'library')
  }

  it('filesystem phase does not sweep a root that walks empty while the index holds rows for it', async () => {
    // An unmounted share leaves its mount point behind as an empty directory, which opens
    // without complaint. Sweeping on that walk would drop every row for the root and tell every
    // filesystem rule the whole library vanished.
    const lib = join(dir, 'lib')
    const share = join(dir, 'share')
    mkdirSync(share)
    seedIndexed(share, ['A.mkv', 'B.mkv'])
    seedIndexed(lib, ['Gone.mkv']) // a genuinely deleted file under the healthy root
    const res = await filesystemPhase.run(ctx({
      pathMap: createPathMap([
        { role: 'library', jellyfin: '/media', container: lib, qbit: null, qbitInstance: null },
        { role: 'library', jellyfin: '/share', container: share, qbit: null, qbitInstance: null },
      ]),
    }))
    // The healthy root was observed, so the phase completed — and it says what it did not sweep.
    expect(res.status).toBe('completed')
    expect(res.counts.unmounted).toBe(1)
    expect(res.reason).toContain(share)
    expect(res.reason).toMatch(/unmounted/)
    expect((db.prepare('SELECT COUNT(*) c FROM fs_entries WHERE library_root = ? AND scan_id = 0').get(share) as { c: number }).c).toBe(2)
    // The healthy root was swept as usual.
    expect(db.prepare('SELECT COUNT(*) c FROM fs_entries WHERE container_path = ?').get(join(lib, 'Gone.mkv'))).toEqual({ c: 0 })
  })

  it('is skipped, naming the root, when its only root walks empty while the index holds rows for it', async () => {
    const share = join(dir, 'share')
    mkdirSync(share)
    seedIndexed(share, ['A.mkv'])
    // A row of a mapping since removed: with the only root unobserved, it is not provably stale.
    const removed = join(dir, 'was-mapped')
    seedIndexed(removed, ['Old.mkv'])
    const res = await filesystemPhase.run(ctx({
      pathMap: createPathMap([{ role: 'library', jellyfin: '/share', container: share, qbit: null, qbitInstance: null }]),
    }))
    // Nothing was observed at all, so downstream rules must not read the stale rows as fresh.
    expect(res.status).toBe('skipped')
    expect(res.reason).toContain(share)
    expect(res.counts.pruned).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM fs_entries').get()).toEqual({ c: 2 })
  })

  it('treats an empty root the index knows nothing about as empty, not unmounted', async () => {
    const fresh = join(dir, 'fresh')
    mkdirSync(fresh)
    const res = await filesystemPhase.run(ctx({
      pathMap: createPathMap([{ role: 'library', jellyfin: '/fresh', container: fresh, qbit: null, qbitInstance: null }]),
    }))
    expect(res.status).toBe('completed')
    expect(res.counts.unmounted).toBe(0)
    expect(res.reason).toBeUndefined()
  })

  it('does not prune on a resumed pass that skipped an already-completed root', async () => {
    const root = join(dir, 'lib')
    const removed = join(dir, 'was-mapped')
    db.prepare(`INSERT INTO fs_entries (container_path, scan_id, parent_path, name, is_dir, library_root, root_role)
                VALUES (?,?,?,?,?,?,?)`).run(join(removed, 'Old.mkv'), 0, removed, 'Old.mkv', 0, removed, 'library')

    // The cursor says this root is already done, so this pass never observes it and cannot
    // vouch for how cleanly the earlier attempt walked it.
    const res = await filesystemPhase.run(ctx(
      { pathMap: createPathMap([{ role: 'library', jellyfin: '/media', container: root, qbit: null, qbitInstance: null }]) },
      { completedRoots: [root] },
    ))
    expect(res.counts.pruned).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM fs_entries WHERE library_root = ?').get(removed)).toEqual({ c: 1 })
  })
})

describe('qbittorrentPhase', () => {
  it('resolves torrent file paths to container paths and stats them for inode', async () => {
    mkdirSync(join(dir, 'dl', 'Heat'), { recursive: true })
    const file = join(dir, 'dl', 'Heat', 'Heat.mkv')
    writeFileSync(file, 'x')
    const c = ctx({
      pathMap: createPathMap([{ role: 'download', jellyfin: null, container: join(dir, 'dl'), qbit: '/downloads', qbitInstance: 'box-a' }]),
      qbittorrents: one({
        torrents: async () => [{
          hash: 'H1', name: 'Heat', savePath: '/downloads', contentPath: '/downloads/Heat',
          category: null, tags: [], state: 'stalledUP', ratio: 1, seedingTimeSeconds: 1,
          isPrivate: false, trackerHost: 'x', sizeBytes: 1, progress: 1,
        }],
        files: async () => [{ index: 0, relPath: 'Heat/Heat.mkv', sizeBytes: 1 }],
      }),
    })
    const res = await qbittorrentPhase.run(c)
    expect(res.status).toBe('completed')
    const row = db.prepare('SELECT container_path, inode FROM torrent_files').get() as { container_path: string; inode: number }
    expect(row.container_path).toBe(file)
    expect(row.inode).toBeGreaterThan(0)
  })

  it('skips with a reason when qbittorrent is unreachable', async () => {
    const c = ctx({ qbittorrents: one({ torrents: async () => { throw Object.assign(new Error('down'), { kind: 'unreachable' }) } }) })
    const res = await qbittorrentPhase.run(c)
    expect(res.status).toBe('skipped')
  })

  const torrent = (hash: string, over: Record<string, unknown> = {}) => ({
    hash, name: hash, savePath: '/downloads', contentPath: `/downloads/${hash}`,
    category: null, tags: [], state: 'downloading', ratio: 1, seedingTimeSeconds: 1,
    isPrivate: false, trackerHost: 'x', sizeBytes: 1, progress: 0.5, ...over,
  })

  const seedTorrentRow = (hash: string, instanceId = 'box-a') => {
    db.prepare("INSERT INTO torrents (instance_id, hash, fetched_at, name, state) VALUES (?, ?, 'long-ago', ?, 'stalledUP')")
      .run(instanceId, hash, hash)
    db.prepare('INSERT INTO torrent_files (instance_id, hash, file_index, rel_path) VALUES (?,?,?,?)').run(instanceId, hash, 0, 'a.mkv')
  }

  it('does not sweep when cancelled mid-iteration', async () => {
    // The rows this pass never reached are unobserved, not gone. Sweeping them takes the
    // cross-seed correlation with them, which is what a later delete guard reads.
    seedTorrentRow('OLD')
    const controller = new AbortController()
    const c = ctx({
      pathMap: createPathMap([{ role: 'download', jellyfin: null, container: join(dir, 'dl'), qbit: '/downloads', qbitInstance: 'box-a' }]),
      qbittorrents: one({
        torrents: async () => [torrent('H1'), torrent('H2')],
        files: async () => { controller.abort(); return [] },
      }),
    }, {}, { signal: controller.signal })

    const res = await qbittorrentPhase.run(c)
    expect(res.status).toBe('cancelled')
    // H1 was written before the abort; OLD survives untouched because nothing was swept.
    expect(db.prepare("SELECT COUNT(*) c FROM torrents WHERE hash = 'OLD'").get()).toEqual({ c: 1 })
    expect(db.prepare("SELECT COUNT(*) c FROM torrent_files WHERE hash = 'OLD'").get()).toEqual({ c: 1 })
  })

  it('sweeps torrents that vanished once a full pass completes', async () => {
    seedTorrentRow('OLD')
    const c = ctx({
      pathMap: createPathMap([{ role: 'download', jellyfin: null, container: join(dir, 'dl'), qbit: '/downloads', qbitInstance: 'box-a' }]),
      qbittorrents: one({ torrents: async () => [torrent('H1')], files: async () => [] }),
    })
    const res = await qbittorrentPhase.run(c)
    expect(res.status).toBe('completed')
    expect(res.counts.stale).toBe(1)
    expect(db.prepare("SELECT COUNT(*) c FROM torrents WHERE hash = 'OLD'").get()).toEqual({ c: 0 })
    expect(db.prepare("SELECT COUNT(*) c FROM torrent_files WHERE hash = 'OLD'").get()).toEqual({ c: 0 })
  })

  it('records a files fetch failure in files_error and leaves state verbatim', async () => {
    // state is what Plan 4's guard.protected matches against a set of busy states, blocking with
    // no override. A decorated string ("downloading (files unavailable: …)") fails that
    // membership test, so the guard would open — and only ever when qBittorrent is flaky.
    const c = ctx({
      qbittorrents: one({
        torrents: async () => [torrent('H1', { state: 'downloading' })],
        files: async () => { throw Object.assign(new Error('timeout'), { kind: 'timeout' }) },
      }),
    })
    await qbittorrentPhase.run(c)
    const row = db.prepare('SELECT state, files_error FROM torrents WHERE hash = ?').get('H1') as
      { state: string; files_error: string | null }
    expect(row.state).toBe('downloading')
    expect(row.files_error).toMatch(/timeout/)
  })

  it('replaces a torrent file list rather than merging it, so a shrunken torrent keeps no phantom links', async () => {
    // A leftover (hash → dev, inode) row makes a confirmed cross-seed expand a delete onto a
    // torrent that no longer holds the file.
    const c1 = ctx({
      qbittorrents: one({
        torrents: async () => [torrent('H1')],
        files: async () => [{ index: 0, relPath: 'a.mkv', sizeBytes: 1 }, { index: 1, relPath: 'b.mkv', sizeBytes: 1 }],
      }),
    })
    await qbittorrentPhase.run(c1)
    expect(db.prepare('SELECT COUNT(*) c FROM torrent_files WHERE hash = ?').get('H1')).toEqual({ c: 2 })

    const c2 = ctx({
      qbittorrents: one({
        torrents: async () => [torrent('H1')],
        files: async () => [{ index: 0, relPath: 'a.mkv', sizeBytes: 1 }],
      }),
    })
    await qbittorrentPhase.run(c2)
    const rows = db.prepare('SELECT rel_path FROM torrent_files WHERE hash = ?').all('H1') as Array<{ rel_path: string }>
    expect(rows.map((r) => r.rel_path)).toEqual(['a.mkv'])
  })

  it('counts paths it could not translate instead of leaving a silent NULL', async () => {
    const c = ctx({
      pathMap: createPathMap([]), // no mapping covers /downloads at all
      qbittorrents: one({ torrents: async () => [torrent('H1')], files: async () => [] }),
    })
    const res = await qbittorrentPhase.run(c)
    // Once for contentPath, once for savePath — both untranslatable.
    expect(res.counts.unmapped).toBe(2)
  })
})

describe('qbittorrentPhase — instances', () => {
  const torrent = (hash: string, over: Record<string, unknown> = {}) => ({
    hash, name: hash, savePath: '/movies', contentPath: `/movies/${hash}.mkv`, rootPath: '',
    category: null, tags: [], state: 'stalledUP', ratio: 1, seedingTimeSeconds: 1,
    isPrivate: false, trackerHost: 'x', sizeBytes: 1, progress: 1, addedOn: 1_700_000_000, ...over,
  })
  // Both boxes call their library /movies; only the container namespace tells them apart.
  const twoBoxes = () => createPathMap([
    { role: 'library', jellyfin: '/data/a', container: join(dir, 'a'), qbit: '/movies', qbitInstance: 'box-a' },
    { role: 'library', jellyfin: '/data/b', container: join(dir, 'b'), qbit: '/movies', qbitInstance: 'box-b' },
  ])
  const files = (hash: string) => async () => [{ index: 0, relPath: `${hash}.mkv`, sizeBytes: 1 }]

  it('skips with a reason when no instance is configured', async () => {
    const res = await qbittorrentPhase.run(ctx({ qbittorrents: new Map() }))
    expect(res.status).toBe('skipped')
    expect(res.reason).toMatch(/no qbittorrent instance/i)
  })

  it('writes each instance\'s torrents under its own id, through its own prefix, with root_path and added_on', async () => {
    const c = ctx({
      pathMap: twoBoxes(),
      qbittorrents: new Map([
        ['box-a', { instanceId: 'box-a', torrents: async () => [torrent('same')], files: files('same') }],
        ['box-b', { instanceId: 'box-b', torrents: async () => [torrent('same'), torrent('onlyb')], files: async (h: string) => files(h)() }],
      ]) as never,
    })
    const res = await qbittorrentPhase.run(c)
    expect(res.status).toBe('completed')
    expect(res.counts.torrents).toBe(3)

    // The same infohash on both boxes is two rows, each pointing at its own box's file.
    const rows = db.prepare('SELECT instance_id, hash, container_content_path, root_path, added_on FROM torrents ORDER BY instance_id, hash')
      .all() as Array<Record<string, unknown>>
    expect(rows).toEqual([
      { instance_id: 'box-a', hash: 'same', container_content_path: join(dir, 'a', 'same.mkv'), root_path: '', added_on: 1_700_000_000 },
      { instance_id: 'box-b', hash: 'onlyb', container_content_path: join(dir, 'b', 'onlyb.mkv'), root_path: '', added_on: 1_700_000_000 },
      { instance_id: 'box-b', hash: 'same', container_content_path: join(dir, 'b', 'same.mkv'), root_path: '', added_on: 1_700_000_000 },
    ])
    const fileRows = db.prepare("SELECT instance_id, container_path FROM torrent_files WHERE hash = 'same' ORDER BY instance_id").all()
    expect(fileRows).toEqual([
      { instance_id: 'box-a', container_path: join(dir, 'a', 'same.mkv') },
      { instance_id: 'box-b', container_path: join(dir, 'b', 'same.mkv') },
    ])
  })

  it('one failing instance leaves its rows untouched, sweeps the other, and returns skipped with the failing id in reason', async () => {
    db.prepare("INSERT INTO torrents (instance_id, hash, fetched_at, name) VALUES ('box-a', 'gone', 'long-ago', 'gone')").run()
    db.prepare("INSERT INTO torrent_files (instance_id, hash, file_index, rel_path) VALUES ('box-a', 'gone', 0, 'g.mkv')").run()
    db.prepare(`INSERT INTO torrents (instance_id, hash, fetched_at, name, state, ratio)
                VALUES ('box-b', 'kept', 'long-ago', 'kept', 'stalledUP', 2.5)`).run()
    db.prepare(`INSERT INTO torrent_files (instance_id, hash, file_index, rel_path, container_path, inode)
                VALUES ('box-b', 'kept', 0, 'k.mkv', '/path/to/b/k.mkv', 77)`).run()
    const c = ctx({
      pathMap: twoBoxes(),
      qbittorrents: new Map([
        ['box-a', { instanceId: 'box-a', torrents: async () => [torrent('fresh')], files: files('fresh') }],
        ['box-b', { instanceId: 'box-b', torrents: async () => { throw Object.assign(new Error('down'), { kind: 'unreachable' }) } }],
      ]) as never,
    })
    const res = await qbittorrentPhase.run(c)
    // One box unobserved means the torrent picture as a whole was not observed.
    expect(res.status).toBe('skipped')
    expect(res.reason).toMatch(/box-b/)
    expect(res.reason).not.toMatch(/box-a/)
    expect(res.counts.stale).toBe(1)
    const torrents = db.prepare('SELECT instance_id, hash FROM torrents ORDER BY instance_id, hash').all()
    expect(torrents).toEqual([{ instance_id: 'box-a', hash: 'fresh' }, { instance_id: 'box-b', hash: 'kept' }])
    const fileRows = db.prepare('SELECT instance_id, hash FROM torrent_files ORDER BY instance_id, hash').all()
    expect(fileRows).toEqual([{ instance_id: 'box-a', hash: 'fresh' }, { instance_id: 'box-b', hash: 'kept' }])
    // Untouched means untouched: not refreshed, not rewritten — exactly what the last good pass recorded.
    expect(db.prepare("SELECT fetched_at, state, ratio FROM torrents WHERE instance_id = 'box-b'").get())
      .toEqual({ fetched_at: 'long-ago', state: 'stalledUP', ratio: 2.5 })
    expect(db.prepare("SELECT container_path, inode FROM torrent_files WHERE instance_id = 'box-b'").get())
      .toEqual({ container_path: '/path/to/b/k.mkv', inode: 77 })
  })

  it('drops the rows of an instance that is no longer configured, even while a configured instance is down', async () => {
    // Nothing else can ever reach these rows: the per-instance sweep only runs for configured
    // instances. Left behind, they keep feeding the cross-seed guard torrents that no configured
    // box holds. They are not "unobserved" the way a down box's rows are — no pass will ever
    // observe them again — so a configured box being down is no reason to keep them.
    db.prepare("INSERT INTO torrents (instance_id, hash, fetched_at, name) VALUES ('box-old', 'h', 'long-ago', 'h')").run()
    db.prepare("INSERT INTO torrent_files (instance_id, hash, file_index, rel_path) VALUES ('box-old', 'h', 0, 'h.mkv')").run()
    // A file row with no torrent row at all is dropped too.
    db.prepare("INSERT INTO torrent_files (instance_id, hash, file_index, rel_path) VALUES ('box-old', 'stray', 0, 's.mkv')").run()
    db.prepare("INSERT INTO torrents (instance_id, hash, fetched_at, name) VALUES ('box-a', 'live', 'long-ago', 'live')").run()
    db.prepare("INSERT INTO torrent_files (instance_id, hash, file_index, rel_path) VALUES ('box-a', 'live', 0, 'l.mkv')").run()
    const res = await qbittorrentPhase.run(ctx({
      pathMap: twoBoxes(),
      qbittorrents: one({ torrents: async () => { throw Object.assign(new Error('down'), { kind: 'unreachable' }) } }),
    }))
    expect(res.status).toBe('skipped')
    expect(res.counts.unconfigured).toBe(1)
    expect(db.prepare("SELECT COUNT(*) c FROM torrents WHERE instance_id = 'box-old'").get()).toEqual({ c: 0 })
    expect(db.prepare("SELECT COUNT(*) c FROM torrent_files WHERE instance_id = 'box-old'").get()).toEqual({ c: 0 })
    // The configured box that is down keeps everything.
    expect(db.prepare("SELECT COUNT(*) c FROM torrents WHERE instance_id = 'box-a'").get()).toEqual({ c: 1 })
    expect(db.prepare("SELECT COUNT(*) c FROM torrent_files WHERE instance_id = 'box-a'").get()).toEqual({ c: 1 })
  })

  it('qbittorrent phase reports progress across instances', async () => {
    const calls: Array<[number, number | null]> = []
    const c = ctx({
      pathMap: twoBoxes(),
      qbittorrents: new Map([
        ['box-a', { instanceId: 'box-a', torrents: async () => [torrent('a1'), torrent('a2')], files: async () => [] }],
        ['box-b', { instanceId: 'box-b', torrents: async () => [torrent('b1'), torrent('b2'), torrent('b3')], files: async () => [] }],
      ]) as never,
    }, {}, { progress: (done, total) => { calls.push([done, total]) } })
    const res = await qbittorrentPhase.run(c)
    expect(res.status).toBe('completed')
    // One running count over every instance, against one total known before the first torrent is
    // written — not a count that restarts at each box, nor a total that grows as boxes answer.
    expect(calls).toEqual([[0, 5], [1, 5], [2, 5], [3, 5], [4, 5], [5, 5]])
  })

  it("qbittorrent phase synthesizes single-file torrents' file lists without calling files()", async () => {
    mkdirSync(join(dir, 'a'), { recursive: true })
    writeFileSync(join(dir, 'a', 'Solo.2019.mkv'), 'x'.repeat(10))
    const asked: string[] = []
    const res = await qbittorrentPhase.run(ctx({
      pathMap: twoBoxes(),
      qbittorrents: one({
        torrents: async () => [
          // qBittorrent 5.x: root_path "" and content_path = save_path/<the one file>.
          torrent('solo', { contentPath: '/movies/Solo.2019.mkv', sizeBytes: 10 }),
          torrent('pack', { rootPath: '/movies/Pack', contentPath: '/movies/Pack' }),
        ],
        files: async (hash: string) => {
          asked.push(hash)
          return [{ index: 0, relPath: 'Pack/E01.mkv', sizeBytes: 5 }, { index: 1, relPath: 'Pack/E02.mkv', sizeBytes: 5 }]
        },
      }),
    }))
    expect(res.status).toBe('completed')
    expect(asked).toEqual(['pack'])
    expect(res.counts.synthesized).toBe(1)
    expect(res.counts.files).toBe(3)
    expect(db.prepare("SELECT file_index, rel_path, container_path, size_bytes, inode FROM torrent_files WHERE hash = 'solo'").all())
      .toEqual([{
        file_index: 0, rel_path: 'Solo.2019.mkv', container_path: join(dir, 'a', 'Solo.2019.mkv'), size_bytes: 10,
        inode: expect.any(Number),
      }])
  })

  it('asks files() whenever an empty root_path does not prove one file sitting directly in the save path', async () => {
    // qBittorrent reports root_path "" for more than single-file torrents: a multi-file torrent
    // added without a root folder reports its storage directory as content_path, and a magnet
    // still fetching metadata reports "". Synthesizing a one-file list for either would index a
    // directory as the torrent's only file.
    mkdirSync(join(dir, 'a', 'Loose'), { recursive: true })
    const asked: string[] = []
    await qbittorrentPhase.run(ctx({
      pathMap: twoBoxes(),
      qbittorrents: one({
        torrents: async () => [
          torrent('nosub', { contentPath: '/movies' }), // no root folder, stored in save_path itself
          torrent('magnet', { contentPath: '' }), // no metadata yet
          torrent('unreported', { contentPath: null }),
          torrent('temp', { contentPath: '/movies/incomplete/T.mkv' }), // still in a download dir under save_path
          torrent('elsewhere', { contentPath: '/downloads/E.mkv' }), // outside save_path entirely
          torrent('dir', { contentPath: '/movies/Loose' }), // one segment deep, but a directory on disk
        ],
        files: async (hash: string) => { asked.push(hash); return [] },
      }),
    }))
    expect(asked.sort()).toEqual(['dir', 'elsewhere', 'magnet', 'nosub', 'temp', 'unreported'])
  })

  // Ruling 18: the worker's clients are fresh every scan, so their own login backoff starts empty.
  // An instance whose main-thread client is holding off logging in must not be asked for anything
  // here either, or every nightly scan spends another failed login towards qBittorrent's ban.
  it('treats an instance whose login is blocked as failed, without asking it anything, and keeps its rows', async () => {
    db.prepare(`INSERT INTO torrents (instance_id, hash, fetched_at, name, state, ratio)
                VALUES ('box-b', 'kept', 'long-ago', 'kept', 'stalledUP', 2.5)`).run()
    db.prepare(`INSERT INTO torrent_files (instance_id, hash, file_index, rel_path, container_path)
                VALUES ('box-b', 'kept', 0, 'k.mkv', '/path/to/b/k.mkv')`).run()
    let asked = 0
    const refuse = async () => { asked += 1; throw new Error('a blocked instance must not be asked') }
    const res = await qbittorrentPhase.run(ctx({
      pathMap: twoBoxes(),
      qbittorrents: new Map([
        ['box-a', { instanceId: 'box-a', torrents: async () => [torrent('fresh')], files: files('fresh') }],
        ['box-b', { instanceId: 'box-b', torrents: refuse, files: refuse, ping: refuse }],
      ]) as never,
      qbitLoginBlocked: new Set(['box-b']),
    }))
    expect(asked).toBe(0)
    expect(res.status).toBe('skipped')
    expect(res.reason).toMatch(/box-b: login blocked/)
    expect(res.reason).not.toMatch(/box-a/)
    // Unobserved, not gone: neither swept as stale nor dropped as unconfigured.
    expect(res.counts.unconfigured).toBe(0)
    expect(db.prepare('SELECT instance_id, hash FROM torrents ORDER BY instance_id, hash').all())
      .toEqual([{ instance_id: 'box-a', hash: 'fresh' }, { instance_id: 'box-b', hash: 'kept' }])
    expect(db.prepare("SELECT hash FROM torrent_files WHERE instance_id = 'box-b'").all()).toEqual([{ hash: 'kept' }])
  })

  it('records a files failure against the right instance only', async () => {
    // Multi-file torrents: a single-file torrent's list is synthesized, so it never calls files().
    const pack = (hash: string) => torrent(hash, { rootPath: `/movies/${hash}`, contentPath: `/movies/${hash}` })
    const c = ctx({
      pathMap: twoBoxes(),
      qbittorrents: new Map([
        ['box-a', { instanceId: 'box-a', torrents: async () => [pack('same')], files: files('same') }],
        ['box-b', { instanceId: 'box-b', torrents: async () => [pack('same')], files: async () => { throw Object.assign(new Error('slow'), { kind: 'timeout' }) } }],
      ]) as never,
    })
    await qbittorrentPhase.run(c)
    expect(db.prepare("SELECT instance_id, files_error FROM torrents WHERE hash = 'same' ORDER BY instance_id").all()).toEqual([
      { instance_id: 'box-a', files_error: null },
      { instance_id: 'box-b', files_error: expect.stringMatching(/slow/) },
    ])
  })
})

describe('arrPhase', () => {
  it('is skipped, not failed, when neither instance is configured', async () => {
    const res = await arrPhase.run(ctx({}))
    expect(res.status).toBe('skipped')
    expect(res.reason).toMatch(/not configured/i)
  })

  it('writes records from both instances', async () => {
    const c = ctx({
      radarr: { inventory: async () => ({ records: [{ kind: 'radarr', instance: 'radarr', remoteId: 1, title: 'Heat', arrPath: '/movies/Heat.mkv', monitored: true, seriesId: null, episodeId: null, episodeFileId: null }], complete: true }) } as never,
      sonarr: { inventory: async () => ({ records: [{ kind: 'sonarr', instance: 'sonarr', remoteId: 2, title: 'Ep', arrPath: '/tv/Ep.mkv', monitored: true, seriesId: 9, episodeId: 500, episodeFileId: 2 }], complete: true }) } as never,
    })
    const res = await arrPhase.run(c)
    expect(res.status).toBe('completed')
    expect(db.prepare('SELECT COUNT(*) c FROM arr_records').get()).toEqual({ c: 2 })
    expect(res.counts.partial).toBe(0)
  })

  it('writes NULL — not the raw *arr path — when the path cannot be translated, and counts it', async () => {
    // container_path is the join key to fs_entries and jellyfin_items. An *arr-side path parked
    // in it looks authoritative and joins to nothing, so the record silently stops describing
    // the file it names.
    const c = ctx({
      pathMap: createPathMap([{ role: 'library', jellyfin: '/media', container: '/mnt/m', qbit: null, qbitInstance: null }]),
      radarr: { inventory: async () => ({ records: [{ kind: 'radarr', instance: 'radarr', remoteId: 1, title: 'Heat', arrPath: '/movies/Heat.mkv', monitored: true, seriesId: null, episodeId: null, episodeFileId: null }], complete: true }) } as never,
    })
    const res = await arrPhase.run(c)
    expect(res.counts.unmapped).toBe(1)
    const row = db.prepare('SELECT arr_path, container_path FROM arr_records').get() as
      { arr_path: string; container_path: string | null }
    expect(row.arr_path).toBe('/movies/Heat.mkv')
    expect(row.container_path).toBeNull()
  })

  it('preserves an instance\'s pre-existing rows when its inventory came back partial, while a complete instance is still replaced wholesale', async () => {
    // A flaky Sonarr series must not erase its files' rows: the delete executor reads the INDEX
    // (not unmonitorByPath) to decide whether a file is *arr-managed, and an erased row reads
    // downstream as "not managed" — licensing a delete the *arr would otherwise have blocked.
    const insert = db.prepare(`INSERT INTO arr_records (
      id, kind, instance, remote_id, title, arr_path, container_path, monitored,
      series_id, episode_id, episode_file_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    insert.run('sonarr:sonarr:999', 'sonarr', 'sonarr', 999, 'Old Show', '/tv/OldShow.mkv', null, 1, 1, 1, 1)
    insert.run('radarr:radarr:888', 'radarr', 'radarr', 888, 'Old Movie', '/movies/OldMovie.mkv', null, 1, null, null, null)

    const c = ctx({
      radarr: { inventory: async () => ({
        records: [{ kind: 'radarr', instance: 'radarr', remoteId: 1, title: 'Heat', arrPath: '/movies/Heat.mkv', monitored: true, seriesId: null, episodeId: null, episodeFileId: null }],
        complete: true,
      }) } as never,
      sonarr: { inventory: async () => ({
        records: [{ kind: 'sonarr', instance: 'sonarr', remoteId: 2, title: 'Ep', arrPath: '/tv/Ep.mkv', monitored: true, seriesId: 9, episodeId: 500, episodeFileId: 2 }],
        complete: false,
      }) } as never,
    })
    const res = await arrPhase.run(c)
    expect(res.status).toBe('completed')
    expect(res.counts.partial).toBe(1)

    // radarr's fetch was complete: its stale row is gone, replaced wholesale.
    expect(db.prepare("SELECT COUNT(*) c FROM arr_records WHERE kind = 'radarr' AND remote_id = 888").get()).toEqual({ c: 0 })
    expect(db.prepare("SELECT COUNT(*) c FROM arr_records WHERE kind = 'radarr' AND remote_id = 1").get()).toEqual({ c: 1 })

    // sonarr's fetch was partial: the old row it never re-read survives...
    expect(db.prepare("SELECT COUNT(*) c FROM arr_records WHERE kind = 'sonarr' AND remote_id = 999").get()).toEqual({ c: 1 })
    // ...alongside the row this pass DID fetch.
    expect(db.prepare("SELECT COUNT(*) c FROM arr_records WHERE kind = 'sonarr' AND remote_id = 2").get()).toEqual({ c: 1 })
  })
})
