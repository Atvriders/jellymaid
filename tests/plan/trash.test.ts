import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { openDb, type Db } from '../../src/index/db.js'
import { moveToTrash, restoreFromTrash, purgeExpiredTrash } from '../../src/plan/trash.js'
import { createPathMap } from '../../src/fs/pathmap.js'
import { fileConfigSchema } from '../../src/config/schema.js'

let db: Db
let dir: string
let dbPath: string
let root: string
let file: string

const deps = (config = fileConfigSchema.parse({})) => ({
  db,
  config,
  pathMap: createPathMap([{ role: 'library', jellyfin: '/media', container: root, qbit: null, qbitInstance: null }]),
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jm-trash-'))
  dbPath = join(dir, 'db.sqlite')
  db = openDb(dbPath)
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

  it('records exactly one row pointing at the returned trash path and the original path', () => {
    // The row is written before the move, so this guards that the reordering did not change
    // WHAT is recorded: the row must still describe the move that actually happened.
    const res = moveToTrash(deps(), { path: file, planId: 'p1', sizeBytes: 4 })
    if (!res.trashed) throw new Error('unreachable')
    const rows = db.prepare('SELECT original_path, trash_path, size_bytes, plan_id FROM trash').all()
    expect(rows).toEqual([
      { original_path: file, trash_path: res.trashPath, size_bytes: 4, plan_id: 'p1' },
    ])
  })

  it('leaves no row behind and leaves the file in place when the move fails', () => {
    // Dropping write permission on the root makes the mkdirSync of <root>/.jellymaid-trash fail
    // with EACCES, which is the "the move never happened" branch. The row written before the
    // move must be rolled back: a row pointing at a file that was never moved is recoverable,
    // but it should not survive a failure the caller was told about.
    chmodSync(root, 0o555)
    try {
      const res = moveToTrash(deps(), { path: file, planId: 'p1', sizeBytes: 4 })
      expect(res.trashed).toBe(false)
      if (res.trashed) throw new Error('unreachable')
      expect(res.reason).toMatch(/move failed/i)
      expect((db.prepare('SELECT COUNT(*) c FROM trash').get() as { c: number }).c).toBe(0)
      expect(existsSync(file)).toBe(true)
    } finally {
      chmodSync(root, 0o755)
    }
  })

  it('commits the row before the file moves, so a crash mid-move can only orphan a row', () => {
    // The ordering IS the fix, so it gets asserted directly rather than inferred. A plain
    // delegating Proxy (no mocking framework) lets the test run at the one instant that matters:
    // immediately after moveToTrash's transaction returns. At that instant a SEPARATE connection
    // must already see the row (it is committed, so it would survive a SIGKILL here) and the
    // source file must still be sitting at its original path (the rename has not run yet).
    const observed: Array<{ rowsVisibleElsewhere: number; sourceStillInPlace: boolean }> = []
    const reader = new Database(dbPath, { readonly: true })
    const observing = new Proxy(db, {
      get(target, prop) {
        if (prop === 'transaction') {
          return (fn: (...args: unknown[]) => unknown) => {
            const tx = target.transaction(fn)
            return (...args: unknown[]) => {
              const result = tx(...args)
              observed.push({
                rowsVisibleElsewhere: (reader.prepare('SELECT COUNT(*) c FROM trash').get() as { c: number }).c,
                sourceStillInPlace: existsSync(file),
              })
              return result
            }
          }
        }
        const value = Reflect.get(target, prop) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    try {
      const res = moveToTrash({ ...deps(), db: observing }, { path: file, planId: 'p1', sizeBytes: 4 })
      expect(res.trashed).toBe(true)
      expect(observed).toEqual([{ rowsVisibleElsewhere: 1, sourceStillInPlace: true }])
    } finally {
      reader.close()
    }
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

  it('forgets the deleted_paths row of a file it puts back — the file is not deleted any more', () => {
    // The executor records a trashed file as deleted, so the read models hide it. A restored file
    // that stayed recorded would stay hidden for good: the row clears only once Jellyfin no longer
    // lists the path, and Jellyfin lists it again once it is back.
    const other = join(root, 'other.mkv')
    writeFileSync(other, 'o')
    moveToTrash(deps(), { path: file, planId: 'p1', sizeBytes: 4 })
    moveToTrash(deps(), { path: other, planId: 'p1', sizeBytes: 1 })
    const record = db.prepare('INSERT INTO deleted_paths (container_path, plan_id, deleted_at) VALUES (?,?,?)')
    record.run(file, 'p1', 'T'); record.run(other, 'p1', 'T')
    const id = (db.prepare('SELECT id FROM trash WHERE original_path = ?').get(file) as { id: string }).id
    expect(restoreFromTrash(deps(), id).restored).toBe(true)
    expect((db.prepare('SELECT container_path FROM deleted_paths').all() as Array<{ container_path: string }>)
      .map((r) => r.container_path)).toEqual([other])
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
