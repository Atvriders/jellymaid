import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../src/index/db.js'
import { runRules } from '../../src/rules/runner.js'
import { fileConfigSchema } from '../../src/config/schema.js'
import { findingId } from '../../src/core/types.js'
import type { Rule } from '../../src/rules/types.js'

let db: Db
const config = fileConfigSchema.parse({})

const ruleEmitting = (id: string, keys: string[]): Rule => ({
  id, class: 'filesystem', requires: ['filesystem'],
  run: () => keys.map((k) => ({
    id: findingId(id, k), ruleId: id, class: 'filesystem' as const, severity: 'warning' as const,
    confidence: 'exact' as const, subjects: [{ kind: 'path' as const, path: k, label: k }],
    evidence: {}, reclaimableBytes: null, status: 'open' as const, firstSeen: '', lastSeen: '',
  })),
})

beforeEach(() => { db = openDb(join(mkdtempSync(join(tmpdir(), 'jm-rules-')), 'db.sqlite')) })

describe('runRules', () => {
  it('persists findings and reports them created', () => {
    const summary = runRules({
      db, config, scanId: 1, availableSources: new Set(['filesystem']),
      rules: [ruleEmitting('fs.test', ['/a', '/b'])],
    })
    expect(summary.created).toBe(2)
    expect((db.prepare('SELECT COUNT(*) c FROM findings').get() as { c: number }).c).toBe(2)
  })

  it('records a rule as evaluated with zero findings — distinct from not evaluated', () => {
    runRules({ db, config, scanId: 1, availableSources: new Set(['filesystem']), rules: [ruleEmitting('fs.quiet', [])] })
    const row = db.prepare('SELECT status, found FROM rule_runs WHERE rule_id = ?').get('fs.quiet')
    expect(row).toEqual({ status: 'evaluated', found: 0 })
  })

  it('records not-evaluated with a reason when a required source is missing', () => {
    const summary = runRules({
      db, config, scanId: 1, availableSources: new Set([]),
      rules: [ruleEmitting('fs.blind', ['/a'])],
    })
    expect(summary.notEvaluated[0]!.ruleId).toBe('fs.blind')
    expect(summary.notEvaluated[0]!.reason).toContain('filesystem')
    const row = db.prepare('SELECT status FROM rule_runs WHERE rule_id = ?').get('fs.blind')
    expect(row).toEqual({ status: 'not-evaluated' })
    expect((db.prepare('SELECT COUNT(*) c FROM findings').get() as { c: number }).c).toBe(0)
  })

  it('does not resolve existing findings of a rule that could not be evaluated', () => {
    runRules({ db, config, scanId: 1, availableSources: new Set(['filesystem']), rules: [ruleEmitting('fs.test', ['/a'])] })
    runRules({ db, config, scanId: 2, availableSources: new Set([]), rules: [ruleEmitting('fs.test', ['/a'])] })
    const row = db.prepare('SELECT status FROM findings').get() as { status: string }
    expect(row.status).toBe('open')
  })

  it('bumps lastSeen and keeps firstSeen for a finding that persists', () => {
    runRules({ db, config, scanId: 1, now: 'T1', availableSources: new Set(['filesystem']), rules: [ruleEmitting('fs.test', ['/a'])] })
    runRules({ db, config, scanId: 2, now: 'T2', availableSources: new Set(['filesystem']), rules: [ruleEmitting('fs.test', ['/a'])] })
    const row = db.prepare('SELECT first_seen, last_seen FROM findings').get() as { first_seen: string; last_seen: string }
    expect(row).toEqual({ first_seen: 'T1', last_seen: 'T2' })
  })

  it('resolves a finding that disappears', () => {
    runRules({ db, config, scanId: 1, availableSources: new Set(['filesystem']), rules: [ruleEmitting('fs.test', ['/a'])] })
    const summary = runRules({ db, config, scanId: 2, availableSources: new Set(['filesystem']), rules: [ruleEmitting('fs.test', [])] })
    expect(summary.resolved).toBe(1)
    expect((db.prepare('SELECT status FROM findings').get() as { status: string }).status).toBe('resolved')
  })

  it('keeps a dismissed finding dismissed when it reappears', () => {
    runRules({ db, config, scanId: 1, availableSources: new Set(['filesystem']), rules: [ruleEmitting('fs.test', ['/a'])] })
    db.prepare("UPDATE findings SET status='dismissed', dismissed_reason='not a dupe', dismissed_by='bob'").run()
    runRules({ db, config, scanId: 2, availableSources: new Set(['filesystem']), rules: [ruleEmitting('fs.test', ['/a'])] })
    const row = db.prepare('SELECT status, dismissed_reason FROM findings').get() as { status: string; dismissed_reason: string }
    expect(row.status).toBe('dismissed')
    expect(row.dismissed_reason).toBe('not a dupe')
  })

  it('reopens a resolved finding that comes back', () => {
    runRules({ db, config, scanId: 1, availableSources: new Set(['filesystem']), rules: [ruleEmitting('fs.test', ['/a'])] })
    runRules({ db, config, scanId: 2, availableSources: new Set(['filesystem']), rules: [ruleEmitting('fs.test', [])] })
    const summary = runRules({ db, config, scanId: 3, availableSources: new Set(['filesystem']), rules: [ruleEmitting('fs.test', ['/a'])] })
    expect(summary.reopened).toBe(1)
    expect((db.prepare('SELECT status FROM findings').get() as { status: string }).status).toBe('open')
  })

  it('isolates a throwing rule — the others still run and it is recorded not-evaluated', () => {
    const boom: Rule = { id: 'fs.boom', class: 'filesystem', requires: ['filesystem'], run: () => { throw new Error('bad sql') } }
    const summary = runRules({
      db, config, scanId: 1, availableSources: new Set(['filesystem']),
      rules: [boom, ruleEmitting('fs.ok', ['/a'])],
    })
    expect(summary.created).toBe(1)
    expect(summary.notEvaluated[0]!.reason).toContain('bad sql')
  })

  it('isolates a rule that attempts a write — recorded not-evaluated, others still run, connection writable again', () => {
    const writer: Rule = {
      id: 'fs.writer', class: 'filesystem', requires: ['filesystem'],
      run: (ctx) => {
        ctx.db.prepare("INSERT INTO kv (key, value_json) VALUES ('should-not-exist', '1')").run()
        return []
      },
    }
    const summary = runRules({
      db, config, scanId: 1, availableSources: new Set(['filesystem']),
      rules: [writer, ruleEmitting('fs.ok', ['/a'])],
    })

    expect(summary.notEvaluated[0]!.ruleId).toBe('fs.writer')
    expect(summary.notEvaluated[0]!.reason).toMatch(/readonly|write/i)
    expect(summary.evaluated).toEqual(['fs.ok'])
    expect(summary.created).toBe(1)

    // The attempted write never landed.
    expect(db.prepare("SELECT 1 FROM kv WHERE key = 'should-not-exist'").get()).toBeUndefined()

    // query_only must not leak past the throwing rule, past runRules() returning, or block a
    // genuine write: prove it with a real insert that persists, not just a pragma readback.
    expect(db.pragma('query_only', { simple: true })).toBe(0)
    db.prepare("INSERT INTO kv (key, value_json) VALUES ('probe', '1')").run()
    expect((db.prepare("SELECT value_json FROM kv WHERE key = 'probe'").get() as { value_json: string }).value_json).toBe('1')
  })

  it('a throwing rule leaves the whole pass consistent — every rule that ran gets exactly one rule_runs row, no finding half-written', () => {
    const boom: Rule = { id: 'fs.boom', class: 'filesystem', requires: ['filesystem'], run: () => { throw new Error('kaboom') } }
    const summary = runRules({
      db, config, scanId: 1, availableSources: new Set(['filesystem']),
      rules: [ruleEmitting('fs.first', ['/a']), boom, ruleEmitting('fs.last', ['/b'])],
    })

    expect([...summary.evaluated].sort()).toEqual(['fs.first', 'fs.last'])
    expect(summary.notEvaluated.map((n) => n.ruleId)).toEqual(['fs.boom'])

    const runs = db.prepare('SELECT rule_id, status FROM rule_runs WHERE scan_id = 1 ORDER BY rule_id').all()
    expect(runs).toEqual([
      { rule_id: 'fs.boom', status: 'not-evaluated' },
      { rule_id: 'fs.first', status: 'evaluated' },
      { rule_id: 'fs.last', status: 'evaluated' },
    ])

    const findingRuleIds = (db.prepare('SELECT rule_id FROM findings ORDER BY rule_id').all() as Array<{ rule_id: string }>)
      .map((r) => r.rule_id)
    expect(findingRuleIds).toEqual(['fs.first', 'fs.last'])
  })
})

