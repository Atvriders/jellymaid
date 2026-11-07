import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../src/index/db.js'
import { buildPlan, approvePlan } from '../../src/plan/planner.js'
import { createExecutor } from '../../src/plan/executor.js'
import { createPathMap } from '../../src/fs/pathmap.js'
import { fileConfigSchema } from '../../src/config/schema.js'
import { createActivityLock } from '../../src/core/activity.js'
import { configStoreOf, verifyMappings } from './support.js'

// The one race this file exists for — a file that is gone by the time the executor's own unlink
// runs — cannot be produced on a local disk on demand, so unlinkSync is wrapped: it behaves exactly
// like the real one unless a test scripts a single call.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, unlinkSync: vi.fn(actual.unlinkSync) }
})

const realFs = await vi.importActual<typeof import('node:fs')>('node:fs')

let db: Db
let root: string
let media: string

const torrent = { instanceId: 'box-a', hash: 'h1', name: 'Heat', savePath: '/downloads', contentPath: '/downloads/Heat.mkv',
  rootPath: '', category: null, tags: [], state: 'stalledUP', ratio: 5, seedingTimeSeconds: 30 * 86_400,
  isPrivate: false, privacySource: 'flag', trackerHost: 't', sizeBytes: 100, progress: 1, addedOn: null }

/** One torrent, saved straight into the library as the owner's are, on a qBittorrent whose delete
 * is answered before its files are gone. `removeFiles` is what qBittorrent does afterwards. */
function setup(removeFiles: () => void) {
  let deleted = false
  const map = createPathMap([{ role: 'library', jellyfin: '/media', container: root, qbit: '/downloads', qbitInstance: 'box-a' }])
  const configStore = configStoreOf(() => fileConfigSchema.parse({}), () => map)
  verifyMappings(db, configStore)
  const notified: string[][] = []
  const d = {
    db,
    configStore,
    qbittorrents: new Map([['box-a', {
      instanceId: 'box-a',
      torrents: async () => (deleted ? [] : [torrent]),
      files: async () => [{ index: 0, relPath: 'Heat.mkv', sizeBytes: 100 }],
      deleteWithData: async () => { deleted = true; removeFiles() },
      awaitGone: async () => deleted,
    }]]),
    radarr: null,
    sonarr: null,
    jellyfin: { mergeVersions: async () => {}, splitVersions: async () => {}, notifyPathsDeleted: async (p: string[]) => { notified.push(p) } },
    activity: createActivityLock(),
  } as unknown as Parameters<typeof createExecutor>[0]
  return { d, notified }
}

async function approvedPlan(d: Parameters<typeof createExecutor>[0]) {
  const plan = await buildPlan(d as never, { createdBy: 'bob', actions: [{ type: 'delete-media', targetPath: media }] })
  approvePlan(db, plan.id, 'bob')
  return plan
}

const resultOf = (planId: string) => JSON.parse((db.prepare('SELECT result_json FROM plan_actions WHERE plan_id = ?').get(planId) as
  { result_json: string }).result_json) as { status: string; bytesFreed: number; detail: { disposition: string } }

beforeEach(() => {
  vi.mocked(fs.unlinkSync).mockClear()
  const dir = fs.mkdtempSync(join(tmpdir(), 'jm-exec-async-'))
  db = openDb(join(dir, 'db.sqlite'))
  root = join(dir, 'lib')
  fs.mkdirSync(root, { recursive: true })
  media = join(root, 'Heat.mkv')
  fs.writeFileSync(media, 'x'.repeat(100))
})

