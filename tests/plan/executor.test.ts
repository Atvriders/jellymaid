import { describe, it, expect, beforeEach } from 'vitest'
import {
  mkdtempSync, mkdirSync, writeFileSync, existsSync, linkSync, symlinkSync, unlinkSync, statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
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
/** Jellyfin's LIVE MediaSources[] paths per item id, in the Jellyfin namespace. */
let jellyfinSources: Record<string, string[]>

/**
 * The *arr namespace is deliberately NOT the container namespace: `arrPath` is what Radarr/Sonarr
 * themselves report ('/media/Heat.mkv'), and the path map translates it to the container path the
 * executor deletes. Every test keeps them distinct so that passing the wrong one to
 * `unmonitorByPath` — which matches on the *arr-native string — cannot pass unnoticed.
 */
const ARR_PATH = '/media/Heat.mkv'

const torrent = (over: Record<string, unknown> = {}) => ({
  hash: 'H1', name: 'Heat', savePath: '/downloads', contentPath: '/downloads/Heat.mkv',
  category: null, tags: [] as string[], state: 'stalledUP', ratio: 5, seedingTimeSeconds: 30 * 86_400,
  isPrivate: false, privacySource: 'flag', trackerHost: 't', sizeBytes: 10, progress: 1, ...over,
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

/**
 * Every call is recorded through the factory, not through the override, so a test that supplies its
 * own torrent list still logs the read — otherwise the ordering assertion's filter would be
 * silently vacuous for exactly the tests that matter most.
 */
type QbitDouble = NonNullable<Parameters<typeof createExecutor>[0]['qbittorrent']>

const qbit = (over: QbitOverrides = {}): QbitDouble => {
  const list = over.torrents ?? (async () => [])
  return {
    torrents: async () => { calls.push('qbit.torrents'); return list() },
    // A real qBittorrent always knows its own file list. The default derives a single-file torrent
    // from the fixture's own contentPath; multi-file tests override it.
    files: over.files ?? (async (hash: string) => {
      const t = (await list()).find((x) => x.hash === hash)
      const content = t?.contentPath as string | undefined
      return content ? [{ index: 0, relPath: content.split('/').pop()!, sizeBytes: (t?.sizeBytes as number) ?? 0 }] : []
    }),
    deleteWithData: over.deleteWithData ?? (async (h: string[]) => { calls.push(`qbit.delete:${h.join(',')}`) }),
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

function deps(over: Record<string, unknown> = {}) {
  return {
    db,
    config: fileConfigSchema.parse({}),
    pathMap: createPathMap([{ role: 'library', jellyfin: '/media', container: root, qbit: '/downloads' }]),
    qbittorrent: qbit(),
    radarr: null,
    sonarr: null,
    jellyfin: {
      deleteItem: async (id: string) => { calls.push(`jf.delete:${id}`) },
      mergeVersions: async (ids: string[]) => { calls.push(`jf.merge:${ids.join(',')}`) },
      splitVersions: async (id: string) => { calls.push(`jf.split:${id}`) },
      refreshLibrary: async () => { calls.push('jf.refresh') },
      // The LIVE view of the item, which is what gates the item delete. Defaults to a healthy
      // single-source item; tests that model a merge performed outside Jellymaid change it.
      getItem: async (id: string) => {
        calls.push(`jf.getItem:${id}`)
        const paths = jellyfinSources[id]
        return paths ? { id, mediaSourcePaths: paths } : null
      },
    },
    ...over,
  } as Parameters<typeof createExecutor>[0]
}

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

beforeEach(() => {
  calls = []
  jellyfinSources = { i1: ['/media/Heat.mkv'] }
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
      qbittorrent: qbit({ torrents: async () => [torrent()] }),
      radarr: arrClient('radarr'),
    })
    item('i1', media)
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    await createExecutor(d).execute(plan.id, 'bob')
    expect(effects()).toEqual([
      `radarr.unmonitor:${ARR_PATH}`, 'qbit.delete:H1', 'qbit.awaitGone', 'jf.delete:i1', 'jf.refresh',
    ])
  })

  it('re-reads live torrent state before it unmonitors anything — approval is not a licence to act on stale facts', async () => {
    const d = deps({ qbittorrent: qbit({ torrents: async () => [torrent()] }), radarr: arrClient('radarr') })
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    calls = []
    await createExecutor(d).execute(plan.id, 'bob')
    expect(calls.indexOf('qbit.torrents')).toBeLessThan(calls.indexOf(`radarr.unmonitor:${ARR_PATH}`))
  })

  it('runs merges before deletes', async () => {
    const d = deps()
    const plan = await planFor(d, [
      { type: 'delete-media', targetPath: media },
      { type: 'merge-versions', itemIds: ['a', 'b'] },
    ])
    await createExecutor(d).execute(plan.id, 'bob')
    expect(calls.indexOf('jf.merge:a,b'))
      .toBeLessThan(calls.findIndex((c) => c.startsWith('jf.delete') || c === 'jf.refresh'))
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

  it('does not refresh at all when nothing was touched', async () => {
    const d = deps()
    const plan = await planFor(d, [{ type: 'merge-versions', itemIds: ['a', 'b'] }])
    await createExecutor(d).execute(plan.id, 'bob')
    expect(calls).not.toContain('jf.refresh')
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
    const summary = await createExecutor(d).execute(plan.id, 'bob')
    expect(summary.skipped).toBe(1)
    expect(calls.some((c) => c.startsWith('qbit.delete'))).toBe(false)
    expect(existsSync(media)).toBe(true)
  })

  it('skips the delete on lookup-failed — "I could not look" is never "it is not there"', async () => {
    const d = withArr(async () => ({ outcome: 'lookup-failed', recordId: null }))
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    const summary = await createExecutor(d).execute(plan.id, 'bob')
    expect(summary.skipped).toBe(1)
    expect(calls.some((c) => c.startsWith('qbit.delete'))).toBe(false)
    expect(existsSync(media)).toBe(true)
  })

  it('skips the delete when *arr answers not-managed for a record the resolver just matched', async () => {
    // The two answers contradict each other, so the unmonitor provably did not happen for a file
    // the inventory says IS managed. Anything but a confirmed flip is fail-closed.
    const d = withArr(async () => ({ outcome: 'not-managed', recordId: null }))
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    const summary = await createExecutor(d).execute(plan.id, 'bob')
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
    const summary = await createExecutor(d).execute(plan.id, 'bob')
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
    const summary = await createExecutor(d).execute(plan.id, 'bob')
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
    await createExecutor(d).execute(plan.id, 'bob')
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
    const summary = await createExecutor(d).execute(plan.id, 'bob')
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
    const summary = await createExecutor(d).execute(plan.id, 'bob')
    expect(summary.failed).toBe(1)
    expect(existsSync(media)).toBe(true)
  })

  it('never removes a torrent that merely shares a save directory with the file being deleted', async () => {
    const stranger = join(root, 'Unrelated.mkv')
    writeFileSync(stranger, 'u')
    const d = deps({
      qbittorrent: qbit({ torrents: async () => [torrent({ contentPath: '/downloads/Heat.mkv', savePath: '/downloads' })] }),
    })
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: stranger }])
    const summary = await createExecutor(d).execute(plan.id, 'bob')
    expect(calls.some((c) => c.startsWith('qbit.delete'))).toBe(false)
    expect(summary.done).toBe(1)
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
    const summary = await createExecutor(d).execute(plan.id, 'bob')
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
    const summary = await createExecutor(d).execute(plan.id, 'bob')
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
    const summary = await createExecutor(d).execute(plan.id, 'bob')
    expect(summary.skipped).toBe(1)
    expect(summary.blocked).toBe(1)
    expect(calls.some((c) => c.startsWith('qbit.delete'))).toBe(false)
    expect(existsSync(e01)).toBe(true)
    expect(existsSync(e02)).toBe(true)
  })

  it('one failure does not abort the rest of the plan', async () => {
    const other = join(root, 'Other.mkv')
    writeFileSync(other, 'y'.repeat(50))
    const d = deps({
      qbittorrent: qbit({ torrents: async () => [torrent()], deleteWithData: async () => {}, awaitGone: async () => false }),
    })
    const plan = await planFor(d, [
      { type: 'delete-media', targetPath: media }, { type: 'delete-media', targetPath: other },
    ])
    const summary = await createExecutor(d).execute(plan.id, 'bob')
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
    const summary = await createExecutor(d).execute(plan.id, 'bob')
    expect(summary.blocked).toBe(1)
    expect(calls.some((c) => c.startsWith('qbit.delete'))).toBe(false)
    expect(existsSync(media)).toBe(true)
  })

  it('refuses to let an approved override clear guard.protected', async () => {
    let state = 'stalledUP'
    const d = deps({ qbittorrent: qbit({ torrents: async () => [torrent({ state })] }) })
    const plan = await planFor(d, [
      { type: 'delete-media', targetPath: media, overrides: ['guard.protected', 'guard.private-ratio'] },
    ])
    state = 'moving'
    const summary = await createExecutor(d).execute(plan.id, 'bob')
    expect(summary.blocked).toBe(1)
    expect(existsSync(media)).toBe(true)
  })

  it('blocks when qBittorrent becomes unreachable between approval and execution', async () => {
    let up = true
    const d = deps({
      qbittorrent: qbit({ torrents: async () => { if (!up) throw new Error('connection refused'); return [] } }),
    })
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    up = false
    const summary = await createExecutor(d).execute(plan.id, 'bob')
    expect(summary.blocked).toBe(1)
    expect(existsSync(media)).toBe(true)
  })

  it('honours an override the operator approved, for a guard that allows one', async () => {
    const d = deps({
      qbittorrent: qbit({ torrents: async () => [torrent({ isPrivate: true, ratio: 0.1, seedingTimeSeconds: 60 })] }),
    })
    const plan = await planFor(d, [
      { type: 'delete-media', targetPath: media, overrides: ['guard.private-ratio'] },
    ])
    const summary = await createExecutor(d).execute(plan.id, 'bob')
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
    const summary = await createExecutor(d).execute(plan.id, 'bob')
    expect(summary.skipped).toBe(1)
    expect(existsSync(media)).toBe(true)
  })

  it('refuses to unlink a symlink — removing the link frees nothing and leaves the real file', async () => {
    const link = join(root, 'Heat-link.mkv')
    symlinkSync(media, link)
    const d = deps()
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: link }])
    const summary = await createExecutor(d).execute(plan.id, 'bob')
    expect(summary.skipped).toBe(1)
    expect(existsSync(link)).toBe(true)
    expect(existsSync(media)).toBe(true)
  })
})

