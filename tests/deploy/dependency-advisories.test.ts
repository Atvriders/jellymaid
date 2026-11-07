import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const carryForward = () => read('docs/superpowers/carry-forward.md').replace(/\s+/g, ' ')

interface Lock { packages: Record<string, { version?: string }> }
const lock = (): Lock => JSON.parse(read('package-lock.json')) as Lock

/** Every installed copy of a package in the tree (hoisted or nested), as [path, version]. */
function copiesOf(name: string): Array<[string, string]> {
  return Object.entries(lock().packages)
    .filter(([path]) => path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`))
    .map(([path, entry]) => [path, entry.version ?? ''])
}

/** -1, 0, 1 for dotted numeric versions (no prerelease tags in the packages checked here). */
function compare(a: string, b: string): number {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

describe('production dependency advisories (npm audit --omit=dev)', () => {
  it('the lockfile carries the non-breaking fixes: brace-expansion 5.0.12 and fast-uri 3.1.9 / 4.2.3', () => {
    const braces = copiesOf('brace-expansion')
    expect(braces.length).toBeGreaterThan(0)
    for (const [path, version] of braces) expect(compare(version, '5.0.12'), `${path}@${version}`).toBeGreaterThanOrEqual(0)

    const uris = copiesOf('fast-uri')
    expect(uris.length).toBeGreaterThan(0)
    for (const [path, version] of uris) {
      const fixed = version.startsWith('4.') ? '4.2.3' : '3.1.9'
      expect(compare(version, fixed), `${path}@${version} should be at least ${fixed}`).toBeGreaterThanOrEqual(0)
    }
  })

  // The three below are the advisories whose fix is a breaking change for this app. They are
  // documented in carry-forward.md *for as long as the lockfile is still on the vulnerable
  // release*: whoever upgrades one has to come back and rewrite its row (and the test that
  // protects the behaviour it would change), instead of leaving a stale "left open" claim.
  it('documents why fastify is not upgraded while the lockfile is still before 5.12.1', () => {
    const [[, version]] = copiesOf('fastify') as [[string, string]]
    if (compare(version, '5.12.1') >= 0) return
    const doc = carryForward()
    expect(doc).toContain('GHSA-3m5p-2c4r-xxw2')
    expect(doc).toMatch(/removes the numeric `trustProxy` form/)
    expect(doc).toContain('tests/server/trust-proxy.test.ts')
  })

  it('documents why zod is not upgraded while the lockfile is still before 4.6.6, and the test that would catch a careless bump', () => {
    const [[, version]] = copiesOf('zod') as [[string, string]]
    if (compare(version, '4.6.6') >= 0) return
    const doc = carryForward()
    expect(doc).toContain('GHSA-mrhx-c7xc-m3w5')
    expect(doc).toMatch(/\.default\(\{\}\)/)
    expect(doc).toMatch(/\.prefault\(\{\}\)/)
    expect(doc).toContain('guard.private-ratio')
    // The claim "the suite already stops a mechanical bump" must stay true.
    const loadTest = read('tests/config/load.test.ts')
    expect(loadTest).toContain('expect(cfg.file.guards.minRatio).toBe(1.0)')
    expect(loadTest).toContain('expect(cfg.file.guards.minSeedTimeDays).toBe(14)')
  })

  it('documents why the glob / minimatch pair is not upgraded while @fastify/static still pins glob 13', () => {
    const [[, version]] = copiesOf('glob') as [[string, string]]
    if (compare(version, '14.0.2') >= 0) return
    const doc = carryForward()
    expect(doc).toContain('GHSA-3g3m-2fjr-6pw4')
    expect(doc).toMatch(/wildcard: false/)
  })

  it('production code never calls glob itself — the pair is reachable only through @fastify/static', () => {
    // `glob` is not a direct dependency; if one appears, the "unreachable" reasoning above needs a new look.
    const pkg = JSON.parse(read('package.json')) as { dependencies: Record<string, string> }
    expect(Object.keys(pkg.dependencies)).not.toContain('glob')
    expect(Object.keys(pkg.dependencies)).not.toContain('minimatch')
  })
})

describe('carry-forward.md records what Plan 7 closed and what it leaves open', () => {
  const closed: Array<[string, RegExp]> = [
    ['saveConfig merging one level deep', /~~`saveConfig` shallow-merges[^~]*~~ \*\*Closed in Plan 7\*\*/],
    ['dryRun.directoriesSwept being optional', /~~\*\*`dryRun\.directoriesSwept` is typed required[^~]*~~ \*\*Closed in Plan 7\*\*/],
    ['a rejected override no longer failing the build', /~~\*\*A rejected override fails the whole plan build with 400\.[^~]*~~ \*\*Closed in Plan 7\*\*/],
    ['boot-time-only config', /~~\*\*Config is boot-time only\.[^~]*~~ \*\*Closed in Plan 7\*\*/],
    ['the missing SIGTERM handler', /~~\*\*No SIGTERM handler\.[^~]*~~ \*\*Closed in Plan 7\*\*/],
  ]
  for (const [what, re] of closed) {
    it(`strikes through ${what}, saying which plan closed it`, () => {
      expect(carryForward()).toMatch(re)
    })
  }

  it('has an "Open after Plan 7" section naming the real-stack scan, the harness gaps and the long-lived PathMap', () => {
    const doc = read('docs/superpowers/carry-forward.md')
    const start = doc.indexOf('## Open after Plan 7')
    expect(start).toBeGreaterThan(-1)
    const section = doc.slice(start).replace(/\s+/g, ' ')
    expect(section).toMatch(/real-stack read-only scan is pending/i)
    expect(section).toMatch(/harness cannot exercise/i)
    expect(section).toMatch(/PathMap` now lives as long as its mapping set/)
    expect(section).toMatch(/stop_grace_period/)
  })

  it('no longer says nothing has ever been verified', () => {
    expect(carryForward()).not.toMatch(/No real Jellyfin, qBittorrent, Radarr or Sonarr instance has ever been contacted/)
  })
})
