import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseQbitInstances } from '../../src/config/load.js'
import { pathMappingSchema } from '../../src/config/schema.js'
import { GUARD_IDS } from '../../src/core/types.js'

const readme = () => readFileSync(new URL('../../README.md', import.meta.url), 'utf8')
/** Bold markers dropped and whitespace collapsed, so prose that wraps across lines still matches. */
const flat = () => readme().replace(/\*\*/g, '').replace(/\s+/g, ' ')

/** The text of one `## ` section (up to the next `## `), whitespace collapsed. */
function section(heading: string): string {
  const text = readme()
  const start = text.indexOf(`\n## ${heading}`)
  if (start === -1) throw new Error(`README has no "## ${heading}" section`)
  const next = text.indexOf('\n## ', start + 4)
  return text.slice(start, next === -1 ? undefined : next).replace(/\*\*/g, '').replace(/\s+/g, ' ')
}

describe('README: qBittorrent instances (QBIT_INSTANCES)', () => {
  it('documents the format: comma-separated id=url pairs, with the id rule', () => {
    const t = flat()
    expect(t).toContain('QBIT_INSTANCES')
    expect(t).toMatch(/comma-separated/i)
    expect(t).toMatch(/id=url/)
    expect(t).toMatch(/lowercase letters, digits/i)
  })

  it('every QBIT_INSTANCES example in the README parses with the real loader (an example that does not start the container is worse than none)', () => {
    const examples = [...readme().matchAll(/^\s*(?:export\s+)?QBIT_INSTANCES(?:=|:\s*)"?([^"\n]+?)"?\s*$/gm)].map((m) => m[1] as string)
    expect(examples.length, 'expected at least the quick start example and the percent-encoding example').toBeGreaterThanOrEqual(2)
    for (const value of examples) {
      const problems: string[] = []
      const instances = parseQbitInstances({ QBIT_INSTANCES: value }, problems)
      expect(problems, `README example ${value}`).toEqual([])
      expect(instances.length).toBeGreaterThan(0)
    }
  })

  it('documents the per-instance credential variables and how their names derive from the id', () => {
    const t = flat()
    expect(t).toContain('QBIT_<ID>_USER')
    expect(t).toContain('QBIT_<ID>_PASS')
    expect(t).toMatch(/uppercase/i)
    expect(t).toMatch(/box-a[^.]*QBIT_BOX_A_USER/)
  })

  it('names a per-instance variable that the loader really reads for that id (the documented example is not a guess)', () => {
    const problems: string[] = []
    const [instance] = parseQbitInstances({
      QBIT_INSTANCES: 'box-a=http://198.51.100.10:8080', QBIT_BOX_A_USER: 'u', QBIT_BOX_A_PASS: 'p',
    }, problems)
    expect(problems).toEqual([])
    expect([instance?.user, instance?.pass]).toEqual(['u', 'p'])
  })

  it('tells the operator that a comma in an embedded password must be written %2C, and why', () => {
    const t = flat()
    expect(t).toContain('%2C')
    expect(t).toMatch(/comma/i)
    expect(t).toMatch(/percent-encod/i)
    // The consequence, so nobody learns it from a crash loop.
    expect(t).toMatch(/refuses to start|will not start|does not start/i)
  })

  it('proves the %2C claim with the real loader: the encoded form parses, the raw comma does not', () => {
    const ok: string[] = []
    const [instance] = parseQbitInstances({ QBIT_INSTANCES: 'box-a=http://admin:pa%2Css@198.51.100.10:8080' }, ok)
    expect(ok).toEqual([])
    expect(instance?.pass).toBe('pa,ss')
    const bad: string[] = []
    expect(parseQbitInstances({ QBIT_INSTANCES: 'box-a=http://admin:pa,ss@198.51.100.10:8080' }, bad)).toEqual([])
    expect(bad.length).toBeGreaterThan(0)
  })

  it('says credentials are optional, per instance, and that half a pair is refused', () => {
    const t = section('qBittorrent instances')
    expect(t).toMatch(/optional/i)
    expect(t).toMatch(/both or neither|half (a|of a) (pair|credential)|username without a password/i)
  })

  it('keeps QBIT_URL documented as the single-instance form, named "default"', () => {
    const t = flat()
    expect(t).toContain('QBIT_URL')
    expect(t).toMatch(/"default"|`default`/)
  })

  it('documents the Unraid same-host auth caveat: a bridged container reaches a same-box qBittorrent from the Docker bridge address, so the LAN bypass does not apply', () => {
    const t = section('qBittorrent instances')
    expect(t).toContain('Unraid')
    expect(t).toMatch(/same (host|box|machine)/i)
    expect(t).toMatch(/bridge/i)
    expect(t).toMatch(/bypass/i)
    expect(t).toMatch(/set that instance'?s credentials|needs? credentials/i)
  })

  // Final review m1: since Task 2's fix round, two refusals in a row stop the logins until a restart.
  // The docs used to promise a retry every five minutes — and that corrected credentials would be
  // picked up by the next one, which never comes.
  it('documents the login cap as the code has it: a 5-minute pause, then no more logins after two refusals in a row until a restart; an hour after a ban', () => {
    const t = section('qBittorrent instances')
    expect(t).toMatch(/5 minutes|five minutes/i)
    expect(t).toMatch(/two refused logins in a row|refused twice in a row|two refusals in a row/i)
    expect(t).toMatch(/until (Jellymaid|it) is restarted|until a restart/i)
    expect(t).toMatch(/hour[^.]*ban|ban[^.]*hour/i)
    expect(t).not.toMatch(/twenty minutes/i)
    expect(t).not.toMatch(/cannot get you banned|can ?not be banned|never be banned/i)
  })

  it('tells the operator who corrected the password in qBittorrent to restart Jellymaid, not to wait for a retry (final review m1)', () => {
    const t = section('Troubleshooting')
    expect(t).not.toMatch(/next attempt picks them up/i)
    expect(t).toMatch(/corrected[^.]*qBittorrent[^.]*restart|restart[^.]*corrected[^.]*qBittorrent/i)
  })
})

describe('README: Jellyfin login near its lockout (Task 3 minor 8)', () => {
  it('says a correct password is refused while the account is one failure from lockout, and that signing in to Jellyfin once clears it', () => {
    const t = section('Quick start')
    expect(t).toMatch(/even (the|a) correct password/i)
    expect(t).toMatch(/sign(ing)? in to Jellyfin (itself )?once|log(ging)? in to Jellyfin (itself )?once/i)
    expect(t).toMatch(/counts? (towards|toward|against) Jellymaid'?s own|Jellymaid'?s own (60-minute |one-hour |hour-long )?lock/i)
  })
})

describe('README: path mapping with instances', () => {
  it('every JSON mapping example in the README is accepted by the real path-mapping schema', () => {
    const blocks = [...readme().matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1] as string)
    expect(blocks.length).toBeGreaterThan(0)
    let seen = 0
    for (const block of blocks) {
      const parsed: unknown = JSON.parse(block)
      for (const mapping of Array.isArray(parsed) ? parsed : [parsed]) {
        const result = pathMappingSchema.safeParse(mapping)
        expect(result.success, `README mapping ${JSON.stringify(mapping)}: ${JSON.stringify(result.error?.issues)}`).toBe(true)
        seen += 1
      }
    }
    expect(seen).toBeGreaterThanOrEqual(3)
  })

  it('shows two boxes that both call their root by the same name, told apart only by qbitInstance', () => {
    const blocks = [...readme().matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1] as string) as unknown)
    const all = blocks.flatMap((b) => (Array.isArray(b) ? b : [b])) as Array<{ qbit: string | null; qbitInstance?: string | null }>
    const byPrefix = new Map<string, Set<string>>()
    for (const m of all) {
      if (m.qbit && m.qbitInstance) byPrefix.set(m.qbit, (byPrefix.get(m.qbit) ?? new Set()).add(m.qbitInstance))
    }
    expect([...byPrefix.values()].some((ids) => ids.size >= 2), 'expected one qbit prefix used by two different instances').toBe(true)
  })

  it('explains qbitInstance, the explicitly-not-torrent-backed root, and that a prefix with no instance fails closed', () => {
    const t = section('Path mapping')
    expect(t).toContain('qbitInstance')
    expect(t).toMatch(/not torrent-backed/i)
    expect(t).toMatch(/fails? closed/i)
    expect(t).toMatch(/exactly one (qBittorrent )?instance/i)
  })

  it('documents Verify as a two-sided gate: Jellyfin to container AND each qBittorrent instance\'s torrents to container', () => {
    const t = section('Path mapping')
    expect(t).toMatch(/Verify/)
    expect(t).toMatch(/Jellyfin path/i)
    expect(t).toMatch(/each (qBittorrent )?instance/i)
    expect(t).toMatch(/content path|content_path/i)
    expect(t).toMatch(/single-file torrent/i)
    expect(t).toMatch(/size/i)
  })

  it('says the gate also refuses plan builds, goes stale when the mappings change, and can be forced for a scan but not for a plan', () => {
    const t = section('Path mapping')
    expect(t).toMatch(/plan build|build(ing)? a plan/i)
    expect(t).toMatch(/stale/i)
    expect(t).toMatch(/\bchang(e|es|ed)\b/i)
    expect(t).toMatch(/force/i)
    expect(t).toMatch(/cannot be forced|a plan cannot|plan builds? (can ?not|cannot)/i)
  })

  it('says Verify ignores and counts torrents outside every mapped folder, and needs a download root only for torrents that back library items (final fix wave part 2, replacing m2)', () => {
    const t = section('Path mapping')
    expect(t).toMatch(/outside every mapped folder[^.]*(ignored|counted)|(ignored|counted)[^.]*outside every mapped folder/i)
    expect(t).toMatch(/download[^.]*only[^.]*(back|behind|feed)[^.]*librar|only[^.]*download[^.]*(back|behind|feed)[^.]*librar/i)
    // m2's wording made every save path of a box a requirement: it no longer is.
    expect(t).not.toMatch(/no mapping covers this path/)
    expect(section('Troubleshooting')).not.toMatch(/no mapping covers this path/)
  })

  it('says a mapped folder no completed torrent lies under fails Verify, and how to fix it (final fix wave part 2)', () => {
    const t = section('Path mapping')
    expect(t).toMatch(/no completed torrent[^.]*fails|fails[^.]*no completed torrent/i)
    const trouble = section('Troubleshooting')
    expect(trouble).toMatch(/reports a path under/)
    expect(trouble).toMatch(/qBittorrent path/)
  })

  it('says two rows of one instance with one qbit prefix and different folders fail Verify, and how to fix it (final re-review N1)', () => {
    const t = section('Path mapping')
    expect(t).toMatch(/same `qbit` prefix but different container folders fail Verify/)
    expect(t).toMatch(/Nested prefixes[^.]*are fine/)
    const trouble = section('Troubleshooting')
    expect(trouble).toMatch(/maps \/movies to two folders/)
    expect(trouble).toMatch(/Choose the right instance on that row/)
  })

  it('says Verify checks EVERY completed torrent against roots marked not torrent-backed, and fails on one found there (final review I1)', () => {
    const t = section('Path mapping')
    expect(t).toMatch(/every completed torrent/i)
    expect(t).toMatch(/not torrent-backed[^.]*(fails|failure)|(fails|failure)[^.]*not torrent-backed/i)
  })

  it('says a new mapping row has no default and must be given an instance or "none" before it saves (final review I1)', () => {
    expect(section('Path mapping')).toMatch(/new (mapping )?row[^.]*(choose|choice|explicit)/i)
  })

  it('says Verify leaves missingFiles and error torrents out of its sample, and fails when they are all there is (Task 4 minor 4)', () => {
    const t = section('Path mapping')
    expect(t).toContain('missingFiles')
    expect(t).toMatch(/every completed torrent[^.]*(is|are) in (one of )?(those|such|these) states|all of (an|the) instance'?s completed torrents/i)
  })

  it('says auto-detect also proposes the qbit prefix and instance, and does not block the server', () => {
    const t = section('Path mapping')
    expect(t).toMatch(/Auto-detect/)
    expect(t).toMatch(/instance/i)
    expect(t).toMatch(/does not block|without blocking|in the background/i)
  })
})

