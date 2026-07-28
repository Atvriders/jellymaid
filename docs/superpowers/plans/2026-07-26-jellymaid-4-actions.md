# Jellymaid Plan 4 — Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn selected findings into an approved, guarded plan and execute it in the one order that cannot break seeding or trigger a re-download — \*arr unmonitor, qBittorrent delete-with-data, sweep, remaining hardlinks, Jellyfin — with a full audit trail and reversible operations where reversal is possible.

**Architecture:** Three separable pieces. A **resolver** turns a path into the complete truth about it: every hardlink, every torrent on that inode, every \*arr record. **Guards** are pure functions from that resolution to a verdict. The **executor** re-runs the resolver and the guards immediately before each action, then performs the ordered steps. Because guards are pure and the resolver is the only thing that talks to services, the entire guard matrix is testable without a network.

**Tech Stack:** Node 22 · TypeScript strict · better-sqlite3 · Vitest · real temp directories with real hardlinks in tests

## Global Constraints

Copied verbatim from `docs/superpowers/specs/2026-07-26-jellymaid-design.md`. Every task's requirements implicitly include this section.

- Execution order is fixed: **\*arr unmonitor → qBittorrent delete-with-data → sweep leftovers → remaining hardlinks → Jellyfin item delete → one batched refresh.**
- **Fail-closed:** if \*arr unmonitor fails, that file's delete is **skipped entirely**.
- **\*arr is unmonitor-only.** No delete endpoint and no blocklist endpoint, ever.
- Guards are evaluated at plan-build **and re-verified immediately before each action runs**. qBittorrent and \*arr state is never taken from the index for a guard decision.
- `guard.protected` has **no override**. `guard.private-ratio` and `guard.cross-seed` may be overridden only with an explicit toggle, and the override actor and reason are recorded.
- `guard.protected` also owns **unverifiable state**, and blocks with no override when: qBittorrent is unreachable, so torrent state cannot be confirmed; or Radarr/Sonarr is unreachable or returned a PARTIAL inventory, so Jellymaid cannot confirm whether the file is \*arr-managed and therefore cannot guarantee the unmonitor-before-delete step. A partial inventory is the dangerous case — the file's `ArrMatch` is simply absent, which is not the same as "not managed", and the executor's fail-closed catch never fires because it never calls `unmonitorByPath` at all. An \*arr that is simply not configured does NOT block.
- The sweep **never climbs above the mapped library or download root**.
- Every action is idempotent. The executor holds a mutex — two plans can never run at once.
- An approved plan is an **immutable snapshot**; edits require a new plan.
- A failure does not abort the remaining actions, except the fail-closed \*arr case.
- Trash covers **non-torrent files below `trash.maxBytes` only**; everything else is permanent.
- Every action writes an `audit` row with before/after state, guard verdicts, actor and outcome.
- TypeScript strict, no `any`. Commit after every task.

## Prerequisites

Plans 1–3 complete. `findings`, `dupe_groups`, `plans`, `plan_actions`, `audit`, `trash` tables exist; connectors and the path map work against the live stack.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/plan/resolve.ts` | Path → hardlinks, torrents, \*arr records (the only service-touching part) |
| `src/plan/guards.ts` | The four guards, pure functions over a `Resolution` |
| `src/plan/planner.ts` | Findings + selections → ordered `Action[]` with verdicts and dry-run totals |
| `src/plan/trash.ts` | Move-to-trash, restore, purge |
| `src/plan/audit.ts` | Audit row writer |
| `src/plan/executor.ts` | Ordered execution, re-verification, mutex, resume |
| `src/api/plans.ts` | `/api/plans/*` routes |

---

### Task 1: Resolver

**Files:**
- Create: `src/plan/resolve.ts`
- Test: `tests/plan/resolve.test.ts`

**Interfaces:**
- Consumes: `Db`, `PathMap`, `QbitClient`, `ArrClient`.
- Produces:
  - `resolveTarget(deps, containerPath): Promise<Resolution>`
  - `Resolution = { path: string; exists: boolean; sizeBytes: number; dev: number; inode: number; nlink: number; hardlinks: string[]; torrents: TorrentMatch[]; arr: ArrMatch[]; root: PathMapping | null; sourcesUnavailable: string[] }`
  - `TorrentMatch = { hash; name; category; tags; state; ratio; seedingTimeSeconds; isPrivate; trackerHost; matchedBy: 'inode' | 'path' }`
  - `ArrMatch = { kind: 'radarr' | 'sonarr'; instance: string; remoteId: number; title: string; path: string }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/plan/resolve.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, linkSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../src/index/db.js'
import { resolveTarget } from '../../src/plan/resolve.js'
import { createPathMap } from '../../src/fs/pathmap.js'

let db: Db
let dir: string
let media: string
let linked: string

const torrent = (over: Record<string, unknown> = {}) => ({
  hash: 'H1', name: 'Heat', savePath: '/downloads', contentPath: '/downloads/Heat.mkv',
  category: 'movies', tags: [], state: 'stalledUP', ratio: 2, seedingTimeSeconds: 100,
  isPrivate: false, trackerHost: 't.example', sizeBytes: 10, progress: 1, ...over,
})

function deps(over: Record<string, unknown> = {}) {
  return {
    db,
    pathMap: createPathMap([
      { role: 'library', jellyfin: '/media/Movies', container: join(dir, 'lib'), qbit: null },
      { role: 'download', jellyfin: null, container: join(dir, 'dl'), qbit: '/downloads' },
    ]),
    qbittorrent: { torrents: async () => [] },
    radarr: null,
    sonarr: null,
    ...over,
  } as Parameters<typeof resolveTarget>[0]
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jm-resolve-'))
  db = openDb(join(dir, 'db.sqlite'))
  mkdirSync(join(dir, 'lib'), { recursive: true })
  mkdirSync(join(dir, 'dl'), { recursive: true })
  media = join(dir, 'lib', 'Heat.mkv')
  linked = join(dir, 'dl', 'Heat.mkv')
  writeFileSync(media, 'x'.repeat(500))
})

describe('resolveTarget', () => {
  it('reports a plain file with one link and no torrents', async () => {
    const r = await resolveTarget(deps(), media)
    expect(r.exists).toBe(true)
    expect(r.sizeBytes).toBe(500)
    expect(r.nlink).toBe(1)
    expect(r.hardlinks).toEqual([media])
    expect(r.torrents).toEqual([])
  })

  it('finds every hardlink to the same inode across roots', async () => {
    linkSync(media, linked)
    db.prepare(`INSERT INTO fs_entries (container_path, scan_id, parent_path, name, is_dir, size_bytes, dev, inode, nlink, is_media, library_root, root_role)
      VALUES (?,1,'p','n',0,500,?,?,2,1,?,'library')`).run(media, ...inodeOf(media), join(dir, 'lib'))
    db.prepare(`INSERT INTO fs_entries (container_path, scan_id, parent_path, name, is_dir, size_bytes, dev, inode, nlink, is_media, library_root, root_role)
      VALUES (?,1,'p','n',0,500,?,?,2,1,?,'download')`).run(linked, ...inodeOf(linked), join(dir, 'dl'))
    const r = await resolveTarget(deps(), media)
    expect(r.nlink).toBe(2)
    expect(r.hardlinks.sort()).toEqual([linked, media].sort())
  })

  it('matches a torrent by inode even when its path string differs', async () => {
    linkSync(media, linked)
    const r = await resolveTarget(deps({
      qbittorrent: { torrents: async () => [torrent({ contentPath: '/downloads/Heat.mkv' })] },
    }), media)
    expect(r.torrents).toHaveLength(1)
    expect(r.torrents[0]!.matchedBy).toBe('inode')
  })

  it('falls back to path matching when the inode is unknown', async () => {
    const r = await resolveTarget(deps({
      qbittorrent: { torrents: async () => [torrent({ contentPath: '/downloads/Nope.mkv', savePath: '/downloads' })] },
    }), join(dir, 'dl', 'Nope.mkv'))
    expect(r.torrents.map((t) => t.matchedBy)).toEqual(['path'])
  })

  it('finds two torrents on one inode — the cross-seed case', async () => {
    linkSync(media, linked)
    const r = await resolveTarget(deps({
      qbittorrent: { torrents: async () => [torrent({ hash: 'A' }), torrent({ hash: 'B' })] },
    }), media)
    expect(r.torrents.map((t) => t.hash).sort()).toEqual(['A', 'B'])
  })

  it('matches *arr records by path', async () => {
    const r = await resolveTarget(deps({
      radarr: { inventory: async () => [{ kind: 'radarr', instance: 'radarr', remoteId: 5, title: 'Heat', arrPath: media, monitored: true, seriesId: null, episodeId: null, episodeFileId: null }] },
    }), media)
    expect(r.arr).toEqual([{ kind: 'radarr', instance: 'radarr', remoteId: 5, title: 'Heat', path: media }])
  })

  it('records an unreachable service in sourcesUnavailable instead of pretending there are no torrents', async () => {
    const r = await resolveTarget(deps({
      qbittorrent: { torrents: async () => { throw Object.assign(new Error('down'), { kind: 'unreachable' }) } },
    }), media)
    expect(r.torrents).toEqual([])
    expect(r.sourcesUnavailable).toContain('qbittorrent')
  })

  it('reports a missing file as exists false rather than throwing', async () => {
    const r = await resolveTarget(deps(), join(dir, 'lib', 'Ghost.mkv'))
    expect(r.exists).toBe(false)
    expect(r.sizeBytes).toBe(0)
  })

  it('identifies the root that contains the path', async () => {
    const r = await resolveTarget(deps(), media)
    expect(r.root?.role).toBe('library')
  })
})

function inodeOf(path: string): [number, number] {
  const s = statSync(path)
  return [Number(s.dev), Number(s.ino)]
}
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/plan/resolve.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the resolver**

```ts
// src/plan/resolve.ts
import { statSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from '../index/db.js'
import type { PathMap } from '../fs/pathmap.js'
import type { PathMapping } from '../core/types.js'
import type { QbitClient, Torrent } from '../connectors/qbittorrent.js'
import type { ArrClient } from '../connectors/arr.js'

export interface TorrentMatch {
  hash: string
  name: string
  category: string | null
  tags: string[]
  state: string
  ratio: number
  seedingTimeSeconds: number
  isPrivate: boolean
  trackerHost: string | null
  matchedBy: 'inode' | 'path'
}

export interface ArrMatch {
  kind: 'radarr' | 'sonarr'
  instance: string
  remoteId: number
  title: string
  path: string
}

export interface Resolution {
  path: string
  exists: boolean
  sizeBytes: number
  dev: number
  inode: number
  nlink: number
  hardlinks: string[]
  torrents: TorrentMatch[]
  arr: ArrMatch[]
  root: PathMapping | null
  sourcesUnavailable: string[]
}

export interface ResolveDeps {
  db: Db
  pathMap: PathMap
  qbittorrent: Pick<QbitClient, 'torrents'> | null
  radarr: Pick<ArrClient, 'inventory'> | null
  sonarr: Pick<ArrClient, 'inventory'> | null
}

/**
 * The single place that turns a path into the whole truth about it. Everything downstream —
 * guards, dry-run totals, the executor — reads this and nothing else, so there is exactly one
 * definition of "what will deleting this actually touch".
 */
