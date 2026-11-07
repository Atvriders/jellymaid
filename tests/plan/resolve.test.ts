import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, linkSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { openDb, type Db } from '../../src/index/db.js'
import { createTorrentListCache, resolveTarget } from '../../src/plan/resolve.js'
import { createPathMap, normalizeMappings } from '../../src/fs/pathmap.js'
import { fileConfigSchema } from '../../src/config/schema.js'

/** Resolutions classify companion files against the run's config; these tests use the defaults. */
const config = fileConfigSchema.parse({})
const resolve = (d: Parameters<typeof resolveTarget>[0], path: string) => resolveTarget(d, path, config)

let db: Db
let dir: string
let media: string
let linked: string

const torrent = (over: Record<string, unknown> = {}) => ({
  instanceId: 'box-a', hash: 'H1', name: 'Heat', savePath: '/downloads', contentPath: '/downloads/Heat.mkv',
  rootPath: null, category: 'movies', tags: [], state: 'stalledUP', ratio: 2, seedingTimeSeconds: 100,
  isPrivate: false, privacySource: 'flag', trackerHost: 't.example', sizeBytes: 10, progress: 1, addedOn: null, ...over,
})

type QbitDouble = { torrents?: () => Promise<Array<Record<string, unknown>>>; files?: unknown }

/** A real qBittorrent always knows its own file list, so every double gets one derived from its
 * own fixture: one file per torrent, named after its contentPath. Tests that need a multi-file
 * torrent, or a torrent whose list cannot be read, override `files` explicitly. */
function withFiles<T extends QbitDouble>(qb: T): T {
  if (!qb.files) {
    qb.files = async (hash: string) => {
      const t = (await qb.torrents!()).find((x) => x.hash === hash)
      const content = t?.contentPath as string | undefined
      return content ? [{ index: 0, relPath: content.split('/').pop()!, sizeBytes: (t?.sizeBytes as number) ?? 0 }] : []
    }
  }
  return qb
}

/**
 * Most tests describe ONE qBittorrent, instance 'box-a', through `qbittorrent` (null = none at all);
 * the multi-instance tests pass `qbittorrents` directly.
 */
function deps(over: Record<string, unknown> = {}) {
  const { qbittorrent: given, ...rest } = over
  const qbittorrent = ('qbittorrent' in over ? given : { torrents: async () => [] }) as QbitDouble | null
  const merged: Record<string, unknown> = {
    db,
    pathMap: createPathMap([
      { role: 'library', jellyfin: '/media/Movies', container: join(dir, 'lib'), qbit: null, qbitInstance: null },
      { role: 'download', jellyfin: null, container: join(dir, 'dl'), qbit: '/downloads', qbitInstance: 'box-a' },
    ]),
    qbittorrents: qbittorrent ? new Map([['box-a', { instanceId: 'box-a', ...withFiles(qbittorrent) }]]) : new Map(),
    radarr: null,
    sonarr: null,
    ...rest,
  }
  return merged as unknown as Parameters<typeof resolveTarget>[0]
}

const indexFile = (hash: string, index: number, relPath: string, containerPath: string | null, instanceId = 'box-a', sizeBytes = 1) =>
  db.prepare('INSERT INTO torrent_files (instance_id, hash, file_index, rel_path, container_path, size_bytes) VALUES (?,?,?,?,?,?)')
    .run(instanceId, hash, index, relPath, containerPath, sizeBytes)

/** One file of a TorrentFileSet, as the resolver reports it. */
const entry = (relPath: string, containerPath: string | null, sizeBytes = 1) => ({ relPath, containerPath, sizeBytes })

/** What a filesystem scan records for a file, which is how the resolver finds its other names. */
const indexLink = (path: string) =>
  db.prepare(`INSERT INTO fs_entries (container_path, scan_id, parent_path, name, is_dir, size_bytes, dev, inode, nlink, is_media, library_root, root_role)
    VALUES (?,1,'p','n',0,1,?,?,2,1,?,'library')`).run(path, ...inodeOf(path), dirname(path))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jm-resolve-'))
  db = openDb(join(dir, 'db.sqlite'))
  mkdirSync(join(dir, 'lib'), { recursive: true })
  mkdirSync(join(dir, 'dl'), { recursive: true })
  media = join(dir, 'lib', 'Heat.mkv')
  linked = join(dir, 'dl', 'Heat.mkv')
  writeFileSync(media, 'x'.repeat(500))
})

