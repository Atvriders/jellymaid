import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, linkSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { openDb, type Db } from '../../src/index/db.js'
import { buildPlan, getPlan, approvePlan, PlanRefusal } from '../../src/plan/planner.js'
import { createPathMap, normalizeMappings, type PathMap } from '../../src/fs/pathmap.js'
import { fileConfigSchema, type FileConfig } from '../../src/config/schema.js'
import { createActivityLock } from '../../src/core/activity.js'
import { writeVerification } from '../../src/scan/verification.js'
import { configStoreOf, verifyMappings } from './support.js'

let db: Db
let dir: string
let a: string
let b: string

const torrent = (over = {}) => ({
  instanceId: 'box-a', hash: 'H1', name: 'Heat', savePath: '/downloads', contentPath: '/downloads/Heat.mkv',
  rootPath: null, category: null, tags: [] as string[], state: 'stalledUP', ratio: 5, seedingTimeSeconds: 30 * 86_400,
  isPrivate: false, trackerHost: 't', sizeBytes: 10, progress: 1, addedOn: null, ...over,
})

type QbitDouble = { torrents?: () => Promise<Array<Record<string, unknown>>>; files?: unknown }

/**
 * The library root every default test plans against. A test that hands in a qBittorrent double is
 * describing torrents box A saved straight into the library; one that does not is describing a
 * library no torrent client writes to. The difference matters: in a torrent-backed root, a file no
 * torrent owns is `guard.untracked`'s to block.
 */
const libraryMap = (torrentBacked: boolean) => createPathMap([{
  role: 'library', jellyfin: '/media', container: join(dir, 'lib'),
  qbit: torrentBacked ? '/downloads' : null, qbitInstance: torrentBacked ? 'box-a' : null,
}])

/**
 * Tests describe ONE qBittorrent, instance 'box-a', through `qbittorrent`, and the config and path
 * map through `config`/`pathMap`; this turns them into the PlannerDeps the planner takes. Every
 * build is gated on a clean verification of the mapping set, so one is written for the store here,
 * as a real Verify would; the gate tests overwrite it.
 */
