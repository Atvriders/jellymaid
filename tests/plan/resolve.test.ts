import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, linkSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../src/index/db.js'
import { resolveTarget } from '../../src/plan/resolve.js'
import { createPathMap } from '../../src/fs/pathmap.js'

let db: Db
let dir: string
let media: string
let linked: string

const torrent = (over: Record<string, unknown> = {}) => ({
  hash: 'H1', name: 'Heat', savePath: '/downloads', contentPath: '/downloads/Heat.mkv',
  category: 'movies', tags: [], state: 'stalledUP', ratio: 2, seedingTimeSeconds: 100,
  isPrivate: false, privacySource: 'flag', trackerHost: 't.example', sizeBytes: 10, progress: 1, ...over,
})

function deps(over: Record<string, unknown> = {}) {
  const merged: Record<string, unknown> = {
    db,
    pathMap: createPathMap([
      { role: 'library', jellyfin: '/media/Movies', container: join(dir, 'lib'), qbit: null },
      { role: 'download', jellyfin: null, container: join(dir, 'dl'), qbit: '/downloads' },
    ]),
    qbittorrent: { torrents: async () => [] },
    radarr: null,
    sonarr: null,
    ...over,
  }
  // A real qBittorrent always knows its own file list, so every double gets one derived from its
  // own fixture: one file per torrent, named after its contentPath. Tests that need a multi-file
  // torrent, or a torrent whose list cannot be read, override `files` explicitly.
  const qb = merged.qbittorrent as { torrents?: () => Promise<Array<Record<string, unknown>>>; files?: unknown } | null
  if (qb && !qb.files) {
    qb.files = async (hash: string) => {
      const t = (await qb.torrents!()).find((x) => x.hash === hash)
      const content = t?.contentPath as string | undefined
      return content ? [{ index: 0, relPath: content.split('/').pop()!, sizeBytes: (t?.sizeBytes as number) ?? 0 }] : []
    }
  }
  return merged as unknown as Parameters<typeof resolveTarget>[0]
}

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
    const r = await resolveTarget(deps(), media)
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
    const r = await resolveTarget(deps(), media)
    expect(r.nlink).toBe(2)
    expect(r.hardlinks.sort()).toEqual([linked, media].sort())
  })

  it('matches a torrent by inode even when its path string differs', async () => {
    linkSync(media, linked)
    const r = await resolveTarget(deps({
      qbittorrent: { torrents: async () => [torrent({ contentPath: '/downloads/Heat.mkv' })] },
    }), media)
    expect(r.torrents).toHaveLength(1)
    expect(r.torrents[0]!.matchedBy).toBe('inode')
  })

  it('matches through the torrent file list when the inode is unknown (the file is not on disk)', async () => {
    const r = await resolveTarget(deps({
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
    const r = await resolveTarget(deps({
      qbittorrent: { torrents: async () => [torrent({ contentPath: '/downloads/Heat.mkv', savePath: '/downloads' })] },
    }), stranger)
    expect(r.torrents).toEqual([])
  })

  it('matches a file nested inside a multi-file torrent, joining its list against the save path', async () => {
    mkdirSync(join(dir, 'dl', 'Heat'), { recursive: true })
    const inside = join(dir, 'dl', 'Heat', 'CD1.mkv')
    writeFileSync(inside, 'c')
    const r = await resolveTarget(deps({
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
    const r = await resolveTarget(deps({
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
    const r = await resolveTarget(deps({
      qbittorrent: {
        torrents: async () => [torrent({ contentPath: '/downloads', savePath: '/downloads' })],
        files: async () => [
          { index: 0, relPath: 'E01.mkv', sizeBytes: 1 }, { index: 1, relPath: 'E02.mkv', sizeBytes: 1 },
        ],
      },
    }), episode)
    expect(r.torrents.map((t) => t.matchedBy)).toEqual(['file'])
    expect(r.torrents[0]!.files).toEqual({ count: 2, paths: [join(dir, 'dl', 'E01.mkv'), join(dir, 'dl', 'E02.mkv')] })
  })

  it('prefers the indexed file list over a live fetch, matching on container_path', async () => {
    const episode = join(dir, 'dl', 'E02.mkv')
    writeFileSync(episode, 'e')
    db.prepare('INSERT INTO torrent_files (hash, file_index, rel_path, container_path, size_bytes) VALUES (?,?,?,?,?)')
      .run('H1', 0, 'E01.mkv', join(dir, 'dl', 'E01.mkv'), 1)
    db.prepare('INSERT INTO torrent_files (hash, file_index, rel_path, container_path, size_bytes) VALUES (?,?,?,?,?)')
      .run('H1', 1, 'E02.mkv', episode, 1)
    const r = await resolveTarget(deps({
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
    db.prepare('INSERT INTO torrent_files (hash, file_index, rel_path, container_path, size_bytes) VALUES (?,?,?,?,?)')
      .run('H1', 0, 'E01.mkv', null, 1)
    db.prepare('INSERT INTO torrent_files (hash, file_index, rel_path, container_path, size_bytes) VALUES (?,?,?,?,?)')
      .run('H1', 1, 'E02.mkv', episode, 1)
    const r = await resolveTarget(deps({
      qbittorrent: { torrents: async () => [torrent({ contentPath: '/downloads', savePath: '/downloads' })], files: async () => [] },
    }), episode)
    expect(r.torrents[0]!.files).toEqual({ count: 2, paths: [episode] })
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
    db.prepare('INSERT INTO torrent_files (hash, file_index, rel_path, container_path, size_bytes) VALUES (?,?,?,?,?)')
      .run('H1', 0, 'Pack/E01.mkv', null, 1)
    db.prepare('INSERT INTO torrent_files (hash, file_index, rel_path, container_path, size_bytes) VALUES (?,?,?,?,?)')
      .run('H1', 1, 'Pack/E02.mkv', null, 1)
    const r = await resolveTarget(deps({
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
    const r = await resolveTarget(deps({
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
    db.prepare('INSERT INTO torrent_files (hash, file_index, rel_path, container_path, size_bytes) VALUES (?,?,?,?,?)')
      .run('H1', 0, 'Pack/E01.mkv', join(dir, 'dl', 'Pack', 'E01.mkv'), 1)
    const r = await resolveTarget(deps({
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
    const r = await resolveTarget(deps({
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
    const r = await resolveTarget(deps({
      qbittorrent: { torrents: async () => [torrent({ hash: 'A' }), torrent({ hash: 'B' })] },
    }), media)
    expect(r.torrents.map((t) => t.hash).sort()).toEqual(['A', 'B'])
  })

  it('carries privacySource through onto the torrent match, for the guard that reads it', async () => {
    linkSync(media, linked)
    const r = await resolveTarget(deps({
      qbittorrent: { torrents: async () => [torrent({ isPrivate: true, privacySource: 'undetermined' })] },
    }), media)
    expect(r.torrents[0]!.isPrivate).toBe(true)
    expect(r.torrents[0]!.privacySource).toBe('undetermined')
  })

  it('matches *arr records by path', async () => {
    const r = await resolveTarget(deps({
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
    const r = await resolveTarget(deps({
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
    const r = await resolveTarget(deps({
      qbittorrent: { torrents: async () => { throw Object.assign(new Error('down'), { kind: 'unreachable' }) } },
    }), media)
    expect(r.torrents).toEqual([])
    expect(r.sourcesUnavailable).toContain('qbittorrent')
  })

  it('reports a missing file as exists false rather than throwing', async () => {
    const r = await resolveTarget(deps(), join(dir, 'lib', 'Ghost.mkv'))
    expect(r.exists).toBe(false)
    expect(r.sizeBytes).toBe(0)
  })

  it('identifies the root that contains the path', async () => {
    const r = await resolveTarget(deps(), media)
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
    const r = await resolveTarget(deps(), media)
    expect(r.hardlinks.sort()).toEqual([linked, media].sort())
    expect(r.hardlinks).not.toContain(join(dir, 'lib', 'Unreadable.mkv'))
  })

  // --- Partial *arr inventory: `complete: false` means part of the library was never read, so
  // "not found in it" must not be reported as "genuinely not managed". ---

  it('flags a partial *arr inventory as unavailable rather than reporting the file as unmanaged', async () => {
    const r = await resolveTarget(deps({
      sonarr: { inventory: async () => ({ records: [], complete: false }) },
    }), media)
    expect(r.arr).toEqual([])
    expect(r.sourcesUnavailable).toContain('sonarr')
  })

  it('still reports a match found inside a partial inventory, alongside flagging it unverifiable', async () => {
    const r = await resolveTarget(deps({
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
    const r = await resolveTarget(deps({
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
    const r = await resolveTarget(deps({
      radarr: { inventory: async () => ({
        records: [{ kind: 'radarr', instance: 'radarr', remoteId: 1, title: 'Heat', arrPath: '/media/Movies/Heat.mkv', monitored: true, seriesId: null, episodeId: null, episodeFileId: null }],
        complete: true,
      }) },
    }), media)
    expect(r.arrUnmappable.count).toBe(0)
  })

  it('marks a directory target as one, so link counts are not reported as if it were a file', async () => {
    const r = await resolveTarget(deps(), join(dir, 'lib'))
    expect(r.isDirectory).toBe(true)
    expect((await resolveTarget(deps(), media)).isDirectory).toBe(false)
  })

  it('does not flag radarr/sonarr unavailable when both are simply unconfigured (null is a legitimate "not used")', async () => {
    const r = await resolveTarget(deps(), media)
    expect(r.sourcesUnavailable).toEqual([])
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
      const r = await resolveTarget(deps(), media)
      expect(r.jellyfin).toEqual({ itemId: 'item1', isAlternateVersion: false, siblingPaths: [altPath()] })
    })

    it('resolves an alternate path to the same item, flagged as an alternate, listing the primary as a sibling', async () => {
      seedMergedItem()
      const r = await resolveTarget(deps(), altPath())
      expect(r.jellyfin).toEqual({ itemId: 'item1', isAlternateVersion: true, siblingPaths: [media] })
    })

    it('resolves a path in neither table to no item at all', async () => {
      const r = await resolveTarget(deps(), media)
      expect(r.jellyfin).toEqual({ itemId: null, isAlternateVersion: false, siblingPaths: [] })
    })
  })
})

function inodeOf(path: string): [number, number] {
  const s = statSync(path)
  return [Number(s.dev), Number(s.ino)]
}
