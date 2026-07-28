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

const SECRET = 'p'.repeat(32)
// isAdministrator: true is required — requireSession (src/api/auth.ts) rejects any session that
// does not carry it, matching every other route's auth() helper (see tests/api/scan.test.ts).
const auth = () => ({ cookie: `jellymaid_session=${signSession({ username: 'bob', userId: 'u', issuedAt: Date.now(), isAdministrator: true }, SECRET)}` })

let db: Db
let dir: string
let root: string
let media: string

interface BuildOpts {
  jellyfin?: { mergeVersions(ids: string[]): Promise<void> }
  isRunning?: () => boolean
}

function build(opts: BuildOpts = {}) {
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
      isRunning: opts.isRunning ?? (() => false),
    },
    trashDeps: () => ({ db, config: fileConfigSchema.parse({}), pathMap: createPathMap([{ role: 'library', jellyfin: '/media', container: root, qbit: null }]) }),
    jellyfin: opts.jellyfin ?? { mergeVersions: async () => {} },
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

  it('rejects an override for a guard that does not block the action it names', async () => {
    // `overrides` accepts any GUARD_IDS member for any action, and nothing here blocks — so this
    // override clears nothing now and would stand ready to clear whatever blocks at EXECUTE time,
    // against live state the operator never saw. An operator cannot meaningfully pre-authorise a
    // block the plan never showed them, so the plan is refused rather than minted.
    const res = await build().inject({
      method: 'POST', url: '/api/plans', headers: auth(),
      payload: { actions: [{ type: 'delete-media', targetPath: media, overrides: ['guard.torrent-scope'] }] },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/guard\.torrent-scope/)
    // Nothing was persisted: a refused plan leaves no half-built rows to approve later.
    expect((db.prepare('SELECT COUNT(*) c FROM plans').get() as { c: number }).c).toBe(0)
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
    const pathMap = createPathMap([{ role: 'library', jellyfin: '/media', container: root, qbit: null }])
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
    const pathMap = createPathMap([{ role: 'library', jellyfin: '/media', container: root, qbit: null }])
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
})

describe('GET /api/config/thresholds', () => {
  it('requires a session', async () => {
    expect((await build().inject({ method: 'GET', url: '/api/config/thresholds' })).statusCode).toBe(401)
  })

  it('reports the guard and trash thresholds actually in force, never a value that could edit them', async () => {
    const res = await build().inject({ method: 'GET', url: '/api/config/thresholds', headers: auth() })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    const parsed = fileConfigSchema.parse({})
    expect(body).toEqual({
      minRatio: parsed.guards.minRatio,
      minSeedTimeDays: parsed.guards.minSeedTimeDays,
      protectedCategories: parsed.guards.protectedCategories,
      protectedTags: parsed.guards.protectedTags,
      trashMaxBytes: parsed.trash.maxBytes,
      trashRetentionDays: parsed.trash.retentionDays,
    })
  })
})
