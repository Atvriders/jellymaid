import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
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

function ctx(deps: Partial<PhaseContext['deps']>, cursor: Record<string, unknown> = {}): PhaseContext {
  let saved = cursor
  return {
    db, scanId: 1, cursor: saved, signal: new AbortController().signal,
    saveCursor: (c) => { saved = c },
    progress: () => {},
    deps: {
      config: fileConfigSchema.parse({}),
      pathMap: createPathMap([]),
      jellyfin: null, qbittorrent: null, radarr: null, sonarr: null,
      hasher: null,
      ...deps,
    } as PhaseContext['deps'],
  }
}

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
      pathMap: createPathMap([{ role: 'library', jellyfin: '/media/Movies', container: '/mnt/m', qbit: null }]),
    })
    await jellyfinPhase.run(c)
    const row = db.prepare('SELECT container_path FROM jellyfin_items').get() as { container_path: string }
    expect(row.container_path).toBe('/mnt/m/M0.mkv')
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
})

describe('filesystemPhase', () => {
  beforeEach(() => {
    mkdirSync(join(dir, 'lib', 'Heat'), { recursive: true })
    writeFileSync(join(dir, 'lib', 'Heat', 'Heat.mkv'), 'x'.repeat(50))
  })

  it('writes entries for every walked root', async () => {
    const c = ctx({
      pathMap: createPathMap([{ role: 'library', jellyfin: '/media', container: join(dir, 'lib'), qbit: null }]),
    })
    const res = await filesystemPhase.run(c)
    expect(res.status).toBe('completed')
    const rows = db.prepare('SELECT container_path, is_media, root_role FROM fs_entries').all() as Array<{ container_path: string; is_media: number; root_role: string }>
    expect(rows.some((r) => r.container_path.endsWith('Heat.mkv') && r.is_media === 1 && r.root_role === 'library')).toBe(true)
  })

  it('hashes only roots listed in hashedLibraryRoots', async () => {
    const root = join(dir, 'lib')
    const c = ctx({
      pathMap: createPathMap([{ role: 'library', jellyfin: '/media', container: root, qbit: null }]),
      config: fileConfigSchema.parse({ hashedLibraryRoots: [] }),
    })
    await filesystemPhase.run(c)
    expect((db.prepare('SELECT COUNT(*) c FROM fs_entries WHERE quick_hash IS NOT NULL').get() as { c: number }).c).toBe(0)

    db.prepare('DELETE FROM fs_entries').run()
    const c2 = ctx({
      pathMap: createPathMap([{ role: 'library', jellyfin: '/media', container: root, qbit: null }]),
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

  it('does not sweep a root that could not be opened at all', async () => {
    const missing = join(dir, 'does-not-exist')
    db.prepare(`INSERT INTO fs_entries (container_path, scan_id, parent_path, name, is_dir, library_root, root_role)
                VALUES (?,?,?,?,?,?,?)`).run(join(missing, 'Old.mkv'), 0, missing, 'Old.mkv', 0, missing, 'library')
    const c = ctx({
      pathMap: createPathMap([{ role: 'library', jellyfin: '/media', container: missing, qbit: null }]),
    })
    const res = await filesystemPhase.run(c)
    expect(res.status).toBe('completed')
    expect(res.counts.errors).toBeGreaterThan(0)
    // The root itself could never be opened — an unreadable root is not an empty one. Sweeping
    // here would have deleted the prior row and told every filesystem rule the file vanished.
    expect(db.prepare('SELECT COUNT(*) c FROM fs_entries').get()).toEqual({ c: 1 })
  })
})

describe('qbittorrentPhase', () => {
  it('resolves torrent file paths to container paths and stats them for inode', async () => {
    mkdirSync(join(dir, 'dl', 'Heat'), { recursive: true })
    const file = join(dir, 'dl', 'Heat', 'Heat.mkv')
    writeFileSync(file, 'x')
    const c = ctx({
      pathMap: createPathMap([{ role: 'download', jellyfin: null, container: join(dir, 'dl'), qbit: '/downloads' }]),
      qbittorrent: {
        torrents: async () => [{
          hash: 'H1', name: 'Heat', savePath: '/downloads', contentPath: '/downloads/Heat',
          category: null, tags: [], state: 'stalledUP', ratio: 1, seedingTimeSeconds: 1,
          isPrivate: false, trackerHost: 'x', sizeBytes: 1, progress: 1,
        }],
        files: async () => [{ index: 0, relPath: 'Heat/Heat.mkv', sizeBytes: 1 }],
      } as never,
    })
    const res = await qbittorrentPhase.run(c)
    expect(res.status).toBe('completed')
    const row = db.prepare('SELECT container_path, inode FROM torrent_files').get() as { container_path: string; inode: number }
    expect(row.container_path).toBe(file)
    expect(row.inode).toBeGreaterThan(0)
  })

  it('skips with a reason when qbittorrent is unreachable', async () => {
    const c = ctx({ qbittorrent: { torrents: async () => { throw Object.assign(new Error('down'), { kind: 'unreachable' }) } } as never })
    const res = await qbittorrentPhase.run(c)
    expect(res.status).toBe('skipped')
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
      radarr: { inventory: async () => [{ kind: 'radarr', instance: 'radarr', remoteId: 1, title: 'Heat', arrPath: '/movies/Heat.mkv', monitored: true, seriesId: null, episodeId: null, episodeFileId: null }] } as never,
      sonarr: { inventory: async () => [{ kind: 'sonarr', instance: 'sonarr', remoteId: 2, title: 'Ep', arrPath: '/tv/Ep.mkv', monitored: true, seriesId: 9, episodeId: 500, episodeFileId: 2 }] } as never,
    })
    const res = await arrPhase.run(c)
    expect(res.status).toBe('completed')
    expect(db.prepare('SELECT COUNT(*) c FROM arr_records').get()).toEqual({ c: 2 })
  })
})
