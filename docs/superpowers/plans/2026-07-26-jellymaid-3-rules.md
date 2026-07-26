# Jellymaid Plan 3 — Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the populated index into findings — duplicates with confidence tiers and a scored keeper, filesystem rot, metadata gaps, quality outliers — reconciled across rescans so dismissals stick, and with every rule that could not run recorded as *not evaluated* rather than zero.

**Architecture:** A rule is a pure function `(ctx: RuleContext) => Finding[]` that reads SQLite and touches nothing else. Rules declare the snapshot sources they require; the runner skips and records any rule whose sources are missing. Duplicate rules emit *links*, and a separate union-find pass turns links into groups, so adding a seventh matching heuristic later needs no change to grouping.

**Tech Stack:** Node 22 · TypeScript strict · better-sqlite3 · Vitest

## Global Constraints

Copied verbatim from `docs/superpowers/specs/2026-07-26-jellymaid-design.md`. Every task's requirements implicitly include this section.

- **Degraded means "not evaluated", never "zero".** Every rule declares its required sources; the runner records `rule_runs.status = 'not-evaluated'` with a reason when they are absent.
- Every threshold is configuration, never a literal buried in a rule.
- Finding ids are stable across rescans (`findingId(ruleId, subjectKey)` from Plan 1) — dismissals must survive.
- Rules are **pure and read-only**. A rule that writes to the database, calls a connector, or touches the filesystem is a defect.
- `.jellymaid-trash` never appears in a finding; the walker already excluded it, and no rule may reintroduce it.
- Quality rules are informational only — they never produce a destructive action.
- TypeScript strict, no `any`. Commit after every task.

## Prerequisites

Plans 1 and 2 complete. The index tables (`jellyfin_items`, `fs_entries`, `torrents`, `torrent_files`, `arr_records`, `rule_runs`, `findings`, `dupe_groups`) exist and a real scan populates them.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/rules/normalize.ts` | Title normalization shared by every duplicate rule |
| `src/rules/types.ts` | `Rule`, `RuleContext`, `DupeLink`, source declarations |
| `src/rules/registry.ts` | The rule list and lookup |
| `src/rules/runner.ts` | Runs rules, records `rule_runs`, reconciles `findings` |
| `src/rules/dupes/*.ts` | The six duplicate rules |
| `src/rules/grouping.ts` | Union-find over links → `dupe_groups` |
| `src/rules/keeper.ts` | Keeper scoring |
| `src/rules/filesystem/*.ts` | The six filesystem rules |
| `src/rules/metadata/*.ts` | The six metadata rules |
| `src/rules/quality/*.ts` | The five quality rules |
| `src/scan/phases/rules.ts` | Phase 5, wiring the runner into a scan |
| `src/api/findings.ts` | `/api/findings/*` and `/api/duplicates` |

---

### Task 1: Title normalization

**Files:**
- Create: `src/rules/normalize.ts`
- Test: `tests/rules/normalize.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `normalizeTitle(raw: string): string` · `trigramSimilarity(a: string, b: string): number` (0–1, Dice coefficient over normalized trigrams).

- [ ] **Step 1: Write the failing test**

```ts
// tests/rules/normalize.test.ts
import { describe, it, expect } from 'vitest'
import { normalizeTitle, trigramSimilarity } from '../../src/rules/normalize.js'

describe('normalizeTitle', () => {
  const cases: Array<[string, string]> = [
    ['Heat', 'heat'],
    ['The Matrix', 'matrix'],
    ['A Quiet Place', 'quiet place'],
    ['Heat (1995)', 'heat'],
    ['Heat.1995.1080p.BluRay.x264-GROUP', 'heat'],
    ['Heat 1995 2160p UHD BluRay REMUX HDR HEVC DTS-HD MA 5.1-FraMeSToR', 'heat'],
    ['Spider-Man: No Way Home', 'spider man no way home'],
    ['WALL·E', 'wall e'],
    ['Amélie', 'amelie'],
    ['Mission: Impossible — Fallout', 'mission impossible fallout'],
    ['   Extra   Spaces   ', 'extra spaces'],
    ['Blade Runner 2049', 'blade runner 2049'],
  ]
  for (const [input, expected] of cases) {
    it(`normalizes ${JSON.stringify(input)}`, () => expect(normalizeTitle(input)).toBe(expected))
  }

  it('keeps a year that is part of the title, but strips a trailing release year', () => {
    expect(normalizeTitle('2012 (2009)')).toBe('2012')
    expect(normalizeTitle('Blade Runner 2049 (2017)')).toBe('blade runner 2049')
  })

  it('returns an empty string for input that is only noise', () => {
    expect(normalizeTitle('(2019) [1080p]')).toBe('')
  })
})

describe('trigramSimilarity', () => {
  it('is 1 for identical strings', () => {
    expect(trigramSimilarity('the matrix', 'the matrix')).toBe(1)
  })

  it('is high for near-identical titles', () => {
    expect(trigramSimilarity('the lord of the rings', 'lord of the rings')).toBeGreaterThan(0.8)
  })

  it('is low for unrelated titles', () => {
    expect(trigramSimilarity('heat', 'frozen')).toBeLessThan(0.3)
  })

  it('is 0 when either side is empty', () => {
    expect(trigramSimilarity('', 'heat')).toBe(0)
  })

  it('is symmetric', () => {
    expect(trigramSimilarity('alien', 'aliens')).toBe(trigramSimilarity('aliens', 'alien'))
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/rules/normalize.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement normalization**

```ts
// src/rules/normalize.ts
const RELEASE_TOKENS = new Set([
  '1080p', '720p', '480p', '2160p', '4k', 'uhd', 'hdr', 'hdr10', 'dv', 'sdr',
  'bluray', 'blu', 'ray', 'bdrip', 'brrip', 'dvdrip', 'webrip', 'web', 'webdl', 'hdtv', 'remux',
  'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'xvid', 'divx', 'av1',
  'aac', 'ac3', 'dts', 'hd', 'ma', 'truehd', 'atmos', 'ddp', 'dd', 'eac3', 'flac',
  'proper', 'repack', 'internal', 'limited', 'extended', 'unrated', 'imax', 'directors', 'cut',
])

const ARTICLES = new Set(['the', 'a', 'an'])

/**
 * Collapses a display or filename title to a comparison key.
 *
 * The subtle rule is the trailing year. "Heat.1995.1080p..." must lose its year, but
 * "Blade Runner 2049" must keep it — the year IS the title. The tell is whether the
 * string looks like a release name at all: dot/underscore separators, or a release
 * token we broke on. A clean display title keeps every token.
 */
export function normalizeTitle(raw: string): string {
  const looksLikeFilename = /[._]/.test(raw)

  let s = raw.normalize('NFKD').replace(/[̀-ͯ]/g, '')     // strip diacritics
  s = s.toLowerCase()
  s = s.replace(/\[[^\]]*\]/g, ' ')                                 // [1080p]
  s = s.replace(/\((?:19|20)\d{2}\)/g, ' ')                         // (1995)
  s = s.replace(/-[a-z0-9]+\s*$/i, ' ')                             // -GROUP suffix
  s = s.replace(/[._]/g, ' ')
  s = s.replace(/[^a-z0-9\s]/g, ' ')

  const tokens = s.split(/\s+/).filter(Boolean)
  const kept: string[] = []
  let brokeOnReleaseToken = false
  for (const t of tokens) {
    if (RELEASE_TOKENS.has(t)) {
      // Everything after the first release token is scene noise.
      brokeOnReleaseToken = true
      break
    }
    kept.push(t)
  }

  if ((looksLikeFilename || brokeOnReleaseToken) && kept.length > 1) {
    const last = kept[kept.length - 1]!
    if (/^(?:19|20)\d{2}$/.test(last)) kept.pop()
  }

  // "Matrix, The" is the same film as "The Matrix": drop a leading or trailing article.
  while (kept.length > 1 && ARTICLES.has(kept[kept.length - 1]!)) kept.pop()
  while (kept.length > 1 && ARTICLES.has(kept[0]!)) kept.shift()
  if (kept.length === 1 && ARTICLES.has(kept[0]!)) return ''

  return kept.join(' ').trim()
}

function trigrams(s: string): Set<string> {
  const padded = `  ${s} `
  const out = new Set<string>()
  for (let i = 0; i < padded.length - 2; i += 1) out.add(padded.slice(i, i + 3))
  return out
}

