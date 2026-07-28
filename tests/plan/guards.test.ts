import { describe, it, expect } from 'vitest'
import { evaluateGuards, isBlocked } from '../../src/plan/guards.js'
import { fileConfigSchema } from '../../src/config/schema.js'
import type { Resolution } from '../../src/plan/resolve.js'

const config = (over = {}) => fileConfigSchema.parse({ guards: { minRatio: 1.0, minSeedTimeDays: 14, ...over } })

const torrent = (over = {}) => ({
  hash: 'H1', name: 'Heat', category: null, tags: [] as string[], state: 'stalledUP',
  ratio: 2, seedingTimeSeconds: 30 * 86_400, isPrivate: false, trackerHost: 't.example',
  privacySource: 'flag' as const, matchedBy: 'inode' as const, ...over,
})

const resolution = (over: Partial<Resolution> = {}): Resolution => ({
  path: '/mnt/m/Heat.mkv', exists: true, sizeBytes: 100, dev: 1, inode: 2, nlink: 1,
  hardlinks: ['/mnt/m/Heat.mkv'], torrents: [], arr: [], root: null, sourcesUnavailable: [],
  jellyfin: { itemId: null, isAlternateVersion: false, siblingPaths: [] },
  ...over,
})

const verdict = (verdicts: ReturnType<typeof evaluateGuards>, id: string) => verdicts.find((v) => v.guard === id)!

describe('guard.private-ratio', () => {
  it('passes a public torrent regardless of ratio', () => {
    const v = evaluateGuards(resolution({ torrents: [torrent({ isPrivate: false, ratio: 0, seedingTimeSeconds: 0 })] }), config())
    expect(verdict(v, 'guard.private-ratio').outcome).toBe('pass')
  })

  it('blocks a private torrent below the ratio minimum', () => {
    const v = evaluateGuards(resolution({ torrents: [torrent({ isPrivate: true, ratio: 0.4 })] }), config())
    const g = verdict(v, 'guard.private-ratio')
    expect(g.outcome).toBe('block')
    expect(g.overridable).toBe(true)
    expect(g.reason).toMatch(/ratio/i)
  })

  it('blocks a private torrent below the seed-time minimum even at a good ratio', () => {
    const v = evaluateGuards(resolution({ torrents: [torrent({ isPrivate: true, ratio: 5, seedingTimeSeconds: 86_400 })] }), config())
    expect(verdict(v, 'guard.private-ratio').outcome).toBe('block')
    expect(verdict(v, 'guard.private-ratio').reason).toMatch(/seed/i)
  })

  it('passes a private torrent that meets both minimums', () => {
    const v = evaluateGuards(resolution({ torrents: [torrent({ isPrivate: true, ratio: 1.5, seedingTimeSeconds: 20 * 86_400 })] }), config())
    expect(verdict(v, 'guard.private-ratio').outcome).toBe('pass')
  })

  it('blocks when any one of several torrents fails', () => {
    const v = evaluateGuards(resolution({
      torrents: [torrent({ isPrivate: true, ratio: 5, seedingTimeSeconds: 30 * 86_400 }), torrent({ hash: 'H2', isPrivate: true, ratio: 0.1 })],
    }), config())
    expect(verdict(v, 'guard.private-ratio').outcome).toBe('block')
  })

  it('respects raised minimums from config', () => {
    const v = evaluateGuards(resolution({ torrents: [torrent({ isPrivate: true, ratio: 1.5, seedingTimeSeconds: 20 * 86_400 })] }), config({ minRatio: 3 }))
    expect(verdict(v, 'guard.private-ratio').outcome).toBe('block')
  })

  it('surfaces privacySource in evidence so an operator can tell a real private tracker from an assumption', () => {
    const v = evaluateGuards(resolution({ torrents: [torrent({ isPrivate: true, ratio: 0.1, privacySource: 'undetermined' })] }), config())
    const g = verdict(v, 'guard.private-ratio')
    const offenders = g.evidence.offenders as Array<{ privacySource: string }>
    expect(offenders[0]?.privacySource).toBe('undetermined')
  })
})

