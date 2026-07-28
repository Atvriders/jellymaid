import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../src/index/db.js'
import { registerFindingsRoutes } from '../../src/api/findings.js'
import { signSession } from '../../src/auth/session.js'

const SECRET = 'q'.repeat(32)
const auth = () => ({ cookie: `jellymaid_session=${signSession({ username: 'bob', userId: 'u', issuedAt: Date.now(), isAdministrator: true }, SECRET)}` })

let db: Db
function build() {
  const app = Fastify()
  app.register(cookie)
  registerFindingsRoutes(app, { db, sessionSecret: SECRET })
  return app
}

function insertFinding(over: Record<string, unknown> = {}) {
  const row = {
    id: 'f1', rule_id: 'fs.junk', class: 'filesystem', severity: 'warning', confidence: 'exact',
    subjects_json: '[]', evidence_json: '{}', reclaimable_bytes: 100, status: 'open',
    first_seen: 'T', last_seen: 'T', ...over,
  }
  db.prepare(`INSERT INTO findings (id, rule_id, class, severity, confidence, subjects_json,
    evidence_json, reclaimable_bytes, status, first_seen, last_seen)
    VALUES (@id,@rule_id,@class,@severity,@confidence,@subjects_json,@evidence_json,
            @reclaimable_bytes,@status,@first_seen,@last_seen)`).run(row)
}

beforeEach(() => { db = openDb(join(mkdtempSync(join(tmpdir(), 'jm-find-')), 'db.sqlite')) })

describe('GET /api/findings', () => {
  it('requires a session', async () => {
    expect((await build().inject({ method: 'GET', url: '/api/findings' })).statusCode).toBe(401)
  })

  it('returns open findings by default, excluding resolved and dismissed', async () => {
    insertFinding({ id: 'a' })
    insertFinding({ id: 'b', status: 'resolved' })
    insertFinding({ id: 'c', status: 'dismissed' })
    const res = await build().inject({ method: 'GET', url: '/api/findings', headers: auth() })
    expect(res.json().findings.map((f: { id: string }) => f.id)).toEqual(['a'])
  })

  it('filters by class', async () => {
    insertFinding({ id: 'a', class: 'filesystem' })
    insertFinding({ id: 'b', class: 'duplicate', rule_id: 'dupe.group' })
    const res = await build().inject({ method: 'GET', url: '/api/findings?class=duplicate', headers: auth() })
    expect(res.json().findings.map((f: { id: string }) => f.id)).toEqual(['b'])
  })

  it('parses subjects and evidence back into objects', async () => {
    insertFinding({ subjects_json: '[{"kind":"path","path":"/x","label":"/x"}]', evidence_json: '{"reason":"sample file"}' })
    const f = (await build().inject({ method: 'GET', url: '/api/findings', headers: auth() })).json().findings[0]
    expect(f.subjects[0].path).toBe('/x')
    expect(f.evidence.reason).toBe('sample file')
  })

  it('paginates and reports the total', async () => {
    for (let i = 0; i < 5; i += 1) insertFinding({ id: `f${i}` })
    const res = await build().inject({ method: 'GET', url: '/api/findings?limit=2&offset=1', headers: auth() })
    expect(res.json().findings).toHaveLength(2)
    expect(res.json().total).toBe(5)
  })
})

describe('POST /api/findings/:id/dismiss', () => {
  it('requires a reason', async () => {
    insertFinding()
    const res = await build().inject({ method: 'POST', url: '/api/findings/f1/dismiss', headers: auth(), payload: {} })
    expect(res.statusCode).toBe(400)
  })

  it('dismisses with a reason and records who did it', async () => {
    insertFinding()
    const res = await build().inject({
      method: 'POST', url: '/api/findings/f1/dismiss', headers: auth(),
      payload: { reason: 'different cuts' },
    })
    expect(res.statusCode).toBe(200)
    const row = db.prepare('SELECT status, dismissed_reason, dismissed_by FROM findings WHERE id = ?').get('f1')
    expect(row).toMatchObject({ status: 'dismissed', dismissed_reason: 'different cuts', dismissed_by: 'bob' })
  })

  it('404s for an unknown finding', async () => {
    const res = await build().inject({
      method: 'POST', url: '/api/findings/nope/dismiss', headers: auth(), payload: { reason: 'x' },
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('GET /api/findings/summary', () => {
  it('counts by class and sums reclaimable bytes, and lists rules that were not evaluated', async () => {
    insertFinding({ id: 'a', class: 'filesystem', reclaimable_bytes: 100 })
    insertFinding({ id: 'b', class: 'filesystem', reclaimable_bytes: 50 })
    db.prepare("INSERT INTO scans (id, started_at, status) VALUES (7,'T','completed')").run()
    db.prepare("INSERT INTO rule_runs (scan_id, rule_id, status, reason, found) VALUES (7,'dupe.identical-file','not-evaluated','hashes disabled',0)").run()
    const body = (await build().inject({ method: 'GET', url: '/api/findings/summary', headers: auth() })).json()
    expect(body.byClass.filesystem).toBe(2)
    expect(body.reclaimableBytes).toBe(150)
    expect(body.notEvaluated).toEqual([{ ruleId: 'dupe.identical-file', reason: 'hashes disabled' }])
  })
})

describe('GET /api/duplicates', () => {
  it('returns groups with their members, tier and keeper', async () => {
    db.prepare(`INSERT INTO dupe_groups (id, tier, members_json, keeper_item_id, scores_json, status)
      VALUES ('g1','exact','["a","b"]','b','{"a":{"total":1},"b":{"total":2}}','open')`).run()
    for (const id of ['a', 'b']) {
      db.prepare(`INSERT INTO jellyfin_items (id, scan_id, type, name, container_path, size_bytes, height, has_primary_image)
        VALUES (?,1,'Movie','Heat','/mnt/m/' || ? || '.mkv', 100, 1080, 1)`).run(id, id)
    }
    const body = (await build().inject({ method: 'GET', url: '/api/duplicates', headers: auth() })).json()
    expect(body.groups[0].tier).toBe('exact')
    expect(body.groups[0].keeperItemId).toBe('b')
    expect(body.groups[0].members).toHaveLength(2)
    expect(body.groups[0].members[0]).toHaveProperty('name')
  })
})
