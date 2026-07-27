import { open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { Db } from '../index/db.js'

const SAMPLE = 1024 * 1024

export interface StatKey { dev: number; inode: number; mtime: number; size: number }

export function createHasher(db: Db) {
  db.exec(`CREATE TABLE IF NOT EXISTS quick_hash_cache (
    dev INTEGER NOT NULL, inode INTEGER NOT NULL, mtime INTEGER NOT NULL,
    size INTEGER NOT NULL, hash TEXT NOT NULL,
    PRIMARY KEY (dev, inode, mtime, size))`)
  const get = db.prepare('SELECT hash FROM quick_hash_cache WHERE dev=? AND inode=? AND mtime=? AND size=?')
  const put = db.prepare('INSERT OR REPLACE INTO quick_hash_cache (dev,inode,mtime,size,hash) VALUES (?,?,?,?,?)')

  return {
    async quickHash(path: string, key: StatKey): Promise<string> {
      const cached = get.get(key.dev, key.inode, key.mtime, key.size) as { hash: string } | undefined
      if (cached) return cached.hash

      const hash = createHash('sha256').update(String(key.size))
      const fh = await open(path, 'r')
      try {
        const head = Buffer.alloc(Math.min(SAMPLE, key.size))
        await fh.read(head, 0, head.length, 0)
        hash.update(head)
        if (key.size > SAMPLE) {
          const tailLen = Math.min(SAMPLE, key.size - SAMPLE)
          const tail = Buffer.alloc(tailLen)
          await fh.read(tail, 0, tailLen, key.size - tailLen)
          hash.update(tail)
        }
      } finally {
        await fh.close()
      }
      const digest = hash.digest('hex').slice(0, 32)
      put.run(key.dev, key.inode, key.mtime, key.size, digest)
      return digest
    },
  }
}