describe('guard.cross-seed', () => {
  it('passes with zero or one torrent', () => {
    expect(verdict(evaluateGuards(resolution(), config()), 'guard.cross-seed').outcome).toBe('pass')
    expect(verdict(evaluateGuards(resolution({ torrents: [torrent()] }), config()), 'guard.cross-seed').outcome).toBe('pass')
  })

  it('blocks when two torrents share the target, listing both hashes', () => {
    const v = verdict(evaluateGuards(resolution({ torrents: [torrent({ hash: 'A' }), torrent({ hash: 'B' })] }), config()), 'guard.cross-seed')
    expect(v.outcome).toBe('block')
    expect(v.overridable).toBe(true)
    expect(v.evidence.hashes).toEqual(['A', 'B'])
  })
})

describe('guard.hardlink', () => {
  it('passes for a single-link file', () => {
    expect(verdict(evaluateGuards(resolution(), config()), 'guard.hardlink').outcome).toBe('pass')
  })

  it('warns, never blocks, when other links exist and lists them', () => {
    const v = verdict(evaluateGuards(resolution({
      nlink: 2, hardlinks: ['/mnt/m/Heat.mkv', '/mnt/d/Heat.mkv'],
    }), config()), 'guard.hardlink')
    expect(v.outcome).toBe('warn')
    expect(v.evidence.otherLinks).toEqual(['/mnt/d/Heat.mkv'])
    expect(v.evidence.bytesReclaimed).toBe(0)
  })

  it('reports the real byte saving when every link is included', () => {
    const v = verdict(evaluateGuards(resolution({ nlink: 1, hardlinks: ['/mnt/m/Heat.mkv'], sizeBytes: 500 }), config()), 'guard.hardlink')
    expect(v.evidence.bytesReclaimed).toBe(500)
  })

  // Adversarial case: the live stat (nlink) is authoritative; the `hardlinks` list is only as
  // complete as the last scan's fs_entries index. A sibling link created (or living under a root)
  // since the last scan means nlink says 2 while the index can only name 1 path (this one). Must
  // never fall through to the single-link "pass" branch just because `others` is empty — that
  // would report `bytesReclaimed: sizeBytes` for a file that provably still has another link on
  // disk right now.
  it('warns — never claims a full reclaim — when nlink says another link exists but the index cannot name it', () => {
    const v = verdict(evaluateGuards(resolution({ nlink: 2, hardlinks: ['/mnt/m/Heat.mkv'], sizeBytes: 500 }), config()), 'guard.hardlink')
    expect(v.outcome).toBe('warn')
    expect(v.evidence.bytesReclaimed).toBe(0)
    expect(v.evidence.otherLinks).toEqual([])
    expect(v.evidence.unresolvedLinks).toBe(1)
  })
})

