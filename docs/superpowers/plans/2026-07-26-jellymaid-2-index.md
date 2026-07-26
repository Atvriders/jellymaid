# Jellymaid Plan 2 — Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate the SQLite index — Jellyfin items, filesystem entries with `(dev, inode, nlink)`, qBittorrent torrents and their files, and Radarr/Sonarr records — via a chunked, resumable, rate-limited scan that runs on a schedule and off the request thread.

**Architecture:** A `ScanOrchestrator` drives ordered phases, each with its own cursor persisted to `scans.cursor_json`. A phase is a pure-ish function of `(deps, cursor, emit)` that writes rows in batched transactions and returns the next cursor, so any phase can be killed and resumed. Connector failures downgrade a phase to `skipped` and are recorded, never swallowed. The scan runs in a `worker_thread`; the HTTP layer only starts, cancels and reads progress.

**Tech Stack:** Node 22 · TypeScript strict · better-sqlite3 · Vitest · `node:worker_threads` · `cron-parser`

## Global Constraints

Copied verbatim from `docs/superpowers/specs/2026-07-26-jellymaid-design.md`. Every task's requirements implicitly include this section.

- **Radarr/Sonarr are unmonitor-only.** No delete endpoint and no blocklist endpoint may appear anywhere in the codebase, in any slice, ever.
- **Degraded means "not evaluated", never "zero".** A phase that could not run must be recorded as skipped with a reason.
- `.jellymaid-trash` is excluded from every scan phase, enforced in `fs/walker`, not per rule.
- Rate-limit defaults: Jellyfin 4 concurrent / 50 ms · qBittorrent 2 / 100 ms · \*arr 2 / 100 ms.
- Quick-hash is **opt-in per library root**, never global; cache key `(dev, inode, mtime, size)`.
- `role: "download"` roots are walked for inodes but never scanned for orphan media.
- The index holds ONE live snapshot. Snapshot rows are upserted by natural key, and **each phase must delete rows still carrying a prior `scan_id` when it completes** — otherwise a file that vanished lingers forever and `fs.orphan-media` / `fs.missing-file` report on ghosts. `scans` rows themselves are metadata; the last two are retained.
- `fs_entries.dev`, `.inode` and `.nlink` are **nullable with no default**. Unknown is NULL, never 0 or 1: `(0,0)` would collide with every other unstattable row on the correlation index, and `nlink = 1` is indistinguishable from "only link, deleting reclaims the full size" — the exact input Plan 4's hardlink guard trusts. The walker must write NULL when it cannot stat.
- TypeScript strict, no `any`. Commit after every task.

## Prerequisites