describe('execute — filesystem effects', () => {
  it('deletes a non-torrent file directly and reports the bytes freed', async () => {
    const d = deps()
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    const summary = await createExecutor(d).execute(plan.id, 'bob')
    expect(existsSync(media)).toBe(false)
    expect(summary.bytesFreed).toBe(100)
  })

  it('removes an empty folder but never climbs above the root', async () => {
    const nested = join(root, 'Show', 'Season 01')
    mkdirSync(nested, { recursive: true })
    unlinkSync(media) // the root is now empty apart from the chain being swept
    const d = deps()
    const plan = await planFor(d, [{ type: 'remove-empty-folder', targetPath: nested }])
    await createExecutor(d).execute(plan.id, 'bob')
    expect(existsSync(nested)).toBe(false)
    expect(existsSync(join(root, 'Show'))).toBe(false)
    expect(existsSync(root)).toBe(true)
    expect(existsSync(dir)).toBe(true)
  })

  it('refuses to remove a configured root itself', async () => {
    unlinkSync(media)
    const d = deps()
    const plan = await planFor(d, [{ type: 'remove-empty-folder', targetPath: root }])
    const summary = await createExecutor(d).execute(plan.id, 'bob')
    expect(summary.failed).toBe(1)
    expect(existsSync(root)).toBe(true)
  })

  it('skips a folder that is no longer empty', async () => {
    const nested = join(root, 'Show')
    mkdirSync(nested, { recursive: true })
    const d = deps()
    const plan = await planFor(d, [{ type: 'remove-empty-folder', targetPath: nested }])
    writeFileSync(join(nested, 'late-arrival.mkv'), 'z')
    const summary = await createExecutor(d).execute(plan.id, 'bob')
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
    await createExecutor(d).execute(plan.id, 'bob')
    expect(existsSync(nested)).toBe(false)
    expect(existsSync(join(root, 'Show'))).toBe(false)
    expect(existsSync(root)).toBe(true)
  })

  it('trashes a small junk file instead of deleting it', async () => {
    const junk = join(root, 'sample.mkv')
    writeFileSync(junk, 'junk')
    const d = deps()
    const plan = await planFor(d, [{ type: 'delete-junk-file', targetPath: junk }])
    const summary = await createExecutor(d).execute(plan.id, 'bob')
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
    const summary = await createExecutor(d).execute(plan.id, 'bob')
    expect(existsSync(junk)).toBe(false)
    expect(trashRows()).toBe(0)
    expect(summary.bytesFreed).toBe(4)
  })

  it('never trashes a torrent-backed junk file — qBittorrent owns those bytes', async () => {
    const junk = join(root, 'sample.mkv')
    writeFileSync(junk, 'junk')
    const d = deps({
      qbittorrent: qbit({ torrents: async () => [torrent({ contentPath: '/downloads/sample.mkv' })] }),
    })
    const plan = await planFor(d, [{ type: 'delete-junk-file', targetPath: junk }])
    await createExecutor(d).execute(plan.id, 'bob')
    expect(existsSync(junk)).toBe(false)
    expect(trashRows()).toBe(0)
  })

  it('removes only the selected link of a hardlinked file, leaving the other intact and claiming nothing', async () => {
    const other = join(root, 'Heat-link.mkv')
    linkSync(media, other)
    indexFile(media); indexFile(other)
    const d = deps()
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    const summary = await createExecutor(d).execute(plan.id, 'bob')
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
    const summary = await createExecutor(d).execute(plan.id, 'bob')
    expect(existsSync(media)).toBe(false)
    expect(summary.bytesFreed).toBe(100)
  })

  it('treats an already-deleted file as done without touching anything else', async () => {
    const d = deps()
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    unlinkSync(media)
    const summary = await createExecutor(d).execute(plan.id, 'bob')
    expect(summary.done).toBe(1)
    expect(summary.bytesFreed).toBe(0)
  })
})

