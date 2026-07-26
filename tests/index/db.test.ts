import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, linkSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, currentSchemaVersion, type Db } from '../../src/index/db.js'

const insertEntry = (db: Db, path: string) => {
  const s = statSync(path)
  db.prepare(`INSERT INTO fs_entries
      (container_path, scan_id, parent_path, name, ext, is_dir, size_bytes, mtime, dev, inode, nlink, is_media)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(path, 1, join(path, '..'), path.split('/').pop()!, '.mkv', 0,
      s.size, Math.floor(s.mtimeMs), s.dev, s.ino, s.nlink, 1)
  return s
}

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'jm-db-')) })

describe('openDb', () => {
  it('creates every table the spec requires', () => {
    const db = openDb(join(dir, 'test.db'))
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
      .map((r) => (r as { name: string }).name)
    for (const t of [
      'scans', 'jellyfin_items', 'fs_entries', 'torrents', 'torrent_files', 'arr_records',
      'findings', 'dupe_groups', 'plans', 'plan_actions', 'audit', 'trash', 'kv', 'rule_runs',
    ]) {
      expect(names).toContain(t)
    }
  })

  it('enables WAL and foreign keys', () => {
    const db = openDb(join(dir, 'test.db'))
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
  })

  it('indexes the (dev, inode) join key on both filesystem and torrent files', () => {
    const db = openDb(join(dir, 'test.db'))
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all()
      .map((r) => (r as { name: string }).name)
    expect(idx).toContain('idx_fs_entries_inode')
    expect(idx).toContain('idx_torrent_files_inode')
  })

  it('spells an unknown dev/inode/nlink as NULL, never as a matchable 0/0/1', () => {
    const db = openDb(join(dir, 'test.db'))
    const cols = db.prepare('PRAGMA table_info(fs_entries)').all() as Array<{ name: string; notnull: number; dflt_value: unknown }>
    for (const name of ['dev', 'inode', 'nlink']) {
      const col = cols.find((c) => c.name === name)!
      expect(col, `fs_entries.${name} must exist`).toBeDefined()
      // NOT NULL DEFAULT 0 would make every unstattable row collide with every other on
      // idx_fs_entries_inode, and nlink DEFAULT 1 reads as "safe to delete, only link".
      expect(col.notnull, `fs_entries.${name} must be nullable`).toBe(0)
      expect(col.dflt_value, `fs_entries.${name} must have no default`).toBeNull()
    }
  })

  it('round-trips a NULL dev/inode row rather than coercing it to zero', () => {
    const db = openDb(join(dir, 'test.db'))
    db.prepare(`INSERT INTO fs_entries (container_path, scan_id, parent_path, name, is_dir, dev, inode, nlink)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run('/mnt/media/unstattable.mkv', 1, '/mnt/media', 'unstattable.mkv', 0, null, null, null)
    const row = db.prepare('SELECT dev, inode, nlink FROM fs_entries WHERE container_path = ?')
      .get('/mnt/media/unstattable.mkv') as { dev: number | null; inode: number | null; nlink: number | null }
    expect(row.dev).toBeNull()
    expect(row.inode).toBeNull()
    expect(row.nlink).toBeNull()
    // NULL never equals NULL, so two unstattable rows can never be correlated as the same bytes.
    const collisions = db.prepare('SELECT COUNT(*) c FROM fs_entries a JOIN fs_entries b ON a.dev = b.dev AND a.inode = b.inode').get() as { c: number }
    expect(collisions.c).toBe(0)
  })

  it('round-trips a real stat() into dev/inode/nlink without loss', () => {
    const db = openDb(join(dir, 'test.db'))
    const file = join(dir, 'Heat.mkv')
    writeFileSync(file, 'x'.repeat(1024))
    const s = insertEntry(db, file)

    const row = db.prepare('SELECT size_bytes, dev, inode, nlink FROM fs_entries WHERE container_path = ?')
      .get(file) as { size_bytes: number; dev: number; inode: number; nlink: number }
    expect(row.dev).toBe(s.dev)
    expect(row.inode).toBe(s.ino)
    expect(row.nlink).toBe(s.nlink)
    expect(row.nlink).toBe(1)
    expect(row.size_bytes).toBe(1024)
  })

  it('correlates two hardlinked paths as one (dev, inode) with nlink 2', () => {
    // This is the correlation model the whole system rests on — that two paths are the same
    // bytes, so deleting one reclaims nothing. Test it against the real filesystem.
    const db = openDb(join(dir, 'test.db'))
    const original = join(dir, 'Heat.mkv')
    const linked = join(dir, 'Heat.hardlink.mkv')
    writeFileSync(original, 'x'.repeat(2048))
    linkSync(original, linked)
    insertEntry(db, original)
    insertEntry(db, linked)

    const rows = db.prepare('SELECT container_path, dev, inode, nlink FROM fs_entries ORDER BY container_path')
      .all() as Array<{ container_path: string; dev: number; inode: number; nlink: number }>
    expect(rows).toHaveLength(2)
    expect(rows[0]!.dev).toBe(rows[1]!.dev)
    expect(rows[0]!.inode).toBe(rows[1]!.inode)
    expect(rows[0]!.nlink).toBe(2)
    expect(rows[1]!.nlink).toBe(2)

    const same = db.prepare(`SELECT COUNT(*) c FROM fs_entries a JOIN fs_entries b
        ON a.dev = b.dev AND a.inode = b.inode AND a.container_path < b.container_path`).get() as { c: number }
    expect(same.c).toBe(1)
  })

  it('is idempotent — reopening applies no further migrations', () => {
    const path = join(dir, 'test.db')
    const first = openDb(path)
    const v = currentSchemaVersion(first)
    first.close()
    const second = openDb(path)
    expect(currentSchemaVersion(second)).toBe(v)
  })

  it('round-trips a finding row', () => {
    const db = openDb(join(dir, 'test.db'))
    db.prepare(`INSERT INTO findings
      (id, rule_id, class, severity, confidence, subjects_json, evidence_json,
       reclaimable_bytes, status, first_seen, last_seen)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run('abc', 'dupe.provider-id', 'duplicate', 'warning', 'exact', '[]', '{}', 42, 'open', 't', 't')
    const row = db.prepare('SELECT * FROM findings WHERE id = ?').get('abc') as { reclaimable_bytes: number }
    expect(row.reclaimable_bytes).toBe(42)
  })

  it('cascades plan_actions when a plan is deleted', () => {
    const db = openDb(join(dir, 'test.db'))
    db.prepare('INSERT INTO plans (id, created_at, created_by, status) VALUES (?,?,?,?)')
      .run('p1', 't', 'admin', 'draft')
    db.prepare('INSERT INTO plan_actions (id, plan_id, seq, type, payload_json, status) VALUES (?,?,?,?,?,?)')
      .run('a1', 'p1', 0, 'delete-media', '{}', 'pending')
    db.prepare('DELETE FROM plans WHERE id = ?').run('p1')
    expect(db.prepare('SELECT COUNT(*) c FROM plan_actions').get()).toEqual({ c: 0 })
  })
})
