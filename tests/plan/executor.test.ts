import { describe, it, expect, beforeEach } from 'vitest'
import {
  mkdtempSync, mkdirSync, writeFileSync, existsSync, linkSync, symlinkSync, unlinkSync, statSync,
  readdirSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { openDb, type Db } from '../../src/index/db.js'
import { buildPlan, approvePlan } from '../../src/plan/planner.js'
import { createExecutor, type ExecutorOptions } from '../../src/plan/executor.js'
import { createPathMap, type PathMap } from '../../src/fs/pathmap.js'
import { fileConfigSchema, type FileConfig } from '../../src/config/schema.js'
import { createActivityLock } from '../../src/core/activity.js'
import { configStoreOf, verifyMappings } from './support.js'

let db: Db
let dir: string
let root: string
let media: string
let calls: string[]

/**
 * The *arr namespace is deliberately NOT the container namespace: `arrPath` is what Radarr/Sonarr
 * themselves report ('/media/Heat.mkv'), and the path map translates it to the container path the
 * executor deletes. Every test keeps them distinct so that passing the wrong one to
 * `unmonitorByPath` — which matches on the *arr-native string — cannot pass unnoticed.
 */
const ARR_PATH = '/media/Heat.mkv'

const torrent = (over: Record<string, unknown> = {}) => ({
  instanceId: 'box-a', hash: 'H1', name: 'Heat', savePath: '/downloads', contentPath: '/downloads/Heat.mkv',
  rootPath: null, category: null, tags: [] as string[], state: 'stalledUP', ratio: 5, seedingTimeSeconds: 30 * 86_400,
  isPrivate: false, privacySource: 'flag', trackerHost: 't', sizeBytes: 100, progress: 1, addedOn: null, ...over,
})

const arrRecord = (over: Record<string, unknown> = {}) => ({
  kind: 'radarr', instance: 'radarr', remoteId: 1, title: 'Heat', arrPath: ARR_PATH,
  monitored: true, seriesId: null, episodeId: null, episodeFileId: null, ...over,
})

interface QbitOverrides {
  torrents?: () => Promise<Array<Record<string, unknown>>>
  files?: (hash: string) => Promise<Array<{ index: number; relPath: string; sizeBytes: number }>>
  deleteWithData?: (hashes: string[]) => Promise<void>
  awaitGone?: (hashes: string[]) => Promise<boolean>
}

type QbitDouble = Parameters<typeof createExecutor>[0]['qbittorrents'] extends ReadonlyMap<string, infer C> ? C : never

/**
 * A qBittorrent that behaves like the real one where the executor can tell: a deleted torrent leaves
 * its list, and its files leave the disk (each at savePath/relPath, through this suite's
 * '/downloads' → root mapping). Every call is recorded through the factory, not through an
 * override, so a test that supplies its own torrent list still logs the read — otherwise the
 * ordering assertion's filter would be silently vacuous for exactly the tests that matter most.
 */
const qbit = (over: QbitOverrides = {}, instanceId = 'box-a'): QbitDouble => {
  const list = over.torrents ?? (async () => [])
  const removed = new Set<string>()
  // A real qBittorrent always knows its own file list. The default derives a single-file torrent
  // from the fixture's own contentPath; multi-file tests override it.
  const files = over.files ?? (async (hash: string) => {
    const t = (await list()).find((x) => x.hash === hash)
    const content = t?.contentPath as string | undefined
    return content ? [{ index: 0, relPath: content.split('/').pop()!, sizeBytes: (t?.sizeBytes as number) ?? 0 }] : []
  })
  return {
    instanceId,
    torrents: async () => { calls.push('qbit.torrents'); return (await list()).filter((t) => !removed.has(String(t.hash))) },
    files,
    deleteWithData: over.deleteWithData ?? (async (hashes: string[]) => {
      calls.push(`qbit.delete:${hashes.join(',')}`)
      for (const hash of hashes) {
        const t = (await list()).find((x) => x.hash === hash)
        const saveDir = String(t?.savePath ?? '/downloads').replace(/^\/downloads/, root)
        for (const f of await files(hash)) if (existsSync(join(saveDir, f.relPath))) unlinkSync(join(saveDir, f.relPath))
        removed.add(hash)
      }
    }),
    awaitGone: over.awaitGone ?? (async () => { calls.push('qbit.awaitGone'); return true }),
  } as unknown as QbitDouble
}

const arrClient = (label: 'radarr' | 'sonarr', over: Record<string, unknown> = {}) => ({
  inventory: async () => ({ records: [arrRecord({ kind: label, instance: label })], complete: true }),
  unmonitorByPath: async (p: string) => {
    calls.push(`${label}.unmonitor:${p}`)
    return { outcome: 'unmonitored', recordId: 1 }
  },
  ...over,
})

/**
 * Jellyfin as the executor may use it: notify, merge, split. The calls it must never make are on
 * the double too, recorded, so a test can prove they are not made.
 */
const jellyfinDouble = (over: Record<string, unknown> = {}) => ({
  mergeVersions: async (ids: string[]) => { calls.push(`jf.merge:${ids.join(',')}`) },
  splitVersions: async (id: string) => { calls.push(`jf.split:${id}`) },
  notifyPathsDeleted: async (paths: string[]) => { calls.push(`jf.notify:${paths.join(',')}`) },
  deleteItem: async (id: string) => { calls.push(`jf.deleteItem:${id}`) },
  getItem: async (id: string) => { calls.push(`jf.getItem:${id}`); return null },
  refreshLibrary: async () => { calls.push('jf.refreshLibrary') },
  ...over,
})

/**
 * The library root every default test acts on. A test that hands in a qBittorrent double is
 * describing torrents box A saved straight into the library; one that does not is describing a
 * library no torrent client writes to, where a file no torrent owns needs no override.
 */
const libraryMap = (torrentBacked: boolean) => createPathMap([{
  role: 'library', jellyfin: '/media', container: root,
  qbit: torrentBacked ? '/downloads' : null, qbitInstance: torrentBacked ? 'box-a' : null,
}])

/**
 * Tests describe ONE qBittorrent, instance 'box-a', through `qbittorrent`, and the config and path
 * map through `config`/`pathMap`; this turns them into deps that serve as both ExecutorDeps and
 * PlannerDeps (`planFor` builds the plan from the same object). Building is gated on a clean
 * verification of the mapping set, so one is written, as a real Verify would.
 */
function deps(over: Record<string, unknown> = {}) {
  const { qbittorrent: given, config, pathMap, ...rest } = over
  const torrentBacked = 'qbittorrent' in over
  const qb = (torrentBacked ? given : qbit()) as QbitDouble | null
  const fileConfig = (config as FileConfig | undefined) ?? fileConfigSchema.parse({})
  const map = (pathMap as PathMap | undefined) ?? libraryMap(torrentBacked)
  const qbittorrents = (rest.qbittorrents as Map<string, unknown> | undefined)
    ?? (qb ? new Map([['box-a', qb]]) : new Map())
  const configStore = configStoreOf(() => fileConfig, () => map, qbittorrents.size > 0 ? [...qbittorrents.keys()] : ['box-a'])
  verifyMappings(db, configStore)
  return {
    db,
    configStore,
    radarr: null,
    sonarr: null,
    activity: createActivityLock(),
    jellyfin: jellyfinDouble(),
    ...rest,
    qbittorrents,
  } as unknown as Parameters<typeof createExecutor>[0]
}

/**
 * The executor with step 3's wait kept short. Every fake here removes what it deletes, so nothing
 * should wait; if something does, it costs a test a fraction of a second rather than 30.
 */
const executorFor = (d: ReturnType<typeof deps>, options: ExecutorOptions = {}) =>
  createExecutor(d, { goneTimeoutMs: 200, gonePollMs: 5, ...options })

/** Reads, not effects: filtered out of the ordering assertion. */
const effects = () => calls.filter((c) => c !== 'qbit.torrents' && !c.startsWith('jf.getItem'))

async function planFor(d: ReturnType<typeof deps>, actions: Parameters<typeof buildPlan>[1]['actions']) {
  const plan = await buildPlan(d as never, { createdBy: 'bob', actions })
  approvePlan(db, plan.id, 'bob')
  return plan
}

/** The resolver finds sibling hardlinks through fs_entries, which a real scan populates. */
function indexFile(path: string) {
  const st = statSync(path)
  db.prepare(`INSERT OR REPLACE INTO fs_entries (container_path, scan_id, parent_path, name, ext,
    is_dir, size_bytes, mtime, dev, inode, nlink, is_media, library_root, root_role)
    VALUES (?,1,?,?,'.mkv',0,?,0,?,?,?,1,?,'library')`).run(
    path, dirname(path), basename(path), st.size, Number(st.dev), Number(st.ino), st.nlink, root,
  )
}

const item = (id: string, path: string) =>
  db.prepare("INSERT INTO jellyfin_items (id, scan_id, type, name, container_path, has_primary_image) VALUES (?,1,'Movie','Heat',?,1)")
    .run(id, path)

const itemPath = (id: string, jfPath: string, path: string) =>
  db.prepare('INSERT INTO jellyfin_item_paths (item_id, scan_id, jf_path, container_path) VALUES (?,1,?,?)')
    .run(id, jfPath, path)

const trashRows = () => (db.prepare('SELECT COUNT(*) c FROM trash').get() as { c: number }).c

const planRow = (id: string) => db.prepare('SELECT status, error FROM plans WHERE id = ?').get(id) as
  { status: string; error: string | null }

/** What one action's run left behind: the executor's own account of it (empty until it has run). */
const resultOf = (planId: string, seq = 0) => {
  const row = db.prepare('SELECT status, error, result_json FROM plan_actions WHERE plan_id = ? AND seq = ?').get(planId, seq) as
    { status: string; error: string | null; result_json: string | null }
  const result = (row.result_json ? JSON.parse(row.result_json) : { detail: {}, bytesFreed: 0 }) as
    { detail: Record<string, unknown>; bytesFreed: number }
  return { status: row.status, error: row.error, detail: result.detail, bytesFreed: result.bytesFreed }
}

const deletedPaths = () => db.prepare('SELECT container_path, plan_id, deleted_at FROM deleted_paths ORDER BY container_path').all() as
  Array<{ container_path: string; plan_id: string; deleted_at: string }>

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
  it('unmonitors *arr, then removes the torrent with its data, then tells Jellyfin once the plan is done', async () => {
    const d = deps({
      qbittorrent: qbit({ torrents: async () => [torrent()] }),
      radarr: arrClient('radarr'),
    })
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    await executorFor(d).execute(plan.id, 'bob')
    expect(effects()).toEqual([
      `radarr.unmonitor:${ARR_PATH}`, 'qbit.delete:H1', 'qbit.awaitGone', 'jf.notify:/media/Heat.mkv',
    ])
  })

  it('re-reads live torrent state before it unmonitors anything — approval is not a licence to act on stale facts', async () => {
    const d = deps({ qbittorrent: qbit({ torrents: async () => [torrent()] }), radarr: arrClient('radarr') })
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    calls = []
    await executorFor(d).execute(plan.id, 'bob')
    expect(calls.indexOf('qbit.torrents')).toBeLessThan(calls.indexOf(`radarr.unmonitor:${ARR_PATH}`))
  })

  it('runs merges before deletes', async () => {
    const d = deps()
    const plan = await planFor(d, [
      { type: 'delete-media', targetPath: media },
      { type: 'merge-versions', itemIds: ['a', 'b'] },
    ])
    await executorFor(d).execute(plan.id, 'bob')
    const order = (db.prepare(
      "SELECT action_type FROM audit WHERE plan_id = ? AND action_type IN ('merge-versions', 'delete-media') ORDER BY id",
    ).all(plan.id) as Array<{ action_type: string }>).map((r) => r.action_type)
    expect(order).toEqual(['merge-versions', 'delete-media'])
  })

  it('tells Jellyfin exactly once for a multi-delete plan, naming every deleted path in its own spelling', async () => {
    const other = join(root, 'Other.mkv')
    writeFileSync(other, 'y')
    const d = deps()
    const plan = await planFor(d, [
      { type: 'delete-media', targetPath: media }, { type: 'delete-media', targetPath: other },
    ])
    await executorFor(d).execute(plan.id, 'bob')
    expect(calls.filter((c) => c.startsWith('jf.notify'))).toEqual(['jf.notify:/media/Heat.mkv,/media/Other.mkv'])
  })

  it('does not call Jellyfin at all when nothing was deleted', async () => {
    const d = deps()
    const plan = await planFor(d, [{ type: 'merge-versions', itemIds: ['a', 'b'] }])
    await executorFor(d).execute(plan.id, 'bob')
    expect(calls.filter((c) => c.startsWith('jf.'))).toEqual(['jf.merge:a,b'])
  })
})