describe('execute — merged jellyfin versions', () => {
  let alt: string

  beforeEach(() => {
    alt = join(root, 'Heat-remux.mkv')
    writeFileSync(alt, 'r'.repeat(80))
    item('i1', media)
    itemPath('i1', '/media/Heat.mkv', media)
    itemPath('i1', '/media/Heat-remux.mkv', alt)
  })

  it('refreshes instead of deleting the item when the target is a merged alternate version', async () => {
    const d = deps()
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: alt }])
    await createExecutor(d).execute(plan.id, 'bob')
    expect(existsSync(alt)).toBe(false)
    expect(existsSync(media)).toBe(true) // the version the operator KEPT
    expect(calls).not.toContain('jf.delete:i1')
    expect(calls).toContain('jf.refresh')
  })

  it('refreshes instead of deleting the item when a sibling version survives on disk', async () => {
    const d = deps()
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    await createExecutor(d).execute(plan.id, 'bob')
    expect(existsSync(alt)).toBe(true)
    expect(calls).not.toContain('jf.delete:i1')
    expect(calls).toContain('jf.refresh')
  })

  it('deletes the item only when the path is primary and no sibling survives', async () => {
    unlinkSync(alt)
    const d = deps()
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    await createExecutor(d).execute(plan.id, 'bob')
    expect(calls).toContain('jf.delete:i1')
  })

  it('refreshes instead of deleting the item when the file was already gone before the plan ran', async () => {
    // `container_path` is a scan-time row. If the file vanished and Jellyfin repointed the item at
    // a different file since, DELETE /Items would delete a file this plan never guarded.
    unlinkSync(alt)
    unlinkSync(media)
    const d = deps()
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    await createExecutor(d).execute(plan.id, 'bob')
    expect(calls).not.toContain('jf.delete:i1')
  })

  it('keeps the byte accounting and still refreshes when the jellyfin item delete fails', async () => {
    unlinkSync(alt)
    const d = deps({
      jellyfin: {
        deleteItem: async () => { throw new Error('jellyfin 500') },
        mergeVersions: async () => {},
        splitVersions: async () => {},
        refreshLibrary: async () => { calls.push('jf.refresh') },
        getItem: async (id: string) => ({ id, mediaSourcePaths: jellyfinSources[id] ?? [] }),
      },
    })
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    const summary = await createExecutor(d).execute(plan.id, 'bob')
    expect(existsSync(media)).toBe(false)
    expect(summary.bytesFreed).toBe(100)
    expect(summary.failed).toBe(1)
    expect(calls).toContain('jf.refresh')
  })

  it('never deletes an item a merge in this plan touched, even when the merge ran before a crash', async () => {
    unlinkSync(alt)
    const d = deps()
    const plan = await planFor(d, [
      { type: 'delete-media', targetPath: media },
      { type: 'merge-versions', itemIds: ['i1', 'i2'] },
    ])
    // The merge already ran in the interrupted attempt; the index is just as stale as if it had
    // run a moment ago, so this run must still refuse to delete the item.
    db.prepare("UPDATE plan_actions SET status='done' WHERE plan_id=? AND type='merge-versions'").run(plan.id)
    await createExecutor(d).execute(plan.id, 'bob')
    expect(existsSync(media)).toBe(false)
    expect(calls).not.toContain('jf.delete:i1')
    expect(calls).toContain('jf.refresh')
  })

  it('refuses the item delete when the LIVE item still reports another media source', async () => {
    // A merge performed outside Jellymaid since the last scan: the index still says "primary, no
    // siblings", but Jellyfin knows better, and deleting the item would take the version kept.
    unlinkSync(alt)
    db.prepare('DELETE FROM jellyfin_item_paths').run()
    jellyfinSources.i1 = ['/media/Heat.mkv', '/media/Heat-remux.mkv']
    const d = deps()
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    await createExecutor(d).execute(plan.id, 'bob')
    expect(existsSync(media)).toBe(false)
    expect(calls).not.toContain('jf.delete:i1')
    expect(calls).toContain('jf.refresh')
  })

  it('refuses the item delete when the live source is a different file than the one removed', async () => {
    unlinkSync(alt)
    db.prepare('DELETE FROM jellyfin_item_paths').run()
    jellyfinSources.i1 = ['/media/Somebody Else.mkv']
    const d = deps()
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    await createExecutor(d).execute(plan.id, 'bob')
    expect(calls).not.toContain('jf.delete:i1')
    expect(calls).toContain('jf.refresh')
  })

  it('refuses the item delete when the live check itself fails', async () => {
    unlinkSync(alt)
    db.prepare('DELETE FROM jellyfin_item_paths').run()
    const d = deps({
      jellyfin: {
        deleteItem: async (id: string) => { calls.push(`jf.delete:${id}`) },
        mergeVersions: async () => {},
        splitVersions: async () => {},
        refreshLibrary: async () => { calls.push('jf.refresh') },
        getItem: async () => { throw new Error('jellyfin 503') },
      },
    })
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    await createExecutor(d).execute(plan.id, 'bob')
    expect(calls).not.toContain('jf.delete:i1')
    expect(calls).toContain('jf.refresh')
  })

  it('never deletes an item this same plan just merged — the index snapshot is stale by then', async () => {
    unlinkSync(alt)
    const d = deps()
    const plan = await planFor(d, [
      { type: 'delete-media', targetPath: media },
      { type: 'merge-versions', itemIds: ['i1', 'i2'] },
    ])
    await createExecutor(d).execute(plan.id, 'bob')
    expect(calls).toContain('jf.merge:i1,i2')
    expect(calls).not.toContain('jf.delete:i1')
    expect(calls).toContain('jf.refresh')
  })
})

