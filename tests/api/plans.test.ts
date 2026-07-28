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
// isAdministrator: true is required — requireSession (src/api/auth.ts) rejects any session that
// does not carry it, matching every other route's auth() helper (see tests/api/scan.test.ts).
const auth = () => ({ cookie: `jellymaid_session=${signSession({ username: 'bob', userId: 'u', issuedAt: Date.now(), isAdministrator: true }, SECRET)}` })

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