describe('resolveTarget', () => {
  it('reports a plain file with one link and no torrents', async () => {
    const r = await resolve(deps(), media)
    expect(r.exists).toBe(true)
    expect(r.sizeBytes).toBe(500)
    expect(r.nlink).toBe(1)
    expect(r.hardlinks).toEqual([media])
    expect(r.torrents).toEqual([])
  })

  it('finds every hardlink to the same inode across roots', async () => {
    linkSync(media, linked)
    db.prepare(`INSERT INTO fs_entries (container_path, scan_id, parent_path, name, is_dir, size_bytes, dev, inode, nlink, is_media, library_root, root_role)
      VALUES (?,1,'p','n',0,500,?,?,2,1,?,'library')`).run(media, ...inodeOf(media), join(dir, 'lib'))
    db.prepare(`INSERT INTO fs_entries (container_path, scan_id, parent_path, name, is_dir, size_bytes, dev, inode, nlink, is_media, library_root, root_role)
      VALUES (?,1,'p','n',0,500,?,?,2,1,?,'download')`).run(linked, ...inodeOf(linked), join(dir, 'dl'))
    const r = await resolve(deps(), media)
    expect(r.nlink).toBe(2)
    expect(r.hardlinks.sort()).toEqual([linked, media].sort())
  })

  it('matches a torrent by inode even when its path string differs', async () => {
    linkSync(media, linked)
    const r = await resolve(deps({
      qbittorrent: { torrents: async () => [torrent({ contentPath: '/downloads/Heat.mkv' })] },
    }), media)
    expect(r.torrents).toHaveLength(1)
    expect(r.torrents[0]!.matchedBy).toBe('inode')
  })

  it('matches through the torrent file list when the inode is unknown (the file is not on disk)', async () => {
    const r = await resolve(deps({
      qbittorrent: { torrents: async () => [torrent({ contentPath: '/downloads/Nope.mkv', savePath: '/downloads' })] },
    }), join(dir, 'dl', 'Nope.mkv'))
    expect(r.torrents.map((t) => t.matchedBy)).toEqual(['file'])
  })

  it('does not match a torrent that merely shares a save directory with the target', async () => {
    // savePath is the directory the torrent was saved INTO, which every other torrent saved beside
    // it shares. Matching on it alone made deleting one unrelated file in a download directory
    // resolve to a torrent that has nothing to do with it — and the executor removes matched
    // torrents WITH THEIR DATA.
    const stranger = join(dir, 'dl', 'Unrelated.mkv')
    writeFileSync(stranger, 'u')
    const r = await resolve(deps({
      qbittorrent: { torrents: async () => [torrent({ contentPath: '/downloads/Heat.mkv', savePath: '/downloads' })] },
    }), stranger)
    expect(r.torrents).toEqual([])
  })

  it('matches a file nested inside a multi-file torrent, joining its list against the save path', async () => {
    mkdirSync(join(dir, 'dl', 'Heat'), { recursive: true })
    const inside = join(dir, 'dl', 'Heat', 'CD1.mkv')
    writeFileSync(inside, 'c')
    const r = await resolve(deps({
      qbittorrent: {
        torrents: async () => [torrent({ contentPath: '/downloads/Heat', savePath: '/downloads' })],
        files: async () => [
          { index: 0, relPath: 'Heat/CD1.mkv', sizeBytes: 1 }, { index: 1, relPath: 'Heat/CD2.mkv', sizeBytes: 1 },
        ],
      },
    }), inside)
    expect(r.torrents.map((t) => t.matchedBy)).toEqual(['file'])
    expect(r.torrents[0]!.files?.count).toBe(2)
  })

  it('does not match an unrelated file in a multi-file torrent whose contentPath IS its savePath', async () => {
    // qBittorrent reports content_path === save_path for a multi-file torrent with no single
    // common root folder, which turns containment back into a bare directory prefix. The torrent's
    // own file list is the only thing that settles it.
    const stranger = join(dir, 'dl', 'Unrelated.mkv')
    writeFileSync(stranger, 'u')
    const r = await resolve(deps({
      qbittorrent: {
        torrents: async () => [torrent({ contentPath: '/downloads', savePath: '/downloads' })],
        files: async () => [
          { index: 0, relPath: 'E01.mkv', sizeBytes: 1 }, { index: 1, relPath: 'E02.mkv', sizeBytes: 1 },
        ],
      },
    }), stranger)
    expect(r.torrents).toEqual([])
  })

  it('matches a file that IS in the torrent file list, and reports the whole list', async () => {
    const episode = join(dir, 'dl', 'E02.mkv')
    writeFileSync(episode, 'e')
    const r = await resolve(deps({
      qbittorrent: {
        torrents: async () => [torrent({ contentPath: '/downloads', savePath: '/downloads' })],
        files: async () => [
          { index: 0, relPath: 'E01.mkv', sizeBytes: 1 }, { index: 1, relPath: 'E02.mkv', sizeBytes: 1 },
        ],
      },
    }), episode)
    expect(r.torrents.map((t) => t.matchedBy)).toEqual(['file'])
    expect(r.torrents[0]!.files).toEqual({
      count: 2,
      entries: [entry('E01.mkv', join(dir, 'dl', 'E01.mkv')), entry('E02.mkv', join(dir, 'dl', 'E02.mkv'))],
    })
  })

  it('prefers the indexed file list over a live fetch, matching on container_path', async () => {
    const episode = join(dir, 'dl', 'E02.mkv')
    writeFileSync(episode, 'e')
    indexFile('H1', 0, 'E01.mkv', join(dir, 'dl', 'E01.mkv'))
    indexFile('H1', 1, 'E02.mkv', episode)
    const r = await resolve(deps({
      qbittorrent: {
        torrents: async () => [torrent({ contentPath: '/downloads', savePath: '/downloads' })],
        files: async () => { throw new Error('should not be called — the index already knows') },
      },
    }), episode)
    expect(r.torrents.map((t) => t.matchedBy)).toEqual(['file'])
    expect(r.torrents[0]!.files?.count).toBe(2)
  })

  it('counts a file whose own path no mapping covers, so the file set is never understated', async () => {
    const episode = join(dir, 'dl', 'E02.mkv')
    writeFileSync(episode, 'e')
    indexFile('H1', 0, 'E01.mkv', null)
    indexFile('H1', 1, 'E02.mkv', episode)
    const r = await resolve(deps({
      qbittorrent: { torrents: async () => [torrent({ contentPath: '/downloads', savePath: '/downloads' })], files: async () => [] },
    }), episode)
    // The unmapped file keeps its place in the list, with no container path, so it is still counted.
    expect(r.torrents[0]!.files).toEqual({ count: 2, entries: [entry('E01.mkv', null), entry('E02.mkv', episode)] })
  })

  it('does not read an INDEXED list of unmapped files as proof the torrent does not own the target', async () => {
    // The qBittorrent phase writes NULL container_path for every file of a torrent whose savePath
    // did not map at scan time. Add the download mapping afterwards and, until the next scan, the
    // indexed list is non-empty but names nothing — and its NULL dev/inode means the inode join
    // cannot rescue it either. Concluding "not this torrent's file" there unlinks a file
    // qBittorrent is actively seeding, with no guard in the chain ever running.
    mkdirSync(join(dir, 'dl', 'Pack'), { recursive: true })
    const episode = join(dir, 'dl', 'Pack', 'E01.mkv')
    writeFileSync(episode, 'e')
    indexFile('H1', 0, 'Pack/E01.mkv', null)
    indexFile('H1', 1, 'Pack/E02.mkv', null)
    const r = await resolve(deps({
      qbittorrent: {
        torrents: async () => [torrent({ contentPath: '/downloads/Pack', savePath: '/downloads' })],
        files: async () => { throw new Error('qbit 500') },
      },
    }), episode)
    expect(r.torrents.map((t) => t.matchedBy)).toEqual(['path'])
  })

  it('does not read a LIVE list whose save path is unmappable as proof of non-ownership', async () => {
    // contentPath maps but savePath does not, so every relPath joins onto nothing: a non-zero count
    // with zero usable paths. Same trap, reached live rather than through the index.
    mkdirSync(join(dir, 'dl', 'Pack'), { recursive: true })
    const episode = join(dir, 'dl', 'Pack', 'E01.mkv')
    writeFileSync(episode, 'e')
    const r = await resolve(deps({
      qbittorrent: {
        torrents: async () => [torrent({ contentPath: '/downloads/Pack', savePath: '/elsewhere' })],
        files: async () => [
          { index: 0, relPath: 'Pack/E01.mkv', sizeBytes: 1 }, { index: 1, relPath: 'Pack/E02.mkv', sizeBytes: 1 },
        ],
      },
    }), episode)
    expect(r.torrents.map((t) => t.matchedBy)).toEqual(['path'])
  })

  it('re-checks live when a stale indexed list does not name the target', async () => {
    mkdirSync(join(dir, 'dl', 'Pack'), { recursive: true })
    const episode = join(dir, 'dl', 'Pack', 'E02.mkv')
    writeFileSync(episode, 'e')
    // The index knows one file; qBittorrent has since added the one being deleted.
    indexFile('H1', 0, 'Pack/E01.mkv', join(dir, 'dl', 'Pack', 'E01.mkv'))
    const r = await resolve(deps({
      qbittorrent: {
        torrents: async () => [torrent({ contentPath: '/downloads/Pack', savePath: '/downloads' })],
        files: async () => [
          { index: 0, relPath: 'Pack/E01.mkv', sizeBytes: 1 }, { index: 1, relPath: 'Pack/E02.mkv', sizeBytes: 1 },
        ],
      },
    }), episode)
    expect(r.torrents.map((t) => t.matchedBy)).toEqual(['file'])
    expect(r.torrents[0]!.files?.count).toBe(2)
  })

  it('falls back to path containment, flagged as such, only when the file list cannot be read', async () => {
    const inside = join(dir, 'dl', 'Heat', 'CD1.mkv')
    mkdirSync(join(dir, 'dl', 'Heat'), { recursive: true })
    writeFileSync(inside, 'c')
    const r = await resolve(deps({
      qbittorrent: {
        torrents: async () => [torrent({ contentPath: '/downloads/Heat', savePath: '/downloads' })],
        files: async () => { throw new Error('qbit 500') },
      },
    }), inside)
    expect(r.torrents.map((t) => t.matchedBy)).toEqual(['path'])
    expect(r.torrents[0]!.files).toBeNull()
  })

  it('finds two torrents on one inode — the cross-seed case', async () => {
    linkSync(media, linked)
    const r = await resolve(deps({
      qbittorrent: { torrents: async () => [torrent({ hash: 'A' }), torrent({ hash: 'B' })] },
    }), media)
    expect(r.torrents.map((t) => t.hash).sort()).toEqual(['A', 'B'])
  })

  it("carries the torrent's size and counts the companion files of its list", async () => {
    mkdirSync(join(dir, 'dl', 'Heat'), { recursive: true })
    const movie = join(dir, 'dl', 'Heat', 'Heat.mkv')
    writeFileSync(movie, 'm')
    const r = await resolve(deps({
      qbittorrent: {
        torrents: async () => [torrent({ contentPath: '/downloads/Heat', savePath: '/downloads', sizeBytes: 9_000 })],
        files: async () => [
          { index: 0, relPath: 'Heat/Heat.mkv', sizeBytes: 8_000 },
          { index: 1, relPath: 'Heat/Heat.nfo', sizeBytes: 10 },
          { index: 2, relPath: 'Heat/Sample/sample.mkv', sizeBytes: 500 },
        ],
      },
    }), movie)
    expect(r.torrents[0]!.sizeBytes).toBe(9_000)
    expect(r.torrents[0]!.companionCount).toBe(2)
  })

  it('reports no companion count for a torrent whose file list could not be read', async () => {
    mkdirSync(join(dir, 'dl', 'Heat'), { recursive: true })
    const movie = join(dir, 'dl', 'Heat', 'Heat.mkv')
    writeFileSync(movie, 'm')
    const r = await resolve(deps({
      qbittorrent: {
        torrents: async () => [torrent({ contentPath: '/downloads/Heat', savePath: '/downloads' })],
        files: async () => { throw new Error('qbit 500') },
      },
    }), movie)
    expect(r.torrents[0]!.files).toBeNull()
    expect(r.torrents[0]!.companionCount).toBeNull()
  })

  it('carries privacySource through onto the torrent match, for the guard that reads it', async () => {
    linkSync(media, linked)
    const r = await resolve(deps({
      qbittorrent: { torrents: async () => [torrent({ isPrivate: true, privacySource: 'undetermined' })] },
    }), media)
    expect(r.torrents[0]!.isPrivate).toBe(true)
    expect(r.torrents[0]!.privacySource).toBe('undetermined')
  })

  it('matches *arr records by path', async () => {
    const r = await resolve(deps({
      radarr: { inventory: async () => ({
        // A real *arr path lives in the Jellyfin-style namespace the path map translates, not
        // already in container space — see the "does not match an untranslated path" test below
        // for why a raw container-space string must NOT be treated as an equivalent stand-in.
        records: [{ kind: 'radarr', instance: 'radarr', remoteId: 5, title: 'Heat', arrPath: '/media/Movies/Heat.mkv', monitored: true, seriesId: null, episodeId: null, episodeFileId: null }],
        complete: true,
      }) },
    }), media)
    // `arrPath` is carried verbatim beside the translated container path: it is the string the
    // connector's own unmonitorByPath matches on, and the executor must hand back exactly it.
    expect(r.arr).toEqual([
      { kind: 'radarr', instance: 'radarr', remoteId: 5, title: 'Heat', path: media, arrPath: '/media/Movies/Heat.mkv' },
    ])
  })

  it('produces no ArrMatch for an *arr path that fails to translate, even when the raw string equals a real container path elsewhere', async () => {
    const r = await resolve(deps({
      // arrPath here is a bare container-space string (in fact the target's own path) rather than
      // anything the configured map translates. Falling back to using it as-is would produce a
      // FALSE match — flipping `monitored: false` on an unrelated title and reporting a false
      // "arr-managed" hit — so an untranslated path must match nothing at all.
      radarr: { inventory: async () => ({
        records: [{ kind: 'radarr', instance: 'radarr', remoteId: 7, title: 'Unrelated', arrPath: media, monitored: true, seriesId: null, episodeId: null, episodeFileId: null }],
        complete: true,
      }) },
    }), media)
    expect(r.arr).toEqual([])
  })

  it('records an unreachable service in sourcesUnavailable instead of pretending there are no torrents', async () => {
    const downloaded = join(dir, 'dl', 'Heat.mkv')
    writeFileSync(downloaded, 'd')
    const r = await resolve(deps({
      qbittorrent: { torrents: async () => { throw Object.assign(new Error('down'), { kind: 'unreachable' }) } },
    }), downloaded)
    expect(r.torrents).toEqual([])
    // Labelled with the instance that failed, so the guard can say which box to look at.
    expect(r.sourcesUnavailable).toEqual(['qbittorrent:box-a'])
  })

  it('reports the owning instance unavailable when no client is configured for it', async () => {
    const downloaded = join(dir, 'dl', 'Heat.mkv')
    writeFileSync(downloaded, 'd')
    const r = await resolve(deps({ qbittorrent: null }), downloaded)
    expect(r.sourcesUnavailable).toEqual(['qbittorrent:box-a'])
  })

  it('asks no instance at all about a root that is explicitly not torrent-backed', async () => {
    let asked = 0
    const r = await resolve(deps({ qbittorrent: { torrents: async () => { asked += 1; return [torrent()] } } }), media)
    expect(asked).toBe(0)
    expect(r.torrents).toEqual([])
    expect(r.sourcesUnavailable).toEqual([])
  })

  it('reports a missing file as exists false rather than throwing', async () => {
    const r = await resolve(deps(), join(dir, 'lib', 'Ghost.mkv'))
    expect(r.exists).toBe(false)
    expect(r.sizeBytes).toBe(0)
  })

  it('identifies the root that contains the path', async () => {
    const r = await resolve(deps(), media)
    expect(r.root?.role).toBe('library')
  })

  // --- NULL-inode correlation: (dev, inode) is the only correlation key, and a NULL inode must
  // never be treated as matching anything, including another NULL. ---

  it('never treats an unstattable fs_entries row (NULL dev/inode) as a hardlink of a real file', async () => {
    linkSync(media, linked)
    db.prepare(`INSERT INTO fs_entries (container_path, scan_id, parent_path, name, is_dir, size_bytes, dev, inode, nlink, is_media, library_root, root_role)
      VALUES (?,1,'p','n',0,500,?,?,2,1,?,'library')`).run(media, ...inodeOf(media), join(dir, 'lib'))
    db.prepare(`INSERT INTO fs_entries (container_path, scan_id, parent_path, name, is_dir, size_bytes, dev, inode, nlink, is_media, library_root, root_role)
      VALUES (?,1,'p','n',0,500,?,?,2,1,?,'download')`).run(linked, ...inodeOf(linked), join(dir, 'dl'))
    // A third file the walker could not stat: NULL dev/inode/nlink, never 0/0 — the value a bad
    // implementation might substitute, which WOULD collide with another unstattable row.
    db.prepare(`INSERT INTO fs_entries (container_path, scan_id, parent_path, name, is_dir, size_bytes, dev, inode, nlink, is_media, library_root, root_role)
      VALUES (?,1,'p','n',0,500,NULL,NULL,NULL,1,?,'library')`).run(join(dir, 'lib', 'Unreadable.mkv'), join(dir, 'lib'))
    const r = await resolve(deps(), media)
    expect(r.hardlinks.sort()).toEqual([linked, media].sort())
    expect(r.hardlinks).not.toContain(join(dir, 'lib', 'Unreadable.mkv'))
  })

  // --- Partial *arr inventory: `complete: false` means part of the library was never read, so
  // "not found in it" must not be reported as "genuinely not managed". ---

  it('flags a partial *arr inventory as unavailable rather than reporting the file as unmanaged', async () => {
    const r = await resolve(deps({
      sonarr: { inventory: async () => ({ records: [], complete: false }) },
    }), media)
    expect(r.arr).toEqual([])
    expect(r.sourcesUnavailable).toContain('sonarr')
  })

  it('still reports a match found inside a partial inventory, alongside flagging it unverifiable', async () => {
    const r = await resolve(deps({
      sonarr: { inventory: async () => ({
        records: [{ kind: 'sonarr', instance: 'sonarr', remoteId: 9, title: 'Heat S1E1', arrPath: '/media/Movies/Heat.mkv', monitored: true, seriesId: 1, episodeId: 2, episodeFileId: 9 }],
        complete: false,
      }) },
    }), media)
    expect(r.arr).toEqual([
      { kind: 'sonarr', instance: 'sonarr', remoteId: 9, title: 'Heat S1E1', path: media, arrPath: '/media/Movies/Heat.mkv' },
    ])
    expect(r.sourcesUnavailable).toContain('sonarr')
  })

  it('counts an *arr record whose path namespace no mapping covers, rather than reading it as unmanaged', async () => {
    // PathMapping has no *arr field: *arr paths are translated through the Jellyfin prefix. A
    // Radarr that reports a namespace no mapping covers therefore produces no ArrMatch at all,
    // while `complete` stays true — "not in the list" is indistinguishable from "not managed"
    // unless the untranslatable records are counted.
    const r = await resolve(deps({
      radarr: { inventory: async () => ({
        records: [
          { kind: 'radarr', instance: 'radarr', remoteId: 1, title: 'Heat', arrPath: '/data/movies/Heat.mkv', monitored: true, seriesId: null, episodeId: null, episodeFileId: null },
          { kind: 'radarr', instance: 'radarr', remoteId: 2, title: 'Ronin', arrPath: '/data/movies/Ronin.mkv', monitored: true, seriesId: null, episodeId: null, episodeFileId: null },
        ],
        complete: true,
      }) },
    }), media)
    expect(r.arr).toEqual([])
    expect(r.arrUnmappable.count).toBe(2)
    expect(r.arrUnmappable.samples).toContain('/data/movies/Heat.mkv')
  })

  it('reports no unmappable *arr records when every path translates', async () => {
    const r = await resolve(deps({
      radarr: { inventory: async () => ({
        records: [{ kind: 'radarr', instance: 'radarr', remoteId: 1, title: 'Heat', arrPath: '/media/Movies/Heat.mkv', monitored: true, seriesId: null, episodeId: null, episodeFileId: null }],
        complete: true,
      }) },
    }), media)
    expect(r.arrUnmappable.count).toBe(0)
  })

  it('marks a directory target as one, so link counts are not reported as if it were a file', async () => {
    const r = await resolve(deps(), join(dir, 'lib'))
    expect(r.isDirectory).toBe(true)
    expect((await resolve(deps(), media)).isDirectory).toBe(false)
  })

  it('does not flag radarr/sonarr unavailable when both are simply unconfigured (null is a legitimate "not used")', async () => {
    const r = await resolve(deps(), media)
    expect(r.sourcesUnavailable).toEqual([])
  })

  // --- Two qBittorrent instances whose paths overlap: both call their library /movies. ---

  describe('multiple instances', () => {
    const boxes = () => createPathMap([
      { role: 'library', jellyfin: '/data/a', container: join(dir, 'a'), qbit: '/movies', qbitInstance: 'box-a' },
      { role: 'library', jellyfin: '/data/b', container: join(dir, 'b'), qbit: '/movies', qbitInstance: 'box-b' },
      { role: 'library', jellyfin: '/media/Movies', container: join(dir, 'lib'), qbit: null, qbitInstance: null },
    ])
    const onBox = (id: string, list: () => Promise<Array<Record<string, unknown>>>, asked: string[]) => ({
      instanceId: id,
      torrents: async () => { asked.push(id); return list() },
      files: async (hash: string) => {
        const t = (await list()).find((x) => x.hash === hash)
        return t ? [{ index: 0, relPath: String(t.contentPath).split('/').pop()!, sizeBytes: 1 }] : []
      },
    })
    let target: string

    beforeEach(() => {
      mkdirSync(join(dir, 'a'), { recursive: true })
      mkdirSync(join(dir, 'b'), { recursive: true })
      writeFileSync(join(dir, 'a', 'X.mkv'), 'a-copy')
      target = join(dir, 'b', 'X.mkv')
      writeFileSync(target, 'b-copy')
    })

    it('resolver asks only the instance from torrentSourceFor', async () => {
      const asked: string[] = []
      const same = (id: string) => torrent({ instanceId: id, hash: 'same', savePath: '/movies', contentPath: '/movies/X.mkv' })
      const r = await resolve(deps({
        pathMap: boxes(),
        qbittorrents: new Map([
          ['box-a', onBox('box-a', async () => [same('box-a')], asked)],
          ['box-b', onBox('box-b', async () => [same('box-b')], asked)],
        ]),
      }), target)
      // Box B's root can only hold box B's torrents. Box A is not asked at all, so box A being down
      // could never block a delete on box B.
      expect(asked).toEqual(['box-b'])
      expect(r.torrents.map((t) => [t.instanceId, t.hash])).toEqual([['box-b', 'same']])
      expect(r.torrents[0]!.files).toEqual({ count: 1, entries: [entry('X.mkv', target)] })
      expect(r.sourcesUnavailable).toEqual([])
    })

    it("reads only the owning instance's index rows for a hash both instances have", async () => {
      indexFile('same', 0, 'X.mkv', join(dir, 'a', 'X.mkv'), 'box-a')
      indexFile('same', 0, 'X.mkv', target, 'box-b')
      const r = await resolve(deps({
        pathMap: boxes(),
        qbittorrents: new Map([
          ['box-a', onBox('box-a', async () => [torrent({ instanceId: 'box-a', hash: 'same', savePath: '/movies', contentPath: '/movies' })], [])],
          ['box-b', onBox('box-b', async () => [torrent({ instanceId: 'box-b', hash: 'same', savePath: '/movies', contentPath: '/movies' })], [])],
        ]),
      }), target)
      expect(r.torrents.map((t) => t.instanceId)).toEqual(['box-b'])
      expect(r.torrents[0]!.matchedBy).toBe('file')
      expect(r.torrents[0]!.files).toEqual({ count: 1, entries: [entry('X.mkv', target)] })
    })

    it('resolver marks qbittorrent:<id> unavailable when that instance throws or has no client', async () => {
      const healthyA = onBox('box-a', async () => [torrent({ instanceId: 'box-a', hash: 'h1', savePath: '/movies', contentPath: '/movies/X.mkv' })], [])
      const throws = await resolve(deps({
        pathMap: boxes(),
        qbittorrents: new Map([
          ['box-a', healthyA],
          ['box-b', onBox('box-b', async () => { throw new Error('connection refused') }, [])],
        ]),
      }), target)
      expect(throws.sourcesUnavailable).toEqual(['qbittorrent:box-b'])
      expect(throws.torrents).toEqual([])

      // A mapping naming an instance with no client — box-b is not configured at all.
      const missing = await resolve(deps({ pathMap: boxes(), qbittorrents: new Map([['box-a', healthyA]]) }), target)
      expect(missing.sourcesUnavailable).toEqual(['qbittorrent:box-b'])
      expect(missing.torrents).toEqual([])
    })

    it('resolver marks qbittorrent unavailable for a root with an unknown instance', async () => {
      // A config written before multi-instance support: a qbit prefix and no instance. With two
      // instances there is no telling whose torrents live there, so normalizeMappings leaves the hole.
      const { mappings, problems } = normalizeMappings([
        { role: 'library', jellyfin: '/data/b', container: join(dir, 'b'), qbit: '/movies', qbitInstance: null },
      ], ['box-a', 'box-b'])
      expect(problems).toHaveLength(1)
      const asked: string[] = []
      const r = await resolve(deps({
        pathMap: createPathMap(mappings),
        qbittorrents: new Map([
          ['box-a', onBox('box-a', async () => [], asked)],
          ['box-b', onBox('box-b', async () => [], asked)],
        ]),
      }), target)
      expect(r.torrentSource).toMatchObject({ kind: 'unknown' })
      expect(r.sourcesUnavailable).toEqual(['qbittorrent'])
      expect(asked).toEqual([])
    })

    it("asks the instance of each indexed hardlink's root, and no other", async () => {
      // The *arr layout: the library copy sits in a root no torrent saves into, and its other name
      // in box A's root is the torrent's own file. Only box A can own these bytes.
      const inLib = join(dir, 'lib', 'Y.mkv')
      const inA = join(dir, 'a', 'Y.mkv')
      writeFileSync(inLib, 'y')
      linkSync(inLib, inA)
      indexLink(inLib); indexLink(inA)
      const asked: string[] = []
      const r = await resolve(deps({
        pathMap: boxes(),
        qbittorrents: new Map([
          ['box-a', onBox('box-a', async () => [torrent({ instanceId: 'box-a', hash: 'ya', savePath: '/movies', contentPath: '/movies/Y.mkv' })], asked)],
          ['box-b', onBox('box-b', async () => [], asked)],
        ]),
      }), inLib)
      expect(asked).toEqual(['box-a'])
      expect(r.torrents.map((t) => [t.instanceId, t.matchedBy])).toEqual([['box-a', 'inode']])
    })

    it('asks every instance about a hardlinked file whose other names the index cannot place', async () => {
      // nlink says there is another name, and no scan has seen it yet: it could lie under any root.
      const inLib = join(dir, 'lib', 'Y.mkv')
      writeFileSync(inLib, 'y')
      linkSync(inLib, join(dir, 'b', 'Y.mkv'))
      const asked: string[] = []
      const r = await resolve(deps({
        pathMap: boxes(),
        qbittorrents: new Map([
          ['box-a', onBox('box-a', async () => [], asked)],
          ['box-b', onBox('box-b', async () => [torrent({ instanceId: 'box-b', hash: 'yb', savePath: '/movies', contentPath: '/movies/Y.mkv' })], asked)],
        ]),
      }), inLib)
      expect(asked.sort()).toEqual(['box-a', 'box-b'])
      expect(r.torrents.map((t) => [t.instanceId, t.matchedBy])).toEqual([['box-b', 'inode']])
    })

    it('also asks an instance the index records as owning these exact bytes', async () => {
      // Box A's own rows claim a file under box B's root (a stale scan, or nested roots). That is
      // evidence box A may own it, so box A is asked too rather than its claim being ignored.
      indexFile('ha', 0, 'X.mkv', target, 'box-a')
      const asked: string[] = []
      await resolve(deps({
        pathMap: boxes(),
        qbittorrents: new Map([
          ['box-a', onBox('box-a', async () => [], asked)],
          ['box-b', onBox('box-b', async () => [], asked)],
        ]),
      }), target)
      expect(asked.sort()).toEqual(['box-a', 'box-b'])
    })

    it('carries the torrent source of the target, per its root', async () => {
      const d = deps({ pathMap: boxes(), qbittorrents: new Map() })
      expect((await resolve(d, target)).torrentSource).toEqual({ kind: 'instance', instanceId: 'box-b' })
      expect((await resolve(d, media)).torrentSource).toEqual({ kind: 'none' })
      expect((await resolve(d, '/elsewhere/Z.mkv')).torrentSource).toMatchObject({ kind: 'unknown' })
    })
  })

  // --- Jellyfin ownership: a merged item's alternate version has no jellyfin_items row of its
  // own, only a jellyfin_item_paths row, so the executor needs a way to tell "primary" from
  // "alternate" apart rather than deleting the alternate as if it were an ordinary orphan. ---

  describe('jellyfin ownership', () => {
    const altPath = () => join(dir, 'lib', 'Heat-remux.mkv')

    function seedMergedItem() {
      writeFileSync(altPath(), 'y'.repeat(500))
      db.prepare('INSERT INTO jellyfin_items (id, scan_id, type, name, container_path) VALUES (?,1,?,?,?)')
        .run('item1', 'Movie', 'Heat', media)
      // Mirrors what the jellyfin scan phase actually writes: one jellyfin_item_paths row per
      // MediaSources[] entry, INCLUDING the primary path, not just the alternates.
      db.prepare('INSERT INTO jellyfin_item_paths (item_id, scan_id, jf_path, container_path) VALUES (?,1,?,?)')
        .run('item1', '/media/Movies/Heat.mkv', media)
      db.prepare('INSERT INTO jellyfin_item_paths (item_id, scan_id, jf_path, container_path) VALUES (?,1,?,?)')
        .run('item1', '/media/Movies/Heat-remux.mkv', altPath())
    }

    it('resolves the primary path as not-an-alternate and lists the alternate as a sibling', async () => {
      seedMergedItem()
      const r = await resolve(deps(), media)
      expect(r.jellyfin).toEqual({ itemId: 'item1', isAlternateVersion: false, siblingPaths: [altPath()] })
    })

    it('resolves an alternate path to the same item, flagged as an alternate, listing the primary as a sibling', async () => {
      seedMergedItem()
      const r = await resolve(deps(), altPath())
      expect(r.jellyfin).toEqual({ itemId: 'item1', isAlternateVersion: true, siblingPaths: [media] })
    })

    it('resolves a path in neither table to no item at all', async () => {
      const r = await resolve(deps(), media)
      expect(r.jellyfin).toEqual({ itemId: null, isAlternateVersion: false, siblingPaths: [] })
    })
  })
})