describe('execute — fail-closed *arr', () => {
  const withArr = (unmonitor: unknown) => deps({
    qbittorrent: qbit({ torrents: async () => [torrent()] }),
    radarr: arrClient('radarr', { unmonitorByPath: unmonitor }),
  })

  it('skips the delete entirely when *arr unmonitor throws, and never calls qBittorrent', async () => {
    const d = withArr(async () => { throw new Error('radarr exploded') })
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    const summary = await executorFor(d).execute(plan.id, 'bob')
    expect(summary.skipped).toBe(1)
    expect(calls.some((c) => c.startsWith('qbit.delete'))).toBe(false)
    expect(existsSync(media)).toBe(true)
  })

  it('skips the delete on lookup-failed — "I could not look" is never "it is not there"', async () => {
    const d = withArr(async () => ({ outcome: 'lookup-failed', recordId: null }))
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    const summary = await executorFor(d).execute(plan.id, 'bob')
    expect(summary.skipped).toBe(1)
    expect(calls.some((c) => c.startsWith('qbit.delete'))).toBe(false)
    expect(existsSync(media)).toBe(true)
  })

  it('skips the delete when *arr answers not-managed for a record the resolver just matched', async () => {
    // The two answers contradict each other, so the unmonitor provably did not happen for a file
    // the inventory says IS managed. Anything but a confirmed flip is fail-closed.
    const d = withArr(async () => ({ outcome: 'not-managed', recordId: null }))
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    const summary = await executorFor(d).execute(plan.id, 'bob')
    expect(summary.skipped).toBe(1)
    expect(existsSync(media)).toBe(true)
  })

  it('passes the *arr-native path to unmonitorByPath, not the container path', async () => {
    const seen: string[] = []
    const d = deps({
      radarr: arrClient('radarr', {
        unmonitorByPath: async (p: string) => {
          seen.push(p)
          // Exactly what the real connector does: it matches on the path the *arr reported.
          return p === ARR_PATH ? { outcome: 'unmonitored', recordId: 1 } : { outcome: 'not-managed', recordId: null }
        },
      }),
    })
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    const summary = await executorFor(d).execute(plan.id, 'bob')
    expect(seen).toEqual([ARR_PATH])
    expect(summary.done).toBe(1)
    expect(existsSync(media)).toBe(false)
  })

  it('deletes without an unmonitor call when a COMPLETE inventory shows the file is not *arr-managed', async () => {
    const d = deps({
      radarr: arrClient('radarr', {
        inventory: async () => ({ records: [arrRecord({ arrPath: '/media/Somebody Else.mkv' })], complete: true }),
      }),
    })
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    const summary = await executorFor(d).execute(plan.id, 'bob')
    expect(calls.some((c) => c.startsWith('radarr.unmonitor'))).toBe(false)
    expect(summary.done).toBe(1)
    expect(existsSync(media)).toBe(false)
  })

  it('routes a sonarr record to the sonarr client, never to radarr', async () => {
    const d = deps({
      radarr: arrClient('radarr', { inventory: async () => ({ records: [], complete: true }) }),
      sonarr: arrClient('sonarr'),
    })
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    await executorFor(d).execute(plan.id, 'bob')
    expect(calls).toContain(`sonarr.unmonitor:${ARR_PATH}`)
    expect(calls.some((c) => c.startsWith('radarr.unmonitor'))).toBe(false)
  })
})

