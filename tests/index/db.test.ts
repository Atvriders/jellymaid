import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, linkSync, statSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
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
      'scans', 'jellyfin_items', 'jellyfin_item_paths', 'fs_entries', 'torrents', 'torrent_files',
      'arr_records', 'findings', 'dupe_groups', 'plans', 'plan_actions', 'audit', 'trash', 'kv',
      'rule_runs',
    ]) {
      expect(names).toContain(t)
    }
  })

  it('enables WAL and foreign keys', () => {
    const db = openDb(join(dir, 'test.db'))
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
  })

  it('waits up to 15s for a lock on every connection instead of failing at once with SQLITE_BUSY', () => {
    // The scan worker holds its own connection; a plan build or an API read on the main thread
    // must queue behind a write, not fail.
    const db = openDb(join(dir, 'test.db'))
    expect(db.pragma('busy_timeout', { simple: true })).toBe(15000)
    const second = openDb(join(dir, 'test.db'))
    expect(second.pragma('busy_timeout', { simple: true })).toBe(15000)
  })

  it('creates the deleted_paths table and the plans.error column', () => {
    const db = openDb(join(dir, 'test.db'))
    const deleted = (db.prepare('PRAGMA table_info(deleted_paths)').all() as Array<{ name: string }>).map((c) => c.name)
    expect(deleted).toEqual(['container_path', 'plan_id', 'deleted_at'])
    const plans = (db.prepare('PRAGMA table_info(plans)').all() as Array<{ name: string }>).map((c) => c.name)
    expect(plans).toContain('error')
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
})

