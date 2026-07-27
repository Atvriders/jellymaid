import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, statSync, rmSync, truncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../../src/index/db.js'
import { createHasher } from '../../src/fs/hasher.js'

let dir: string
const statOf = (p: string) => {
  const s = statSync(p)
  return { dev: Number(s.dev), inode: Number(s.ino), mtime: s.mtimeMs, ctime: s.ctimeMs, size: s.size }
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'jm-hash-')) })

describe('quickHash', () => {
  it('is identical for byte-identical files at different paths', async () => {
    const a = join(dir, 'a.mkv'); const b = join(dir, 'b.mkv')
    writeFileSync(a, 'x'.repeat(5000)); writeFileSync(b, 'x'.repeat(5000))
    const h = createHasher(openDb(join(dir, 'db.sqlite')))
    expect(await h.quickHash(a, statOf(a))).toBe(await h.quickHash(b, statOf(b)))
  })

  it('differs when only the tail differs — proving the tail is read', async () => {
    const big = 3 * 1024 * 1024
    const a = join(dir, 'a.mkv'); const b = join(dir, 'b.mkv')
    writeFileSync(a, Buffer.concat([Buffer.alloc(big, 1), Buffer.from('TAIL-A')]))
    writeFileSync(b, Buffer.concat([Buffer.alloc(big, 1), Buffer.from('TAIL-B')]))
    const h = createHasher(openDb(join(dir, 'db.sqlite')))
    expect(await h.quickHash(a, statOf(a))).not.toBe(await h.quickHash(b, statOf(b)))
  })

  it('differs when sizes differ even if the sampled bytes match', async () => {
    const a = join(dir, 'a.mkv'); const b = join(dir, 'b.mkv')
    writeFileSync(a, 'y'.repeat(100)); writeFileSync(b, 'y'.repeat(200))
    const h = createHasher(openDb(join(dir, 'db.sqlite')))
    expect(await h.quickHash(a, statOf(a))).not.toBe(await h.quickHash(b, statOf(b)))
  })

  it('serves a cached value without re-reading the file', async () => {
    const a = join(dir, 'a.mkv')
    writeFileSync(a, 'z'.repeat(1000))
    const db = openDb(join(dir, 'db.sqlite'))
    const h = createHasher(db)
    const key = statOf(a)
    const first = await h.quickHash(a, key)
    // Deleting the file proves the second call never touched the disk. Spying on
    // node:fs/promises would not: the hasher's import binding is already resolved.
    rmSync(a)
    expect(await h.quickHash(a, key)).toBe(first)
  })

  it('recomputes when mtime changes', async () => {
    const a = join(dir, 'a.mkv')
    writeFileSync(a, 'z'.repeat(1000))
    const db = openDb(join(dir, 'db.sqlite'))
    const h = createHasher(db)
    const before = await h.quickHash(a, statOf(a))
    writeFileSync(a, 'w'.repeat(1000))
    const stat = statOf(a)
    const after = await h.quickHash(a, { ...stat, mtime: stat.mtime + 1 })
    expect(after).not.toBe(before)
  })

  it('produces a different digest when a short read occurs than a full read of the same declared size', async () => {
    const a = join(dir, 'a.mkv')
    writeFileSync(a, 'x'.repeat(10000))
    const db = openDb(join(dir, 'db.sqlite'))
    const h = createHasher(db)
    // Hash the 10000-byte file with correct declared size
    const fullKey = statOf(a)
    expect(fullKey.size).toBe(10000)
    const fullHash = await h.quickHash(a, fullKey)
    // Truncate the file to 5000 bytes on disk, but keep declared size as 10000
    // This forces the read to come up short (5000 vs 10000 declared)
    truncateSync(a, 5000)
    // Use different mtime/ctime to avoid cache hit
    const shortKey = { ...fullKey, size: 10000, mtime: fullKey.mtime + 1, ctime: fullKey.ctime + 1 }
    const shortHash = await h.quickHash(a, shortKey)
    // Short read (5000 actual bytes, 10000 declared) should produce different digest than full read
    expect(shortHash).not.toBe(fullHash)
  })

  it('recomputes when only ctime changes', async () => {
    const a = join(dir, 'a.mkv')
    writeFileSync(a, 'z'.repeat(1000))
    const db = openDb(join(dir, 'db.sqlite'))
    const h = createHasher(db)
    const stat1 = statOf(a)
    const first = await h.quickHash(a, stat1)
    // Delete and rewrite with different content, then hash with original stat but different ctime
    rmSync(a)
    writeFileSync(a, 'w'.repeat(1000))
    const second = await h.quickHash(a, { ...stat1, ctime: stat1.ctime + 1 })
    // Different ctime means cache miss; recompute with new content produces different hash
    expect(second).not.toBe(first)
  })

  it('upgrades old 4-column schema to 5-column schema with ctime', async () => {
    const a = join(dir, 'a.mkv')
    writeFileSync(a, 'x'.repeat(5000))
    const db = openDb(join(dir, 'db.sqlite'))
    // Manually create old schema with 4 columns (no ctime)
    db.exec(`CREATE TABLE quick_hash_cache (
      dev INTEGER NOT NULL, inode INTEGER NOT NULL, mtime INTEGER NOT NULL,
      size INTEGER NOT NULL, hash TEXT NOT NULL,
      PRIMARY KEY (dev, inode, mtime, size))`)
    // Insert a row with old schema
    db.prepare('INSERT INTO quick_hash_cache (dev,inode,mtime,size,hash) VALUES (?,?,?,?,?)')
      .run(1, 2, 3000, 5000, 'old_hash_value')
    // Now call createHasher, which should detect old schema and upgrade it
    const h = createHasher(db)
    // Verify ctime column exists by checking table info
    const info = db.prepare('PRAGMA table_info(quick_hash_cache)').all() as Array<{ name: string }>
    const columnNames = info.map(col => col.name)
    expect(columnNames).toContain('ctime')
    expect(columnNames).toContain('dev')
    expect(columnNames).toContain('inode')
    expect(columnNames).toContain('mtime')
    expect(columnNames).toContain('size')
    expect(columnNames).toContain('hash')
    // Verify quickHash works
    const stat = statOf(a)
    const digest = await h.quickHash(a, stat)
    expect(digest).toHaveLength(32)
  })
})
