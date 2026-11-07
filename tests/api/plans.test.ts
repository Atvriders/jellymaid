import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../src/index/db.js'
import { registerPlanRoutes } from '../../src/api/plans.js'
import { signSession } from '../../src/auth/session.js'
import { createPathMap } from '../../src/fs/pathmap.js'
import { fileConfigSchema } from '../../src/config/schema.js'
import { moveToTrash } from '../../src/plan/trash.js'
import { createExecutor } from '../../src/plan/executor.js'
import { createActivityLock, type ActivityLock } from '../../src/core/activity.js'
import { writeVerification } from '../../src/scan/verification.js'
import { configStoreOf, verifyMappings } from '../plan/support.js'

const SECRET = 'p'.repeat(32)
// isAdministrator: true is required — requireSession (src/api/auth.ts) rejects any session that
// does not carry it, matching every other route's auth() helper (see tests/api/scan.test.ts).
const auth = () => ({ cookie: `jellymaid_session=${signSession({ username: 'bob', userId: 'u', issuedAt: Date.now(), isAdministrator: true }, SECRET)}` })

let db: Db
let dir: string
let root: string
let media: string
/** One lock for the whole app, as index.ts wires it: the planner, the executor and the scan runner share it. */
let activity: ActivityLock
/** The library root's Jellyfin prefix as configured right now; a test edits it to change the mapping set. */
let jellyfinPrefix: string

interface BuildOpts {
  jellyfin?: { mergeVersions(ids: string[]): Promise<void> }
  radarr?: unknown
}

/** A plain library root, no torrent client writing to it, read live like the real store. */
const store = () => configStoreOf(
  () => fileConfigSchema.parse({}),
  () => createPathMap([{ role: 'library', jellyfin: jellyfinPrefix, container: root, qbit: null, qbitInstance: null }]),
)

/** The plan routes over a REAL planner and executor, sharing one database and one activity lock. */
function build(opts: BuildOpts = {}) {
  const app = Fastify()
  app.register(cookie)
  const configStore = store()
  verifyMappings(db, configStore)
  const shared = {
    db,
    configStore,
    qbittorrents: new Map([['box-a', { instanceId: 'box-a', torrents: async () => [] }]]),
    radarr: opts.radarr ?? null,
    sonarr: null,
    activity,
  }
  const executor = createExecutor({
    ...shared,
    jellyfin: { mergeVersions: async () => {}, splitVersions: async () => {}, notifyPathsDeleted: async () => {} },
  } as never)
  registerPlanRoutes(app, {
    db,
    sessionSecret: SECRET,
    plannerDeps: () => shared,
    executor,
    trashDeps: () => ({ db, config: fileConfigSchema.parse({}), pathMap: configStore.pathMap() }),
    jellyfin: opts.jellyfin ?? { mergeVersions: async () => {} },
  } as never)
  return Object.assign(app, { executor })
}