export async function resolveTarget(deps: ResolveDeps, containerPath: string): Promise<Resolution> {
  const sourcesUnavailable: string[] = []

  let dev = 0
  let inode = 0
  let nlink = 0
  let sizeBytes = 0
  let exists = false
  try {
    const st = statSync(containerPath)
    exists = true
    dev = Number(st.dev)
    inode = Number(st.ino)
    nlink = st.nlink
    sizeBytes = st.size
  } catch { /* missing file: exists stays false */ }

  const hardlinks = exists && nlink > 1
    ? (deps.db.prepare('SELECT container_path FROM fs_entries WHERE dev = ? AND inode = ?')
        .all(dev, inode) as Array<{ container_path: string }>).map((r) => r.container_path)
    : []
  if (exists && !hardlinks.includes(containerPath)) hardlinks.push(containerPath)

  const inodeSet = new Set(hardlinks)

  let torrents: TorrentMatch[] = []
  if (deps.qbittorrent) {
    try {
      const all = await deps.qbittorrent.torrents()
      torrents = all.flatMap((t) => matchTorrent(t, deps.pathMap, containerPath, inodeSet, dev, inode))
    } catch (err) {
      sourcesUnavailable.push('qbittorrent')
      void err
    }
  } else {
    sourcesUnavailable.push('qbittorrent')
  }

  const arr: ArrMatch[] = []
  for (const [label, client] of [['radarr', deps.radarr], ['sonarr', deps.sonarr]] as const) {
    if (!client) continue
    try {
      for (const record of await client.inventory()) {
        const mapped = record.arrPath ? deps.pathMap.toContainer(record.arrPath) ?? record.arrPath : null
        if (mapped && (mapped === containerPath || inodeSet.has(mapped))) {
          arr.push({ kind: record.kind, instance: record.instance, remoteId: record.remoteId, title: record.title, path: mapped })
        }
      }
    } catch {
      sourcesUnavailable.push(label)
    }
  }

  return {
    path: containerPath,
    exists,
    sizeBytes,
    dev,
    inode,
    nlink,
    hardlinks: hardlinks.sort(),
    torrents,
    arr,
    root: deps.pathMap.rootFor(containerPath),
    sourcesUnavailable,
  }
}

