import { open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { Db } from '../index/db.js'

const SAMPLE = 1024 * 1024

export interface StatKey { dev: number; inode: number; mtime: number; ctime: number; size: number }

export function createHasher(db: Db) {
  // Cache key is (dev, inode, mtime, ctime, size). ctime catches rewrites that preserve mtime.
  // Residual risk: a same-size rewrite within one filesystem timestamp tick (sub-millisecond on
  // modern filesystems, whole seconds on FAT/NFS) can still serve a stale hash. This is accepted
  // because the hash is a corroborating signal behind an operator-reviewed plan, never an automatic delete.
  db.exec(`CREATE TABLE IF NOT EXISTS quick_hash_cache (
    dev INTEGER NOT NULL, inode INTEGER NOT NULL, mtime INTEGER NOT NULL, ctime INTEGER NOT NULL,
    size INTEGER NOT NULL, hash TEXT NOT NULL,
    PRIMARY KEY (dev, inode, mtime, ctime, size))`)

  // Schema migration: if the table exists with old 4-column key (no ctime), drop and recreate it.
  // This is safe because quick_hash_cache is a derived cache; the next scan will recompute any
  // hashes that were cached.
  const columns = db.prepare('PRAGMA table_info(quick_hash_cache)').all() as Array<{ name: string }>
  const columnNames = columns.map(col => col.name)
  if (!columnNames.includes('ctime')) {
    db.exec('DROP TABLE quick_hash_cache')
    db.exec(`CREATE TABLE quick_hash_cache (
      dev INTEGER NOT NULL, inode INTEGER NOT NULL, mtime INTEGER NOT NULL, ctime INTEGER NOT NULL,
      size INTEGER NOT NULL, hash TEXT NOT NULL,
      PRIMARY KEY (dev, inode, mtime, ctime, size))`)
  }

  const get = db.prepare('SELECT hash FROM quick_hash_cache WHERE dev=? AND inode=? AND mtime=? AND ctime=? AND size=?')
  const put = db.prepare('INSERT OR REPLACE INTO quick_hash_cache (dev,inode,mtime,ctime,size,hash) VALUES (?,?,?,?,?,?)')

  return {
    async quickHash(path: string, key: StatKey): Promise<string> {
      const cached = get.get(key.dev, key.inode, key.mtime, key.ctime, key.size) as { hash: string } | undefined
      if (cached) return cached.hash

      const hash = createHash('sha256').update(String(key.size))
      const fh = await open(path, 'r')
      try {
        const head = Buffer.alloc(Math.min(SAMPLE, key.size))
        const headBytesRead = (await fh.read(head, 0, head.length, 0)).bytesRead
        hash.update(String(headBytesRead))
        hash.update(head.subarray(0, headBytesRead))
        if (key.size > SAMPLE) {
          const tailLen = Math.min(SAMPLE, key.size - SAMPLE)
          const tail = Buffer.alloc(tailLen)
          const tailBytesRead = (await fh.read(tail, 0, tailLen, key.size - tailLen)).bytesRead
          hash.update(String(tailBytesRead))
          hash.update(tail.subarray(0, tailBytesRead))
        }
      } finally {
        await fh.close()
      }
      const digest = hash.digest('hex').slice(0, 32)
      put.run(key.dev, key.inode, key.mtime, key.ctime, key.size, digest)
      return digest
    },
  }
}
