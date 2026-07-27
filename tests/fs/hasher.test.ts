import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../../src/index/db.js'
import { createHasher } from '../../src/fs/hasher.js'

let dir: string
const statOf = (p: string) => {
  const s = statSync(p)
  return { dev: Number(s.dev), inode: Number(s.ino), mtime: Math.floor(s.mtimeMs), size: s.size }
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
    const after = await h.quickHash(a, { ...statOf(a), mtime: statOf(a).mtime + 1 })
    expect(after).not.toBe(before)
  })
})
