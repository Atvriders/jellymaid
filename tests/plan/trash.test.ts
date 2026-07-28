import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { openDb, type Db } from '../../src/index/db.js'
import { moveToTrash, restoreFromTrash, purgeExpiredTrash } from '../../src/plan/trash.js'
import { createPathMap } from '../../src/fs/pathmap.js'
import { fileConfigSchema } from '../../src/config/schema.js'

let db: Db
let dir: string
let root: string
let file: string

const deps = (config = fileConfigSchema.parse({})) => ({
  db,
  config,
  pathMap: createPathMap([{ role: 'library', jellyfin: '/media', container: root, qbit: null }]),
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jm-trash-'))
  db = openDb(join(dir, 'db.sqlite'))
  root = join(dir, 'lib')
  mkdirSync(root, { recursive: true })
  file = join(root, 'sample.mkv')
  writeFileSync(file, 'junk')
})

describe('moveToTrash', () => {
  it('moves the file under .jellymaid-trash and records a row', () => {
    const res = moveToTrash(deps(), { path: file, planId: 'p1', sizeBytes: 4 })
    expect(res.trashed).toBe(true)
    expect(existsSync(file)).toBe(false)
    if (!res.trashed) throw new Error('unreachable')
    expect(res.trashPath).toContain('.jellymaid-trash')
    expect(existsSync(res.trashPath)).toBe(true)
    expect(readFileSync(res.trashPath, 'utf8')).toBe('junk')
    expect((db.prepare('SELECT COUNT(*) c FROM trash').get() as { c: number }).c).toBe(1)
  })

  it('refuses a file above the size cap so a remux is never copied around', () => {
    const cfg = fileConfigSchema.parse({ trash: { maxBytes: 2, retentionDays: 30 } })
    const res = moveToTrash(deps(cfg), { path: file, planId: 'p1', sizeBytes: 4 })
    expect(res.trashed).toBe(false)
    if (res.trashed) throw new Error('unreachable')
    expect(res.reason).toMatch(/exceeds/i)
    expect(existsSync(file)).toBe(true)
  })

  it('accepts a file whose size exactly equals the cap — only "above" is refused', () => {
    const cfg = fileConfigSchema.parse({ trash: { maxBytes: 4, retentionDays: 30 } })
    const res = moveToTrash(deps(cfg), { path: file, planId: 'p1', sizeBytes: 4 })
    expect(res.trashed).toBe(true)
  })

  it('refuses a path with no configured root', () => {
    const res = moveToTrash(deps(), { path: '/etc/hosts', planId: 'p1', sizeBytes: 1 })
    expect(res.trashed).toBe(false)
  })

  it('refuses a planId that would walk the trash target outside the root', () => {
    // join() collapses ".." lexically regardless of what exists on disk, so an unsanitized
    // planId is a path-traversal vector for the trash TARGET, independent of the source-path
    // confinement check above. planId is caller-supplied; this must fail closed.
    const res = moveToTrash(deps(), { path: file, planId: '../../../etc', sizeBytes: 4 })
    expect(res.trashed).toBe(false)
    if (res.trashed) throw new Error('unreachable')
    expect(res.reason).toMatch(/root/i)
    expect(existsSync(file)).toBe(true)
    expect(existsSync('/etc/.jellymaid-trash')).toBe(false)
  })

  it('sets purge_after from the retention config', () => {
    moveToTrash(deps(fileConfigSchema.parse({ trash: { maxBytes: 1000, retentionDays: 7 } })), { path: file, planId: 'p1', sizeBytes: 4 })
    const row = db.prepare('SELECT deleted_at, purge_after FROM trash').get() as { deleted_at: string; purge_after: string }
    const days = (Date.parse(row.purge_after) - Date.parse(row.deleted_at)) / 86_400_000
    expect(Math.round(days)).toBe(7)
  })

  it('does not collide when two files share a name', () => {
    const second = join(root, 'sub')
    mkdirSync(second)
    const other = join(second, 'sample.mkv')
    writeFileSync(other, 'other')
    const a = moveToTrash(deps(), { path: file, planId: 'p1', sizeBytes: 4 })
    const b = moveToTrash(deps(), { path: other, planId: 'p1', sizeBytes: 5 })
    if (!a.trashed || !b.trashed) throw new Error('unreachable')
    expect(a.trashPath).not.toBe(b.trashPath)
    expect(readFileSync(b.trashPath, 'utf8')).toBe('other')
  })
})

