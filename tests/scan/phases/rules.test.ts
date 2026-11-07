import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../../src/index/db.js'
import { availableSources, rulesPhase } from '../../../src/scan/phases/rules.js'
import { ALL_RULES } from '../../../src/rules/registry.js'
import { runRules } from '../../../src/rules/runner.js'
import { createPathMap } from '../../../src/fs/pathmap.js'
import { fileConfigSchema } from '../../../src/config/schema.js'
import type { PhaseContext, PhaseName, PhaseResult } from '../../../src/scan/phases/types.js'

let db: Db

const completed = (counts: Record<string, number> = {}): PhaseResult => ({ status: 'completed', counts })

function ctx(priorResults: Partial<Record<PhaseName, PhaseResult>>, scanId = 2): PhaseContext {
  return {
    db,
    scanId,
    cursor: {},
    signal: new AbortController().signal,
    priorResults,
    saveCursor: () => {},
    progress: () => {},
    deps: {
      config: fileConfigSchema.parse({}),
      pathMap: createPathMap([]),
      jellyfin: null, qbittorrents: new Map(), radarr: null, sonarr: null, hasher: null,
    },
  }
}

/** An item row from an EARLIER scan — exactly what a skipped jellyfin phase leaves behind. */
function staleItem(id: string, containerPath: string) {
  db.prepare(`INSERT INTO jellyfin_items (id, scan_id, type, name, provider_ids_json, jf_path,
    container_path, has_primary_image, year) VALUES (?,1,'Movie',?, '{"tmdb":"1"}', ?, ?, 1, 2001)`)
    .run(id, id, containerPath, containerPath)
}

function mediaFile(containerPath: string, size = 1_000) {
  db.prepare(`INSERT INTO fs_entries (container_path, scan_id, parent_path, name, ext, is_dir,
    size_bytes, mtime, is_media, library_root, root_role)
    VALUES (?,2,'/mnt/m',?,'.mkv',0,?,0,1,'/mnt/m','library')`)
    .run(containerPath, containerPath.split('/').pop(), size)
}

const runsFor = (ruleId: string, scanId = 2) =>
  db.prepare('SELECT status, reason FROM rule_runs WHERE scan_id = ? AND rule_id = ?')
    .get(scanId, ruleId) as { status: string; reason: string | null } | undefined

const findingsFor = (ruleId: string) =>
  db.prepare('SELECT id FROM findings WHERE rule_id = ?').all(ruleId) as Array<{ id: string }>

beforeEach(() => {
  db = openDb(join(mkdtempSync(join(tmpdir(), 'jm-rulesphase-')), 'db.sqlite'))
  db.prepare("INSERT INTO scans (id, started_at, status) VALUES (1,'T1','completed')").run()
  db.prepare("INSERT INTO scans (id, started_at, status) VALUES (2,'T2','running')").run()
})

