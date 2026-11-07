import { statSync } from 'node:fs'
import { join, posix } from 'node:path'
import type { QbitClient, Torrent, TorrentFile } from '../../connectors/qbittorrent.js'
import type { Phase, PhaseResult } from './types.js'
import { describeError } from './types.js'

interface FileRow {
  index: number
  relPath: string
  containerPath: string | null
  sizeBytes: number
  dev: number | null
  inode: number | null
  isDir: boolean
}

/** One torrent file as the index stores it, with the container file's identity when it can be read. */
function fileRow(base: string | null, f: TorrentFile): FileRow {
  const containerPath = base ? join(base, f.relPath) : null
  let dev: number | null = null
  let inode: number | null = null
  let isDir = false
  if (containerPath) {
    try {
      const st = statSync(containerPath)
      dev = Number(st.dev)
      inode = Number(st.ino)
      isDir = st.isDirectory()
    } catch { /* file gone or unmounted — inode stays null */ }
  }
  return { index: f.index, relPath: f.relPath, containerPath, sizeBytes: f.sizeBytes, dev, inode, isDir }
}

/**
 * The file list of a torrent that is provably ONE file sitting directly in its save path, built
 * from what torrents() already reported, so the phase spends no files() request on it. Most
 * library torrents are single files, and one request per torrent is most of this phase's time.
 *
 * An empty root path alone does not prove it. qBittorrent reports root_path "" for every torrent
 * without a root folder: a single file (content_path = storage directory + the file), but also a
 * multi-file torrent added without a subfolder (content_path = the storage directory itself) and a
 * magnet still fetching metadata (content_path ""). And the storage directory is save_path only
 * once the download has finished; before that it can be an incomplete-download directory. So the
 * content path must sit exactly one segment below save_path. Anything else returns null and the
 * caller asks files(), as it always did.
 */
function singleFile(t: Torrent): TorrentFile | null {
  if (t.rootPath !== '' || !t.savePath || !t.contentPath) return null
  if (!posix.isAbsolute(t.savePath) || !posix.isAbsolute(t.contentPath)) return null
  const relPath = posix.relative(t.savePath, t.contentPath)
  if (relPath === '' || relPath === '..' || relPath.includes('/')) return null
  return { index: 0, relPath, sizeBytes: t.sizeBytes }
}

