import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../src/index/db.js'
import {
  readVerification, writeVerification, verificationBlocker, VERIFICATION_KV_KEY, type VerificationRecord,
} from '../../src/scan/verification.js'

let db: Db

const current = { mappingsHash: '0123456789abcdef', instanceIds: ['box-a', 'box-b'] }

/** A record that passes against `current`. box-b has no completed torrents, so it sampled nothing. */
function clean(): VerificationRecord {
  return {
    at: '2026-10-30T00:00:00.000Z',
    mappingsHash: current.mappingsHash,
    jellyfin: { sampled: 20, resolved: 20, failures: [] },
    qbit: [
      { instanceId: 'box-a', sampled: 5, resolved: 5, failures: [] },
      { instanceId: 'box-b', sampled: 0, resolved: 0, failures: [] },
    ],
  }
}

const blockerFor = (record: VerificationRecord) => {
  writeVerification(db, record)
  return verificationBlocker(db, current)
}

beforeEach(() => { db = openDb(join(mkdtempSync(join(tmpdir(), 'jm-verify-')), 'db.sqlite')) })

describe('verificationBlocker', () => {
  it('lets a current, clean record through — an instance that sampled 0 with no failures passes', () => {
    expect(blockerFor(clean())).toBeNull()
  })

  it('blocks when the mappings were never verified', () => {
    expect(verificationBlocker(db, current)).toMatch(/never been verified/i)
  })

  it('blocks when the mapping set changed since the record was written', () => {
    expect(blockerFor({ ...clean(), mappingsHash: 'fedcba9876543210' })).toMatch(/changed/i)
  })

  it('blocks a Jellyfin half that sampled nothing — checking nothing is not a pass', () => {
    expect(blockerFor({ ...clean(), jellyfin: { sampled: 0, resolved: 0, failures: [] } })).toMatch(/sampled 0/i)
  })

  it('blocks a Jellyfin half with a failure', () => {
    const record = clean()
    record.jellyfin = { sampled: 20, resolved: 20, failures: [{ jellyfinPath: '/data/x.mkv', reason: 'no mapping covers this path' }] }
    expect(blockerFor(record)).toMatch(/20 of 20/)
  })

  it('blocks a Jellyfin half that resolved fewer items than it sampled', () => {
    expect(blockerFor({ ...clean(), jellyfin: { sampled: 20, resolved: 19, failures: [] } })).toMatch(/19 of 20/)
  })

  it('blocks a configured instance the record has no report for', () => {
    const record = clean()
    record.qbit = record.qbit.filter((r) => r.instanceId !== 'box-b')
    expect(blockerFor(record)).toMatch(/box-b/)
  })

  it('blocks an instance report with a failure', () => {
    const record = clean()
    record.qbit[0] = { instanceId: 'box-a', sampled: 5, resolved: 5, failures: [{ qbitPath: '/movies/X', reason: 'maps nowhere' }] }
    expect(blockerFor(record)).toMatch(/box-a/)
  })

  it('names the first failure when every sampled torrent resolved but the report still failed (final review I1)', () => {
    // "resolved 20 of 20" alone reads as a pass: the operator has to be told what actually failed.
    const record = clean()
    record.qbit[0] = {
      instanceId: 'box-a', sampled: 5, resolved: 5,
      failures: [
        { qbitPath: '/tv/Show', reason: 'root /mnt/tv is marked not torrent-backed, but qBittorrent instance "box-a" seeds this torrent there' },
        { qbitPath: '/tv/Other', reason: 'another' },
      ],
    }
    const blocker = blockerFor(record)
    expect(blocker).toMatch(/box-a/)
    expect(blocker).toMatch(/not torrent-backed/)
    expect(blocker).toMatch(/1 more/)
  })

  it('blocks an instance report that resolved fewer torrents than it sampled', () => {
    const record = clean()
    record.qbit[0] = { instanceId: 'box-a', sampled: 5, resolved: 4, failures: [] }
    const blocker = blockerFor(record)
    expect(blocker).toMatch(/box-a/)
    expect(blocker).toMatch(/4 of 5/)
  })

  it('names the cause when an instance could not be listed at all, instead of reporting "0 of 0" (harness E2E)', () => {
    // Seen on the real stack: box-b behind auth with a wrong password. Verify records the listing
    // failure with nothing sampled, and the plan screen and scan refusal then said only "resolved
    // 0 of 0 sampled torrents" — true, and no help: the operator could not tell it was the login.
    const record = clean()
    record.qbit[1] = {
      instanceId: 'box-b', sampled: 0, resolved: 0,
      failures: [{ qbitPath: '', reason: 'could not list torrents: [qbittorrent] auth: instance "box-b" rejected the login' }],
    }
    const blocker = blockerFor(record)
    expect(blocker).toMatch(/box-b/)
    expect(blocker).toMatch(/rejected the login/)
    expect(blocker).not.toMatch(/0 of 0/)
  })

  it('lets through a report that ignored torrents outside every mapped folder and failed nothing (final fix wave part 2)', () => {
    const record = clean()
    record.qbit[1] = { instanceId: 'box-b', sampled: 0, resolved: 0, failures: [], ignored: { count: 819, examples: ['/music/Album'] } }
    expect(blockerFor(record)).toBeNull()
  })

  it('names a mapped prefix that no completed torrent lies under (final fix wave part 2)', () => {
    const record = clean()
    record.qbit[0] = {
      instanceId: 'box-a', sampled: 0, resolved: 0,
      failures: [{ qbitPath: '/move', reason: 'no completed torrent of "box-a" reports a path under /move — check the qBittorrent path' }],
      ignored: { count: 40, examples: ['/movies/Heat (1995)'] },
    }
    const blocker = blockerFor(record)
    expect(blocker).toMatch(/box-a/)
    expect(blocker).toMatch(/under \/move/)
  })

  it('blocks on ANY failing report, including one for an instance that is no longer configured', () => {
    // Fail closed: a failing report is evidence something was wrong when it was taken, and the
    // remedy (verify again) is cheap. Guessing that it no longer matters is not.
    const record = clean()
    record.qbit.push({ instanceId: 'box-gone', sampled: 3, resolved: 0, failures: [{ qbitPath: '/x', reason: 'gone' }] })
    expect(blockerFor(record)).toMatch(/box-gone/)
  })
})

