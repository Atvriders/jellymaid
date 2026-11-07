import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../src/index/db.js'
import { registerFindingsRoutes } from '../../src/api/findings.js'
import { signSession } from '../../src/auth/session.js'
import { createPathMap } from '../../src/fs/pathmap.js'
import { fileConfigSchema, type FileConfig } from '../../src/config/schema.js'
import type { PathMapping } from '../../src/core/types.js'

const SECRET = 'q'.repeat(32)
const auth = () => ({ cookie: `jellymaid_session=${signSession({ username: 'bob', userId: 'u', issuedAt: Date.now(), isAdministrator: true }, SECRET)}` })

/**
 * Two boxes that each call their library `/movies` (the owner's real setup), plus a library root
 * that is explicitly not torrent-backed. The container paths differ even though the qBittorrent
 * spellings do not.
 */
const MAPPINGS: PathMapping[] = [
  { role: 'library', jellyfin: '/media/a', container: '/mnt/a', qbit: '/movies', qbitInstance: 'box-a' },
  { role: 'library', jellyfin: '/media/b', container: '/mnt/b', qbit: '/movies', qbitInstance: 'box-b' },
  { role: 'library', jellyfin: '/media/local', container: '/mnt/local', qbit: null, qbitInstance: null },
]

let db: Db
/** What the routes see through the live store; a test reassigns it to "edit config.json". */
let config: FileConfig
function build() {
  const app = Fastify()
  app.register(cookie)
  registerFindingsRoutes(app, {
    db, sessionSecret: SECRET,
    configStore: { file: () => config, pathMap: () => createPathMap(MAPPINGS) },
  })
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

beforeEach(() => {
  db = openDb(join(mkdtempSync(join(tmpdir(), 'jm-find-')), 'db.sqlite'))
  config = fileConfigSchema.parse({})
})

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

  it('does not lend one group another group\'s matchedBy', async () => {
    db.prepare(`INSERT INTO dupe_groups (id, tier, members_json, keeper_item_id, scores_json, status)
      VALUES ('g4','exact','["a","b"]','b','{}','open')`).run()
    for (const id of ['a', 'b']) {
      db.prepare(`INSERT INTO jellyfin_items (id, scan_id, type, name, container_path, size_bytes, height, has_primary_image)
        VALUES (?,1,'Movie','Heat','/mnt/m/' || ? || '.mkv', 100, 1080, 1)`).run(id, id)
    }
    db.prepare(`INSERT INTO findings (id, rule_id, class, severity, confidence, subjects_json,
      evidence_json, reclaimable_bytes, status, first_seen, last_seen)
      VALUES ('finding-g5','dupe.group','duplicate','warning','exact','[]',?,0,'open','T','T')`)
      .run(JSON.stringify({ groupId: 'g5', keeperId: 'b', scores: {}, matchedBy: ['dupe.provider-id'], links: [], crossLibrary: false }))

    const body = (await build().inject({ method: 'GET', url: '/api/duplicates', headers: auth() })).json()
    expect(body.groups[0].matchedBy).toEqual([])
  })

  it('reads a group\'s evidence whatever its finding\'s status: every rescan rewrites it, dismissed or not (final review I2)', async () => {
    // A finding resolved by the last scan while its group row is still listed (nothing else writes
    // that combination, but the read model must not turn "not open" into "nothing known").
    db.prepare(`INSERT INTO dupe_groups (id, tier, members_json, keeper_item_id, scores_json, status)
      VALUES ('g4','exact','["a","b"]','b','{}','open')`).run()
    for (const id of ['a', 'b']) {
      db.prepare(`INSERT INTO jellyfin_items (id, scan_id, type, name, container_path, size_bytes, height, has_primary_image)
        VALUES (?,1,'Movie','Heat','/mnt/m/' || ? || '.mkv', 100, 1080, 1)`).run(id, id)
    }
    db.prepare(`INSERT INTO findings (id, rule_id, class, severity, confidence, subjects_json,
      evidence_json, reclaimable_bytes, status, first_seen, last_seen)
      VALUES ('finding-g4','dupe.group','duplicate','warning','exact','[]',?,0,'resolved','T','T')`)
      .run(JSON.stringify({ groupId: 'g4', keeperId: 'b', scores: {}, matchedBy: ['dupe.provider-id'], links: [], crossLibrary: false, editionsDiffer: true }))

    const body = (await build().inject({ method: 'GET', url: '/api/duplicates', headers: auth() })).json()
    expect(body.groups[0]).toMatchObject({ matchedBy: ['dupe.provider-id'], editionsDiffer: true })
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
    expect(a.videoRange).toBe('SDR')
    expect(a.hasSubtitles).toBe(false)
    expect(b.videoRange).toBe('HDR10')
    expect(b.hasSubtitles).toBe(true)
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
    expect(a.videoRange).toBeNull()
    expect(a.hasSubtitles).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------
// GET /api/duplicates — the C12 read model
// ---------------------------------------------------------------------------------------------

const DAY = 86_400
const HASH_A = 'a'.repeat(40)
const HASH_B = 'b'.repeat(40)
const HASH_C = 'c'.repeat(40)

interface SeedItem {
  id: string; type?: string; name?: string; year?: number | null
  series_name?: string | null; season_no?: number | null; episode_no?: number | null
  container_path?: string | null; size_bytes?: number | null
  width?: number | null; height?: number | null; bitrate?: number | null
  video_codec?: string | null; audio_channels?: number | null; container?: string | null
  library_name?: string | null; video_range?: string | null; has_subtitles?: number
}

function seedItem(item: SeedItem) {
  db.prepare(`INSERT INTO jellyfin_items (id, scan_id, type, name, year, series_name, season_no, episode_no,
    container_path, size_bytes, width, height, bitrate, video_codec, audio_channels, container, library_name,
    video_range, has_subtitles, has_primary_image)
    VALUES (@id, 1, @type, @name, @year, @series_name, @season_no, @episode_no,
    @container_path, @size_bytes, @width, @height, @bitrate, @video_codec, @audio_channels, @container, @library_name,
    @video_range, @has_subtitles, 1)`).run({
    type: 'Movie', name: 'Heat', year: 1995, series_name: null, season_no: null, episode_no: null,
    container_path: `/mnt/local/${item.id}.mkv`, size_bytes: 100, width: 1920, height: 1080, bitrate: 8_000_000,
    video_codec: 'h264', audio_channels: 6, container: 'mkv', library_name: 'Movies',
    video_range: null, has_subtitles: 0, ...item,
  })
}

function seedGroup(g: {
  id: string; members: string[]; keeper?: string | null; tier?: string
  scores?: Record<string, unknown>; status?: string
}) {
  db.prepare(`INSERT INTO dupe_groups (id, tier, members_json, keeper_item_id, scores_json, status)
    VALUES (?,?,?,?,?,?)`).run(
    g.id, g.tier ?? 'exact', JSON.stringify(g.members), g.keeper === undefined ? g.members[0]! : g.keeper,
    JSON.stringify(g.scores ?? {}), g.status ?? 'open',
  )
}

/** The `dupe.group` finding that goes with a group; `evidence` is merged over what Task 6's rule writes. */
function seedDupeFinding(groupId: string, evidence: Record<string, unknown> = {}, status = 'open') {
  db.prepare(`INSERT INTO findings (id, rule_id, class, severity, confidence, subjects_json,
    evidence_json, reclaimable_bytes, status, first_seen, last_seen)
    VALUES (?, 'dupe.group', 'duplicate', 'warning', 'exact', '[]', ?, 0, ?, 'T', 'T')`)
    .run(`finding-${groupId}`, JSON.stringify({ groupId, keeperId: 'x', scores: {}, matchedBy: [], links: [], crossLibrary: false, ...evidence }), status)
}

function seedTorrent(t: {
  instanceId: string; hash: string; name?: string; state?: string; ratio?: number; seedingTime?: number
  isPrivate?: boolean; trackerHost?: string | null; sizeBytes?: number
  files: Array<{ relPath: string; containerPath: string | null; sizeBytes?: number }>
}) {
  db.prepare(`INSERT INTO torrents (instance_id, hash, fetched_at, name, state, ratio, seeding_time, is_private,
    tracker_host, size_bytes, progress) VALUES (?,?,?,?,?,?,?,?,?,?,1)`).run(
    t.instanceId, t.hash, 'T', t.name ?? 'Heat.1995.1080p', t.state ?? 'stalledUP', t.ratio ?? 2, t.seedingTime ?? 30 * DAY,
    t.isPrivate ? 1 : 0, t.trackerHost ?? null, t.sizeBytes ?? 9000,
  )
  const insertFile = db.prepare(`INSERT INTO torrent_files (instance_id, hash, file_index, rel_path, container_path, size_bytes)
    VALUES (?,?,?,?,?,?)`)
  t.files.forEach((f, index) => insertFile.run(t.instanceId, t.hash, index, f.relPath, f.containerPath, f.sizeBytes ?? 100))
}

const deletePath = (containerPath: string) =>
  db.prepare("INSERT INTO deleted_paths (container_path, plan_id, deleted_at) VALUES (?, 'plan-1', 'T')").run(containerPath)

const seedScan = (id: number, status: string, finishedAt: string | null = `F${id}`) =>
  db.prepare('INSERT INTO scans (id, started_at, finished_at, status) VALUES (?,?,?,?)').run(id, 'T', finishedAt, status)
const seedRuleRun = (scanId: number, ruleId: string, status: string, reason: string | null = null) =>
  db.prepare('INSERT INTO rule_runs (scan_id, rule_id, status, reason, found) VALUES (?,?,?,?,0)').run(scanId, ruleId, status, reason)

const duplicates = async () => {
  const res = await build().inject({ method: 'GET', url: '/api/duplicates', headers: auth() })
  expect(res.statusCode).toBe(200)
  return res.json()
}
type MemberJson = Record<string, unknown> & { id: string }
type GroupJson = Record<string, unknown> & { id: string; members: MemberJson[] }
const group = (body: { groups: GroupJson[] }, id: string) => body.groups.find((g) => g.id === id)
const member = (g: GroupJson | undefined, id: string) => g!.members.find((m) => m.id === id)!

describe('GET /api/duplicates — instance and torrent facts', () => {
  it('requires a session', async () => {
    expect((await build().inject({ method: 'GET', url: '/api/duplicates' })).statusCode).toBe(401)
  })

  it('duplicates returns per-member instance and torrent facts with hnrMet under current thresholds', async () => {
    seedItem({ id: 'a', container_path: '/mnt/a/Heat (1995)/Heat.mkv' })
    seedItem({ id: 'b', container_path: '/mnt/b/Heat (1995)/Heat.mkv' })
    seedItem({ id: 'c', container_path: '/mnt/local/Heat (1995)/Heat.mkv' })
    seedGroup({ id: 'g1', members: ['a', 'b', 'c'], keeper: 'b' })
    // Box A: a private torrent that is 20 days old with ratio 0.5 — a release with an .nfo and a
    // sample next to the video, so only one of its three files is media.
    seedTorrent({
      instanceId: 'box-a', hash: HASH_A, name: 'Heat.1995.1080p', state: 'stalledUP', ratio: 0.5, seedingTime: 20 * DAY,
      isPrivate: true, trackerHost: 'tracker.example', sizeBytes: 9_000,
      files: [
        { relPath: 'Heat.1995.1080p/Heat.mkv', containerPath: '/mnt/a/Heat (1995)/Heat.mkv', sizeBytes: 8_000 },
        { relPath: 'Heat.1995.1080p/Heat.nfo', containerPath: '/mnt/a/Heat (1995)/Heat.nfo', sizeBytes: 1 },
        { relPath: 'Heat.1995.1080p/Sample/sample.mkv', containerPath: '/mnt/a/Heat (1995)/Sample/sample.mkv', sizeBytes: 999 },
      ],
    })
    // Box B: a public torrent that has barely seeded — H&R does not apply to it at all.
    seedTorrent({
      instanceId: 'box-b', hash: HASH_B, name: 'Heat.1995.2160p', ratio: 0.1, seedingTime: DAY, isPrivate: false,
      trackerHost: 'open.example', sizeBytes: 20_000,
      files: [{ relPath: 'Heat.1995.2160p.mkv', containerPath: '/mnt/b/Heat (1995)/Heat.mkv', sizeBytes: 20_000 }],
    })

    const a = member(group(await duplicates(), 'g1'), 'a')
    expect(a).toMatchObject({
      containerPath: '/mnt/a/Heat (1995)/Heat.mkv', instanceId: 'box-a', torrentCount: 1,
      torrent: {
        instanceId: 'box-a', hash: HASH_A, name: 'Heat.1995.1080p', state: 'stalledUP', ratio: 0.5, seedingDays: 20,
        isPrivate: true, trackerHost: 'tracker.example', sizeBytes: 9_000, fileCount: 3, mediaFileCount: 1,
        hnrMet: false, // ratio 0.5 is under the default minimum of 1
      },
    })
    expect(member(group(await duplicates(), 'g1'), 'b')).toMatchObject({
      instanceId: 'box-b', torrentCount: 1,
      torrent: { instanceId: 'box-b', hash: HASH_B, isPrivate: false, trackerHost: 'open.example', fileCount: 1, mediaFileCount: 1, hnrMet: true },
    })
    // A root that is explicitly not torrent-backed has no box and no torrent.
    expect(member(group(await duplicates(), 'g1'), 'c')).toMatchObject({ instanceId: null, torrent: null, torrentCount: 0 })

    // hnrMet follows the thresholds in force NOW, with no rescan: the same index rows, a new config.
    config = fileConfigSchema.parse({ guards: { minRatio: 0.4 } })
    expect((member(group(await duplicates(), 'g1'), 'a').torrent as { hnrMet: boolean }).hnrMet).toBe(true)
    config = fileConfigSchema.parse({ guards: { minRatio: 0.4, minSeedTimeDays: 30 } })
    expect((member(group(await duplicates(), 'g1'), 'a').torrent as { hnrMet: boolean }).hnrMet).toBe(false)
  })

  // hnrMet must say exactly what guard.private-ratio will say when the plan is built: both a ratio
  // AND a seed time must be met, and a value exactly at the minimum meets it.
  it('hnrMet needs both ratio and seed time on a private torrent, and is met exactly at the minimums', async () => {
    seedItem({ id: 'a', container_path: '/mnt/a/1.mkv' })
    seedItem({ id: 'b', container_path: '/mnt/a/2.mkv' })
    seedItem({ id: 'c', container_path: '/mnt/a/3.mkv' })
    seedItem({ id: 'd', container_path: '/mnt/a/4.mkv' })
    seedGroup({ id: 'g1', members: ['a', 'b', 'c', 'd'], keeper: 'a' })
    const priv = (hash: string, file: string, ratio: number, days: number) => seedTorrent({
      instanceId: 'box-a', hash, ratio, seedingTime: days * DAY, isPrivate: true, trackerHost: 'tracker.example',
      files: [{ relPath: file, containerPath: `/mnt/a/${file}` }],
    })
    priv(HASH_A, '1.mkv', 1, 14) // exactly at both minimums
    priv(HASH_B, '2.mkv', 5, 13.9) // ratio met, seed time short
    priv(HASH_C, '3.mkv', 0.99, 99) // seed time met, ratio short
    priv('d'.repeat(40), '4.mkv', 0, 0)

    const g = group(await duplicates(), 'g1')
    const met = (id: string) => (member(g, id).torrent as { hnrMet: boolean }).hnrMet
    expect([met('a'), met('b'), met('c'), met('d')]).toEqual([true, false, false, false])
  })

  it('counts every torrent that owns a file, and shows the first by instance and hash', async () => {
    seedItem({ id: 'a', container_path: '/mnt/a/Heat.mkv' })
    seedItem({ id: 'b', container_path: '/mnt/a/Heat 2.mkv' })
    seedGroup({ id: 'g1', members: ['a', 'b'] })
    // A cross-seed: two torrents on the same box pointing at the same bytes. Inserted in the
    // "wrong" order so the answer cannot just be insertion order.
    seedTorrent({ instanceId: 'box-a', hash: HASH_C, name: 'second', files: [{ relPath: 'Heat.mkv', containerPath: '/mnt/a/Heat.mkv' }] })
    seedTorrent({ instanceId: 'box-a', hash: HASH_A, name: 'first', files: [{ relPath: 'Heat.mkv', containerPath: '/mnt/a/Heat.mkv' }] })
    const a = member(group(await duplicates(), 'g1'), 'a')
    expect(a.torrentCount).toBe(2)
    expect((a.torrent as { name: string }).name).toBe('first')
    expect(member(group(await duplicates(), 'g1'), 'b')).toMatchObject({ torrent: null, torrentCount: 0 })
  })

  it('does not mix up the same infohash on two boxes', async () => {
    seedItem({ id: 'a', container_path: '/mnt/a/Heat.mkv' })
    seedItem({ id: 'b', container_path: '/mnt/b/Heat.mkv' })
    seedGroup({ id: 'g1', members: ['a', 'b'] })
    // The owner's two boxes really do share infohashes: one hash, two torrents, two sets of files.
    seedTorrent({ instanceId: 'box-a', hash: HASH_A, name: 'on box a', files: [{ relPath: 'Heat.mkv', containerPath: '/mnt/a/Heat.mkv' }, { relPath: 'Heat.nfo', containerPath: '/mnt/a/Heat.nfo' }] })
    seedTorrent({ instanceId: 'box-b', hash: HASH_A, name: 'on box b', files: [{ relPath: 'Heat.mkv', containerPath: '/mnt/b/Heat.mkv' }] })
    const g = group(await duplicates(), 'g1')
    expect(member(g, 'a').torrent).toMatchObject({ instanceId: 'box-a', name: 'on box a', fileCount: 2, mediaFileCount: 1 })
    expect(member(g, 'b').torrent).toMatchObject({ instanceId: 'box-b', name: 'on box b', fileCount: 1, mediaFileCount: 1 })
  })

  it('reads one season pack\'s file counts correctly for episodes in different groups', async () => {
    const pack = ['E01', 'E02'].map((e) => `Show.S01.1080p/Show.S01${e}.mkv`)
    for (const [i, id] of ['e1a', 'e1b', 'e2a', 'e2b'].entries()) {
      seedItem({ id, type: 'Episode', name: `Ep ${i}`, container_path: i < 2 ? `/mnt/a/Show/S01E01.${id}.mkv` : `/mnt/a/Show/S01E02.${id}.mkv` })
    }
    seedGroup({ id: 'g1', members: ['e1a', 'e1b'] })
    seedGroup({ id: 'g2', members: ['e2a', 'e2b'] })
    seedTorrent({
      instanceId: 'box-a', hash: HASH_A, name: 'Show.S01.1080p',
      files: [
        { relPath: pack[0]!, containerPath: '/mnt/a/Show/S01E01.e1a.mkv' },
        { relPath: pack[1]!, containerPath: '/mnt/a/Show/S01E02.e2a.mkv' },
        { relPath: 'Show.S01.1080p/Show.S01.nfo', containerPath: '/mnt/a/Show/Show.S01.nfo' },
      ],
    })
    const body = await duplicates()
    expect(member(group(body, 'g1'), 'e1a').torrent).toMatchObject({ hash: HASH_A, fileCount: 3, mediaFileCount: 2 })
    expect(member(group(body, 'g2'), 'e2a').torrent).toMatchObject({ hash: HASH_A, fileCount: 3, mediaFileCount: 2 })
  })

  it('has no box and no torrent for a member without a path or outside every root, and does not hide it', async () => {
    seedItem({ id: 'a', container_path: null })
    seedItem({ id: 'b', container_path: '/srv/elsewhere/Heat.mkv' })
    seedItem({ id: 'c', container_path: '/mnt/a/Heat.mkv' })
    seedGroup({ id: 'g1', members: ['a', 'b', 'c'] })
    const g = group(await duplicates(), 'g1')
    expect(g!.members).toHaveLength(3)
    expect(member(g, 'a')).toMatchObject({ containerPath: null, instanceId: null, torrent: null, torrentCount: 0 })
    // No root covers it: the instance is unknown, which is never reported as a box.
    expect(member(g, 'b')).toMatchObject({ instanceId: null, torrent: null, torrentCount: 0 })
  })

  // The index column is nullable. A torrent whose privacy it does not know is treated as private —
  // the direction guard.private-ratio fails in — so it cannot read as "H&R met" by default.
  it('treats a torrent whose privacy the index does not know as private', async () => {
    seedItem({ id: 'a', container_path: '/mnt/a/Heat.mkv' }); seedItem({ id: 'b', container_path: '/mnt/a/Heat 2.mkv' })
    seedGroup({ id: 'g1', members: ['a', 'b'] })
    seedTorrent({ instanceId: 'box-a', hash: HASH_A, ratio: 0.1, seedingTime: DAY, files: [{ relPath: 'Heat.mkv', containerPath: '/mnt/a/Heat.mkv' }] })
    db.prepare('UPDATE torrents SET is_private = NULL').run()
    expect(member(group(await duplicates(), 'g1'), 'a').torrent).toMatchObject({ isPrivate: true, hnrMet: false })
  })

  it('reports the hardware and quality facts of a member under their C12 names', async () => {
    seedItem({
      id: 'a', name: 'Heat', container_path: '/mnt/a/Heat.mkv', size_bytes: 1234, width: 3840, height: 2160, bitrate: 40_000_000,
      video_codec: 'hevc', audio_channels: 8, container: 'mkv', library_name: 'Movies A', video_range: 'HDR10', has_subtitles: 1,
    })
    seedItem({ id: 'b', container_path: '/mnt/b/Heat.mkv' })
    seedGroup({ id: 'g1', members: ['a', 'b'] })
    expect(member(group(await duplicates(), 'g1'), 'a')).toEqual({
      id: 'a', name: 'Heat', containerPath: '/mnt/a/Heat.mkv', sizeBytes: 1234, width: 3840, height: 2160, bitrate: 40_000_000,
      videoCodec: 'hevc', audioChannels: 8, container: 'mkv', libraryName: 'Movies A', videoRange: 'HDR10', hasSubtitles: true,
      edition: null, instanceId: 'box-a', torrent: null, torrentCount: 0,
    })
  })
})

describe('GET /api/duplicates — what is hidden', () => {
  it('duplicates omits deleted_paths members and groups left with fewer than two members', async () => {
    for (const id of ['a', 'b', 'c', 'x', 'y']) seedItem({ id, container_path: `/mnt/a/${id}.mkv` })
    seedGroup({ id: 'three', members: ['a', 'b', 'c'] })
    seedGroup({ id: 'two', members: ['x', 'y'] })
    deletePath('/mnt/a/c.mkv') // a plan already removed one of three: two copies remain
    deletePath('/mnt/a/y.mkv') // …and one of two: nothing is left to compare it with

    const body = await duplicates()
    expect(group(body, 'three')!.members.map((m: { id: string }) => m.id).sort()).toEqual(['a', 'b'])
    expect(group(body, 'two')).toBeUndefined()
    expect(body.groups).toHaveLength(1)
  })

  it('omits a group whose members have gone from the library, rather than listing a lone copy', async () => {
    seedItem({ id: 'a', container_path: '/mnt/a/a.mkv' })
    seedGroup({ id: 'g1', members: ['a', 'gone'] })
    expect((await duplicates()).groups).toEqual([])
  })

  it('brings a group back as soon as its deleted_paths row goes', async () => {
    seedItem({ id: 'a', container_path: '/mnt/a/a.mkv' })
    seedItem({ id: 'b', container_path: '/mnt/a/b.mkv' })
    seedGroup({ id: 'g1', members: ['a', 'b'] })
    deletePath('/mnt/a/b.mkv')
    expect((await duplicates()).groups).toEqual([])
    db.prepare('DELETE FROM deleted_paths').run()
    expect((await duplicates()).groups).toHaveLength(1)
  })

  it('hides a merged group too', async () => {
    seedItem({ id: 'a' }); seedItem({ id: 'b' })
    seedGroup({ id: 'g1', members: ['a', 'b'], status: 'merged' })
    expect((await duplicates()).groups).toEqual([])
  })

  it('duplicates hides dismissed groups; dismiss and reopen flip both dupe_groups and the finding', async () => {
    seedItem({ id: 'a' }); seedItem({ id: 'b' })
    seedGroup({ id: 'g1', members: ['a', 'b'] })
    seedDupeFinding('g1')
    expect((await duplicates()).groups).toHaveLength(1)

    const dismissed = await build().inject({
      method: 'POST', url: '/api/duplicates/g1/dismiss', headers: auth(), payload: { reason: 'different cuts' },
    })
    expect(dismissed.statusCode).toBe(204)
    expect(dismissed.body).toBe('')
    expect(db.prepare('SELECT status FROM dupe_groups WHERE id = ?').get('g1')).toEqual({ status: 'dismissed' })
    expect(db.prepare('SELECT status, dismissed_reason, dismissed_by, dismissed_at FROM findings WHERE id = ?').get('finding-g1'))
      .toMatchObject({ status: 'dismissed', dismissed_reason: 'different cuts', dismissed_by: 'bob', dismissed_at: expect.any(String) })
    expect((await duplicates()).groups).toEqual([])

    const reopened = await build().inject({ method: 'POST', url: '/api/duplicates/g1/reopen', headers: auth() })
    expect(reopened.statusCode).toBe(204)
    expect(db.prepare('SELECT status FROM dupe_groups WHERE id = ?').get('g1')).toEqual({ status: 'open' })
    expect(db.prepare('SELECT status, dismissed_reason, dismissed_by, dismissed_at FROM findings WHERE id = ?').get('finding-g1'))
      .toEqual({ status: 'open', dismissed_reason: null, dismissed_by: null, dismissed_at: null })
    expect((await duplicates()).groups).toHaveLength(1)
  })
})

// Final review I2: the Findings screen dismisses a `dupe.group` finding through the generic route.
// That used to change the finding alone, so the group stayed on the Duplicates screen — and, its
// evidence no longer read, it lost `editionsDiffer` and the bulk queue took its different cut.
describe('a dupe.group finding dismissed or reopened on the Findings screen (final review I2)', () => {
  const findingsDismiss = (id: string) =>
    build().inject({ method: 'POST', url: `/api/findings/${id}/dismiss`, headers: auth(), payload: { reason: 'different cuts, keep both' } })
  const findingsReopen = (id: string) => build().inject({ method: 'POST', url: `/api/findings/${id}/reopen`, headers: auth() })

  /** The reviewer's case: two cuts of one film, recorded as such by the scan. */
  function twoCuts() {
    seedItem({ id: 'a', name: 'Aliens', container_path: '/mnt/local/Aliens (1986)/Aliens.1986.Theatrical.mkv', size_bytes: 100 })
    seedItem({ id: 'b', name: 'Aliens', container_path: '/mnt/local/Aliens (1986)/Aliens.1986.Special.Edition.mkv', size_bytes: 90 })
    seedGroup({ id: 'g1', members: ['a', 'b'], keeper: 'a' })
    seedDupeFinding('g1', {
      keeperId: 'a', keeperPolicy: 'best-quality', matchedBy: ['dupe.provider-id'],
      editions: { a: 'Theatrical', b: 'Special Edition' }, editionsDiffer: true,
    })
  }

  it('dismissing it hides the group from /api/duplicates, and reopening brings it back as it was', async () => {
    twoCuts()
    expect(group(await duplicates(), 'g1')).toMatchObject({ editionsDiffer: true, matchedBy: ['dupe.provider-id'] })

    expect((await findingsDismiss('finding-g1')).statusCode).toBe(200)
    expect(db.prepare('SELECT status FROM dupe_groups WHERE id = ?').get('g1')).toEqual({ status: 'dismissed' })
    expect((await duplicates()).groups).toEqual([])

    expect((await findingsReopen('finding-g1')).statusCode).toBe(200)
    expect(db.prepare('SELECT status FROM dupe_groups WHERE id = ?').get('g1')).toEqual({ status: 'open' })
    expect(group(await duplicates(), 'g1')).toMatchObject({ editionsDiffer: true, matchedBy: ['dupe.provider-id'] })
  })

  it('never un-merges a merged group, and leaves other groups and other findings alone', async () => {
    seedItem({ id: 'a' }); seedItem({ id: 'b' }); seedItem({ id: 'c' }); seedItem({ id: 'd' })
    seedGroup({ id: 'merged', members: ['a', 'b'], status: 'merged' })
    seedDupeFinding('merged')
    seedGroup({ id: 'other', members: ['c', 'd'] })
    seedDupeFinding('other')
    insertFinding({ id: 'junk', evidence_json: JSON.stringify({ groupId: 'other' }) }) // not a dupe.group finding

    expect((await findingsDismiss('finding-merged')).statusCode).toBe(200)
    expect((await findingsReopen('finding-merged')).statusCode).toBe(200)
    expect((await findingsDismiss('junk')).statusCode).toBe(200)
    expect(db.prepare('SELECT id, status FROM dupe_groups ORDER BY id').all())
      .toEqual([{ id: 'merged', status: 'merged' }, { id: 'other', status: 'open' }])
    expect(db.prepare("SELECT status FROM findings WHERE id = 'finding-other'").get()).toEqual({ status: 'open' })
  })

  it('hides a group whose finding is dismissed even while the group row still reads open', async () => {
    // A finding dismissed before the routes mirrored it: the next scan's persist() would catch the
    // group up, and until then the operator's word on the finding is the one that counts.
    twoCuts()
    db.prepare("UPDATE findings SET status = 'dismissed' WHERE id = 'finding-g1'").run()
    expect((await duplicates()).groups).toEqual([])
  })
})

describe('POST /api/duplicates/:groupId/dismiss and /reopen', () => {
  const dismiss = (id: string, payload?: unknown, headers: Record<string, string> = auth()) =>
    build().inject({ method: 'POST', url: `/api/duplicates/${id}/dismiss`, headers, ...(payload === undefined ? {} : { payload: payload as object }) })
  const reopen = (id: string, headers: Record<string, string> = auth()) =>
    build().inject({ method: 'POST', url: `/api/duplicates/${id}/reopen`, headers })

  it('require a session', async () => {
    seedItem({ id: 'a' }); seedItem({ id: 'b' }); seedGroup({ id: 'g1', members: ['a', 'b'] })
    expect((await dismiss('g1', {}, {})).statusCode).toBe(401)
    expect((await reopen('g1', {})).statusCode).toBe(401)
    expect(db.prepare('SELECT status FROM dupe_groups').get()).toEqual({ status: 'open' })
  })

  it('dismisses without a reason, and without any body at all', async () => {
    seedItem({ id: 'a' }); seedItem({ id: 'b' }); seedItem({ id: 'c' }); seedItem({ id: 'd' })
    seedGroup({ id: 'g1', members: ['a', 'b'] }); seedGroup({ id: 'g2', members: ['c', 'd'] })
    seedDupeFinding('g1'); seedDupeFinding('g2')
    expect((await dismiss('g1', {})).statusCode).toBe(204)
    expect((await dismiss('g2')).statusCode).toBe(204)
    expect(db.prepare("SELECT COUNT(*) c FROM dupe_groups WHERE status = 'dismissed'").get()).toEqual({ c: 2 })
    expect(db.prepare('SELECT dismissed_reason FROM findings WHERE id = ?').get('finding-g1')).toEqual({ dismissed_reason: null })
  })

  it('rejects a reason that is not a non-empty string', async () => {
    seedItem({ id: 'a' }); seedItem({ id: 'b' }); seedGroup({ id: 'g1', members: ['a', 'b'] })
    for (const payload of [{ reason: 5 }, { reason: '' }, { reason: ['x'] }]) {
      expect((await dismiss('g1', payload)).statusCode).toBe(400)
    }
    expect(db.prepare('SELECT status FROM dupe_groups').get()).toEqual({ status: 'open' })
  })

  it('404s for an unknown group, in the route\'s own words (not the framework\'s unknown-route 404)', async () => {
    for (const res of [await dismiss('nope', {}), await reopen('nope')]) {
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ error: 'no such duplicate group' })
    }
  })

  // A merged group has been resolved in Jellyfin. Reopening it would make it mergeable again, and
  // merging ids that no longer name independent items has no defined behaviour (plans.ts).
  it('refuses to touch a merged group', async () => {
    seedItem({ id: 'a' }); seedItem({ id: 'b' }); seedGroup({ id: 'g1', members: ['a', 'b'], status: 'merged' })
    expect((await dismiss('g1', {})).statusCode).toBe(409)
    expect((await reopen('g1')).statusCode).toBe(409)
    expect(db.prepare('SELECT status FROM dupe_groups').get()).toEqual({ status: 'merged' })
  })

  it('is idempotent, and a second dismissal does not overwrite who dismissed it or why', async () => {
    seedItem({ id: 'a' }); seedItem({ id: 'b' }); seedGroup({ id: 'g1', members: ['a', 'b'] }); seedDupeFinding('g1')
    expect((await dismiss('g1', { reason: 'first' })).statusCode).toBe(204)
    expect((await dismiss('g1', { reason: 'second' })).statusCode).toBe(204)
    expect(db.prepare('SELECT dismissed_reason FROM findings WHERE id = ?').get('finding-g1')).toEqual({ dismissed_reason: 'first' })
    expect((await reopen('g1')).statusCode).toBe(204)
    expect((await reopen('g1')).statusCode).toBe(204)
    expect(db.prepare('SELECT status FROM dupe_groups').get()).toEqual({ status: 'open' })
  })

  it('still dismisses a group that has no finding row, and leaves other groups\' findings alone', async () => {
    seedItem({ id: 'a' }); seedItem({ id: 'b' }); seedItem({ id: 'c' }); seedItem({ id: 'd' })
    seedGroup({ id: 'g1', members: ['a', 'b'] }); seedGroup({ id: 'g2', members: ['c', 'd'] })
    seedDupeFinding('g2')
    expect((await dismiss('g1', { reason: 'x' })).statusCode).toBe(204)
    expect(db.prepare("SELECT status FROM dupe_groups WHERE id = 'g1'").get()).toEqual({ status: 'dismissed' })
    expect(db.prepare("SELECT status FROM findings WHERE id = 'finding-g2'").get()).toEqual({ status: 'open' })
  })

  // runRules() upserts a finding keeping 'dismissed' (src/rules/runner.ts), so a dismissed finding
  // is what makes a dismissal survive the next scan. A finding that had meanwhile been resolved
  // must therefore become dismissed too, not stay resolved.
  it('dismisses a finding that had been resolved, so the dismissal outlives a rescan', async () => {
    seedItem({ id: 'a' }); seedItem({ id: 'b' }); seedGroup({ id: 'g1', members: ['a', 'b'] })
    seedDupeFinding('g1', {}, 'resolved')
    await dismiss('g1', { reason: 'x' })
    expect(db.prepare('SELECT status FROM findings').get()).toEqual({ status: 'dismissed' })
  })
})

describe('GET /api/duplicates — was dupe matching evaluated', () => {
  it('duplicates reports evaluated false when the dupe rule did not run in the latest scan', async () => {
    seedItem({ id: 'a' }); seedItem({ id: 'b' }); seedGroup({ id: 'g1', members: ['a', 'b'] })
    seedScan(7, 'completed', 'F7')
    seedRuleRun(7, 'dupe.group', 'not-evaluated', 'jellyfin phase failed: 401')
    const body = await duplicates()
    expect(body).toMatchObject({ evaluated: false, reason: 'jellyfin phase failed: 401', scanId: 7, scanFinishedAt: 'F7' })
  })

  it('reports evaluated false, with a reason, when the latest scan has no dupe.group row at all', async () => {
    seedScan(7, 'completed', 'F7')
    seedRuleRun(7, 'fs.junk', 'evaluated')
    const body = await duplicates()
    expect(body).toMatchObject({ evaluated: false, scanId: 7, scanFinishedAt: 'F7' })
    expect(body.reason).toEqual(expect.stringContaining('did not run'))
  })

  it('reports evaluated true from the latest completed scan', async () => {
    seedScan(7, 'completed', 'F7')
    seedRuleRun(7, 'dupe.group', 'evaluated')
    expect(await duplicates()).toMatchObject({ evaluated: true, reason: null, scanId: 7, scanFinishedAt: 'F7', groups: [] })
  })

  it('looks at the latest COMPLETED scan: a newer failed or running one says nothing about the rule', async () => {
    seedScan(7, 'completed', 'F7')
    seedRuleRun(7, 'dupe.group', 'evaluated')
    seedScan(8, 'failed', 'F8')
    seedScan(9, 'running', null)
    expect(await duplicates()).toMatchObject({ evaluated: true, scanId: 7 })
  })

  it('uses the newest completed scan\'s answer, not an older one\'s', async () => {
    seedScan(7, 'completed', 'F7')
    seedRuleRun(7, 'dupe.group', 'evaluated')
    seedScan(8, 'completed', 'F8')
    seedRuleRun(8, 'dupe.group', 'not-evaluated', 'hashing is disabled')
    expect(await duplicates()).toMatchObject({ evaluated: false, reason: 'hashing is disabled', scanId: 8 })
  })

  it('says no scan has completed, rather than that nothing is duplicated, on a fresh database', async () => {
    const body = await duplicates()
    expect(body).toMatchObject({ evaluated: false, scanId: null, scanFinishedAt: null, groups: [] })
    expect(body.reason).toEqual(expect.stringContaining('no scan'))
  })
})

describe('GET /api/duplicates — group facts', () => {
  it('reclaimableBytes sums non-keepers', async () => {
    seedItem({ id: 'a', size_bytes: 100 }); seedItem({ id: 'b', size_bytes: 200 }); seedItem({ id: 'c', size_bytes: 400 })
    seedGroup({ id: 'g1', members: ['a', 'b', 'c'], keeper: 'c' })
    expect(group(await duplicates(), 'g1')).toMatchObject({ keeperItemId: 'c', reclaimableBytes: 300 })
  })

  it('counts a non-keeper with no known size as zero bytes', async () => {
    seedItem({ id: 'a', size_bytes: null }); seedItem({ id: 'b', size_bytes: 50 })
    seedGroup({ id: 'g1', members: ['a', 'b'], keeper: 'b' })
    expect(group(await duplicates(), 'g1')!.reclaimableBytes).toBe(0)
  })

  it('reclaims nothing when there is no keeper, because nothing is yet marked to keep', async () => {
    seedItem({ id: 'a', size_bytes: 100 }); seedItem({ id: 'b', size_bytes: 200 })
    seedGroup({ id: 'g1', members: ['a', 'b'], keeper: null })
    expect(group(await duplicates(), 'g1')).toMatchObject({ keeperItemId: null, reclaimableBytes: 0 })
  })

  // If the copy marked to keep has already been deleted, "every other member is a non-keeper" would
  // read as "queue all the rest for deletion" — the last copies. No keeper is the only safe answer.
  it('reports no keeper, and nothing reclaimable, once the keeper itself is hidden', async () => {
    seedItem({ id: 'a', container_path: '/mnt/a/a.mkv', size_bytes: 100 })
    seedItem({ id: 'b', container_path: '/mnt/a/b.mkv', size_bytes: 200 })
    seedItem({ id: 'c', container_path: '/mnt/a/c.mkv', size_bytes: 400 })
    seedGroup({ id: 'g1', members: ['a', 'b', 'c'], keeper: 'c' })
    deletePath('/mnt/a/c.mkv')
    const g = group(await duplicates(), 'g1')
    expect(g).toMatchObject({ keeperItemId: null, reclaimableBytes: 0 })
    expect(g!.members).toHaveLength(2)
  })

  it('crossInstance is true when members span instances', async () => {
    seedItem({ id: 'a', container_path: '/mnt/a/Heat.mkv' })
    seedItem({ id: 'b', container_path: '/mnt/b/Heat.mkv' })
    seedItem({ id: 'c', container_path: '/mnt/a/Heat copy.mkv' })
    seedItem({ id: 'd', container_path: '/mnt/local/Heat.mkv' })
    seedGroup({ id: 'across', members: ['a', 'b'] })
    seedGroup({ id: 'within', members: ['a', 'c'] })
    seedGroup({ id: 'with-untracked', members: ['a', 'd'] })
    const body = await duplicates()
    expect(group(body, 'across')!.crossInstance).toBe(true)
    expect(group(body, 'within')!.crossInstance).toBe(false)
    // A copy on a root no instance owns is not "another box".
    expect(group(body, 'with-untracked')!.crossInstance).toBe(false)
  })

  it('takes the keeper policy and editionsDiffer from the finding evidence', async () => {
    seedItem({ id: 'a' }); seedItem({ id: 'b' })
    seedGroup({ id: 'g1', members: ['a', 'b'] })
    seedDupeFinding('g1', { keeperPolicy: 'smallest', editionsDiffer: true, editions: { a: 'Extended', b: null } })
    config = fileConfigSchema.parse({ keeper: { policy: 'none' } })
    const g = group(await duplicates(), 'g1')!
    // The policy the keeper was CHOSEN under, not whatever the config says today.
    expect(g).toMatchObject({ keeperPolicy: 'smallest', editionsDiffer: true })
    expect(member(g, 'a').edition).toBe('Extended')
    expect(member(g, 'b').edition).toBeNull()
  })

  it('falls back to the current keeper policy, and reads editionsDiffer off the members, when the finding says neither', async () => {
    seedItem({ id: 'a' }); seedItem({ id: 'b' })
    seedGroup({ id: 'with-finding', members: ['a', 'b'] })
    seedDupeFinding('with-finding') // an older scan's evidence: no keeperPolicy, no editions
    seedGroup({ id: 'no-finding', members: ['a', 'b'] })
    config = fileConfigSchema.parse({ keeper: { policy: 'smallest' } })
    const body = await duplicates()
    for (const id of ['with-finding', 'no-finding']) {
      expect(group(body, id)).toMatchObject({ keeperPolicy: 'smallest', editionsDiffer: false })
    }
    // A plain file name carries no edition.
    expect(member(group(body, 'with-finding'), 'a').edition).toBeNull()
  })

  it("reads a member's edition from its file path when the finding recorded none, as the duplicate rule does", async () => {
    // The folder carries the edition here, not the file, so this also proves the path — not only the
    // item name — is what is read: the same input the dupe rule's adapter hands editionOf.
    seedItem({ id: 'a', name: 'Aliens', container_path: '/path/to/movies/Aliens (1986) Extended/Aliens (1986).mkv' })
    seedItem({ id: 'b', name: 'Aliens', container_path: "/path/to/movies/Aliens (1986)/Aliens (1986) - Director's Cut.mkv" })
    seedItem({ id: 'c', name: 'Aliens', container_path: '/path/to/movies/Aliens (1986)/Aliens (1986).mkv' })
    seedGroup({ id: 'g1', members: ['a', 'b', 'c'] })
    seedDupeFinding('g1') // an older scan's evidence: no editions recorded
    const g = group(await duplicates(), 'g1')!
    expect(member(g, 'a').edition).toBe('Extended')
    expect(member(g, 'b').edition).toBe("Director's Cut")
    expect(member(g, 'c').edition).toBeNull()
  })

  // Final review I2 / Task 8 minor 1: "unknown" was read as "no", and the bulk queue took the cut.
  it('derives editionsDiffer from the members\' editions when the finding is missing or never said, never assuming false', async () => {
    seedItem({ id: 'a', name: 'Aliens', container_path: '/mnt/local/Aliens (1986)/Aliens.1986.Theatrical.mkv' })
    seedItem({ id: 'b', name: 'Aliens', container_path: '/mnt/local/Aliens (1986)/Aliens.1986.Special.Edition.mkv' })
    seedItem({ id: 'c', name: 'Aliens', container_path: '/mnt/local/Aliens (1986)/Aliens.1986.mkv' })
    seedItem({ id: 'd', name: 'Aliens', container_path: '/mnt/local/Aliens (1986) Extended/Aliens.1986.mkv' })
    seedGroup({ id: 'no-finding', members: ['a', 'b'] })
    seedGroup({ id: 'old-finding', members: ['c', 'd'] })
    seedDupeFinding('old-finding') // an older scan's evidence: no editions, no editionsDiffer
    seedGroup({ id: 'same-cut', members: ['a', 'b', 'c'] })
    seedDupeFinding('same-cut', { editions: { a: 'Theatrical', b: 'Theatrical', c: 'Theatrical' } }) // and no editionsDiffer
    const body = await duplicates()
    expect(group(body, 'no-finding')!.editionsDiffer).toBe(true)
    // An unnamed copy counts as one more edition, as the duplicate rule counts it.
    expect(group(body, 'old-finding')!.editionsDiffer).toBe(true)
    expect(group(body, 'same-cut')!.editionsDiffer).toBe(false)
  })

  // Task 6 minor 4: a multi-episode copy is not a spare copy of the group's one episode.
  it('reports multiEpisode from the evidence, or reads it off the members\' file names when the finding never said', async () => {
    const episode = { type: 'Episode', name: 'Pilot', series_name: 'Show', season_no: 1, episode_no: 1 }
    seedItem({ id: 'double', ...episode, container_path: '/mnt/local/Show/Show.S01E01E02.mkv' })
    seedItem({ id: 'single', ...episode, container_path: '/mnt/local/Show/Show.S01E01.mkv' })
    seedItem({ id: 'single-2', ...episode, container_path: '/mnt/local/Other/Show.S01E01.mkv' })
    seedGroup({ id: 'no-finding', members: ['double', 'single'] })
    seedGroup({ id: 'said-so', members: ['single', 'single-2'] })
    seedDupeFinding('said-so', { multiEpisode: true })
    seedGroup({ id: 'plain', members: ['single', 'single-2'] })
    seedDupeFinding('plain', { multiEpisode: false })
    const body = await duplicates()
    expect(group(body, 'no-finding')!.multiEpisode).toBe(true)
    expect(group(body, 'said-so')!.multiEpisode).toBe(true)
    expect(group(body, 'plain')!.multiEpisode).toBe(false)
  })

  it('ignores evidence values of the wrong type rather than trusting them', async () => {
    seedItem({ id: 'a' }); seedItem({ id: 'b' }); seedGroup({ id: 'g1', members: ['a', 'b'] })
    seedDupeFinding('g1', { keeperPolicy: 'cheapest', editionsDiffer: 'yes', editions: { a: 5, b: { x: 1 } } })
    const g = group(await duplicates(), 'g1')!
    expect(g).toMatchObject({ keeperPolicy: 'best-quality', editionsDiffer: false })
    expect(member(g, 'a').edition).toBeNull()
    expect(member(g, 'b').edition).toBeNull()
  })

  it('describes a movie group by its title and year', async () => {
    seedItem({ id: 'a', name: 'Heat', year: 1995, size_bytes: 10 })
    seedItem({ id: 'b', name: 'Heat', year: 1995, size_bytes: 20 })
    seedGroup({ id: 'g1', members: ['a', 'b'], tier: 'strong', keeper: 'b' })
    expect(group(await duplicates(), 'g1')).toMatchObject({
      tier: 'strong', title: 'Heat', year: 1995, kind: 'movie', seriesName: null, seasonNo: null, episodeNo: null,
    })
  })

  it('describes an episode group by its series, season and episode', async () => {
    seedItem({ id: 'a', type: 'Episode', name: 'Pilot', year: null, series_name: 'The Show', season_no: 1, episode_no: 2 })
    seedItem({ id: 'b', type: 'Episode', name: 'Pilot', year: null, series_name: 'The Show', season_no: 1, episode_no: 2 })
    seedGroup({ id: 'g1', members: ['a', 'b'] })
    expect(group(await duplicates(), 'g1')).toMatchObject({
      title: 'Pilot', kind: 'episode', seriesName: 'The Show', seasonNo: 1, episodeNo: 2, year: null,
    })
  })

  it('falls back to another member for a year the keeper does not have', async () => {
    seedItem({ id: 'a', year: null, size_bytes: 20 })
    seedItem({ id: 'b', year: 1995, size_bytes: 10 })
    seedGroup({ id: 'g1', members: ['a', 'b'], keeper: 'a' })
    expect(group(await duplicates(), 'g1')!.year).toBe(1995)
  })

  it('carries the scores of the visible members only', async () => {
    seedItem({ id: 'a', container_path: '/mnt/a/a.mkv' }); seedItem({ id: 'b', container_path: '/mnt/a/b.mkv' })
    seedItem({ id: 'c', container_path: '/mnt/a/c.mkv' })
    seedGroup({
      id: 'g1', members: ['a', 'b', 'c'],
      scores: { a: { total: 1, breakdown: { resolution: 1 } }, b: { total: 2, breakdown: {} }, c: { total: 3, breakdown: {} } },
    })
    deletePath('/mnt/a/c.mkv')
    expect(group(await duplicates(), 'g1')!.scores).toEqual({ a: { total: 1, breakdown: { resolution: 1 } }, b: { total: 2, breakdown: {} } })
  })

  it('lists the keeper first, then the biggest copies, and the groups with the most to reclaim first', async () => {
    seedItem({ id: 'a', size_bytes: 10 }); seedItem({ id: 'b', size_bytes: 300 }); seedItem({ id: 'c', size_bytes: 20 })
    seedItem({ id: 'x', size_bytes: 5 }); seedItem({ id: 'y', size_bytes: 6 })
    seedGroup({ id: 'small', members: ['x', 'y'], keeper: 'y' }) // reclaims 5
    seedGroup({ id: 'big', members: ['a', 'b', 'c'], keeper: 'a' }) // reclaims 320
    const body = await duplicates()
    expect(body.groups.map((g: { id: string }) => g.id)).toEqual(['big', 'small'])
    expect(group(body, 'big')!.members.map((m: { id: string }) => m.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('GET /api/duplicates — at the size of a real library', () => {
  // The owner's library has hundreds of duplicate groups. A query per member (or per group) is
  // invisible on the handful of rows every other test seeds and ruinous at this size, so this
  // counts the statements the request prepares: the lookups are batched, so the count must not
  // grow with the number of groups.
  it('looks members and torrents up in batches, not one query per member', async () => {
    const GROUPS = 1_200
    const insertItem = db.prepare(`INSERT INTO jellyfin_items (id, scan_id, type, name, year, container_path, size_bytes, has_primary_image)
      VALUES (?, 1, 'Movie', ?, 1999, ?, ?, 1)`)
    const insertGroup = db.prepare(`INSERT INTO dupe_groups (id, tier, members_json, keeper_item_id, scores_json, status)
      VALUES (?, 'exact', ?, ?, '{}', 'open')`)
    const insertTorrent = db.prepare(`INSERT INTO torrents (instance_id, hash, fetched_at, name, state, ratio, seeding_time, is_private, size_bytes, progress)
      VALUES (?, ?, 'T', ?, 'stalledUP', 2, 2592000, 0, 5000, 1)`)
    const insertFile = db.prepare('INSERT INTO torrent_files (instance_id, hash, file_index, rel_path, container_path, size_bytes) VALUES (?,?,?,?,?,?)')
    db.transaction(() => {
      for (let g = 0; g < GROUPS; g += 1) {
        const ids = [`m${g}a`, `m${g}b`]
        ids.forEach((id, side) => {
          const root = side === 0 ? '/mnt/a' : '/mnt/b'
          const instanceId = side === 0 ? 'box-a' : 'box-b'
          const path = `${root}/Movie ${g}/Movie ${g}.mkv`
          insertItem.run(id, `Movie ${g}`, path, 1_000 + side)
          const hash = id.padEnd(40, '0')
          insertTorrent.run(instanceId, hash, `Movie.${g}`)
          insertFile.run(instanceId, hash, 0, `Movie.${g}/Movie ${g}.mkv`, path, 1_000)
          insertFile.run(instanceId, hash, 1, `Movie.${g}/Movie ${g}.nfo`, `${root}/Movie ${g}/Movie ${g}.nfo`, 1)
          insertFile.run(instanceId, hash, 2, `Movie.${g}/Subs/Movie ${g}.srt`, `${root}/Movie ${g}/Subs/Movie ${g}.srt`, 1)
        })
        insertGroup.run(`g${g}`, JSON.stringify(ids), ids[1])
      }
    })()

    const originalPrepare = db.prepare.bind(db)
    let prepares = 0
    db.prepare = ((sql: string) => { prepares += 1; return originalPrepare(sql) }) as typeof db.prepare
    const body = await duplicates()

    expect(body.groups).toHaveLength(GROUPS)
    expect(prepares).toBeLessThan(60)
    const sample = group(body, 'g777')!
    expect(sample.crossInstance).toBe(true)
    expect(sample.reclaimableBytes).toBe(1_000) // member "a" is the non-keeper
    expect(member(sample, 'm777a').torrent).toMatchObject({ instanceId: 'box-a', fileCount: 3, mediaFileCount: 1, hnrMet: true })
    expect(member(sample, 'm777b').torrent).toMatchObject({ instanceId: 'box-b', fileCount: 3, mediaFileCount: 1 })
  })
})
