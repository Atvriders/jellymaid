import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { ACTION_TYPES } from '../../src/core/types.js'
import { parseQbitInstances } from '../../src/config/load.js'

const readme = () => readFileSync(new URL('../../README.md', import.meta.url), 'utf8')
const executorSource = () => readFileSync(new URL('../../src/plan/executor.ts', import.meta.url), 'utf8')
const configSource = () => readFileSync(new URL('../../src/config/load.ts', import.meta.url), 'utf8')

/** Markdown bold markers (`**`) can land mid-phrase (e.g. `**Jellyfin**,`) and would otherwise
 *  break a plain substring/regex match across the boundary. Stripping them first lets every anchor
 *  below match prose regardless of exactly where the author chose to bold it. */
const stripBold = (s: string) => s.replace(/\*\*/g, '')

describe('README', () => {
  it('warns that Jellymaid deletes media', () => {
    expect(readme().toLowerCase()).toMatch(/deletes? (your )?media|permanently delete/)
  })

  it('states that Radarr and Sonarr are unmonitor-only', () => {
    expect(readme().toLowerCase()).toContain('unmonitor')
    expect(readme().toLowerCase()).toMatch(/never delet\w+ (from )?(radarr|sonarr)|does not delete/)
  })

  it('documents the required /data bind mount', () => {
    expect(readme()).toContain('/data')
  })

  it('documents the path map including download roots', () => {
    expect(readme()).toContain('pathMappings')
    expect(readme()).toContain('download')
  })

  it('documents the guard defaults', () => {
    expect(readme()).toContain('minRatio')
    expect(readme()).toContain('minSeedTimeDays')
  })

  it('lists every required environment variable', () => {
    // QBIT_INSTANCES names the qBittorrent instances (QBIT_URL is only the older single-instance
    // form, and credentials are optional and per instance), so only these are "required".
    for (const key of ['JELLYFIN_URL', 'JELLYFIN_API_KEY', 'QBIT_INSTANCES']) {
      expect(readme()).toContain(key)
    }
  })
})