describe('readVerification / writeVerification', () => {
  it('round-trips a record under the documented kv key', () => {
    writeVerification(db, clean())
    expect(readVerification(db)).toEqual(clean())
    const raw = db.prepare('SELECT value_json FROM kv WHERE key = ?').get(VERIFICATION_KV_KEY) as { value_json: string }
    expect(JSON.parse(raw.value_json)).toEqual(clean())
  })

  it('keeps the count of torrents a report ignored, with its examples (final fix wave part 2)', () => {
    const record = clean()
    record.qbit[1] = { instanceId: 'box-b', sampled: 0, resolved: 0, failures: [], ignored: { count: 819, examples: ['/music/Album', '/books/Novel.epub'] } }
    writeVerification(db, record)
    expect(readVerification(db)).toEqual(record)
  })

  it('returns null when nothing was ever written', () => {
    expect(readVerification(db)).toBeNull()
  })

  it('reads the legacy flat shape as Jellyfin-only and stale', () => {
    db.prepare('INSERT INTO kv (key, value_json) VALUES (?, ?)').run(VERIFICATION_KV_KEY, JSON.stringify({
      sampled: 20, resolved: 20, failures: [], at: '2026-07-30T00:00:00.000Z',
    }))
    expect(readVerification(db)).toEqual({
      at: '2026-07-30T00:00:00.000Z',
      mappingsHash: '',
      jellyfin: { sampled: 20, resolved: 20, failures: [] },
      qbit: [],
    })
    // A record that predates the mapping hash can never be current, so it blocks.
    expect(verificationBlocker(db, current)).toMatch(/changed/i)
  })

  it('treats an unreadable record as absent, which blocks', () => {
    db.prepare('INSERT INTO kv (key, value_json) VALUES (?, ?)').run(VERIFICATION_KV_KEY, '{ torn')
    expect(readVerification(db)).toBeNull()
    expect(verificationBlocker(db, current)).toMatch(/never been verified/i)
  })
})