describe('rulesPhase source availability', () => {
  it('records fs.orphan-media not-evaluated, and emits no orphan finding, when this scan\'s jellyfin phase skipped even though jellyfin_items still holds an earlier scan\'s rows', async () => {
    // The stale snapshot knows /mnt/m/old.mkv. The file that Jellyfin imported since — and would
    // have told us about had its phase not skipped — is /mnt/m/new.mkv.
    staleItem('old', '/mnt/m/old.mkv')
    mediaFile('/mnt/m/old.mkv')
    mediaFile('/mnt/m/new.mkv', 5_000_000_000)

    const res = await rulesPhase.run(ctx({
      jellyfin: { status: 'skipped', reason: 'unreachable: connect ECONNREFUSED', counts: {} },
      filesystem: completed({ entries: 2 }),
    }))
    expect(res.status).toBe('completed')

    const run = runsFor('fs.orphan-media')
    expect(run?.status).toBe('not-evaluated')
    expect(run?.reason).toMatch(/jellyfin/)
    expect(run?.reason).toMatch(/skipped/)
    expect(run?.reason).toMatch(/ECONNREFUSED/)
    expect(findingsFor('fs.orphan-media')).toHaveLength(0)
  })

  it('evaluates fs.orphan-media normally when the jellyfin phase completed', async () => {
    staleItem('old', '/mnt/m/old.mkv')
    mediaFile('/mnt/m/old.mkv')
    mediaFile('/mnt/m/new.mkv', 5_000_000_000)

    const res = await rulesPhase.run(ctx({
      jellyfin: completed({ items: 1 }),
      filesystem: completed({ entries: 2 }),
    }))
    expect(res.status).toBe('completed')

    expect(runsFor('fs.orphan-media')?.status).toBe('evaluated')
    expect(findingsFor('fs.orphan-media')).toHaveLength(1)
  })

  it('treats a source whose phase never ran at all as unavailable', async () => {
    staleItem('old', '/mnt/m/old.mkv')
    mediaFile('/mnt/m/old.mkv')

    await rulesPhase.run(ctx({ filesystem: completed() }))
    const run = runsFor('fs.orphan-media')
    expect(run?.status).toBe('not-evaluated')
    expect(run?.reason).toMatch(/jellyfin/)
  })

  it('treats a completed phase that landed no rows as unavailable, naming the empty table', async () => {
    mediaFile('/mnt/m/new.mkv')
    const run = await rulesPhase.run(ctx({ jellyfin: completed({ items: 0 }), filesystem: completed() }))
    expect(run.status).toBe('completed')
    const orphan = runsFor('fs.orphan-media')
    expect(orphan?.status).toBe('not-evaluated')
    expect(orphan?.reason).toMatch(/jellyfin_items/)
  })

  it('makes hashes unavailable when the filesystem phase did not complete, even if hashed rows survive from an earlier scan', async () => {
    staleItem('old', '/mnt/m/old.mkv')
    db.prepare(`INSERT INTO fs_entries (container_path, scan_id, parent_path, name, ext, is_dir,
      size_bytes, mtime, is_media, library_root, root_role, quick_hash)
      VALUES ('/mnt/m/old.mkv',1,'/mnt/m','old.mkv','.mkv',0,10,0,1,'/mnt/m','library','deadbeef')`).run()

    await rulesPhase.run(ctx({
      jellyfin: completed({ items: 1 }),
      filesystem: { status: 'skipped', reason: 'a root could not be read', counts: {} },
    }))

    const identical = runsFor('dupe.identical-file')
    expect(identical?.status).toBe('not-evaluated')
    expect(identical?.reason).toMatch(/filesystem/)
    // ...and the reason names the phase's own skip reason, not a guess about hashing.
    expect(identical?.reason).toMatch(/a root could not be read/)
  })

  it('reports hashes as unavailable, but the filesystem source as available, when the phase completed with no hashed rows', async () => {
    staleItem('old', '/mnt/m/old.mkv')
    mediaFile('/mnt/m/old.mkv')

    await rulesPhase.run(ctx({ jellyfin: completed({ items: 1 }), filesystem: completed({ entries: 1 }) }))

    expect(runsFor('dupe.identical-file')?.reason).toMatch(/quick_hash/)
    expect(runsFor('fs.orphan-media')?.status).toBe('evaluated')
  })

  it('counts the rules it could not evaluate in the phase result', async () => {
    const res = await rulesPhase.run(ctx({}))
    expect(res.counts.notEvaluated).toBeGreaterThan(0)
    expect(res.status).toBe('completed')
  })
})

describe('rulesPhase progress', () => {
  it('rules phase reports per-rule progress', async () => {
    staleItem('old', '/mnt/m/old.mkv')
    mediaFile('/mnt/m/old.mkv')
    const n = ALL_RULES.length
    const calls: Array<[number, number | null]> = []
    const landed: string[] = []
    const c = ctx({ jellyfin: completed({ items: 1 }), filesystem: completed({ entries: 1 }) })
    c.progress = (done, total) => {
      calls.push([done, total])
      if (done === 0) return
      // Reported after the rule's own work, evaluated or not, is in the index…
      const rule = ALL_RULES[done - 1]!
      if (runsFor(rule.id)) landed.push(rule.id)
      // …and while the pass is still one open transaction, so a failure part-way through rolls
      // the whole pass back rather than leaving some rules recorded and others not.
      expect(db.inTransaction).toBe(true)
    }
    await rulesPhase.run(c)
    expect(calls).toEqual(Array.from({ length: n + 1 }, (_v, i) => [i, n]))
    expect(landed).toEqual(ALL_RULES.map((r) => r.id))
    // Evaluated and not-evaluated rules alike: both kinds are in this pass.
    expect(runsFor('fs.orphan-media')?.status).toBe('evaluated')
    expect(runsFor('dupe.identical-file')?.status).toBe('not-evaluated')
  })

  it('reports the same counts as one pass over every rule', async () => {
    staleItem('old', '/mnt/m/old.mkv')
    mediaFile('/mnt/m/old.mkv')
    mediaFile('/mnt/m/new.mkv', 5_000_000_000)
    const priors = { jellyfin: completed({ items: 1 }), filesystem: completed({ entries: 2 }) }
    const res = await rulesPhase.run(ctx(priors))
    const availability = availableSources(db, priors)

    // The same scan replayed through one runRules call over the registry: every finding is
    // re-emitted, so nothing is created that the phase did not, and nothing is resolved.
    const once = runRules({
      db, config: fileConfigSchema.parse({}), scanId: 2,
      availableSources: availability.sources, sourceReasons: availability.reasons,
    })
    expect(res.counts).toEqual({
      created: once.created, resolved: 0, reopened: 0, notEvaluated: once.notEvaluated.length,
    })
  })
})
