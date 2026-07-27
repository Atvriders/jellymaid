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
    let seen = 0
    let unmapped = 0

    for (const t of torrents) {
      // Mid-iteration cancellation returns here, BEFORE the sweep below: the torrent rows this
      // pass never got to are unobserved, not gone, and dropping them takes the cross-seed
      // correlation with them.
      if (ctx.signal.aborted) return { status: 'cancelled', counts: { torrents: seen, files, unmapped } }
      const containerContent = t.contentPath ? ctx.deps.pathMap.qbitToContainer(t.contentPath) : null
      if (t.contentPath && containerContent === null) unmapped += 1
      // Rewrites the row wholesale, which also resets files_error to NULL — a per-scan field
      // describing THIS pass, never a leftover from the last one.
      insertTorrent.run(
        t.hash, now, t.name, t.savePath, t.contentPath, containerContent, t.category, t.tags.join(','),
        t.state, t.ratio, t.seedingTimeSeconds, t.isPrivate ? 1 : 0, t.trackerHost, t.sizeBytes, t.progress,
      )
      seen += 1
      let list
      try {
        list = await qb.files(t.hash)
      } catch (err) {
        // Recorded in its own column, NEVER by decorating `state`. Plan 4's `guard.protected`
        // tests `state` for membership of a set of busy states and blocks with no override; a
        // decorated string ("downloading (files unavailable: …)") fails that membership test, so
        // the guard would silently open — and only ever when qBittorrent is flaky.
        ctx.db.prepare('UPDATE torrents SET files_error = ? WHERE hash = ?').run(describeError(err), t.hash)
        continue
      }
      // savePath is fixed per torrent, not per file — resolved once outside the per-file loop.
      const base = t.savePath ? ctx.deps.pathMap.qbitToContainer(t.savePath) : null
      if (t.savePath && base === null) unmapped += 1
      const write = ctx.db.transaction(() => {
        // This torrent's file list is replaced, not merged. Upserting on (hash, file_index)
        // alone leaves a phantom (hash → dev, inode) link behind whenever a torrent's file list
        // shrinks, and a confirmed cross-seed then expands a delete onto a torrent that no
        // longer holds the file.
        ctx.db.prepare('DELETE FROM torrent_files WHERE hash = ?').run(t.hash)
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
    //
    // Licensed by a torrents() call that SUCCEEDED (a failure returned `skipped` above without
    // reaching here) and an iteration that ran to completion. Emptiness alone cannot license it
    // and cannot forbid it either: qBittorrent legitimately reports zero torrents, so a
    // successful empty list is a real observation — an unsuccessful or half-finished one is not.
    const staleTorrents = ctx.db.prepare('DELETE FROM torrents WHERE fetched_at != ?').run(now).changes
    ctx.db.prepare('DELETE FROM torrent_files WHERE hash NOT IN (SELECT hash FROM torrents)').run()
    return { status: 'completed', counts: { torrents: seen, files, stale: staleTorrents, unmapped } }
  },
}