export function trigramSimilarity(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1
  const ta = trigrams(a)
  const tb = trigrams(b)
  let shared = 0
  for (const g of ta) if (tb.has(g)) shared += 1
  return (2 * shared) / (ta.size + tb.size)
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run tests/rules/normalize.test.ts && npm run typecheck`
Expected: 19 tests PASS. If a normalization case fails, fix `normalize.ts` — never weaken the test.

- [ ] **Step 5: Commit**

```bash
git add src/rules/normalize.ts tests/rules/normalize.test.ts
git commit -m "feat: title normalization and trigram similarity"
```

---

### Task 2: Rule contract, registry and runner

**Files:**
- Create: `src/rules/types.ts`, `src/rules/registry.ts`, `src/rules/runner.ts`
- Test: `tests/rules/runner.test.ts`

**Interfaces:**
- Consumes: `Finding`, `findingId` (Plan 1), `Db`.
- Produces:
  - `interface Rule { id: RuleId; class: FindingClass; requires: SourceName[]; run(ctx: RuleContext): Finding[] }`
  - `SourceName = 'jellyfin' | 'filesystem' | 'qbittorrent' | 'arr' | 'hashes'`
  - `RuleContext = { db: Db; config: FileConfig; scanId: number; now: string }`
  - `runRules(opts: { db; config; scanId; now?; rules?; availableSources }): RuleRunSummary`
  - `RuleRunSummary = { evaluated: string[]; notEvaluated: Array<{ ruleId; reason }>; created: number; resolved: number; reopened: number }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/rules/runner.test.ts
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
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/rules/runner.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the rule contract and runner**

```ts
// src/rules/types.ts
import type { Db } from '../index/db.js'
import type { FileConfig } from '../config/schema.js'
import type { Finding, FindingClass, RuleId } from '../core/types.js'

export type SourceName = 'jellyfin' | 'filesystem' | 'qbittorrent' | 'arr' | 'hashes'

export interface RuleContext {
  db: Db
  config: FileConfig
  scanId: number
  now: string
}

export interface Rule {
  id: RuleId
  class: FindingClass
  requires: SourceName[]
  run(ctx: RuleContext): Finding[]
}

/** Duplicate rules emit links; grouping is a separate concern. */
export interface DupeLink {
  ruleId: RuleId
  a: string
  b: string
  confidence: 'exact' | 'strong' | 'possible'
  evidence: Record<string, unknown>
}

export interface DupeRule {
  id: RuleId
  requires: SourceName[]
  link(ctx: RuleContext): DupeLink[]
}
```

```ts
// src/rules/runner.ts
import type { Db } from '../index/db.js'
import type { FileConfig } from '../config/schema.js'
import type { Rule, SourceName } from './types.js'
import { ALL_RULES } from './registry.js'

export interface RuleRunSummary {
  evaluated: string[]
  notEvaluated: Array<{ ruleId: string; reason: string }>
  created: number
  resolved: number
  reopened: number
}

export function runRules(opts: {
  db: Db
  config: FileConfig
  scanId: number
  availableSources: Set<SourceName>
  rules?: Rule[]
  now?: string
}): RuleRunSummary {
  const { db } = opts
  const now = opts.now ?? new Date().toISOString()
  const rules = opts.rules ?? ALL_RULES
  const summary: RuleRunSummary = { evaluated: [], notEvaluated: [], created: 0, resolved: 0, reopened: 0 }

  const upsert = db.prepare(`INSERT INTO findings
    (id, rule_id, class, severity, confidence, subjects_json, evidence_json, reclaimable_bytes,
     status, first_seen, last_seen)
    VALUES (@id, @ruleId, @class, @severity, @confidence, @subjects, @evidence, @reclaimable,
            'open', @now, @now)
    ON CONFLICT(id) DO UPDATE SET
      last_seen = @now,
      severity = @severity,
      confidence = @confidence,
      subjects_json = @subjects,
      evidence_json = @evidence,
      reclaimable_bytes = @reclaimable,
      status = CASE findings.status WHEN 'dismissed' THEN 'dismissed' ELSE 'open' END`)

  const recordRun = db.prepare(`INSERT OR REPLACE INTO rule_runs
    (scan_id, rule_id, status, reason, found, duration_ms) VALUES (?,?,?,?,?,?)`)

  const countReopened = db.prepare(
    "SELECT COUNT(*) c FROM findings WHERE id = ? AND status = 'resolved'",
  )

  for (const rule of rules) {
    const missing = rule.requires.filter((r) => !opts.availableSources.has(r))
    if (missing.length) {
      const reason = `required sources unavailable: ${missing.join(', ')}`
      recordRun.run(opts.scanId, rule.id, 'not-evaluated', reason, 0, 0)
      summary.notEvaluated.push({ ruleId: rule.id, reason })
      continue
    }

    const started = Date.now()
    let findings
    try {
      findings = rule.run({ db, config: opts.config, scanId: opts.scanId, now })
    } catch (err) {
      const reason = `rule threw: ${(err as Error).message}`
      recordRun.run(opts.scanId, rule.id, 'not-evaluated', reason, 0, Date.now() - started)
      summary.notEvaluated.push({ ruleId: rule.id, reason })
      continue
    }

    const write = db.transaction(() => {
      for (const f of findings) {
        const wasResolved = (countReopened.get(f.id) as { c: number }).c > 0
        upsert.run({
          id: f.id, ruleId: f.ruleId, class: f.class, severity: f.severity, confidence: f.confidence,
          subjects: JSON.stringify(f.subjects), evidence: JSON.stringify(f.evidence),
          reclaimable: f.reclaimableBytes, now,
        })
        if (wasResolved) summary.reopened += 1
      }
    })
    write()

    summary.created += findings.length
    summary.evaluated.push(rule.id)
    recordRun.run(opts.scanId, rule.id, 'evaluated', null, findings.length, Date.now() - started)
  }

  // Only rules that actually ran may resolve their own stale findings. A rule that could not be
  // evaluated leaves its previous findings untouched — absence of evidence is not evidence of absence.
  if (summary.evaluated.length) {
    const placeholders = summary.evaluated.map(() => '?').join(',')
    const info = db.prepare(
      `UPDATE findings SET status='resolved'
       WHERE status='open' AND last_seen != ? AND rule_id IN (${placeholders})`,
    ).run(now, ...summary.evaluated)
    summary.resolved = info.changes
  }

  return summary
}
```

```ts
// src/rules/registry.ts
import type { Rule } from './types.js'

/** Populated task by task; grouping and keeper scoring are not rules and are not listed here. */
export const ALL_RULES: Rule[] = []

export function ruleById(id: string): Rule | undefined {
  return ALL_RULES.find((r) => r.id === id)
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run tests/rules/runner.test.ts && npm run typecheck`
Expected: 9 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/rules/types.ts src/rules/registry.ts src/rules/runner.ts tests/rules/runner.test.ts
git commit -m "feat: rule contract, registry and reconciling runner"
```

---

### Task 3: Duplicate rules and grouping

**Files:**
- Create: `src/rules/dupes/index.ts`, `src/rules/grouping.ts`
- Modify: `src/rules/registry.ts`
- Test: `tests/rules/dupes.test.ts`, `tests/rules/grouping.test.ts`

**Interfaces:**
- Consumes: `DupeRule`, `DupeLink`, `normalizeTitle`, `trigramSimilarity`.
- Produces:
  - `DUPE_RULES: DupeRule[]` — the six rules.
  - `buildDupeGroups(links: DupeLink[]): DupeGroup[]` where `DupeGroup = { id: string; tier: Confidence; memberIds: string[]; links: DupeLink[] }`
  - `dupeRulesAsRules(): Rule[]` — adapter emitting one `Finding` per group, so groups flow through the same findings pipeline.

- [ ] **Step 1: Write the failing dupe test**

```ts
// tests/rules/dupes.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../src/index/db.js'
import { DUPE_RULES } from '../../src/rules/dupes/index.js'
import { fileConfigSchema } from '../../src/config/schema.js'

let db: Db
const config = fileConfigSchema.parse({})
const ctx = () => ({ db, config, scanId: 1, now: 'T' })
const rule = (id: string) => DUPE_RULES.find((r) => r.id === id)!

function item(over: Partial<Record<string, unknown>> = {}) {
  const base = {
    id: 'i1', scan_id: 1, type: 'Movie', name: 'Heat', year: 1995, provider_ids_json: '{}',
    jf_path: '/media/Movies/Heat.mkv', container_path: '/mnt/m/Heat.mkv', size_bytes: 100,
    runtime_ticks: 106_920_000_000, series_id: null, season_no: null, episode_no: null,
    has_primary_image: 1,
  }
  const row = { ...base, ...over }
  db.prepare(`INSERT INTO jellyfin_items
    (id, scan_id, type, name, year, provider_ids_json, jf_path, container_path, size_bytes,
     runtime_ticks, series_id, season_no, episode_no, has_primary_image)
    VALUES (@id,@scan_id,@type,@name,@year,@provider_ids_json,@jf_path,@container_path,
            @size_bytes,@runtime_ticks,@series_id,@season_no,@episode_no,@has_primary_image)`).run(row)
  return row
}

beforeEach(() => { db = openDb(join(mkdtempSync(join(tmpdir(), 'jm-dupe-')), 'db.sqlite')) })

describe('dupe.provider-id', () => {
  it('links two items sharing a tmdb id', () => {
    item({ id: 'a', provider_ids_json: '{"tmdb":"949"}' })
    item({ id: 'b', provider_ids_json: '{"tmdb":"949"}' })
    const links = rule('dupe.provider-id').link(ctx())
    expect(links).toHaveLength(1)
    expect([links[0]!.a, links[0]!.b].sort()).toEqual(['a', 'b'])
    expect(links[0]!.confidence).toBe('exact')
  })

  it('does not link across different provider namespaces with equal numbers', () => {
    item({ id: 'a', provider_ids_json: '{"tmdb":"1"}' })
    item({ id: 'b', provider_ids_json: '{"tvdb":"1"}' })
    expect(rule('dupe.provider-id').link(ctx())).toHaveLength(0)
  })

  it('ignores items with no provider ids', () => {
    item({ id: 'a' }); item({ id: 'b' })
    expect(rule('dupe.provider-id').link(ctx())).toHaveLength(0)
  })

  it('links all pairs in a triple', () => {
    for (const id of ['a', 'b', 'c']) item({ id, provider_ids_json: '{"imdb":"tt1"}' })
    expect(rule('dupe.provider-id').link(ctx())).toHaveLength(3)
  })
})

describe('dupe.series-episode', () => {
  it('links two files of the same episode', () => {
    item({ id: 'a', type: 'Episode', series_id: 's1', season_no: 1, episode_no: 1 })
    item({ id: 'b', type: 'Episode', series_id: 's1', season_no: 1, episode_no: 1 })
    expect(rule('dupe.series-episode').link(ctx())).toHaveLength(1)
  })

  it('does not link different episodes or different series', () => {
    item({ id: 'a', type: 'Episode', series_id: 's1', season_no: 1, episode_no: 1 })
    item({ id: 'b', type: 'Episode', series_id: 's1', season_no: 1, episode_no: 2 })
    item({ id: 'c', type: 'Episode', series_id: 's2', season_no: 1, episode_no: 1 })
    expect(rule('dupe.series-episode').link(ctx())).toHaveLength(0)
  })

  it('ignores episodes with a null season', () => {
    item({ id: 'a', type: 'Episode', series_id: 's1', season_no: null, episode_no: 1 })
    item({ id: 'b', type: 'Episode', series_id: 's1', season_no: null, episode_no: 1 })
    expect(rule('dupe.series-episode').link(ctx())).toHaveLength(0)
  })
})

describe('dupe.title-year', () => {
  it('links items whose normalized title and year agree', () => {
    item({ id: 'a', name: 'The Matrix', year: 1999 })
    item({ id: 'b', name: 'Matrix, The (1999)', year: 1999 })
    expect(rule('dupe.title-year').link(ctx())[0]!.confidence).toBe('strong')
  })

  it('does not link the same title in different years', () => {
    item({ id: 'a', name: 'Dune', year: 1984 })
    item({ id: 'b', name: 'Dune', year: 2021 })
    expect(rule('dupe.title-year').link(ctx())).toHaveLength(0)
  })

  it('skips items with no year rather than grouping every yearless item together', () => {
    item({ id: 'a', name: 'Dune', year: null })
    item({ id: 'b', name: 'Dune', year: null })
    expect(rule('dupe.title-year').link(ctx())).toHaveLength(0)
  })
})

describe('dupe.runtime', () => {
  it('links same-title items within the tolerance', () => {
    item({ id: 'a', name: 'Heat', year: null, runtime_ticks: 106_920_000_000 })
    item({ id: 'b', name: 'Heat', year: null, runtime_ticks: 106_930_000_000 })
    expect(rule('dupe.runtime').link(ctx())).toHaveLength(1)
  })

  it('does not link when runtimes differ beyond the tolerance', () => {
    item({ id: 'a', name: 'Heat', runtime_ticks: 106_920_000_000 })
    item({ id: 'b', name: 'Heat', runtime_ticks: 206_920_000_000 })
    expect(rule('dupe.runtime').link(ctx())).toHaveLength(0)
  })
})

describe('dupe.identical-file', () => {
  it('links items whose files share size and quick hash', () => {
    item({ id: 'a', container_path: '/mnt/m/A.mkv', size_bytes: 100 })
    item({ id: 'b', container_path: '/mnt/n/B.mkv', size_bytes: 100 })
    for (const [p, h] of [['/mnt/m/A.mkv', 'deadbeef'], ['/mnt/n/B.mkv', 'deadbeef']] as const) {
      db.prepare(`INSERT INTO fs_entries (container_path, scan_id, parent_path, name, is_dir, size_bytes, quick_hash, is_media)
        VALUES (?,1,'/','x',0,100,?,1)`).run(p, h)
    }
    expect(rule('dupe.identical-file').link(ctx())[0]!.confidence).toBe('exact')
  })

  it('does not link when hashes differ despite equal size', () => {
    item({ id: 'a', container_path: '/mnt/m/A.mkv', size_bytes: 100 })
    item({ id: 'b', container_path: '/mnt/n/B.mkv', size_bytes: 100 })
    for (const [p, h] of [['/mnt/m/A.mkv', 'aaa'], ['/mnt/n/B.mkv', 'bbb']] as const) {
      db.prepare(`INSERT INTO fs_entries (container_path, scan_id, parent_path, name, is_dir, size_bytes, quick_hash, is_media)
        VALUES (?,1,'/','x',0,100,?,1)`).run(p, h)
    }
    expect(rule('dupe.identical-file').link(ctx())).toHaveLength(0)
  })

  it('declares hashes as a required source', () => {
    expect(rule('dupe.identical-file').requires).toContain('hashes')
  })
})

describe('dupe.fuzzy-title', () => {
  it('links near-identical but non-identical titles above the configured similarity', () => {
    // Deliberately NOT an exact-key pair: identical keys belong to dupe.title-year,
    // and the fuzzy rule skips them so the same pair is not reported twice.
    item({ id: 'a', name: 'The Hobbit', year: 2012 })
    item({ id: 'b', name: 'The Hobbits', year: 2012 })
    const links = rule('dupe.fuzzy-title').link({ ...ctx(), config: fileConfigSchema.parse({ rules: { 'dupe.fuzzy-title': { similarity: 0.7 } } }) })
    expect(links[0]!.confidence).toBe('possible')
  })

  it('respects a raised threshold', () => {
    item({ id: 'a', name: 'Alien' })
    item({ id: 'b', name: 'Aliens' })
    const strict = fileConfigSchema.parse({ rules: { 'dupe.fuzzy-title': { similarity: 0.99 } } })
    expect(rule('dupe.fuzzy-title').link({ ...ctx(), config: strict })).toHaveLength(0)
  })

  it('can be disabled entirely', () => {
    item({ id: 'a', name: 'Alien' }); item({ id: 'b', name: 'Aliens' })
    const off = fileConfigSchema.parse({ rules: { 'dupe.fuzzy-title': { enabled: false } } })
    expect(rule('dupe.fuzzy-title').link({ ...ctx(), config: off })).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Write the failing grouping test**

```ts
// tests/rules/grouping.test.ts
import { describe, it, expect } from 'vitest'
import { buildDupeGroups } from '../../src/rules/grouping.js'
import type { DupeLink } from '../../src/rules/types.js'

const link = (a: string, b: string, confidence: DupeLink['confidence'], ruleId = 'dupe.test'): DupeLink =>
  ({ ruleId, a, b, confidence, evidence: {} })

describe('buildDupeGroups', () => {
  it('merges transitively linked items into one group', () => {
    const groups = buildDupeGroups([link('a', 'b', 'exact'), link('b', 'c', 'strong')])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.memberIds.sort()).toEqual(['a', 'b', 'c'])
  })

  it('keeps unrelated pairs in separate groups', () => {
    const groups = buildDupeGroups([link('a', 'b', 'exact'), link('c', 'd', 'exact')])
    expect(groups).toHaveLength(2)
  })

  it('takes the strongest tier that formed the group', () => {
    expect(buildDupeGroups([link('a', 'b', 'possible'), link('b', 'c', 'exact')])[0]!.tier).toBe('exact')
    expect(buildDupeGroups([link('a', 'b', 'possible'), link('b', 'c', 'strong')])[0]!.tier).toBe('strong')
    expect(buildDupeGroups([link('a', 'b', 'possible')])[0]!.tier).toBe('possible')
  })

  it('produces a stable id independent of link order', () => {
    const one = buildDupeGroups([link('a', 'b', 'exact'), link('b', 'c', 'exact')])[0]!
    const two = buildDupeGroups([link('c', 'b', 'exact'), link('b', 'a', 'exact')])[0]!
    expect(one.id).toBe(two.id)
  })

  it('carries every contributing link for evidence display', () => {
    const groups = buildDupeGroups([link('a', 'b', 'exact', 'dupe.provider-id'), link('a', 'b', 'strong', 'dupe.title-year')])
    expect(groups[0]!.links.map((l) => l.ruleId).sort()).toEqual(['dupe.provider-id', 'dupe.title-year'])
  })

  it('returns nothing for no links', () => {
    expect(buildDupeGroups([])).toEqual([])
  })

  it('never emits a single-member group', () => {
    expect(buildDupeGroups([link('a', 'a', 'exact')])).toEqual([])
  })
})
```

- [ ] **Step 3: Run both and confirm they fail**

Run: `npx vitest run tests/rules/dupes.test.ts tests/rules/grouping.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement grouping**

```ts
// src/rules/grouping.ts
import { createHash } from 'node:crypto'
import type { Confidence } from '../core/types.js'
import type { DupeLink } from './types.js'

export interface DupeGroup {
  id: string
  tier: Confidence
  memberIds: string[]
  links: DupeLink[]
}

const RANK: Record<Confidence, number> = { possible: 1, strong: 2, exact: 3 }

export function buildDupeGroups(links: DupeLink[]): DupeGroup[] {
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    const p = parent.get(x)
    if (p === undefined || p === x) { parent.set(x, x); return x }
    const root = find(p)
    parent.set(x, root)
    return root
  }
  const union = (a: string, b: string) => {
    const ra = find(a); const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }

  for (const l of links) {
    if (l.a === l.b) continue
    find(l.a); find(l.b)
    union(l.a, l.b)
  }

  const members = new Map<string, Set<string>>()
  for (const key of parent.keys()) {
    const root = find(key)
    if (!members.has(root)) members.set(root, new Set())
    members.get(root)!.add(key)
  }

  const groups: DupeGroup[] = []
  for (const memberSet of members.values()) {
    if (memberSet.size < 2) continue
    const memberIds = [...memberSet].sort()
    const groupLinks = links.filter((l) => memberSet.has(l.a) && memberSet.has(l.b) && l.a !== l.b)
    const tier = groupLinks.reduce<Confidence>(
      (best, l) => (RANK[l.confidence] > RANK[best] ? l.confidence : best),
      'possible',
    )
    groups.push({
      id: createHash('sha256').update(memberIds.join(' ')).digest('hex').slice(0, 32),
      tier,
      memberIds,
      links: groupLinks,
    })
  }
  return groups.sort((a, b) => a.id.localeCompare(b.id))
}
```

- [ ] **Step 5: Implement the six duplicate rules**

```ts
// src/rules/dupes/index.ts
import type { DupeLink, DupeRule, RuleContext } from '../types.js'
import { normalizeTitle, trigramSimilarity } from '../normalize.js'

interface ItemRow {
  id: string
  type: string
  name: string
  year: number | null
  provider_ids_json: string
  container_path: string | null
  size_bytes: number | null
  runtime_ticks: number | null
  series_id: string | null
  season_no: number | null
  episode_no: number | null
}

const loadItems = (ctx: RuleContext): ItemRow[] =>
  ctx.db.prepare(`SELECT id, type, name, year, provider_ids_json, container_path, size_bytes,
    runtime_ticks, series_id, season_no, episode_no
    FROM jellyfin_items WHERE type IN ('Movie','Episode')`).all() as ItemRow[]

/** Emits every pair inside each bucket of two or more. */
function pairsWithin<T>(buckets: Map<string, T[]>, make: (a: T, b: T, key: string) => DupeLink): DupeLink[] {
  const out: DupeLink[] = []
  for (const [key, group] of buckets) {
    if (group.length < 2) continue
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) out.push(make(group[i]!, group[j]!, key))
    }
  }
  return out
}

function bucket<T>(rows: T[], keyOf: (row: T) => string | null): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const row of rows) {
    const key = keyOf(row)
    if (key === null) continue
    const list = map.get(key)
    if (list) list.push(row); else map.set(key, [row])
  }
  return map
}