describe('README: duplicate groups', () => {
  it('says a group holding a multi-episode file is skipped by the bulk queue unless included (Task 6 minor 4)', () => {
    const t = section('Duplicate groups and the keeper')
    expect(t).toMatch(/multi-episode/i)
    expect(t).toMatch(/S01E01E02/)
    expect(t).toMatch(/bulk[^.]*skips[^.]*multi-episode|multi-episode[^.]*unless you (tick|include)/i)
  })

  it('says a dismissal on either screen hides the group from Duplicates (final review I2)', () => {
    expect(section('Duplicate groups and the keeper')).toMatch(/Findings screen/i)
  })
})

describe('README: settings are live', () => {
  it('has a section saying saved settings take effect without a restart, and that a plan run uses one snapshot', () => {
    const t = section('Settings are live')
    expect(t).toMatch(/without a restart|no restart/i)
    expect(t).toMatch(/one (consistent )?snapshot|single snapshot/i)
    for (const field of ['path mapping', 'minRatio', 'minSeedTimeDays', 'keeper']) expect(t, field).toMatch(new RegExp(field, 'i'))
  })

  it('is honest about what still needs a restart: the environment, scanCron and the connector rate limits', () => {
    const t = section('Settings are live')
    expect(t).toMatch(/restart/i)
    expect(t).toContain('scanCron')
    expect(t).toContain('rateLimits')
    expect(t).toContain('QBIT_INSTANCES')
  })

  it('says the keeper policy applies at the next scan', () => {
    expect(section('Settings are live')).toMatch(/keeper[^.]*next scan|next scan[^.]*keeper/i)
  })

  it('says a hand-edited config.json is re-read when it changes, and a broken edit is refused rather than papered over', () => {
    const t = section('Settings are live')
    expect(t).toMatch(/hand-edit|edit(ing)? .*config\.json by hand/i)
    expect(t).toMatch(/invalid|broken/i)
  })
})

