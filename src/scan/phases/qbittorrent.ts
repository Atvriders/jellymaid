import { statSync } from 'node:fs'
import { join } from 'node:path'
import type { Phase, PhaseResult } from './types.js'
import { describeError } from './types.js'

export const qbittorrentPhase: Phase = {
  name: 'qbittorrent',
  async run(ctx): Promise<PhaseResult> {
    const qb = ctx.deps.qbittorrent
    if (!qb) return { status: 'skipped', reason: 'qbittorrent client not configured', counts: {} }

    let torrents
    try {
      torrents = await qb.torrents()
    } catch (err) {
      return { status: 'skipped', reason: describeError(err), counts: {} }
    }

    const insertTorrent = ctx.db.prepare(`INSERT OR REPLACE INTO torrents (
      hash, fetched_at, name, save_path, content_path, container_content_path, category, tags,
      state, ratio, seeding_time, is_private, tracker_host, size_bytes, progress
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    const insertFile = ctx.db.prepare(`INSERT OR REPLACE INTO torrent_files (
      hash, file_index, rel_path, container_path, size_bytes, dev, inode
    ) VALUES (?,?,?,?,?,?,?)`)

    const now = new Date().toISOString()
    let files = 0

    for (const t of torrents) {
      if (ctx.signal.aborted) return { status: 'cancelled', counts: { torrents: 0, files } }
      const containerContent = t.contentPath ? ctx.deps.pathMap.qbitToContainer(t.contentPath) : null
      insertTorrent.run(
        t.hash, now, t.name, t.savePath, t.contentPath, containerContent, t.category, t.tags.join(','),
        t.state, t.ratio, t.seedingTimeSeconds, t.isPrivate ? 1 : 0, t.trackerHost, t.sizeBytes, t.progress,
      )
      let list
      try {
        list = await qb.files(t.hash)
      } catch (err) {
        ctx.db.prepare('UPDATE torrents SET state = ? WHERE hash = ?')
          .run(`${t.state} (files unavailable: ${describeError(err)})`, t.hash)
        continue
      }
      // savePath is fixed per torrent, not per file — resolved once outside the per-file loop.
      const base = t.savePath ? ctx.deps.pathMap.qbitToContainer(t.savePath) : null
      const write = ctx.db.transaction(() => {
        for (const f of list) {
          const containerPath = base ? join(base, f.relPath) : null
          let dev: number | null = null
          let inode: number | null = null
          if (containerPath) {
            try {
              const st = statSync(containerPath)
              dev = Number(st.dev)
              inode = Number(st.ino)
            } catch { /* file gone or unmounted — inode stays null */ }
          }
          insertFile.run(t.hash, f.index, f.relPath, containerPath, f.sizeBytes, dev, inode)
          files += 1
        }
      })
      write()
    }
    // Torrents removed from qBittorrent since the last scan keep a stale fetched_at.
    // Drop them and their file rows, or the cross-seed guard reasons about torrents that
    // no longer exist and blocks deletes for nothing.
    const staleTorrents = ctx.db.prepare('DELETE FROM torrents WHERE fetched_at != ?').run(now).changes
    ctx.db.prepare('DELETE FROM torrent_files WHERE hash NOT IN (SELECT hash FROM torrents)').run()
    return { status: 'completed', counts: { torrents: torrents.length, files, stale: staleTorrents } }
  },
}