describe('createTorrentListCache', () => {
  type Listed = Parameters<ReturnType<typeof createTorrentListCache>['get']>[0]
  function counted(instanceId: string, list: () => Promise<unknown[]> = async () => []) {
    const client = { instanceId, fetches: 0, torrents: async () => { client.fetches += 1; return list() } }
    return client as typeof client & Listed
  }

  it('serves one list per instance until it is older than maxAgeMs', async () => {
    let now = 1_000
    const cache = createTorrentListCache({ maxAgeMs: 10_000, now: () => now })
    const a = counted('box-a')
    const b = counted('box-b')
    await cache.get(a); await cache.get(a); await cache.get(b)
    expect([a.fetches, b.fetches]).toEqual([1, 1])
    now += 9_999
    await cache.get(a)
    expect(a.fetches).toBe(1)
    now += 1
    await cache.get(a)
    expect(a.fetches).toBe(2)
  })

  it("invalidate drops one instance's list and keeps the others", async () => {
    const cache = createTorrentListCache({ maxAgeMs: Number.POSITIVE_INFINITY })
    const a = counted('box-a')
    const b = counted('box-b')
    await cache.get(a); await cache.get(b)
    cache.invalidate('box-a')
    await cache.get(a); await cache.get(b)
    expect([a.fetches, b.fetches]).toEqual([2, 1])
  })

  it('never remembers a failed fetch — an outage is retried, not served for the rest of the window', async () => {
    let up = false
    const a = counted('box-a', async () => { if (!up) throw new Error('connection refused'); return [] })
    const cache = createTorrentListCache({ maxAgeMs: Number.POSITIVE_INFINITY })
    await expect(cache.get(a)).rejects.toThrow('connection refused')
    up = true
    await expect(cache.get(a)).resolves.toEqual([])
    expect(a.fetches).toBe(2)
  })

  it('shares one fetch between callers that ask at the same time', async () => {
    const a = counted('box-a')
    const cache = createTorrentListCache({ maxAgeMs: Number.POSITIVE_INFINITY })
    await Promise.all([cache.get(a), cache.get(a), cache.get(a)])
    expect(a.fetches).toBe(1)
  })

  it('is what a resolution reads when it is given one, instead of the client', async () => {
    const downloaded = join(dir, 'dl', 'Heat.mkv')
    writeFileSync(downloaded, 'd')
    let fetches = 0
    const d = deps({
      qbittorrent: { torrents: async () => { fetches += 1; return [] } },
      torrentLists: createTorrentListCache({ maxAgeMs: Number.POSITIVE_INFINITY }),
    })
    await resolve(d, downloaded)
    await resolve(d, downloaded)
    expect(fetches).toBe(1)
  })
})

function inodeOf(path: string): [number, number] {
  const s = statSync(path)
  return [Number(s.dev), Number(s.ino)]
}