/** Builds and approves a plan deleting `paths`, through the routes. */
async function approvedPlan(app: ReturnType<typeof build>, ...paths: string[]) {
  const id = (await app.inject({
    method: 'POST', url: '/api/plans', headers: auth(),
    payload: { actions: paths.map((targetPath) => ({ type: 'delete-media', targetPath })) },
  })).json().id as string
  expect((await app.inject({ method: 'POST', url: `/api/plans/${id}/approve`, headers: auth() })).statusCode).toBe(200)
  return id
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jm-planapi-'))
  db = openDb(join(dir, 'db.sqlite'))
  root = join(dir, 'lib')
  mkdirSync(root, { recursive: true })
  media = join(root, 'Heat.mkv')
  writeFileSync(media, 'x')
  activity = createActivityLock()
  jellyfinPrefix = '/media'
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

  it('stale overrides are dropped into droppedOverrides instead of a 400', async () => {
    // `overrides` accepts any GUARD_IDS member for any action, and nothing here blocks — so this
    // override clears nothing now and would stand ready to clear whatever blocks at EXECUTE time,
    // against live state the operator never saw. The screen resubmits every override it holds on a
    // rebuild, so it is dropped and reported rather than failing the whole build.
    const res = await build().inject({
      method: 'POST', url: '/api/plans', headers: auth(),
      payload: { actions: [{ type: 'delete-media', targetPath: media, overrides: ['guard.torrent-scope'] }] },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().droppedOverrides).toEqual([{ seq: 0, guard: 'guard.torrent-scope' }])
    expect(res.json().actions[0].payload.overrides).toEqual([])
  })

  it('plan build refuses 412 on a stale or failing verification and 409 while a scan holds the lock', async () => {
    const app = build()
    const post = () => app.inject({
      method: 'POST', url: '/api/plans', headers: auth(),
      payload: { actions: [{ type: 'delete-media', targetPath: media }] },
    })

    // Verified, but for a mapping set that is no longer the one configured.
    writeVerification(db, { at: 'T', mappingsHash: 'an-older-set', jellyfin: { sampled: 1, resolved: 1, failures: [] }, qbit: [] })
    const stale = await post()
    expect(stale.statusCode).toBe(412)
    expect(stale.json()).toEqual({ error: 'verification', reason: expect.stringMatching(/changed since/) })

    // The configured set, but its last verification failed.
    writeVerification(db, {
      at: 'T', mappingsHash: store().mappingsHash(),
      jellyfin: { sampled: 2, resolved: 1, failures: [{ jellyfinPath: '/media/Ghost.mkv', reason: 'not found on disk' }] },
      qbit: [{ instanceId: 'box-a', sampled: 0, resolved: 0, failures: [] }],
    })
    const failing = await post()
    expect(failing.statusCode).toBe(412)
    expect(failing.json()).toEqual({ error: 'verification', reason: expect.stringMatching(/resolved 1 of 2/) })

    verifyMappings(db, store())
    activity.tryAcquire('scan', 'scan-3')
    const busy = await post()
    expect(busy.statusCode).toBe(409)
    expect(busy.json()).toEqual({ error: 'busy', reason: expect.stringMatching(/scan/) })
    // Nothing was persisted by any refusal: no half-built rows to approve later.
    expect((db.prepare('SELECT COUNT(*) c FROM plans').get() as { c: number }).c).toBe(0)

    activity.release('scan', 'scan-3')
    expect((await post()).statusCode).toBe(201)
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

  it('refuses to execute an unapproved plan, saying so in the error code', async () => {
    const app = build()
    const id = await draft(app)
    const res = await app.inject({ method: 'POST', url: `/api/plans/${id}/execute`, headers: auth() })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'not-approved', reason: expect.stringMatching(/not approved/) })
    expect(existsSync(media)).toBe(true)
  })

  it('execute route returns 202 and runs in the background; GET shows progress; a crash sets plans.error and status failed', async () => {
    // The first action's *arr read is held open, so the run can be watched mid-flight.
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let holding = false
    const app = build({
      radarr: {
        inventory: async () => { if (holding) await gate; return { records: [], complete: true } },
        unmonitorByPath: async () => ({ outcome: 'unmonitored', recordId: 1 }),
      },
    })
    const other = join(root, 'Other.mkv')
    writeFileSync(other, 'y')
    const id = await approvedPlan(app, media, other)

    holding = true
    const res = await app.inject({ method: 'POST', url: `/api/plans/${id}/execute`, headers: auth() })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ planId: id, status: 'running' })
    const during = (await app.inject({ method: 'GET', url: `/api/plans/${id}`, headers: auth() })).json()
    expect(during.status).toBe('running')
    expect(during.progress).toEqual({ total: 2, finished: 0 })

    release()
    await app.executor.idle()
    const after = (await app.inject({ method: 'GET', url: `/api/plans/${id}`, headers: auth() })).json()
    expect(after).toMatchObject({ status: 'completed', error: null, progress: { total: 2, finished: 2 } })
    expect(existsSync(media)).toBe(false)

    // A run that crashes after the 202 has nobody to answer: the plan itself must say so.
    holding = false
    const third = join(root, 'Third.mkv')
    writeFileSync(third, 'z')
    const crashing = await approvedPlan(app, third)
    db.exec('DROP TABLE audit')
    expect((await app.inject({ method: 'POST', url: `/api/plans/${crashing}/execute`, headers: auth() })).statusCode).toBe(202)
    await app.executor.idle()
    const crashed = (await app.inject({ method: 'GET', url: `/api/plans/${crashing}`, headers: auth() })).json()
    expect(crashed.status).toBe('failed')
    expect(crashed.error).toMatch(/audit/)
  })

  it('execute answers 409 busy while a scan holds the activity lock, and starts nothing', async () => {
    const app = build()
    const id = await approvedPlan(app, media)
    activity.tryAcquire('scan', 'scan-4')
    const res = await app.inject({ method: 'POST', url: `/api/plans/${id}/execute`, headers: auth() })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'busy', reason: expect.stringMatching(/scan-4/) })
    expect(existsSync(media)).toBe(true)
    expect((await app.inject({ method: 'GET', url: `/api/plans/${id}`, headers: auth() })).json().status).toBe('approved')
  })

  it('execute and resume refuse 412 when the mappings changed after approval and were never verified, claiming nothing', async () => {
    const app = build()
    const id = await approvedPlan(app, media)
    const status = async () => (await app.inject({ method: 'GET', url: `/api/plans/${id}`, headers: auth() })).json().status

    jellyfinPrefix = '/library' // edited after approval; nobody ran Verify
    const res = await app.inject({ method: 'POST', url: `/api/plans/${id}/execute`, headers: auth() })
    expect(res.statusCode).toBe(412)
    expect(res.json()).toEqual({ error: 'verification', reason: expect.stringMatching(/changed since/) })
    await app.executor.idle()
    expect(existsSync(media)).toBe(true)
    expect(activity.current()).toBeNull()
    expect(app.executor.isRunning()).toBe(false)
    expect(await status()).toBe('approved')

    // A crashed run is not finished under an unverified set either. The resume route hands the
    // wreckage back as approved before the executor refuses, as it does for a busy refusal, so the
    // plan is left executable once the mappings are verified.
    db.prepare("UPDATE plans SET status='running', started_at=? WHERE id=?").run(new Date(Date.now() - 60 * 60_000).toISOString(), id)
    const resumed = await app.inject({ method: 'POST', url: `/api/plans/${id}/resume`, headers: auth() })
    expect(resumed.statusCode).toBe(412)
    expect(resumed.json()).toEqual({ error: 'verification', reason: expect.stringMatching(/changed since/) })
    expect(existsSync(media)).toBe(true)
    expect(activity.current()).toBeNull()
    expect(await status()).toBe('approved')

    verifyMappings(db, store())
    expect((await app.inject({ method: 'POST', url: `/api/plans/${id}/execute`, headers: auth() })).statusCode).toBe(202)
    await app.executor.idle()
    expect(existsSync(media)).toBe(false)
  })

  it('404s an unknown plan', async () => {
    expect((await build().inject({ method: 'GET', url: '/api/plans/nope', headers: auth() })).statusCode).toBe(404)
    expect((await build().inject({ method: 'POST', url: '/api/plans/nope/execute', headers: auth() })).statusCode).toBe(404)
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

  async function runningPlan(app: ReturnType<typeof build>, startedAt: string | null) {
    const id = (await app.inject({
      method: 'POST', url: '/api/plans', headers: auth(),
      payload: { actions: [{ type: 'delete-media', targetPath: media }] },
    })).json().id as string
    await app.inject({ method: 'POST', url: `/api/plans/${id}/approve`, headers: auth() })
    db.prepare("UPDATE plans SET status='running', started_at=? WHERE id=?").run(startedAt, id)
    return id
  }

  // Finding 5: isRunning() only speaks for THIS process. A plan whose started_at is seconds old is
  // far more likely to be actively executing in another process than to be crash wreckage.
  it('refuses to resume a plan that started moments ago, saying why', async () => {
    const app = build()
    const id = await runningPlan(app, new Date().toISOString())
    const res = await app.inject({ method: 'POST', url: `/api/plans/${id}/resume`, headers: auth() })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/recent/i)
    expect(res.json().error).toMatch(/wait/i)
    // Refused, not half-recovered: the plan is still claimed for whoever is running it.
    expect((db.prepare('SELECT status FROM plans WHERE id=?').get(id) as { status: string }).status).toBe('running')
  })

  it('resumes a plan whose started_at is old enough to be a crash', async () => {
    const app = build()
    const id = await runningPlan(app, new Date(Date.now() - 60 * 60_000).toISOString())
    const res = await app.inject({ method: 'POST', url: `/api/plans/${id}/resume`, headers: auth() })
    expect(res.statusCode).toBe(200)
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

describe('POST /api/duplicates/:groupId/merge', () => {
  function seedGroup(status = 'open') {
    db.prepare(`INSERT INTO dupe_groups (id, tier, members_json, keeper_item_id, scores_json, status)
      VALUES ('g1','exact','["a","b"]','b','{}',?)`).run(status)
  }

  it('merges and writes an audit row naming the actor, the group and the merged ids', async () => {
    seedGroup()
    const res = await build().inject({ method: 'POST', url: '/api/duplicates/g1/merge', headers: auth() })
    expect(res.statusCode).toBe(200)
    expect(res.json().merged).toEqual(['a', 'b'])

    const row = db.prepare(
      "SELECT actor, action_type AS actionType, subject, outcome, after_json AS afterJson FROM audit WHERE action_type='merge-versions'",
    ).get() as { actor: string; actionType: string; subject: string; outcome: string; afterJson: string }
    expect(row.actor).toBe('bob')
    expect(row.subject).toBe('g1')
    expect(row.outcome).toBe('done')
    expect(JSON.parse(row.afterJson).mergedItemIds).toEqual(['a', 'b'])

    expect((db.prepare("SELECT status FROM dupe_groups WHERE id='g1'").get() as { status: string }).status).toBe('merged')
  })

  it('refuses to re-merge a group that was already merged, without touching Jellyfin again', async () => {
    seedGroup('merged')
    const app = build()
    const res = await app.inject({ method: 'POST', url: '/api/duplicates/g1/merge', headers: auth() })
    expect(res.statusCode).toBe(409)
    // No second audit row from a refused retry.
    expect((db.prepare("SELECT COUNT(*) c FROM audit WHERE action_type='merge-versions'").get() as { c: number }).c).toBe(0)
  })

  it('404s an unknown duplicate group', async () => {
    const res = await build().inject({ method: 'POST', url: '/api/duplicates/nope/merge', headers: auth() })
    expect(res.statusCode).toBe(404)
  })

  // Finding 4: the double-click the route's own comment names as the threat. Both requests are in
  // flight at once — the first is parked inside mergeVersions when the second arrives — so a status
  // check that is not atomic with the Jellyfin call lets both through and merges twice.
  it('merges once, not twice, when two requests race', async () => {
    seedGroup()
    let calls = 0
    const app = build({
      jellyfin: {
        mergeVersions: async () => {
          calls += 1
          await new Promise((resolve) => setTimeout(resolve, 20))
        },
      },
    })
    // Fired without awaiting between them, so the second enters the handler while the first is
    // still suspended in mergeVersions.
    const first = app.inject({ method: 'POST', url: '/api/duplicates/g1/merge', headers: auth() })
    const second = app.inject({ method: 'POST', url: '/api/duplicates/g1/merge', headers: auth() })
    const [a, b] = await Promise.all([first, second])

    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409])
    expect(calls).toBe(1)
    // Exactly one merge happened, so exactly one audit row may claim one.
    expect((db.prepare("SELECT COUNT(*) c FROM audit WHERE action_type='merge-versions'").get() as { c: number }).c).toBe(1)
    expect((db.prepare("SELECT status FROM dupe_groups WHERE id='g1'").get() as { status: string }).status).toBe('merged')
  })

  it('releases the claim when Jellyfin fails, so the group can still be merged later', async () => {
    seedGroup()
    const app = build({ jellyfin: { mergeVersions: async () => { throw new Error('jellyfin unreachable') } } })
    const res = await app.inject({ method: 'POST', url: '/api/duplicates/g1/merge', headers: auth() })
    expect(res.statusCode).toBe(500)
    // A transient Jellyfin outage must not wedge the group as permanently un-mergeable.
    expect((db.prepare("SELECT status FROM dupe_groups WHERE id='g1'").get() as { status: string }).status).toBe('open')
    expect((db.prepare("SELECT COUNT(*) c FROM audit WHERE action_type='merge-versions'").get() as { c: number }).c).toBe(0)

    // And the retry, against a healthy Jellyfin, goes through.
    const retry = await build().inject({ method: 'POST', url: '/api/duplicates/g1/merge', headers: auth() })
    expect(retry.statusCode).toBe(200)
  })
})

describe('POST /api/trash/:id/restore', () => {
  it('restores a trashed file back to its original path', async () => {
    const pathMap = createPathMap([{ role: 'library', jellyfin: '/media', container: root, qbit: null, qbitInstance: null }])
    const trashed = moveToTrash({ db, config: fileConfigSchema.parse({}), pathMap }, { path: media, planId: 'p1', sizeBytes: 1 })
    if (!trashed.trashed) throw new Error(`test setup failed: ${JSON.stringify(trashed)}`)
    expect(existsSync(media)).toBe(false)
    const id = (db.prepare('SELECT id FROM trash').get() as { id: string }).id

    const res = await build().inject({ method: 'POST', url: `/api/trash/${id}/restore`, headers: auth() })
    expect(res.statusCode).toBe(200)
    expect(res.json().restored).toBe(true)
    expect(existsSync(media)).toBe(true)
  })

  it('refuses to restore an unknown trash id', async () => {
    const res = await build().inject({ method: 'POST', url: '/api/trash/nope/restore', headers: auth() })
    expect(res.statusCode).toBe(409)
    expect(res.json().restored).toBe(false)
  })
})

describe('GET /api/trash', () => {
  it('requires a session', async () => {
    expect((await build().inject({ method: 'GET', url: '/api/trash' })).statusCode).toBe(401)
  })

  it('lists trash entries newest first, including ones already restored', async () => {
    const pathMap = createPathMap([{ role: 'library', jellyfin: '/media', container: root, qbit: null, qbitInstance: null }])
    const trashed = moveToTrash({ db, config: fileConfigSchema.parse({}), pathMap }, { path: media, planId: 'p1', sizeBytes: 1 })
    if (!trashed.trashed) throw new Error(`test setup failed: ${JSON.stringify(trashed)}`)
    const id = (db.prepare('SELECT id FROM trash').get() as { id: string }).id

    const res = await build().inject({ method: 'GET', url: '/api/trash', headers: auth() })
    expect(res.statusCode).toBe(200)
    const entry = res.json().entries[0]
    expect(entry.id).toBe(id)
    expect(entry.originalPath).toBe(media)
    expect(entry.sizeBytes).toBe(1)
    expect(entry.planId).toBe('p1')
    // Not yet restored — restoredAt must read as genuinely unknown, not coerced to some sentinel.
    expect(entry.restoredAt).toBeNull()

    await build().inject({ method: 'POST', url: `/api/trash/${id}/restore`, headers: auth() })
    const afterRestore = (await build().inject({ method: 'GET', url: '/api/trash', headers: auth() })).json().entries[0]
    // Still listed — a restored entry is not erased from the record, only no longer restorable.
    expect(afterRestore.id).toBe(id)
    expect(afterRestore.restoredAt).not.toBeNull()
  })

  // Finding 4: with no offset and a fixed LIMIT 200, anything past row 200 (and every slot an
  // already-restored row still occupies) was permanently unreachable — there was no way to page
  // past it and no way to filter restored rows out of the way.
  function seedTrash(pathMap: ReturnType<typeof createPathMap>, name: string, deletedAt: string, restored = false) {
    const path = join(root, `${name}.mkv`)
    writeFileSync(path, 'x')
    const result = moveToTrash({ db, config: fileConfigSchema.parse({}), pathMap }, { path, planId: 'p1', sizeBytes: 1 })
    if (!result.trashed) throw new Error(`test setup failed: ${JSON.stringify(result)}`)
    const id = (db.prepare('SELECT id FROM trash WHERE original_path = ?').get(path) as { id: string }).id
    // deleted_at is forced to a deterministic value rather than trusted to differ across two
    // `moveToTrash` calls a few milliseconds apart — the route orders by it, and this suite must
    // not depend on wall-clock granularity to get a stable order.
    db.prepare('UPDATE trash SET deleted_at = ? WHERE id = ?').run(deletedAt, id)
    if (restored) db.prepare('UPDATE trash SET restored_at = ? WHERE id = ?').run(deletedAt, id)
    return id
  }

  it('paginates with limit/offset and reports the total across the whole table, not just the page', async () => {
    const pathMap = createPathMap([{ role: 'library', jellyfin: '/media', container: root, qbit: null, qbitInstance: null }])
    seedTrash(pathMap, 'a', 'T1')
    seedTrash(pathMap, 'b', 'T2')
    seedTrash(pathMap, 'c', 'T3')

    const res = await build().inject({ method: 'GET', url: '/api/trash?limit=1&offset=1', headers: auth() })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.entries).toHaveLength(1)
    // Newest first (T3, T2, T1); offset 1 skips T3, so the one row returned is T2.
    expect(body.entries[0].originalPath).toBe(join(root, 'b.mkv'))
    expect(body.total).toBe(3)
  })

  it('rejects a malformed limit/offset with 400 rather than a raw datatype-mismatch 500', async () => {
    expect((await build().inject({ method: 'GET', url: '/api/trash?limit=0', headers: auth() })).statusCode).toBe(400)
    expect((await build().inject({ method: 'GET', url: '/api/trash?offset=-1', headers: auth() })).statusCode).toBe(400)
    expect((await build().inject({ method: 'GET', url: '/api/trash?limit=not-a-number', headers: auth() })).statusCode).toBe(400)
  })

  it('excludes already-restored entries when includeRestored=false, with a total reflecting the same filter', async () => {
    const pathMap = createPathMap([{ role: 'library', jellyfin: '/media', container: root, qbit: null, qbitInstance: null }])
    seedTrash(pathMap, 'a', 'T1', true)
    seedTrash(pathMap, 'b', 'T2', false)

    const res = await build().inject({ method: 'GET', url: '/api/trash?includeRestored=false', headers: auth() })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.entries).toHaveLength(1)
    expect(body.entries[0].originalPath).toBe(join(root, 'b.mkv'))
    expect(body.total).toBe(1)
  })

  it('still includes restored entries by default, unchanged from before pagination existed', async () => {
    const pathMap = createPathMap([{ role: 'library', jellyfin: '/media', container: root, qbit: null, qbitInstance: null }])
    seedTrash(pathMap, 'a', 'T1', true)
    seedTrash(pathMap, 'b', 'T2', false)

    const res = await build().inject({ method: 'GET', url: '/api/trash', headers: auth() })
    const body = res.json()
    expect(body.entries).toHaveLength(2)
    expect(body.total).toBe(2)
  })
})

describe('GET /api/config/thresholds', () => {
  it('is not a plan route any more — the settings routes serve it, and one app cannot register it twice', async () => {
    const res = await build().inject({ method: 'GET', url: '/api/config/thresholds', headers: auth() })
    expect(res.statusCode).toBe(404)
  })
})