describe('execute — qBittorrent', () => {
  it('fails the action when qBittorrent does not confirm removal, leaving the file alone', async () => {
    const d = deps({
      qbittorrent: qbit({ torrents: async () => [torrent()], deleteWithData: async () => {}, awaitGone: async () => false }),
    })
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    const summary = await executorFor(d).execute(plan.id, 'bob')
    expect(summary.failed).toBe(1)
    expect(existsSync(media)).toBe(true)
  })

  it('fails the action when the delete call itself throws, leaving the file alone', async () => {
    const d = deps({
      qbittorrent: qbit({
        torrents: async () => [torrent()],
        deleteWithData: async () => { throw new Error('qbit 502') },
      }),
    })
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    const summary = await executorFor(d).execute(plan.id, 'bob')
    expect(summary.failed).toBe(1)
    expect(existsSync(media)).toBe(true)
  })

  it('never removes a torrent that merely shares a save directory with the file being deleted', async () => {
    const stranger = join(root, 'Unrelated.mkv')
    writeFileSync(stranger, 'u')
    const d = deps({
      qbittorrent: qbit({ torrents: async () => [torrent({ contentPath: '/downloads/Heat.mkv', savePath: '/downloads' })] }),
    })
    // No torrent owns the stranger, so guard.untracked asks first: the override is the operator
    // saying it is a leftover to delete from disk.
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: stranger, overrides: ['guard.untracked'] }])
    const summary = await executorFor(d).execute(plan.id, 'bob')
    expect(calls.some((c) => c.startsWith('qbit.delete'))).toBe(false)
    expect(summary.done).toBe(1)
    expect(existsSync(stranger)).toBe(false)
    expect(existsSync(media)).toBe(true)
  })

  it('blocks a delete that would take the rest of a multi-file torrent with it', async () => {
    // The season-pack sample: `sample.mkv` is its own torrent when the plan is approved, and by the
    // time it runs the same hash owns eleven episodes beside it — "remove the torrent with its
    // data" would take all of them, and only the operator can say whether that is what they meant.
    const pack = join(root, 'Pack')
    mkdirSync(pack, { recursive: true })
    const sample = join(pack, 'sample.mkv')
    writeFileSync(sample, 'junk')
    for (let i = 0; i < 11; i += 1) writeFileSync(join(pack, `E${i}.mkv`), 'e')
    let packed = false
    const d = deps({
      qbittorrent: qbit({
        torrents: async () => [torrent({ contentPath: '/downloads/Pack', savePath: '/downloads' })],
        files: async () => (packed
          ? [
            { index: 0, relPath: 'Pack/sample.mkv', sizeBytes: 4 },
            ...Array.from({ length: 11 }, (_, i) => ({ index: i + 1, relPath: `Pack/E${i}.mkv`, sizeBytes: 1 })),
          ]
          : [{ index: 0, relPath: 'Pack/sample.mkv', sizeBytes: 4 }]),
      }),
    })
    const plan = await planFor(d, [{ type: 'delete-junk-file', targetPath: sample }])
    packed = true
    const summary = await executorFor(d).execute(plan.id, 'bob')
    expect(summary.blocked).toBe(1)
    expect(calls.some((c) => c.startsWith('qbit.delete'))).toBe(false)
    expect(existsSync(sample)).toBe(true)
    expect(existsSync(join(pack, 'E0.mkv'))).toBe(true)
  })

  it('blocks the same delete at PLAN time too, so it never reaches an approval', async () => {
    const pack = join(root, 'Pack')
    mkdirSync(pack, { recursive: true })
    const sample = join(pack, 'sample.mkv')
    writeFileSync(sample, 'junk')
    writeFileSync(join(pack, 'E0.mkv'), 'e')
    const d = deps({
      qbittorrent: qbit({
        torrents: async () => [torrent({ contentPath: '/downloads/Pack', savePath: '/downloads' })],
        files: async () => [
          { index: 0, relPath: 'Pack/sample.mkv', sizeBytes: 4 },
          { index: 1, relPath: 'Pack/E0.mkv', sizeBytes: 1 },
        ],
      }),
    })
    const plan = await buildPlan(d as never, { createdBy: 'bob', actions: [{ type: 'delete-junk-file', targetPath: sample }] })
    expect(plan.actions[0]!.status).toBe('blocked')
    expect(plan.dryRun.torrentsRemoved).toBe(0)
  })

  it('proceeds once the operator overrides the scope block, which is theirs to make', async () => {
    const pack = join(root, 'Pack')
    mkdirSync(pack, { recursive: true })
    const sample = join(pack, 'sample.mkv')
    writeFileSync(sample, 'junk')
    writeFileSync(join(pack, 'E0.mkv'), 'e')
    const d = deps({
      qbittorrent: qbit({
        torrents: async () => [torrent({ contentPath: '/downloads/Pack', savePath: '/downloads' })],
        files: async () => [
          { index: 0, relPath: 'Pack/sample.mkv', sizeBytes: 4 },
          { index: 1, relPath: 'Pack/E0.mkv', sizeBytes: 1 },
        ],
      }),
    })
    const plan = await planFor(d, [
      { type: 'delete-junk-file', targetPath: sample, overrides: ['guard.torrent-scope'] },
    ])
    const summary = await executorFor(d).execute(plan.id, 'bob')
    expect(summary.done).toBe(1)
    expect(calls).toContain('qbit.delete:H1')
  })

  it('does not count a sibling whose own delete was skipped as still targeted', async () => {
    // E01 and E02 are the two files of one torrent, so the plan clears guard.torrent-scope: both
    // are named. At execute time E01's *arr unmonitor cannot be confirmed and its delete is skipped
    // — the fail-closed protection. If E02 still counts E01 as "in the plan", delete-with-data
    // takes E01's bytes anyway and the protection is silently undone.
    const pack = join(root, 'Pack')
    mkdirSync(pack, { recursive: true })
    const e01 = join(pack, 'E01.mkv')
    const e02 = join(pack, 'E02.mkv')
    writeFileSync(e01, '1'); writeFileSync(e02, '2')
    const d = deps({
      qbittorrent: qbit({
        torrents: async () => [torrent({ contentPath: '/downloads/Pack', savePath: '/downloads' })],
        files: async () => [
          { index: 0, relPath: 'Pack/E01.mkv', sizeBytes: 1 }, { index: 1, relPath: 'Pack/E02.mkv', sizeBytes: 1 },
        ],
      }),
      radarr: arrClient('radarr', {
        inventory: async () => ({
          records: [
            arrRecord({ remoteId: 1, arrPath: '/media/Pack/E01.mkv' }),
            arrRecord({ remoteId: 2, arrPath: '/media/Pack/E02.mkv' }),
          ],
          complete: true,
        }),
        unmonitorByPath: async (p: string) => {
          calls.push(`radarr.unmonitor:${p}`)
          return p.endsWith('E01.mkv')
            ? { outcome: 'lookup-failed', recordId: null }
            : { outcome: 'unmonitored', recordId: 2 }
        },
      }),
    })
    const plan = await planFor(d, [
      { type: 'delete-media', targetPath: e01 }, { type: 'delete-media', targetPath: e02 },
    ])
    const summary = await executorFor(d).execute(plan.id, 'bob')
    expect(summary.skipped).toBe(1)
    expect(summary.blocked).toBe(1)
    expect(calls.some((c) => c.startsWith('qbit.delete'))).toBe(false)
    expect(existsSync(e01)).toBe(true)
    expect(existsSync(e02)).toBe(true)
  })

  /**
   * A season pack under one hash, both episodes named, so `guard.torrent-scope` passes. The point
   * of every test in this block is that "remove the torrent with its data" is a single act that
   * destroys BOTH files, so it must be atomic with respect to both files' *arr unmonitor — not
   * just the one the current action happens to name.
   */
  function twoEpisodePack(over: {
    unmonitor?: (p: string) => Promise<unknown>
    extraFile?: () => boolean
  } = {}) {
    const pack = join(root, 'Pack')
    mkdirSync(pack, { recursive: true })
    const e01 = join(pack, 'E01.mkv')
    const e02 = join(pack, 'E02.mkv')
    const e03 = join(pack, 'E03.mkv')
    writeFileSync(e01, '1'); writeFileSync(e02, '2'); writeFileSync(e03, '3')
    const state = { removed: false }
    const d = deps({
      qbittorrent: qbit({
        torrents: async () => (state.removed ? [] : [torrent({ contentPath: '/downloads/Pack', savePath: '/downloads' })]),
        files: async () => [
          { index: 0, relPath: 'Pack/E01.mkv', sizeBytes: 1 },
          { index: 1, relPath: 'Pack/E02.mkv', sizeBytes: 1 },
          ...(over.extraFile?.() ? [{ index: 2, relPath: 'Pack/E03.mkv', sizeBytes: 1 }] : []),
        ],
        // The real client removes the torrent's WHOLE content, which is exactly the hazard.
        deleteWithData: async (h: string[]) => {
          calls.push(`qbit.delete:${h.join(',')}`)
          state.removed = true
          for (const p of [e01, e02, e03]) if (existsSync(p)) unlinkSync(p)
        },
      }),
      radarr: arrClient('radarr', {
        inventory: async () => ({
          records: [
            arrRecord({ remoteId: 1, title: 'E01', arrPath: '/media/Pack/E01.mkv' }),
            arrRecord({ remoteId: 2, title: 'E02', arrPath: '/media/Pack/E02.mkv' }),
            arrRecord({ remoteId: 3, title: 'E03', arrPath: '/media/Pack/E03.mkv' }),
          ],
          complete: true,
        }),
        unmonitorByPath: over.unmonitor ?? (async (p: string) => {
          calls.push(`radarr.unmonitor:${p}`)
          return { outcome: 'unmonitored', recordId: 1 }
        }),
      }),
    })
    return { d, e01, e02, e03, state }
  }

  it('refuses to remove a torrent when a SIBLING file it would destroy cannot be unmonitored', async () => {
    // The order is the whole finding: E01's own unmonitor confirms, so pre-fix its delete-with-data
    // removed the torrent and both files — and only THEN did E02's unmonitor fail, reporting
    // "skipped" for a file whose bytes were already gone and which Sonarr was still free to
    // re-grab. The torrent removal has to be atomic with respect to every file it destroys.
    const { d, e01, e02, state } = twoEpisodePack({
      unmonitor: async (p: string) => {
        calls.push(`radarr.unmonitor:${p}`)
        return p.endsWith('E02.mkv')
          ? { outcome: 'lookup-failed', recordId: null }
          : { outcome: 'unmonitored', recordId: 1 }
      },
    })
    const plan = await planFor(d, [
      { type: 'delete-media', targetPath: e01 }, { type: 'delete-media', targetPath: e02 },
    ])
    const summary = await executorFor(d).execute(plan.id, 'bob')

    expect(calls.some((c) => c.startsWith('qbit.delete'))).toBe(false)
    expect(state.removed).toBe(false)
    expect(existsSync(e01)).toBe(true)
    expect(existsSync(e02)).toBe(true)
    expect(summary.done).toBe(0)
    // E01 skipped on its sibling's account, naming it; E02 then blocks on its own scope, since E01
    // has dropped out of the plan's eligible paths.
    const rows = db.prepare('SELECT status, error FROM plan_actions WHERE plan_id=? ORDER BY seq')
      .all(plan.id) as Array<{ status: string; error: string }>
    expect(rows[0]!.status).toBe('skipped')
    expect(rows[0]!.error).toContain(e02)
    expect(rows[1]!.status).toBe('blocked')
  })

  it('removes the torrent exactly once when every sibling it would destroy is confirmed unmonitored', async () => {
    const { d, e01, e02 } = twoEpisodePack()
    const plan = await planFor(d, [
      { type: 'delete-media', targetPath: e01 }, { type: 'delete-media', targetPath: e02 },
    ])
    const summary = await executorFor(d).execute(plan.id, 'bob')

    expect(calls.filter((c) => c.startsWith('qbit.delete'))).toEqual(['qbit.delete:H1'])
    expect(existsSync(e01)).toBe(false)
    expect(existsSync(e02)).toBe(false)
    expect(summary.done).toBe(2)
    expect(summary.skipped + summary.blocked + summary.failed).toBe(0)
  })

  it('still blocks at guard.torrent-scope when the torrent owns a file no action names', async () => {
    // The sibling unmonitor covers files the plan NAMES. A file nobody named is a different
    // question, and it is still `guard.torrent-scope`'s to answer — fail-closed, before any
    // unmonitor runs at all.
    let grown = false
    const { d, e01, e02, e03 } = twoEpisodePack({ extraFile: () => grown })
    const plan = await planFor(d, [
      { type: 'delete-media', targetPath: e01 }, { type: 'delete-media', targetPath: e02 },
    ])
    grown = true // the same hash owns a third episode by the time the plan runs
    const summary = await executorFor(d).execute(plan.id, 'bob')

    expect(summary.blocked).toBe(2)
    expect(calls.some((c) => c.startsWith('qbit.delete'))).toBe(false)
    expect(calls.some((c) => c.startsWith('radarr.unmonitor'))).toBe(false)
    expect(existsSync(e01)).toBe(true)
    expect(existsSync(e02)).toBe(true)
    expect(existsSync(e03)).toBe(true)
  })

  it('one failure does not abort the rest of the plan', async () => {
    const other = join(root, 'Other.mkv')
    writeFileSync(other, 'y'.repeat(50))
    const d = deps({
      qbittorrent: qbit({ torrents: async () => [torrent()], deleteWithData: async () => {}, awaitGone: async () => false }),
    })
    const plan = await planFor(d, [
      { type: 'delete-media', targetPath: media },
      { type: 'delete-media', targetPath: other, overrides: ['guard.untracked'] },
    ])
    const summary = await executorFor(d).execute(plan.id, 'bob')
    expect(summary.failed).toBe(1)
    expect(summary.done).toBe(1)
    expect(existsSync(media)).toBe(true)
    expect(existsSync(other)).toBe(false)
  })
})