describe('README: the private-tracker (H&R) rule', () => {
  it('states the AND rule precisely: a private torrent needs BOTH the ratio and the seeding time', () => {
    const t = flat()
    expect(t).toMatch(/H&R|hit-and-run/i)
    expect(t).toMatch(/both\b[^.]*ratio[^.]*\band\b[^.]*seed|ratio[^.]*\band\b[^.]*seed[^.]*\bboth\b|both ratio/i)
    expect(t).toMatch(/not (just )?either|neither one alone|either one is not enough|one of the two is not enough/i)
  })

  it('says the thresholds are editable and live, with their defaults', () => {
    const t = section('The guards')
    expect(t).toContain('minRatio')
    expect(t).toContain('minSeedTimeDays')
    expect(t).toMatch(/1\.0/)
    expect(t).toMatch(/14/)
    expect(t).toMatch(/Settings/)
    expect(t).toMatch(/without a restart|immediately|live/i)
  })

  it('points at the bulk override, because the AND rule blocks a lot', () => {
    expect(flat()).toMatch(/override[^.]*all[^.]*blocked/i)
  })

  it('says the bulk confirmation for guard.untracked and guard.torrent-scope says what will be deleted (final review m5)', () => {
    expect(flat()).toMatch(/`guard\.untracked`[^.]*no torrent owns, will be deleted from disk/)
    expect(flat()).toMatch(/`guard\.torrent-scope`[^.]*other files in those torrents will be deleted too/)
  })
})

