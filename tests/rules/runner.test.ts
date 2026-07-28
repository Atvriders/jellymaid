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