describe('execute — guards at execute time', () => {
  it('blocks an action whose guard state changed after approval', async () => {
    let state = 'stalledUP'
    const d = deps({ qbittorrent: qbit({ torrents: async () => [torrent({ state })] }) })
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    state = 'downloading' // someone hit re-download between approval and execution
    const summary = await executorFor(d).execute(plan.id, 'bob')
    expect(summary.blocked).toBe(1)
    expect(calls.some((c) => c.startsWith('qbit.delete'))).toBe(false)
    expect(existsSync(media)).toBe(true)
  })

  it('refuses to let an approved override clear guard.protected', async () => {
    // The override here is legitimately pre-authorised: guard.private-ratio really was blocking
    // when the operator approved, so buildPlan accepts it. It still cannot clear guard.protected,
    // which allows no override at all.
    let state = 'stalledUP'
    const d = deps({
      qbittorrent: qbit({
        torrents: async () => [torrent({ state, isPrivate: true, ratio: 0.1, seedingTimeSeconds: 60 })],
      }),
    })
    const plan = await planFor(d, [
      { type: 'delete-media', targetPath: media, overrides: ['guard.private-ratio'] },
    ])
    state = 'moving' // someone hit re-download between approval and execution
    const summary = await executorFor(d).execute(plan.id, 'bob')
    expect(summary.blocked).toBe(1)
    expect(existsSync(media)).toBe(true)
  })

  /**
   * A season pack whose torrent owns one file at plan time and twelve by execute time. `packed`
   * flips between the two.
   */
  function growingPack() {
    const pack = join(root, 'Pack')
    mkdirSync(pack, { recursive: true })
    const sample = join(pack, 'sample.mkv')
    writeFileSync(sample, 'junk')
    for (let i = 0; i < 11; i += 1) writeFileSync(join(pack, `E${i}.mkv`), 'e')
    const state = { packed: false }
    const d = deps({
      qbittorrent: qbit({
        torrents: async () => [torrent({ contentPath: '/downloads/Pack', savePath: '/downloads' })],
        files: async () => (state.packed
          ? [
            { index: 0, relPath: 'Pack/sample.mkv', sizeBytes: 4 },
            ...Array.from({ length: 11 }, (_, i) => ({ index: i + 1, relPath: `Pack/E${i}.mkv`, sizeBytes: 1 })),
          ]
          : [{ index: 0, relPath: 'Pack/sample.mkv', sizeBytes: 4 }]),
        // The bytes the operator never saw are only really at stake if the fake takes them, so it does.
        deleteWithData: async (h: string[]) => {
          calls.push(`qbit.delete:${h.join(',')}`)
          for (const name of readdirSync(pack)) unlinkSync(join(pack, name))
        },
      }),
    })
    return { d, pack, sample, state }
  }

  it('ignores an override for a guard that was NOT blocking when the plan was approved', async () => {
    // The operator was shown a clean plan: one torrent, four bytes, guard.torrent-scope passing.
    // The override rode along on the request anyway. By execute time the same hash owns eleven
    // episodes and scope blocks — and a pre-granted override for a guard nobody was ever shown
    // must not clear it, or eleven files no operator saw are destroyed while the audit row says
    // "overrode guard.torrent-scope", which is true and useless.
    const { d, pack, sample, state } = growingPack()
    const plan = await planFor(d, [{ type: 'delete-junk-file', targetPath: sample }])
    expect(plan.dryRun.torrentsRemoved).toBe(1)
    expect(plan.actions[0]!.guardVerdicts.find((v) => v.guard === 'guard.torrent-scope')!.outcome).toBe('pass')

    // buildPlan drops such an override rather than storing it (see the planner tests); this is the
    // executor's own second line, which is what protects a plan minted by any other writer.
    const row = db.prepare('SELECT id, payload_json FROM plan_actions WHERE plan_id=?').get(plan.id) as
      { id: string; payload_json: string }
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>
    payload.overrides = ['guard.torrent-scope']
    db.prepare('UPDATE plan_actions SET payload_json=? WHERE id=?').run(JSON.stringify(payload), row.id)

    state.packed = true
    const summary = await executorFor(d).execute(plan.id, 'bob')

    expect(summary.blocked).toBe(1)
    expect(calls.some((c) => c.startsWith('qbit.delete'))).toBe(false)
    expect(existsSync(sample)).toBe(true)
    expect(existsSync(join(pack, 'E0.mkv'))).toBe(true)
    const settled = db.prepare('SELECT error FROM plan_actions WHERE id=?').get(row.id) as { error: string }
    expect(settled.error).toMatch(/guard\.torrent-scope/)
    expect(settled.error).toMatch(/approved/i)
  })

  it('honours an override for a guard that DID block when the plan was approved', async () => {
    // Same shape, one difference that is the whole point: the scope block was on screen when the
    // operator approved, so the override answers a question they were actually asked.
    const { d, pack, sample, state } = growingPack()
    state.packed = true
    const plan = await planFor(d, [
      { type: 'delete-junk-file', targetPath: sample, overrides: ['guard.torrent-scope'] },
    ])
    expect(plan.actions[0]!.guardVerdicts.find((v) => v.guard === 'guard.torrent-scope')!.outcome).toBe('block')
    const summary = await executorFor(d).execute(plan.id, 'bob')
    expect(summary.done).toBe(1)
    expect(calls).toContain('qbit.delete:H1')
    expect(existsSync(join(pack, 'E0.mkv'))).toBe(false)
  })

  it('blocks when qBittorrent becomes unreachable between approval and execution', async () => {
    let up = true
    const d = deps({
      qbittorrent: qbit({ torrents: async () => { if (!up) throw new Error('connection refused'); return [] } }),
    })
    // A leftover in a torrent-backed root: approved as one, through guard.untracked's override.
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media, overrides: ['guard.untracked'] }])
    up = false
    const summary = await executorFor(d).execute(plan.id, 'bob')
    expect(summary.blocked).toBe(1)
    expect(resultOf(plan.id).error).toMatch(/guard\.protected/)
    expect(existsSync(media)).toBe(true)
  })

  it('honours an override the operator approved, for a guard that allows one', async () => {
    const d = deps({
      qbittorrent: qbit({ torrents: async () => [torrent({ isPrivate: true, ratio: 0.1, seedingTimeSeconds: 60 })] }),
    })
    const plan = await planFor(d, [
      { type: 'delete-media', targetPath: media, overrides: ['guard.private-ratio'] },
    ])
    const summary = await executorFor(d).execute(plan.id, 'bob')
    expect(summary.done).toBe(1)
    expect(existsSync(media)).toBe(false)
  })

  it('skips the delete when the file at the path changed identity after the guards ran', async () => {
    const d = deps({
      radarr: arrClient('radarr', {
        // The unmonitor step sits between the guard check and the unlink: swapping the file here
        // is the tightest window an attacker (or a racing *arr import) actually has.
        unmonitorByPath: async () => {
          unlinkSync(media)
          writeFileSync(media, 'a different film entirely')
          return { outcome: 'unmonitored', recordId: 1 }
        },
      }),
    })
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    const summary = await executorFor(d).execute(plan.id, 'bob')
    expect(summary.skipped).toBe(1)
    expect(existsSync(media)).toBe(true)
  })

  it('refuses to unlink a symlink — removing the link frees nothing and leaves the real file', async () => {
    const link = join(root, 'Heat-link.mkv')
    symlinkSync(media, link)
    const d = deps()
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: link }])
    const summary = await executorFor(d).execute(plan.id, 'bob')
    expect(summary.skipped).toBe(1)
    expect(existsSync(link)).toBe(true)
    expect(existsSync(media)).toBe(true)
  })
})

