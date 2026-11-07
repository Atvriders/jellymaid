import { describe, it, expect } from 'vitest'
import { evaluateGuards, isBlocked } from '../../src/plan/guards.js'
import { fileConfigSchema } from '../../src/config/schema.js'
import type { Resolution } from '../../src/plan/resolve.js'

const config = (over = {}) => fileConfigSchema.parse({ guards: { minRatio: 1.0, minSeedTimeDays: 14, ...over } })

/** One file of a torrent's list. Sizes default to a film-sized file so nothing is "small" by accident. */
const file = (relPath: string, containerPath: string | null, sizeBytes = 1_000_000) => ({ relPath, containerPath, sizeBytes })

/** A torrent's whole file list, in the shape the resolver reports it. */
const filesOf = (...entries: Array<ReturnType<typeof file>>) => ({ count: entries.length, entries })

const torrent = (over = {}) => ({
  instanceId: 'box-a', hash: 'H1', name: 'Heat', category: null, tags: [] as string[], state: 'stalledUP',
  ratio: 2, seedingTimeSeconds: 30 * 86_400, isPrivate: false, trackerHost: 't.example',
  privacySource: 'flag' as const, matchedBy: 'inode' as const, sizeBytes: 1_000_000, companionCount: 0,
  // A single-file torrent owning exactly the resolution's own path: the shape that makes
  // "remove the torrent with its data" mean what the operator thinks it means.
  files: filesOf(file('Heat.mkv', '/mnt/m/Heat.mkv')), ...over,
})

