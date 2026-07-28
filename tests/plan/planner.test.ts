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
  const merged: Record<string, unknown> = {
    db,
    config: fileConfigSchema.parse({}),
    pathMap: createPathMap([{ role: 'library', jellyfin: '/media', container: join(dir, 'lib'), qbit: '/downloads' }]),
    qbittorrent: { torrents: async () => [] },
    radarr: null,
    sonarr: null,
    ...over,
  }
  // A real qBittorrent knows its own file list, and guard.torrent-scope reads it: without one every
  // matched torrent is "scope unknown" and blocks. Each double gets a single-file listing derived
  // from its own fixture, which is what these torrents are.
  const qb = merged.qbittorrent as { torrents?: () => Promise<Array<Record<string, unknown>>>; files?: unknown } | null
  if (qb && !qb.files) {
    qb.files = async (hash: string) => {
      const t = (await qb.torrents!()).find((x) => x.hash === hash)
      const content = t?.contentPath as string | undefined
      return content ? [{ index: 0, relPath: content.split('/').pop()!, sizeBytes: (t?.sizeBytes as number) ?? 0 }] : []
    }
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