describe('README: how Jellyfin forgets a deleted item', () => {
  it('names the notification, the delay, and that Jellymaid never deletes Jellyfin items', () => {
    const t = flat()
    expect(t).toContain('/Library/Media/Updated')
    expect(t).toMatch(/about a minute/i)
    expect(t).toMatch(/never (asks Jellyfin to )?delete[s]? (anything|items|a Jellyfin item)|never deletes Jellyfin items/i)
    expect(t).toMatch(/LibraryMonitorDelay/)
  })

  it('says only paths confirmed gone are reported, and nothing happens in Jellyfin while the file is still on disk', () => {
    const t = flat()
    expect(t).toMatch(/only (for )?(the )?paths[^.]*(confirmed )?gone|confirmed gone/i)
    expect(t).toMatch(/still (on disk|there|present)[^.]*(nothing|not)/i)
  })
})

describe('README: Verified against', () => {
  it('has a "Verified against" section with the versions, the harness and the date', () => {
    const t = section('Verified against')
    expect(t).toContain('Jellyfin 12.1.0')
    expect(t).toContain('qBittorrent 5.2.2')
    expect(t).toContain('5.1.2')
    expect(t).toContain('2026-10-31')
    expect(t).toMatch(/harness/i)
    expect(t).toMatch(/real (binaries|software)/i)
  })

  it('says the real-stack read-only scan is still pending, and that Radarr/Sonarr were never contacted', () => {
    const t = section('Verified against')
    expect(t).toMatch(/read-only scan/i)
    expect(t).toMatch(/pending/i)
    expect(t).toMatch(/Radarr[^.]*Sonarr[^.]*(never|not)/i)
  })

  it('is the only place that talks about verification status, with no claim that nothing was ever contacted', () => {
    expect(readme()).not.toMatch(/No real Jellyfin server has ever been contacted/i)
    expect(readme()).not.toMatch(/No real qBittorrent instance has ever been contacted/i)
    expect(readme()).not.toMatch(/No real delete has ever been executed/i)
    expect(readme()).not.toMatch(/## What has NOT been verified against a live stack/)
  })
})

describe('README: the guards', () => {
  it('has one table row for every guard Jellymaid has, so a new guard cannot be added without documenting it', () => {
    const t = section('The guards')
    for (const id of GUARD_IDS) expect(t, `${id} is missing from the guards section`).toContain(`\`${id}\``)
  })

  it('describes guard.untracked and the companion-aware guard.torrent-scope', () => {
    const t = section('The guards')
    expect(t).toMatch(/guard\.untracked`[^|]*\|[^|]*(no torrent|not owned|owns it)/i)
    expect(t).toMatch(/companion/i)
    expect(t).toMatch(/\.nfo/)
    expect(t).toMatch(/season pack/i)
  })
})

describe('README: stale claims stay out', () => {
  const stale: Array<[string, RegExp]> = [
    ['config being boot-time only', /read once at container start/i],
    ['a path map not reaching the executor until a restart', /restart the container after changing path mappings/i],
    ['thresholds being read-only in the UI', /Thresholds panel is explicitly read-only/i],
    ['no PUT route for the thresholds', /there is no `PUT` route for it/i],
    ['hand-editing plus a restart being the way to change a threshold', /hand-edit(ing)? `?\/data\/config\.json`? directly and \*{0,2}restart/i],
    ['the five guards', /five guards/i],
    ['a missing SIGTERM handler', /There is no `SIGTERM` handler/i],
    ['an item delete in Jellyfin', /the item is deleted once its bytes are actually gone/i],
    ['a library refresh after a plan', /batched `Library\/Refresh`/i],
    ['one qBittorrent being required via QBIT_USER/QBIT_PASS', /Required environment variables:\*{0,2} `JELLYFIN_URL`, `JELLYFIN_API_KEY`, `QBIT_URL`, `QBIT_USER`/i],
    ['an out-of-date test count', /\b\d{3} server tests\b/i],
    ['SCAN_CRON as a variable', /(?<!there is no )`SCAN_CRON`[^.]*environment variable/i],
  ]
  // Against the flattened text: the old prose wraps mid-phrase ("container\nstart"), and a raw match
  // would pass vacuously on exactly the sentence it is meant to catch.
  for (const [what, re] of stale) {
    it(`does not claim ${what}`, () => {
      expect(flat()).not.toMatch(re)
    })
  }

  it('never tells the operator to expose, call or rely on Jellyfin item deletion or library refresh', () => {
    // The only legitimate mentions say Jellymaid does NOT do these.
    for (const m of readme().matchAll(/DELETE \/Items|Library\/Refresh|deleteItem|refreshLibrary/g)) {
      const around = readme().slice(Math.max(0, m.index! - 160), m.index! + 160).replace(/\s+/g, ' ')
      expect(around, `"${m[0]}" is mentioned, but not as something Jellymaid never does`).toMatch(/never|no |not |without/i)
    }
  })
})