describe('execute — filesystem effects', () => {
  it('deletes a non-torrent file directly and reports the bytes freed', async () => {
    const d = deps()
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    const summary = await executorFor(d).execute(plan.id, 'bob')
    expect(existsSync(media)).toBe(false)
    expect(summary.bytesFreed).toBe(100)
  })

  it('removes an empty folder but never climbs above the root', async () => {
    const nested = join(root, 'Show', 'Season 01')
    mkdirSync(nested, { recursive: true })
    unlinkSync(media) // the root is now empty apart from the chain being swept
    const d = deps()
    const plan = await planFor(d, [{ type: 'remove-empty-folder', targetPath: nested }])
    await executorFor(d).execute(plan.id, 'bob')
    expect(existsSync(nested)).toBe(false)
    expect(existsSync(join(root, 'Show'))).toBe(false)
    expect(existsSync(root)).toBe(true)
    expect(existsSync(dir)).toBe(true)
  })

  it('refuses to remove a configured root itself', async () => {
    unlinkSync(media)
    const d = deps()
    const plan = await planFor(d, [{ type: 'remove-empty-folder', targetPath: root }])
    const summary = await executorFor(d).execute(plan.id, 'bob')
    expect(summary.failed).toBe(1)
    expect(existsSync(root)).toBe(true)
  })

  it('skips a folder that is no longer empty', async () => {
    const nested = join(root, 'Show')
    mkdirSync(nested, { recursive: true })
    const d = deps()
    const plan = await planFor(d, [{ type: 'remove-empty-folder', targetPath: nested }])
    writeFileSync(join(nested, 'late-arrival.mkv'), 'z')
    const summary = await executorFor(d).execute(plan.id, 'bob')
    expect(summary.skipped).toBe(1)
    expect(existsSync(nested)).toBe(true)
  })

  it('sweeps the now-empty parent of a deleted file, stopping at the root', async () => {
    const nested = join(root, 'Show', 'Season 01')
    mkdirSync(nested, { recursive: true })
    const episode = join(nested, 'S01E01.mkv')
    writeFileSync(episode, 'e')
    const d = deps()
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: episode }])
    await executorFor(d).execute(plan.id, 'bob')
    expect(existsSync(nested)).toBe(false)
    expect(existsSync(join(root, 'Show'))).toBe(false)
    expect(existsSync(root)).toBe(true)
  })

  it('trashes a small junk file instead of deleting it', async () => {
    const junk = join(root, 'sample.mkv')
    writeFileSync(junk, 'junk')
    const d = deps()
    const plan = await planFor(d, [{ type: 'delete-junk-file', targetPath: junk }])
    const summary = await executorFor(d).execute(plan.id, 'bob')
    expect(existsSync(junk)).toBe(false)
    expect(trashRows()).toBe(1)
    // A trashed file still occupies its bytes; claiming them as freed would be a lie.
    expect(summary.bytesFreed).toBe(0)
  })

  it('deletes a junk file permanently when it is too big for the trash', async () => {
    const junk = join(root, 'sample.mkv')
    writeFileSync(junk, 'junk')
    const d = deps({ config: fileConfigSchema.parse({ trash: { maxBytes: 1 } }) })
    const plan = await planFor(d, [{ type: 'delete-junk-file', targetPath: junk }])
    const summary = await executorFor(d).execute(plan.id, 'bob')
    expect(existsSync(junk)).toBe(false)
    expect(trashRows()).toBe(0)
    expect(summary.bytesFreed).toBe(4)
  })

  it('never trashes a torrent-backed junk file — qBittorrent owns those bytes', async () => {
    const junk = join(root, 'sample.mkv')
    writeFileSync(junk, 'junk')
    const d = deps({
      qbittorrent: qbit({ torrents: async () => [torrent({ contentPath: '/downloads/sample.mkv', sizeBytes: 4 })] }),
    })
    const plan = await planFor(d, [{ type: 'delete-junk-file', targetPath: junk }])
    await executorFor(d).execute(plan.id, 'bob')
    expect(existsSync(junk)).toBe(false)
    expect(trashRows()).toBe(0)
    expect(resultOf(plan.id).detail.disposition).toBe('removed-by-qbittorrent')
  })

  it('removes only the selected link of a hardlinked file, leaving the other intact and claiming nothing', async () => {
    const other = join(root, 'Heat-link.mkv')
    linkSync(media, other)
    indexFile(media); indexFile(other)
    const d = deps()
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    const summary = await executorFor(d).execute(plan.id, 'bob')
    expect(existsSync(media)).toBe(false)
    expect(existsSync(other)).toBe(true)
    expect(summary.bytesFreed).toBe(0)
  })

  it('claims the bytes once qBittorrent has removed the other link and this one is the last', async () => {
    const downloaded = join(root, 'Heat-dl.mkv')
    linkSync(media, downloaded)
    indexFile(media); indexFile(downloaded)
    const d = deps({
      qbittorrent: qbit({
        torrents: async () => [torrent({ contentPath: '/downloads/Heat-dl.mkv' })],
        // The real client deletes its own data; the fake must too, or the accounting is untested.
        deleteWithData: async () => { unlinkSync(downloaded) },
        awaitGone: async () => true,
      }),
    })
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    const summary = await executorFor(d).execute(plan.id, 'bob')
    expect(existsSync(media)).toBe(false)
    expect(summary.bytesFreed).toBe(100)
    // qBittorrent took its own name for the bytes; this path was the library's, unlinked here.
    expect(resultOf(plan.id).detail.disposition).toBe('unlinked')
  })

  it('treats an already-deleted file as done without touching anything else', async () => {
    const d = deps()
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    unlinkSync(media)
    const summary = await executorFor(d).execute(plan.id, 'bob')
    expect(summary.done).toBe(1)
    expect(summary.bytesFreed).toBe(0)
  })
})