const providerIdRule: DupeRule = {
  id: 'dupe.provider-id',
  requires: ['jellyfin'],
  link(ctx) {
    const rows = loadItems(ctx)
    const buckets = new Map<string, ItemRow[]>()
    for (const row of rows) {
      const ids = JSON.parse(row.provider_ids_json) as Record<string, string>
      for (const [ns, value] of Object.entries(ids)) {
        if (!value) continue
        const key = `${ns}:${value}`
        const list = buckets.get(key)
        if (list) list.push(row); else buckets.set(key, [row])
      }
    }
    return pairsWithin(buckets, (a, b, key) => ({
      ruleId: 'dupe.provider-id', a: a.id, b: b.id, confidence: 'exact', evidence: { providerId: key },
    }))
  },
}

const seriesEpisodeRule: DupeRule = {
  id: 'dupe.series-episode',
  requires: ['jellyfin'],
  link(ctx) {
    const rows = loadItems(ctx).filter(
      (r) => r.type === 'Episode' && r.series_id && r.season_no !== null && r.episode_no !== null,
    )
    return pairsWithin(
      bucket(rows, (r) => `${r.series_id}|${r.season_no}|${r.episode_no}`),
      (a, b, key) => ({ ruleId: 'dupe.series-episode', a: a.id, b: b.id, confidence: 'exact', evidence: { episodeKey: key } }),
    )
  },
}

const titleYearRule: DupeRule = {
  id: 'dupe.title-year',
  requires: ['jellyfin'],
  link(ctx) {
    const rows = loadItems(ctx).filter((r) => r.type === 'Movie' && r.year !== null)
    return pairsWithin(
      bucket(rows, (r) => {
        const t = normalizeTitle(r.name)
        return t ? `${t}|${r.year}` : null
      }),
      (a, b, key) => ({ ruleId: 'dupe.title-year', a: a.id, b: b.id, confidence: 'strong', evidence: { titleYear: key } }),
    )
  },
}

const TICKS_PER_SECOND = 10_000_000

const runtimeRule: DupeRule = {
  id: 'dupe.runtime',
  requires: ['jellyfin'],
  link(ctx) {
    const cfg = ctx.config.rules['dupe.runtime']
    if (!cfg.enabled) return []
    const tolerance = cfg.toleranceSeconds * TICKS_PER_SECOND
    const rows = loadItems(ctx).filter((r) => r.runtime_ticks !== null)
    const out: DupeLink[] = []
    for (const [, group] of bucket(rows, (r) => normalizeTitle(r.name) || null)) {
      for (let i = 0; i < group.length; i += 1) {
        for (let j = i + 1; j < group.length; j += 1) {
          const a = group[i]!; const b = group[j]!
          const delta = Math.abs(a.runtime_ticks! - b.runtime_ticks!)
          if (delta <= tolerance) {
            out.push({
              ruleId: 'dupe.runtime', a: a.id, b: b.id, confidence: 'strong',
              evidence: { runtimeDeltaSeconds: delta / TICKS_PER_SECOND },
            })
          }
        }
      }
    }
    return out
  },
}

const identicalFileRule: DupeRule = {
  id: 'dupe.identical-file',
  requires: ['jellyfin', 'filesystem', 'hashes'],
  link(ctx) {
    const rows = ctx.db.prepare(`SELECT i.id AS id, f.quick_hash AS hash, f.size_bytes AS size
      FROM jellyfin_items i
      JOIN fs_entries f ON f.container_path = i.container_path
      WHERE f.quick_hash IS NOT NULL`).all() as Array<{ id: string; hash: string; size: number }>
    return pairsWithin(
      bucket(rows, (r) => `${r.size}|${r.hash}`),
      (a, b, key) => ({ ruleId: 'dupe.identical-file', a: a.id, b: b.id, confidence: 'exact', evidence: { sizeAndHash: key } }),
    )
  },
}

const fuzzyTitleRule: DupeRule = {
  id: 'dupe.fuzzy-title',
  requires: ['jellyfin'],
  link(ctx) {
    const cfg = ctx.config.rules['dupe.fuzzy-title']
    if (!cfg.enabled) return []
    const rows = loadItems(ctx)
      .filter((r) => r.type === 'Movie')
      .map((r) => ({ id: r.id, key: normalizeTitle(r.name) }))
      .filter((r) => r.key.length >= 3)
    // Bucket by first letter to keep this O(n²) pass tractable on a 100k library.
    const byLetter = bucket(rows, (r) => r.key[0] ?? null)
    const out: DupeLink[] = []
    for (const group of byLetter.values()) {
      for (let i = 0; i < group.length; i += 1) {
        for (let j = i + 1; j < group.length; j += 1) {
          const a = group[i]!; const b = group[j]!
          if (a.key === b.key) continue   // exact matches belong to title-year, not fuzzy
          const score = trigramSimilarity(a.key, b.key)
          if (score >= cfg.similarity) {
            out.push({
              ruleId: 'dupe.fuzzy-title', a: a.id, b: b.id, confidence: 'possible',
              evidence: { similarity: Number(score.toFixed(3)), a: a.key, b: b.key },
            })
          }
        }
      }
    }
    return out
  },
}

export const DUPE_RULES: DupeRule[] = [
  providerIdRule, seriesEpisodeRule, identicalFileRule, titleYearRule, runtimeRule, fuzzyTitleRule,
]
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npx vitest run tests/rules/dupes.test.ts tests/rules/grouping.test.ts && npm run typecheck`
Expected: 21 tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/rules/dupes src/rules/grouping.ts tests/rules/dupes.test.ts tests/rules/grouping.test.ts
git commit -m "feat: six duplicate rules and union-find grouping"
```

---

### Task 4: Keeper scoring and the duplicate finding adapter

**Files:**
- Create: `src/rules/keeper.ts`, `src/rules/dupes/adapter.ts`
- Modify: `src/rules/registry.ts`
- Test: `tests/rules/keeper.test.ts`