export const qbittorrentPhase: Phase = {
  name: 'qbittorrent',
  async run(ctx): Promise<PhaseResult> {
    const clients = ctx.deps.qbittorrents
    if (clients.size === 0) return { status: 'skipped', reason: 'no qBittorrent instance is configured', counts: {} }

    const insertTorrent = ctx.db.prepare(`INSERT OR REPLACE INTO torrents (
      instance_id, hash, fetched_at, name, save_path, content_path, root_path, container_content_path,
      category, tags, state, ratio, seeding_time, is_private, tracker_host, size_bytes, progress, added_on
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    const insertFile = ctx.db.prepare(`INSERT OR REPLACE INTO torrent_files (
      instance_id, hash, file_index, rel_path, container_path, size_bytes, dev, inode
    ) VALUES (?,?,?,?,?,?,?,?)`)

    const now = new Date().toISOString()
    let files = 0
    let seen = 0
    let unmapped = 0
    let stale = 0
    let synthesized = 0
    const failed: string[] = []

    // Rows of an instance that is no longer configured. The per-instance sweep below only ever
    // runs for configured instances, so nothing else can reach them, and left in place they keep
    // feeding the cross-seed guard torrents that no configured box holds. Unlike a down box's
    // rows they are not "unobserved": no pass will ever observe them again, so nothing about this
    // pass (a configured box failing, a cancel) is a reason to keep them.
    const configured = [...clients.keys()]
    const placeholders = configured.map(() => '?').join(',')
    const unconfigured = ctx.db.transaction(() => {
      const dropped = ctx.db.prepare(`DELETE FROM torrents WHERE instance_id NOT IN (${placeholders})`)
        .run(...configured).changes
      ctx.db.prepare(`DELETE FROM torrent_files WHERE instance_id NOT IN (${placeholders})`).run(...configured)
      return dropped
    })()

    const counts = () => ({ torrents: seen, files, stale, unmapped, synthesized, unconfigured })

    // Every instance's list first, so progress runs against one total across all of them rather
    // than restarting at each box. An instance whose list cannot be read is left out of it.
    const lists: Array<{ instanceId: string; qb: QbitClient; torrents: Torrent[] }> = []
    for (const [instanceId, qb] of clients) {
      if (ctx.signal.aborted) return { status: 'cancelled', counts: counts() }
      // Not one request: this scan's client would log in, and the refusal the main thread is
      // holding off on would cost another failed login. Failed like an unreachable box — its rows
      // are kept, unobserved — and the reason says why.
      if (ctx.deps.qbitLoginBlocked?.has(instanceId)) {
        failed.push(`${instanceId}: login blocked (a recent login was refused; see this instance's health status)`)
        continue
      }
      try {
        lists.push({ instanceId, qb, torrents: await qb.torrents() })
      } catch (err) {
        failed.push(`${instanceId}: ${describeError(err)}`)
      }
    }
    const total = lists.reduce((n, l) => n + l.torrents.length, 0)
    ctx.progress(0, total)

    const indexTorrent = async (instanceId: string, qb: QbitClient, t: Torrent): Promise<void> => {
      const containerContent = t.contentPath ? ctx.deps.pathMap.qbitToContainer(instanceId, t.contentPath) : null
      if (t.contentPath && containerContent === null) unmapped += 1
      // Rewrites the row wholesale, which also resets files_error to NULL — a per-scan field
      // describing THIS pass, never a leftover from the last one.
      insertTorrent.run(
        instanceId, t.hash, now, t.name, t.savePath, t.contentPath, t.rootPath, containerContent, t.category,
        t.tags.join(','), t.state, t.ratio, t.seedingTimeSeconds, t.isPrivate ? 1 : 0, t.trackerHost, t.sizeBytes,
        t.progress, t.addedOn,
      )
      seen += 1

      // savePath is fixed per torrent, not per file — resolved once outside the per-file loop.
      const base = t.savePath ? ctx.deps.pathMap.qbitToContainer(instanceId, t.savePath) : null
      let rows: FileRow[] | null = null
      const single = singleFile(t)
      if (single) {
        const row = fileRow(base, single)
        // A directory where the one file should be: a multi-file torrent without a root folder,
        // still stored in a directory one level below save_path. Not a single file after all.
        if (!row.isDir) {
          rows = [row]
          synthesized += 1
        }
      }
      if (!rows) {
        let list
        try {
          list = await qb.files(t.hash)
        } catch (err) {
          // Recorded in its own column, NEVER by decorating `state`. Plan 4's `guard.protected`
          // tests `state` for membership of a set of busy states and blocks with no override; a
          // decorated string ("downloading (files unavailable: …)") fails that membership test, so
          // the guard would silently open — and only ever when qBittorrent is flaky.
          ctx.db.prepare('UPDATE torrents SET files_error = ? WHERE instance_id = ? AND hash = ?')
            .run(describeError(err), instanceId, t.hash)
          return
        }
        rows = list.map((f) => fileRow(base, f))
      }
      if (t.savePath && base === null) unmapped += 1
      const fileRows = rows
      const write = ctx.db.transaction(() => {
        // This torrent's file list is replaced, not merged. Upserting on (hash, file_index)
        // alone leaves a phantom (hash → dev, inode) link behind whenever a torrent's file list
        // shrinks, and a confirmed cross-seed then expands a delete onto a torrent that no
        // longer holds the file.
        ctx.db.prepare('DELETE FROM torrent_files WHERE instance_id = ? AND hash = ?').run(instanceId, t.hash)
        for (const f of fileRows) {
          insertFile.run(instanceId, t.hash, f.index, f.relPath, f.containerPath, f.sizeBytes, f.dev, f.inode)
          files += 1
        }
      })
      write()
    }

    // Instance by instance, and each instance answers only for itself: its torrents are written under
    // its own id, translated through its own prefix, and swept against its own pass. One box being
    // down says nothing about the other box's torrents, so it costs only its own rows' freshness.
    for (const { instanceId, qb, torrents } of lists) {
      for (const t of torrents) {
        // Mid-iteration cancellation returns here, BEFORE the sweep below: the torrent rows this
        // pass never got to are unobserved, not gone, and dropping them takes the cross-seed
        // correlation with them.
        if (ctx.signal.aborted) return { status: 'cancelled', counts: counts() }
        await indexTorrent(instanceId, qb, t)
        ctx.progress(seen, total)
      }

      // Torrents removed from THIS instance since the last scan keep a stale fetched_at. Drop them
      // and their file rows, or the cross-seed guard reasons about torrents that no longer exist
      // and blocks deletes for nothing.
      //
      // Licensed by a torrents() call that SUCCEEDED (a failed instance never made it into
      // `lists`) and an iteration over its list that ran to completion — and scoped to this
      // instance, whose pass is the only thing that observed anything. Emptiness alone cannot
      // license it and cannot forbid it either: qBittorrent legitimately reports zero torrents, so
      // a successful empty list is a real observation — an unsuccessful or half-finished one is not.
      stale += ctx.db.prepare('DELETE FROM torrents WHERE instance_id = ? AND fetched_at != ?').run(instanceId, now).changes
      ctx.db.prepare(`DELETE FROM torrent_files WHERE instance_id = ? AND NOT EXISTS (
        SELECT 1 FROM torrents t WHERE t.instance_id = torrent_files.instance_id AND t.hash = torrent_files.hash
      )`).run(instanceId)
    }

    // Any instance that could not be read leaves the torrent picture incomplete, and an incomplete
    // picture is not "observed": downstream rules must not treat its missing torrents as absent.
    if (failed.length > 0) return { status: 'skipped', reason: failed.join('; '), counts: counts() }
    return { status: 'completed', counts: counts() }
  },
}