describe('execute — Jellyfin forgets deleted paths, and is never asked to delete', () => {
  it('notifies Jellyfin only for paths that are gone, once per plan', async () => {
    // Three deletes. Heat goes. Back goes, then reappears before the plan ends (a re-download).
    // Kept never goes: its *arr unmonitor fails, so its delete is skipped.
    const back = join(root, 'Back.mkv')
    const kept = join(root, 'Kept.mkv')
    writeFileSync(back, 'b'.repeat(10))
    writeFileSync(kept, 'k'.repeat(10))
    const d = deps({
      radarr: arrClient('radarr', {
        inventory: async () => ({ records: [arrRecord({ title: 'Kept', arrPath: '/media/Kept.mkv' })], complete: true }),
        unmonitorByPath: async () => {
          writeFileSync(back, 'downloaded again')
          throw new Error('radarr down')
        },
      }),
    })
    const plan = await planFor(d, [
      { type: 'delete-media', targetPath: media },
      { type: 'delete-media', targetPath: back },
      { type: 'delete-media', targetPath: kept },
    ])
    const summary = await executorFor(d).execute(plan.id, 'bob')
    expect([summary.done, summary.skipped]).toEqual([2, 1])
    expect(calls.filter((c) => c.startsWith('jf.notify'))).toEqual(['jf.notify:/media/Heat.mkv'])
    const audit = db.prepare("SELECT outcome, after_json FROM audit WHERE action_type = 'notify-jellyfin'").all() as
      Array<{ outcome: string; after_json: string }>
    expect(audit).toHaveLength(1)
    expect(audit[0]!.outcome).toBe('done')
    expect(JSON.parse(audit[0]!.after_json)).toMatchObject({ jellyfinPaths: ['/media/Heat.mkv'], stillPresent: [back] })
  })

  it('executor never calls deleteItem or refreshLibrary', async () => {
    // Everything that used to end in an item delete or a library refresh: a Jellyfin item's own
    // file, a merged item's alternate version, a merge in the same plan, a file already gone.
    const alt = join(root, 'Heat-remux.mkv')
    const gone = join(root, 'Gone.mkv')
    writeFileSync(alt, 'r'.repeat(80))
    writeFileSync(gone, 'g')
    item('i1', media)
    itemPath('i1', '/media/Heat.mkv', media)
    itemPath('i1', '/media/Heat-remux.mkv', alt)
    item('i2', gone)
    const d = deps()
    const plan = await planFor(d, [
      { type: 'merge-versions', itemIds: ['i1', 'i3'] },
      { type: 'delete-media', targetPath: alt },
      { type: 'delete-media', targetPath: gone },
    ])
    unlinkSync(gone)
    const summary = await executorFor(d).execute(plan.id, 'bob')
    expect(summary.done).toBe(3)
    expect(calls.filter((c) => /^jf\.(deleteItem|getItem|refreshLibrary)/.test(c))).toEqual([])
    expect(calls).toContain('jf.notify:/media/Gone.mkv,/media/Heat-remux.mkv')
  })

  it("tells Jellyfin about a merged alternate version by its own path, and leaves the version kept alone", async () => {
    const alt = join(root, 'Heat-remux.mkv')
    writeFileSync(alt, 'r'.repeat(80))
    item('i1', media)
    itemPath('i1', '/media/Heat.mkv', media)
    itemPath('i1', '/media/Heat-remux.mkv', alt)
    const d = deps()
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: alt }])
    expect(plan.actions[0]!.isAlternateVersion).toBe(true)
    await executorFor(d).execute(plan.id, 'bob')
    expect(existsSync(alt)).toBe(false)
    expect(existsSync(media)).toBe(true)
    expect(calls.filter((c) => c.startsWith('jf.'))).toEqual(['jf.notify:/media/Heat-remux.mkv'])
  })

  it('never tells Jellyfin about a path in a root it does not see', async () => {
    const downloads = join(dir, 'downloads')
    mkdirSync(downloads)
    const loose = join(downloads, 'Loose.mkv')
    writeFileSync(loose, 'l')
    const pathMap = createPathMap([
      { role: 'library', jellyfin: '/media', container: root, qbit: null, qbitInstance: null },
      { role: 'download', jellyfin: null, container: downloads, qbit: null, qbitInstance: null },
    ])
    const d = deps({ pathMap })
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: loose }, { type: 'delete-media', targetPath: media }])
    await executorFor(d).execute(plan.id, 'bob')
    expect(existsSync(loose)).toBe(false)
    expect(calls.filter((c) => c.startsWith('jf.'))).toEqual(['jf.notify:/media/Heat.mkv'])
  })

  it('records a failed notification in the audit and still completes the plan — the bytes are already gone', async () => {
    const d = deps({ jellyfin: jellyfinDouble({ notifyPathsDeleted: async () => { throw new Error('jellyfin 503') } }) })
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    const summary = await executorFor(d).execute(plan.id, 'bob')
    expect(summary.status).toBe('completed')
    expect(existsSync(media)).toBe(false)
    const row = db.prepare("SELECT outcome, after_json FROM audit WHERE action_type = 'notify-jellyfin'").get() as
      { outcome: string; after_json: string }
    expect(row.outcome).toBe('failed')
    expect(JSON.parse(row.after_json).error).toMatch(/503/)
  })

  it('records it in the audit when the list of deleted paths cannot even be read, rather than vanishing', async () => {
    const d = deps()
    const plan = await planFor(d, [{ type: 'merge-versions', itemIds: ['a', 'b'] }])
    db.exec('DROP TABLE deleted_paths')
    const summary = await executorFor(d).execute(plan.id, 'bob')
    expect(summary.status).toBe('completed')
    expect(calls.filter((c) => c.startsWith('jf.notify'))).toEqual([])
    const row = db.prepare("SELECT outcome, after_json FROM audit WHERE action_type = 'notify-jellyfin'").get() as
      { outcome: string; after_json: string } | undefined
    expect(row?.outcome).toBe('failed')
    expect(JSON.parse(row!.after_json).error).toMatch(/deleted_paths/)
  })

  it('deleted paths are recorded in deleted_paths', async () => {
    // Every way a target ends up gone: unlinked here, moved to the trash, taken by qBittorrent, or
    // already gone when the action ran. A path the plan did not remove is not recorded.
    const junk = join(root, 'sample.mkv')
    const ghost = join(root, 'Ghost.mkv')
    const blocked = join(root, 'Blocked.mkv')
    writeFileSync(junk, 'junk'); writeFileSync(ghost, 'g'); writeFileSync(blocked, 'b')
    const d = deps({
      qbittorrent: qbit({
        torrents: async () => [
          torrent({ hash: 'h1' }),
          torrent({ hash: 'h2', name: 'Blocked', contentPath: '/downloads/Blocked.mkv', state: 'downloading' }),
        ],
      }),
    })
    const plan = await planFor(d, [
      { type: 'delete-media', targetPath: media },
      { type: 'delete-junk-file', targetPath: junk, overrides: ['guard.untracked'] },
      { type: 'delete-media', targetPath: ghost, overrides: ['guard.untracked'] },
      { type: 'delete-media', targetPath: blocked },
    ])
    unlinkSync(ghost)
    await executorFor(d).execute(plan.id, 'bob')
    const rows = deletedPaths()
    expect(rows.map((r) => r.container_path)).toEqual([ghost, media, junk])
    expect(rows.every((r) => r.plan_id === plan.id && !Number.isNaN(Date.parse(r.deleted_at)))).toBe(true)
    expect(trashRows()).toBe(1)
  })
})

describe('execute — bytes freed', () => {
  it('bytes freed credit each removed torrent once', async () => {
    // Two episodes of one pack, both in the plan. The first delete takes the whole torrent — both
    // episodes and the .nfo — and is credited with all of it; the second finds its file already
    // gone and is credited nothing. Crediting per action counted one episode and lost the rest.
    const pack = join(root, 'Pack')
    mkdirSync(pack, { recursive: true })
    const e01 = join(pack, 'E01.mkv')
    const e02 = join(pack, 'E02.mkv')
    writeFileSync(e01, '1'.repeat(400)); writeFileSync(e02, '2'.repeat(500)); writeFileSync(join(pack, 'Pack.nfo'), 'n'.repeat(30))
    const d = deps({
      qbittorrent: qbit({
        torrents: async () => [torrent({ hash: 'hp', name: 'Pack', contentPath: '/downloads/Pack', sizeBytes: 930 })],
        files: async () => [
          { index: 0, relPath: 'Pack/E01.mkv', sizeBytes: 400 },
          { index: 1, relPath: 'Pack/E02.mkv', sizeBytes: 500 },
          { index: 2, relPath: 'Pack/Pack.nfo', sizeBytes: 30 },
        ],
      }),
    })
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: e01 }, { type: 'delete-media', targetPath: e02 }])
    expect(plan.dryRun.bytesFreed).toBe(930)
    const summary = await executorFor(d).execute(plan.id, 'bob')
    expect(summary.done).toBe(2)
    expect(summary.bytesFreed).toBe(930)
    expect([resultOf(plan.id, 0).bytesFreed, resultOf(plan.id, 1).bytesFreed]).toEqual([930, 0])
    expect(calls.filter((c) => c.startsWith('qbit.delete'))).toEqual(['qbit.delete:hp'])
    expect(existsSync(pack)).toBe(false)
  })
})