describe('migrations', () => {
  const MIGRATIONS_DIR = fileURLToPath(new URL('../../src/index/migrations/', import.meta.url))
  const files = () => readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))

  it('names every migration so that lexicographic order IS numeric order', () => {
    // migrate() sorts filenames as strings and parses the version from the first three
    // characters. A file named `01_x.sql` or `2_x.sql` would both mis-sort and mis-parse.
    const names = files()
    expect(names.length).toBeGreaterThan(1) // ordering is only meaningfully tested with several
    for (const name of names) expect(name).toMatch(/^\d{3}_.+\.sql$/)
    const lexicographic = [...names].sort()
    const numeric = [...names].sort((a, b) => Number(a.slice(0, 3)) - Number(b.slice(0, 3)))
    expect(lexicographic).toEqual(numeric)
    // Two migrations may never claim the same version — one of them would be silently skipped.
    const versions = names.map((n) => Number(n.slice(0, 3)))
    expect(new Set(versions).size).toBe(versions.length)
  })

  it('applies migrations in numeric order, and applies only the ones a database is missing', () => {
    // A database created before 002 shipped: schema at 001, with a row already in it. Opening it
    // must apply 002 ON TOP (not re-run 001, which would throw "table already exists") and must
    // not lose the row.
    const path = join(dir, 'legacy.db')
    const legacy = new Database(path)
    legacy.exec(readFileSync(join(MIGRATIONS_DIR, '001_init.sql'), 'utf8'))
    legacy.pragma('user_version = 1')
    legacy.prepare("INSERT INTO plans (id, created_at, created_by, status) VALUES ('p1', 't', 'admin', 'completed')").run()
    legacy.close()

    const upgraded = openDb(path)
    const highest = Math.max(...files().map((f) => Number(f.slice(0, 3))))
    expect(currentSchemaVersion(upgraded)).toBe(highest)
    // 002's files_error survives 005's rebuild of the torrents table.
    const cols = (upgraded.prepare('PRAGMA table_info(torrents)').all() as Array<{ name: string }>).map((c) => c.name)
    expect(cols).toContain('files_error')
    // A row written before any of the later migrations is still there — and gained 005's column.
    expect(upgraded.prepare("SELECT status, error FROM plans WHERE id = 'p1'").get())
      .toEqual({ status: 'completed', error: null })
    // 003 must also have applied on top of a database that started at 001 — proves the chain
    // isn't just "the immediately-next migration", but every one still missing, in order.
    const tables = upgraded.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
      .map((t) => (t as { name: string }).name)
    expect(tables).toContain('jellyfin_item_paths')
    // 004 likewise: an item row written before the quality-signal columns existed must read back
    // with video_range NULL — an absent signal, which the keeper score must not fill in with a
    // guess — rather than the migration failing or defaulting it to something assertable.
    const itemCols = (upgraded.prepare('PRAGMA table_info(jellyfin_items)').all() as Array<{ name: string }>)
      .map((c) => c.name)
    expect(itemCols).toEqual(expect.arrayContaining(['video_range', 'has_subtitles']))
    upgraded.prepare("INSERT INTO jellyfin_items (id, scan_id, type, name) VALUES ('i','1','Movie','M')").run()
    expect(upgraded.prepare("SELECT video_range, has_subtitles FROM jellyfin_items WHERE id='i'").get())
      .toEqual({ video_range: null, has_subtitles: 0 })
    upgraded.close()

    // And reopening applies nothing further — no version bump, no second ALTER TABLE (which
    // would fail outright with "duplicate column name").
    const reopened = openDb(path)
    expect(currentSchemaVersion(reopened)).toBe(highest)
    expect((reopened.prepare('SELECT COUNT(*) c FROM plans').get() as { c: number }).c).toBe(1)
  })

  it('005 upgrades a v4 database: the torrent cache is rebuilt keyed by (instance_id, hash)', () => {
    // Built by hand from 001-004, exactly as a pre-multi-instance install left it.
    const path = join(dir, 'v4.db')
    const v4 = new Database(path)
    for (const f of files().filter((name) => Number(name.slice(0, 3)) <= 4).sort()) {
      v4.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
    }
    v4.pragma('user_version = 4')
    v4.prepare("INSERT INTO torrents (hash, fetched_at, name, state) VALUES ('h1', 't', 'n', 'stalledUP')").run()
    v4.prepare("INSERT INTO torrent_files (hash, file_index, rel_path) VALUES ('h1', 0, 'a.mkv')").run()
    v4.prepare("INSERT INTO kv (key, value_json) VALUES ('pathmap.lastVerification', '{}')").run()
    v4.close()

    const db = openDb(path)
    expect(currentSchemaVersion(db)).toBeGreaterThanOrEqual(5)
    // A per-scan cache: emptied, not carried across a key change it cannot be translated through.
    expect(db.prepare('SELECT COUNT(*) c FROM torrents').get()).toEqual({ c: 0 })
    expect(db.prepare('SELECT COUNT(*) c FROM torrent_files').get()).toEqual({ c: 0 })
    // Everything that is not a cache survives.
    expect(db.prepare("SELECT COUNT(*) c FROM kv WHERE key = 'pathmap.lastVerification'").get()).toEqual({ c: 1 })

    const torrentCols = (db.prepare('PRAGMA table_info(torrents)').all() as Array<{ name: string }>).map((c) => c.name)
    expect(torrentCols).toEqual(expect.arrayContaining(['instance_id', 'hash', 'root_path', 'added_on', 'files_error']))

    // The same infohash on two boxes is two torrents, in both tables.
    const insertTorrent = db.prepare("INSERT INTO torrents (instance_id, hash, fetched_at, name) VALUES (?, 'h1', 't', 'n')")
    insertTorrent.run('box-a')
    insertTorrent.run('box-b')
    const insertFile = db.prepare("INSERT INTO torrent_files (instance_id, hash, file_index, rel_path) VALUES (?, 'h1', 0, 'a.mkv')")
    insertFile.run('box-a')
    insertFile.run('box-b')
    expect(db.prepare("SELECT COUNT(*) c FROM torrents WHERE hash = 'h1'").get()).toEqual({ c: 2 })
    expect(db.prepare("SELECT COUNT(*) c FROM torrent_files WHERE hash = 'h1'").get()).toEqual({ c: 2 })
    // ...but the same (instance, hash) twice is still one torrent.
    expect(() => insertTorrent.run('box-a')).toThrow(/UNIQUE/)

    // A torrent row must say which instance reported it.
    expect(() => db.prepare("INSERT INTO torrents (hash, fetched_at, name) VALUES ('h2', 't', 'n')").run()).toThrow(/NOT NULL/)

    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => (r as { name: string }).name)
    expect(idx).toEqual(expect.arrayContaining(['idx_torrent_files_inode', 'idx_torrent_files_path']))

    db.prepare("INSERT INTO deleted_paths (container_path, plan_id, deleted_at) VALUES ('/path/to/x.mkv', 'p1', 't')").run()
    expect(db.prepare('SELECT plan_id FROM deleted_paths').get()).toEqual({ plan_id: 'p1' })
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