describe('restoreFromTrash', () => {
  it('puts the file back where it came from', () => {
    moveToTrash(deps(), { path: file, planId: 'p1', sizeBytes: 4 })
    const id = (db.prepare('SELECT id FROM trash').get() as { id: string }).id
    expect(restoreFromTrash(deps(), id).restored).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('junk')
    expect((db.prepare('SELECT restored_at FROM trash WHERE id=?').get(id) as { restored_at: string }).restored_at).toBeTruthy()
  })

  it('refuses to overwrite a file that reappeared at the original path', () => {
    moveToTrash(deps(), { path: file, planId: 'p1', sizeBytes: 4 })
    writeFileSync(file, 'new content')
    const id = (db.prepare('SELECT id FROM trash').get() as { id: string }).id
    const res = restoreFromTrash(deps(), id)
    expect(res.restored).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('new content')
  })
})

describe('purgeExpiredTrash', () => {
  it('deletes entries past their purge date and leaves fresh ones alone', () => {
    moveToTrash(deps(), { path: file, planId: 'p1', sizeBytes: 4 })
    expect(purgeExpiredTrash(deps(), new Date('2020-01-01T00:00:00Z'))).toEqual({ purged: 0, failed: [] })
    const result = purgeExpiredTrash(deps(), new Date(Date.now() + 40 * 86_400_000))
    expect(result).toEqual({ purged: 1, failed: [] })
    expect((db.prepare('SELECT COUNT(*) c FROM trash').get() as { c: number }).c).toBe(0)
  })

  it('still purges and counts an entry whose file is already gone (ENOENT)', () => {
    const res = moveToTrash(deps(), { path: file, planId: 'p1', sizeBytes: 4 })
    if (!res.trashed) throw new Error('unreachable')
    // Someone/something removed the trashed file out from under the row — the legitimate
    // "already gone" case, distinct from a real unlink failure.
    rmSync(res.trashPath)
    const result = purgeExpiredTrash(deps(), new Date(Date.now() + 40 * 86_400_000))
    expect(result).toEqual({ purged: 1, failed: [] })
    expect((db.prepare('SELECT COUNT(*) c FROM trash').get() as { c: number }).c).toBe(0)
  })

  it('keeps the row and reports the failure when unlink fails for a reason other than ENOENT', () => {
    const res = moveToTrash(deps(), { path: file, planId: 'p1', sizeBytes: 4 })
    if (!res.trashed) throw new Error('unreachable')
    const id = (db.prepare('SELECT id FROM trash').get() as { id: string }).id
    const trashDir = dirname(res.trashPath)
    // Removing a directory entry needs write+execute on its PARENT, not the file itself, so this
    // makes the unlink() inside purgeExpiredTrash fail with EACCES rather than ENOENT.
    chmodSync(trashDir, 0o000)
    try {
      const result = purgeExpiredTrash(deps(), new Date(Date.now() + 40 * 86_400_000))
      expect(result.purged).toBe(0)
      expect(result.failed).toEqual([{ id, path: res.trashPath, reason: expect.any(String) }])
      // The row must survive: it is the only record that this file still exists, untracked.
      expect((db.prepare('SELECT COUNT(*) c FROM trash').get() as { c: number }).c).toBe(1)
    } finally {
      chmodSync(trashDir, 0o755)
    }
  })

  it('purges the good entries in a mixed batch without aborting on the bad one', () => {
    const good = moveToTrash(deps(), { path: file, planId: 'good-plan', sizeBytes: 4 })
    const badSource = join(root, 'other.mkv')
    writeFileSync(badSource, 'other')
    const bad = moveToTrash(deps(), { path: badSource, planId: 'bad-plan', sizeBytes: 5 })
    if (!good.trashed || !bad.trashed) throw new Error('unreachable')
    const badId = (db.prepare('SELECT id FROM trash WHERE trash_path = ?').get(bad.trashPath) as { id: string }).id
    const badDir = dirname(bad.trashPath)
    chmodSync(badDir, 0o000)
    try {
      const result = purgeExpiredTrash(deps(), new Date(Date.now() + 40 * 86_400_000))
      expect(result.purged).toBe(1)
      expect(result.failed).toEqual([{ id: badId, path: bad.trashPath, reason: expect.any(String) }])
      const remaining = db.prepare('SELECT id FROM trash').all() as Array<{ id: string }>
      expect(remaining).toEqual([{ id: badId }])
    } finally {
      chmodSync(badDir, 0o755)
    }
  })
})