describe('execute — bookkeeping', () => {
  it('writes an audit row per action, carrying the actor, the guard verdicts and the outcome', async () => {
    const d = deps()
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    await executorFor(d).execute(plan.id, 'bob')
    const rows = db.prepare("SELECT actor, action_type, outcome, before_json, plan_id FROM audit WHERE action_type='delete-media'")
      .all() as Array<{ actor: string; outcome: string; before_json: string; plan_id: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0]!.actor).toBe('bob')
    expect(rows[0]!.outcome).toBe('done')
    expect(rows[0]!.plan_id).toBe(plan.id)
    const before = JSON.parse(rows[0]!.before_json) as { guardVerdicts: Array<{ guard: string }> }
    expect(before.guardVerdicts.map((v) => v.guard)).toContain('guard.protected')
  })

  it('records each removed torrent in the audit with the instance it was removed from', async () => {
    const d = deps({ qbittorrent: qbit({ torrents: async () => [torrent({ hash: 'h1' })] }) })
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    await executorFor(d).execute(plan.id, 'bob')
    const row = db.prepare("SELECT after_json FROM audit WHERE action_type='delete-media'").get() as { after_json: string }
    expect(JSON.parse(row.after_json).torrents).toEqual([{ instanceId: 'box-a', hash: 'h1' }])
  })

  it('records a blocked action with the guard that blocked it', async () => {
    let state = 'stalledUP'
    const d = deps({ qbittorrent: qbit({ torrents: async () => [torrent({ state })] }) })
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    state = 'downloading'
    await executorFor(d).execute(plan.id, 'bob')
    const row = db.prepare('SELECT status, error FROM plan_actions WHERE plan_id=?').get(plan.id) as
      { status: string; error: string }
    expect(row.status).toBe('blocked')
    expect(row.error).toContain('guard.protected')
  })

  it('marks the plan completed, or failed when any action failed', async () => {
    const d = deps({ qbittorrent: qbit({ torrents: async () => [torrent()], deleteWithData: async () => {}, awaitGone: async () => false }) })
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    const summary = await executorFor(d).execute(plan.id, 'bob')
    expect(summary.status).toBe('failed')
    expect(planRow(plan.id).status).toBe('failed')
  })

  it('refuses to execute a plan that was never approved', async () => {
    const d = deps()
    const plan = await buildPlan(d as never, { createdBy: 'bob', actions: [{ type: 'delete-media', targetPath: media }] })
    await expect(executorFor(d).execute(plan.id, 'bob')).rejects.toThrow(/not approved/i)
    expect(existsSync(media)).toBe(true)
  })

  it('refuses to execute a plan that does not exist', async () => {
    await expect(executorFor(deps()).execute('nope', 'bob')).rejects.toThrow(/does not exist/i)
  })

  it('refuses to run two plans at once', async () => {
    const d = deps({
      jellyfin: jellyfinDouble({ mergeVersions: async () => { await new Promise((r) => setTimeout(r, 30)) } }),
    })
    const p1 = await planFor(d, [{ type: 'merge-versions', itemIds: ['a', 'b'] }])
    const p2 = await planFor(d, [{ type: 'merge-versions', itemIds: ['c', 'd'] }])
    const exec = executorFor(d)
    const first = exec.execute(p1.id, 'bob')
    await expect(exec.execute(p2.id, 'bob')).rejects.toThrow(/already running/i)
    await first
  })

  it('refuses to start while another plan is still marked running in the database', async () => {
    const d = deps()
    const stuck = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    db.prepare("UPDATE plans SET status='running' WHERE id=?").run(stuck.id)
    const other = join(root, 'Other.mkv')
    writeFileSync(other, 'y')
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: other }])
    await expect(executorFor(d).execute(plan.id, 'bob')).rejects.toThrow(/already running/i)
    expect(existsSync(other)).toBe(true)
    // A refused run holds nothing: the activity lock is free for whoever comes next.
    expect(d.activity.current()).toBeNull()
  })

  it('releases the mutex after a rejected execution, so the executor cannot wedge', async () => {
    const d = deps()
    const draft = await buildPlan(d as never, { createdBy: 'bob', actions: [{ type: 'delete-media', targetPath: media }] })
    const exec = executorFor(d)
    await expect(exec.execute(draft.id, 'bob')).rejects.toThrow(/not approved/i)
    expect(exec.isRunning()).toBe(false)
    approvePlan(db, draft.id, 'bob')
    expect((await exec.execute(draft.id, 'bob')).done).toBe(1)
    expect(exec.isRunning()).toBe(false)
    expect(d.activity.current()).toBeNull()
  })

  it('is idempotent — re-executing a completed plan deletes nothing more', async () => {
    const d = deps()
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    const exec = executorFor(d)
    await exec.execute(plan.id, 'bob')
    const before = effects().filter((c) => !c.startsWith('jf.notify'))
    db.prepare("UPDATE plans SET status='approved' WHERE id=?").run(plan.id)
    const second = await exec.execute(plan.id, 'bob')
    expect(second.done).toBe(0)
    // Every run tells Jellyfin what the plan has deleted; nothing else happens again.
    expect(effects().filter((c) => !c.startsWith('jf.notify'))).toEqual(before)
  })

  it('takes ONE *arr inventory snapshot for the whole run, not one per action', async () => {
    const other = join(root, 'Other.mkv')
    writeFileSync(other, 'y')
    let inventories = 0
    const d = deps({
      radarr: arrClient('radarr', {
        inventory: async () => { inventories += 1; return { records: [arrRecord()], complete: true } },
      }),
    })
    const plan = await planFor(d, [
      { type: 'delete-media', targetPath: media }, { type: 'delete-media', targetPath: other },
    ])
    inventories = 0
    await executorFor(d).execute(plan.id, 'bob')
    expect(inventories).toBe(1)
  })

  it("serves every action of a run from one torrent list while that instance deletes nothing", async () => {
    const other = join(root, 'Other.mkv')
    writeFileSync(other, 'y')
    const d = deps({ qbittorrent: qbit() })
    const plan = await planFor(d, [
      { type: 'delete-media', targetPath: media, overrides: ['guard.untracked'] },
      { type: 'delete-media', targetPath: other, overrides: ['guard.untracked'] },
    ])
    calls = []
    await executorFor(d).execute(plan.id, 'bob')
    expect(calls.filter((c) => c === 'qbit.torrents')).toHaveLength(1)
  })

  it("re-reads an instance's torrent list right after that instance deletes something", async () => {
    const other = join(root, 'Other.mkv')
    writeFileSync(other, 'y'.repeat(100))
    const d = deps({
      qbittorrent: qbit({
        torrents: async () => [torrent({ hash: 'h1' }), torrent({ hash: 'h2', name: 'Other', contentPath: '/downloads/Other.mkv' })],
      }),
    })
    const plan = await planFor(d, [
      { type: 'delete-media', targetPath: media }, { type: 'delete-media', targetPath: other },
    ])
    calls = []
    await executorFor(d).execute(plan.id, 'bob')
    expect(calls.filter((c) => c === 'qbit.torrents' || c.startsWith('qbit.delete'))).toEqual([
      'qbit.torrents', 'qbit.delete:h1', 'qbit.torrents', 'qbit.delete:h2',
    ])
  })

  it('does not credit qBittorrent for a file that vanished before the plan ran', async () => {
    item('i1', media)
    const d = deps()
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    unlinkSync(media)
    const summary = await executorFor(d).execute(plan.id, 'bob')
    expect(summary.bytesFreed).toBe(0)
    expect(resultOf(plan.id).detail.disposition).toBe('already-gone')
  })

  it('does not credit qBittorrent for a file that vanished while the guards were still running', async () => {
    // The file is stat'd by resolveTarget and then disappears during its own service calls — long
    // before qBittorrent is asked to do anything. Attributing that to qBittorrent claims bytes
    // nothing here freed.
    let armed = false
    const d = deps({
      qbittorrent: qbit({ torrents: async () => { if (armed && existsSync(media)) unlinkSync(media); return [] } }),
    })
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media, overrides: ['guard.untracked'] }])
    armed = true
    const summary = await executorFor(d).execute(plan.id, 'bob')
    expect(summary.bytesFreed).toBe(0)
    expect(resultOf(plan.id).detail.disposition).toBe('already-gone')
  })

  it('a crash mid-run marks the plan failed, records why, and hands the unfinished action back as pending', async () => {
    const d = deps()
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    db.exec('DROP TABLE audit') // a database fault outside any one action
    const exec = executorFor(d)
    await expect(exec.execute(plan.id, 'bob')).rejects.toThrow(/audit/)
    expect(planRow(plan.id)).toEqual({ status: 'failed', error: expect.stringMatching(/audit/) })
    expect((db.prepare('SELECT status FROM plan_actions WHERE plan_id=?').get(plan.id) as { status: string }).status).toBe('pending')
    // Nothing is left held: no in-process run, no activity lock, no plan claiming 'running'.
    expect(exec.isRunning()).toBe(false)
    expect(d.activity.current()).toBeNull()
  })

  it('resumes only the unfinished tail of an interrupted plan', async () => {
    const other = join(root, 'Other.mkv')
    writeFileSync(other, 'y')
    const d = deps()
    const plan = await planFor(d, [
      { type: 'delete-media', targetPath: media }, { type: 'delete-media', targetPath: other },
    ])
    // What a crash mid-plan leaves behind, and what the resume route hands back to the executor.
    db.prepare("UPDATE plan_actions SET status='done' WHERE plan_id=? AND seq=0").run(plan.id)
    const summary = await executorFor(d).execute(plan.id, 'bob')
    expect(summary.done).toBe(1)
    expect(existsSync(media)).toBe(true)
    expect(existsSync(other)).toBe(false)
  })

  it("a run that claims the plan clears an earlier run's error", async () => {
    const d = deps()
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    db.prepare("UPDATE plans SET error='execution of plan was stopped before it finished' WHERE id=?").run(plan.id)
    let seenDuringRun: string | null | undefined
    const exec = createExecutor({
      ...d,
      // Read while the run is in flight: the claim itself must already have cleared it.
      jellyfin: jellyfinDouble({ notifyPathsDeleted: async () => { seenDuringRun = planRow(plan.id).error } }),
    })
    await exec.execute(plan.id, 'bob')
    expect(seenDuringRun).toBeNull()
    expect(planRow(plan.id)).toEqual({ status: 'completed', error: null })
  })
})