**Interfaces:**
- Consumes: `DupeGroup`, `Db`.
- Produces:
  - `scoreMember(m: MemberFacts, weights: KeeperWeights): { total: number; breakdown: Record<string, number> }`
  - `MemberFacts = { itemId, height, bitrate, videoCodec, audioChannels, isHdr, hasSubtitles, sizeBytes }`
  - `pickKeeper(members: MemberFacts[], weights): { keeperId: string; scores: Record<string, { total: number; breakdown: Record<string, number> }> }`
  - `dupeFindingRules(): Rule[]` — one adapter rule per duplicate rule id plus a group emitter registered as `dupe.group`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/rules/keeper.test.ts
import { describe, it, expect } from 'vitest'
import { scoreMember, pickKeeper, DEFAULT_KEEPER_WEIGHTS } from '../../src/rules/keeper.js'

const facts = (over: Partial<Parameters<typeof scoreMember>[0]> = {}) => ({
  itemId: 'a', height: 1080, bitrate: 8_000_000, videoCodec: 'h264',
  audioChannels: 6, isHdr: false, hasSubtitles: false, sizeBytes: 10_000_000_000,
  ...over,
})

describe('scoreMember', () => {
  it('scores higher resolution above lower', () => {
    const uhd = scoreMember(facts({ height: 2160 }), DEFAULT_KEEPER_WEIGHTS).total
    const hd = scoreMember(facts({ height: 1080 }), DEFAULT_KEEPER_WEIGHTS).total
    expect(uhd).toBeGreaterThan(hd)
  })

  it('weights resolution above bitrate — a 4K low-bitrate beats a 1080p high-bitrate', () => {
    const uhd = scoreMember(facts({ height: 2160, bitrate: 6_000_000 }), DEFAULT_KEEPER_WEIGHTS).total
    const hd = scoreMember(facts({ height: 1080, bitrate: 40_000_000 }), DEFAULT_KEEPER_WEIGHTS).total
    expect(uhd).toBeGreaterThan(hd)
  })

  it('rewards HDR, more audio channels and subtitles', () => {
    const base = scoreMember(facts(), DEFAULT_KEEPER_WEIGHTS).total
    expect(scoreMember(facts({ isHdr: true }), DEFAULT_KEEPER_WEIGHTS).total).toBeGreaterThan(base)
    expect(scoreMember(facts({ audioChannels: 8 }), DEFAULT_KEEPER_WEIGHTS).total).toBeGreaterThan(base)
    expect(scoreMember(facts({ hasSubtitles: true }), DEFAULT_KEEPER_WEIGHTS).total).toBeGreaterThan(base)
  })

  it('exposes a breakdown whose parts sum to the total', () => {
    const { total, breakdown } = scoreMember(facts(), DEFAULT_KEEPER_WEIGHTS)
    const sum = Object.values(breakdown).reduce((a, b) => a + b, 0)
    expect(Math.abs(sum - total)).toBeLessThan(1e-6)
  })

  it('handles missing facts without producing NaN', () => {
    const { total } = scoreMember(
      { itemId: 'x', height: null, bitrate: null, videoCodec: null, audioChannels: null, isHdr: false, hasSubtitles: false, sizeBytes: null },
      DEFAULT_KEEPER_WEIGHTS,
    )
    expect(Number.isFinite(total)).toBe(true)
  })
})