function deps(over: Record<string, unknown> = {}) {
  const { qbittorrent: given, config, pathMap, ...rest } = over
  const torrentBacked = 'qbittorrent' in over
  const qb = (torrentBacked ? given : { torrents: async () => [] }) as QbitDouble | null
  // A real qBittorrent knows its own file list, and guard.torrent-scope reads it: without one every
  // matched torrent is "scope unknown" and blocks. Each double gets a single-file listing derived
  // from its own fixture, which is what these torrents are.
  if (qb && !qb.files) {
    qb.files = async (hash: string) => {
      const t = (await qb.torrents!()).find((x) => x.hash === hash)
      const content = t?.contentPath as string | undefined
      return content ? [{ index: 0, relPath: content.split('/').pop()!, sizeBytes: (t?.sizeBytes as number) ?? 0 }] : []
    }
  }
  const qbittorrents = (rest.qbittorrents as Map<string, unknown> | undefined)
    ?? (qb ? new Map([['box-a', { instanceId: 'box-a', ...qb }]]) : new Map())
  const map = (pathMap as PathMap | undefined) ?? libraryMap(torrentBacked)
  const configStore = configStoreOf(
    () => (config as FileConfig | undefined) ?? fileConfigSchema.parse({}),
    () => map,
    qbittorrents.size > 0 ? [...qbittorrents.keys()] : ['box-a'],
  )
  verifyMappings(db, configStore)
  const merged: Record<string, unknown> = {
    db,
    configStore,
    radarr: null,
    sonarr: null,
    activity: createActivityLock(),
    ...rest,
    qbittorrents,
  }
  return merged as unknown as Parameters<typeof buildPlan>[0]
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

function seedMergedItem(primary: string, alt: string) {
  writeFileSync(alt, 'z'.repeat(400))
  db.prepare('INSERT INTO jellyfin_items (id, scan_id, type, name, container_path) VALUES (?,1,?,?,?)')
    .run('item1', 'Movie', 'Heat', primary)
  // Mirrors what the jellyfin scan phase actually writes: one jellyfin_item_paths row per
  // MediaSources[] entry, INCLUDING the primary path, not just the alternates.
  db.prepare('INSERT INTO jellyfin_item_paths (item_id, scan_id, jf_path, container_path) VALUES (?,1,?,?)')
    .run('item1', '/media/Heat.mkv', primary)
  db.prepare('INSERT INTO jellyfin_item_paths (item_id, scan_id, jf_path, container_path) VALUES (?,1,?,?)')
    .run('item1', '/media/Heat-remux.mkv', alt)
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

  // Self-review case: a plan that mixes all three shapes at once, so the per-action accounting
  // cannot accidentally lean on there being only one inode in play. Hand-verified total:
  //   S  (single link, 500B)                     -> pays in full: 500
  //   L1 (2 links, 700B, only L1 requested)       -> pays 0 (L2 never goes away)
  //   M1+M2 (2 links, 900B, BOTH requested)       -> pays once: 900
  //   500 + 0 + 900 = 1400
  it('hand-verified: sums a single-link file, a partially-selected two-link file, and a fully-selected two-link file in one plan', async () => {
    const s = join(dir, 'lib', 'S.mkv')
    writeFileSync(s, 's'.repeat(500))

    const l1 = join(dir, 'lib', 'L1.mkv')
    const l2 = join(dir, 'lib', 'L2.mkv')
    writeFileSync(l1, 'l'.repeat(700))
    linkSync(l1, l2)
    indexFile(l1); indexFile(l2)

    const m1 = join(dir, 'lib', 'M1.mkv')
    const m2 = join(dir, 'lib', 'M2.mkv')
    writeFileSync(m1, 'm'.repeat(900))
    linkSync(m1, m2)
    indexFile(m1); indexFile(m2)

    const plan = await buildPlan(deps(), { createdBy: 'bob', actions: [
      { type: 'delete-media', targetPath: s },
      { type: 'delete-media', targetPath: l1 },
      { type: 'delete-media', targetPath: m1 },
      { type: 'delete-media', targetPath: m2 },
    ] })

    expect(plan.dryRun.bytesFreed).toBe(1400)
    expect(plan.dryRun.deleteCount).toBe(4)
  })

  // Self-review case: the same target path requested twice in one plan must still free its bytes
  // only once. The dedup key has to be the inode's identity, not "is this the lexicographically
  // smallest path in the group" — two rows for the exact same path are tied on that comparison and
  // both look like the "smallest", so a purely path-string-based dedup can double-pay a single
  // link. Deleting the same file twice is itself a garbage request, but the bytesFreed total this
  // task exists to keep honest must never overstate reality even for a garbage request.
  it('counts a single link only once even if the same target path is requested twice', async () => {
    const plan = await buildPlan(deps(), { createdBy: 'bob', actions: [
      { type: 'delete-media', targetPath: a }, { type: 'delete-media', targetPath: a },
    ] })
    expect(plan.dryRun.bytesFreed).toBe(1000)
    expect(plan.dryRun.deleteCount).toBe(2)
  })

  // Self-review case: a blocked action never executes, so a hardlinked sibling that IS pending
  // must not be credited for the whole inode just because its blocked twin was also "requested".
  // Each RequestedAction carries its own overrides, so two actions naming the same inode can land
  // on different guard verdicts — here M1's override clears guard.private-ratio for itself only;
  // M2 has no override and stays blocked. M2's link will not actually go away, so the honest
  // answer for this plan is zero bytes freed, not the full size.
  it('does not credit a hardlinked pair as reclaimed when one sibling is blocked and the other is pending only via its own override', async () => {
    const m1 = join(dir, 'lib', 'M1.mkv')
    const m2 = join(dir, 'lib', 'M2.mkv')
    writeFileSync(m1, 'm'.repeat(900))
    linkSync(m1, m2)
    indexFile(m1); indexFile(m2)

    const plan = await buildPlan(deps({
      config: fileConfigSchema.parse({ guards: { minRatio: 10 } }),
      qbittorrent: { torrents: async () => [torrent({ isPrivate: true, ratio: 1, contentPath: '/downloads/M1.mkv' })] },
    }), { createdBy: 'bob', actions: [
      { type: 'delete-media', targetPath: m1, overrides: ['guard.private-ratio'] },
      { type: 'delete-media', targetPath: m2 },
    ] })

    const m1Action = plan.actions.find((x) => x.payload.targetPath === m1)!
    const m2Action = plan.actions.find((x) => x.payload.targetPath === m2)!
    expect(m1Action.status).toBe('pending')
    expect(m2Action.status).toBe('blocked')
    expect(plan.dryRun.blockedCount).toBe(1)
    expect(plan.dryRun.bytesFreed).toBe(0)
  })

  it('does not let a blocked sibling vouch for a torrent\'s scope', async () => {
    // Both files of one torrent are named, so at first glance the whole torrent is in the plan. But
    // A.mkv is blocked (it did not override the private-ratio block that B.mkv did), so removing
    // the torrent for B.mkv would take A.mkv's bytes — the very file the block just protected.
    const files = async () => [
      { index: 0, relPath: 'A.mkv', sizeBytes: 1 }, { index: 1, relPath: 'B.mkv', sizeBytes: 1 },
    ]
    const plan = await buildPlan(deps({
      config: fileConfigSchema.parse({ guards: { minRatio: 10 } }),
      qbittorrent: {
        torrents: async () => [torrent({ isPrivate: true, ratio: 1, contentPath: '/downloads', savePath: '/downloads' })],
        files,
      },
    }), { createdBy: 'bob', actions: [
      { type: 'delete-media', targetPath: a },
      { type: 'delete-media', targetPath: b, overrides: ['guard.private-ratio'] },
    ] })
    const aAction = plan.actions.find((x) => x.payload.targetPath === a)!
    const bAction = plan.actions.find((x) => x.payload.targetPath === b)!
    expect(aAction.status).toBe('blocked')
    expect(bAction.status).toBe('blocked')
    expect(bAction.guardVerdicts.find((v) => v.guard === 'guard.torrent-scope')!.outcome).toBe('block')
    expect(plan.dryRun.torrentsRemoved).toBe(0)
  })

  it('leaves both files pending when the plan really does cover the whole torrent', async () => {
    const plan = await buildPlan(deps({
      qbittorrent: {
        torrents: async () => [torrent({ contentPath: '/downloads', savePath: '/downloads' })],
        files: async () => [
          { index: 0, relPath: 'A.mkv', sizeBytes: 1 }, { index: 1, relPath: 'B.mkv', sizeBytes: 1 },
        ],
      },
    }), { createdBy: 'bob', actions: [
      { type: 'delete-media', targetPath: a }, { type: 'delete-media', targetPath: b },
    ] })
    expect(plan.actions.every((x) => x.status === 'pending')).toBe(true)
    expect(plan.dryRun.torrentsRemoved).toBe(1)
  })

  it('marks a guard-blocked action blocked and counts it', async () => {
    const plan = await buildPlan(deps({
      qbittorrent: { torrents: async () => [torrent({ state: 'downloading', contentPath: '/downloads/A.mkv' })] },
    }), { createdBy: 'bob', actions: [{ type: 'delete-media', targetPath: a }] })
    expect(plan.actions[0]!.status).toBe('blocked')
    expect(plan.dryRun.blockedCount).toBe(1)
  })

  it('leaves an action pending when an overridable guard is overridden', async () => {
    const plan = await buildPlan(deps({
      config: fileConfigSchema.parse({ guards: { minRatio: 10 } }),
      qbittorrent: { torrents: async () => [torrent({ isPrivate: true, ratio: 1, contentPath: '/downloads/A.mkv' })] },
    }), { createdBy: 'bob', actions: [{ type: 'delete-media', targetPath: a, overrides: ['guard.private-ratio'] }] })
    expect(plan.actions[0]!.status).toBe('pending')
  })

  it('stale overrides are dropped into droppedOverrides instead of a 400', async () => {
    // A blank cheque, not a decision: nothing about guard.torrent-scope is blocking here, so the
    // override has nothing to clear NOW and would stand ready to clear whatever blocks at execute
    // time — a block the operator was never shown. It is dropped, said so, and never stored.
    const plan = await buildPlan(deps(), { createdBy: 'bob', actions: [
      { type: 'delete-media', targetPath: a, overrides: ['guard.torrent-scope'] },
    ] })
    expect(plan.actions[0]!.status).toBe('pending')
    expect(plan.droppedOverrides).toEqual([{ seq: 0, guard: 'guard.torrent-scope' }])
    const row = db.prepare('SELECT override_by, override_reason, payload_json FROM plan_actions').get() as
      { override_by: string | null; override_reason: string | null; payload_json: string }
    expect(JSON.parse(row.payload_json).overrides).toEqual([])
    expect(row.override_by).toBeNull()
    expect(row.override_reason).toBeNull()
    // And it survives a fresh read, for the screen that polls it.
    expect(getPlan(db, plan.id)!.droppedOverrides).toEqual([{ seq: 0, guard: 'guard.torrent-scope' }])
  })

  it('drops every override on an action that has no guards at all', async () => {
    const plan = await buildPlan(deps(), { createdBy: 'bob', actions: [
      { type: 'merge-versions', itemIds: ['a', 'b'], overrides: ['guard.private-ratio'] },
    ] })
    expect(plan.droppedOverrides).toEqual([{ seq: 0, guard: 'guard.private-ratio' }])
  })

  it('keeps the override that still answers a block and drops the one that no longer does', async () => {
    const plan = await buildPlan(deps({
      config: fileConfigSchema.parse({ guards: { minRatio: 10 } }),
      qbittorrent: { torrents: async () => [torrent({ isPrivate: true, ratio: 1, contentPath: '/downloads/A.mkv' })] },
    }), { createdBy: 'bob', actions: [
      { type: 'delete-media', targetPath: a, overrides: ['guard.private-ratio', 'guard.cross-seed'] },
    ] })
    expect(plan.actions[0]!.status).toBe('pending')
    expect(plan.actions[0]!.payload.overrides).toEqual(['guard.private-ratio'])
    expect(plan.droppedOverrides).toEqual([{ seq: 0, guard: 'guard.cross-seed' }])
  })

  it('accepts an override for a guard that really is blocking this action', async () => {
    const plan = await buildPlan(deps({
      config: fileConfigSchema.parse({ guards: { minRatio: 10 } }),
      qbittorrent: { torrents: async () => [torrent({ isPrivate: true, ratio: 1, contentPath: '/downloads/A.mkv' })] },
    }), { createdBy: 'bob', actions: [{ type: 'delete-media', targetPath: a, overrides: ['guard.private-ratio'] }] })
    expect(plan.actions[0]!.status).toBe('pending')
  })

  it('records the override in the persisted action', async () => {
    await buildPlan(deps({
      config: fileConfigSchema.parse({ guards: { minRatio: 10 } }),
      qbittorrent: { torrents: async () => [torrent({ isPrivate: true, ratio: 1, contentPath: '/downloads/A.mkv' })] },
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

  /**
   * The executor sweeps the target's now-empty parent chain, stopping at the mapped root. Nothing
   * in the dry run used to mention it, so an operator approving one episode was silently approving
   * `Show/Season 01/` and `Show/` as well.
   */
  describe('directory sweep preview', () => {
    function episodeIn(...segments: string[]) {
      const nested = join(dir, 'lib', ...segments)
      mkdirSync(nested, { recursive: true })
      return nested
    }

    it('counts the empty parent chain one delete would take, and never the root itself', async () => {
      const nested = episodeIn('Show', 'Season 01')
      const episode = join(nested, 'S01E01.mkv')
      writeFileSync(episode, 'e')
      const plan = await buildPlan(deps(), { createdBy: 'bob', actions: [{ type: 'delete-media', targetPath: episode }] })
      // Season 01 and Show. `lib` is the mapped root and is where the sweep stops dead.
      expect(plan.dryRun.directoriesSwept).toBe(2)
    })

    it('counts nothing when a file the plan does not name keeps the directory alive', async () => {
      const nested = episodeIn('Show', 'Season 01')
      writeFileSync(join(nested, 'S01E01.mkv'), 'e')
      writeFileSync(join(nested, 'S01E02.mkv'), 'e')
      const plan = await buildPlan(deps(), { createdBy: 'bob', actions: [
        { type: 'delete-media', targetPath: join(nested, 'S01E01.mkv') },
      ] })
      expect(plan.dryRun.directoriesSwept).toBe(0)
    })

    it('counts a shared directory once when two actions empty it between them', async () => {
      const nested = episodeIn('Show', 'Season 01')
      writeFileSync(join(nested, 'S01E01.mkv'), 'e')
      writeFileSync(join(nested, 'S01E02.mkv'), 'e')
      const plan = await buildPlan(deps(), { createdBy: 'bob', actions: [
        { type: 'delete-media', targetPath: join(nested, 'S01E01.mkv') },
        { type: 'delete-media', targetPath: join(nested, 'S01E02.mkv') },
      ] })
      expect(plan.dryRun.directoriesSwept).toBe(2)
    })

    it('does not count a chain only a BLOCKED action would have emptied', async () => {
      const nested = episodeIn('Show', 'Season 01')
      const episode = join(nested, 'S01E01.mkv')
      writeFileSync(episode, 'e')
      const plan = await buildPlan(deps({
        qbittorrent: {
          torrents: async () => [torrent({ state: 'downloading', contentPath: '/downloads/Show/Season 01/S01E01.mkv' })],
        },
      }), { createdBy: 'bob', actions: [{ type: 'delete-media', targetPath: episode }] })
      expect(plan.actions[0]!.status).toBe('blocked')
      expect(plan.dryRun.directoriesSwept).toBe(0)
    })

    it('counts the parents a remove-empty-folder would take above the folder it names', async () => {
      const nested = episodeIn('Show', 'Season 01')
      const plan = await buildPlan(deps(), { createdBy: 'bob', actions: [
        { type: 'remove-empty-folder', targetPath: nested },
      ] })
      // Only `Show`: `Season 01` is the folder the operator explicitly named, not a surprise.
      expect(plan.dryRun.directoriesSwept).toBe(1)
    })
  })

  // --- Alternate-version carry-through: a delete targeting a merged item's alternate version is
  // legal, but the executor (Task 5) must refresh the surviving item afterwards instead of
  // deleting `itemId` outright. That fact has to survive the round trip through persistence
  // without re-resolving, and be visible on the plan view without drilling into the raw payload.
  describe('alternate version resolution', () => {
    it('carries isAlternateVersion through to the persisted payload and the plan view', async () => {
      const alt = join(dir, 'lib', 'Heat-remux.mkv')
      seedMergedItem(a, alt)
      const plan = await buildPlan(deps(), { createdBy: 'bob', actions: [{ type: 'delete-media', targetPath: alt }] })

      expect(plan.actions[0]!.isAlternateVersion).toBe(true)
      expect(plan.actions[0]!.payload.resolution?.jellyfin.isAlternateVersion).toBe(true)
      // The surviving item's id is the one Task 5 must refresh — already present in the carried
      // resolution, with no need to re-resolve.
      expect(plan.actions[0]!.payload.resolution?.jellyfin.itemId).toBe('item1')

      const row = db.prepare('SELECT payload_json FROM plan_actions WHERE plan_id = ?').get(plan.id) as { payload_json: string }
      expect(JSON.parse(row.payload_json).resolution.jellyfin.isAlternateVersion).toBe(true)

      // Round-trips through a fresh read without re-resolving anything.
      expect(getPlan(db, plan.id)!.actions[0]!.isAlternateVersion).toBe(true)
    })

    it('reports isAlternateVersion false for a primary path, and null for an action with no resolution', async () => {
      const alt = join(dir, 'lib', 'Heat-remux.mkv')
      seedMergedItem(a, alt)
      const plan = await buildPlan(deps(), { createdBy: 'bob', actions: [
        { type: 'delete-media', targetPath: a },
        { type: 'merge-versions', itemIds: ['x', 'y'] },
      ] })
      const del = plan.actions.find((x) => x.type === 'delete-media')!
      const merge = plan.actions.find((x) => x.type === 'merge-versions')!
      expect(del.isAlternateVersion).toBe(false)
      expect(merge.isAlternateVersion).toBeNull()
    })
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
      qbittorrent: { torrents: async () => [torrent({ state: 'downloading', contentPath: '/downloads/A.mkv' })] },
    }), { createdBy: 'bob', actions: [{ type: 'delete-media', targetPath: a }] })
    expect(() => approvePlan(db, plan.id, 'bob')).toThrow(/no executable actions/i)
  })
})

describe('buildPlan — live configuration and instances', () => {
  it('reads thresholds and the path map from the config store once per build, so a change shows on the next build', async () => {
    let config = fileConfigSchema.parse({ guards: { minRatio: 10 } })
    const pathMap = libraryMap(true)
    let reads = 0
    const configStore = configStoreOf(() => { reads += 1; return config }, () => pathMap)
    verifyMappings(db, configStore)
    const d = deps({ qbittorrent: { torrents: async () => [torrent({ isPrivate: true, ratio: 1, contentPath: '/downloads/A.mkv' })] } })
    const live = { ...(d as unknown as Record<string, unknown>), configStore } as unknown as Parameters<typeof buildPlan>[0]

    const before = await buildPlan(live, { createdBy: 'bob', actions: [{ type: 'delete-media', targetPath: a }] })
    expect(before.actions[0]!.status).toBe('blocked')
    expect(reads).toBe(1)

    config = fileConfigSchema.parse({ guards: { minRatio: 0.5 } })
    const after = await buildPlan(live, { createdBy: 'bob', actions: [{ type: 'delete-media', targetPath: a }] })
    expect(after.actions[0]!.status).toBe('pending')
  })

  it('private-ratio keeps AND semantics with thresholds read from configStore at build time', async () => {
    // Ratio 2 is plenty; 5 days of seeding is not. Only BOTH minimums met may delete a private torrent.
    let config = fileConfigSchema.parse({ guards: { minRatio: 1, minSeedTimeDays: 14 } })
    const d = deps({
      qbittorrent: { torrents: async () => [torrent({ isPrivate: true, ratio: 2, seedingTimeSeconds: 5 * 86_400, contentPath: '/downloads/A.mkv' })] },
    })
    const store = configStoreOf(() => config, () => libraryMap(true))
    const live = { ...(d as unknown as Record<string, unknown>), configStore: store } as unknown as Parameters<typeof buildPlan>[0]
    const statusNow = async () => (await buildPlan(live, { createdBy: 'bob', actions: [{ type: 'delete-media', targetPath: a }] })).actions[0]!.status

    expect(await statusNow()).toBe('blocked')
    config = fileConfigSchema.parse({ guards: { minRatio: 1, minSeedTimeDays: 3 } })
    expect(await statusNow()).toBe('pending')
    config = fileConfigSchema.parse({ guards: { minRatio: 3, minSeedTimeDays: 3 } })
    expect(await statusNow()).toBe('blocked')
  })

  it('torrent list cache serves one snapshot per plan build', async () => {
    let lists = 0
    const list = [torrent({ hash: 'ha', contentPath: '/downloads/A.mkv' }), torrent({ hash: 'hb', contentPath: '/downloads/B.mkv' })]
    const d = deps({
      qbittorrent: {
        torrents: async () => { lists += 1; return list },
        files: async (hash: string) => [{ index: 0, relPath: hash === 'ha' ? 'A.mkv' : 'B.mkv', sizeBytes: 1 }],
      },
    })
    const request = { createdBy: 'bob', actions: [
      { type: 'delete-media' as const, targetPath: a }, { type: 'delete-media' as const, targetPath: b },
    ] }
    const plan = await buildPlan(d, request)
    expect(plan.actions.map((x) => x.payload.resolution!.torrents.map((t) => t.hash))).toEqual([['ha'], ['hb']])
    expect(lists).toBe(1)
    // The next build takes its own snapshot: it is never judged from a list an earlier build read.
    await buildPlan(d, request)
    expect(lists).toBe(2)
  })

  it('counts a torrent per instance, so the same infohash on two boxes is two torrents removed', async () => {
    mkdirSync(join(dir, 'b'), { recursive: true })
    const onB = join(dir, 'b', 'A.mkv')
    writeFileSync(onB, 'b'.repeat(10))
    const pathMap = createPathMap([
      { role: 'library', jellyfin: '/media', container: join(dir, 'lib'), qbit: '/downloads', qbitInstance: 'box-a' },
      { role: 'library', jellyfin: '/media-b', container: join(dir, 'b'), qbit: '/downloads', qbitInstance: 'box-b' },
    ])
    const box = (id: string) => ({
      instanceId: id,
      torrents: async () => [torrent({ instanceId: id, hash: 'same', contentPath: '/downloads/A.mkv' })],
      files: async () => [{ index: 0, relPath: 'A.mkv', sizeBytes: 10 }],
    })
    const plan = await buildPlan(deps({
      pathMap,
      qbittorrents: new Map([['box-a', box('box-a')], ['box-b', box('box-b')]]),
    }), { createdBy: 'bob', actions: [{ type: 'delete-media', targetPath: a }, { type: 'delete-media', targetPath: onB }] })
    expect(plan.actions.map((x) => x.status)).toEqual(['pending', 'pending'])
    expect(plan.actions.map((x) => x.payload.resolution!.torrents.map((t) => t.instanceId))).toEqual([['box-a'], ['box-b']])
    expect(plan.dryRun.torrentsRemoved).toBe(2)
  })
})

describe('buildPlan — refusals before anything is resolved', () => {
  const request = () => ({ createdBy: 'bob', actions: [{ type: 'delete-media' as const, targetPath: a }] })

  async function refusal(promise: Promise<unknown>): Promise<PlanRefusal> {
    const err = await promise.then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(PlanRefusal)
    return err as PlanRefusal
  }

  it('refuses with "verification" when the mapping set was never verified, has changed, or failed verification', async () => {
    const d = deps()
    db.prepare('DELETE FROM kv').run()
    expect((await refusal(buildPlan(d, request()))).code).toBe('verification')

    // A record for some other mapping set.
    writeVerification(db, { at: 'T', mappingsHash: 'not-this-set', jellyfin: { sampled: 1, resolved: 1, failures: [] }, qbit: [] })
    expect((await refusal(buildPlan(d, request()))).message).toMatch(/changed since/i)

    // The right set, but box A's half did not resolve.
    writeVerification(db, {
      at: 'T', mappingsHash: d.configStore.mappingsHash(), jellyfin: { sampled: 1, resolved: 1, failures: [] },
      qbit: [{ instanceId: 'box-a', sampled: 2, resolved: 1, failures: [{ qbitPath: '/downloads/X', reason: 'missing' }] }],
    })
    const failing = await refusal(buildPlan(d, request()))
    expect(failing.code).toBe('verification')
    expect(failing.message).toMatch(/box-a/)
    // Nothing was written: a refused build leaves no plan behind.
    expect((db.prepare('SELECT COUNT(*) c FROM plans').get() as { c: number }).c).toBe(0)
  })

  it('refuses with "busy" while a scan or a plan run holds the activity lock, and builds once it is free', async () => {
    const activity = createActivityLock()
    const d = deps({ activity })
    activity.tryAcquire('scan', 'scan-7')
    const busy = await refusal(buildPlan(d, request()))
    expect(busy.code).toBe('busy')
    expect(busy.message).toMatch(/scan/)
    activity.release('scan', 'scan-7')

    activity.tryAcquire('plan', 'plan-1')
    expect((await refusal(buildPlan(d, request()))).message).toMatch(/plan/)
    activity.release('plan', 'plan-1')

    expect((await buildPlan(d, request())).status).toBe('draft')
  })
})

describe('buildPlan — the dry run', () => {
  /** A movie as the owner's torrents deliver it: the film, an .nfo and a sample beside it. */
  function movieRelease(name: string, sizes: { film: number; nfo: number; sample: number }) {
    const folder = join(dir, 'lib', name)
    mkdirSync(join(folder, 'Sample'), { recursive: true })
    writeFileSync(join(folder, `${name}.mkv`), 'f'.repeat(sizes.film))
    writeFileSync(join(folder, `${name}.nfo`), 'n'.repeat(sizes.nfo))
    writeFileSync(join(folder, 'Sample', 'sample.mkv'), 's'.repeat(sizes.sample))
    return {
      film: join(folder, `${name}.mkv`),
      files: [
        { index: 0, relPath: `${name}/${name}.mkv`, sizeBytes: sizes.film },
        { index: 1, relPath: `${name}/${name}.nfo`, sizeBytes: sizes.nfo },
        { index: 2, relPath: `${name}/Sample/sample.mkv`, sizeBytes: sizes.sample },
      ],
    }
  }

  it('dry run reports companionFiles and byInstance', async () => {
    mkdirSync(join(dir, 'b'), { recursive: true })
    const heat = movieRelease('Heat', { film: 1000, nfo: 10, sample: 50 })
    const roninOnB = join(dir, 'b', 'Ronin.mkv')
    writeFileSync(roninOnB, 'r'.repeat(700))
    const pathMap = createPathMap([
      { role: 'library', jellyfin: '/media', container: join(dir, 'lib'), qbit: '/movies', qbitInstance: 'box-a' },
      { role: 'library', jellyfin: '/media-b', container: join(dir, 'b'), qbit: '/movies', qbitInstance: 'box-b' },
    ])
    const plan = await buildPlan(deps({
      pathMap,
      qbittorrents: new Map([
        ['box-a', {
          instanceId: 'box-a',
          torrents: async () => [torrent({ instanceId: 'box-a', hash: 'ha', name: 'Heat', savePath: '/movies', contentPath: '/movies/Heat', sizeBytes: 1060 })],
          files: async () => heat.files,
        }],
        ['box-b', {
          instanceId: 'box-b',
          torrents: async () => [torrent({ instanceId: 'box-b', hash: 'hb', name: 'Ronin', savePath: '/movies', contentPath: '/movies/Ronin.mkv', sizeBytes: 700 })],
          files: async () => [{ index: 0, relPath: 'Ronin.mkv', sizeBytes: 700 }],
        }],
      ]),
    }), { createdBy: 'bob', actions: [
      { type: 'delete-media', targetPath: heat.film }, { type: 'delete-media', targetPath: roninOnB },
    ] })

    expect(plan.actions.map((x) => x.status)).toEqual(['pending', 'pending'])
    expect(plan.actions[0]!.payload.resolution!.torrents[0]!.companionCount).toBe(2)
    expect(plan.dryRun.companionFiles).toBe(2)
    expect(plan.dryRun.byInstance).toEqual({ 'box-a': { torrents: 1, bytes: 1060 }, 'box-b': { torrents: 1, bytes: 700 } })
    expect(plan.dryRun.torrentsRemoved).toBe(2)
    expect(plan.dryRun.bytesFreed).toBe(1760)
  })

  it('bytes freed credit each removed torrent once', async () => {
    // Two episodes of one pack, both queued: one torrent goes, with its .nfo, and is counted once —
    // not once per action, and not as just the two files the plan happened to name.
    const pack = join(dir, 'lib', 'Pack')
    mkdirSync(pack, { recursive: true })
    const e01 = join(pack, 'E01.mkv')
    const e02 = join(pack, 'E02.mkv')
    writeFileSync(e01, '1'.repeat(400)); writeFileSync(e02, '2'.repeat(500)); writeFileSync(join(pack, 'Pack.nfo'), 'n'.repeat(30))
    const plan = await buildPlan(deps({
      qbittorrent: {
        torrents: async () => [torrent({ hash: 'hp', name: 'Pack', contentPath: '/downloads/Pack', sizeBytes: 930 })],
        files: async () => [
          { index: 0, relPath: 'Pack/E01.mkv', sizeBytes: 400 },
          { index: 1, relPath: 'Pack/E02.mkv', sizeBytes: 500 },
          { index: 2, relPath: 'Pack/Pack.nfo', sizeBytes: 30 },
        ],
      },
    }), { createdBy: 'bob', actions: [{ type: 'delete-media', targetPath: e01 }, { type: 'delete-media', targetPath: e02 }] })
    expect(plan.actions.map((x) => x.status)).toEqual(['pending', 'pending'])
    expect(plan.dryRun.torrentsRemoved).toBe(1)
    expect(plan.dryRun.bytesFreed).toBe(930)
    expect(plan.dryRun.byInstance).toEqual({ 'box-a': { torrents: 1, bytes: 930 } })
    expect(plan.dryRun.companionFiles).toBe(1)
  })

  it('credits bytes two cross-seeded torrents share only once', async () => {
    // Two torrents over the very same file: removing both frees the file once, not twice.
    const plan = await buildPlan(deps({
      qbittorrent: {
        torrents: async () => [
          torrent({ hash: 'h1', contentPath: '/downloads/A.mkv', sizeBytes: 1000 }),
          torrent({ hash: 'h2', contentPath: '/downloads/A.mkv', sizeBytes: 1000 }),
        ],
      },
    }), { createdBy: 'bob', actions: [{ type: 'delete-media', targetPath: a, overrides: ['guard.cross-seed'] }] })
    expect(plan.actions[0]!.status).toBe('pending')
    expect(plan.dryRun.torrentsRemoved).toBe(2)
    expect(plan.dryRun.bytesFreed).toBe(1000)
  })

  it('reports progress as the actions that reached an end state, out of all of them', async () => {
    const plan = await buildPlan(deps({
      qbittorrent: { torrents: async () => [torrent({ state: 'downloading', contentPath: '/downloads/A.mkv' })] },
    }), { createdBy: 'bob', actions: [
      { type: 'delete-media', targetPath: a }, { type: 'merge-versions', itemIds: ['x', 'y'] },
    ] })
    // The blocked delete will never run, so it is already finished; the merge is still to come.
    expect(plan.progress).toEqual({ total: 2, finished: 1 })
    expect(plan.error).toBeNull()
  })

  it('reads a plan written before companionFiles and byInstance existed', () => {
    db.prepare("INSERT INTO plans (id, created_at, created_by, status, dry_run_json) VALUES ('old','T','bob','completed',?)")
      .run(JSON.stringify({ deleteCount: 1, bytesFreed: 5, torrentsRemoved: 1, blockedCount: 0 }))
    const plan = getPlan(db, 'old')!
    expect(plan.dryRun).toMatchObject({ deleteCount: 1, bytesFreed: 5, companionFiles: 0, byInstance: {} })
    expect(plan.droppedOverrides).toEqual([])
    expect(plan.progress).toEqual({ total: 0, finished: 0 })
  })
})

describe('buildPlan — a mapping hole fails closed', () => {
  /** A delete the operator has overridden every overridable guard for: only guard.protected is left. */
  const everyOverride = ['guard.private-ratio', 'guard.cross-seed', 'guard.torrent-scope', 'guard.untracked'] as const

  async function planThrough(mappings: Parameters<typeof normalizeMappings>[0], instanceIds: string[]) {
    const asked: string[] = []
    const { mappings: normalized } = normalizeMappings(mappings, instanceIds)
    const plan = await buildPlan(deps({
      pathMap: createPathMap(normalized),
      qbittorrents: new Map(instanceIds.map((id) => [id, {
        instanceId: id,
        torrents: async () => { asked.push(id); return [] },
        files: async () => [],
      }])),
    }), { createdBy: 'bob', actions: [{ type: 'delete-media', targetPath: a, overrides: [...everyOverride] }] })
    return { plan, asked, protectedVerdict: plan.actions[0]!.guardVerdicts.find((v) => v.guard === 'guard.protected')! }
  }

  it('a legacy qbit mapping with two instances: no instance can be determined, so guard.protected blocks', async () => {
    const { plan, asked, protectedVerdict } = await planThrough(
      [{ role: 'library', jellyfin: '/media', container: join(dir, 'lib'), qbit: '/downloads', qbitInstance: null }],
      ['box-a', 'box-b'],
    )
    expect(plan.actions[0]!.payload.resolution!.torrentSource).toMatchObject({ kind: 'unknown' })
    expect(plan.actions[0]!.status).toBe('blocked')
    expect(protectedVerdict).toMatchObject({ outcome: 'block', overridable: false })
    expect(protectedVerdict.reason).toMatch(/no instance/)
    expect(asked).toEqual([])
    expect(() => approvePlan(db, plan.id, 'bob')).toThrow(/no executable actions/i)
  })

  it('a qbitInstance naming an unconfigured instance: that instance is unavailable, so guard.protected blocks', async () => {
    const { plan, protectedVerdict } = await planThrough(
      [{ role: 'library', jellyfin: '/media', container: join(dir, 'lib'), qbit: '/downloads', qbitInstance: 'box-z' }],
      ['box-a'],
    )
    expect(plan.actions[0]!.payload.resolution!.sourcesUnavailable).toEqual(['qbittorrent:box-z'])
    expect(plan.actions[0]!.status).toBe('blocked')
    expect(protectedVerdict).toMatchObject({ outcome: 'block', overridable: false })
    expect(protectedVerdict.reason).toMatch(/box-z/)
  })
})
