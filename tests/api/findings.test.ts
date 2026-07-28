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

describe('GET /api/findings/summary — what the numbers are based on', () => {
  const scan = (id: number, status: string, finishedAt: string | null = 'F') =>
    db.prepare('INSERT INTO scans (id, started_at, finished_at, status) VALUES (?,?,?,?)').run(id, 'T', finishedAt, status)
  const ruleRun = (scanId: number, ruleId: string, status = 'not-evaluated', reason: string | null = 'r') =>
    db.prepare('INSERT INTO rule_runs (scan_id, rule_id, status, reason, found) VALUES (?,?,?,?,0)')
      .run(scanId, ruleId, status, reason)
  const summary = async () =>
    (await build().inject({ method: 'GET', url: '/api/findings/summary', headers: auth() })).json()

  it('reports the scan the findings actually came from, and surfaces a newer failed attempt that never reached the rules phase', async () => {
    scan(41, 'completed', 'F41')
    ruleRun(41, 'dupe.identical-file', 'not-evaluated', 'hashes disabled')
    scan(42, 'failed', 'F42')

    const body = await summary()
    expect(body.evaluated).toBe(true)
    expect(body.basedOn).toMatchObject({ scanId: 41, status: 'completed', finishedAt: 'F41' })
    expect(body.latestAttempt).toMatchObject({ scanId: 42, status: 'failed' })
    // The not-evaluated list must come from scan 41, not be empty because 42 died first.
    expect(body.notEvaluated).toEqual([{ ruleId: 'dupe.identical-file', reason: 'hashes disabled' }])
  })

  it('says so explicitly when no scan has ever reached the rules phase, instead of an empty clean-looking summary', async () => {
    insertFinding({ id: 'a', class: 'filesystem', reclaimable_bytes: 100 })
    scan(1, 'failed', null)

    const body = await summary()
    expect(body.evaluated).toBe(false)
    expect(body.basedOn).toBeNull()
    expect(body.latestAttempt).toMatchObject({ scanId: 1, status: 'failed' })
  })

  it('reports no newer attempt when the latest scan is itself the one that ran the rules', async () => {
    scan(9, 'completed', 'F9')
    ruleRun(9, 'fs.junk', 'evaluated', null)

    const body = await summary()
    expect(body.basedOn).toMatchObject({ scanId: 9, status: 'completed' })
    expect(body.latestAttempt).toBeNull()
  })

  it('reports evaluated:false and no attempt at all on a database that has never scanned', async () => {
    const body = await summary()
    expect(body.evaluated).toBe(false)
    expect(body.basedOn).toBeNull()
    expect(body.latestAttempt).toBeNull()
    expect(body.notEvaluated).toEqual([])
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

  // Finding 6a: `exact` does not mean byte-verified — dupe.provider-id and dupe.series-episode
  // both emit 'exact' from pure metadata, and dupe.identical-file's 'exact' rests on a HEAD+TAIL
  // sampled hash, not the whole file. The Duplicates screen needs to show WHICH matcher(s) agreed,
  // not just the tier. That list is only ever persisted in the finding's evidence_json
  // (dupe.group's `matchedBy`, src/rules/dupes/adapter.ts), joinable on evidence.groupId ===
  // dupe_groups.id — dupe_groups itself never stored it.
  it('carries matchedBy, joined from the dupe.group finding that produced this group', async () => {
    db.prepare(`INSERT INTO dupe_groups (id, tier, members_json, keeper_item_id, scores_json, status)
      VALUES ('g1','exact','["a","b"]','b','{}','open')`).run()
    for (const id of ['a', 'b']) {
      db.prepare(`INSERT INTO jellyfin_items (id, scan_id, type, name, container_path, size_bytes, height, has_primary_image)
        VALUES (?,1,'Movie','Heat','/mnt/m/' || ? || '.mkv', 100, 1080, 1)`).run(id, id)
    }
    db.prepare(`INSERT INTO findings (id, rule_id, class, severity, confidence, subjects_json,
      evidence_json, reclaimable_bytes, status, first_seen, last_seen)
      VALUES ('finding-g1','dupe.group','duplicate','warning','exact','[]',?,0,'open','T','T')`)
      .run(JSON.stringify({
        groupId: 'g1', keeperId: 'b', scores: {},
        matchedBy: ['dupe.provider-id', 'dupe.series-episode'], links: [], crossLibrary: false,
      }))

    const body = (await build().inject({ method: 'GET', url: '/api/duplicates', headers: auth() })).json()
    expect(body.groups[0].matchedBy).toEqual(['dupe.provider-id', 'dupe.series-episode'])
  })

  it('reports an empty matchedBy, rather than throwing, for a group with no corresponding finding', async () => {
    db.prepare(`INSERT INTO dupe_groups (id, tier, members_json, keeper_item_id, scores_json, status)
      VALUES ('g2','exact','["a","b"]','b','{}','open')`).run()
    for (const id of ['a', 'b']) {
      db.prepare(`INSERT INTO jellyfin_items (id, scan_id, type, name, container_path, size_bytes, height, has_primary_image)
        VALUES (?,1,'Movie','Heat','/mnt/m/' || ? || '.mkv', 100, 1080, 1)`).run(id, id)
    }
    const body = (await build().inject({ method: 'GET', url: '/api/duplicates', headers: auth() })).json()
    expect(body.groups[0].matchedBy).toEqual([])
  })

  it('does not confuse a dismissed dupe.group finding for a currently-open one when joining matchedBy', async () => {
    // A finding that was dismissed (or belongs to a different, unrelated groupId) must not leak
    // its matchedBy onto this group.
    db.prepare(`INSERT INTO dupe_groups (id, tier, members_json, keeper_item_id, scores_json, status)
      VALUES ('g4','exact','["a","b"]','b','{}','open')`).run()
    for (const id of ['a', 'b']) {
      db.prepare(`INSERT INTO jellyfin_items (id, scan_id, type, name, container_path, size_bytes, height, has_primary_image)
        VALUES (?,1,'Movie','Heat','/mnt/m/' || ? || '.mkv', 100, 1080, 1)`).run(id, id)
    }
    db.prepare(`INSERT INTO findings (id, rule_id, class, severity, confidence, subjects_json,
      evidence_json, reclaimable_bytes, status, first_seen, last_seen)
      VALUES ('finding-g4-stale','dupe.group','duplicate','warning','exact','[]',?,0,'dismissed','T','T')`)
      .run(JSON.stringify({ groupId: 'g4', keeperId: 'b', scores: {}, matchedBy: ['dupe.provider-id'], links: [], crossLibrary: false }))

    const body = (await build().inject({ method: 'GET', url: '/api/duplicates', headers: auth() })).json()
    expect(body.groups[0].matchedBy).toEqual([])
  })

  // Finding 6b: the keeper score shows e.g. "HDR 300 vs 0" with nothing to corroborate it.
  // video_range and has_subtitles already live on jellyfin_items (004_item_quality_signals.sql) —
  // the same table this route already SELECTs members from — so exposing them is two column names,
  // no join.
  it('carries the video_range and has_subtitles facts behind each member\'s keeper score', async () => {
    db.prepare(`INSERT INTO dupe_groups (id, tier, members_json, keeper_item_id, scores_json, status)
      VALUES ('g3','exact','["a","b"]','b','{}','open')`).run()
    db.prepare(`INSERT INTO jellyfin_items (id, scan_id, type, name, container_path, size_bytes, height,
      has_primary_image, video_range, has_subtitles)
      VALUES ('a',1,'Movie','Heat','/mnt/m/a.mkv', 100, 1080, 1, 'SDR', 0)`).run()
    db.prepare(`INSERT INTO jellyfin_items (id, scan_id, type, name, container_path, size_bytes, height,
      has_primary_image, video_range, has_subtitles)
      VALUES ('b',1,'Movie','Heat','/mnt/m/b.mkv', 100, 2160, 1, 'HDR10', 1)`).run()

    const body = (await build().inject({ method: 'GET', url: '/api/duplicates', headers: auth() })).json()
    const a = body.groups[0].members.find((m: { id: string }) => m.id === 'a')
    const b = body.groups[0].members.find((m: { id: string }) => m.id === 'b')
    expect(a.video_range).toBe('SDR')
    expect(a.has_subtitles).toBe(0)
    expect(b.video_range).toBe('HDR10')
    expect(b.has_subtitles).toBe(1)
  })

  it('reports video_range as null, not a guessed value, for an item this Jellyfin never reported it for', async () => {
    db.prepare(`INSERT INTO dupe_groups (id, tier, members_json, keeper_item_id, scores_json, status)
      VALUES ('g5','exact','["a","b"]','b','{}','open')`).run()
    for (const id of ['a', 'b']) {
      db.prepare(`INSERT INTO jellyfin_items (id, scan_id, type, name, container_path, size_bytes, height, has_primary_image)
        VALUES (?,1,'Movie','Heat','/mnt/m/' || ? || '.mkv', 100, 1080, 1)`).run(id, id)
    }
    const body = (await build().inject({ method: 'GET', url: '/api/duplicates', headers: auth() })).json()
    const a = body.groups[0].members.find((m: { id: string }) => m.id === 'a')
    expect(a.video_range).toBeNull()
    expect(a.has_subtitles).toBe(0)
  })
})