function matchTorrent(
  t: Torrent, pathMap: PathMap, target: string, inodeSet: Set<string>, dev: number, inode: number,
): TorrentMatch[] {
  const base = {
    hash: t.hash, name: t.name, category: t.category, tags: t.tags, state: t.state,
    ratio: t.ratio, seedingTimeSeconds: t.seedingTimeSeconds, isPrivate: t.isPrivate,
    trackerHost: t.trackerHost,
  }
  const contentContainer = t.contentPath ? pathMap.qbitToContainer(t.contentPath) : null
  const saveContainer = t.savePath ? pathMap.qbitToContainer(t.savePath) : null

  // Inode is authoritative: the same bytes under a different path string still match.
  for (const candidate of [contentContainer, saveContainer]) {
    if (!candidate) continue
    if (inodeSet.has(candidate)) return [{ ...base, matchedBy: 'inode' }]
    try {
      const st = statSync(candidate)
      if (Number(st.dev) === dev && Number(st.ino) === inode && inode !== 0) {
        return [{ ...base, matchedBy: 'inode' }]
      }
    } catch { /* not present */ }
  }

  if (contentContainer === target) return [{ ...base, matchedBy: 'path' }]
  if (saveContainer && target.startsWith(join(saveContainer, ''))) return [{ ...base, matchedBy: 'path' }]
  return []
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run tests/plan/resolve.test.ts && npm run typecheck`
Expected: 9 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/plan/resolve.ts tests/plan/resolve.test.ts
git commit -m "feat: target resolver joining hardlinks, torrents and arr records by inode"
```

---

### Task 2: Guards

**Files:**
- Create: `src/plan/guards.ts`
- Test: `tests/plan/guards.test.ts`

**Interfaces:**
- Consumes: `Resolution`, `GuardVerdict`, `FileConfig`.
- Produces:
  - `evaluateGuards(resolution: Resolution, config: FileConfig): GuardVerdict[]`
  - `isBlocked(verdicts: GuardVerdict[], overrides: GuardId[]): { blocked: boolean; by: GuardId[] }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/plan/guards.test.ts
import { describe, it, expect } from 'vitest'
import { evaluateGuards, isBlocked } from '../../src/plan/guards.js'
import { fileConfigSchema } from '../../src/config/schema.js'
import type { Resolution } from '../../src/plan/resolve.js'

const config = (over = {}) => fileConfigSchema.parse({ guards: { minRatio: 1.0, minSeedTimeDays: 14, ...over } })

const torrent = (over = {}) => ({
  hash: 'H1', name: 'Heat', category: null, tags: [] as string[], state: 'stalledUP',
  ratio: 2, seedingTimeSeconds: 30 * 86_400, isPrivate: false, trackerHost: 't.example',
  matchedBy: 'inode' as const, ...over,
})

const resolution = (over: Partial<Resolution> = {}): Resolution => ({
  path: '/mnt/m/Heat.mkv', exists: true, sizeBytes: 100, dev: 1, inode: 2, nlink: 1,
  hardlinks: ['/mnt/m/Heat.mkv'], torrents: [], arr: [], root: null, sourcesUnavailable: [],
  ...over,
})

const verdict = (verdicts: ReturnType<typeof evaluateGuards>, id: string) => verdicts.find((v) => v.guard === id)!

describe('guard.private-ratio', () => {
  it('passes a public torrent regardless of ratio', () => {
    const v = evaluateGuards(resolution({ torrents: [torrent({ isPrivate: false, ratio: 0, seedingTimeSeconds: 0 })] }), config())
    expect(verdict(v, 'guard.private-ratio').outcome).toBe('pass')
  })

  it('blocks a private torrent below the ratio minimum', () => {
    const v = evaluateGuards(resolution({ torrents: [torrent({ isPrivate: true, ratio: 0.4 })] }), config())
    const g = verdict(v, 'guard.private-ratio')
    expect(g.outcome).toBe('block')
    expect(g.overridable).toBe(true)
    expect(g.reason).toMatch(/ratio/i)
  })

  it('blocks a private torrent below the seed-time minimum even at a good ratio', () => {
    const v = evaluateGuards(resolution({ torrents: [torrent({ isPrivate: true, ratio: 5, seedingTimeSeconds: 86_400 })] }), config())
    expect(verdict(v, 'guard.private-ratio').outcome).toBe('block')
    expect(verdict(v, 'guard.private-ratio').reason).toMatch(/seed/i)
  })

  it('passes a private torrent that meets both minimums', () => {
    const v = evaluateGuards(resolution({ torrents: [torrent({ isPrivate: true, ratio: 1.5, seedingTimeSeconds: 20 * 86_400 })] }), config())
    expect(verdict(v, 'guard.private-ratio').outcome).toBe('pass')
  })

  it('blocks when any one of several torrents fails', () => {
    const v = evaluateGuards(resolution({
      torrents: [torrent({ isPrivate: true, ratio: 5, seedingTimeSeconds: 30 * 86_400 }), torrent({ hash: 'H2', isPrivate: true, ratio: 0.1 })],
    }), config())
    expect(verdict(v, 'guard.private-ratio').outcome).toBe('block')
  })

  it('respects raised minimums from config', () => {
    const v = evaluateGuards(resolution({ torrents: [torrent({ isPrivate: true, ratio: 1.5, seedingTimeSeconds: 20 * 86_400 })] }), config({ minRatio: 3 }))
    expect(verdict(v, 'guard.private-ratio').outcome).toBe('block')
  })
})

describe('guard.cross-seed', () => {
  it('passes with zero or one torrent', () => {
    expect(verdict(evaluateGuards(resolution(), config()), 'guard.cross-seed').outcome).toBe('pass')
    expect(verdict(evaluateGuards(resolution({ torrents: [torrent()] }), config()), 'guard.cross-seed').outcome).toBe('pass')
  })

  it('blocks when two torrents share the target, listing both hashes', () => {
    const v = verdict(evaluateGuards(resolution({ torrents: [torrent({ hash: 'A' }), torrent({ hash: 'B' })] }), config()), 'guard.cross-seed')
    expect(v.outcome).toBe('block')
    expect(v.overridable).toBe(true)
    expect(v.evidence.hashes).toEqual(['A', 'B'])
  })
})

describe('guard.hardlink', () => {
  it('passes for a single-link file', () => {
    expect(verdict(evaluateGuards(resolution(), config()), 'guard.hardlink').outcome).toBe('pass')
  })

  it('warns, never blocks, when other links exist and lists them', () => {
    const v = verdict(evaluateGuards(resolution({
      nlink: 2, hardlinks: ['/mnt/m/Heat.mkv', '/mnt/d/Heat.mkv'],
    }), config()), 'guard.hardlink')
    expect(v.outcome).toBe('warn')
    expect(v.evidence.otherLinks).toEqual(['/mnt/d/Heat.mkv'])
    expect(v.evidence.bytesReclaimed).toBe(0)
  })

  it('reports the real byte saving when every link is included', () => {
    const v = verdict(evaluateGuards(resolution({ nlink: 1, hardlinks: ['/mnt/m/Heat.mkv'], sizeBytes: 500 }), config()), 'guard.hardlink')
    expect(v.evidence.bytesReclaimed).toBe(500)
  })
})

describe('guard.protected', () => {
  it('blocks a downloading torrent and is not overridable', () => {
    const v = verdict(evaluateGuards(resolution({ torrents: [torrent({ state: 'downloading' })] }), config()), 'guard.protected')
    expect(v.outcome).toBe('block')
    expect(v.overridable).toBe(false)
  })

  it.each(['checkingUP', 'moving', 'allocating'])('blocks state %s', (state) => {
    expect(verdict(evaluateGuards(resolution({ torrents: [torrent({ state })] }), config()), 'guard.protected').outcome).toBe('block')
  })

  it('blocks a protected category', () => {
    const cfg = fileConfigSchema.parse({ guards: { protectedCategories: ['permaseed'] } })
    expect(verdict(evaluateGuards(resolution({ torrents: [torrent({ category: 'permaseed' })] }), cfg), 'guard.protected').outcome).toBe('block')
  })

  it('blocks a protected tag', () => {
    const cfg = fileConfigSchema.parse({ guards: { protectedTags: ['keep'] } })
    expect(verdict(evaluateGuards(resolution({ torrents: [torrent({ tags: ['hd', 'keep'] })] }), cfg), 'guard.protected').outcome).toBe('block')
  })

  it('blocks when qBittorrent could not be reached — unknown torrent state is not a safe state', () => {
    const v = verdict(evaluateGuards(resolution({ sourcesUnavailable: ['qbittorrent'] }), config()), 'guard.protected')
    expect(v.outcome).toBe('block')
    expect(v.overridable).toBe(false)
    expect(v.reason).toMatch(/unavailable/i)
  })
})

describe('isBlocked', () => {
  it('is blocked when any guard blocks', () => {
    const v = evaluateGuards(resolution({ torrents: [torrent({ state: 'downloading' })] }), config())
    expect(isBlocked(v, []).blocked).toBe(true)
  })

  it('clears an overridable block when that guard is overridden', () => {
    const v = evaluateGuards(resolution({ torrents: [torrent({ isPrivate: true, ratio: 0.1 })] }), config())
    expect(isBlocked(v, ['guard.private-ratio']).blocked).toBe(false)
  })

  it('cannot be cleared for a non-overridable guard', () => {
    const v = evaluateGuards(resolution({ torrents: [torrent({ state: 'downloading' })] }), config())
    expect(isBlocked(v, ['guard.protected']).blocked).toBe(true)
    expect(isBlocked(v, ['guard.protected']).by).toEqual(['guard.protected'])
  })

  it('is not blocked by a warn verdict', () => {
    const v = evaluateGuards(resolution({ nlink: 2, hardlinks: ['/a', '/b'] }), config())
    expect(isBlocked(v, []).blocked).toBe(false)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/plan/guards.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the guards**

```ts
// src/plan/guards.ts
import type { GuardId, GuardVerdict } from '../core/types.js'
import type { FileConfig } from '../config/schema.js'
import type { Resolution, TorrentMatch } from './resolve.js'

const BUSY_STATES = new Set([
  'downloading', 'metaDL', 'stalledDL', 'checkingDL', 'checkingUP', 'checkingResumeData',
  'allocating', 'moving', 'forcedDL',
])

const pass = (guard: GuardId, reason: string, evidence: Record<string, unknown> = {}): GuardVerdict =>
  ({ guard, outcome: 'pass', overridable: false, reason, evidence })

export function evaluateGuards(r: Resolution, config: FileConfig): GuardVerdict[] {
  return [privateRatio(r, config), crossSeed(r), hardlink(r), protectedState(r, config)]
}

function privateRatio(r: Resolution, config: FileConfig): GuardVerdict {
  const minSeedSeconds = config.guards.minSeedTimeDays * 86_400
  const offenders = r.torrents.filter(
    (t) => t.isPrivate && (t.ratio < config.guards.minRatio || t.seedingTimeSeconds < minSeedSeconds),
  )
  if (!offenders.length) {
    return pass('guard.private-ratio', 'no private torrent is below its seeding minimums')
  }
  const detail = offenders.map((t) => ({
    hash: t.hash, name: t.name, ratio: t.ratio,
    seedingDays: Number((t.seedingTimeSeconds / 86_400).toFixed(1)),
    trackerHost: t.trackerHost,
    // Surfaced so an operator can tell "this really is a private tracker" from
    // "qBittorrent did not report privacy, so Jellymaid assumed the worst". The second
    // is fixed by listing the tracker in privateTrackerHosts or upgrading qBittorrent.
    privacySource: t.privacySource,
  }))
  const reasons: string[] = []
  if (offenders.some((t) => t.ratio < config.guards.minRatio)) reasons.push(`ratio below ${config.guards.minRatio}`)
  if (offenders.some((t) => t.seedingTimeSeconds < minSeedSeconds)) reasons.push(`seed time below ${config.guards.minSeedTimeDays} days`)
  return {
    guard: 'guard.private-ratio',
    outcome: 'block',
    overridable: true,
    reason: `private tracker torrent with ${reasons.join(' and ')}`,
    evidence: { offenders: detail, minRatio: config.guards.minRatio, minSeedTimeDays: config.guards.minSeedTimeDays },
  }
}

function crossSeed(r: Resolution): GuardVerdict {
  if (r.torrents.length < 2) return pass('guard.cross-seed', 'at most one torrent backs this file')
  return {
    guard: 'guard.cross-seed',
    outcome: 'block',
    overridable: true,
    reason: `${r.torrents.length} torrents share these bytes; removing one with data breaks the others`,
    evidence: {
      hashes: r.torrents.map((t) => t.hash).sort(),
      names: r.torrents.map((t) => t.name),
    },
  }
}

function hardlink(r: Resolution): GuardVerdict {
  const others = r.hardlinks.filter((p) => p !== r.path)
  if (r.nlink <= 1 || others.length === 0) {
    return pass('guard.hardlink', 'file has a single link', { bytesReclaimed: r.sizeBytes, otherLinks: [] })
  }
  return {
    guard: 'guard.hardlink',
    outcome: 'warn',
    overridable: false,
    reason: `${r.nlink} links point at these bytes; removing only this path frees nothing`,
    // Space is reclaimed only when the last link goes, so the honest number here is zero.
    evidence: { otherLinks: others, nlink: r.nlink, bytesReclaimed: 0, bytesIfAllLinksRemoved: r.sizeBytes },
  }
}

function protectedState(r: Resolution, config: FileConfig): GuardVerdict {
  if (r.sourcesUnavailable.includes('qbittorrent')) {
    return {
      guard: 'guard.protected',
      outcome: 'block',
      overridable: false,
      reason: 'qBittorrent is unavailable, so torrent state cannot be verified',
      evidence: { sourcesUnavailable: r.sourcesUnavailable },
    }
  }
  const categories = new Set(config.guards.protectedCategories.map((c) => c.toLowerCase()))
  const tags = new Set(config.guards.protectedTags.map((t) => t.toLowerCase()))
  const offenders: Array<{ hash: string; why: string }> = []
  for (const t of r.torrents) {
    if (BUSY_STATES.has(t.state)) offenders.push({ hash: t.hash, why: `state ${t.state}` })
    else if (t.category && categories.has(t.category.toLowerCase())) offenders.push({ hash: t.hash, why: `protected category ${t.category}` })
    else {
      const tag = t.tags.find((x) => tags.has(x.toLowerCase()))
      if (tag) offenders.push({ hash: t.hash, why: `protected tag ${tag}` })
    }
  }
  if (!offenders.length) return pass('guard.protected', 'no torrent is busy or protected')
  return {
    guard: 'guard.protected',
    outcome: 'block',
    overridable: false,
    reason: offenders.map((o) => o.why).join('; '),
    evidence: { offenders },
  }
}

export function isBlocked(verdicts: GuardVerdict[], overrides: GuardId[]): { blocked: boolean; by: GuardId[] } {
  const overrideSet = new Set(overrides)
  const by = verdicts
    .filter((v) => v.outcome === 'block' && !(v.overridable && overrideSet.has(v.guard)))
    .map((v) => v.guard)
  return { blocked: by.length > 0, by }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run tests/plan/guards.test.ts && npm run typecheck`
Expected: 20 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/plan/guards.ts tests/plan/guards.test.ts
git commit -m "feat: four safety guards with fail-safe unknown-state blocking"
```

---

### Task 3: Planner

**Files:**
- Create: `src/plan/planner.ts`
- Test: `tests/plan/planner.test.ts`

**Interfaces:**
- Consumes: `resolveTarget`, `evaluateGuards`, `isBlocked`, `Db`.
- Produces:
  - `buildPlan(deps, request): Promise<PlanView>`
  - `PlanRequest = { createdBy: string; actions: RequestedAction[] }`
  - `RequestedAction = { type: ActionType; targetPath?: string; itemIds?: string[]; overrides?: GuardId[] }`
  - `PlanView = { id; status; createdBy; actions: PlanActionView[]; dryRun: { deleteCount; bytesFreed; torrentsRemoved; blockedCount } }`
  - `getPlan(db, id): PlanView | null` · `approvePlan(db, id, approvedBy): PlanView`

- [ ] **Step 1: Write the failing test**

```ts
// tests/plan/planner.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, linkSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { openDb, type Db } from '../../src/index/db.js'
import { buildPlan, getPlan, approvePlan } from '../../src/plan/planner.js'
import { createPathMap } from '../../src/fs/pathmap.js'
import { fileConfigSchema } from '../../src/config/schema.js'

let db: Db
let dir: string
let a: string
let b: string

const torrent = (over = {}) => ({
  hash: 'H1', name: 'Heat', savePath: '/downloads', contentPath: '/downloads/Heat.mkv',
  category: null, tags: [] as string[], state: 'stalledUP', ratio: 5, seedingTimeSeconds: 30 * 86_400,
  isPrivate: false, trackerHost: 't', sizeBytes: 10, progress: 1, ...over,
})

function deps(over: Record<string, unknown> = {}) {
  return {
    db,
    config: fileConfigSchema.parse({}),
    pathMap: createPathMap([{ role: 'library', jellyfin: '/media', container: join(dir, 'lib'), qbit: '/downloads' }]),
    qbittorrent: { torrents: async () => [] },
    radarr: null,
    sonarr: null,
    ...over,
  } as Parameters<typeof buildPlan>[0]
}

/**
 * The resolver finds sibling hardlinks through fs_entries, which a real scan populates.
 * Tests that care about link accounting must index their files the same way.
 */
function indexFile(path: string) {
  const st = statSync(path)
  db.prepare(`INSERT OR REPLACE INTO fs_entries (container_path, scan_id, parent_path, name, ext,
    is_dir, size_bytes, mtime, dev, inode, nlink, is_media, library_root, root_role)
    VALUES (?,1,?,?,'.mkv',0,?,0,?,?,?,1,?,'library')`).run(
    path, dirname(path), basename(path), st.size, Number(st.dev), Number(st.ino), st.nlink, join(dir, 'lib'),
  )
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jm-plan-'))
  db = openDb(join(dir, 'db.sqlite'))
  mkdirSync(join(dir, 'lib'), { recursive: true })
  a = join(dir, 'lib', 'A.mkv'); b = join(dir, 'lib', 'B.mkv')
  writeFileSync(a, 'x'.repeat(1000)); writeFileSync(b, 'y'.repeat(2000))
})

describe('buildPlan', () => {
  it('creates a draft plan with one action per request', async () => {
    const plan = await buildPlan(deps(), { createdBy: 'bob', actions: [
      { type: 'delete-media', targetPath: a }, { type: 'delete-media', targetPath: b },
    ] })
    expect(plan.status).toBe('draft')
    expect(plan.actions).toHaveLength(2)
    expect(plan.createdBy).toBe('bob')
  })

  it('totals the bytes that would actually be freed', async () => {
    const plan = await buildPlan(deps(), { createdBy: 'bob', actions: [
      { type: 'delete-media', targetPath: a }, { type: 'delete-media', targetPath: b },
    ] })
    expect(plan.dryRun.bytesFreed).toBe(3000)
    expect(plan.dryRun.deleteCount).toBe(2)
  })

  it('counts zero freed bytes for a hardlinked file whose other link is not in the plan', async () => {
    const linked = join(dir, 'lib', 'A-link.mkv')
    linkSync(a, linked)
    indexFile(a); indexFile(linked)
    const plan = await buildPlan(deps(), { createdBy: 'bob', actions: [{ type: 'delete-media', targetPath: a }] })
    expect(plan.dryRun.bytesFreed).toBe(0)
  })

  it('counts the full size once when every link is included in the plan', async () => {
    const linked = join(dir, 'lib', 'A-link.mkv')
    linkSync(a, linked)
    indexFile(a); indexFile(linked)
    const plan = await buildPlan(deps(), { createdBy: 'bob', actions: [
      { type: 'delete-media', targetPath: a }, { type: 'delete-media', targetPath: linked },
    ] })
    expect(plan.dryRun.bytesFreed).toBe(1000)
  })

  it('marks a guard-blocked action blocked and counts it', async () => {
    const plan = await buildPlan(deps({
      qbittorrent: { torrents: async () => [torrent({ state: 'downloading' })] },
    }), { createdBy: 'bob', actions: [{ type: 'delete-media', targetPath: a }] })
    expect(plan.actions[0]!.status).toBe('blocked')
    expect(plan.dryRun.blockedCount).toBe(1)
  })

  it('leaves an action pending when an overridable guard is overridden', async () => {
    const plan = await buildPlan(deps({
      config: fileConfigSchema.parse({ guards: { minRatio: 10 } }),
      qbittorrent: { torrents: async () => [torrent({ isPrivate: true, ratio: 1 })] },
    }), { createdBy: 'bob', actions: [{ type: 'delete-media', targetPath: a, overrides: ['guard.private-ratio'] }] })
    expect(plan.actions[0]!.status).toBe('pending')
  })

  it('records the override in the persisted action', async () => {
    await buildPlan(deps({
      config: fileConfigSchema.parse({ guards: { minRatio: 10 } }),
      qbittorrent: { torrents: async () => [torrent({ isPrivate: true, ratio: 1 })] },
    }), { createdBy: 'bob', actions: [{ type: 'delete-media', targetPath: a, overrides: ['guard.private-ratio'] }] })
    const row = db.prepare('SELECT override_by, payload_json FROM plan_actions').get() as { override_by: string; payload_json: string }
    expect(row.override_by).toBe('bob')
    expect(JSON.parse(row.payload_json).overrides).toEqual(['guard.private-ratio'])
  })

  it('counts the torrents that would be removed, deduplicated across actions', async () => {
    const plan = await buildPlan(deps({
      qbittorrent: { torrents: async () => [torrent({ contentPath: '/downloads/A.mkv' })] },
    }), { createdBy: 'bob', actions: [{ type: 'delete-media', targetPath: a }] })
    expect(plan.dryRun.torrentsRemoved).toBe(1)
  })

  it('rejects merge-versions with fewer than two items', async () => {
    await expect(buildPlan(deps(), { createdBy: 'bob', actions: [{ type: 'merge-versions', itemIds: ['only'] }] }))
      .rejects.toThrow(/at least two/i)
  })

  it('rejects a delete whose path escapes every configured root', async () => {
    await expect(buildPlan(deps(), { createdBy: 'bob', actions: [{ type: 'delete-media', targetPath: '/etc/passwd' }] }))
      .rejects.toThrow(/outside/i)
  })

  it('orders actions so merges run before deletes', async () => {
    const plan = await buildPlan(deps(), { createdBy: 'bob', actions: [
      { type: 'delete-media', targetPath: a },
      { type: 'merge-versions', itemIds: ['x', 'y'] },
    ] })
    expect(plan.actions.map((x) => x.type)).toEqual(['merge-versions', 'delete-media'])
  })
})

describe('approvePlan', () => {
  it('moves a draft to approved and stamps the approver', async () => {
    const plan = await buildPlan(deps(), { createdBy: 'bob', actions: [{ type: 'delete-media', targetPath: a }] })
    const approved = approvePlan(db, plan.id, 'bob')
    expect(approved.status).toBe('approved')
    expect(getPlan(db, plan.id)!.status).toBe('approved')
  })

  it('refuses to approve twice — an approved plan is immutable', async () => {
    const plan = await buildPlan(deps(), { createdBy: 'bob', actions: [{ type: 'delete-media', targetPath: a }] })
    approvePlan(db, plan.id, 'bob')
    expect(() => approvePlan(db, plan.id, 'bob')).toThrow(/not a draft/i)
  })

  it('refuses to approve a plan whose every action is blocked', async () => {
    const plan = await buildPlan(deps({
      qbittorrent: { torrents: async () => [torrent({ state: 'downloading' })] },
    }), { createdBy: 'bob', actions: [{ type: 'delete-media', targetPath: a }] })
    expect(() => approvePlan(db, plan.id, 'bob')).toThrow(/no executable actions/i)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/plan/planner.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the planner**

```ts
// src/plan/planner.ts
import { randomUUID } from 'node:crypto'
import type { Db } from '../index/db.js'
import type { ActionType, GuardId, GuardVerdict, ActionStatus } from '../core/types.js'
import type { FileConfig } from '../config/schema.js'
import type { PathMap } from '../fs/pathmap.js'
import { resolveTarget, type ResolveDeps, type Resolution } from './resolve.js'
import { evaluateGuards, isBlocked } from './guards.js'

export interface RequestedAction {
  type: ActionType
  targetPath?: string
  itemIds?: string[]
  overrides?: GuardId[]
}

export interface PlanRequest { createdBy: string; actions: RequestedAction[] }

export interface PlanActionView {
  id: string
  seq: number
  type: ActionType
  status: ActionStatus
  payload: RequestedAction & { resolution?: Resolution }
  guardVerdicts: GuardVerdict[]
  error: string | null
}

export interface PlanView {
  id: string
  status: string
  createdBy: string
  createdAt: string
  approvedBy: string | null
  actions: PlanActionView[]
  dryRun: { deleteCount: number; bytesFreed: number; torrentsRemoved: number; blockedCount: number }
}

export interface PlannerDeps extends ResolveDeps {
  config: FileConfig
  pathMap: PathMap
}

/** Merges are library-only and cheap; running them first means a failed delete never leaves a half-merged group. */
const ORDER: Record<ActionType, number> = {
  'merge-versions': 0,
  'split-versions': 1,
  'delete-media': 2,
  'delete-junk-file': 3,
  'remove-empty-folder': 4,
}

export async function buildPlan(deps: PlannerDeps, request: PlanRequest): Promise<PlanView> {
  const planId = randomUUID()
  const createdAt = new Date().toISOString()

  const ordered = [...request.actions].sort((a, b) => ORDER[a.type] - ORDER[b.type])
  const rows: Array<{
    id: string; seq: number; type: ActionType; payload: RequestedAction & { resolution?: Resolution }
    verdicts: GuardVerdict[]; status: ActionStatus
  }> = []

  const touchesPath = new Set<string>()
  for (const action of ordered) {
    if (action.type === 'merge-versions' && (action.itemIds?.length ?? 0) < 2) {
      throw new Error('merge-versions requires at least two item ids')
    }
    if (action.targetPath) touchesPath.add(action.targetPath)
  }

  let bytesFreed = 0
  let deleteCount = 0
  let blockedCount = 0
  const torrentHashes = new Set<string>()

  for (const [index, action] of ordered.entries()) {
    let verdicts: GuardVerdict[] = []
    let resolution: Resolution | undefined
    let status: ActionStatus = 'pending'

    if (action.targetPath) {
      const root = deps.pathMap.rootFor(action.targetPath)
      if (!root || !deps.pathMap.isWithinRoot(action.targetPath, root)) {
        throw new Error(`refusing to plan an action outside every configured root: ${action.targetPath}`)
      }
      resolution = await resolveTarget(deps, action.targetPath)
      verdicts = evaluateGuards(resolution, deps.config)
      const blocked = isBlocked(verdicts, action.overrides ?? [])
      if (blocked.blocked) { status = 'blocked'; blockedCount += 1 }

      if (action.type === 'delete-media' || action.type === 'delete-junk-file') {
        deleteCount += 1
        // Space is reclaimed only when EVERY link to the inode goes away in this same plan.
        // Comparing against nlink rather than the discovered link list matters: if the index
        // knows about fewer links than the inode actually has, the honest answer is zero.
        const linksInPlan = resolution.hardlinks.filter((p) => touchesPath.has(p)).length
        const allLinksIncluded = resolution.nlink <= linksInPlan
        if (status !== 'blocked' && allLinksIncluded) {
          // Count the inode once: only the lexicographically first participating link pays.
          const others = resolution.hardlinks.filter((p) => p !== action.targetPath && touchesPath.has(p))
          const alreadyCounted = others.some((p) => p < action.targetPath!)
          if (!alreadyCounted) bytesFreed += resolution.sizeBytes
        }
        for (const t of resolution.torrents) torrentHashes.add(t.hash)
      }
    }

    rows.push({
      id: randomUUID(),
      seq: index,
      type: action.type,
      payload: { ...action, resolution },
      verdicts,
      status,
    })
  }

  const dryRun = { deleteCount, bytesFreed, torrentsRemoved: torrentHashes.size, blockedCount }

  const write = deps.db.transaction(() => {
    deps.db.prepare(
      'INSERT INTO plans (id, created_at, created_by, status, dry_run_json) VALUES (?,?,?,?,?)',
    ).run(planId, createdAt, request.createdBy, 'draft', JSON.stringify(dryRun))
    const insert = deps.db.prepare(`INSERT INTO plan_actions
      (id, plan_id, seq, type, payload_json, guard_verdicts_json, status, override_by, override_reason)
      VALUES (?,?,?,?,?,?,?,?,?)`)
    for (const r of rows) {
      const overrides = r.payload.overrides ?? []
      insert.run(
        r.id, planId, r.seq, r.type, JSON.stringify(r.payload), JSON.stringify(r.verdicts), r.status,
        overrides.length ? request.createdBy : null,
        overrides.length ? `overrode ${overrides.join(', ')}` : null,
      )
    }
  })
  write()

  return getPlan(deps.db, planId)!
}

interface PlanRow {
  id: string; created_at: string; created_by: string; status: string
  dry_run_json: string; approved_by: string | null
}
interface ActionRow {
  id: string; seq: number; type: ActionType; payload_json: string
  guard_verdicts_json: string; status: ActionStatus; error: string | null
}

export function getPlan(db: Db, id: string): PlanView | null {
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as PlanRow | undefined
  if (!plan) return null
  const actions = db.prepare('SELECT * FROM plan_actions WHERE plan_id = ? ORDER BY seq').all(id) as ActionRow[]
  return {
    id: plan.id,
    status: plan.status,
    createdBy: plan.created_by,
    createdAt: plan.created_at,
    approvedBy: plan.approved_by,
    dryRun: JSON.parse(plan.dry_run_json),
    actions: actions.map((a) => ({
      id: a.id,
      seq: a.seq,
      type: a.type,
      status: a.status,
      payload: JSON.parse(a.payload_json),
      guardVerdicts: JSON.parse(a.guard_verdicts_json),
      error: a.error,
    })),
  }
}

export function approvePlan(db: Db, id: string, approvedBy: string): PlanView {
  const plan = getPlan(db, id)
  if (!plan) throw new Error(`plan ${id} does not exist`)
  if (plan.status !== 'draft') throw new Error(`plan ${id} is not a draft (status: ${plan.status})`)
  if (!plan.actions.some((a) => a.status === 'pending')) {
    throw new Error('plan has no executable actions — every action is blocked')
  }
  db.prepare("UPDATE plans SET status='approved', approved_at=?, approved_by=? WHERE id=?")
    .run(new Date().toISOString(), approvedBy, id)
  return getPlan(db, id)!
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run tests/plan/planner.test.ts && npm run typecheck`
Expected: 14 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/plan/planner.ts tests/plan/planner.test.ts
git commit -m "feat: planner with guard verdicts, honest dry-run totals and approval gate"
```

---

### Task 4: Trash and audit

**Files:**
- Create: `src/plan/trash.ts`, `src/plan/audit.ts`
- Test: `tests/plan/trash.test.ts`

**Interfaces:**
- Produces:
  - `moveToTrash(deps, opts: { path; planId; sizeBytes }): { trashed: true; trashPath: string } | { trashed: false; reason: string }`
  - `restoreFromTrash(deps, trashId): { restored: boolean; reason?: string }`
  - `purgeExpiredTrash(deps, now?): number`
  - `writeAudit(db, entry: AuditEntry): void` where `AuditEntry = { actor; actionType; subject; before?; after?; outcome; planId?; planActionId? }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/plan/trash.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  it('refuses a path with no configured root', () => {
    const res = moveToTrash(deps(), { path: '/etc/hosts', planId: 'p1', sizeBytes: 1 })
    expect(res.trashed).toBe(false)
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
    expect(purgeExpiredTrash(deps(), new Date('2020-01-01T00:00:00Z'))).toBe(0)
    const purged = purgeExpiredTrash(deps(), new Date(Date.now() + 40 * 86_400_000))
    expect(purged).toBe(1)
    expect((db.prepare('SELECT COUNT(*) c FROM trash').get() as { c: number }).c).toBe(0)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/plan/trash.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement trash and audit**

```ts
// src/plan/trash.ts
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Db } from '../index/db.js'
import type { FileConfig } from '../config/schema.js'
import type { PathMap } from '../fs/pathmap.js'
import { TRASH_DIR_NAME } from '../fs/walker.js'

export interface TrashDeps { db: Db; config: FileConfig; pathMap: PathMap }

export function moveToTrash(
  deps: TrashDeps,
  opts: { path: string; planId: string; sizeBytes: number },
): { trashed: true; trashPath: string } | { trashed: false; reason: string } {
  if (opts.sizeBytes > deps.config.trash.maxBytes) {
    return { trashed: false, reason: `file exceeds trash.maxBytes (${opts.sizeBytes} > ${deps.config.trash.maxBytes})` }
  }
  const root = deps.pathMap.rootFor(opts.path)
  if (!root || !deps.pathMap.isWithinRoot(opts.path, root)) {
    return { trashed: false, reason: 'path is not inside a configured root' }
  }

  const id = randomUUID()
  const trashDir = join(root.container, TRASH_DIR_NAME, opts.planId)
  const trashPath = join(trashDir, `${id}-${basename(opts.path)}`)
  try {
    mkdirSync(trashDir, { recursive: true })
    // Same-filesystem rename only. A cross-device move would mean copying, which the
    // whole point of trashing small files is to avoid.
    renameSync(opts.path, trashPath)
  } catch (err) {
    return { trashed: false, reason: `move failed: ${(err as Error).message}` }
  }

  const deletedAt = new Date()
  const purgeAfter = new Date(deletedAt.getTime() + deps.config.trash.retentionDays * 86_400_000)
  deps.db.prepare(
    'INSERT INTO trash (id, original_path, trash_path, size_bytes, deleted_at, purge_after, plan_id) VALUES (?,?,?,?,?,?,?)',
  ).run(id, opts.path, trashPath, opts.sizeBytes, deletedAt.toISOString(), purgeAfter.toISOString(), opts.planId)

  return { trashed: true, trashPath }
}

export function restoreFromTrash(deps: TrashDeps, trashId: string): { restored: boolean; reason?: string } {
  const row = deps.db.prepare('SELECT * FROM trash WHERE id = ? AND restored_at IS NULL').get(trashId) as
    { id: string; original_path: string; trash_path: string } | undefined
  if (!row) return { restored: false, reason: 'no such trash entry' }
  if (!existsSync(row.trash_path)) return { restored: false, reason: 'trashed file is gone' }
  if (existsSync(row.original_path)) return { restored: false, reason: 'a file already exists at the original path' }
  try {
    mkdirSync(dirname(row.original_path), { recursive: true })
    renameSync(row.trash_path, row.original_path)
  } catch (err) {
    return { restored: false, reason: (err as Error).message }
  }
  deps.db.prepare('UPDATE trash SET restored_at = ? WHERE id = ?').run(new Date().toISOString(), trashId)
  return { restored: true }
}

export function purgeExpiredTrash(
  deps: TrashDeps,
  now = new Date(),
): { purged: number; failed: Array<{ id: string; path: string; reason: string }> } {
  const rows = deps.db.prepare('SELECT id, trash_path FROM trash WHERE restored_at IS NULL AND purge_after <= ?')
    .all(now.toISOString()) as Array<{ id: string; trash_path: string }>
  let purged = 0
  const failed: Array<{ id: string; path: string; reason: string }> = []
  for (const row of rows) {
    // Only drop the row when the file is genuinely gone. An unconditional catch cannot
    // tell "already gone" from EACCES or a read-only mount, and deleting the row anyway
    // destroys the only record of a file that is still sitting on disk.
    try {
      rmSync(row.trash_path)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        failed.push({ id: row.id, path: row.trash_path, reason: (err as Error).message })
        continue
      }
    }
    deps.db.prepare('DELETE FROM trash WHERE id = ?').run(row.id)
    purged += 1
  }
  return { purged, failed }
}
```

```ts
// src/plan/audit.ts
import type { Db } from '../index/db.js'

export interface AuditEntry {
  actor: string
  actionType: string
  subject: string
  before?: unknown
  after?: unknown
  outcome: string
  planId?: string
  planActionId?: string
}

export function writeAudit(db: Db, entry: AuditEntry): void {
  db.prepare(`INSERT INTO audit (ts, actor, action_type, subject, before_json, after_json, outcome, plan_id, plan_action_id)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    new Date().toISOString(),
    entry.actor,
    entry.actionType,
    entry.subject,
    entry.before === undefined ? null : JSON.stringify(entry.before),
    entry.after === undefined ? null : JSON.stringify(entry.after),
    entry.outcome,
    entry.planId ?? null,
    entry.planActionId ?? null,
  )
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run tests/plan/trash.test.ts && npm run typecheck`
Expected: 9 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/plan/trash.ts src/plan/audit.ts tests/plan/trash.test.ts
git commit -m "feat: trash for small non-torrent files, restore, purge and audit log"
```

---

### Task 5: Executor

**Files:**
- Create: `src/plan/executor.ts`
- Test: `tests/plan/executor.test.ts`

**Interfaces:**
- Consumes: everything in `src/plan/`, `JellyfinClient`, `QbitClient`, `ArrClient`.
- Produces:
  - `createExecutor(deps: ExecutorDeps): { execute(planId: string, actor: string): Promise<ExecutionSummary>; isRunning(): boolean }`
  - `ExecutionSummary = { planId; status: 'completed' | 'failed'; done: number; failed: number; skipped: number; blocked: number; bytesFreed: number }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/plan/executor.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, linkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../src/index/db.js'
import { buildPlan, approvePlan } from '../../src/plan/planner.js'
import { createExecutor } from '../../src/plan/executor.js'
import { createPathMap } from '../../src/fs/pathmap.js'
import { fileConfigSchema } from '../../src/config/schema.js'

let db: Db
let dir: string
let root: string
let media: string
let calls: string[]

const torrent = (over = {}) => ({
  hash: 'H1', name: 'Heat', savePath: '/downloads', contentPath: '/downloads/Heat.mkv',
  category: null, tags: [] as string[], state: 'stalledUP', ratio: 5, seedingTimeSeconds: 30 * 86_400,
  isPrivate: false, trackerHost: 't', sizeBytes: 10, progress: 1, ...over,
})

function deps(over: Record<string, unknown> = {}) {
  return {
    db,
    config: fileConfigSchema.parse({}),
    pathMap: createPathMap([{ role: 'library', jellyfin: '/media', container: root, qbit: '/downloads' }]),
    qbittorrent: {
      torrents: async () => [],
      deleteWithData: async (h: string[]) => { calls.push(`qbit.delete:${h.join(',')}`) },
      awaitGone: async () => { calls.push('qbit.awaitGone'); return true },
    },
    radarr: { inventory: async () => [], unmonitorByPath: async () => { calls.push('radarr.unmonitor'); return { unmonitored: true, recordId: 1 } } },
    sonarr: null,
    jellyfin: {
      deleteItem: async (id: string) => { calls.push(`jf.delete:${id}`) },
      mergeVersions: async (ids: string[]) => { calls.push(`jf.merge:${ids.join(',')}`) },
      splitVersions: async (id: string) => { calls.push(`jf.split:${id}`) },
      refreshLibrary: async () => { calls.push('jf.refresh') },
    },
    ...over,
  } as Parameters<typeof createExecutor>[0]
}

async function planFor(d: ReturnType<typeof deps>, actions: Parameters<typeof buildPlan>[1]['actions']) {
  const plan = await buildPlan(d as never, { createdBy: 'bob', actions })
  approvePlan(db, plan.id, 'bob')
  return plan
}

beforeEach(() => {
  calls = []
  dir = mkdtempSync(join(tmpdir(), 'jm-exec-'))
  db = openDb(join(dir, 'db.sqlite'))
  root = join(dir, 'lib')
  mkdirSync(root, { recursive: true })
  media = join(root, 'Heat.mkv')
  writeFileSync(media, 'x'.repeat(100))
})

describe('execute — ordering', () => {
  it('unmonitors *arr, then deletes the torrent with data, then removes the jellyfin item, then refreshes once', async () => {
    const d = deps({
      qbittorrent: {
        torrents: async () => [torrent({ contentPath: '/downloads/Heat.mkv' })],
        deleteWithData: async (h: string[]) => { calls.push(`qbit.delete:${h.join(',')}`) },
        awaitGone: async () => { calls.push('qbit.awaitGone'); return true },
      },
      radarr: {
        inventory: async () => [{ kind: 'radarr', instance: 'radarr', remoteId: 1, title: 'Heat', arrPath: media, monitored: true, seriesId: null, episodeId: null, episodeFileId: null }],
        unmonitorByPath: async () => { calls.push('radarr.unmonitor'); return { unmonitored: true, recordId: 1 } },
      },
    })
    db.prepare("INSERT INTO jellyfin_items (id, scan_id, type, name, container_path, has_primary_image) VALUES ('i1',1,'Movie','Heat',?,1)").run(media)
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    await createExecutor(d).execute(plan.id, 'bob')
    expect(calls).toEqual(['radarr.unmonitor', 'qbit.delete:H1', 'qbit.awaitGone', 'jf.delete:i1', 'jf.refresh'])
  })

  it('runs merges before deletes', async () => {
    const d = deps()
    const plan = await planFor(d, [
      { type: 'delete-media', targetPath: media },
      { type: 'merge-versions', itemIds: ['a', 'b'] },
    ])
    await createExecutor(d).execute(plan.id, 'bob')
    expect(calls.indexOf('jf.merge:a,b')).toBeLessThan(calls.findIndex((c) => c.startsWith('jf.delete') || c === 'jf.refresh'))
  })

  it('refreshes the library exactly once for a multi-delete plan', async () => {
    const other = join(root, 'Other.mkv')
    writeFileSync(other, 'y')
    const d = deps()
    const plan = await planFor(d, [
      { type: 'delete-media', targetPath: media }, { type: 'delete-media', targetPath: other },
    ])
    await createExecutor(d).execute(plan.id, 'bob')
    expect(calls.filter((c) => c === 'jf.refresh')).toHaveLength(1)
  })
})

describe('execute — fail-closed', () => {
  it('skips the delete entirely when *arr unmonitor fails, and never calls qBittorrent', async () => {
    const d = deps({
      qbittorrent: {
        torrents: async () => [torrent({ contentPath: '/downloads/Heat.mkv' })],
        deleteWithData: async () => { calls.push('qbit.delete') },
        awaitGone: async () => true,
      },
      radarr: {
        inventory: async () => [{ kind: 'radarr', instance: 'radarr', remoteId: 1, title: 'Heat', arrPath: media, monitored: true, seriesId: null, episodeId: null, episodeFileId: null }],
        unmonitorByPath: async () => { throw new Error('radarr exploded') },
      },
    })
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    const summary = await createExecutor(d).execute(plan.id, 'bob')
    expect(summary.skipped).toBe(1)
    expect(calls).not.toContain('qbit.delete')
    expect(existsSync(media)).toBe(true)
  })

  it('fails the action when qBittorrent does not confirm removal, leaving the file alone', async () => {
    const d = deps({
      qbittorrent: {
        torrents: async () => [torrent({ contentPath: '/downloads/Heat.mkv' })],
        deleteWithData: async () => {},
        awaitGone: async () => false,
      },
    })
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    const summary = await createExecutor(d).execute(plan.id, 'bob')
    expect(summary.failed).toBe(1)
    expect(existsSync(media)).toBe(true)
  })
})

describe('execute — guards at execute time', () => {
  it('blocks an action whose guard state changed after approval', async () => {
    let state = 'stalledUP'
    const d = deps({
      qbittorrent: {
        torrents: async () => [torrent({ contentPath: '/downloads/Heat.mkv', state })],
        deleteWithData: async () => { calls.push('qbit.delete') },
        awaitGone: async () => true,
      },
    })
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    state = 'downloading'   // someone hit re-download between approval and execution
    const summary = await createExecutor(d).execute(plan.id, 'bob')
    expect(summary.blocked).toBe(1)
    expect(calls).not.toContain('qbit.delete')
  })
})

describe('execute — filesystem effects', () => {
  it('deletes a non-torrent file directly and reports the bytes freed', async () => {
    const d = deps()
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    const summary = await createExecutor(d).execute(plan.id, 'bob')
    expect(existsSync(media)).toBe(false)
    expect(summary.bytesFreed).toBeGreaterThan(0)
  })

  it('removes an empty folder but never climbs above the root', async () => {
    const nested = join(root, 'Show', 'Season 01')
    mkdirSync(nested, { recursive: true })
    const d = deps()
    const plan = await planFor(d, [{ type: 'remove-empty-folder', targetPath: nested }])
    await createExecutor(d).execute(plan.id, 'bob')
    expect(existsSync(nested)).toBe(false)
    expect(existsSync(root)).toBe(true)
  })

  it('trashes a small junk file instead of deleting it', async () => {
    const junk = join(root, 'sample.mkv')
    writeFileSync(junk, 'junk')
    const d = deps()
    const plan = await planFor(d, [{ type: 'delete-junk-file', targetPath: junk }])
    await createExecutor(d).execute(plan.id, 'bob')
    expect(existsSync(junk)).toBe(false)
    expect((db.prepare('SELECT COUNT(*) c FROM trash').get() as { c: number }).c).toBe(1)
  })

  it('removes only the selected link of a hardlinked file, leaving the other intact', async () => {
    const other = join(root, 'Heat-link.mkv')
    linkSync(media, other)
    const d = deps()
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    await createExecutor(d).execute(plan.id, 'bob')
    expect(existsSync(media)).toBe(false)
    expect(existsSync(other)).toBe(true)
  })
})

describe('execute — bookkeeping', () => {
  it('writes an audit row per action', async () => {
    const d = deps()
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    await createExecutor(d).execute(plan.id, 'bob')
    const rows = db.prepare('SELECT actor, action_type, outcome FROM audit').all() as Array<{ actor: string; outcome: string }>
    expect(rows.length).toBeGreaterThanOrEqual(1)
    expect(rows[0]!.actor).toBe('bob')
  })

  it('refuses to execute a plan that was never approved', async () => {
    const d = deps()
    const plan = await buildPlan(d as never, { createdBy: 'bob', actions: [{ type: 'delete-media', targetPath: media }] })
    await expect(createExecutor(d).execute(plan.id, 'bob')).rejects.toThrow(/not approved/i)
  })

  it('refuses to run two plans at once', async () => {
    const d = deps({
      jellyfin: {
        deleteItem: async () => {},
        mergeVersions: async () => { await new Promise((r) => setTimeout(r, 30)) },
        splitVersions: async () => {},
        refreshLibrary: async () => {},
      },
    })
    const p1 = await planFor(d, [{ type: 'merge-versions', itemIds: ['a', 'b'] }])
    const p2 = await planFor(d, [{ type: 'merge-versions', itemIds: ['c', 'd'] }])
    const exec = createExecutor(d)
    const first = exec.execute(p1.id, 'bob')
    await expect(exec.execute(p2.id, 'bob')).rejects.toThrow(/already running/i)
    await first
  })

  it('is idempotent — re-executing a completed plan performs no further work', async () => {
    const d = deps()
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    const exec = createExecutor(d)
    await exec.execute(plan.id, 'bob')
    const before = calls.length
    db.prepare("UPDATE plans SET status='approved' WHERE id=?").run(plan.id)
    const second = await exec.execute(plan.id, 'bob')
    expect(second.done).toBe(0)
    expect(calls.length).toBe(before)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/plan/executor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the executor**

```ts
// src/plan/executor.ts
import { existsSync, readdirSync, rmdirSync, statSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Db } from '../index/db.js'
import type { FileConfig } from '../config/schema.js'
import type { PathMap } from '../fs/pathmap.js'
import type { ActionStatus } from '../core/types.js'
import type { JellyfinClient } from '../connectors/jellyfin.js'
import type { QbitClient } from '../connectors/qbittorrent.js'
import type { ArrClient } from '../connectors/arr.js'
import { resolveTarget, type Resolution } from './resolve.js'
import { evaluateGuards, isBlocked } from './guards.js'
import { getPlan, type PlanActionView } from './planner.js'
import { moveToTrash } from './trash.js'
import { writeAudit } from './audit.js'

export interface ExecutorDeps {
  db: Db
  config: FileConfig
  pathMap: PathMap
  qbittorrent: Pick<QbitClient, 'torrents' | 'deleteWithData' | 'awaitGone'> | null
  radarr: Pick<ArrClient, 'inventory' | 'unmonitorByPath'> | null
  sonarr: Pick<ArrClient, 'inventory' | 'unmonitorByPath'> | null
  jellyfin: Pick<JellyfinClient, 'deleteItem' | 'mergeVersions' | 'splitVersions' | 'refreshLibrary'>
}

export interface ExecutionSummary {
  planId: string
  status: 'completed' | 'failed'
  done: number
  failed: number
  skipped: number
  blocked: number
  bytesFreed: number
}

export function createExecutor(deps: ExecutorDeps) {
  let running = false

  const setStatus = (actionId: string, status: ActionStatus, error?: string, result?: unknown) => {
    deps.db.prepare(
      'UPDATE plan_actions SET status=?, finished_at=?, error=?, result_json=? WHERE id=?',
    ).run(status, new Date().toISOString(), error ?? null, result === undefined ? null : JSON.stringify(result), actionId)
  }

  async function execute(planId: string, actor: string): Promise<ExecutionSummary> {
    if (running) throw new Error('a plan is already running')
    const plan = getPlan(deps.db, planId)
    if (!plan) throw new Error(`plan ${planId} does not exist`)
    if (plan.status !== 'approved') throw new Error(`plan ${planId} is not approved (status: ${plan.status})`)

    running = true
    deps.db.prepare("UPDATE plans SET status='running', started_at=? WHERE id=?")
      .run(new Date().toISOString(), planId)

    const summary: ExecutionSummary = { planId, status: 'completed', done: 0, failed: 0, skipped: 0, blocked: 0, bytesFreed: 0 }
    let touchedJellyfin = false

    try {
      for (const action of plan.actions) {
        if (action.status !== 'pending') continue
        deps.db.prepare("UPDATE plan_actions SET status='running', started_at=? WHERE id=?")
          .run(new Date().toISOString(), action.id)
        try {
          const outcome = await runAction(action, actor, planId)
          summary.bytesFreed += outcome.bytesFreed
          touchedJellyfin ||= outcome.touchedJellyfin
          if (outcome.status === 'done') summary.done += 1
          else if (outcome.status === 'skipped') summary.skipped += 1
          else if (outcome.status === 'blocked') summary.blocked += 1
          setStatus(action.id, outcome.status, outcome.error, outcome)
          writeAudit(deps.db, {
            actor, actionType: action.type, subject: subjectOf(action),
            after: outcome, outcome: outcome.status, planId, planActionId: action.id,
          })
        } catch (err) {
          summary.failed += 1
          const message = (err as Error).message
          setStatus(action.id, 'failed', message)
          writeAudit(deps.db, {
            actor, actionType: action.type, subject: subjectOf(action),
            outcome: 'failed', after: { error: message }, planId, planActionId: action.id,
          })
        }
      }

      // One refresh for the whole plan, after everything else has settled.
      if (touchedJellyfin) await deps.jellyfin.refreshLibrary().catch(() => undefined)

      if (summary.failed > 0) summary.status = 'failed'
      deps.db.prepare('UPDATE plans SET status=?, finished_at=? WHERE id=?')
        .run(summary.status === 'failed' ? 'failed' : 'completed', new Date().toISOString(), planId)
      return summary
    } finally {
      running = false
    }
  }

  async function runAction(
    action: PlanActionView, actor: string, planId: string,
  ): Promise<{ status: ActionStatus; bytesFreed: number; touchedJellyfin: boolean; error?: string; detail?: unknown }> {
    switch (action.type) {
      case 'merge-versions': {
        const ids = action.payload.itemIds ?? []
        await deps.jellyfin.mergeVersions(ids)
        return { status: 'done', bytesFreed: 0, touchedJellyfin: false, detail: { merged: ids } }
      }
      case 'split-versions': {
        const id = action.payload.itemIds?.[0]
        if (!id) return { status: 'failed', bytesFreed: 0, touchedJellyfin: false, error: 'no item id' }
        await deps.jellyfin.splitVersions(id)
        return { status: 'done', bytesFreed: 0, touchedJellyfin: false, detail: { split: id } }
      }
      case 'remove-empty-folder':
        return removeEmptyFolder(action)
      case 'delete-junk-file':
      case 'delete-media':
        return deleteTarget(action, actor, planId)
      default:
        return { status: 'failed', bytesFreed: 0, touchedJellyfin: false, error: `unknown action type ${action.type}` }
    }
  }

  function removeEmptyFolder(action: PlanActionView) {
    const target = action.payload.targetPath
    if (!target) return { status: 'failed' as const, bytesFreed: 0, touchedJellyfin: false, error: 'no target path' }
    const root = deps.pathMap.rootFor(target)
    if (!root || !deps.pathMap.isWithinRoot(target, root) || target === root.container) {
      return { status: 'failed' as const, bytesFreed: 0, touchedJellyfin: false, error: 'target is outside a configured root' }
    }
    if (!existsSync(target)) return { status: 'done' as const, bytesFreed: 0, touchedJellyfin: false, detail: { alreadyGone: true } }
    if (readdirSync(target).length > 0) {
      return { status: 'skipped' as const, bytesFreed: 0, touchedJellyfin: false, error: 'folder is no longer empty' }
    }
    rmdirSync(target)
    const removed = sweepEmptyParents(dirname(target), root.container)
    return { status: 'done' as const, bytesFreed: 0, touchedJellyfin: false, detail: { removed: [target, ...removed] } }
  }

  async function deleteTarget(action: PlanActionView, actor: string, planId: string) {
    const target = action.payload.targetPath
    if (!target) return { status: 'failed' as const, bytesFreed: 0, touchedJellyfin: false, error: 'no target path' }

    // Guards are re-evaluated here against LIVE state. Approval is not a licence to act on stale facts.
    const resolution: Resolution = await resolveTarget(deps, target)
    if (!resolution.exists) {
      return { status: 'done' as const, bytesFreed: 0, touchedJellyfin: false, detail: { alreadyGone: true } }
    }
    const verdicts = evaluateGuards(resolution, deps.config)
    const blocked = isBlocked(verdicts, action.payload.overrides ?? [])
    if (blocked.blocked) {
      deps.db.prepare('UPDATE plan_actions SET guard_verdicts_json=? WHERE id=?')
        .run(JSON.stringify(verdicts), action.id)
      return { status: 'blocked' as const, bytesFreed: 0, touchedJellyfin: false, error: `blocked by ${blocked.by.join(', ')}` }
    }

    // 1. *arr unmonitor first — fail closed.
    for (const record of resolution.arr) {
      const client = record.kind === 'radarr' ? deps.radarr : deps.sonarr
      if (!client) continue
      try {
        await client.unmonitorByPath(record.path)
      } catch (err) {
        return {
          status: 'skipped' as const, bytesFreed: 0, touchedJellyfin: false,
          error: `${record.kind} unmonitor failed, delete skipped: ${(err as Error).message}`,
        }
      }
    }

    const sizeBytes = resolution.sizeBytes
    const lastLink = resolution.nlink <= 1

    // 2. qBittorrent removes its own data.
    if (resolution.torrents.length && deps.qbittorrent) {
      const hashes = resolution.torrents.map((t) => t.hash)
      await deps.qbittorrent.deleteWithData(hashes)
      const gone = await deps.qbittorrent.awaitGone(hashes, {})
      if (!gone) {
        return { status: 'failed' as const, bytesFreed: 0, touchedJellyfin: false, error: 'qBittorrent did not confirm removal' }
      }
    }

    // 3–4. Sweep whatever qBittorrent left, then the remaining link.
    let freed = 0
    if (existsSync(target)) {
      if (action.type === 'delete-junk-file') {
        const trashed = moveToTrash(deps, { path: target, planId, sizeBytes })
        if (!trashed.trashed) { unlinkSync(target); freed = lastLink ? sizeBytes : 0 }
      } else {
        unlinkSync(target)
        freed = lastLink ? sizeBytes : 0
      }
    } else {
      freed = lastLink ? sizeBytes : 0
    }
    const root = resolution.root
    if (root) sweepEmptyParents(dirname(target), root.container)

    // 5. Jellyfin last.
    let touchedJellyfin = false
    const item = deps.db.prepare('SELECT id FROM jellyfin_items WHERE container_path = ?').get(target) as
      { id: string } | undefined
    if (item) {
      await deps.jellyfin.deleteItem(item.id).catch(() => undefined)
      touchedJellyfin = true
    }
    void actor

    return { status: 'done' as const, bytesFreed: freed, touchedJellyfin, detail: { path: target, sizeBytes } }
  }

  /** Walks upward removing empty directories, and stops dead at the root — never above it. */
  function sweepEmptyParents(from: string, rootContainer: string): string[] {
    const removed: string[] = []
    let current = from
    while (current !== rootContainer && current.startsWith(rootContainer) && current !== dirname(current)) {
      try {
        if (!existsSync(current) || !statSync(current).isDirectory()) break
        if (readdirSync(current).length > 0) break
        rmdirSync(current)
        removed.push(current)
        current = dirname(current)
      } catch { break }
    }
    return removed
  }

  return { execute, isRunning: () => running }
}

function subjectOf(action: PlanActionView): string {
  return action.payload.targetPath ?? (action.payload.itemIds ?? []).join(',')
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run tests/plan/executor.test.ts && npm run typecheck`
Expected: 14 tests PASS. The ordering test is the one that matters most — if it fails, fix the executor, never the assertion.

- [ ] **Step 5: Commit**

```bash
git add src/plan/executor.ts tests/plan/executor.test.ts
git commit -m "feat: plan executor with fixed ordering, execute-time guards and fail-closed arr step"
```

---

### Task 6: Plans API and undo

**Files:**
- Create: `src/api/plans.ts`
- Modify: `src/server.ts`, `src/index.ts`
- Test: `tests/api/plans.test.ts`

**Interfaces:**
- Produces routes: `POST /api/plans` (build), `GET /api/plans/:id`, `POST /api/plans/:id/approve`, `POST /api/plans/:id/execute`, `POST /api/plans/:id/resume`, `GET /api/plans` (recent), `GET /api/audit`, `POST /api/trash/:id/restore`, `POST /api/duplicates/:groupId/merge`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/api/plans.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../src/index/db.js'
import { registerPlanRoutes } from '../../src/api/plans.js'
import { signSession } from '../../src/auth/session.js'
import { createPathMap } from '../../src/fs/pathmap.js'
import { fileConfigSchema } from '../../src/config/schema.js'

const SECRET = 'p'.repeat(32)
const auth = () => ({ cookie: `jellymaid_session=${signSession({ username: 'bob', userId: 'u', issuedAt: Date.now() }, SECRET)}` })

let db: Db
let dir: string
let root: string
let media: string

function build() {
  const app = Fastify()
  app.register(cookie)
  registerPlanRoutes(app, {
    db,
    sessionSecret: SECRET,
    plannerDeps: () => ({
      db,
      config: fileConfigSchema.parse({}),
      pathMap: createPathMap([{ role: 'library', jellyfin: '/media', container: root, qbit: null }]),
      qbittorrent: { torrents: async () => [] },
      radarr: null,
      sonarr: null,
    }),
    executor: {
      execute: async (planId: string) => ({ planId, status: 'completed', done: 1, failed: 0, skipped: 0, blocked: 0, bytesFreed: 100 }),
      isRunning: () => false,
    },
    trashDeps: () => ({ db, config: fileConfigSchema.parse({}), pathMap: createPathMap([{ role: 'library', jellyfin: '/media', container: root, qbit: null }]) }),
    jellyfin: { mergeVersions: async () => {} },
  } as never)
  return app
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jm-planapi-'))
  db = openDb(join(dir, 'db.sqlite'))
  root = join(dir, 'lib')
  mkdirSync(root, { recursive: true })
  media = join(root, 'Heat.mkv')
  writeFileSync(media, 'x')
})

describe('POST /api/plans', () => {
  it('requires a session', async () => {
    expect((await build().inject({ method: 'POST', url: '/api/plans', payload: { actions: [] } })).statusCode).toBe(401)
  })

  it('builds a draft plan and returns the dry run', async () => {
    const res = await build().inject({
      method: 'POST', url: '/api/plans', headers: auth(),
      payload: { actions: [{ type: 'delete-media', targetPath: media }] },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().status).toBe('draft')
    expect(res.json().dryRun.deleteCount).toBe(1)
  })

  it('rejects an unknown action type', async () => {
    const res = await build().inject({
      method: 'POST', url: '/api/plans', headers: auth(),
      payload: { actions: [{ type: 'nuke-everything', targetPath: media }] },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects a path outside every root with 400, not 500', async () => {
    const res = await build().inject({
      method: 'POST', url: '/api/plans', headers: auth(),
      payload: { actions: [{ type: 'delete-media', targetPath: '/etc/passwd' }] },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('approve and execute', () => {
  async function draft(app: ReturnType<typeof build>) {
    const res = await app.inject({
      method: 'POST', url: '/api/plans', headers: auth(),
      payload: { actions: [{ type: 'delete-media', targetPath: media }] },
    })
    return res.json().id as string
  }

  it('refuses to execute an unapproved plan', async () => {
    const app = build()
    const id = await draft(app)
    const res = await app.inject({ method: 'POST', url: `/api/plans/${id}/execute`, headers: auth() })
    expect(res.statusCode).toBe(409)
  })

  it('approves then executes', async () => {
    const app = build()
    const id = await draft(app)
    expect((await app.inject({ method: 'POST', url: `/api/plans/${id}/approve`, headers: auth() })).statusCode).toBe(200)
    const res = await app.inject({ method: 'POST', url: `/api/plans/${id}/execute`, headers: auth() })
    expect(res.statusCode).toBe(200)
    expect(res.json().done).toBe(1)
  })

  it('404s an unknown plan', async () => {
    expect((await build().inject({ method: 'GET', url: '/api/plans/nope', headers: auth() })).statusCode).toBe(404)
  })
})

describe('POST /api/plans/:id/resume', () => {
  it('resumes a plan left stuck in running by a crash', async () => {
    const app = build()
    const id = (await app.inject({
      method: 'POST', url: '/api/plans', headers: auth(),
      payload: { actions: [{ type: 'delete-media', targetPath: media }] },
    })).json().id as string
    await app.inject({ method: 'POST', url: `/api/plans/${id}/approve`, headers: auth() })
    db.prepare("UPDATE plans SET status='running' WHERE id=?").run(id)
    const res = await app.inject({ method: 'POST', url: `/api/plans/${id}/resume`, headers: auth() })
    expect(res.statusCode).toBe(200)
  })

  it('refuses to resume a plan that is not an interrupted run', async () => {
    const app = build()
    const id = (await app.inject({
      method: 'POST', url: '/api/plans', headers: auth(),
      payload: { actions: [{ type: 'delete-media', targetPath: media }] },
    })).json().id as string
    const res = await app.inject({ method: 'POST', url: `/api/plans/${id}/resume`, headers: auth() })
    expect(res.statusCode).toBe(409)
  })
})

describe('GET /api/audit', () => {
  it('returns audit rows newest first', async () => {
    db.prepare("INSERT INTO audit (ts, actor, action_type, subject, outcome) VALUES ('T1','bob','delete-media','/a','done')").run()
    db.prepare("INSERT INTO audit (ts, actor, action_type, subject, outcome) VALUES ('T2','bob','delete-media','/b','done')").run()
    const body = (await build().inject({ method: 'GET', url: '/api/audit', headers: auth() })).json()
    expect(body.entries[0].subject).toBe('/b')
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/api/plans.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the plans API**

```ts
// src/api/plans.ts
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Db } from '../index/db.js'
import { requireSession } from './auth.js'
import type { SessionPayload } from '../auth/session.js'
import { ACTION_TYPES, GUARD_IDS } from '../core/types.js'
import { buildPlan, getPlan, approvePlan, type PlannerDeps } from '../plan/planner.js'
import { restoreFromTrash, type TrashDeps } from '../plan/trash.js'
import type { createExecutor } from '../plan/executor.js'

const actionSchema = z.object({
  type: z.enum(ACTION_TYPES),
  targetPath: z.string().min(1).optional(),
  itemIds: z.array(z.string().min(1)).optional(),
  overrides: z.array(z.enum(GUARD_IDS)).optional(),
})
const planBody = z.object({ actions: z.array(actionSchema).min(1) })

const sessionOf = (req: FastifyRequest) => (req as FastifyRequest & { session: SessionPayload }).session

export interface PlanRoutesDeps {
  db: Db
  sessionSecret: string
  plannerDeps: () => PlannerDeps
  trashDeps: () => TrashDeps
  executor: ReturnType<typeof createExecutor>
  jellyfin: { mergeVersions(ids: string[]): Promise<void> }
}

export function registerPlanRoutes(app: FastifyInstance, deps: PlanRoutesDeps): void {
  const guard = { preHandler: requireSession(deps.sessionSecret) }

  app.post('/api/plans', guard, async (req, reply) => {
    const parsed = planBody.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid plan', issues: parsed.error.issues.map((i) => i.message) })
    }
    try {
      const plan = await buildPlan(deps.plannerDeps(), {
        createdBy: sessionOf(req).username,
        actions: parsed.data.actions,
      })
      return reply.code(201).send(plan)
    } catch (err) {
      // A refusal to plan (outside a root, too few merge ids) is the caller's fault, not a server fault.
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  app.get('/api/plans', guard, async (_req, reply) => {
    const rows = deps.db.prepare(
      'SELECT id, created_at, created_by, status, dry_run_json FROM plans ORDER BY created_at DESC LIMIT 50',
    ).all() as Array<{ id: string; created_at: string; created_by: string; status: string; dry_run_json: string }>
    return reply.send({
      plans: rows.map((r) => ({
        id: r.id, createdAt: r.created_at, createdBy: r.created_by, status: r.status,
        dryRun: JSON.parse(r.dry_run_json),
      })),
    })
  })

  app.get('/api/plans/:id', guard, async (req, reply) => {
    const plan = getPlan(deps.db, (req.params as { id: string }).id)
    return plan ? reply.send(plan) : reply.code(404).send({ error: 'no such plan' })
  })

  app.post('/api/plans/:id/approve', guard, async (req, reply) => {
    try {
      return reply.send(approvePlan(deps.db, (req.params as { id: string }).id, sessionOf(req).username))
    } catch (err) {
      const message = (err as Error).message
      return reply.code(message.includes('does not exist') ? 404 : 409).send({ error: message })
    }
  })

  app.post('/api/plans/:id/execute', guard, async (req, reply) => {
    try {
      return reply.send(await deps.executor.execute((req.params as { id: string }).id, sessionOf(req).username))
    } catch (err) {
      const message = (err as Error).message
      return reply.code(message.includes('does not exist') ? 404 : 409).send({ error: message })
    }
  })

  /**
   * Spec §13 crash recovery. A process killed mid-execution leaves the plan stuck in
   * `running`, which `execute` rightly refuses. Resuming is an explicit operator decision,
   * never automatic — actions already `done` are skipped, so only the unfinished tail runs.
   */
  app.post('/api/plans/:id/resume', guard, async (req, reply) => {
    const { id } = req.params as { id: string }
    if (deps.executor.isRunning()) return reply.code(409).send({ error: 'a plan is already running' })
    const plan = getPlan(deps.db, id)
    if (!plan) return reply.code(404).send({ error: 'no such plan' })
    if (plan.status !== 'running') {
      return reply.code(409).send({ error: `plan is ${plan.status}, not an interrupted run` })
    }
    deps.db.prepare("UPDATE plans SET status='approved' WHERE id=?").run(id)
    deps.db.prepare("UPDATE plan_actions SET status='pending' WHERE plan_id=? AND status='running'").run(id)
    return reply.send(await deps.executor.execute(id, sessionOf(req).username))
  })

  app.post('/api/duplicates/:groupId/merge', guard, async (req, reply) => {
    const { groupId } = req.params as { groupId: string }
    const row = deps.db.prepare('SELECT members_json FROM dupe_groups WHERE id = ?').get(groupId) as
      { members_json: string } | undefined
    if (!row) return reply.code(404).send({ error: 'no such duplicate group' })
    const ids = JSON.parse(row.members_json) as string[]
    if (ids.length < 2) return reply.code(409).send({ error: 'group has fewer than two members' })
    await deps.jellyfin.mergeVersions(ids)
    deps.db.prepare("UPDATE dupe_groups SET status='merged' WHERE id=?").run(groupId)
    return reply.send({ merged: ids })
  })

  app.get('/api/audit', guard, async (req, reply) => {
    const limit = Math.min(Number((req.query as { limit?: string }).limit ?? 200), 1000)
    const entries = deps.db.prepare(
      'SELECT ts, actor, action_type AS actionType, subject, outcome, plan_id AS planId, after_json AS afterJson FROM audit ORDER BY id DESC LIMIT ?',
    ).all(limit)
    return reply.send({ entries })
  })

  app.post('/api/trash/:id/restore', guard, async (req, reply) => {
    const result = restoreFromTrash(deps.trashDeps(), (req.params as { id: string }).id)
    return result.restored ? reply.send(result) : reply.code(409).send(result)
  })
}
```

Wire into `src/server.ts` (add `plannerDeps`, `trashDeps`, `executor` to `ServerDeps` and register), and construct them in `src/index.ts` from the live connectors.

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run && npm run typecheck && npm run build`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/plans.ts src/server.ts src/index.ts tests/api/plans.test.ts
git commit -m "feat: plans api with approval gate, execution, merge and trash restore"
```

---

## Definition of done

- `npm test`, `npm run typecheck`, `npm run build` clean.
- The ordering test passes and the emitted call sequence is exactly
  `radarr.unmonitor → qbit.delete → qbit.awaitGone → jf.delete → jf.refresh`.
- Every guard blocks what it should, `guard.protected` cannot be overridden, and a torrent that
  starts downloading between approval and execution is blocked at execute time.
- Against the real stack with a deliberately chosen throwaway file: the file is gone, qBittorrent
  no longer lists the torrent, Radarr shows the movie unmonitored **and still present**, and the
  audit log records the whole chain.
- `grep -rn "blocklist\|blacklist\|api/v3/movie/[0-9]*\"" src/` finds no delete or blocklist call.