describe('execute — bookkeeping', () => {
  it('writes an audit row per action, carrying the actor, the guard verdicts and the outcome', async () => {
    const d = deps()
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    await createExecutor(d).execute(plan.id, 'bob')
    const rows = db.prepare("SELECT actor, action_type, outcome, before_json, plan_id FROM audit WHERE action_type='delete-media'")
      .all() as Array<{ actor: string; outcome: string; before_json: string; plan_id: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0]!.actor).toBe('bob')
    expect(rows[0]!.outcome).toBe('done')
    expect(rows[0]!.plan_id).toBe(plan.id)
    const before = JSON.parse(rows[0]!.before_json) as { guardVerdicts: Array<{ guard: string }> }
    expect(before.guardVerdicts.map((v) => v.guard)).toContain('guard.protected')
  })

  it('records a blocked action with the guard that blocked it', async () => {
    let state = 'stalledUP'
    const d = deps({ qbittorrent: qbit({ torrents: async () => [torrent({ state })] }) })
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    state = 'downloading'
    await createExecutor(d).execute(plan.id, 'bob')
    const row = db.prepare('SELECT status, error FROM plan_actions WHERE plan_id=?').get(plan.id) as
      { status: string; error: string }
    expect(row.status).toBe('blocked')
    expect(row.error).toContain('guard.protected')
  })

  it('marks the plan completed, or failed when any action failed', async () => {
    const d = deps({ qbittorrent: qbit({ torrents: async () => [torrent()], deleteWithData: async () => {}, awaitGone: async () => false }) })
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    const summary = await createExecutor(d).execute(plan.id, 'bob')
    expect(summary.status).toBe('failed')
    expect((db.prepare('SELECT status FROM plans WHERE id=?').get(plan.id) as { status: string }).status).toBe('failed')
  })

  it('refuses to execute a plan that was never approved', async () => {
    const d = deps()
    const plan = await buildPlan(d as never, { createdBy: 'bob', actions: [{ type: 'delete-media', targetPath: media }] })
    await expect(createExecutor(d).execute(plan.id, 'bob')).rejects.toThrow(/not approved/i)
    expect(existsSync(media)).toBe(true)
  })

  it('refuses to execute a plan that does not exist', async () => {
    await expect(createExecutor(deps()).execute('nope', 'bob')).rejects.toThrow(/does not exist/i)
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

  it('refuses to start while another plan is still marked running in the database', async () => {
    const d = deps()
    const stuck = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    db.prepare("UPDATE plans SET status='running' WHERE id=?").run(stuck.id)
    const other = join(root, 'Other.mkv')
    writeFileSync(other, 'y')
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: other }])
    await expect(createExecutor(d).execute(plan.id, 'bob')).rejects.toThrow(/already running/i)
    expect(existsSync(other)).toBe(true)
  })

  it('releases the mutex after a rejected execution, so the executor cannot wedge', async () => {
    const d = deps()
    const draft = await buildPlan(d as never, { createdBy: 'bob', actions: [{ type: 'delete-media', targetPath: media }] })
    const exec = createExecutor(d)
    await expect(exec.execute(draft.id, 'bob')).rejects.toThrow(/not approved/i)
    expect(exec.isRunning()).toBe(false)
    approvePlan(db, draft.id, 'bob')
    expect((await exec.execute(draft.id, 'bob')).done).toBe(1)
    expect(exec.isRunning()).toBe(false)
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
    await createExecutor(d).execute(plan.id, 'bob')
    expect(inventories).toBe(1)
  })

  it('still re-reads the torrent list per action — torrent state is what the guards most need fresh', async () => {
    const other = join(root, 'Other.mkv')
    writeFileSync(other, 'y')
    const d = deps()
    const plan = await planFor(d, [
      { type: 'delete-media', targetPath: media }, { type: 'delete-media', targetPath: other },
    ])
    calls = []
    await createExecutor(d).execute(plan.id, 'bob')
    expect(calls.filter((c) => c === 'qbit.torrents')).toHaveLength(2)
  })

  it('does not credit qBittorrent — or the item delete — for a file that vanished before the plan ran', async () => {
    item('i1', media)
    const d = deps()
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    unlinkSync(media)
    const summary = await createExecutor(d).execute(plan.id, 'bob')
    expect(summary.bytesFreed).toBe(0)
    expect(calls).not.toContain('jf.delete:i1')
  })

  it('does not credit qBittorrent for a file that vanished while the guards were still running', async () => {
    // The file is stat'd by resolveTarget and then disappears during its own service calls — long
    // before qBittorrent is asked to do anything. Attributing that to qBittorrent claims bytes
    // nothing here freed and unlocks the item delete on a row that is now stale.
    item('i1', media)
    const d = deps({
      qbittorrent: qbit({ torrents: async () => { if (existsSync(media)) unlinkSync(media); return [] } }),
    })
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    const summary = await createExecutor(d).execute(plan.id, 'bob')
    expect(summary.bytesFreed).toBe(0)
    expect(calls).not.toContain('jf.delete:i1')
  })

  it('hands the database claim back after a transient failure inside the executor', async () => {
    const d = deps()
    const plan = await planFor(d, [{ type: 'delete-media', targetPath: media }])
    db.exec('DROP TABLE audit') // a transient database fault, not a process death
    await expect(createExecutor(d).execute(plan.id, 'bob')).rejects.toThrow()
    expect((db.prepare('SELECT status FROM plans WHERE id=?').get(plan.id) as { status: string }).status).toBe('approved')
    expect((db.prepare('SELECT status FROM plan_actions WHERE plan_id=?').get(plan.id) as { status: string }).status).toBe('pending')
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
    const summary = await createExecutor(d).execute(plan.id, 'bob')
    expect(summary.done).toBe(1)
    expect(existsSync(media)).toBe(true)
    expect(existsSync(other)).toBe(false)
  })
})
