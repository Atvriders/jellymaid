import { z } from 'zod'
import type { Db } from '../index/db.js'
import type { QbitVerifyReport } from '../fs/pathmap.js'

/**
 * The last path-map verification. It describes ONE mapping set — the one `mappingsHash` names —
 * and both halves of the translation every destructive path relies on: Jellyfin → container, and
 * each qBittorrent instance → container.
 */
export interface VerificationRecord {
  at: string
  mappingsHash: string
  jellyfin: { sampled: number; resolved: number; failures: Array<{ jellyfinPath: string; reason: string }> }
  qbit: QbitVerifyReport[]
}

export const VERIFICATION_KV_KEY = 'pathmap.lastVerification'

/**
 * What a stored record must look like before anything may trust it. `verificationBlocker` decides
 * whether a destructive plan may be built from `sampled`, `resolved` and `failures.length`, so each
 * of those has to be a real count and a real list: a missing `sampled` makes `sampled <= 0` false,
 * and a string `"20"` compares loosely against a number — both read as "nothing wrong". A record
 * that does not pass is treated as absent, which blocks.
 *
 * `resolved` is a subset of `sampled` by construction, so a record claiming more was not written
 * by this code. Fields the schema does not name are dropped rather than refused: a newer writer
 * adding one must not turn the gate into a permanent block.
 *
 * A report's `ignored` (added by the final fix wave) is optional, because a record written before it
 * existed has none and is still a valid record. The gate never reads it — torrents outside every
 * mapped folder are not failures — but it is kept so Settings can show the count, and a malformed one
 * marks the record as not written by this code, like any other bad field.
 */
const count = z.number().int().min(0)
const tally = z.object({ sampled: count, resolved: count })
const resolvedWithinSampled = (t: { sampled: number; resolved: number }) => t.resolved <= t.sampled

const jellyfinFailure = z.object({ jellyfinPath: z.string(), reason: z.string() })

const recordSchema = z.object({
  at: z.string(),
  mappingsHash: z.string(),
  jellyfin: tally.extend({ failures: z.array(jellyfinFailure) }).refine(resolvedWithinSampled),
  qbit: z.array(
    tally.extend({
      instanceId: z.string(),
      failures: z.array(z.object({ qbitPath: z.string(), reason: z.string() })),
      ignored: z.object({ count, examples: z.array(z.string()) }).optional(),
    }).refine(resolvedWithinSampled),
  ),
})

/** What POST /api/pathmap/verify stored before verification knew about mapping sets or qBittorrent. */
const legacyRecordSchema = tally.extend({ failures: z.array(jellyfinFailure), at: z.string() }).refine(resolvedWithinSampled)

/**
 * Reads the legacy shape {sampled,resolved,failures,at} as jellyfin-only with mappingsHash '' (stale).
 * A record that cannot be read at all, or whose fields do not check out, is reported as absent —
 * which blocks — never as a pass.
 */
export function readVerification(db: Db): VerificationRecord | null {
  const row = db.prepare('SELECT value_json FROM kv WHERE key = ?').get(VERIFICATION_KV_KEY) as
    { value_json: string } | undefined
  if (!row) return null
  let value: unknown
  try {
    value = JSON.parse(row.value_json)
  } catch {
    return null
  }
  const current = recordSchema.safeParse(value)
  if (current.success) return current.data
  const legacy = legacyRecordSchema.safeParse(value)
  if (legacy.success) {
    return {
      at: legacy.data.at,
      // No mapping set hashes to '', so a record from before hashing existed is never current.
      mappingsHash: '',
      jellyfin: { sampled: legacy.data.sampled, resolved: legacy.data.resolved, failures: legacy.data.failures },
      qbit: [],
    }
  }
  return null
}

export function writeVerification(db: Db, record: VerificationRecord): void {
  db.prepare('INSERT OR REPLACE INTO kv (key, value_json) VALUES (?, ?)').run(VERIFICATION_KV_KEY, JSON.stringify(record))
}

/**
 * Spec §11: indexing against an unverified path map is how the wrong files get identified.
 *
 * This lives with the RUNNER, not with the HTTP route, because the route is not the dominant way
 * a scan starts — the nightly scheduled scan is, and it never passes through Fastify at all. A
 * gate the manual button honours and the 3am scan bypasses is not a gate. Plan builds read it too.
 *
 * Null when scans/plans may proceed, else the operator-facing reason. Blocks on: no record;
 * mappingsHash !== current.mappingsHash; jellyfin.sampled <= 0; any jellyfin failure or
 * resolved < sampled; any id in current.instanceIds with no report; any report with failures or
 * resolved < sampled. A report with sampled 0 and no failures passes (that instance has no
 * completed torrents, or none under a mapped folder and no mapping of its own — an instance WITH a
 * mapping that no completed torrent lies under carries a failure). A report's `ignored` count never
 * blocks: those torrents lie outside every mapped folder.
 */
export function verificationBlocker(db: Db, current: { mappingsHash: string; instanceIds: string[] }): string | null {
  const record = readVerification(db)
  if (!record) return 'path mappings have never been verified — run Verify in Settings first'
  // A result describes the mapping set it was run against. Any edit since — a prefix, an instance,
  // a root added or removed — means nobody has checked what is configured NOW.
  if (record.mappingsHash !== current.mappingsHash) {
    return 'path mappings changed since they were last verified — run Verify in Settings again'
  }
  // verifyMappings reports {sampled: 0, resolved: 0, failures: []} when sampleItems() yields
  // nothing, which every other clause below reads as a clean pass. It is not one: nothing was
  // checked. Treating "couldn't check" as "checked and clean" here would wave a scan through at
  // the single gate the spec names as the most likely way this class of tool deletes the wrong
  // thing.
  const jf = record.jellyfin
  if (jf.sampled <= 0) {
    return 'the last path-map verification sampled 0 items, so it checked nothing — verify again once Jellyfin returns items'
  }
  if (jf.failures.length > 0 || jf.resolved < jf.sampled) {
    return `last path-map verification resolved ${jf.resolved} of ${jf.sampled} sampled items`
  }
  for (const id of current.instanceIds) {
    if (!record.qbit.some((r) => r.instanceId === id)) {
      return `qBittorrent instance "${id}" has not been verified — run Verify in Settings again`
    }
  }
  // Unlike the Jellyfin half, sampled 0 is a legitimate answer here: an instance with no completed
  // torrents, or none in a mapped folder and no mapping of its own, has nothing to translate. It
  // still has to have been ASKED (the loop above), and a mapping of its own that translates nothing
  // is a failure Verify records, never an empty sample.
  for (const report of record.qbit) {
    // Nothing sampled yet a failure recorded: the instance could not even be listed (unreachable,
    // or its login refused). "Resolved 0 of 0" would be true and useless — say why instead.
    if (report.sampled === 0 && report.failures.length > 0) {
      return `qBittorrent instance "${report.instanceId}" could not be verified: ${report.failures[0]!.reason}`
    }
    if (report.failures.length > 0 || report.resolved < report.sampled) {
      // The count alone can read "resolved 20 of 20" for a report that failed anyway (a torrent
      // found seeding into a root marked not torrent-backed is checked outside the sample), so the
      // first failure is named.
      const [first, ...rest] = report.failures
      const why = first === undefined ? '' : `: ${first.reason}${rest.length > 0 ? ` (and ${rest.length} more)` : ''}`
      return `last path-map verification resolved ${report.resolved} of ${report.sampled} sampled torrents `
        + `for qBittorrent instance "${report.instanceId}"${why}`
    }
  }
  return null
}