Plan 1 complete: `src/core/types.ts`, `src/config/*`, `src/index/db.ts`, `src/connectors/http.ts`, `src/connectors/jellyfin.ts`, `src/fs/pathmap.ts`, `src/server.ts` all exist and their tests pass.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/fs/walker.ts` | Chunked directory walk emitting `FsEntry` records |
| `src/fs/hasher.ts` | Quick-hash with an inode-keyed cache |
| `src/connectors/qbittorrent.ts` | qBittorrent WebUI API v2 protocol |
| `src/connectors/arr.ts` | Radarr/Sonarr read + unmonitor |
| `src/scan/phases/jellyfin.ts` | Phase 1 |
| `src/scan/phases/filesystem.ts` | Phase 2 |
| `src/scan/phases/qbittorrent.ts` | Phase 3 |
| `src/scan/phases/arr.ts` | Phase 4 |
| `src/scan/orchestrator.ts` | Phase sequencing, cursors, resume, cancel, progress, retention |
| `src/scan/worker.ts` | Worker-thread entry that runs a scan |
| `src/scan/scheduler.ts` | Cron scheduling with overlap suppression |
| `src/api/scan.ts` | `/api/scan/*` routes |

---

### Task 1: Filesystem walker

**Files:**
- Create: `src/fs/walker.ts`
- Test: `tests/fs/walker.test.ts`

**Interfaces:**
- Consumes: `PathMapping`, `PathMap` (Plan 1).
- Produces:
  - `interface FsEntry { containerPath, parentPath, name, ext, isDir, sizeBytes, mtime, dev, inode, nlink, isMedia, libraryRoot, rootRole }`
  - `walkRoot(opts: WalkOptions): AsyncGenerator<FsEntry[]>` — yields batches of at most `batchSize`.
  - `TRASH_DIR_NAME = '.jellymaid-trash'`

- [ ] **Step 1: Write the failing test**

```ts
// tests/fs/walker.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, linkSync, symlinkSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { walkRoot, TRASH_DIR_NAME, type FsEntry } from '../../src/fs/walker.js'
import type { PathMapping } from '../../src/core/types.js'

let dir: string
const libraryRoot = (container: string): PathMapping =>
  ({ role: 'library', jellyfin: '/media/Movies', container, qbit: null })

async function collect(root: PathMapping, over: Partial<Parameters<typeof walkRoot>[0]> = {}) {
  const out: FsEntry[] = []
  for await (const batch of walkRoot({
    root,
    mediaExtensions: ['.mkv', '.mp4'],
    batchSize: 3,
    ...over,
  })) out.push(...batch)
  return out
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jm-walk-'))
  mkdirSync(join(dir, 'Heat (1995)'), { recursive: true })
  writeFileSync(join(dir, 'Heat (1995)', 'Heat.mkv'), 'a'.repeat(100))
  writeFileSync(join(dir, 'Heat (1995)', 'Heat.nfo'), 'meta')
  mkdirSync(join(dir, 'Empty'), { recursive: true })
})

describe('walkRoot', () => {
  it('emits both files and directories with parent linkage', async () => {
    const entries = await collect(libraryRoot(dir))
    const byPath = new Map(entries.map((e) => [e.containerPath, e]))
    const file = byPath.get(join(dir, 'Heat (1995)', 'Heat.mkv'))!
    expect(file.isDir).toBe(false)
    expect(file.parentPath).toBe(join(dir, 'Heat (1995)'))
    expect(byPath.get(join(dir, 'Empty'))!.isDir).toBe(true)
  })

  it('captures dev, inode and nlink', async () => {
    const entries = await collect(libraryRoot(dir))
    const file = entries.find((e) => e.name === 'Heat.mkv')!
    expect(file.inode).toBeGreaterThan(0)
    expect(file.dev).toBeGreaterThan(0)
    expect(file.nlink).toBe(1)
  })

  it('reports nlink 2 for a hardlinked file and the same inode for both links', async () => {
    linkSync(join(dir, 'Heat (1995)', 'Heat.mkv'), join(dir, 'Heat-link.mkv'))
    const entries = await collect(libraryRoot(dir))
    const a = entries.find((e) => e.name === 'Heat.mkv')!
    const b = entries.find((e) => e.name === 'Heat-link.mkv')!
    expect(a.nlink).toBe(2)
    expect(b.nlink).toBe(2)
    expect(a.inode).toBe(b.inode)
    expect(a.dev).toBe(b.dev)
  })

  it('flags media by extension, case-insensitively', async () => {
    writeFileSync(join(dir, 'Loud.MKV'), 'x')
    const entries = await collect(libraryRoot(dir))
    expect(entries.find((e) => e.name === 'Heat.mkv')!.isMedia).toBe(true)
    expect(entries.find((e) => e.name === 'Loud.MKV')!.isMedia).toBe(true)
    expect(entries.find((e) => e.name === 'Heat.nfo')!.isMedia).toBe(false)
  })

  it('never descends into .jellymaid-trash', async () => {
    mkdirSync(join(dir, TRASH_DIR_NAME, 'plan-1'), { recursive: true })
    writeFileSync(join(dir, TRASH_DIR_NAME, 'plan-1', 'Old.mkv'), 'x')
    const entries = await collect(libraryRoot(dir))
    expect(entries.some((e) => e.containerPath.includes(TRASH_DIR_NAME))).toBe(false)
  })

  it('yields in batches no larger than batchSize', async () => {
    const sizes: number[] = []
    for await (const batch of walkRoot({ root: libraryRoot(dir), mediaExtensions: ['.mkv'], batchSize: 2 })) {
      sizes.push(batch.length)
    }
    expect(Math.max(...sizes)).toBeLessThanOrEqual(2)
  })

  it('does not follow symlinks out of the root', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'jm-outside-'))
    writeFileSync(join(outside, 'Escaped.mkv'), 'x')
    symlinkSync(outside, join(dir, 'link'))
    const entries = await collect(libraryRoot(dir))
    expect(entries.some((e) => e.name === 'Escaped.mkv')).toBe(false)
  })

  it('records an unreadable directory instead of aborting the walk', async () => {
    const locked = join(dir, 'locked')
    mkdirSync(locked)
    writeFileSync(join(locked, 'x.mkv'), 'x')
    chmodSync(locked, 0o000)
    const errors: Array<{ path: string; reason: string }> = []
    const entries = await collect(libraryRoot(dir), { onError: (e) => errors.push(e) })
    chmodSync(locked, 0o755)
    expect(entries.some((e) => e.name === 'Heat.mkv')).toBe(true)
    expect(errors.some((e) => e.path === locked)).toBe(true)
  })

  it('tags every entry with its root and role', async () => {
    const entries = await collect({ role: 'download', jellyfin: null, container: dir, qbit: '/downloads' })
    expect(entries.every((e) => e.libraryRoot === dir && e.rootRole === 'download')).toBe(true)
  })

  it('stops promptly when the caller signals cancellation', async () => {
    const controller = new AbortController()
    let seen = 0
    for await (const batch of walkRoot({ root: libraryRoot(dir), mediaExtensions: ['.mkv'], batchSize: 1, signal: controller.signal })) {
      seen += batch.length
      controller.abort()
    }
    expect(seen).toBe(1)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/fs/walker.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the walker**

```ts
// src/fs/walker.ts
import { opendir, lstat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { PathMapping, PathRole } from '../core/types.js'

export const TRASH_DIR_NAME = '.jellymaid-trash'

export interface FsEntry {
  containerPath: string
  parentPath: string
  name: string
  ext: string | null
  isDir: boolean
  sizeBytes: number
  mtime: number
  dev: number
  inode: number
  nlink: number
  isMedia: boolean
  libraryRoot: string
  rootRole: PathRole
}

export interface WalkOptions {
  root: PathMapping
  mediaExtensions: string[]
  batchSize?: number
  signal?: AbortSignal
  onError?: (err: { path: string; reason: string }) => void
}

export async function* walkRoot(opts: WalkOptions): AsyncGenerator<FsEntry[]> {
  const batchSize = opts.batchSize ?? 500
  const media = new Set(opts.mediaExtensions.map((e) => e.toLowerCase()))
  const stack: string[] = [opts.root.container]
  let batch: FsEntry[] = []

  while (stack.length) {
    if (opts.signal?.aborted) break
    const current = stack.pop()!
    let dir
    try {
      dir = await opendir(current)
    } catch (err) {
      opts.onError?.({ path: current, reason: (err as Error).message })
      continue
    }
    try {
      for await (const dirent of dir) {
        if (opts.signal?.aborted) break
        if (dirent.name === TRASH_DIR_NAME) continue
        const full = join(current, dirent.name)
        // lstat, never stat: a symlink must not be followed out of the root.
        let st
        try {
          st = await lstat(full)
        } catch (err) {
          opts.onError?.({ path: full, reason: (err as Error).message })
          continue
        }
        if (st.isSymbolicLink()) continue
        const isDir = st.isDirectory()
        if (isDir) stack.push(full)
        const ext = isDir ? null : extname(dirent.name).toLowerCase() || null
        batch.push({
          containerPath: full,
          parentPath: current,
          name: dirent.name,
          ext,
          isDir,
          sizeBytes: isDir ? 0 : st.size,
          mtime: Math.floor(st.mtimeMs),
          dev: Number(st.dev),
          inode: Number(st.ino),
          nlink: st.nlink,
          isMedia: !isDir && ext !== null && media.has(ext),
          libraryRoot: opts.root.container,
          rootRole: opts.root.role,
        })
        if (batch.length >= batchSize) {
          yield batch
          batch = []
          if (opts.signal?.aborted) return
        }
      }
    } catch (err) {
      opts.onError?.({ path: current, reason: (err as Error).message })
    }
  }
  if (batch.length) yield batch
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run tests/fs/walker.test.ts && npm run typecheck`
Expected: 10 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/fs/walker.ts tests/fs/walker.test.ts
git commit -m "feat: chunked filesystem walker capturing dev/inode/nlink"
```

---

### Task 2: Quick-hash with inode cache

**Files:**
- Create: `src/fs/hasher.ts`
- Test: `tests/fs/hasher.test.ts`

**Interfaces:**
- Consumes: `Db` (Plan 1).
- Produces: `createHasher(db: Db): { quickHash(path, stat: { dev, inode, mtime, size }): Promise<string> }`. The hash is `sha256(size + first 1 MiB + last 1 MiB)`, hex, 32 chars.

- [ ] **Step 1: Write the failing test**

```ts
// tests/fs/hasher.test.ts
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
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/fs/hasher.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the hasher**

```ts
// src/fs/hasher.ts
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
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run tests/fs/hasher.test.ts && npm run typecheck`
Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/fs/hasher.ts tests/fs/hasher.test.ts
git commit -m "feat: quick-hash with inode-keyed cache"
```

---

### Task 3: qBittorrent connector

**Files:**
- Create: `src/connectors/qbittorrent.ts`
- Test: `tests/connectors/qbittorrent.test.ts`

**Interfaces:**
- Consumes: `HttpClient`, `ConnectorError` (Plan 1).
- Produces:
  - `createQbitClient(opts: { url, user, pass, concurrency, minDelayMs, privateTrackerHosts: string[], fetchImpl? }): QbitClient`
  - `QbitClient.torrents(): Promise<Torrent[]>` · `.files(hash): Promise<TorrentFile[]>` · `.trackers(hash): Promise<string[]>` · `.deleteWithData(hashes: string[]): Promise<void>` · `.awaitGone(hashes, opts): Promise<boolean>` · `.ping(): Promise<void>`
  - `Torrent = { hash, name, savePath, contentPath, category, tags: string[], state, ratio, seedingTimeSeconds, isPrivate, trackerHost, sizeBytes, progress }`
  - `TorrentFile = { index, relPath, sizeBytes }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/connectors/qbittorrent.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createQbitClient } from '../../src/connectors/qbittorrent.js'

function stub(routes: Record<string, unknown>, spy?: (url: string, init?: RequestInit) => void) {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    spy?.(u, init)
    if (u.includes('/auth/login')) return new Response('Ok.', { status: 200, headers: { 'set-cookie': 'SID=abc; path=/' } })
    const key = Object.keys(routes).find((k) => u.includes(k))
    if (!key) return new Response('nf', { status: 404 })
    const body = routes[key]
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 })
  }) as unknown as typeof fetch
}

const client = (f: typeof fetch, privateHosts: string[] = []) => createQbitClient({
  url: 'http://qb:8080', user: 'u', pass: 'p',
  concurrency: 2, minDelayMs: 0, privateTrackerHosts: privateHosts, fetchImpl: f,
})

const RAW = [{
  hash: 'H1', name: 'Heat.1995.mkv', save_path: '/downloads/movies',
  content_path: '/downloads/movies/Heat.1995.mkv', category: 'movies', tags: 'keep, hd',
  state: 'stalledUP', ratio: 2.4, seeding_time: 1_209_600, size: 1000, progress: 1,
  tracker: 'http://tracker.private.example/announce',
}]

describe('torrents', () => {
  it('normalizes fields and splits tags', async () => {
    const t = (await client(stub({ '/torrents/info': RAW })).torrents())[0]!
    expect(t).toMatchObject({
      hash: 'H1', savePath: '/downloads/movies', contentPath: '/downloads/movies/Heat.1995.mkv',
      category: 'movies', state: 'stalledUP', ratio: 2.4, seedingTimeSeconds: 1_209_600,
      sizeBytes: 1000, trackerHost: 'tracker.private.example',
    })
    expect(t.tags).toEqual(['keep', 'hd'])
  })

  it('uses the private flag when the qBittorrent version reports it', async () => {
    const t = (await client(stub({ '/torrents/info': [{ ...RAW[0], private: true }] })).torrents())[0]!
    expect(t.isPrivate).toBe(true)
  })

  it('falls back to the configured private-host list', async () => {
    const t = (await client(stub({ '/torrents/info': RAW }), ['tracker.private.example']).torrents())[0]!
    expect(t.isPrivate).toBe(true)
  })

  it('treats unknown privacy as private — fail safe', async () => {
    const raw = [{ ...RAW[0], tracker: '' }]
    const t = (await client(stub({ '/torrents/info': raw })).torrents())[0]!
    expect(t.isPrivate).toBe(true)
  })

  it('treats a known public tracker as public', async () => {
    const raw = [{ ...RAW[0], tracker: 'http://tracker.opentrackr.org:1337/announce', private: false }]
    const t = (await client(stub({ '/torrents/info': raw })).torrents())[0]!
    expect(t.isPrivate).toBe(false)
  })

  it('logs in once and reuses the SID cookie', async () => {
    const urls: string[] = []
    const c = client(stub({ '/torrents/info': RAW }, (u) => urls.push(u)))
    await c.torrents(); await c.torrents()
    expect(urls.filter((u) => u.includes('/auth/login'))).toHaveLength(1)
  })

  it('re-logins after a 403 and retries the call', async () => {
    let logins = 0; let infoCalls = 0
    const f = (async (url: string | URL) => {
      const u = String(url)
      if (u.includes('/auth/login')) { logins += 1; return new Response('Ok.', { status: 200, headers: { 'set-cookie': 'SID=z' } }) }
      infoCalls += 1
      return infoCalls === 1 ? new Response('', { status: 403 }) : new Response(JSON.stringify(RAW), { status: 200 })
    }) as unknown as typeof fetch
    const t = await client(f).torrents()
    expect(logins).toBe(2)
    expect(t).toHaveLength(1)
  })
})

describe('files', () => {
  it('normalizes the file list', async () => {
    const files = await client(stub({ '/torrents/files': [{ index: 0, name: 'Heat/Heat.mkv', size: 900 }] })).files('H1')
    expect(files[0]).toEqual({ index: 0, relPath: 'Heat/Heat.mkv', sizeBytes: 900 })
  })
})

describe('deleteWithData', () => {
  it('posts deleteFiles=true with the joined hashes', async () => {
    let body = ''
    const f = stub({ '/torrents/delete': 'Ok.' }, (_u, init) => { body = String(init?.body) })
    await client(f).deleteWithData(['H1', 'H2'])
    expect(body).toContain('hashes=H1%7CH2')
    expect(body).toContain('deleteFiles=true')
  })

  it('refuses an empty hash list rather than issuing a wildcard delete', async () => {
    await expect(client(stub({})).deleteWithData([])).rejects.toThrow(/no torrent hashes/i)
  })
})

describe('awaitGone', () => {
  it('returns true once the hashes disappear', async () => {
    let calls = 0
    const f = (async (url: string | URL) => {
      const u = String(url)
      if (u.includes('/auth/login')) return new Response('Ok.', { status: 200, headers: { 'set-cookie': 'SID=z' } })
      calls += 1
      return new Response(JSON.stringify(calls < 2 ? RAW : []), { status: 200 })
    }) as unknown as typeof fetch
    await expect(client(f).awaitGone(['H1'], { timeoutMs: 500, pollMs: 1 })).resolves.toBe(true)
  })

  it('returns false when the torrent is still present at timeout', async () => {
    await expect(client(stub({ '/torrents/info': RAW })).awaitGone(['H1'], { timeoutMs: 20, pollMs: 5 }))
      .resolves.toBe(false)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/connectors/qbittorrent.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the connector**

```ts
// src/connectors/qbittorrent.ts
import { HttpClient, ConnectorError } from './http.js'

export interface Torrent {
  hash: string
  name: string
  savePath: string | null
  contentPath: string | null
  category: string | null
  tags: string[]
  state: string
  ratio: number
  seedingTimeSeconds: number
  isPrivate: boolean
  trackerHost: string | null
  sizeBytes: number
  progress: number
}

export interface TorrentFile { index: number; relPath: string; sizeBytes: number }

export interface QbitClientOptions {
  url: string
  user: string
  pass: string
  concurrency: number
  minDelayMs: number
  privateTrackerHosts: string[]
  fetchImpl?: typeof fetch
}

interface RawTorrent {
  hash: string; name?: string; save_path?: string; content_path?: string
  category?: string; tags?: string; state?: string; ratio?: number; seeding_time?: number
  size?: number; progress?: number; tracker?: string; private?: boolean
}

function hostOf(tracker: string | undefined): string | null {
  if (!tracker) return null
  try { return new URL(tracker).hostname } catch { return null }
}

export interface QbitClient {
  torrents(): Promise<Torrent[]>
  files(hash: string): Promise<TorrentFile[]>
  trackers(hash: string): Promise<string[]>
  deleteWithData(hashes: string[]): Promise<void>
  awaitGone(hashes: string[], opts?: { timeoutMs?: number; pollMs?: number }): Promise<boolean>
  ping(): Promise<void>
}

export function createQbitClient(opts: QbitClientOptions): QbitClient {
  let sid: string | null = null
  const privateHosts = new Set(opts.privateTrackerHosts.map((h) => h.toLowerCase()))

  const http = new HttpClient({
    service: 'qbittorrent',
    baseUrl: opts.url,
    concurrency: opts.concurrency,
    minDelayMs: opts.minDelayMs,
    fetchImpl: opts.fetchImpl,
  })

  async function login(): Promise<void> {
    const body = new URLSearchParams({ username: opts.user, password: opts.pass }).toString()
    const raw = await http.request<string>('/api/v2/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: opts.url },
      body,
    }, 'text')
    if (!raw.includes('Ok')) throw new ConnectorError('auth', 'qbittorrent', 'login rejected')
    sid = 'authenticated'
  }

  /** qBittorrent expires sessions silently; a 403 means "log in again", not "wrong password". */
  async function call<T>(path: string, init: RequestInit = {}, parse: 'json' | 'text' | 'none' = 'json'): Promise<T> {
    if (!sid) await login()
    try {
      return await http.request<T>(path, withCookie(init), parse)
    } catch (err) {
      if (err instanceof ConnectorError && err.kind === 'auth') {
        sid = null
        await login()
        return await http.request<T>(path, withCookie(init), parse)
      }
      throw err
    }
  }

  function withCookie(init: RequestInit): RequestInit {
    return { ...init, credentials: 'include', headers: { ...(init.headers as Record<string, string>), Referer: opts.url } }
  }

  function isPrivate(raw: RawTorrent, host: string | null): boolean {
    if (typeof raw.private === 'boolean') return raw.private
    if (host && privateHosts.has(host.toLowerCase())) return true
    if (!host) return true // undeterminable → treat as private
    return false
  }

  return {
    async torrents() {
      const raw = await call<RawTorrent[]>('/api/v2/torrents/info')
      return raw.map((t) => {
        const trackerHost = hostOf(t.tracker)
        return {
          hash: t.hash,
          name: t.name ?? '',
          savePath: t.save_path ?? null,
          contentPath: t.content_path ?? null,
          category: t.category?.length ? t.category : null,
          tags: (t.tags ?? '').split(',').map((s) => s.trim()).filter(Boolean),
          state: t.state ?? 'unknown',
          ratio: t.ratio ?? 0,
          seedingTimeSeconds: t.seeding_time ?? 0,
          isPrivate: isPrivate(t, trackerHost),
          trackerHost,
          sizeBytes: t.size ?? 0,
          progress: t.progress ?? 0,
        }
      })
    },

    async files(hash) {
      const raw = await call<Array<{ index?: number; name?: string; size?: number }>>(
        `/api/v2/torrents/files?hash=${encodeURIComponent(hash)}`,
      )
      return raw.map((f, i) => ({ index: f.index ?? i, relPath: f.name ?? '', sizeBytes: f.size ?? 0 }))
    },

    async trackers(hash) {
      const raw = await call<Array<{ url?: string }>>(`/api/v2/torrents/trackers?hash=${encodeURIComponent(hash)}`)
      return raw.map((t) => t.url ?? '').filter(Boolean)
    },

    async deleteWithData(hashes) {
      if (!hashes.length) throw new Error('deleteWithData called with no torrent hashes')
      const body = new URLSearchParams({ hashes: hashes.join('|'), deleteFiles: 'true' }).toString()
      await call('/api/v2/torrents/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      }, 'text')
    },

    async awaitGone(hashes, awaitOpts = {}) {
      const timeoutMs = awaitOpts.timeoutMs ?? 60_000
      const pollMs = awaitOpts.pollMs ?? 1000
      const deadline = Date.now() + timeoutMs
      const wanted = new Set(hashes.map((h) => h.toLowerCase()))
      while (Date.now() < deadline) {
        const present = await call<RawTorrent[]>('/api/v2/torrents/info')
        if (!present.some((t) => wanted.has(t.hash.toLowerCase()))) return true
        await new Promise((r) => setTimeout(r, pollMs))
      }
      return false
    },

    async ping() { await call('/api/v2/app/version', {}, 'text') },
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run tests/connectors/qbittorrent.test.ts && npm run typecheck`
Expected: 12 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/connectors/qbittorrent.ts tests/connectors/qbittorrent.test.ts
git commit -m "feat: qbittorrent connector with privacy detection and delete-with-data"
```

---

### Task 4: Radarr/Sonarr connector — read and unmonitor only

**Files:**
- Create: `src/connectors/arr.ts`
- Test: `tests/connectors/arr.test.ts`

**Interfaces:**
- Consumes: `HttpClient` (Plan 1).
- Produces:
  - `createRadarrClient(opts): ArrClient` · `createSonarrClient(opts): ArrClient`
  - `ArrClient.inventory(): Promise<ArrRecord[]>` · `.unmonitorByPath(path: string): Promise<{ unmonitored: boolean; recordId: number | null }>` · `.ping(): Promise<void>`
  - `ArrRecord = { kind: 'radarr' | 'sonarr'; instance: string; remoteId: number; title: string; arrPath: string | null; monitored: boolean; seriesId: number | null; episodeId: number | null; episodeFileId: number | null }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/connectors/arr.test.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRadarrClient, createSonarrClient } from '../../src/connectors/arr.js'

function stub(routes: Record<string, unknown>, spy?: (url: string, init?: RequestInit) => void) {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    spy?.(u, init)
    const key = Object.keys(routes).find((k) => u.includes(k))
    if (!key) return new Response('nf', { status: 404 })
    return new Response(JSON.stringify(routes[key]), { status: 200 })
  }) as unknown as typeof fetch
}

const base = (f: typeof fetch) => ({ url: 'http://arr', apiKey: 'K', concurrency: 2, minDelayMs: 0, fetchImpl: f })

describe('radarr', () => {
  it('maps movies to records including the file path', async () => {
    const f = stub({ '/api/v3/movie': [
      { id: 5, title: 'Heat', monitored: true, path: '/movies/Heat', movieFile: { path: '/movies/Heat/Heat.mkv' } },
    ] })
    const recs = await createRadarrClient(base(f)).inventory()
    expect(recs[0]).toMatchObject({ kind: 'radarr', remoteId: 5, title: 'Heat', arrPath: '/movies/Heat/Heat.mkv', monitored: true })
  })

  it('sends the api key header', async () => {
    let headers: Record<string, string> = {}
    const f = stub({ '/api/v3/movie': [] }, (_u, init) => { headers = init!.headers as Record<string, string> })
    await createRadarrClient(base(f)).inventory()
    expect(headers['X-Api-Key']).toBe('K')
  })

  it('unmonitors by path with a PUT that only flips monitored', async () => {
    let method = ''; let body: Record<string, unknown> = {}
    const f = stub({
      '/api/v3/movie': [{ id: 5, title: 'Heat', monitored: true, path: '/movies/Heat', movieFile: { path: '/movies/Heat/Heat.mkv' } }],
    }, (u, init) => { if (u.includes('/movie/5')) { method = init!.method!; body = JSON.parse(String(init!.body)) } })
    const res = await createRadarrClient(base(f)).unmonitorByPath('/movies/Heat/Heat.mkv')
    expect(res).toEqual({ unmonitored: true, recordId: 5 })
    expect(method).toBe('PUT')
    expect(body.monitored).toBe(false)
    expect(body.id).toBe(5)
  })

  it('reports not-found rather than throwing when the path is unknown', async () => {
    const f = stub({ '/api/v3/movie': [] })
    await expect(createRadarrClient(base(f)).unmonitorByPath('/nope.mkv'))
      .resolves.toEqual({ unmonitored: false, recordId: null })
  })
})

describe('sonarr', () => {
  it('maps episode files to records carrying seriesId and episodeId', async () => {
    const f = stub({
      '/api/v3/series': [{ id: 9, title: 'Show', monitored: true, path: '/tv/Show' }],
      '/api/v3/episodefile': [{ id: 77, seriesId: 9, path: '/tv/Show/S01E01.mkv' }],
      '/api/v3/episode': [{ id: 500, seriesId: 9, episodeFileId: 77, monitored: true, title: 'Pilot' }],
    })
    const recs = await createSonarrClient(base(f)).inventory()
    expect(recs.find((r) => r.arrPath === '/tv/Show/S01E01.mkv')).toMatchObject({
      kind: 'sonarr', seriesId: 9, episodeId: 500, episodeFileId: 77,
    })
  })

  it('unmonitors via the episode monitor endpoint', async () => {
    let url = ''; let body: Record<string, unknown> = {}
    const f = stub({
      '/api/v3/series': [{ id: 9, title: 'Show', monitored: true, path: '/tv/Show' }],
      '/api/v3/episodefile': [{ id: 77, seriesId: 9, path: '/tv/Show/S01E01.mkv' }],
      '/api/v3/episode': [{ id: 500, seriesId: 9, episodeFileId: 77, monitored: true, title: 'Pilot' }],
    }, (u, init) => { if (u.includes('/episode/monitor')) { url = u; body = JSON.parse(String(init!.body)) } })
    const res = await createSonarrClient(base(f)).unmonitorByPath('/tv/Show/S01E01.mkv')
    expect(res.unmonitored).toBe(true)
    expect(url).toContain('/api/v3/episode/monitor')
    expect(body).toEqual({ episodeIds: [500], monitored: false })
  })
})

describe('safety', () => {
  it('the source contains no delete or blocklist call', () => {
    const src = readFileSync(new URL('../../src/connectors/arr.ts', import.meta.url), 'utf8')
    expect(src).not.toMatch(/method:\s*'DELETE'/)
    expect(src.toLowerCase()).not.toContain('blocklist')
    expect(src.toLowerCase()).not.toContain('blacklist')
    expect(src).not.toMatch(/deleteFiles/)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/connectors/arr.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the connector**

```ts
// src/connectors/arr.ts
import { HttpClient } from './http.js'

export interface ArrRecord {
  kind: 'radarr' | 'sonarr'
  instance: string
  remoteId: number
  title: string
  arrPath: string | null
  monitored: boolean
  seriesId: number | null
  episodeId: number | null
  episodeFileId: number | null
}

export interface ArrClientOptions {
  url: string
  apiKey: string
  concurrency: number
  minDelayMs: number
  instance?: string
  fetchImpl?: typeof fetch
}

export interface ArrClient {
  inventory(): Promise<ArrRecord[]>
  unmonitorByPath(path: string): Promise<{ unmonitored: boolean; recordId: number | null }>
  ping(): Promise<void>
}

function makeHttp(opts: ArrClientOptions, service: string) {
  return new HttpClient({
    service,
    baseUrl: opts.url,
    concurrency: opts.concurrency,
    minDelayMs: opts.minDelayMs,
    defaultHeaders: { 'X-Api-Key': opts.apiKey, 'Content-Type': 'application/json' },
    fetchImpl: opts.fetchImpl,
  })
}

interface RawMovie { id: number; title?: string; monitored?: boolean; path?: string; movieFile?: { path?: string } }

export function createRadarrClient(opts: ArrClientOptions): ArrClient {
  const http = makeHttp(opts, 'radarr')
  const instance = opts.instance ?? 'radarr'

  const load = async (): Promise<Array<{ raw: RawMovie; rec: ArrRecord }>> => {
    const movies = await http.request<RawMovie[]>('/api/v3/movie')
    return movies.map((m) => ({
      raw: m,
      rec: {
        kind: 'radarr' as const, instance, remoteId: m.id, title: m.title ?? '',
        arrPath: m.movieFile?.path ?? m.path ?? null,
        monitored: Boolean(m.monitored), seriesId: null, episodeId: null, episodeFileId: null,
      },
    }))
  }

  return {
    async inventory() { return (await load()).map((x) => x.rec) },

    async unmonitorByPath(path) {
      const all = await load()
      const hit = all.find((x) => x.rec.arrPath === path)
      if (!hit) return { unmonitored: false, recordId: null }
      // PUT the whole record back with monitored flipped — Radarr replaces the document.
      await http.request(`/api/v3/movie/${hit.raw.id}`, {
        method: 'PUT',
        body: JSON.stringify({ ...hit.raw, monitored: false }),
      }, 'none')
      return { unmonitored: true, recordId: hit.raw.id }
    },

    async ping() { await http.request('/api/v3/system/status') },
  }
}

interface RawSeries { id: number; title?: string; monitored?: boolean; path?: string }
interface RawEpisodeFile { id: number; seriesId: number; path?: string }
interface RawEpisode { id: number; seriesId: number; episodeFileId?: number; monitored?: boolean; title?: string }

export function createSonarrClient(opts: ArrClientOptions): ArrClient {
  const http = makeHttp(opts, 'sonarr')
  const instance = opts.instance ?? 'sonarr'

  const load = async (): Promise<ArrRecord[]> => {
    const series = await http.request<RawSeries[]>('/api/v3/series')
    const out: ArrRecord[] = []
    for (const s of series) {
      const [files, episodes] = await Promise.all([
        http.request<RawEpisodeFile[]>(`/api/v3/episodefile?seriesId=${s.id}`),
        http.request<RawEpisode[]>(`/api/v3/episode?seriesId=${s.id}`),
      ])
      const episodeByFile = new Map<number, RawEpisode>()
      for (const e of episodes) if (e.episodeFileId) episodeByFile.set(e.episodeFileId, e)
      for (const f of files) {
        const ep = episodeByFile.get(f.id)
        out.push({
          kind: 'sonarr', instance, remoteId: f.id, title: ep?.title ?? s.title ?? '',
          arrPath: f.path ?? null, monitored: Boolean(ep?.monitored),
          seriesId: s.id, episodeId: ep?.id ?? null, episodeFileId: f.id,
        })
      }
    }
    return out
  }

  return {
    async inventory() { return load() },

    async unmonitorByPath(path) {
      const records = await load()
      const hit = records.find((r) => r.arrPath === path)
      if (!hit?.episodeId) return { unmonitored: false, recordId: null }
      await http.request('/api/v3/episode/monitor', {
        method: 'PUT',
        body: JSON.stringify({ episodeIds: [hit.episodeId], monitored: false }),
      }, 'none')
      return { unmonitored: true, recordId: hit.episodeId }
    },

    async ping() { await http.request('/api/v3/system/status') },
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run tests/connectors/arr.test.ts && npm run typecheck`
Expected: 7 tests PASS, including the safety test asserting no delete/blocklist call exists.

- [ ] **Step 5: Commit**

```bash
git add src/connectors/arr.ts tests/connectors/arr.test.ts
git commit -m "feat: radarr/sonarr connector, read and unmonitor only"
```

---

### Task 5: Scan phases

**Files:**
- Create: `src/scan/phases/jellyfin.ts`, `src/scan/phases/filesystem.ts`, `src/scan/phases/qbittorrent.ts`, `src/scan/phases/arr.ts`, `src/scan/phases/types.ts`
- Test: `tests/scan/phases.test.ts`

**Interfaces:**
- Consumes: all connectors, `walkRoot`, `createHasher`, `PathMap`, `Db`.
- Produces:
  - `interface Phase { name: PhaseName; run(ctx: PhaseContext): Promise<PhaseResult> }`
  - `PhaseName = 'jellyfin' | 'filesystem' | 'qbittorrent' | 'arr'`
  - `PhaseContext = { db: Db; scanId: number; cursor: Record<string, unknown>; signal: AbortSignal; deps: ScanDeps; saveCursor(c: Record<string, unknown>): void; progress(done: number, total: number | null): void }`
  - `PhaseResult = { status: 'completed' | 'skipped' | 'cancelled'; reason?: string; counts: Record<string, number> }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/scan/phases.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../src/index/db.js'
import { jellyfinPhase } from '../../src/scan/phases/jellyfin.js'
import { filesystemPhase } from '../../src/scan/phases/filesystem.js'
import { qbittorrentPhase } from '../../src/scan/phases/qbittorrent.js'
import { arrPhase } from '../../src/scan/phases/arr.js'
import { createPathMap } from '../../src/fs/pathmap.js'
import { fileConfigSchema } from '../../src/config/schema.js'
import type { PhaseContext } from '../../src/scan/phases/types.js'

let db: Db
let dir: string

function ctx(deps: Partial<PhaseContext['deps']>, cursor: Record<string, unknown> = {}): PhaseContext {
  let saved = cursor
  return {
    db, scanId: 1, cursor: saved, signal: new AbortController().signal,
    saveCursor: (c) => { saved = c },
    progress: () => {},
    deps: {
      config: fileConfigSchema.parse({}),
      pathMap: createPathMap([]),
      jellyfin: null, qbittorrent: null, radarr: null, sonarr: null,
      hasher: null,
      ...deps,
    } as PhaseContext['deps'],
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jm-phase-'))
  db = openDb(join(dir, 'db.sqlite'))
  db.prepare("INSERT INTO scans (id, started_at, status) VALUES (1, 't', 'running')").run()
})

describe('jellyfinPhase', () => {
  const pages = (total: number) => ({
    items: async ({ startIndex, limit }: { startIndex: number; limit: number }) => ({
      totalRecordCount: total,
      items: Array.from({ length: Math.max(0, Math.min(limit, total - startIndex)) }, (_v, i) => ({
        id: `i${startIndex + i}`, type: 'Movie', name: `M${startIndex + i}`, sortName: null, year: 2000,
        seriesId: null, seriesName: null, seasonNo: null, episodeNo: null,
        providerIds: { tmdb: String(startIndex + i) }, jfPath: `/media/Movies/M${startIndex + i}.mkv`,
        sizeBytes: 10, runtimeTicks: 1, container: 'mkv', videoCodec: 'h264', audioCodec: 'aac',
        audioChannels: 2, width: 1920, height: 1080, bitrate: 100, hasPrimaryImage: true,
        dateCreated: null, mediaSourceId: 'ms',
      })),
    }),
    virtualFolders: async () => [{ id: 'lib1', name: 'Movies', collectionType: 'movies', locations: ['/media/Movies'] }],
  })

  it('writes every item and records the total', async () => {
    const c = ctx({ jellyfin: pages(5) as never })
    const res = await jellyfinPhase.run(c)
    expect(res.status).toBe('completed')
    expect(db.prepare('SELECT COUNT(*) c FROM jellyfin_items').get()).toEqual({ c: 5 })
  })

  it('translates jellyfin paths to container paths using the map', async () => {
    const c = ctx({
      jellyfin: pages(1) as never,
      pathMap: createPathMap([{ role: 'library', jellyfin: '/media/Movies', container: '/mnt/m', qbit: null }]),
    })
    await jellyfinPhase.run(c)
    const row = db.prepare('SELECT container_path FROM jellyfin_items').get() as { container_path: string }
    expect(row.container_path).toBe('/mnt/m/M0.mkv')
  })

  it('skips with a reason when jellyfin is unreachable, and writes no rows', async () => {
    const c = ctx({ jellyfin: { virtualFolders: async () => { throw Object.assign(new Error('x'), { kind: 'unreachable' }) } } as never })
    const res = await jellyfinPhase.run(c)
    expect(res.status).toBe('skipped')
    expect(res.reason).toMatch(/unreachable/)
    expect(db.prepare('SELECT COUNT(*) c FROM jellyfin_items').get()).toEqual({ c: 0 })
  })

  it('resumes from a saved startIndex instead of refetching page one', async () => {
    const seen: number[] = []
    const jf = {
      virtualFolders: async () => [],
      items: async ({ startIndex, limit }: { startIndex: number; limit: number }) => {
        seen.push(startIndex)
        return { totalRecordCount: 4, items: Array.from({ length: Math.max(0, Math.min(limit, 4 - startIndex)) }, (_v, i) => ({
          id: `r${startIndex + i}`, type: 'Movie', name: 'x', sortName: null, year: null,
          seriesId: null, seriesName: null, seasonNo: null, episodeNo: null, providerIds: {},
          jfPath: null, sizeBytes: null, runtimeTicks: null, container: null, videoCodec: null,
          audioCodec: null, audioChannels: null, width: null, height: null, bitrate: null,
          hasPrimaryImage: false, dateCreated: null, mediaSourceId: null,
        })) }
      },
    }
    await jellyfinPhase.run(ctx({ jellyfin: jf as never }, { startIndex: 2 }))
    expect(seen[0]).toBe(2)
  })
})

describe('filesystemPhase', () => {
  beforeEach(() => {
    mkdirSync(join(dir, 'lib', 'Heat'), { recursive: true })
    writeFileSync(join(dir, 'lib', 'Heat', 'Heat.mkv'), 'x'.repeat(50))
  })

  it('writes entries for every walked root', async () => {
    const c = ctx({
      pathMap: createPathMap([{ role: 'library', jellyfin: '/media', container: join(dir, 'lib'), qbit: null }]),
    })
    const res = await filesystemPhase.run(c)
    expect(res.status).toBe('completed')
    const rows = db.prepare('SELECT container_path, is_media, root_role FROM fs_entries').all() as Array<{ container_path: string; is_media: number; root_role: string }>
    expect(rows.some((r) => r.container_path.endsWith('Heat.mkv') && r.is_media === 1 && r.root_role === 'library')).toBe(true)
  })

  it('hashes only roots listed in hashedLibraryRoots', async () => {
    const root = join(dir, 'lib')
    const c = ctx({
      pathMap: createPathMap([{ role: 'library', jellyfin: '/media', container: root, qbit: null }]),
      config: fileConfigSchema.parse({ hashedLibraryRoots: [] }),
    })
    await filesystemPhase.run(c)
    expect((db.prepare('SELECT COUNT(*) c FROM fs_entries WHERE quick_hash IS NOT NULL').get() as { c: number }).c).toBe(0)

    db.prepare('DELETE FROM fs_entries').run()
    const c2 = ctx({
      pathMap: createPathMap([{ role: 'library', jellyfin: '/media', container: root, qbit: null }]),
      config: fileConfigSchema.parse({ hashedLibraryRoots: [root] }),
      hasher: { quickHash: async () => 'deadbeef' } as never,
    })
    await filesystemPhase.run(c2)
    expect((db.prepare('SELECT COUNT(*) c FROM fs_entries WHERE quick_hash IS NOT NULL').get() as { c: number }).c).toBe(1)
  })

  it('skips when no roots are configured rather than walking the whole container', async () => {
    const res = await filesystemPhase.run(ctx({}))
    expect(res.status).toBe('skipped')
    expect(res.reason).toMatch(/no path mappings/i)
  })
})

describe('qbittorrentPhase', () => {
  it('resolves torrent file paths to container paths and stats them for inode', async () => {
    mkdirSync(join(dir, 'dl', 'Heat'), { recursive: true })
    const file = join(dir, 'dl', 'Heat', 'Heat.mkv')
    writeFileSync(file, 'x')
    const c = ctx({
      pathMap: createPathMap([{ role: 'download', jellyfin: null, container: join(dir, 'dl'), qbit: '/downloads' }]),
      qbittorrent: {
        torrents: async () => [{
          hash: 'H1', name: 'Heat', savePath: '/downloads', contentPath: '/downloads/Heat',
          category: null, tags: [], state: 'stalledUP', ratio: 1, seedingTimeSeconds: 1,
          isPrivate: false, trackerHost: 'x', sizeBytes: 1, progress: 1,
        }],
        files: async () => [{ index: 0, relPath: 'Heat/Heat.mkv', sizeBytes: 1 }],
      } as never,
    })
    const res = await qbittorrentPhase.run(c)
    expect(res.status).toBe('completed')
    const row = db.prepare('SELECT container_path, inode FROM torrent_files').get() as { container_path: string; inode: number }
    expect(row.container_path).toBe(file)
    expect(row.inode).toBeGreaterThan(0)
  })

  it('skips with a reason when qbittorrent is unreachable', async () => {
    const c = ctx({ qbittorrent: { torrents: async () => { throw Object.assign(new Error('down'), { kind: 'unreachable' }) } } as never })
    const res = await qbittorrentPhase.run(c)
    expect(res.status).toBe('skipped')
  })
})

describe('arrPhase', () => {
  it('is skipped, not failed, when neither instance is configured', async () => {
    const res = await arrPhase.run(ctx({}))
    expect(res.status).toBe('skipped')
    expect(res.reason).toMatch(/not configured/i)
  })

  it('writes records from both instances', async () => {
    const c = ctx({
      radarr: { inventory: async () => [{ kind: 'radarr', instance: 'radarr', remoteId: 1, title: 'Heat', arrPath: '/movies/Heat.mkv', monitored: true, seriesId: null, episodeId: null, episodeFileId: null }] } as never,
      sonarr: { inventory: async () => [{ kind: 'sonarr', instance: 'sonarr', remoteId: 2, title: 'Ep', arrPath: '/tv/Ep.mkv', monitored: true, seriesId: 9, episodeId: 500, episodeFileId: 2 }] } as never,
    })
    const res = await arrPhase.run(c)
    expect(res.status).toBe('completed')
    expect(db.prepare('SELECT COUNT(*) c FROM arr_records').get()).toEqual({ c: 2 })
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/scan/phases.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the shared phase types**

```ts
// src/scan/phases/types.ts
import type { Db } from '../../index/db.js'
import type { PathMap } from '../../fs/pathmap.js'
import type { FileConfig } from '../../config/schema.js'
import type { JellyfinClient } from '../../connectors/jellyfin.js'
import type { QbitClient } from '../../connectors/qbittorrent.js'
import type { ArrClient } from '../../connectors/arr.js'
import type { createHasher } from '../../fs/hasher.js'

export type PhaseName = 'jellyfin' | 'filesystem' | 'qbittorrent' | 'arr'

export interface ScanDeps {
  config: FileConfig
  pathMap: PathMap
  jellyfin: JellyfinClient | null
  qbittorrent: QbitClient | null
  radarr: ArrClient | null
  sonarr: ArrClient | null
  hasher: ReturnType<typeof createHasher> | null
}

export interface PhaseContext {
  db: Db
  scanId: number
  cursor: Record<string, unknown>
  signal: AbortSignal
  deps: ScanDeps
  saveCursor(cursor: Record<string, unknown>): void
  progress(done: number, total: number | null): void
}

export interface PhaseResult {
  status: 'completed' | 'skipped' | 'cancelled'
  reason?: string
  counts: Record<string, number>
}

export interface Phase {
  name: PhaseName
  run(ctx: PhaseContext): Promise<PhaseResult>
}

export function describeError(err: unknown): string {
  const kind = (err as { kind?: string }).kind
  return kind ? `${kind}: ${(err as Error).message}` : (err as Error).message
}
```

- [ ] **Step 4: Implement the four phases**

```ts
// src/scan/phases/jellyfin.ts
import type { Phase } from './types.js'
import { describeError } from './types.js'

const PAGE = 500

export const jellyfinPhase: Phase = {
  name: 'jellyfin',
  async run(ctx) {
    const jf = ctx.deps.jellyfin
    if (!jf) return { status: 'skipped', reason: 'jellyfin client not configured', counts: {} }

    const insert = ctx.db.prepare(`INSERT OR REPLACE INTO jellyfin_items (
      id, scan_id, type, name, sort_name, year, series_id, series_name, season_no, episode_no,
      provider_ids_json, jf_path, container_path, size_bytes, runtime_ticks, container,
      video_codec, audio_codec, audio_channels, width, height, bitrate, has_primary_image,
      library_id, library_name, date_created, media_source_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)

    let libraryByLocation: Array<{ id: string; name: string; location: string }> = []
    try {
      const folders = await jf.virtualFolders()
      libraryByLocation = folders.flatMap((f) => f.locations.map((l) => ({ id: f.id, name: f.name, location: l })))
        .sort((a, b) => b.location.length - a.location.length)
    } catch (err) {
      return { status: 'skipped', reason: describeError(err), counts: {} }
    }

    let startIndex = typeof ctx.cursor.startIndex === 'number' ? ctx.cursor.startIndex : 0
    let written = 0
    let total: number | null = null

    const writeBatch = ctx.db.transaction((rows: unknown[][]) => { for (const r of rows) insert.run(...r) })

    while (true) {
      if (ctx.signal.aborted) return { status: 'cancelled', counts: { items: written } }
      let page
      try {
        page = await jf.items({ startIndex, limit: PAGE })
      } catch (err) {
        return { status: 'skipped', reason: describeError(err), counts: { items: written } }
      }
      total = page.totalRecordCount
      if (!page.items.length) break

      const rows = page.items.map((i) => {
        const lib = i.jfPath ? libraryByLocation.find((l) => i.jfPath!.startsWith(l.location)) : undefined
        return [
          i.id, ctx.scanId, i.type, i.name, i.sortName, i.year, i.seriesId, i.seriesName, i.seasonNo, i.episodeNo,
          JSON.stringify(i.providerIds), i.jfPath, i.jfPath ? ctx.deps.pathMap.toContainer(i.jfPath) : null,
          i.sizeBytes, i.runtimeTicks, i.container, i.videoCodec, i.audioCodec, i.audioChannels,
          i.width, i.height, i.bitrate, i.hasPrimaryImage ? 1 : 0,
          lib?.id ?? null, lib?.name ?? null, i.dateCreated, i.mediaSourceId,
        ]
      })
      writeBatch(rows)
      written += rows.length
      startIndex += page.items.length
      ctx.saveCursor({ startIndex })
      ctx.progress(written, total)
      if (startIndex >= total) break
    }
    return { status: 'completed', counts: { items: written } }
  },
}
```

```ts
// src/scan/phases/filesystem.ts
import type { Phase } from './types.js'
import { describeError } from './types.js'
import { walkRoot } from '../../fs/walker.js'

export const filesystemPhase: Phase = {
  name: 'filesystem',
  async run(ctx) {
    const roots = ctx.deps.pathMap.all()
    if (!roots.length) return { status: 'skipped', reason: 'no path mappings configured', counts: {} }

    const hashedRoots = new Set(ctx.deps.config.hashedLibraryRoots)
    const insert = ctx.db.prepare(`INSERT OR REPLACE INTO fs_entries (
      container_path, scan_id, parent_path, name, ext, is_dir, size_bytes, mtime,
      dev, inode, nlink, is_media, library_root, root_role, quick_hash
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    const writeBatch = ctx.db.transaction((rows: unknown[][]) => { for (const r of rows) insert.run(...r) })

    const done = new Set((ctx.cursor.completedRoots as string[] | undefined) ?? [])
    const errors: Array<{ path: string; reason: string }> = []
    let written = 0

    for (const root of roots) {
      if (done.has(root.container)) continue
      if (ctx.signal.aborted) return { status: 'cancelled', counts: { entries: written } }
      const shouldHash = hashedRoots.has(root.container) && ctx.deps.hasher !== null

      try {
        for await (const batch of walkRoot({
          root,
          mediaExtensions: ctx.deps.config.mediaExtensions,
          batchSize: 1000,
          signal: ctx.signal,
          onError: (e) => errors.push(e),
        })) {
          const rows: unknown[][] = []
          for (const e of batch) {
            let hash: string | null = null
            if (shouldHash && e.isMedia && ctx.deps.hasher) {
              try {
                hash = await ctx.deps.hasher.quickHash(e.containerPath, {
                  dev: e.dev, inode: e.inode, mtime: e.mtime, size: e.sizeBytes,
                })
              } catch (err) {
                errors.push({ path: e.containerPath, reason: describeError(err) })
              }
            }
            rows.push([
              e.containerPath, ctx.scanId, e.parentPath, e.name, e.ext, e.isDir ? 1 : 0,
              e.sizeBytes, e.mtime, e.dev, e.inode, e.nlink, e.isMedia ? 1 : 0,
              e.libraryRoot, e.rootRole, hash,
            ])
          }
          writeBatch(rows)
          written += rows.length
          ctx.progress(written, null)
        }
      } catch (err) {
        errors.push({ path: root.container, reason: describeError(err) })
      }
      done.add(root.container)
      ctx.saveCursor({ completedRoots: [...done] })
    }
    return { status: 'completed', counts: { entries: written, errors: errors.length } }
  },
}
```

```ts
// src/scan/phases/qbittorrent.ts
import { statSync } from 'node:fs'
import { join } from 'node:path'
import type { Phase } from './types.js'
import { describeError } from './types.js'

export const qbittorrentPhase: Phase = {
  name: 'qbittorrent',
  async run(ctx) {
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

    for (const t of torrents) {
      if (ctx.signal.aborted) return { status: 'cancelled', counts: { torrents: 0, files } }
      const containerContent = t.contentPath ? ctx.deps.pathMap.qbitToContainer(t.contentPath) : null
      insertTorrent.run(
        t.hash, now, t.name, t.savePath, t.contentPath, containerContent, t.category, t.tags.join(','),
        t.state, t.ratio, t.seedingTimeSeconds, t.isPrivate ? 1 : 0, t.trackerHost, t.sizeBytes, t.progress,
      )
      let list
      try {
        list = await qb.files(t.hash)
      } catch (err) {
        ctx.db.prepare('UPDATE torrents SET state = ? WHERE hash = ?')
          .run(`${t.state} (files unavailable: ${describeError(err)})`, t.hash)
        continue
      }
      const write = ctx.db.transaction(() => {
        for (const f of list) {
          const base = t.savePath ? ctx.deps.pathMap.qbitToContainer(t.savePath) : null
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
    return { status: 'completed', counts: { torrents: torrents.length, files } }
  },
}
```

```ts
// src/scan/phases/arr.ts
import type { Phase } from './types.js'
import { describeError } from './types.js'
import type { ArrClient } from '../../connectors/arr.js'

export const arrPhase: Phase = {
  name: 'arr',
  async run(ctx) {
    const clients: Array<[string, ArrClient]> = []
    if (ctx.deps.radarr) clients.push(['radarr', ctx.deps.radarr])
    if (ctx.deps.sonarr) clients.push(['sonarr', ctx.deps.sonarr])
    if (!clients.length) return { status: 'skipped', reason: 'radarr and sonarr are not configured', counts: {} }

    const insert = ctx.db.prepare(`INSERT OR REPLACE INTO arr_records (
      id, kind, instance, remote_id, title, arr_path, container_path, monitored,
      series_id, episode_id, episode_file_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)

    let written = 0
    const problems: string[] = []

    for (const [label, client] of clients) {
      if (ctx.signal.aborted) return { status: 'cancelled', counts: { records: written } }
      let records
      try {
        records = await client.inventory()
      } catch (err) {
        problems.push(`${label}: ${describeError(err)}`)
        continue
      }
      const write = ctx.db.transaction(() => {
        for (const r of records) {
          insert.run(
            `${r.kind}:${r.instance}:${r.remoteId}`, r.kind, r.instance, r.remoteId, r.title,
            r.arrPath, r.arrPath ? ctx.deps.pathMap.toContainer(r.arrPath) ?? r.arrPath : null,
            r.monitored ? 1 : 0, r.seriesId, r.episodeId, r.episodeFileId,
          )
          written += 1
        }
      })
      write()
    }

    if (problems.length === clients.length) {
      return { status: 'skipped', reason: problems.join('; '), counts: { records: written } }
    }
    return { status: 'completed', counts: { records: written } }
  },
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run tests/scan/phases.test.ts && npm run typecheck`
Expected: 11 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/scan/phases tests/scan/phases.test.ts
git commit -m "feat: scan phases for jellyfin, filesystem, qbittorrent and arr"
```

---

### Task 6: Scan orchestrator

**Files:**
- Create: `src/scan/orchestrator.ts`
- Test: `tests/scan/orchestrator.test.ts`

**Interfaces:**
- Consumes: the four phases, `Db`.
- Produces:
  - `runScan(opts: { db, deps, signal, scanId?, phases?, onProgress? }): Promise<ScanSummary>`
  - `ScanSummary = { scanId: number; status: 'completed' | 'cancelled' | 'failed'; phases: Record<PhaseName, PhaseResult>; startedAt: string; finishedAt: string }`
  - `latestScan(db): ScanRow | null` · `pruneOldScans(db, keep = 2): number`

- [ ] **Step 1: Write the failing test**

```ts
// tests/scan/orchestrator.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../src/index/db.js'
import { runScan, latestScan, pruneOldScans } from '../../src/scan/orchestrator.js'
import { createPathMap } from '../../src/fs/pathmap.js'
import { fileConfigSchema } from '../../src/config/schema.js'
import type { Phase } from '../../src/scan/phases/types.js'

let db: Db
const deps = () => ({
  config: fileConfigSchema.parse({}), pathMap: createPathMap([]),
  jellyfin: null, qbittorrent: null, radarr: null, sonarr: null, hasher: null,
})

const fakePhase = (name: string, impl: Phase['run']): Phase => ({ name: name as Phase['name'], run: impl })

beforeEach(() => { db = openDb(join(mkdtempSync(join(tmpdir(), 'jm-orch-')), 'db.sqlite')) })

describe('runScan', () => {
  it('runs phases in order and records a completed scan', async () => {
    const order: string[] = []
    const phases = ['jellyfin', 'filesystem', 'qbittorrent', 'arr'].map((n) =>
      fakePhase(n, async () => { order.push(n); return { status: 'completed', counts: {} } }))
    const summary = await runScan({ db, deps: deps() as never, signal: new AbortController().signal, phases })
    expect(order).toEqual(['jellyfin', 'filesystem', 'qbittorrent', 'arr'])
    expect(summary.status).toBe('completed')
    const row = latestScan(db)!
    expect(row.status).toBe('completed')
    expect(row.finished_at).toBeTruthy()
  })

  it('continues after a skipped phase and records the reason', async () => {
    const phases = [
      fakePhase('jellyfin', async () => ({ status: 'skipped', reason: 'unreachable: down', counts: {} })),
      fakePhase('filesystem', async () => ({ status: 'completed', counts: { entries: 3 } })),
    ]
    const summary = await runScan({ db, deps: deps() as never, signal: new AbortController().signal, phases })
    expect(summary.status).toBe('completed')
    expect(summary.phases.jellyfin!.status).toBe('skipped')
    expect(summary.phases.jellyfin!.reason).toContain('unreachable')
    expect(summary.phases.filesystem!.status).toBe('completed')
  })

  it('marks the scan failed when a phase throws, without losing prior phase results', async () => {
    const phases = [
      fakePhase('jellyfin', async () => ({ status: 'completed', counts: { items: 1 } })),
      fakePhase('filesystem', async () => { throw new Error('disk exploded') }),
    ]
    const summary = await runScan({ db, deps: deps() as never, signal: new AbortController().signal, phases })
    expect(summary.status).toBe('failed')
    expect(summary.phases.jellyfin!.status).toBe('completed')
    expect(latestScan(db)!.error).toContain('disk exploded')
  })

  it('stops at the next phase boundary when cancelled', async () => {
    const controller = new AbortController()
    const ran: string[] = []
    const phases = [
      fakePhase('jellyfin', async () => { ran.push('jellyfin'); controller.abort(); return { status: 'completed', counts: {} } }),
      fakePhase('filesystem', async () => { ran.push('filesystem'); return { status: 'completed', counts: {} } }),
    ]
    const summary = await runScan({ db, deps: deps() as never, signal: controller.signal, phases })
    expect(ran).toEqual(['jellyfin'])
    expect(summary.status).toBe('cancelled')
    expect(latestScan(db)!.status).toBe('cancelled')
  })

  it('persists the phase cursor so a resumed scan skips finished phases', async () => {
    const controller = new AbortController()
    const first = await runScan({
      db, deps: deps() as never, signal: controller.signal,
      phases: [
        fakePhase('jellyfin', async () => ({ status: 'completed', counts: {} })),
        fakePhase('filesystem', async () => { controller.abort(); return { status: 'cancelled', counts: {} } }),
      ],
    })
    expect(first.status).toBe('cancelled')

    const ran: string[] = []
    const second = await runScan({
      db, deps: deps() as never, signal: new AbortController().signal, scanId: first.scanId,
      phases: [
        fakePhase('jellyfin', async () => { ran.push('jellyfin'); return { status: 'completed', counts: {} } }),
        fakePhase('filesystem', async () => { ran.push('filesystem'); return { status: 'completed', counts: {} } }),
      ],
    })
    expect(ran).toEqual(['filesystem'])
    expect(second.status).toBe('completed')
  })

  it('reports progress with the phase name', async () => {
    const seen: Array<{ phase: string; done: number }> = []
    await runScan({
      db, deps: deps() as never, signal: new AbortController().signal,
      onProgress: (p) => seen.push({ phase: p.phase, done: p.done }),
      phases: [fakePhase('jellyfin', async (ctx) => { ctx.progress(5, 10); return { status: 'completed', counts: {} } })],
    })
    expect(seen).toContainEqual({ phase: 'jellyfin', done: 5 })
  })
})

describe('pruneOldScans', () => {
  it('keeps the two most recent scans and deletes the rest', async () => {
    for (let i = 0; i < 4; i += 1) {
      await runScan({ db, deps: deps() as never, signal: new AbortController().signal, phases: [] })
    }
    const removed = pruneOldScans(db, 2)
    expect(removed).toBe(2)
    expect((db.prepare('SELECT COUNT(*) c FROM scans').get() as { c: number }).c).toBe(2)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/scan/orchestrator.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the orchestrator**

```ts
// src/scan/orchestrator.ts
import type { Db } from '../index/db.js'
import type { Phase, PhaseName, PhaseResult, ScanDeps } from './phases/types.js'
import { jellyfinPhase } from './phases/jellyfin.js'
import { filesystemPhase } from './phases/filesystem.js'
import { qbittorrentPhase } from './phases/qbittorrent.js'
import { arrPhase } from './phases/arr.js'

export const DEFAULT_PHASES: Phase[] = [jellyfinPhase, filesystemPhase, qbittorrentPhase, arrPhase]

export interface ScanRow {
  id: number
  started_at: string
  finished_at: string | null
  status: string
  phase: string | null
  cursor_json: string
  stats_json: string
  error: string | null
}

export interface ScanSummary {
  scanId: number
  status: 'completed' | 'cancelled' | 'failed'
  phases: Partial<Record<PhaseName, PhaseResult>>
  startedAt: string
  finishedAt: string
}

export interface ScanProgress { phase: PhaseName; done: number; total: number | null }

export function latestScan(db: Db): ScanRow | null {
  return (db.prepare('SELECT * FROM scans ORDER BY id DESC LIMIT 1').get() as ScanRow | undefined) ?? null
}

export function pruneOldScans(db: Db, keep = 2): number {
  const info = db.prepare(
    'DELETE FROM scans WHERE id NOT IN (SELECT id FROM scans ORDER BY id DESC LIMIT ?)',
  ).run(keep)
  return info.changes
}

export async function runScan(opts: {
  db: Db
  deps: ScanDeps
  signal: AbortSignal
  scanId?: number
  phases?: Phase[]
  onProgress?: (p: ScanProgress) => void
}): Promise<ScanSummary> {
  const { db } = opts
  const phases = opts.phases ?? DEFAULT_PHASES
  const startedAt = new Date().toISOString()

  let scanId: number
  let cursor: Record<string, Record<string, unknown>>
  let completed: string[]
  let results: Partial<Record<PhaseName, PhaseResult>> = {}

  if (opts.scanId) {
    const existing = db.prepare('SELECT * FROM scans WHERE id = ?').get(opts.scanId) as ScanRow | undefined
    if (!existing) throw new Error(`scan ${opts.scanId} does not exist`)
    scanId = existing.id
    const parsed = JSON.parse(existing.cursor_json) as {
      phases?: Record<string, Record<string, unknown>>
      completed?: string[]
      results?: Partial<Record<PhaseName, PhaseResult>>
    }
    cursor = parsed.phases ?? {}
    completed = parsed.completed ?? []
    results = parsed.results ?? {}
    db.prepare("UPDATE scans SET status='running', error=NULL WHERE id=?").run(scanId)
  } else {
    const info = db.prepare("INSERT INTO scans (started_at, status) VALUES (?, 'running')").run(startedAt)
    scanId = Number(info.lastInsertRowid)
    cursor = {}
    completed = []
  }

  const persistCursor = () => {
    db.prepare('UPDATE scans SET cursor_json = ? WHERE id = ?')
      .run(JSON.stringify({ phases: cursor, completed, results }), scanId)
  }

  let status: ScanSummary['status'] = 'completed'
  let error: string | null = null

  for (const phase of phases) {
    if (opts.signal.aborted) { status = 'cancelled'; break }
    if (completed.includes(phase.name)) continue

    db.prepare('UPDATE scans SET phase = ? WHERE id = ?').run(phase.name, scanId)
    try {
      const result = await phase.run({
        db,
        scanId,
        cursor: cursor[phase.name] ?? {},
        signal: opts.signal,
        deps: opts.deps,
        saveCursor: (c) => { cursor[phase.name] = c; persistCursor() },
        progress: (done, total) => opts.onProgress?.({ phase: phase.name, done, total }),
      })
      results[phase.name] = result
      if (result.status === 'cancelled') { status = 'cancelled'; persistCursor(); break }
      completed.push(phase.name)
      persistCursor()
    } catch (err) {
      error = `${phase.name}: ${(err as Error).message}`
      status = 'failed'
      break
    }
    if (opts.signal.aborted) { status = 'cancelled'; break }
  }

  const finishedAt = new Date().toISOString()
  db.prepare('UPDATE scans SET status=?, finished_at=?, error=?, stats_json=? WHERE id=?')
    .run(status, finishedAt, error, JSON.stringify(results), scanId)
  if (status === 'completed') pruneOldScans(db, 2)

  return { scanId, status, phases: results, startedAt, finishedAt }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run tests/scan/orchestrator.test.ts && npm run typecheck`
Expected: 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/scan/orchestrator.ts tests/scan/orchestrator.test.ts
git commit -m "feat: scan orchestrator with phase cursors, resume and retention"
```

---

### Task 7: Scheduler, worker thread and scan API

**Files:**
- Create: `src/scan/scheduler.ts`, `src/scan/worker.ts`, `src/scan/runner.ts`, `src/api/scan.ts`
- Modify: `src/server.ts` (register scan routes), `src/index.ts` (start scheduler)
- Test: `tests/scan/scheduler.test.ts`, `tests/api/scan.test.ts`

**Interfaces:**
- Consumes: `runScan`, `latestScan`, `requireSession`.
- Produces:
  - `createScheduler(opts: { cron: string; run: () => Promise<void>; isRunning: () => boolean; now?: () => Date }): { nextRun(): Date; tick(): Promise<'ran' | 'skipped-overlap' | 'not-due'>; start(): void; stop(): void }`
  - `createScanRunner(opts): ScanRunner` with `.start(): { scanId: number } | { error: string }`, `.cancel(): boolean`, `.status(): ScanStatus`
  - Routes `POST /api/scan/start`, `POST /api/scan/cancel`, `GET /api/scan/status`

- [ ] **Step 1: Write the failing scheduler test**

```ts
// tests/scan/scheduler.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createScheduler } from '../../src/scan/scheduler.js'

describe('scheduler', () => {
  it('does not run before the cron time is due', async () => {
    const run = vi.fn(async () => {})
    let now = new Date('2026-07-26T02:00:00Z')
    const s = createScheduler({ cron: '0 3 * * *', run, isRunning: () => false, now: () => now })
    expect(await s.tick()).toBe('not-due')
    expect(run).not.toHaveBeenCalled()
  })

  it('runs once the cron time passes', async () => {
    const run = vi.fn(async () => {})
    let now = new Date('2026-07-26T02:00:00Z')
    const s = createScheduler({ cron: '0 3 * * *', run, isRunning: () => false, now: () => now })
    await s.tick()
    now = new Date('2026-07-26T03:00:01Z')
    expect(await s.tick()).toBe('ran')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('suppresses a scheduled run while a scan is already running', async () => {
    const run = vi.fn(async () => {})
    let now = new Date('2026-07-26T02:00:00Z')
    const s = createScheduler({ cron: '0 3 * * *', run, isRunning: () => true, now: () => now })
    await s.tick()
    now = new Date('2026-07-26T03:00:01Z')
    expect(await s.tick()).toBe('skipped-overlap')
    expect(run).not.toHaveBeenCalled()
  })

  it('advances to the next occurrence after running so it does not re-fire', async () => {
    const run = vi.fn(async () => {})
    let now = new Date('2026-07-26T03:00:01Z')
    const s = createScheduler({ cron: '0 3 * * *', run, isRunning: () => false, now: () => now })
    await s.tick()
    expect(await s.tick()).toBe('not-due')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('rejects an invalid cron expression at construction', () => {
    expect(() => createScheduler({ cron: 'not a cron', run: async () => {}, isRunning: () => false }))
      .toThrow(/cron/i)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/scan/scheduler.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the scheduler**

```ts
// src/scan/scheduler.ts
import parser from 'cron-parser'

export interface Scheduler {
  nextRun(): Date
  tick(): Promise<'ran' | 'skipped-overlap' | 'not-due'>
  start(intervalMs?: number): void
  stop(): void
}

export function createScheduler(opts: {
  cron: string
  run: () => Promise<void>
  isRunning: () => boolean
  now?: () => Date
}): Scheduler {
  const now = opts.now ?? (() => new Date())
  let next: Date
  try {
    next = parser.parseExpression(opts.cron, { currentDate: now() }).next().toDate()
  } catch (err) {
    throw new Error(`invalid cron expression "${opts.cron}": ${(err as Error).message}`)
  }
  let timer: NodeJS.Timeout | null = null

  const advance = () => {
    next = parser.parseExpression(opts.cron, { currentDate: now() }).next().toDate()
  }

  return {
    nextRun: () => next,
    async tick() {
      if (now() < next) return 'not-due'
      if (opts.isRunning()) { advance(); return 'skipped-overlap' }
      advance()
      await opts.run()
      return 'ran'
    },
    start(intervalMs = 30_000) {
      if (timer) return
      timer = setInterval(() => { void this.tick() }, intervalMs)
      timer.unref?.()
    },
    stop() { if (timer) { clearInterval(timer); timer = null } },
  }
}
```

- [ ] **Step 4: Implement the runner and worker**

```ts
// src/scan/runner.ts
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import type { Db } from '../index/db.js'
import { latestScan, type ScanProgress } from './orchestrator.js'

export interface ScanStatus {
  running: boolean
  scanId: number | null
  phase: string | null
  done: number
  total: number | null
  lastScan: ReturnType<typeof latestScan>
}

export interface ScanRunner {
  start(resumeScanId?: number): { scanId: number } | { error: string }
  cancel(): boolean
  status(): ScanStatus
  isRunning(): boolean
}

/**
 * Owns the single scan worker. Two scans can never run at once: `start` refuses
 * while one is live, which is also what the scheduler's overlap check relies on.
 */
export function createScanRunner(opts: {
  db: Db
  dbPath: string
  env: NodeJS.ProcessEnv
  workerUrl?: URL
}): ScanRunner {
  let worker: Worker | null = null
  let currentScanId: number | null = null
  let progress: { phase: string | null; done: number; total: number | null } = { phase: null, done: 0, total: null }

  const workerPath = fileURLToPath(opts.workerUrl ?? new URL('./worker.js', import.meta.url))

  return {
    isRunning: () => worker !== null,

    start(resumeScanId) {
      if (worker) return { error: 'a scan is already running' }
      const row = opts.db.prepare("INSERT INTO scans (started_at, status) VALUES (?, 'running')")
      const scanId = resumeScanId ?? Number(row.run(new Date().toISOString()).lastInsertRowid)
      currentScanId = scanId
      progress = { phase: null, done: 0, total: null }

      worker = new Worker(workerPath, {
        workerData: { dbPath: opts.dbPath, scanId, env: { ...opts.env } },
      })
      worker.on('message', (msg: { type: 'progress'; payload: ScanProgress }) => {
        if (msg.type === 'progress') {
          progress = { phase: msg.payload.phase, done: msg.payload.done, total: msg.payload.total }
        }
      })
      const finish = () => { worker = null; currentScanId = null }
      worker.on('error', finish)
      worker.on('exit', finish)
      return { scanId }
    },

    cancel() {
      if (!worker) return false
      worker.postMessage({ type: 'cancel' })
      return true
    },

    status() {
      return {
        running: worker !== null,
        scanId: currentScanId,
        phase: progress.phase,
        done: progress.done,
        total: progress.total,
        lastScan: latestScan(opts.db),
      }
    },
  }
}
```

```ts
// src/scan/worker.ts
import { parentPort, workerData } from 'node:worker_threads'
import { openDb } from '../index/db.js'
import { loadConfig } from '../config/load.js'
import { createPathMap } from '../fs/pathmap.js'
import { createHasher } from '../fs/hasher.js'
import { createJellyfinClient } from '../connectors/jellyfin.js'
import { createQbitClient } from '../connectors/qbittorrent.js'
import { createRadarrClient, createSonarrClient } from '../connectors/arr.js'
import { runScan } from './orchestrator.js'

interface WorkerInput { dbPath: string; scanId: number; env: NodeJS.ProcessEnv }

const input = workerData as WorkerInput
const controller = new AbortController()
parentPort?.on('message', (msg: { type: string }) => { if (msg.type === 'cancel') controller.abort() })

const config = loadConfig(input.env)
const db = openDb(input.dbPath)

const deps = {
  config: config.file,
  pathMap: createPathMap(config.file.pathMappings),
  hasher: createHasher(db),
  jellyfin: createJellyfinClient({
    url: config.env.jellyfin.url, apiKey: config.env.jellyfin.apiKey,
    concurrency: config.file.rateLimits.jellyfin.concurrency,
    minDelayMs: config.file.rateLimits.jellyfin.minDelayMs,
  }),
  qbittorrent: createQbitClient({
    url: config.env.qbittorrent.url, user: config.env.qbittorrent.user, pass: config.env.qbittorrent.pass,
    concurrency: config.file.rateLimits.qbittorrent.concurrency,
    minDelayMs: config.file.rateLimits.qbittorrent.minDelayMs,
    privateTrackerHosts: config.file.guards.privateTrackerHosts,
  }),
  radarr: config.env.radarr
    ? createRadarrClient({ ...config.env.radarr, concurrency: config.file.rateLimits.arr.concurrency, minDelayMs: config.file.rateLimits.arr.minDelayMs })
    : null,
  sonarr: config.env.sonarr
    ? createSonarrClient({ ...config.env.sonarr, concurrency: config.file.rateLimits.arr.concurrency, minDelayMs: config.file.rateLimits.arr.minDelayMs })
    : null,
}

runScan({
  db, deps, signal: controller.signal, scanId: input.scanId,
  onProgress: (payload) => parentPort?.postMessage({ type: 'progress', payload }),
})
  .then((summary) => parentPort?.postMessage({ type: 'done', payload: summary }))
  .catch((err) => parentPort?.postMessage({ type: 'error', payload: (err as Error).message }))
  .finally(() => db.close())
```

- [ ] **Step 5: Write the failing API test**

```ts
// tests/api/scan.test.ts
import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import { registerScanRoutes } from '../../src/api/scan.js'
import { signSession } from '../../src/auth/session.js'
import { openDb } from '../../src/index/db.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SECRET = 'z'.repeat(32)
const auth = () => ({ cookie: `jellymaid_session=${signSession({ username: 'bob', userId: 'u', issuedAt: Date.now() }, SECRET)}` })

let db: ReturnType<typeof openDb>

function build(runner: Partial<ReturnType<typeof fakeRunner>> = {}) {
  const app = Fastify()
  app.register(cookie)
  db = openDb(join(mkdtempSync(join(tmpdir(), 'jm-scanapi-')), 'db.sqlite'))
  registerScanRoutes(app, { runner: { ...fakeRunner(), ...runner } as never, sessionSecret: SECRET, db })
  return app
}

function fakeRunner() {
  return {
    start: () => ({ scanId: 1 }),
    cancel: () => true,
    isRunning: () => false,
    status: () => ({ running: false, scanId: null, phase: null, done: 0, total: null, lastScan: null }),
  }
}

/** Mirrors what POST /api/pathmap/verify persists. */
function setVerification(report: { sampled: number; resolved: number; failures: unknown[] }) {
  db.prepare("INSERT OR REPLACE INTO kv (key, value_json) VALUES ('pathmap.lastVerification', ?)")
    .run(JSON.stringify({ ...report, at: new Date().toISOString() }))
}

describe('/api/scan', () => {
  it('requires a session to start', async () => {
    expect((await build().inject({ method: 'POST', url: '/api/scan/start' })).statusCode).toBe(401)
  })

  it('starts a scan and returns the id', async () => {
    const res = await build().inject({ method: 'POST', url: '/api/scan/start', headers: auth() })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ scanId: 1 })
  })

  it('returns 409 when a scan is already running', async () => {
    const res = await build({ start: () => ({ error: 'a scan is already running' }) })
      .inject({ method: 'POST', url: '/api/scan/start', headers: auth() })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/already running/)
  })

  it('reports status without a session — the UI polls it on the login screen', async () => {
    const res = await build().inject({ method: 'GET', url: '/api/scan/status' })
    expect(res.statusCode).toBe(401)
  })

  it('reports status with a session', async () => {
    const res = await build().inject({ method: 'GET', url: '/api/scan/status', headers: auth() })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ running: false })
  })

  it('returns 409 on cancel when nothing is running', async () => {
    const res = await build({ cancel: () => false })
      .inject({ method: 'POST', url: '/api/scan/cancel', headers: auth() })
    expect(res.statusCode).toBe(409)
  })
})

describe('/api/scan/start — path-map verification gate', () => {
  // Spec §11: a scan must not run against an unverified path map. Indexing the wrong
  // paths is how a cleanup tool ends up proposing deletions for files it misidentified.
  it('refuses with 412 when verification has never been run', async () => {
    const app = build()
    const res = await app.inject({ method: 'POST', url: '/api/scan/start', headers: auth() })
    expect(res.statusCode).toBe(412)
    expect(res.json().error).toMatch(/verif/i)
  })

  it('refuses when the last verification had failures', async () => {
    const app = build()
    setVerification({ sampled: 20, resolved: 12, failures: [{ jellyfinPath: '/media/x.mkv', reason: 'no mapping covers this path' }] })
    const res = await app.inject({ method: 'POST', url: '/api/scan/start', headers: auth() })
    expect(res.statusCode).toBe(412)
  })

  it('starts when the last verification was clean', async () => {
    const app = build()
    setVerification({ sampled: 20, resolved: 20, failures: [] })
    const res = await app.inject({ method: 'POST', url: '/api/scan/start', headers: auth() })
    expect(res.statusCode).toBe(202)
  })

  it('starts anyway when the operator explicitly forces it', async () => {
    const app = build()
    setVerification({ sampled: 20, resolved: 0, failures: [{ jellyfinPath: '/x', reason: 'nope' }] })
    const res = await app.inject({ method: 'POST', url: '/api/scan/start', headers: auth(), payload: { force: true } })
    expect(res.statusCode).toBe(202)
  })
})
```

- [ ] **Step 6: Implement the scan routes and wire the server**

```ts
// src/api/scan.ts
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Db } from '../index/db.js'
import type { ScanRunner } from '../scan/runner.js'
import { requireSession } from './auth.js'

const startSchema = z.object({
  resumeScanId: z.number().int().positive().optional(),
  force: z.boolean().optional(),
}).default({})

interface VerificationRecord { sampled: number; resolved: number; failures: unknown[]; at: string }

/** Spec §11: indexing against an unverified path map is how the wrong files get identified. */
function verificationBlocker(db: Db): string | null {
  const row = db.prepare("SELECT value_json FROM kv WHERE key = 'pathmap.lastVerification'").get() as
    { value_json: string } | undefined
  if (!row) return 'path mappings have never been verified — run Verify in Settings first'
  const record = JSON.parse(row.value_json) as VerificationRecord
  if (record.failures.length > 0 || record.resolved < record.sampled) {
    return `last path-map verification resolved ${record.resolved} of ${record.sampled} sampled items`
  }
  return null
}

export function registerScanRoutes(
  app: FastifyInstance,
  deps: { runner: ScanRunner; sessionSecret: string; db: Db },
): void {
  const guard = { preHandler: requireSession(deps.sessionSecret) }

  app.post('/api/scan/start', guard, async (req, reply) => {
    const parsed = startSchema.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' })
    if (!parsed.data.force) {
      const blocker = verificationBlocker(deps.db)
      if (blocker) return reply.code(412).send({ error: blocker, forcible: true })
    }
    const result = deps.runner.start(parsed.data.resumeScanId)
    if ('error' in result) return reply.code(409).send(result)
    return reply.code(202).send(result)
  })

  app.post('/api/scan/cancel', guard, async (_req, reply) => {
    return deps.runner.cancel()
      ? reply.send({ cancelled: true })
      : reply.code(409).send({ error: 'no scan is running' })
  })

  app.get('/api/scan/status', guard, async (_req, reply) => reply.send(deps.runner.status()))
}
```

Modify `src/server.ts` — add to `ServerDeps` and register:

```ts
// in ServerDeps
  scanRunner: ScanRunner

// after registerPathMapRoutes(...)
  registerScanRoutes(app, {
    runner: deps.scanRunner,
    sessionSecret: deps.config.env.sessionSecret,
    db: deps.db,
  })
```

Modify `src/api/pathmap.ts` so verification results are persisted — the gate above reads them:

```ts
  app.post('/api/pathmap/verify', guard, async (_req, reply) => {
    const mappings = readFileConfig(deps.dataDir).pathMappings
    const report = await verifyMappings({ mappings, sampleItems })
    deps.db.prepare("INSERT OR REPLACE INTO kv (key, value_json) VALUES ('pathmap.lastVerification', ?)")
      .run(JSON.stringify({ ...report, at: new Date().toISOString() }))
    return reply.send(report)
  })
```

Add `db: Db` to `registerPathMapRoutes`'s deps and pass it from `src/server.ts`. Saving a new
mapping set must also clear the record, so an edited map cannot ride on an old verification:

```ts
  app.put('/api/pathmap', guard, async (req, reply) => {
    // ...existing validation and saveConfig...
    deps.db.prepare("DELETE FROM kv WHERE key = 'pathmap.lastVerification'").run()
    return reply.send({ mappings: parsed.data.mappings })
  })
```

Modify `src/index.ts` — construct the runner and start the scheduler:

```ts
const dbPath = join(config.env.dataDir, 'jellymaid.db')
const scanRunner = createScanRunner({ db, dbPath, env: process.env })
const scheduler = createScheduler({
  cron: config.file.scanCron,
  run: async () => { scanRunner.start() },
  isRunning: () => scanRunner.isRunning(),
})
scheduler.start()

const app = buildServer({ config, db, jellyfin, logger, scanRunner })
```

Update every existing `buildServer` call in `tests/api/*.test.ts` to pass a stub runner:

```ts
scanRunner: {
  start: () => ({ scanId: 1 }), cancel: () => false, isRunning: () => false,
  status: () => ({ running: false, scanId: null, phase: null, done: 0, total: null, lastScan: null }),
} as never,
```

- [ ] **Step 7: Run the full suite**

Run: `npx vitest run && npm run typecheck && npm run build`
Expected: every test PASS including Plan 1's, typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add src/scan src/api/scan.ts src/server.ts src/index.ts tests/scan tests/api
git commit -m "feat: scan scheduler, worker thread runner and scan api"
```

---

## Definition of done

- `npm test` green; `npm run typecheck` and `npm run build` clean.
- Against the real stack: `POST /api/scan/start` completes a full pass over the live library,
  `GET /api/scan/status` reports phase progress throughout, and the four snapshot tables are
  populated with sane row counts.
- Killing the process mid-scan and calling `POST /api/scan/start` with `resumeScanId` continues
  from the interrupted phase rather than starting over.
- Stopping qBittorrent and rescanning yields a scan with `status: completed` whose
  `qbittorrent` phase is `skipped` with a reason — not a failed scan and not silent zeros.
- `grep -rn "torrents/delete" src/scan/` returns nothing: the index never deletes.