describe('runRules — persist hook', () => {
  it('a rule with no persist behaves exactly as before', () => {
    const summary = runRules({
      db, config, scanId: 1, availableSources: new Set(['filesystem']),
      rules: [ruleEmitting('fs.plain', ['/a'])],
    })
    expect(summary.evaluated).toEqual(['fs.plain'])
    expect(summary.created).toBe(1)
    const row = db.prepare('SELECT status FROM rule_runs WHERE rule_id = ?').get('fs.plain')
    expect(row).toEqual({ status: 'evaluated' })
  })

  it("runs a rule's persist step after query_only is back off, and its write lands", () => {
    const persisting: Rule = {
      id: 'fs.persisting', class: 'filesystem', requires: ['filesystem'],
      run: () => [],
      persist: (ctx) => {
        ctx.db.prepare("INSERT INTO kv (key, value_json) VALUES ('persisted', '1')").run()
      },
    }
    runRules({ db, config, scanId: 1, availableSources: new Set(['filesystem']), rules: [persisting] })
    const row = db.prepare("SELECT value_json FROM kv WHERE key = 'persisted'").get() as { value_json: string } | undefined
    expect(row?.value_json).toBe('1')
  })

  it('isolates a rule whose persist step throws — not-evaluated with the error, its findings never land, other rules still run, connection writable after', () => {
    const badPersist: Rule = {
      id: 'fs.badpersist', class: 'filesystem', requires: ['filesystem'],
      run: () => [{
        id: findingId('fs.badpersist', 'x'), ruleId: 'fs.badpersist', class: 'filesystem' as const,
        severity: 'warning' as const, confidence: 'exact' as const,
        subjects: [{ kind: 'path' as const, path: '/x', label: '/x' }],
        evidence: {}, reclaimableBytes: null, status: 'open' as const, firstSeen: '', lastSeen: '',
      }],
      persist: () => { throw new Error('persist exploded') },
    }
    const summary = runRules({
      db, config, scanId: 1, availableSources: new Set(['filesystem']),
      rules: [badPersist, ruleEmitting('fs.ok', ['/a'])],
    })

    expect(summary.notEvaluated).toEqual([{ ruleId: 'fs.badpersist', reason: 'rule threw: persist exploded' }])
    expect(summary.evaluated).toEqual(['fs.ok'])
    expect(summary.created).toBe(1)
    expect(db.prepare("SELECT 1 FROM findings WHERE rule_id = 'fs.badpersist'").get()).toBeUndefined()

    // query_only must not leak past a persist failure, exactly as it must not past a run() failure.
    expect(db.pragma('query_only', { simple: true })).toBe(0)
    db.prepare("INSERT INTO kv (key, value_json) VALUES ('probe2', '1')").run()
    expect((db.prepare("SELECT value_json FROM kv WHERE key = 'probe2'").get() as { value_json: string }).value_json).toBe('1')
  })

  it('keeps the pass consistent when a rule succeeds (with persist) and a later rule throws — one rule_runs row each, no partial findings', () => {
    const good: Rule = {
      id: 'fs.good', class: 'filesystem', requires: ['filesystem'],
      run: () => [{
        id: findingId('fs.good', 'g'), ruleId: 'fs.good', class: 'filesystem' as const,
        severity: 'info' as const, confidence: 'exact' as const,
        subjects: [{ kind: 'path' as const, path: '/g', label: '/g' }],
        evidence: {}, reclaimableBytes: null, status: 'open' as const, firstSeen: '', lastSeen: '',
      }],
      persist: (ctx) => {
        ctx.db.prepare("INSERT INTO kv (key, value_json) VALUES ('good-persisted', '1')").run()
      },
    }
    const boom: Rule = { id: 'fs.boom2', class: 'filesystem', requires: ['filesystem'], run: () => { throw new Error('late kaboom') } }

    const summary = runRules({
      db, config, scanId: 1, availableSources: new Set(['filesystem']),
      rules: [good, boom],
    })

    expect(summary.evaluated).toEqual(['fs.good'])
    expect(summary.notEvaluated.map((n) => n.ruleId)).toEqual(['fs.boom2'])

    const runs = db.prepare('SELECT rule_id, status FROM rule_runs WHERE scan_id = 1 ORDER BY rule_id').all()
    expect(runs).toEqual([
      { rule_id: 'fs.boom2', status: 'not-evaluated' },
      { rule_id: 'fs.good', status: 'evaluated' },
    ])

    const row = db.prepare("SELECT value_json FROM kv WHERE key = 'good-persisted'").get()
    expect(row).toEqual({ value_json: '1' })

    const findingRuleIds = (db.prepare('SELECT rule_id FROM findings ORDER BY rule_id').all() as Array<{ rule_id: string }>)
      .map((r) => r.rule_id)
    expect(findingRuleIds).toEqual(['fs.good'])
  })
})

