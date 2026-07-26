import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, currentSchemaVersion } from '../../src/index/db.js'

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
