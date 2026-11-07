import { afterAll, describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../src/index/db.js'
import { createPathMap, mappingsHash, normalizeMappings, verifyQbitMappings } from '../../src/fs/pathmap.js'
import { resolveTarget } from '../../src/plan/resolve.js'
import { evaluateGuards } from '../../src/plan/guards.js'
import { fileConfigSchema } from '../../src/config/schema.js'
import { verificationBlocker, writeVerification } from '../../src/scan/verification.js'
import type { PathMapping } from '../../src/core/types.js'
import type { Torrent } from '../../src/connectors/qbittorrent.js'

const made: string[] = []
const dbs: Db[] = []
afterAll(() => {
  for (const db of dbs) db.close()
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

function seeded(instanceId: string, hash: string, contentPath: string, sizeBytes: number): Torrent {
  return {
    instanceId, hash, name: contentPath.split('/').pop()!, savePath: contentPath.slice(0, contentPath.lastIndexOf('/')),
    contentPath, rootPath: '', category: null, tags: [], state: 'stalledUP', ratio: 0, seedingTimeSeconds: 0,
    isPrivate: true, privacySource: 'flag', trackerHost: 'tracker.example', sizeBytes, progress: 1, addedOn: null,
  }
}

/**
 * The owner's two boxes, each seeding private-tracker films into its own `/movies` and episodes into
 * its own `/tv` — both boxes spell the two paths the same way.
 */
function ownerBoxes() {
  const dir = mkdtempSync(join(tmpdir(), 'jm-shadowed-'))
  made.push(dir)
  const roots = { aMovies: join(dir, 'a-movies'), aTv: join(dir, 'a-tv'), bMovies: join(dir, 'b-movies'), bTv: join(dir, 'b-tv') }
  for (const root of Object.values(roots)) mkdirSync(root, { recursive: true })
  const fill = (instanceId: string, root: string, prefix: string, tag: string, size: number) =>
    Array.from({ length: 15 }, (_, i) => {
      writeFileSync(join(root, `${tag}${i}.mkv`), 'x'.repeat(size))
      return seeded(instanceId, `${tag}${i.toString(16).padStart(38, '0')}`, `${prefix}/${tag}${i}.mkv`, size)
    })
  const a = [...fill('box-a', roots.aMovies, '/movies', 'am', 10), ...fill('box-a', roots.aTv, '/tv', 'at', 11)]
  const b = [...fill('box-b', roots.bMovies, '/movies', 'bm', 12), ...fill('box-b', roots.bTv, '/tv', 'bt', 13)]
  const row = (container: string, qbit: string, qbitInstance: string): PathMapping =>
    ({ role: 'library', jellyfin: `/jf${container}`, container, qbit, qbitInstance })
  const db = openDb(join(dir, 'db.sqlite'))
  dbs.push(db)

  /** Verify, stored the way POST /api/pathmap/verify stores it, then the gate every scan and plan reads. */
  async function gateAfterVerify(mappings: PathMapping[]): Promise<string | null> {
    const pathMap = createPathMap(normalizeMappings(mappings, ['box-a', 'box-b']).mappings)
    const qbit = await verifyQbitMappings({
      pathMap, instances: [{ id: 'box-a', torrents: async () => a }, { id: 'box-b', torrents: async () => b }],
    })
    writeVerification(db, { at: new Date().toISOString(), mappingsHash: mappingsHash(mappings), jellyfin: { sampled: 1, resolved: 1, failures: [] }, qbit })
    return verificationBlocker(db, { mappingsHash: mappingsHash(mappings), instanceIds: ['box-a', 'box-b'] })
  }
  return { roots, a, b, row, db, gateAfterVerify }
}

/**
 * Final re-review N1, reproduced as the reviewer's scratch scripts found it (half-swap.mts and
 * all-to-a.mts). A row of box B labelled `box-a` gave box-a two `/movies` rows, only the first of which
 * ever translated; box-b's films lay under none of its own prefixes and were merely ignored; Verify
 * passed both boxes. A delete of box B's seeded film then resolved to box-a, which owns no torrent for
 * it, and met only guard.untracked — which the bulk "Override guard.untracked for all N rows" clears.
 */
describe('a row of one box labelled with the other box, where both boxes report /movies (final re-review N1)', () => {
  it("leaves the guards only an overridable block on box B's seeded film, so Verify has to shut the gate", async () => {
    const { roots, a, b, row, db, gateAfterVerify } = ownerBoxes()
    const mappings = [
      row(roots.aMovies, '/movies', 'box-a'), row(roots.aTv, '/tv', 'box-a'),
      row(roots.bMovies, '/movies', 'box-a'), // box B's row, mislabelled
      row(roots.bTv, '/tv', 'box-b'),
    ]

    // Why Verify has to catch this: on this map the guards cannot tell the film is seeding.
    const film = join(roots.bMovies, 'bm0.mkv')
    const clients = new Map([
      ['box-a', { instanceId: 'box-a', torrents: async () => a, files: async () => [] }],
      ['box-b', { instanceId: 'box-b', torrents: async () => b, files: async () => [] }],
    ])
    const config = fileConfigSchema.parse({})
    const resolution = await resolveTarget(
      { db, pathMap: createPathMap(mappings), qbittorrents: clients, radarr: null, sonarr: null } as never, film, config,
    )
    expect(resolution.torrentSource).toEqual({ kind: 'instance', instanceId: 'box-a' })
    expect(resolution.torrents).toEqual([])
    const blocks = evaluateGuards(resolution, config, { plannedPaths: [film] }).filter((v) => v.outcome === 'block')
    expect(blocks.map((v) => [v.guard, v.overridable])).toEqual([['guard.untracked', true]])

    const blocker = await gateAfterVerify(mappings)
    expect(blocker).toMatch(/qBittorrent instance "box-a"/)
    expect(blocker).toContain(`box-a maps /movies to two folders (${roots.aMovies}, ${roots.bMovies}); one of them probably belongs to another box`)
  })

  it('shuts the gate when every row is labelled box-a, which leaves box-b with no mapping at all', async () => {
    const { roots, row, gateAfterVerify } = ownerBoxes()
    const blocker = await gateAfterVerify([
      row(roots.aMovies, '/movies', 'box-a'), row(roots.aTv, '/tv', 'box-a'),
      row(roots.bMovies, '/movies', 'box-a'), row(roots.bTv, '/tv', 'box-a'),
    ])
    expect(blocker).toMatch(/qBittorrent instance "box-a".*box-a maps \/movies to two folders/)
    expect(blocker).toMatch(/\(and 1 more\)/) // /tv is shadowed too
  })

  it('opens the gate for the correct layout, where each box maps /movies and /tv once', async () => {
    const { roots, row, gateAfterVerify } = ownerBoxes()
    expect(await gateAfterVerify([
      row(roots.aMovies, '/movies', 'box-a'), row(roots.aTv, '/tv', 'box-a'),
      row(roots.bMovies, '/movies', 'box-b'), row(roots.bTv, '/tv', 'box-b'),
    ])).toBeNull()
  })
})