describe('runRules — subRuns hook', () => {
  it('a rule with no subRuns behaves exactly as before', () => {
    const summary = runRules({
      db, config, scanId: 1, availableSources: new Set(['filesystem']),
      rules: [ruleEmitting('fs.plain2', ['/a'])],
    })
    expect(summary.evaluated).toEqual(['fs.plain2'])
    const runs = db.prepare('SELECT rule_id FROM rule_runs WHERE scan_id = 1').all()
    expect(runs).toEqual([{ rule_id: 'fs.plain2' }])
  })

  it("writes a rule's subRuns entries into rule_runs alongside its own row", () => {
    const withSubRuns: Rule = {
      id: 'fs.parent', class: 'filesystem', requires: ['filesystem'],
      run: () => [],
      subRuns: () => [
        { ruleId: 'fs.parent.child-a', status: 'evaluated', found: 3 },
        { ruleId: 'fs.parent.child-b', status: 'not-evaluated', reason: 'disabled' },
      ],
    }
    runRules({ db, config, scanId: 1, availableSources: new Set(['filesystem']), rules: [withSubRuns] })
    const runs = db.prepare('SELECT rule_id, status, reason, found FROM rule_runs WHERE scan_id = 1 ORDER BY rule_id').all()
    expect(runs).toEqual([
      { rule_id: 'fs.parent', status: 'evaluated', reason: null, found: 0 },
      { rule_id: 'fs.parent.child-a', status: 'evaluated', reason: null, found: 3 },
      { rule_id: 'fs.parent.child-b', status: 'not-evaluated', reason: 'disabled', found: 0 },
    ])
  })

  it('calls subRuns under the same read-only window as run() — a write inside it is rejected exactly like one inside run()', () => {
    const badSubRuns: Rule = {
      id: 'fs.badsubruns', class: 'filesystem', requires: ['filesystem'],
      run: () => [],
      subRuns: (ctx) => {
        ctx.db.prepare("INSERT INTO kv (key, value_json) VALUES ('should-not-exist-2', '1')").run()
        return []
      },
    }
    const summary = runRules({ db, config, scanId: 1, availableSources: new Set(['filesystem']), rules: [badSubRuns] })
    expect(summary.notEvaluated[0]!.ruleId).toBe('fs.badsubruns')
    expect(summary.notEvaluated[0]!.reason).toMatch(/readonly|write/i)
    expect(db.prepare("SELECT 1 FROM kv WHERE key = 'should-not-exist-2'").get()).toBeUndefined()
  })

  it("does not write a rule's subRuns entries when its own persist step throws afterward", () => {
    const badPersistWithSubRuns: Rule = {
      id: 'fs.badpersist2', class: 'filesystem', requires: ['filesystem'],
      run: () => [],
      subRuns: () => [{ ruleId: 'fs.badpersist2.child', status: 'evaluated', found: 1 }],
      persist: () => { throw new Error('boom') },
    }
    runRules({ db, config, scanId: 1, availableSources: new Set(['filesystem']), rules: [badPersistWithSubRuns] })
    const runs = db.prepare('SELECT rule_id, status FROM rule_runs WHERE scan_id = 1').all()
    expect(runs).toEqual([{ rule_id: 'fs.badpersist2', status: 'not-evaluated' }])
  })
})