describe('step 3: qBittorrent deletes asynchronously', () => {
  it("executor waits for qBittorrent's asynchronous delete and treats ENOENT as removed-by-qbittorrent", async () => {
    // qBittorrent answers torrents/delete at once and takes the file 150 ms later. The executor
    // waits for it rather than racing it, and never unlinks the file itself.
    const later = setup(() => { setTimeout(() => realFs.unlinkSync(media), 150) })
    const plan = await approvedPlan(later.d)
    const summary = await createExecutor(later.d, { goneTimeoutMs: 5_000, gonePollMs: 10 }).execute(plan.id, 'bob')
    expect(summary).toMatchObject({ done: 1, failed: 0, bytesFreed: 100 })
    expect(resultOf(plan.id).detail.disposition).toBe('removed-by-qbittorrent')
    expect(vi.mocked(fs.unlinkSync)).not.toHaveBeenCalledWith(media)
    expect(later.notified).toEqual([['/media/Heat.mkv']])

    // Still visible when the wait runs out — an NFS client's stale view — and gone by the time the
    // identity-checked unlink runs. That ENOENT is qBittorrent finishing, not a failed action.
    fs.writeFileSync(media, 'y'.repeat(100))
    const stale = setup(() => {})
    const second = await approvedPlan(stale.d)
    vi.mocked(fs.unlinkSync).mockImplementationOnce((path) => {
      realFs.unlinkSync(path) // qBittorrent gets there first
      realFs.unlinkSync(path) // ...so this one finds nothing: ENOENT
    })
    const after = await createExecutor(stale.d, { goneTimeoutMs: 30, gonePollMs: 5 }).execute(second.id, 'bob')
    expect(after).toMatchObject({ done: 1, failed: 0, bytesFreed: 100 })
    expect(resultOf(second.id).detail.disposition).toBe('removed-by-qbittorrent')
    expect(fs.existsSync(media)).toBe(false)
  })

  /**
   * A season pack saved straight into the library, every episode queued. One torrent owns both
   * files; `removeFiles` is what qBittorrent does to them after answering torrents/delete.
   */
  function packSetup(removeFiles: (e01: string, e02: string) => void) {
    const pack = join(root, 'Pack')
    fs.mkdirSync(pack, { recursive: true })
    const e01 = join(pack, 'E01.mkv')
    const e02 = join(pack, 'E02.mkv')
    fs.writeFileSync(e01, '1'.repeat(400))
    fs.writeFileSync(e02, '2'.repeat(500))
    let deleted = false
    const map = createPathMap([{ role: 'library', jellyfin: '/media', container: root, qbit: '/downloads', qbitInstance: 'box-a' }])
    const configStore = configStoreOf(() => fileConfigSchema.parse({}), () => map)
    verifyMappings(db, configStore)
    const notified: string[][] = []
    const packTorrent = { ...torrent, hash: 'hp', name: 'Pack', contentPath: '/downloads/Pack', rootPath: 'Pack', sizeBytes: 900 }
    const d = {
      db,
      configStore,
      qbittorrents: new Map([['box-a', {
        instanceId: 'box-a',
        torrents: async () => (deleted ? [] : [packTorrent]),
        files: async () => [{ index: 0, relPath: 'Pack/E01.mkv', sizeBytes: 400 }, { index: 1, relPath: 'Pack/E02.mkv', sizeBytes: 500 }],
        deleteWithData: async () => { deleted = true; removeFiles(e01, e02) },
        awaitGone: async () => deleted,
      }]]),
      radarr: null,
      sonarr: null,
      jellyfin: { mergeVersions: async () => {}, splitVersions: async () => {}, notifyPathsDeleted: async (p: string[]) => { notified.push(p) } },
      activity: createActivityLock(),
    } as unknown as Parameters<typeof createExecutor>[0]
    return { d, notified, pack, e01, e02 }
  }

  async function approvedPack(d: Parameters<typeof createExecutor>[0], e01: string, e02: string) {
    const plan = await buildPlan(d as never, {
      createdBy: 'bob',
      actions: [{ type: 'delete-media', targetPath: e01 }, { type: 'delete-media', targetPath: e02 }],
    })
    expect(plan.actions.map((a) => a.status)).toEqual(['pending', 'pending'])
    approvePlan(db, plan.id, 'bob')
    return plan
  }

  const rowsOf = (planId: string) => (db.prepare('SELECT status, error, result_json FROM plan_actions WHERE plan_id = ? ORDER BY seq')
    .all(planId) as Array<{ status: string; error: string | null; result_json: string }>)
    .map((r) => ({ status: r.status, error: r.error, detail: (JSON.parse(r.result_json) as { detail: Record<string, unknown> }).detail }))

  const deletedPaths = () => (db.prepare('SELECT container_path FROM deleted_paths ORDER BY container_path').all() as
    Array<{ container_path: string }>).map((r) => r.container_path)

  it('settles every episode of a fully queued pack whose files qBittorrent removes one after another', async () => {
    // qBittorrent takes E01 at once and E02 a moment later. The first action removes the torrent;
    // the second must not then judge E02 — still on disk, its torrent gone from the fresh list — as
    // a file no torrent owns: it is the rest of the delete this run just started.
    const { d, notified, pack, e01, e02 } = packSetup((first, second) => {
      realFs.unlinkSync(first)
      setTimeout(() => realFs.unlinkSync(second), 150)
    })
    const plan = await approvedPack(d, e01, e02)
    const summary = await createExecutor(d, { goneTimeoutMs: 5_000, gonePollMs: 10 }).execute(plan.id, 'bob')

    expect(summary).toMatchObject({ done: 2, blocked: 0, failed: 0, skipped: 0, bytesFreed: 900 })
    const rows = rowsOf(plan.id)
    expect(rows.map((r) => [r.status, r.detail.disposition])).toEqual([
      ['done', 'removed-by-qbittorrent'], ['done', 'removed-by-qbittorrent'],
    ])
    // The first action's wait covered E02 as well as its own file, so the folder went with the
    // action that removed the torrent, and E02's action found its file already taken.
    expect(rows[0]!.detail.sweptDirectories).toEqual([pack])
    expect(rows[1]!.detail.removedWith).toEqual([{ instanceId: 'box-a', hash: 'hp' }])
    expect(deletedPaths()).toEqual([e01, e02])
    expect(notified).toEqual([['/media/Pack/E01.mkv', '/media/Pack/E02.mkv']])
    // qBittorrent took both; the executor unlinked neither, and the emptied folder is swept.
    expect(vi.mocked(fs.unlinkSync)).not.toHaveBeenCalledWith(e01)
    expect(vi.mocked(fs.unlinkSync)).not.toHaveBeenCalledWith(e02)
    expect(fs.existsSync(e02)).toBe(false)
    expect(fs.existsSync(pack)).toBe(false)
  })

  it('finishes a pack sibling still visible after the whole wait, rather than blocking it as untracked', async () => {
    // An NFS client's stale view: E02 is still visible when the first action's wait runs out, and
    // the second action re-resolves it with the torrent already gone from the fresh list. It is the
    // same file the removed torrent owned, so it is settled through the identity-checked unlink, not
    // blocked as a file nobody owns.
    const { d, notified, pack, e01, e02 } = packSetup((first) => { realFs.unlinkSync(first) })
    const plan = await approvedPack(d, e01, e02)
    const summary = await createExecutor(d, { goneTimeoutMs: 40, gonePollMs: 5 }).execute(plan.id, 'bob')

    expect(summary).toMatchObject({ done: 2, blocked: 0, failed: 0, skipped: 0, bytesFreed: 900 })
    const rows = rowsOf(plan.id)
    expect(rows[1]!.status).toBe('done')
    expect(rows[1]!.detail).toMatchObject({ disposition: 'unlinked', removedWith: [{ instanceId: 'box-a', hash: 'hp' }] })
    expect(deletedPaths()).toEqual([e01, e02])
    expect(notified).toEqual([['/media/Pack/E01.mkv', '/media/Pack/E02.mkv']])
    expect(fs.existsSync(e02)).toBe(false)
    expect(fs.existsSync(pack)).toBe(false)
  })

  it('still blocks a different file that appears where a removed torrent\'s file was', async () => {
    // The pass above is for the bytes the removed torrent owned, never for whatever sits at the path
    // afterwards: a file written there since is judged on its own, and nothing owns it.
    const { d, notified, e01, e02 } = packSetup((first, second) => {
      realFs.unlinkSync(first)
      realFs.unlinkSync(second)
      realFs.writeFileSync(second, 'new bytes, nobody\'s torrent')
    })
    const plan = await approvedPack(d, e01, e02)
    const summary = await createExecutor(d, { goneTimeoutMs: 40, gonePollMs: 5 }).execute(plan.id, 'bob')

    expect(summary).toMatchObject({ done: 1, blocked: 1 })
    expect(rowsOf(plan.id)[1]!.error).toMatch(/guard\.untracked/)
    expect(realFs.readFileSync(e02, 'utf8')).toBe('new bytes, nobody\'s torrent')
    expect(deletedPaths()).toEqual([e01])
    expect(notified).toEqual([['/media/Pack/E01.mkv']])
  })

  it('leaves a removed torrent\'s file alone when it was rewritten in place since, even though inode and size still match', async () => {
    // Same dev, inode and size — all a Resolution can show guard.untracked — but not the bytes the
    // torrent owned: mtime moved. The executor's own identity check is the one that catches it.
    const { d, e01, e02 } = packSetup((first, second) => {
      realFs.unlinkSync(first)
      realFs.utimesSync(second, new Date(2_000_000_000_000), new Date(2_000_000_000_000))
    })
    const plan = await approvedPack(d, e01, e02)
    const summary = await createExecutor(d, { goneTimeoutMs: 40, gonePollMs: 5 }).execute(plan.id, 'bob')

    expect(summary).toMatchObject({ done: 1, skipped: 1 })
    expect(rowsOf(plan.id)[1]!.error).toMatch(/changed identity after the torrent that owned it was removed/)
    expect(fs.existsSync(e02)).toBe(true)
    expect(vi.mocked(fs.unlinkSync)).not.toHaveBeenCalledWith(e02)
    expect(deletedPaths()).toEqual([e01])
  })

  it('fails, rather than calling it done, when the unlink fails for any reason but ENOENT', async () => {
    const { d } = setup(() => {})
    const plan = await approvedPlan(d)
    vi.mocked(fs.unlinkSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    })
    const summary = await createExecutor(d, { goneTimeoutMs: 30, gonePollMs: 5 }).execute(plan.id, 'bob')
    expect(summary.failed).toBe(1)
    expect(fs.existsSync(media)).toBe(true)
  })
})