describe('readVerification — checks what it reads (a stored record is data, not a promise)', () => {
  /** Stores `value` verbatim: a hand-edited, truncated or older-version record is exactly this. */
  const store = (value: unknown) =>
    db.prepare('INSERT OR REPLACE INTO kv (key, value_json) VALUES (?, ?)').run(VERIFICATION_KV_KEY, JSON.stringify(value))

  // Each case is a record that carries the right top-level keys but cannot be trusted: the gate
  // compares `sampled`, `resolved` and `failures.length`, and a missing or mistyped field makes
  // those comparisons quietly come out "fine" (`undefined <= 0` is false) or throw only later.
  const bad: Array<[string, (r: Record<string, any>) => void]> = [
    ['jellyfin half has no counts', (r) => { r.jellyfin = {} }],
    ['jellyfin sampled is a string', (r) => { r.jellyfin.sampled = '20' }],
    ['jellyfin resolved is a string', (r) => { r.jellyfin.resolved = '20' }],
    ['jellyfin count is negative', (r) => { r.jellyfin.resolved = -1 }],
    ['jellyfin count is fractional', (r) => { r.jellyfin.sampled = 1.5 }],
    ['jellyfin resolved exceeds sampled', (r) => { r.jellyfin.resolved = 21 }],
    ['jellyfin failures is not a list', (r) => { r.jellyfin.failures = {} }],
    ['jellyfin failure has no reason', (r) => { r.jellyfin.failures = [{ jellyfinPath: '/x' }] }],
    ['jellyfin failure has no path', (r) => { r.jellyfin.failures = [{ reason: 'gone' }] }],
    ['qbit is not a list', (r) => { r.qbit = {} }],
    ['qbit report has no instance id', (r) => { delete r.qbit[0].instanceId }],
    ['qbit report instance id is not a string', (r) => { r.qbit[0].instanceId = 7 }],
    ['qbit report resolved is a string', (r) => { r.qbit[0].resolved = '5' }],
    ['qbit report resolved exceeds sampled', (r) => { r.qbit[0].resolved = 6 }],
    ['qbit report failures is missing', (r) => { delete r.qbit[0].failures }],
    ['qbit failure names its path under the wrong key', (r) => { r.qbit[0].failures = [{ path: '/x', reason: 'gone' }] }],
    ['qbit report ignored count is a string', (r) => { r.qbit[0].ignored = { count: '5', examples: [] } }],
    ['qbit report ignored count is negative', (r) => { r.qbit[0].ignored = { count: -1, examples: [] } }],
    ['qbit report ignored examples is not a list', (r) => { r.qbit[0].ignored = { count: 1, examples: '/music' } }],
    ['timestamp is not a string', (r) => { r.at = 1730000000 }],
    ['mapping hash is not a string', (r) => { r.mappingsHash = 42 }],
  ]

  it.each(bad)('reads a record whose %s as absent, which blocks', (_name, damage) => {
    const record = JSON.parse(JSON.stringify(clean())) as Record<string, any>
    damage(record)
    store(record)
    expect(readVerification(db)).toBeNull()
    expect(verificationBlocker(db, current)).toMatch(/never been verified/i)
  })

  it.each([
    ['null', null],
    ['a list', [clean()]],
    ['a number', 7],
    ['a string', 'ok'],
  ])('reads %s as absent', (_name, value) => {
    store(value)
    expect(readVerification(db)).toBeNull()
  })

  it('reads a legacy record with mistyped fields as absent rather than as a stale pass', () => {
    store({ sampled: '20', resolved: 20, failures: [], at: '2026-07-30T00:00:00.000Z' })
    expect(readVerification(db)).toBeNull()
    store({ sampled: 20, resolved: 20, failures: [] }) // no timestamp
    expect(readVerification(db)).toBeNull()
    store({ sampled: 20, resolved: 21, failures: [], at: '2026-07-30T00:00:00.000Z' })
    expect(readVerification(db)).toBeNull()
  })

  it('tolerates a field it does not know, so a newer writer does not turn the gate into a permanent block', () => {
    store({ ...clean(), recheckedBy: 'someone' })
    expect(readVerification(db)).toEqual(clean())
    expect(verificationBlocker(db, current)).toBeNull()
  })

  it('still reads a well-formed record exactly as written', () => {
    store(clean())
    expect(readVerification(db)).toEqual(clean())
  })
})
