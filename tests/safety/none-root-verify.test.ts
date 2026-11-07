import { afterAll, describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../../src/index/db.js'
import { createPathMap, mappingsHash, verifyQbitMappings } from '../../src/fs/pathmap.js'
import { resolveTarget } from '../../src/plan/resolve.js'
import { evaluateGuards, isBlocked } from '../../src/plan/guards.js'
import { fileConfigSchema } from '../../src/config/schema.js'
import { verificationBlocker, writeVerification } from '../../src/scan/verification.js'
import type { PathMapping } from '../../src/core/types.js'
import type { Torrent } from '../../src/connectors/qbittorrent.js'

const made: string[] = []
afterAll(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }) })

function seeded(over: Partial<Torrent> & Pick<Torrent, 'hash' | 'name' | 'contentPath' | 'sizeBytes'>): Torrent {
  return {
    instanceId: 'box-a', savePath: null, rootPath: '', category: null, tags: [], state: 'stalledUP',
    ratio: 0, seedingTimeSeconds: 0, isPrivate: true, privacySource: 'flag', trackerHost: 'tracker.example',
    progress: 1, addedOn: null, ...over,
  }
}

/**
 * Final review I1, reproduced as the reviewer found it: box-a seeds 40 films into a mapped movies
 * root and one episode into a tv root whose row was left at "none (not torrent-backed)". Verify
 * sampled 20 of the 41 torrents, never the episode, and said 20 of 20. With that record the gate
 * opened, and a delete of the episode passed every guard: no instance is asked about a `none` root,
 * so `guard.untracked` passes it and `guard.private-ratio` has no torrent to judge. The executor
 * would then unlink a file a private tracker is still being seeded from.
 */
describe('a library root marked not torrent-backed while an instance seeds into it (final review I1)', () => {
  it('fails Verify, so the gate stays shut on the map that let every guard pass the seeded file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jm-none-root-'))
    made.push(dir)
    const movies = join(dir, 'a-movies')
    const tv = join(dir, 'a-tv')
    mkdirSync(movies, { recursive: true })
    mkdirSync(join(tv, 'Show'), { recursive: true })
    const episode = join(tv, 'Show', 'Show.S01E01.mkv')
    writeFileSync(episode, 'x'.repeat(100))

    const torrents: Torrent[] = []
    for (let i = 0; i < 40; i += 1) {
      const name = `Film${i}.mkv`
      writeFileSync(join(movies, name), 'y'.repeat(10))
      torrents.push(seeded({ hash: i.toString(16).padStart(40, '0'), name, contentPath: `/movies/${name}`, sizeBytes: 10 }))
    }
    torrents.push(seeded({ hash: 'f'.repeat(40), name: 'Show.S01E01.mkv', contentPath: '/tv/Show/Show.S01E01.mkv', sizeBytes: 100 }))

    const mappings: PathMapping[] = [
      { role: 'library', jellyfin: '/jf/movies', container: movies, qbit: '/movies', qbitInstance: 'box-a' },
      { role: 'library', jellyfin: '/jf/tv', container: tv, qbit: null, qbitInstance: null }, // the forgotten instance
    ]
    const pathMap = createPathMap(mappings)

    // Why Verify has to catch this: on this map the guards cannot.
    const db = openDb(join(dir, 'db.sqlite'))
    const config = fileConfigSchema.parse({})
    const client = { instanceId: 'box-a', torrents: async () => torrents, files: async () => [] }
    const resolution = await resolveTarget(
      { db, pathMap, qbittorrents: new Map([['box-a', client]]), radarr: null, sonarr: null } as never, episode, config,
    )
    expect(resolution.torrentSource).toEqual({ kind: 'none' })
    expect(isBlocked(evaluateGuards(resolution, config, { plannedPaths: [episode] }), []).blocked).toBe(false)

    const [report] = await verifyQbitMappings({ pathMap, instances: [{ id: 'box-a', torrents: async () => torrents }] })
    // The sample still never reaches the episode — it is the full pass that finds it.
    expect(report).toMatchObject({ instanceId: 'box-a', sampled: 20, resolved: 20 })
    expect(report!.failures).toEqual([{
      qbitPath: '/tv/Show/Show.S01E01.mkv',
      reason: expect.stringMatching(/not torrent-backed/),
    }])
    expect(report!.failures[0]!.reason).toContain(tv)
    expect(report!.failures[0]!.reason).toContain('box-a')

    writeVerification(db, {
      at: new Date().toISOString(), mappingsHash: mappingsHash(mappings),
      jellyfin: { sampled: 1, resolved: 1, failures: [] }, qbit: [report!],
    })
    const blocker = verificationBlocker(db, { mappingsHash: mappingsHash(mappings), instanceIds: ['box-a'] })
    expect(blocker).toMatch(/box-a/)
    expect(blocker).toMatch(/not torrent-backed/)
    db.close()
  })
})