describe('execute — qBittorrent instances', () => {
  /**
   * Three boxes that each spell their library `/movies` and each seed their own copy of X, under
   * their own hash. The roots are disjoint, so a copy belongs to exactly one box.
   */
  function threeBoxes() {
    const boxes = ['box-a', 'box-b', 'box-c'] as const
    const roots = Object.fromEntries(boxes.map((id) => [id, join(dir, id)])) as Record<(typeof boxes)[number], string>
    for (const id of boxes) {
      mkdirSync(roots[id], { recursive: true })
      writeFileSync(join(roots[id], 'X.mkv'), `${id}'s copy`)
    }
    const pathMap = createPathMap(boxes.map((id) => (
      { role: 'library' as const, jellyfin: `/media/${id}`, container: roots[id], qbit: '/movies', qbitInstance: id })))
    const deleted: Record<string, string[][]> = { 'box-a': [], 'box-b': [], 'box-c': [] }
    const clients = new Map(boxes.map((id) => [id, {
      instanceId: id,
      torrents: async () => [torrent({ instanceId: id, hash: `hash-${id}`, savePath: '/movies', contentPath: '/movies/X.mkv' })],
      files: async () => [{ index: 0, relPath: 'X.mkv', sizeBytes: 9 }],
      deleteWithData: async (hashes: string[]) => {
        deleted[id]!.push(hashes)
        unlinkSync(join(roots[id], 'X.mkv'))
      },
      awaitGone: async () => true,
    }]))
    const d = deps({ pathMap, qbittorrents: clients })
    return { d, roots, deleted }
  }

  it('executor routes deletes to the owning instance only', async () => {
    const { d, roots, deleted } = threeBoxes()
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: join(roots['box-b'], 'X.mkv') }])
    expect(plan.actions[0]!.payload.resolution!.torrents.map((t) => [t.instanceId, t.hash])).toEqual([['box-b', 'hash-box-b']])
    const summary = await executorFor(d).execute(plan.id, 'bob')
    expect(summary.done).toBe(1)
    expect(deleted).toEqual({ 'box-a': [], 'box-b': [['hash-box-b']], 'box-c': [] })
    expect(existsSync(join(roots['box-a'], 'X.mkv'))).toBe(true)
    expect(existsSync(join(roots['box-c'], 'X.mkv'))).toBe(true)

    // And the reverse: box A's copy goes through box A alone.
    const back = await planFor(d, [{ type: 'delete-media', targetPath: join(roots['box-a'], 'X.mkv') }])
    await executorFor(d).execute(back.id, 'bob')
    expect(deleted).toEqual({ 'box-a': [['hash-box-a']], 'box-b': [['hash-box-b']], 'box-c': [] })
    expect(existsSync(join(roots['box-c'], 'X.mkv'))).toBe(true)
  })
})

describe('the activity lock', () => {
  it('refuses to run while a scan holds it, and holds it for the length of a run', async () => {
    let heldDuringRun: unknown
    const d = deps()
    const exec = createExecutor({
      ...d, jellyfin: jellyfinDouble({ mergeVersions: async () => { heldDuringRun = d.activity.current() } }),
    })
    const plan = await planFor(d, [{ type: 'merge-versions', itemIds: ['a', 'b'] }])

    d.activity.tryAcquire('scan', 'scan-9')
    await expect(exec.execute(plan.id, 'bob')).rejects.toThrow(/scan/)
    expect(exec.start(plan.id, 'bob')).toEqual({ ok: false, error: 'busy', reason: expect.stringMatching(/scan-9/) })
    expect(planRow(plan.id).status).toBe('approved')
    d.activity.release('scan', 'scan-9')

    await exec.execute(plan.id, 'bob')
    expect(heldDuringRun).toEqual({ kind: 'plan', id: plan.id })
    expect(d.activity.current()).toBeNull()
  })
})

describe('the verification gate', () => {
  it('refuses to run a plan whose mapping set changed after approval and was never verified, claiming nothing', async () => {
    // Spec §2's gate, extended from scans and builds to the step that deletes: every action is
    // re-resolved under the CURRENT mappings, so a set nobody verified would route the deletes.
    const d = deps({ qbittorrent: qbit({ torrents: async () => [torrent()] }) })
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    const edited = createPathMap([{ role: 'library', jellyfin: '/library', container: root, qbit: '/downloads', qbitInstance: 'box-a' }])
    const changed = { ...d, configStore: configStoreOf(() => fileConfigSchema.parse({}), () => edited, ['box-a']) } as unknown as typeof d
    const exec = executorFor(changed)
    calls = []

    await expect(exec.execute(plan.id, 'bob')).rejects.toMatchObject({
      name: 'ExecutionRefused', code: 'verification', message: expect.stringMatching(/changed since/),
    })
    expect(exec.start(plan.id, 'bob')).toEqual({ ok: false, error: 'verification', reason: expect.stringMatching(/changed since/) })
    await exec.idle()
    expect(planRow(plan.id)).toEqual({ status: 'approved', error: null })
    expect((db.prepare('SELECT status FROM plan_actions WHERE plan_id = ?').all(plan.id) as Array<{ status: string }>)
      .map((a) => a.status)).toEqual(['pending'])
    expect(exec.isRunning()).toBe(false)
    expect(d.activity.current()).toBeNull()
    expect(existsSync(media)).toBe(true)
    expect(calls).toEqual([])

    // Verified as it now stands, the same approved plan runs.
    verifyMappings(db, changed.configStore)
    expect((await exec.execute(plan.id, 'bob')).done).toBe(1)
    expect(existsSync(media)).toBe(false)
  })
})

describe('start / requestStop / idle', () => {
  it('start runs the plan in the background; a second start is refused while it runs; idle resolves after', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const d = deps({ jellyfin: jellyfinDouble({ mergeVersions: async () => { await gate } }) })
    const p1 = await planFor(d, [{ type: 'merge-versions', itemIds: ['a', 'b'] }])
    const p2 = await planFor(d, [{ type: 'merge-versions', itemIds: ['c', 'd'] }])
    const exec = executorFor(d)
    expect(exec.start(p1.id, 'bob')).toEqual({ ok: true })
    // A 202 promises the plan is running: the claim happened before start returned.
    expect(planRow(p1.id).status).toBe('running')
    expect(exec.start(p2.id, 'bob')).toMatchObject({ ok: false, error: 'busy' })
    expect(exec.isRunning()).toBe(true)
    release()
    await exec.idle()
    expect(exec.isRunning()).toBe(false)
    expect(planRow(p1.id)).toEqual({ status: 'completed', error: null })
  })

  it('refuses at once, writing nothing, a plan that is not approved or does not exist', async () => {
    const d = deps()
    const draft = await buildPlan(d as never, { createdBy: 'bob', actions: [{ type: 'delete-media', targetPath: media }] })
    const exec = executorFor(d)
    expect(exec.start(draft.id, 'bob')).toEqual({ ok: false, error: 'not-approved', reason: expect.stringMatching(/not approved/) })
    expect(exec.start('nope', 'bob')).toMatchObject({ ok: false, error: 'not-found' })
    await exec.idle()
    expect(planRow(draft.id)).toEqual({ status: 'draft', error: null })
    expect(existsSync(media)).toBe(true)
  })

  it('records why a background run crashed in plans.error, and marks the plan failed', async () => {
    const d = deps()
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    db.exec('DROP TABLE audit')
    const exec = executorFor(d)
    expect(exec.start(plan.id, 'bob')).toEqual({ ok: true })
    await exec.idle()
    expect(planRow(plan.id)).toEqual({ status: 'failed', error: expect.stringMatching(/audit/) })
  })

  it('idle resolves at once when nothing is running', async () => {
    await executorFor(deps()).idle()
  })

  it('requestStop finishes the current action, leaves the rest pending, and resumes cleanly', async () => {
    const second = join(root, 'Second.mkv')
    writeFileSync(second, 'y')
    let exec!: ReturnType<typeof createExecutor>
    const d = deps({
      radarr: arrClient('radarr', {
        // The stop arrives while the first delete is mid-flight, between its guards and its unlink.
        unmonitorByPath: async (p: string) => {
          calls.push(`radarr.unmonitor:${p}`)
          exec.requestStop()
          return { outcome: 'unmonitored', recordId: 1 }
        },
      }),
    })
    const plan = await planFor(d, [
      { type: 'delete-media', targetPath: media },
      { type: 'delete-media', targetPath: second },
    ])
    exec = executorFor(d)
    await expect(exec.execute(plan.id, 'bob')).rejects.toThrow(/stopped/i)
    const statuses = () => (db.prepare('SELECT status FROM plan_actions WHERE plan_id = ? ORDER BY seq').all(plan.id) as
      Array<{ status: string }>).map((a) => a.status)
    expect(statuses()).toEqual(['done', 'pending'])
    expect(planRow(plan.id)).toEqual({ status: 'approved', error: expect.stringMatching(/stopped/) })
    expect(existsSync(media)).toBe(false)
    expect(existsSync(second)).toBe(true)
    expect(d.activity.current()).toBeNull()
    // Stopping is no reason to leave Jellyfin holding a deleted file: what the run did delete is
    // still told, at the end of the run that deleted it.
    expect(calls.filter((c) => c.startsWith('jf.notify'))).toEqual(['jf.notify:/media/Heat.mkv'])

    const resumed = await exec.execute(plan.id, 'bob')
    expect(resumed.done).toBe(1)
    expect(statuses()).toEqual(['done', 'done'])
    expect(existsSync(second)).toBe(false)
    expect(planRow(plan.id)).toEqual({ status: 'completed', error: null })
    // The resumed run tells Jellyfin about everything the plan has deleted, both runs' worth.
    expect(calls.filter((c) => c.startsWith('jf.notify')).at(-1)).toBe('jf.notify:/media/Heat.mkv,/media/Second.mkv')
  })
})