/** Defaults to a root no torrent saves into, so guard.untracked has nothing to say unless a test asks it. */
const resolution = (over: Partial<Resolution> = {}): Resolution => ({
  path: '/mnt/m/Heat.mkv', exists: true, sizeBytes: 100, dev: 1, inode: 2, nlink: 1,
  hardlinks: ['/mnt/m/Heat.mkv'], torrents: [], arr: [], root: null, sourcesUnavailable: [],
  jellyfin: { itemId: null, isAlternateVersion: false, siblingPaths: [] },
  isDirectory: false, arrUnmappable: { count: 0, samples: [] }, torrentSource: { kind: 'none' },
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

  it('tells two boxes seeding the same infohash apart in its evidence', () => {
    const v = verdict(evaluateGuards(resolution({
      torrents: [torrent({ hash: 'same' }), torrent({ instanceId: 'box-b', hash: 'same' })],
    }), config()), 'guard.cross-seed')
    expect(v.outcome).toBe('block')
    expect(v.evidence.torrents).toEqual([
      { instanceId: 'box-a', hash: 'same', name: 'Heat' }, { instanceId: 'box-b', hash: 'same', name: 'Heat' },
    ])
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
  it('blocks, with no override, when one qBittorrent instance could not be verified, and names it', () => {
    const v = verdict(evaluateGuards(resolution({ sourcesUnavailable: ['qbittorrent:box-b'] }), config()), 'guard.protected')
    expect(v.outcome).toBe('block')
    expect(v.overridable).toBe(false)
    expect(v.reason).toMatch(/box-b/)
  })

  it('names the mapping hole, with no override, when no instance can be determined for the path', () => {
    const hole = 'the mapping for /mnt/m names qBittorrent path /movies but no instance'
    const v = verdict(evaluateGuards(resolution({
      torrentSource: { kind: 'unknown', reason: hole }, sourcesUnavailable: ['qbittorrent'],
    }), config()), 'guard.protected')
    expect(v.outcome).toBe('block')
    expect(v.overridable).toBe(false)
    expect(v.reason).toContain(hole)
  })

  it('names every unavailable instance when several are', () => {
    const v = verdict(evaluateGuards(resolution({ sourcesUnavailable: ['qbittorrent:box-a', 'qbittorrent:box-b'] }), config()), 'guard.protected')
    expect(v.outcome).toBe('block')
    expect(v.reason).toMatch(/box-a/)
    expect(v.reason).toMatch(/box-b/)
  })

  it('does not block when *arr is simply not configured — sourcesUnavailable stays empty per the resolver', () => {
    const v = verdict(evaluateGuards(resolution({ sourcesUnavailable: [] }), config()), 'guard.protected')
    expect(v.outcome).toBe('pass')
  })
})

describe('guard.torrent-scope', () => {
  const pack = (over = {}) => torrent({
    files: filesOf(file('Heat.mkv', '/mnt/m/Heat.mkv'), ...Array.from({ length: 11 }, (_, i) => file(`E${i}.mkv`, `/mnt/m/E${i}.mkv`))),
    ...over,
  })

  /** A movie released the way the owner's torrents arrive: the film, its sidecars and a sample. */
  const movieRelease = () => filesOf(
    file('Heat/Heat.mkv', '/mnt/m/Heat.mkv', 8_000_000_000),
    file('Heat/Heat.nfo', '/mnt/m/Heat.nfo', 4_000),
    file('Heat/Subs/Eng.srt', '/mnt/m/Subs/Eng.srt', 90_000),
    file('Heat/Sample/sample.mkv', '/mnt/m/Sample/sample.mkv', 60_000_000),
  )

  it('torrent-scope ignores companion files', () => {
    const v = verdict(evaluateGuards(resolution({ torrents: [torrent({ files: movieRelease() })] }), config()), 'guard.torrent-scope')
    expect(v.outcome).toBe('pass')
    // The operator is still told what goes along with the film.
    expect(v.evidence.companionFiles).toBe(3)
  })

  it('torrent-scope still blocks a partially queued pack', () => {
    // Ten episodes and an .nfo, one episode queued. The .nfo is a companion and is not counted;
    // the nine other episodes are media the plan never named.
    const season = filesOf(
      ...Array.from({ length: 10 }, (_, i) => file(`Show/S01E${i + 1}.mkv`, `/mnt/m/S01E${i + 1}.mkv`)),
      file('Show/Show.nfo', '/mnt/m/Show.nfo', 2_000),
    )
    const v = verdict(evaluateGuards(resolution({
      path: '/mnt/m/S01E1.mkv', hardlinks: ['/mnt/m/S01E1.mkv'], torrents: [torrent({ files: season })],
    }), config()), 'guard.torrent-scope')
    expect(v.outcome).toBe('block')
    expect(v.overridable).toBe(true)
    const offenders = v.evidence.offenders as Array<{ instanceId: string; filesNotInPlan: number; fileCount: number }>
    expect(offenders[0]).toMatchObject({ instanceId: 'box-a', fileCount: 11, filesNotInPlan: 9 })
    expect(v.reason).toMatch(/9 media file/)
  })

  it('counts a film whose name merely looks like a sample as media, not a companion (Ruling 11)', () => {
    const v = verdict(evaluateGuards(resolution({
      torrents: [torrent({
        files: filesOf(
          file('Pack/Heat.mkv', '/mnt/m/Heat.mkv', 8_000_000_000),
          file('Pack/Sample City (1999).mkv', '/mnt/m/Sample City (1999).mkv', 6_000_000_000),
        ),
      })],
    }), config()), 'guard.torrent-scope')
    expect(v.outcome).toBe('block')
    expect((v.evidence.offenders as Array<{ filesNotInPlan: number }>)[0]!.filesNotInPlan).toBe(1)
  })

  it('counts an oversized sample as media, so it blocks and needs an override', () => {
    const v = verdict(evaluateGuards(resolution({
      torrents: [torrent({
        files: filesOf(
          file('Heat/Heat.mkv', '/mnt/m/Heat.mkv', 1_000),
          file('Heat/Sample/sample.mkv', '/mnt/m/Sample/sample.mkv', 100),
        ),
      })],
    }), config()), 'guard.torrent-scope')
    expect(v.outcome).toBe('block')
  })

  it('lets a companion no mapping covers go with the release — it is still a companion', () => {
    const v = verdict(evaluateGuards(resolution({
      torrents: [torrent({ files: filesOf(file('Heat/Heat.mkv', '/mnt/m/Heat.mkv'), file('Heat/Heat.nfo', null, 10)) })],
    }), config()), 'guard.torrent-scope')
    expect(v.outcome).toBe('pass')
  })

  it('blocks when the target is itself only a companion of a film the plan does not name', () => {
    // Deleting a sample must never take the film it was cut from.
    const v = verdict(evaluateGuards(resolution({
      path: '/mnt/m/Sample/sample.mkv', hardlinks: ['/mnt/m/Sample/sample.mkv'],
      torrents: [torrent({ files: movieRelease() })],
    }), config()), 'guard.torrent-scope')
    expect(v.outcome).toBe('block')
  })

  it('passes when the target is the torrent\'s only file', () => {
    const v = verdict(evaluateGuards(resolution({ torrents: [torrent()] }), config()), 'guard.torrent-scope')
    expect(v.outcome).toBe('pass')
  })

  it('blocks when removing the torrent would take files the plan never named', () => {
    const v = verdict(evaluateGuards(resolution({ torrents: [pack()] }), config()), 'guard.torrent-scope')
    expect(v.outcome).toBe('block')
    expect(v.overridable).toBe(true)
    const offenders = v.evidence.offenders as Array<{ hash: string; fileCount: number; filesNotInPlan: number }>
    expect(offenders[0]!.hash).toBe('H1')
    expect(offenders[0]!.fileCount).toBe(12)
    expect(offenders[0]!.filesNotInPlan).toBe(11)
  })

  it('passes when every one of the torrent\'s files is targeted by the plan', () => {
    const files = filesOf(file('Heat.mkv', '/mnt/m/Heat.mkv'), file('Heat-cd2.mkv', '/mnt/m/Heat-cd2.mkv'))
    const v = verdict(
      evaluateGuards(resolution({ torrents: [torrent({ files })] }), config(), { plannedPaths: ['/mnt/m/Heat.mkv', '/mnt/m/Heat-cd2.mkv'] }),
      'guard.torrent-scope',
    )
    expect(v.outcome).toBe('pass')
  })

  it('blocks when qBittorrent reports an EMPTY file list — nothing said is not "no files"', () => {
    // A hash qBittorrent no longer has answers []. Read as "zero files", filesNotInPlan is zero and
    // the guard would wave through a delete-with-data on the strength of an empty answer.
    const v = verdict(
      evaluateGuards(resolution({ torrents: [torrent({ files: filesOf() })] }), config()),
      'guard.torrent-scope',
    )
    expect(v.outcome).toBe('block')
    expect(v.reason).toMatch(/no files/i)
  })

  it('torrent-scope blocks an unreadable file list', () => {
    const v = verdict(evaluateGuards(resolution({ torrents: [torrent({ files: null, companionCount: null })] }), config()), 'guard.torrent-scope')
    expect(v.outcome).toBe('block')
    expect(v.overridable).toBe(true)
    expect(v.reason).toMatch(/file list/i)
  })

  it('counts a media file whose path no mapping covers as one the plan does not target', () => {
    const v = verdict(
      evaluateGuards(resolution({ torrents: [torrent({ files: filesOf(file('Heat.mkv', '/mnt/m/Heat.mkv'), file('Other.mkv', null)) })] }), config()),
      'guard.torrent-scope',
    )
    expect(v.outcome).toBe('block')
    expect((v.evidence.offenders as Array<{ filesNotInPlan: number }>)[0]!.filesNotInPlan).toBe(1)
  })

  it('treats a torrent file that is a hardlink of the target as targeted — the standard *arr layout', () => {
    // The torrent owns /downloads/Heat.mkv, the library holds /mnt/m/Heat.mkv, and they are one
    // inode. Removing the torrent with its data takes a link to bytes this plan is removing anyway.
    const v = verdict(evaluateGuards(resolution({
      nlink: 2,
      hardlinks: ['/mnt/m/Heat.mkv', '/downloads/Heat.mkv'],
      torrents: [torrent({ files: filesOf(file('Heat.mkv', '/downloads/Heat.mkv')) })],
    }), config()), 'guard.torrent-scope')
    expect(v.outcome).toBe('pass')
  })

  it('passes for an action that removes no torrent data at all', () => {
    const v = verdict(
      evaluateGuards(resolution({ torrents: [pack()] }), config(), { removesTorrentData: false }),
      'guard.torrent-scope',
    )
    expect(v.outcome).toBe('pass')
  })

  it('passes when nothing matched at all', () => {
    expect(verdict(evaluateGuards(resolution(), config()), 'guard.torrent-scope').outcome).toBe('pass')
  })

  it('can be overridden — the operator may really want the whole pack gone', () => {
    const v = evaluateGuards(resolution({ torrents: [pack()] }), config())
    expect(isBlocked(v, ['guard.torrent-scope']).blocked).toBe(false)
  })
})

describe('guard.protected — an *arr namespace no mapping covers', () => {
  it('blocks, with no override, when *arr records could not be translated', () => {
    const v = verdict(evaluateGuards(resolution({ arrUnmappable: { count: 3, samples: ['/data/movies/Heat.mkv'] } }), config()), 'guard.protected')
    expect(v.outcome).toBe('block')
    expect(v.overridable).toBe(false)
    expect(isBlocked([v], ['guard.protected']).blocked).toBe(true)
    // The block is whole-install and has no override, so the reason has to carry its own remedy:
    // which paths failed, and that the fix is a mapping covering that *arr namespace.
    expect(v.reason).toContain('/data/movies/Heat.mkv')
    expect(v.reason).toMatch(/add a path mapping/i)
    expect(v.reason).toMatch(/jellyfin prefix/i)
  })

  it('passes when every *arr path translated', () => {
    expect(verdict(evaluateGuards(resolution(), config()), 'guard.protected').outcome).toBe('pass')
  })
})

describe('guard.hardlink — directories', () => {
  it('does not report a directory\'s link count as if it were a file\'s', () => {
    // Every empty directory has nlink 2 (itself and `.`), which is not two links to any bytes.
    const v = verdict(evaluateGuards(resolution({ isDirectory: true, nlink: 2, sizeBytes: 4096 }), config()), 'guard.hardlink')
    expect(v.outcome).toBe('pass')
    expect(v.reason).toMatch(/director/i)
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

describe('guard.untracked', () => {
  const boxA = { kind: 'instance', instanceId: 'box-a' } as const

  it('guard.untracked blocks (overridable) a file in a torrent-backed root that no torrent owns, and passes in a root with source none', () => {
    // Nothing would remove this file but a raw unlink, in a root box A saves its torrents into. Either
    // it is a leftover — which the override says, in so many words — or a torrent the index and box
    // A both failed to tie to it is still seeding it.
    const v = verdict(evaluateGuards(resolution({ torrentSource: boxA }), config()), 'guard.untracked')
    expect(v.outcome).toBe('block')
    expect(v.overridable).toBe(true)
    expect(v.reason).toMatch(/box-a/)
    expect(v.evidence.instanceId).toBe('box-a')
    expect(isBlocked([v], ['guard.untracked']).blocked).toBe(false)

    expect(verdict(evaluateGuards(resolution({ torrentSource: { kind: 'none' } }), config()), 'guard.untracked').outcome).toBe('pass')
  })

  it('passes when a torrent owns the file', () => {
    const v = verdict(evaluateGuards(resolution({ torrentSource: boxA, torrents: [torrent()] }), config()), 'guard.untracked')
    expect(v.outcome).toBe('pass')
  })

  it('passes for a path that is already gone, and for a directory — neither is a file to unlink', () => {
    expect(verdict(evaluateGuards(resolution({ torrentSource: boxA, exists: false }), config()), 'guard.untracked').outcome).toBe('pass')
    expect(verdict(evaluateGuards(resolution({ torrentSource: boxA, isDirectory: true }), config()), 'guard.untracked').outcome).toBe('pass')
  })

  it("passes a file whose torrent this run already removed with its data, only while its bytes are that torrent's", () => {
    // The next episode of a fully queued pack, still on disk while qBittorrent finishes deleting it:
    // its torrent is gone from the fresh list because an earlier action of this run removed it.
    const removed = (identity: { dev: number; inode: number; sizeBytes: number } | null) => ({
      removedThisRun: new Map([['/mnt/m/Heat.mkv', { torrents: [{ instanceId: 'box-a', hash: 'hp' }], identity }]]),
    })
    const r = resolution({ torrentSource: boxA })
    const same = verdict(evaluateGuards(r, config(), removed({ dev: 1, inode: 2, sizeBytes: 100 })), 'guard.untracked')
    expect(same.outcome).toBe('pass')
    expect(same.reason).toMatch(/hp on box-a/)
    expect(same.evidence.removedTorrents).toEqual([{ instanceId: 'box-a', hash: 'hp' }])

    // Anything else at the path is judged like any other file: a new inode, a new size, or nothing
    // recorded at all (the path was empty when the torrent went).
    for (const identity of [{ dev: 1, inode: 3, sizeBytes: 100 }, { dev: 1, inode: 2, sizeBytes: 99 }, null]) {
      expect(verdict(evaluateGuards(r, config(), removed(identity)), 'guard.untracked').outcome).toBe('block')
    }
    // ...and the planner, which passes no such map, never sees the pass.
    expect(verdict(evaluateGuards(r, config()), 'guard.untracked').outcome).toBe('block')
  })

  it("leaves an instance that could not be asked to guard.protected, so no override is invited for a block that cannot be overridden", () => {
    const r = resolution({ torrentSource: boxA, sourcesUnavailable: ['qbittorrent:box-a'] })
    expect(verdict(evaluateGuards(r, config()), 'guard.untracked').outcome).toBe('pass')
    expect(verdict(evaluateGuards(r, config()), 'guard.protected').outcome).toBe('block')
  })

  it('runs alongside the other five, one verdict per guard', () => {
    expect(evaluateGuards(resolution(), config()).map((v) => v.guard).sort()).toEqual([
      'guard.cross-seed', 'guard.hardlink', 'guard.private-ratio', 'guard.protected', 'guard.torrent-scope',
      'guard.untracked',
    ])
  })
})
