import type { Db } from '../index/db.js'

interface VerificationRecord { sampled: number; resolved: number; failures: unknown[]; at: string }

/**
 * Spec §11: indexing against an unverified path map is how the wrong files get identified.
 *
 * This lives with the RUNNER, not with the HTTP route, because the route is not the dominant way
 * a scan starts — the nightly scheduled scan is, and it never passes through Fastify at all. A
 * gate the manual button honours and the 3am scan bypasses is not a gate. Returns the operator-
 * facing blocker message, or null when a scan may proceed.
 */
export function verificationBlocker(db: Db): string | null {
  const row = db.prepare("SELECT value_json FROM kv WHERE key = 'pathmap.lastVerification'").get() as
    { value_json: string } | undefined
  if (!row) return 'path mappings have never been verified — run Verify in Settings first'
  const record = JSON.parse(row.value_json) as VerificationRecord
  // verifyMappings reports {sampled: 0, resolved: 0, failures: []} when sampleItems() yields
  // nothing, which every other clause below reads as a clean pass. It is not one: nothing was
  // checked. Treating "couldn't check" as "checked and clean" here would wave a scan through at
  // the single gate the spec names as the most likely way this class of tool deletes the wrong
  // thing.
  if (record.sampled <= 0) {
    return 'the last path-map verification sampled 0 items, so it checked nothing — verify again once Jellyfin returns items'
  }
  if (record.failures.length > 0 || record.resolved < record.sampled) {
    return `last path-map verification resolved ${record.resolved} of ${record.sampled} sampled items`
  }
  return null
}