describe('pickKeeper', () => {
  it('picks the highest total', () => {
    const { keeperId } = pickKeeper([facts({ itemId: 'a', height: 1080 }), facts({ itemId: 'b', height: 2160 })], DEFAULT_KEEPER_WEIGHTS)
    expect(keeperId).toBe('b')
  })

  it('breaks an exact tie by larger size, then by id, so the choice is deterministic', () => {
    const a = pickKeeper([facts({ itemId: 'a', sizeBytes: 1 }), facts({ itemId: 'b', sizeBytes: 2 })], DEFAULT_KEEPER_WEIGHTS)
    expect(a.keeperId).toBe('b')
    const b = pickKeeper([facts({ itemId: 'z', sizeBytes: 5 }), facts({ itemId: 'y', sizeBytes: 5 })], DEFAULT_KEEPER_WEIGHTS)
    expect(b.keeperId).toBe('y')
  })

  it('returns a score for every member so the UI can show the comparison', () => {
    const { scores } = pickKeeper([facts({ itemId: 'a' }), facts({ itemId: 'b' })], DEFAULT_KEEPER_WEIGHTS)
    expect(Object.keys(scores).sort()).toEqual(['a', 'b'])
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/rules/keeper.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement keeper scoring**

```ts
// src/rules/keeper.ts
export interface MemberFacts {
  itemId: string
  height: number | null
  bitrate: number | null
  videoCodec: string | null
  audioChannels: number | null
  isHdr: boolean
  hasSubtitles: boolean
  sizeBytes: number | null
}

export interface KeeperWeights {
  resolution: number
  hdr: number
  bitrate: number
  codec: number
  audioChannels: number
  subtitles: number
  size: number
  codecRank: Record<string, number>
}

/**
 * Weights are ordered so resolution dominates: a 4K copy wins over a 1080p copy
 * even when the 1080p file has a far higher bitrate. Everything is normalized to
 * roughly 0–1 before weighting so one signal cannot silently swamp the rest.
 */
export const DEFAULT_KEEPER_WEIGHTS: KeeperWeights = {
  resolution: 1000,
  hdr: 300,
  bitrate: 200,
  codec: 100,
  audioChannels: 80,
  subtitles: 40,
  size: 10,
  codecRank: { av1: 1, hevc: 0.9, h265: 0.9, h264: 0.7, avc: 0.7, mpeg4: 0.3, xvid: 0.2 },
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

export function scoreMember(m: MemberFacts, w: KeeperWeights): { total: number; breakdown: Record<string, number> } {
  const breakdown = {
    resolution: w.resolution * clamp01((m.height ?? 0) / 2160),
    hdr: m.isHdr ? w.hdr : 0,
    bitrate: w.bitrate * clamp01((m.bitrate ?? 0) / 40_000_000),
    codec: w.codec * (w.codecRank[(m.videoCodec ?? '').toLowerCase()] ?? 0),
    audioChannels: w.audioChannels * clamp01((m.audioChannels ?? 0) / 8),
    subtitles: m.hasSubtitles ? w.subtitles : 0,
    size: w.size * clamp01((m.sizeBytes ?? 0) / 100_000_000_000),
  }
  const total = Object.values(breakdown).reduce((a, b) => a + b, 0)
  return { total, breakdown }
}

export function pickKeeper(members: MemberFacts[], w: KeeperWeights) {
  const scores: Record<string, { total: number; breakdown: Record<string, number> }> = {}
  for (const m of members) scores[m.itemId] = scoreMember(m, w)

  const sorted = [...members].sort((a, b) => {
    const diff = scores[b.itemId]!.total - scores[a.itemId]!.total
    if (Math.abs(diff) > 1e-9) return diff
    const size = (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0)
    if (size !== 0) return size
    return a.itemId.localeCompare(b.itemId)
  })
  return { keeperId: sorted[0]!.itemId, scores }
}
```

- [ ] **Step 4: Implement the duplicate finding adapter**

```ts
// src/rules/dupes/adapter.ts
import type { Finding, Subject } from '../../core/types.js'
import { findingId } from '../../core/types.js'
import type { Rule, RuleContext } from '../types.js'
import { DUPE_RULES } from './index.js'
import { buildDupeGroups } from '../grouping.js'
import { DEFAULT_KEEPER_WEIGHTS, pickKeeper, type MemberFacts } from '../keeper.js'

interface MemberRow {
  id: string; name: string; container_path: string | null; size_bytes: number | null
  height: number | null; bitrate: number | null; video_codec: string | null
  audio_channels: number | null; library_name: string | null
}

/**
 * One rule that runs every duplicate matcher, groups the links, scores keepers,
 * and emits a single finding per group. Registered as `dupe.group`.
 */
export const dupeGroupRule: Rule = {
  id: 'dupe.group',
  class: 'duplicate',
  requires: ['jellyfin'],
  run(ctx: RuleContext): Finding[] {
    const links = DUPE_RULES.flatMap((rule) => {
      // A matcher whose extra sources are absent contributes nothing rather than failing the group rule.
      if (rule.requires.includes('hashes') && !hasHashes(ctx)) return []
      try { return rule.link(ctx) } catch { return [] }
    })
    const groups = buildDupeGroups(links)
    if (!groups.length) return []

    ctx.db.prepare('DELETE FROM dupe_groups').run()
    const insertGroup = ctx.db.prepare(
      'INSERT OR REPLACE INTO dupe_groups (id, tier, members_json, keeper_item_id, scores_json, status) VALUES (?,?,?,?,?,?)',
    )

    const findings: Finding[] = []
    for (const group of groups) {
      const placeholders = group.memberIds.map(() => '?').join(',')
      const rows = ctx.db.prepare(`SELECT id, name, container_path, size_bytes, height, bitrate,
        video_codec, audio_channels, library_name FROM jellyfin_items WHERE id IN (${placeholders})`)
        .all(...group.memberIds) as MemberRow[]
      if (rows.length < 2) continue

      const facts: MemberFacts[] = rows.map((r) => ({
        itemId: r.id,
        height: r.height,
        bitrate: r.bitrate,
        videoCodec: r.video_codec,
        audioChannels: r.audio_channels,
        isHdr: (r.video_codec ?? '').toLowerCase().includes('hevc') && (r.height ?? 0) >= 2160,
        hasSubtitles: false,
        sizeBytes: r.size_bytes,
      }))
      const { keeperId, scores } = pickKeeper(facts, DEFAULT_KEEPER_WEIGHTS)

      insertGroup.run(group.id, group.tier, JSON.stringify(group.memberIds), keeperId, JSON.stringify(scores), 'open')

      const subjects: Subject[] = rows.map((r) => ({
        kind: 'item', id: r.id, label: r.name, path: r.container_path ?? undefined,
      }))
      const reclaimable = rows
        .filter((r) => r.id !== keeperId)
        .reduce((sum, r) => sum + (r.size_bytes ?? 0), 0)

      findings.push({
        id: findingId('dupe.group', group.memberIds),
        ruleId: 'dupe.group',
        class: 'duplicate',
        severity: group.tier === 'exact' ? 'warning' : 'info',
        confidence: group.tier,
        subjects,
        evidence: {
          groupId: group.id,
          keeperId,
          scores,
          matchedBy: [...new Set(group.links.map((l) => l.ruleId))],
          links: group.links,
          crossLibrary: new Set(rows.map((r) => r.library_name)).size > 1,
        },
        reclaimableBytes: reclaimable,
        status: 'open',
        firstSeen: ctx.now,
        lastSeen: ctx.now,
      })
    }
    return findings
  },
}

function hasHashes(ctx: RuleContext): boolean {
  const row = ctx.db.prepare('SELECT COUNT(*) c FROM fs_entries WHERE quick_hash IS NOT NULL').get() as { c: number }
  return row.c > 0
}
```

Register it in `src/rules/registry.ts`:

```ts
import { dupeGroupRule } from './dupes/adapter.js'
export const ALL_RULES: Rule[] = [dupeGroupRule]
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run tests/rules && npm run typecheck`
Expected: all rules tests PASS (8 keeper + earlier tasks').

- [ ] **Step 6: Commit**

```bash
git add src/rules/keeper.ts src/rules/dupes/adapter.ts src/rules/registry.ts tests/rules/keeper.test.ts
git commit -m "feat: keeper scoring and duplicate group findings"
```

---

### Task 5: Filesystem rules

**Files:**
- Create: `src/rules/filesystem/index.ts`
- Modify: `src/rules/registry.ts`
- Test: `tests/rules/filesystem.test.ts`

**Interfaces:**
- Consumes: `Rule`, `RuleContext`.
- Produces: `FILESYSTEM_RULES: Rule[]` — `fs.empty-folder`, `fs.orphan-media`, `fs.missing-file`, `fs.junk`, `fs.stray-sidecar`, `fs.permission`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/rules/filesystem.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../src/index/db.js'
import { FILESYSTEM_RULES } from '../../src/rules/filesystem/index.js'
import { fileConfigSchema } from '../../src/config/schema.js'

let db: Db
const config = fileConfigSchema.parse({})
const ctx = () => ({ db, config, scanId: 1, now: 'T' })
const rule = (id: string) => FILESYSTEM_RULES.find((r) => r.id === id)!

function entry(over: Record<string, unknown>) {
  const row = {
    container_path: '/mnt/m/x', scan_id: 1, parent_path: '/mnt/m', name: 'x', ext: null,
    is_dir: 0, size_bytes: 0, mtime: 0, dev: 1, inode: 1, nlink: 1, is_media: 0,
    library_root: '/mnt/m', root_role: 'library', quick_hash: null, ...over,
  }
  db.prepare(`INSERT OR REPLACE INTO fs_entries (container_path, scan_id, parent_path, name, ext,
    is_dir, size_bytes, mtime, dev, inode, nlink, is_media, library_root, root_role, quick_hash)
    VALUES (@container_path,@scan_id,@parent_path,@name,@ext,@is_dir,@size_bytes,@mtime,@dev,
            @inode,@nlink,@is_media,@library_root,@root_role,@quick_hash)`).run(row)
}

function jfItem(id: string, containerPath: string | null) {
  db.prepare(`INSERT INTO jellyfin_items (id, scan_id, type, name, container_path, has_primary_image)
    VALUES (?,1,'Movie','n',?,1)`).run(id, containerPath)
}

beforeEach(() => { db = openDb(join(mkdtempSync(join(tmpdir(), 'jm-fsrule-')), 'db.sqlite')) })

describe('fs.empty-folder', () => {
  it('reports a directory containing nothing', () => {
    entry({ container_path: '/mnt/m/Empty', name: 'Empty', is_dir: 1 })
    const f = rule('fs.empty-folder').run(ctx())
    expect(f).toHaveLength(1)
    expect(f[0]!.subjects[0]!.path).toBe('/mnt/m/Empty')
  })

  it('reports a directory holding only ignorable files', () => {
    entry({ container_path: '/mnt/m/Junky', name: 'Junky', is_dir: 1 })
    entry({ container_path: '/mnt/m/Junky/Thumbs.db', parent_path: '/mnt/m/Junky', name: 'Thumbs.db', ext: '.db' })
    expect(rule('fs.empty-folder').run(ctx())).toHaveLength(1)
  })

  it('does not report a directory containing media', () => {
    entry({ container_path: '/mnt/m/Full', name: 'Full', is_dir: 1 })
    entry({ container_path: '/mnt/m/Full/a.mkv', parent_path: '/mnt/m/Full', name: 'a.mkv', ext: '.mkv', is_media: 1 })
    expect(rule('fs.empty-folder').run(ctx())).toHaveLength(0)
  })

  it('reports only the topmost empty root, not every nested descendant', () => {
    entry({ container_path: '/mnt/m/A', name: 'A', is_dir: 1 })
    entry({ container_path: '/mnt/m/A/B', parent_path: '/mnt/m/A', name: 'B', is_dir: 1 })
    entry({ container_path: '/mnt/m/A/B/C', parent_path: '/mnt/m/A/B', name: 'C', is_dir: 1 })
    const f = rule('fs.empty-folder').run(ctx())
    expect(f).toHaveLength(1)
    expect(f[0]!.subjects[0]!.path).toBe('/mnt/m/A')
  })

  it('never reports a library root itself', () => {
    entry({ container_path: '/mnt/m', name: 'm', is_dir: 1, parent_path: '/mnt' })
    expect(rule('fs.empty-folder').run(ctx())).toHaveLength(0)
  })
})

describe('fs.orphan-media', () => {
  it('reports media under a library root that Jellyfin does not know', () => {
    entry({ container_path: '/mnt/m/Orphan.mkv', name: 'Orphan.mkv', ext: '.mkv', is_media: 1, size_bytes: 500 })
    const f = rule('fs.orphan-media').run(ctx())
    expect(f).toHaveLength(1)
    expect(f[0]!.reclaimableBytes).toBe(500)
  })

  it('does not report media Jellyfin references', () => {
    entry({ container_path: '/mnt/m/Known.mkv', name: 'Known.mkv', ext: '.mkv', is_media: 1 })
    jfItem('i1', '/mnt/m/Known.mkv')
    expect(rule('fs.orphan-media').run(ctx())).toHaveLength(0)
  })

  it('ignores download roots entirely — nothing there is expected in Jellyfin', () => {
    entry({ container_path: '/mnt/d/x.mkv', name: 'x.mkv', ext: '.mkv', is_media: 1, library_root: '/mnt/d', root_role: 'download' })
    expect(rule('fs.orphan-media').run(ctx())).toHaveLength(0)
  })
})

describe('fs.missing-file', () => {
  it('reports a Jellyfin item whose path is absent from the index', () => {
    jfItem('i1', '/mnt/m/Gone.mkv')
    const f = rule('fs.missing-file').run(ctx())
    expect(f).toHaveLength(1)
    expect(f[0]!.severity).toBe('critical')
  })

  it('does not report an item whose file exists', () => {
    entry({ container_path: '/mnt/m/Here.mkv', name: 'Here.mkv', ext: '.mkv', is_media: 1 })
    jfItem('i1', '/mnt/m/Here.mkv')
    expect(rule('fs.missing-file').run(ctx())).toHaveLength(0)
  })

  it('does not report items with no path at all — those are Series and Season rows', () => {
    jfItem('i1', null)
    expect(rule('fs.missing-file').run(ctx())).toHaveLength(0)
  })
})

describe('fs.junk', () => {
  it.each([
    ['sample.mkv', '.mkv'],
    ['movie.mkv.part', '.part'],
    ['movie.mkv.!qB', '.!qb'],
    ['film-sample.mp4', '.mp4'],
  ])('flags %s', (name, ext) => {
    entry({ container_path: `/mnt/m/${name}`, name, ext })
    expect(rule('fs.junk').run(ctx())).toHaveLength(1)
  })

  it('flags a zero-byte media file', () => {
    entry({ container_path: '/mnt/m/broken.mkv', name: 'broken.mkv', ext: '.mkv', is_media: 1, size_bytes: 0 })
    expect(rule('fs.junk').run(ctx())).toHaveLength(1)
  })

  it('does not flag an ordinary media file', () => {
    entry({ container_path: '/mnt/m/Heat.mkv', name: 'Heat.mkv', ext: '.mkv', is_media: 1, size_bytes: 5_000_000_000 })
    expect(rule('fs.junk').run(ctx())).toHaveLength(0)
  })
})

describe('fs.stray-sidecar', () => {
  it('reports a subtitle with no media beside it', () => {
    entry({ container_path: '/mnt/m/Heat.srt', name: 'Heat.srt', ext: '.srt' })
    expect(rule('fs.stray-sidecar').run(ctx())).toHaveLength(1)
  })

  it('does not report a subtitle sitting next to its media', () => {
    entry({ container_path: '/mnt/m/Heat.srt', name: 'Heat.srt', ext: '.srt' })
    entry({ container_path: '/mnt/m/Heat.mkv', name: 'Heat.mkv', ext: '.mkv', is_media: 1 })
    expect(rule('fs.stray-sidecar').run(ctx())).toHaveLength(0)
  })
})

describe('fs.permission', () => {
  it('reports a path recorded as unreadable during the walk', () => {
    db.prepare("INSERT INTO kv (key, value_json) VALUES ('scan.fsErrors', ?)")
      .run(JSON.stringify([{ path: '/mnt/m/locked', reason: 'EACCES' }]))
    const f = rule('fs.permission').run(ctx())
    expect(f).toHaveLength(1)
    expect(f[0]!.evidence.reason).toBe('EACCES')
  })

  it('reports nothing when the walk recorded no errors', () => {
    expect(rule('fs.permission').run(ctx())).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/rules/filesystem.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the filesystem rules**

```ts
// src/rules/filesystem/index.ts
import type { Finding } from '../../core/types.js'
import { findingId } from '../../core/types.js'
import type { Rule, RuleContext } from '../types.js'

const JUNK_NAME = /(^|[.\-_ ])sample([.\-_ ]|$)/i
const JUNK_EXT = new Set(['.part', '.tmp', '.!qb', '.crdownload'])
const JUNK_DIR = new Set(['proof', 'screens', 'sample'])
const SIDECAR_EXT = new Set(['.srt', '.sub', '.idx', '.ass', '.nfo', '.jpg', '.png'])

function finding(
  ctx: RuleContext, ruleId: string, key: string, path: string,
  severity: Finding['severity'], evidence: Record<string, unknown>, reclaimable: number | null,
): Finding {
  return {
    id: findingId(ruleId, key),
    ruleId,
    class: 'filesystem',
    severity,
    confidence: 'exact',
    subjects: [{ kind: 'path', path, label: path }],
    evidence,
    reclaimableBytes: reclaimable,
    status: 'open',
    firstSeen: ctx.now,
    lastSeen: ctx.now,
  }
}

const emptyFolderRule: Rule = {
  id: 'fs.empty-folder',
  class: 'filesystem',
  requires: ['filesystem'],
  run(ctx) {
    const ignorable = new Set(ctx.config.ignorableFiles.map((s) => s.toLowerCase()))
    const dirs = ctx.db.prepare(
      'SELECT container_path, parent_path, library_root FROM fs_entries WHERE is_dir = 1',
    ).all() as Array<{ container_path: string; parent_path: string; library_root: string }>

    const emptyPaths = new Set<string>()
    for (const dir of dirs) {
      if (dir.container_path === dir.library_root) continue
      const files = ctx.db.prepare(`SELECT name, ext FROM fs_entries
        WHERE is_dir = 0 AND container_path LIKE ? || '/%'`).all(dir.container_path) as Array<{ name: string; ext: string | null }>
      const meaningful = files.filter(
        (f) => !ignorable.has(f.name.toLowerCase()) && !ignorable.has((f.ext ?? '').toLowerCase()),
      )
      if (meaningful.length === 0) emptyPaths.add(dir.container_path)
    }

    // Report only the topmost empty ancestor: nine nested rows for one dead folder is noise.
    const topmost = [...emptyPaths].filter((p) => {
      const parent = p.slice(0, p.lastIndexOf('/'))
      return !emptyPaths.has(parent)
    })

    return topmost.sort().map((p) =>
      finding(ctx, 'fs.empty-folder', p, p, 'info', { path: p }, 0))
  },
}

const orphanMediaRule: Rule = {
  id: 'fs.orphan-media',
  class: 'filesystem',
  requires: ['filesystem', 'jellyfin'],
  run(ctx) {
    const rows = ctx.db.prepare(`SELECT f.container_path AS path, f.size_bytes AS size
      FROM fs_entries f
      LEFT JOIN jellyfin_items i ON i.container_path = f.container_path
      WHERE f.is_media = 1 AND f.root_role = 'library' AND i.id IS NULL`)
      .all() as Array<{ path: string; size: number }>
    return rows.map((r) =>
      finding(ctx, 'fs.orphan-media', r.path, r.path, 'warning', { sizeBytes: r.size }, r.size))
  },
}

const missingFileRule: Rule = {
  id: 'fs.missing-file',
  class: 'filesystem',
  requires: ['filesystem', 'jellyfin'],
  run(ctx) {
    const rows = ctx.db.prepare(`SELECT i.id AS id, i.name AS name, i.container_path AS path
      FROM jellyfin_items i
      LEFT JOIN fs_entries f ON f.container_path = i.container_path
      WHERE i.container_path IS NOT NULL AND f.container_path IS NULL`)
      .all() as Array<{ id: string; name: string; path: string }>
    return rows.map((r) => ({
      id: findingId('fs.missing-file', r.id),
      ruleId: 'fs.missing-file',
      class: 'filesystem' as const,
      severity: 'critical' as const,
      confidence: 'exact' as const,
      subjects: [{ kind: 'item' as const, id: r.id, label: r.name, path: r.path }],
      evidence: { expectedPath: r.path },
      reclaimableBytes: null,
      status: 'open' as const,
      firstSeen: ctx.now,
      lastSeen: ctx.now,
    }))
  },
}

const junkRule: Rule = {
  id: 'fs.junk',
  class: 'filesystem',
  requires: ['filesystem'],
  run(ctx) {
    const rows = ctx.db.prepare(
      'SELECT container_path, name, ext, is_dir, is_media, size_bytes FROM fs_entries',
    ).all() as Array<{ container_path: string; name: string; ext: string | null; is_dir: number; is_media: number; size_bytes: number }>

    const out: Finding[] = []
    for (const r of rows) {
      const ext = (r.ext ?? '').toLowerCase()
      let reason: string | null = null
      if (r.is_dir === 1 && JUNK_DIR.has(r.name.toLowerCase())) reason = 'junk directory'
      else if (r.is_dir === 0 && JUNK_EXT.has(ext)) reason = `incomplete download (${ext})`
      else if (r.is_dir === 0 && JUNK_NAME.test(r.name)) reason = 'sample file'
      else if (r.is_dir === 0 && r.is_media === 1 && r.size_bytes === 0) reason = 'zero-byte media file'
      if (!reason) continue
      out.push(finding(ctx, 'fs.junk', r.container_path, r.container_path, 'warning',
        { reason, sizeBytes: r.size_bytes }, r.size_bytes))
    }
    return out
  },
}

const straySidecarRule: Rule = {
  id: 'fs.stray-sidecar',
  class: 'filesystem',
  requires: ['filesystem'],
  run(ctx) {
    const rows = ctx.db.prepare(
      'SELECT container_path, parent_path, ext FROM fs_entries WHERE is_dir = 0',
    ).all() as Array<{ container_path: string; parent_path: string; ext: string | null }>
    const mediaByParent = new Map<string, number>()
    for (const r of ctx.db.prepare(
      'SELECT parent_path, COUNT(*) c FROM fs_entries WHERE is_media = 1 GROUP BY parent_path',
    ).all() as Array<{ parent_path: string; c: number }>) mediaByParent.set(r.parent_path, r.c)

    return rows
      .filter((r) => SIDECAR_EXT.has((r.ext ?? '').toLowerCase()) && !(mediaByParent.get(r.parent_path) ?? 0))
      .map((r) => finding(ctx, 'fs.stray-sidecar', r.container_path, r.container_path, 'info',
        { ext: r.ext }, 0))
  },
}

const permissionRule: Rule = {
  id: 'fs.permission',
  class: 'filesystem',
  requires: ['filesystem'],
  run(ctx) {
    const row = ctx.db.prepare("SELECT value_json FROM kv WHERE key = 'scan.fsErrors'").get() as
      { value_json: string } | undefined
    if (!row) return []
    const errors = JSON.parse(row.value_json) as Array<{ path: string; reason: string }>
    return errors.map((e) =>
      finding(ctx, 'fs.permission', e.path, e.path, 'warning', { reason: e.reason }, null))
  },
}

export const FILESYSTEM_RULES: Rule[] = [
  emptyFolderRule, orphanMediaRule, missingFileRule, junkRule, straySidecarRule, permissionRule,
]
```

Modify `src/scan/phases/filesystem.ts` to persist walk errors so `fs.permission` has input — add before `return`:

```ts
    ctx.db.prepare("INSERT OR REPLACE INTO kv (key, value_json) VALUES ('scan.fsErrors', ?)")
      .run(JSON.stringify(errors.slice(0, 500)))
```

Register in `src/rules/registry.ts`:

```ts
import { FILESYSTEM_RULES } from './filesystem/index.js'
export const ALL_RULES: Rule[] = [dupeGroupRule, ...FILESYSTEM_RULES]
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run tests/rules/filesystem.test.ts && npm run typecheck`
Expected: 18 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/rules/filesystem src/rules/registry.ts src/scan/phases/filesystem.ts tests/rules/filesystem.test.ts
git commit -m "feat: filesystem hygiene rules"
```

---

### Task 6: Metadata and quality rules

**Files:**
- Create: `src/rules/metadata/index.ts`, `src/rules/quality/index.ts`
- Modify: `src/rules/registry.ts`
- Test: `tests/rules/metadata.test.ts`, `tests/rules/quality.test.ts`

**Interfaces:**
- Produces: `METADATA_RULES: Rule[]` (`meta.unidentified`, `meta.missing-artwork`, `meta.missing-year`, `meta.episode-no-season`, `meta.mixed-content`, `meta.bad-naming`) and `QUALITY_RULES: Rule[]` (`quality.low-bitrate`, `quality.tiny-file`, `quality.transcode-risk`, `quality.missing-subs`, `quality.biggest`).

- [ ] **Step 1: Write the failing metadata test**

```ts
// tests/rules/metadata.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../src/index/db.js'
import { METADATA_RULES } from '../../src/rules/metadata/index.js'
import { fileConfigSchema } from '../../src/config/schema.js'

let db: Db
const config = fileConfigSchema.parse({})
const ctx = () => ({ db, config, scanId: 1, now: 'T' })
const rule = (id: string) => METADATA_RULES.find((r) => r.id === id)!

function item(over: Record<string, unknown> = {}) {
  const row = {
    id: 'i1', type: 'Movie', name: 'Heat', year: 1995, provider_ids_json: '{"tmdb":"949"}',
    jf_path: '/media/Movies/Heat (1995)/Heat (1995).mkv', container_path: '/mnt/m/Heat.mkv',
    has_primary_image: 1, series_id: null, season_no: null, episode_no: null, library_name: 'Movies',
    ...over,
  }
  db.prepare(`INSERT INTO jellyfin_items (id, scan_id, type, name, year, provider_ids_json, jf_path,
    container_path, has_primary_image, series_id, season_no, episode_no, library_name)
    VALUES (@id,1,@type,@name,@year,@provider_ids_json,@jf_path,@container_path,@has_primary_image,
            @series_id,@season_no,@episode_no,@library_name)`).run(row)
}

beforeEach(() => { db = openDb(join(mkdtempSync(join(tmpdir(), 'jm-meta-')), 'db.sqlite')) })

describe('meta.unidentified', () => {
  it('reports an item with no provider ids', () => {
    item({ provider_ids_json: '{}' })
    expect(rule('meta.unidentified').run(ctx())).toHaveLength(1)
  })
  it('ignores an identified item', () => {
    item()
    expect(rule('meta.unidentified').run(ctx())).toHaveLength(0)
  })
  it('ignores Season rows, which never carry provider ids', () => {
    item({ type: 'Season', provider_ids_json: '{}' })
    expect(rule('meta.unidentified').run(ctx())).toHaveLength(0)
  })
})

describe('meta.missing-artwork', () => {
  it('reports an item with no primary image', () => {
    item({ has_primary_image: 0 })
    expect(rule('meta.missing-artwork').run(ctx())).toHaveLength(1)
  })
})

describe('meta.missing-year', () => {
  it('reports a movie with no production year', () => {
    item({ year: null })
    expect(rule('meta.missing-year').run(ctx())).toHaveLength(1)
  })
  it('does not report episodes, which inherit the series year', () => {
    item({ type: 'Episode', year: null, series_id: 's1', season_no: 1, episode_no: 1 })
    expect(rule('meta.missing-year').run(ctx())).toHaveLength(0)
  })
})

describe('meta.episode-no-season', () => {
  it('reports an episode with a null season number', () => {
    item({ id: 'e1', type: 'Episode', series_id: 's1', season_no: null, episode_no: 3 })
    expect(rule('meta.episode-no-season').run(ctx())).toHaveLength(1)
  })
  it('reports an episode with no series at all', () => {
    item({ id: 'e2', type: 'Episode', series_id: null, season_no: 1, episode_no: 3 })
    expect(rule('meta.episode-no-season').run(ctx())).toHaveLength(1)
  })
})

describe('meta.mixed-content', () => {
  it('reports a library holding both movies and episodes', () => {
    item({ id: 'a', type: 'Movie', library_name: 'Media' })
    item({ id: 'b', type: 'Episode', library_name: 'Media', series_id: 's', season_no: 1, episode_no: 1 })
    expect(rule('meta.mixed-content').run(ctx())).toHaveLength(1)
  })
  it('does not report clean single-type libraries', () => {
    item({ id: 'a', type: 'Movie', library_name: 'Movies' })
    item({ id: 'b', type: 'Episode', library_name: 'TV', series_id: 's', season_no: 1, episode_no: 1 })
    expect(rule('meta.mixed-content').run(ctx())).toHaveLength(0)
  })
})

describe('meta.bad-naming', () => {
  it('reports a movie whose folder omits the year', () => {
    item({ jf_path: '/media/Movies/Heat/Heat.mkv' })
    expect(rule('meta.bad-naming').run(ctx())).toHaveLength(1)
  })
  it('accepts the conventional "Title (Year)" folder', () => {
    item({ jf_path: '/media/Movies/Heat (1995)/Heat (1995).mkv' })
    expect(rule('meta.bad-naming').run(ctx())).toHaveLength(0)
  })
  it('reports an episode file with no SxxEyy token', () => {
    item({ id: 'e', type: 'Episode', series_id: 's', season_no: 1, episode_no: 1, jf_path: '/media/TV/Show/ep1.mkv' })
    expect(rule('meta.bad-naming').run(ctx())).toHaveLength(1)
  })
  it('accepts a conventional episode filename', () => {
    item({ id: 'e', type: 'Episode', series_id: 's', season_no: 1, episode_no: 1, jf_path: '/media/TV/Show/Season 01/Show - S01E01.mkv' })
    expect(rule('meta.bad-naming').run(ctx())).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Write the failing quality test**

```ts
// tests/rules/quality.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../src/index/db.js'
import { QUALITY_RULES } from '../../src/rules/quality/index.js'
import { fileConfigSchema } from '../../src/config/schema.js'

let db: Db
const ctx = (config = fileConfigSchema.parse({})) => ({ db, config, scanId: 1, now: 'T' })
const rule = (id: string) => QUALITY_RULES.find((r) => r.id === id)!

function item(over: Record<string, unknown> = {}) {
  const row = {
    id: 'i1', type: 'Movie', name: 'Heat', height: 1080, bitrate: 8_000_000, container: 'mkv',
    video_codec: 'h264', audio_codec: 'aac', runtime_ticks: 60_000_000_000, size_bytes: 5_000_000_000,
    container_path: '/mnt/m/Heat.mkv', ...over,
  }
  db.prepare(`INSERT INTO jellyfin_items (id, scan_id, type, name, height, bitrate, container,
    video_codec, audio_codec, runtime_ticks, size_bytes, container_path, has_primary_image)
    VALUES (@id,1,@type,@name,@height,@bitrate,@container,@video_codec,@audio_codec,
            @runtime_ticks,@size_bytes,@container_path,1)`).run(row)
}

beforeEach(() => { db = openDb(join(mkdtempSync(join(tmpdir(), 'jm-qual-')), 'db.sqlite')) })

describe('quality.low-bitrate', () => {
  it('reports a 1080p file below the configured floor', () => {
    item({ height: 1080, bitrate: 1_000_000 })
    const f = rule('quality.low-bitrate').run(ctx())
    expect(f).toHaveLength(1)
    expect(f[0]!.severity).toBe('info')
  })
  it('accepts a file above the floor', () => {
    item({ height: 1080, bitrate: 9_000_000 })
    expect(rule('quality.low-bitrate').run(ctx())).toHaveLength(0)
  })
  it('uses the nearest configured height bucket', () => {
    item({ height: 2160, bitrate: 6_000_000 })
    expect(rule('quality.low-bitrate').run(ctx())).toHaveLength(1)
  })
  it('skips items with no bitrate rather than treating null as zero', () => {
    item({ bitrate: null })
    expect(rule('quality.low-bitrate').run(ctx())).toHaveLength(0)
  })
})

describe('quality.tiny-file', () => {
  it('reports a file far smaller than its same-resolution peers', () => {
    item({ id: 'a', size_bytes: 20_000_000_000 })
    item({ id: 'b', size_bytes: 18_000_000_000 })
    item({ id: 'c', size_bytes: 300_000_000 })
    const f = rule('quality.tiny-file').run(ctx())
    expect(f.map((x) => x.subjects[0]!.id)).toEqual(['c'])
  })
  it('reports nothing when there are too few peers to compare', () => {
    item({ id: 'a', size_bytes: 100 })
    expect(rule('quality.tiny-file').run(ctx())).toHaveLength(0)
  })
})

describe('quality.transcode-risk', () => {
  it('reports a codec outside the allowed list', () => {
    item({ video_codec: 'mpeg2video' })
    expect(rule('quality.transcode-risk').run(ctx())).toHaveLength(1)
  })
  it('reports a container outside the allowed list', () => {
    item({ container: 'avi' })
    expect(rule('quality.transcode-risk').run(ctx())).toHaveLength(1)
  })
  it('accepts an allowed codec and container', () => {
    item({ video_codec: 'hevc', container: 'mkv' })
    expect(rule('quality.transcode-risk').run(ctx())).toHaveLength(0)
  })
})

describe('quality.biggest', () => {
  it('reports the top N largest items as one informational finding', () => {
    for (let i = 0; i < 5; i += 1) item({ id: `i${i}`, size_bytes: i * 1_000_000_000 })
    const f = rule('quality.biggest').run(ctx(fileConfigSchema.parse({ rules: { 'quality.biggest': { topN: 3 } } })))
    expect(f).toHaveLength(1)
    expect((f[0]!.evidence.items as unknown[]).length).toBe(3)
  })
  it('has a stable id so it never accumulates duplicates across scans', () => {
    item()
    const a = rule('quality.biggest').run(ctx())[0]!
    const b = rule('quality.biggest').run(ctx())[0]!
    expect(a.id).toBe(b.id)
  })
})
```

- [ ] **Step 3: Run both and confirm they fail**

Run: `npx vitest run tests/rules/metadata.test.ts tests/rules/quality.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement the metadata rules**

```ts
// src/rules/metadata/index.ts
import type { Finding } from '../../core/types.js'
import { findingId } from '../../core/types.js'
import type { Rule, RuleContext } from '../types.js'

interface Row {
  id: string; type: string; name: string; year: number | null; provider_ids_json: string
  jf_path: string | null; container_path: string | null; has_primary_image: number
  series_id: string | null; season_no: number | null; episode_no: number | null
  library_name: string | null
}

const ALL = `SELECT id, type, name, year, provider_ids_json, jf_path, container_path,
  has_primary_image, series_id, season_no, episode_no, library_name FROM jellyfin_items`

function itemFinding(
  ctx: RuleContext, ruleId: string, row: Row, severity: Finding['severity'], evidence: Record<string, unknown>,
): Finding {
  return {
    id: findingId(ruleId, row.id),
    ruleId,
    class: 'metadata',
    severity,
    confidence: 'exact',
    subjects: [{ kind: 'item', id: row.id, label: row.name, path: row.container_path ?? undefined }],
    evidence,
    reclaimableBytes: null,
    status: 'open',
    firstSeen: ctx.now,
    lastSeen: ctx.now,
  }
}

const PLAYABLE = new Set(['Movie', 'Episode'])

const unidentified: Rule = {
  id: 'meta.unidentified', class: 'metadata', requires: ['jellyfin'],
  run(ctx) {
    return (ctx.db.prepare(ALL).all() as Row[])
      .filter((r) => PLAYABLE.has(r.type) && Object.keys(JSON.parse(r.provider_ids_json) as object).length === 0)
      .map((r) => itemFinding(ctx, 'meta.unidentified', r, 'warning', { path: r.jf_path }))
  },
}

const missingArtwork: Rule = {
  id: 'meta.missing-artwork', class: 'metadata', requires: ['jellyfin'],
  run(ctx) {
    return (ctx.db.prepare(ALL).all() as Row[])
      .filter((r) => r.has_primary_image === 0)
      .map((r) => itemFinding(ctx, 'meta.missing-artwork', r, 'info', { type: r.type }))
  },
}

const missingYear: Rule = {
  id: 'meta.missing-year', class: 'metadata', requires: ['jellyfin'],
  run(ctx) {
    return (ctx.db.prepare(ALL).all() as Row[])
      .filter((r) => (r.type === 'Movie' || r.type === 'Series') && r.year === null)
      .map((r) => itemFinding(ctx, 'meta.missing-year', r, 'info', { type: r.type }))
  },
}

const episodeNoSeason: Rule = {
  id: 'meta.episode-no-season', class: 'metadata', requires: ['jellyfin'],
  run(ctx) {
    return (ctx.db.prepare(ALL).all() as Row[])
      .filter((r) => r.type === 'Episode' && (r.season_no === null || r.series_id === null))
      .map((r) => itemFinding(ctx, 'meta.episode-no-season', r, 'warning', {
        seriesId: r.series_id, seasonNo: r.season_no, episodeNo: r.episode_no,
      }))
  },
}

const mixedContent: Rule = {
  id: 'meta.mixed-content', class: 'metadata', requires: ['jellyfin'],
  run(ctx) {
    const rows = ctx.db.prepare(
      `SELECT library_name, type, COUNT(*) c FROM jellyfin_items
       WHERE library_name IS NOT NULL AND type IN ('Movie','Episode') GROUP BY library_name, type`,
    ).all() as Array<{ library_name: string; type: string; c: number }>
    const byLibrary = new Map<string, Record<string, number>>()
    for (const r of rows) {
      const entry = byLibrary.get(r.library_name) ?? {}
      entry[r.type] = r.c
      byLibrary.set(r.library_name, entry)
    }
    const out: Finding[] = []
    for (const [library, counts] of byLibrary) {
      if (Object.keys(counts).length < 2) continue
      out.push({
        id: findingId('meta.mixed-content', library),
        ruleId: 'meta.mixed-content',
        class: 'metadata',
        severity: 'warning',
        confidence: 'exact',
        subjects: [{ kind: 'path', path: library, label: library }],
        evidence: { library, counts },
        reclaimableBytes: null,
        status: 'open',
        firstSeen: ctx.now,
        lastSeen: ctx.now,
      })
    }
    return out
  },
}

const MOVIE_FOLDER = /\((?:19|20)\d{2}\)\/[^/]+$/
const EPISODE_TOKEN = /s\d{1,2}[ ._-]?e\d{1,3}/i

const badNaming: Rule = {
  id: 'meta.bad-naming', class: 'metadata', requires: ['jellyfin'],
  run(ctx) {
    const out: Finding[] = []
    for (const r of ctx.db.prepare(ALL).all() as Row[]) {
      if (!r.jf_path) continue
      if (r.type === 'Movie' && !MOVIE_FOLDER.test(r.jf_path)) {
        out.push(itemFinding(ctx, 'meta.bad-naming', r, 'info', {
          path: r.jf_path, expected: 'Movie Title (Year)/Movie Title (Year).ext',
        }))
      } else if (r.type === 'Episode' && !EPISODE_TOKEN.test(r.jf_path)) {
        out.push(itemFinding(ctx, 'meta.bad-naming', r, 'info', {
          path: r.jf_path, expected: 'Series/Season 01/Series - S01E01.ext',
        }))
      }
    }
    return out
  },
}

export const METADATA_RULES: Rule[] = [
  unidentified, missingArtwork, missingYear, episodeNoSeason, mixedContent, badNaming,
]
```

- [ ] **Step 5: Implement the quality rules**

```ts
// src/rules/quality/index.ts
import type { Finding } from '../../core/types.js'
import { findingId } from '../../core/types.js'
import type { Rule, RuleContext } from '../types.js'

interface Row {
  id: string; type: string; name: string; height: number | null; bitrate: number | null
  container: string | null; video_codec: string | null; audio_codec: string | null
  runtime_ticks: number | null; size_bytes: number | null; container_path: string | null
}

const ALL = `SELECT id, type, name, height, bitrate, container, video_codec, audio_codec,
  runtime_ticks, size_bytes, container_path FROM jellyfin_items WHERE type IN ('Movie','Episode')`

function itemFinding(ctx: RuleContext, ruleId: string, row: Row, evidence: Record<string, unknown>, severity: Finding['severity'] = 'info'): Finding {
  return {
    id: findingId(ruleId, row.id),
    ruleId,
    class: 'quality',
    severity,
    confidence: 'strong',
    subjects: [{ kind: 'item', id: row.id, label: row.name, path: row.container_path ?? undefined }],
    evidence,
    reclaimableBytes: null,
    status: 'open',
    firstSeen: ctx.now,
    lastSeen: ctx.now,
  }
}

/** Picks the configured floor whose height bucket is closest at or below the item's height. */
function floorFor(height: number, floors: Record<string, number>): number | null {
  const buckets = Object.keys(floors).map(Number).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b)
  let chosen: number | null = null
  for (const b of buckets) if (height >= b) chosen = b
  return chosen === null ? null : floors[String(chosen)] ?? null
}

const lowBitrate: Rule = {
  id: 'quality.low-bitrate', class: 'quality', requires: ['jellyfin'],
  run(ctx) {
    const cfg = ctx.config.rules['quality.low-bitrate']
    if (!cfg.enabled) return []
    return (ctx.db.prepare(ALL).all() as Row[])
      .filter((r) => {
        if (r.bitrate === null || r.height === null) return false
        const floorKbps = floorFor(r.height, cfg.floorsKbpsByHeight)
        return floorKbps !== null && r.bitrate / 1000 < floorKbps
      })
      .map((r) => itemFinding(ctx, 'quality.low-bitrate', r, {
        bitrateKbps: Math.round((r.bitrate ?? 0) / 1000),
        floorKbps: floorFor(r.height!, cfg.floorsKbpsByHeight),
        height: r.height,
      }))
  },
}

const tinyFile: Rule = {
  id: 'quality.tiny-file', class: 'quality', requires: ['jellyfin'],
  run(ctx) {
    const cfg = ctx.config.rules['quality.tiny-file']
    if (!cfg.enabled) return []
    const rows = (ctx.db.prepare(ALL).all() as Row[]).filter((r) => r.size_bytes && r.height)
    const byHeight = new Map<number, Row[]>()
    for (const r of rows) {
      const list = byHeight.get(r.height!)
      if (list) list.push(r); else byHeight.set(r.height!, [r])
    }
    const out: Finding[] = []
    for (const peers of byHeight.values()) {
      if (peers.length < 3) continue
      const sizes = peers.map((p) => p.size_bytes!).sort((a, b) => a - b)
      const median = sizes[Math.floor(sizes.length / 2)]!
      for (const r of peers) {
        if (r.size_bytes! < median * cfg.peerRatio) {
          out.push(itemFinding(ctx, 'quality.tiny-file', r, {
            sizeBytes: r.size_bytes, peerMedianBytes: median, ratio: Number((r.size_bytes! / median).toFixed(3)),
          }, 'warning'))
        }
      }
    }
    return out
  },
}

const transcodeRisk: Rule = {
  id: 'quality.transcode-risk', class: 'quality', requires: ['jellyfin'],
  run(ctx) {
    const cfg = ctx.config.rules['quality.transcode-risk']
    if (!cfg.enabled) return []
    const codecs = new Set(cfg.allowedVideoCodecs.map((c) => c.toLowerCase()))
    const containers = new Set(cfg.allowedContainers.map((c) => c.toLowerCase()))
    return (ctx.db.prepare(ALL).all() as Row[])
      .filter((r) => {
        const codecBad = r.video_codec !== null && !codecs.has(r.video_codec.toLowerCase())
        const containerBad = r.container !== null && !containers.has(r.container.toLowerCase())
        return codecBad || containerBad
      })
      .map((r) => itemFinding(ctx, 'quality.transcode-risk', r, {
        videoCodec: r.video_codec, container: r.container,
        allowedVideoCodecs: cfg.allowedVideoCodecs, allowedContainers: cfg.allowedContainers,
      }))
  },
}

const missingSubs: Rule = {
  id: 'quality.missing-subs', class: 'quality', requires: ['jellyfin', 'filesystem'],
  run(ctx) {
    const rows = ctx.db.prepare(`SELECT i.id AS id, i.type AS type, i.name AS name,
      i.container_path AS container_path, i.height AS height, i.bitrate AS bitrate,
      i.container AS container, i.video_codec AS video_codec, i.audio_codec AS audio_codec,
      i.runtime_ticks AS runtime_ticks, i.size_bytes AS size_bytes
      FROM jellyfin_items i
      WHERE i.type IN ('Movie','Episode') AND i.container_path IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM fs_entries f
          WHERE f.parent_path = (SELECT parent_path FROM fs_entries WHERE container_path = i.container_path)
            AND lower(f.ext) IN ('.srt', '.ass', '.sub')
        )`).all() as Row[]
    return rows.map((r) => itemFinding(ctx, 'quality.missing-subs', r, { hasExternalSubtitles: false }))
  },
}

const biggest: Rule = {
  id: 'quality.biggest', class: 'quality', requires: ['jellyfin'],
  run(ctx) {
    const cfg = ctx.config.rules['quality.biggest']
    if (!cfg.enabled) return []
    const rows = ctx.db.prepare(
      `SELECT id, name, container_path, size_bytes FROM jellyfin_items
       WHERE size_bytes IS NOT NULL ORDER BY size_bytes DESC LIMIT ?`,
    ).all(cfg.topN) as Array<{ id: string; name: string; container_path: string | null; size_bytes: number }>
    if (!rows.length) return []
    return [{
      id: findingId('quality.biggest', 'report'),
      ruleId: 'quality.biggest',
      class: 'quality' as const,
      severity: 'info' as const,
      confidence: 'exact' as const,
      subjects: rows.map((r) => ({ kind: 'item' as const, id: r.id, label: r.name, path: r.container_path ?? undefined })),
      evidence: { items: rows.map((r) => ({ id: r.id, name: r.name, sizeBytes: r.size_bytes })) },
      reclaimableBytes: null,
      status: 'open' as const,
      firstSeen: ctx.now,
      lastSeen: ctx.now,
    }]
  },
}

export const QUALITY_RULES: Rule[] = [lowBitrate, tinyFile, transcodeRisk, missingSubs, biggest]
```

Register both in `src/rules/registry.ts`:

```ts
import { METADATA_RULES } from './metadata/index.js'
import { QUALITY_RULES } from './quality/index.js'
export const ALL_RULES: Rule[] = [dupeGroupRule, ...FILESYSTEM_RULES, ...METADATA_RULES, ...QUALITY_RULES]
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npx vitest run tests/rules && npm run typecheck`
Expected: all rule tests PASS (metadata 12 + quality 10 + earlier).

- [ ] **Step 7: Commit**

```bash
git add src/rules/metadata src/rules/quality src/rules/registry.ts tests/rules/metadata.test.ts tests/rules/quality.test.ts
git commit -m "feat: metadata integrity and quality rules"
```

---

### Task 7: Rules scan phase and findings API

**Files:**
- Create: `src/scan/phases/rules.ts`, `src/api/findings.ts`
- Modify: `src/scan/orchestrator.ts` (append the phase), `src/server.ts`
- Test: `tests/api/findings.test.ts`

**Interfaces:**
- Consumes: `runRules`, `ALL_RULES`, `requireSession`.
- Produces:
  - `rulesPhase: Phase` — derives `availableSources` from what the preceding phases actually wrote, then calls `runRules`.
  - Routes: `GET /api/findings` (filters: `class`, `severity`, `confidence`, `status`, `ruleId`, `limit`, `offset`), `POST /api/findings/:id/dismiss` (body `{ reason }`), `POST /api/findings/:id/reopen`, `GET /api/findings/summary`, `GET /api/duplicates`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/api/findings.test.ts
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
const auth = () => ({ cookie: `jellymaid_session=${signSession({ username: 'bob', userId: 'u', issuedAt: Date.now() }, SECRET)}` })

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
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/api/findings.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the rules phase**

Widen `PhaseName` in `src/scan/phases/types.ts` **first** — `rulesPhase` will not typecheck until `'rules'` is a member:

```ts
export type PhaseName = 'jellyfin' | 'filesystem' | 'qbittorrent' | 'arr' | 'rules'
```

```ts
// src/scan/phases/rules.ts
import type { Phase } from './types.js'
import type { Db } from '../../index/db.js'
import { runRules } from '../../rules/runner.js'
import type { SourceName } from '../../rules/types.js'

/** Sources are derived from what actually landed in the index, not from what was configured. */
function availableSources(db: Db): Set<SourceName> {
  const has = (sql: string) => (db.prepare(sql).get() as { c: number }).c > 0
  const sources = new Set<SourceName>()
  if (has('SELECT COUNT(*) c FROM jellyfin_items')) sources.add('jellyfin')
  if (has('SELECT COUNT(*) c FROM fs_entries')) sources.add('filesystem')
  if (has('SELECT COUNT(*) c FROM torrents')) sources.add('qbittorrent')
  if (has('SELECT COUNT(*) c FROM arr_records')) sources.add('arr')
  if (has('SELECT COUNT(*) c FROM fs_entries WHERE quick_hash IS NOT NULL')) sources.add('hashes')
  return sources
}

export const rulesPhase: Phase = {
  name: 'rules',
  async run(ctx) {
    const summary = runRules({
      db: ctx.db,
      config: ctx.deps.config,
      scanId: ctx.scanId,
      availableSources: availableSources(ctx.db),
    })
    return {
      status: 'completed',
      counts: {
        created: summary.created,
        resolved: summary.resolved,
        reopened: summary.reopened,
        notEvaluated: summary.notEvaluated.length,
      },
    }
  },
}
```

Append the phase in `src/scan/orchestrator.ts`:

```ts
import { rulesPhase } from './phases/rules.js'
export const DEFAULT_PHASES: Phase[] = [jellyfinPhase, filesystemPhase, qbittorrentPhase, arrPhase, rulesPhase]
```

- [ ] **Step 4: Implement the findings API**

```ts
// src/api/findings.ts
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Db } from '../index/db.js'
import { requireSession } from './auth.js'
import type { SessionPayload } from '../auth/session.js'

const listQuery = z.object({
  class: z.string().optional(),
  severity: z.string().optional(),
  confidence: z.string().optional(),
  status: z.string().default('open'),
  ruleId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
})

const dismissBody = z.object({ reason: z.string().min(1) })

interface FindingRow {
  id: string; rule_id: string; class: string; severity: string; confidence: string
  subjects_json: string; evidence_json: string; reclaimable_bytes: number | null
  status: string; first_seen: string; last_seen: string
  dismissed_reason: string | null; dismissed_by: string | null
}

const hydrate = (r: FindingRow) => ({
  id: r.id, ruleId: r.rule_id, class: r.class, severity: r.severity, confidence: r.confidence,
  subjects: JSON.parse(r.subjects_json), evidence: JSON.parse(r.evidence_json),
  reclaimableBytes: r.reclaimable_bytes, status: r.status,
  firstSeen: r.first_seen, lastSeen: r.last_seen,
  dismissedReason: r.dismissed_reason, dismissedBy: r.dismissed_by,
})

const sessionOf = (req: FastifyRequest) => (req as FastifyRequest & { session: SessionPayload }).session

export function registerFindingsRoutes(app: FastifyInstance, deps: { db: Db; sessionSecret: string }): void {
  const guard = { preHandler: requireSession(deps.sessionSecret) }

  app.get('/api/findings', guard, async (req, reply) => {
    const parsed = listQuery.safeParse(req.query)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid query' })
    const q = parsed.data

    const where: string[] = ['status = ?']
    const params: unknown[] = [q.status]
    for (const [column, value] of [['class', q.class], ['severity', q.severity], ['confidence', q.confidence], ['rule_id', q.ruleId]] as const) {
      if (value) { where.push(`${column} = ?`); params.push(value) }
    }
    const clause = `WHERE ${where.join(' AND ')}`

    const total = (deps.db.prepare(`SELECT COUNT(*) c FROM findings ${clause}`).get(...params) as { c: number }).c
    const rows = deps.db.prepare(
      `SELECT * FROM findings ${clause} ORDER BY severity, rule_id, id LIMIT ? OFFSET ?`,
    ).all(...params, q.limit, q.offset) as FindingRow[]
    return reply.send({ findings: rows.map(hydrate), total })
  })

  app.get('/api/findings/summary', guard, async (_req, reply) => {
    const byClassRows = deps.db.prepare(
      "SELECT class, COUNT(*) c FROM findings WHERE status = 'open' GROUP BY class",
    ).all() as Array<{ class: string; c: number }>
    const byClass: Record<string, number> = {}
    for (const r of byClassRows) byClass[r.class] = r.c

    const reclaimable = (deps.db.prepare(
      "SELECT COALESCE(SUM(reclaimable_bytes), 0) s FROM findings WHERE status = 'open'",
    ).get() as { s: number }).s

    const latest = deps.db.prepare('SELECT id FROM scans ORDER BY id DESC LIMIT 1').get() as { id: number } | undefined
    const notEvaluated = latest
      ? (deps.db.prepare(
          "SELECT rule_id AS ruleId, reason FROM rule_runs WHERE scan_id = ? AND status = 'not-evaluated'",
        ).all(latest.id) as Array<{ ruleId: string; reason: string }>)
      : []

    return reply.send({ byClass, reclaimableBytes: reclaimable, notEvaluated })
  })

  app.post('/api/findings/:id/dismiss', guard, async (req, reply) => {
    const parsed = dismissBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'a dismiss reason is required' })
    const { id } = req.params as { id: string }
    const info = deps.db.prepare(
      "UPDATE findings SET status='dismissed', dismissed_reason=?, dismissed_by=?, dismissed_at=? WHERE id=?",
    ).run(parsed.data.reason, sessionOf(req).username, new Date().toISOString(), id)
    if (info.changes === 0) return reply.code(404).send({ error: 'no such finding' })
    return reply.send({ ok: true })
  })

  app.post('/api/findings/:id/reopen', guard, async (req, reply) => {
    const { id } = req.params as { id: string }
    const info = deps.db.prepare(
      "UPDATE findings SET status='open', dismissed_reason=NULL, dismissed_by=NULL, dismissed_at=NULL WHERE id=?",
    ).run(id)
    if (info.changes === 0) return reply.code(404).send({ error: 'no such finding' })
    return reply.send({ ok: true })
  })

  app.get('/api/duplicates', guard, async (_req, reply) => {
    const groups = deps.db.prepare("SELECT * FROM dupe_groups WHERE status = 'open' ORDER BY tier, id")
      .all() as Array<{ id: string; tier: string; members_json: string; keeper_item_id: string | null; scores_json: string }>
    const detail = groups.map((g) => {
      const memberIds = JSON.parse(g.members_json) as string[]
      const placeholders = memberIds.map(() => '?').join(',')
      const members = deps.db.prepare(
        `SELECT id, name, container_path, size_bytes, height, bitrate, video_codec, audio_channels,
                container, library_name FROM jellyfin_items WHERE id IN (${placeholders})`,
      ).all(...memberIds)
      return {
        id: g.id, tier: g.tier, keeperItemId: g.keeper_item_id,
        scores: JSON.parse(g.scores_json), members,
      }
    })
    return reply.send({ groups: detail })
  })
}
```

Register in `src/server.ts` after the scan routes:

```ts
  registerFindingsRoutes(app, { db: deps.db, sessionSecret: deps.config.env.sessionSecret })
```

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run && npm run typecheck && npm run build`
Expected: everything PASS.

- [ ] **Step 6: Commit**

```bash
git add src/scan/phases/rules.ts src/scan/phases/types.ts src/scan/orchestrator.ts src/api/findings.ts src/server.ts tests/api/findings.test.ts
git commit -m "feat: rules scan phase and findings api"
```

---

## Definition of done

- `npm test`, `npm run typecheck` and `npm run build` all clean.
- A scan against the real library produces findings in all four classes, and `GET /api/duplicates`
  returns groups whose tiers and keeper choices look right when spot-checked by hand.
- Turning hashing off for every root and rescanning leaves `dupe.identical-file` recorded as
  `not-evaluated` in `rule_runs` — and `/api/findings/summary` surfaces it — rather than silently
  reporting no identical files.
- Dismissing a duplicate group and rescanning leaves it dismissed.
- Deleting nothing: `grep -rn "unlink\|rmdir\|torrents/delete" src/rules/` returns nothing.