describe('README delete pipeline matches executor.ts', () => {
  /**
   * `createExecutor`'s own doc comment is the one place the fixed step order is declared; it is
   * the ground truth this test pins the README against, not a hardcoded copy of either text. Five
   * short, distinctive anchors — one per step — check *relative order* rather than exact wording,
   * so cosmetic rewording on either side doesn't break this, but a REORDER (steps 3/4 swapped, the
   * way they once were) or a step being renamed into something unrecognizable will.
   */
  const anchors: RegExp[] = [
    /unmonitor/i,
    /qBittorrent delete-with-data/i,
    /this path.s own link/i,
    /now-empty parent director/i,
    /Jellyfin,? (last|then)/i,
  ]

  const orderOf = (text: string, label: string): number[] =>
    anchors.map((re) => {
      const idx = stripBold(text).search(re)
      if (idx === -1) throw new Error(`${label}: could not find an anchor matching ${re}`)
      return idx
    })

  it("executor.ts's own doc comment lists the five steps in ascending order (sanity check on the anchors themselves)", () => {
    const start = executorSource().indexOf('Runs an approved plan')
    const end = executorSource().indexOf('export function createExecutor')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const docBlock = executorSource().slice(start, end)
    const order = orderOf(docBlock, 'executor.ts doc comment')
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('the "How a delete actually runs" section names the same five steps in the same order', () => {
    const start = readme().indexOf('## How a delete actually runs')
    const end = readme().indexOf('## The guards')
    expect(start, 'expected a "## How a delete actually runs" heading').toBeGreaterThan(-1)
    expect(end, 'expected a "## The guards" heading after it').toBeGreaterThan(start)
    const section = readme().slice(start, end)
    const order = orderOf(section, 'README "How a delete actually runs" section')
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('does not claim a "remaining hardlinks" delete action exists', () => {
    // The capability this used to (wrongly) describe would need its own ACTION_TYPES entry to be
    // real. If one is ever added, this test — and the README paragraph next to it — need a look.
    for (const type of ACTION_TYPES) expect(type.toLowerCase()).not.toContain('hardlink')
    expect(readme()).not.toMatch(/remaining hardlinks[^.]*unlinked here/i)
    expect(readme()).not.toMatch(/step that actually reclaims space/i)
  })
})

describe('README environment variables match src/config/load.ts', () => {
  /**
   * The env vars loadConfig genuinely reads, mapped to a substring that proves it. Most are read
   * as a literal `env.FOO`/`env[key]`, so the name itself is the proof; RADARR_URL, RADARR_API_KEY,
   * SONARR_URL and SONARR_API_KEY are built at runtime from a `${prefix}_URL`/`${prefix}_API_KEY`
   * template (see `requireArr`), so the literal concatenated name never appears in the source —
   * the bare prefix passed into `requireArr` is what proves those four are real.
   */
  const REAL_ENV_VARS: Record<string, string> = {
    DATA_DIR: 'DATA_DIR', PORT: 'PORT', TRUST_PROXY: 'TRUST_PROXY', SESSION_SECRET: 'SESSION_SECRET',
    JELLYFIN_URL: 'JELLYFIN_URL', JELLYFIN_API_KEY: 'JELLYFIN_API_KEY',
    QBIT_URL: 'QBIT_URL', QBIT_USER: 'QBIT_USER', QBIT_PASS: 'QBIT_PASS',
    RADARR_URL: "requireArr(env, 'RADARR'", RADARR_API_KEY: "requireArr(env, 'RADARR'",
    SONARR_URL: "requireArr(env, 'SONARR'", SONARR_API_KEY: "requireArr(env, 'SONARR'",
    QBIT_INSTANCES: 'QBIT_INSTANCES',
  }

  /**
   * `QBIT_<ID>_USER` / `QBIT_<ID>_PASS` are built at runtime from each instance's id (the same
   * template trick as the *arr pairs), so a literal example such as `QBIT_BOX_A_USER` never appears
   * in load.ts. Proving one is real means asking the loader: give the instance the id the name
   * implies, set the variable, and see whether it arrives.
   */
  const perInstanceCredential = /^QBIT_([A-Z0-9]+(?:_[A-Z0-9]+)*)_(USER|PASS)$/

  function loaderReadsPerInstanceVariable(name: string): boolean {
    const m = name.match(perInstanceCredential)
    if (!m || m[1] === undefined) return false
    const id = m[1].toLowerCase().replaceAll('_', '-')
    const partner = name.endsWith('_USER') ? name.replace(/_USER$/, '_PASS') : name.replace(/_PASS$/, '_USER')
    const problems: string[] = []
    const [instance] = parseQbitInstances(
      { QBIT_INSTANCES: `${id}=http://198.51.100.10:8080`, [name]: 'documented', [partner]: 'partner' } as NodeJS.ProcessEnv,
      problems,
    )
    const arrived = name.endsWith('_USER') ? instance?.user : instance?.pass
    return problems.length === 0 && arrived === 'documented'
  }

  it('every real env var the README documents is actually read by loadConfig', () => {
    const load = configSource()
    for (const [name, proof] of Object.entries(REAL_ENV_VARS)) {
      expect(load, `README documents \`${name}\` as a real variable, but src/config/load.ts never reads it`)
        .toContain(proof)
    }
  })

  /**
   * Every backtick-quoted, UPPER_SNAKE token in the README is either a real variable (must appear
   * in load.ts) or explicitly disclaimed ("there is no `X`", checked in a window right before the
   * token so wrapped prose still matches). A token that is neither — styled like a real variable
   * with no disclaimer, the way `SCAN_CRON` used to be — fails loudly instead of drifting silently.
   */
  it('every other env-styled token is either real or explicitly documented as not existing', () => {
    const text = readme()
    const load = configSource()
    const seen = new Set<string>()
    for (const m of text.matchAll(/`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)`/g)) {
      const name = m[1]!
      if (seen.has(name)) continue
      seen.add(name)
      const windowBefore = text.slice(Math.max(0, m.index! - 60), m.index!)
      const claimedAbsent = /there is no\b/i.test(windowBefore)
      if (claimedAbsent) {
        expect(load, `README says \`${name}\` does not exist, but src/config/load.ts reads it anyway`)
          .not.toContain(name)
      } else if (perInstanceCredential.test(name) && !(name in REAL_ENV_VARS)) {
        expect(loaderReadsPerInstanceVariable(name), `\`${name}\` is documented as a per-instance credential variable, but the loader does not read it for the instance id it implies`)
          .toBe(true)
      } else {
        expect(Object.keys(REAL_ENV_VARS), `\`${name}\` is documented without a "there is no" disclaimer, so it must be a real, documented variable — add it to REAL_ENV_VARS here once verified against src/config/load.ts`)
          .toContain(name)
        expect(load, `\`${name}\` is documented as real, but src/config/load.ts never reads it`).toContain(REAL_ENV_VARS[name])
      }
    }
  })
})