describe('guard.protected', () => {
  it('blocks a downloading torrent and is not overridable', () => {
    const v = verdict(evaluateGuards(resolution({ torrents: [torrent({ state: 'downloading' })] }), config()), 'guard.protected')
    expect(v.outcome).toBe('block')
    expect(v.overridable).toBe(false)
  })

  it.each(['checkingUP', 'moving', 'allocating'])('blocks state %s', (state) => {
    expect(verdict(evaluateGuards(resolution({ torrents: [torrent({ state })] }), config()), 'guard.protected').outcome).toBe('block')
  })

  it('blocks a protected category', () => {
    const cfg = fileConfigSchema.parse({ guards: { protectedCategories: ['permaseed'] } })
    expect(verdict(evaluateGuards(resolution({ torrents: [torrent({ category: 'permaseed' })] }), cfg), 'guard.protected').outcome).toBe('block')
  })

  it('blocks a protected tag', () => {
    const cfg = fileConfigSchema.parse({ guards: { protectedTags: ['keep'] } })
    expect(verdict(evaluateGuards(resolution({ torrents: [torrent({ tags: ['hd', 'keep'] })] }), cfg), 'guard.protected').outcome).toBe('block')
  })

  it('blocks when qBittorrent could not be reached — unknown torrent state is not a safe state', () => {
    const v = verdict(evaluateGuards(resolution({ sourcesUnavailable: ['qbittorrent'] }), config()), 'guard.protected')
    expect(v.outcome).toBe('block')
    expect(v.overridable).toBe(false)
    expect(v.reason).toMatch(/unavailable/i)
  })

  // Adversarial case: the qbittorrent connector itself falls back to the literal string
  // 'unknown' when a torrent's `state` field is missing or unparseable (see `t.state ?? 'unknown'`
  // in connectors/qbittorrent.ts) — a genuine possibility on API version skew or a malformed
  // response, not a hypothetical. `BUSY_STATES` is an allowlist of specific busy states, so an
  // unrecognized value silently fell through as "not busy" unless explicitly handled. The global
  // "unknown state fails closed" rule is stated for source-unavailability, but the same reasoning
  // applies one level down, to a single torrent whose own reported state IS the unknown.
  it('blocks a torrent whose reported state is the literal "unknown" sentinel', () => {
    const v = verdict(evaluateGuards(resolution({ torrents: [torrent({ state: 'unknown' })] }), config()), 'guard.protected')
    expect(v.outcome).toBe('block')
    expect(v.overridable).toBe(false)
  })

  // Fix round 1: a partial *arr inventory (a Sonarr per-series fetch skipped, `complete: false`)
  // leaves a genuinely-monitored file's ArrMatch silently absent from `resolution.arr`. The drafted
  // executor (task-5-brief) only unmonitors records it finds by iterating `resolution.arr`, so an
  // absent-due-to-partial-fetch record means the unmonitor step never runs and the *arr re-grabs
  // what was just deleted — invisibly, since nothing failed loudly. Blocking here, before approval,
  // is where an unverifiable-state concern belongs — the same rationale this guard already applies
  // to an unreachable qBittorrent.
  it('blocks when Sonarr could not be verified (partial inventory), naming sonarr and unmonitoring', () => {
    const v = verdict(evaluateGuards(resolution({ sourcesUnavailable: ['sonarr'] }), config()), 'guard.protected')
    expect(v.outcome).toBe('block')
    expect(v.overridable).toBe(false)
    expect(v.reason).toMatch(/sonarr/i)
    expect(v.reason).toMatch(/unmonitor/i)
  })

  it('blocks when Radarr could not be verified (partial inventory), naming radarr and unmonitoring', () => {
    const v = verdict(evaluateGuards(resolution({ sourcesUnavailable: ['radarr'] }), config()), 'guard.protected')
    expect(v.outcome).toBe('block')
    expect(v.overridable).toBe(false)
    expect(v.reason).toMatch(/radarr/i)
    expect(v.reason).toMatch(/unmonitor/i)
  })

  it('blocks once, naming both, when qBittorrent and an *arr source are unavailable together', () => {
    const v = verdict(evaluateGuards(resolution({ sourcesUnavailable: ['qbittorrent', 'radarr'] }), config()), 'guard.protected')
    expect(v.outcome).toBe('block')
    expect(v.overridable).toBe(false)
    expect(v.reason).toMatch(/qbittorrent/i)
    expect(v.reason).toMatch(/radarr/i)
  })

  // A `null` radarr/sonarr client (no integration configured at all) is a legitimate "not used",
  // and `resolveTarget` never reports it as unavailable — verified against the resolver's actual
  // behavior in `tests/plan/resolve.test.ts`, "does not flag radarr/sonarr unavailable when both
  // are simply unconfigured (null is a legitimate 'not used')", not assumed here. A `Resolution`
  // built the way that test proves (`sourcesUnavailable: []`) must not wedge every delete just
  // because an operator has no *arr integration at all.
  it('does not block when *arr is simply not configured — sourcesUnavailable stays empty per the resolver', () => {
    const v = verdict(evaluateGuards(resolution({ sourcesUnavailable: [] }), config()), 'guard.protected')
    expect(v.outcome).toBe('pass')
  })
})

describe('isBlocked', () => {
  it('is blocked when any guard blocks', () => {
    const v = evaluateGuards(resolution({ torrents: [torrent({ state: 'downloading' })] }), config())
    expect(isBlocked(v, []).blocked).toBe(true)
  })

  it('clears an overridable block when that guard is overridden', () => {
    const v = evaluateGuards(resolution({ torrents: [torrent({ isPrivate: true, ratio: 0.1 })] }), config())
    expect(isBlocked(v, ['guard.private-ratio']).blocked).toBe(false)
  })

  it('cannot be cleared for a non-overridable guard', () => {
    const v = evaluateGuards(resolution({ torrents: [torrent({ state: 'downloading' })] }), config())
    expect(isBlocked(v, ['guard.protected']).blocked).toBe(true)
    expect(isBlocked(v, ['guard.protected']).by).toEqual(['guard.protected'])
  })

  it('is not blocked by a warn verdict', () => {
    const v = evaluateGuards(resolution({ nlink: 2, hardlinks: ['/a', '/b'] }), config())
    expect(isBlocked(v, []).blocked).toBe(false)
  })
})
