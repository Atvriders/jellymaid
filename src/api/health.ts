import type { FastifyInstance } from 'fastify'
import type { Db } from '../index/db.js'
import { currentSchemaVersion } from '../index/db.js'
import type { ConnectorErrorKind } from '../connectors/http.js'
import type { ArrClient, ArrRecord } from '../connectors/arr.js'
import type { PathMap } from '../fs/pathmap.js'

/**
 * How long a connector's ping result is reused. `/healthz` is deliberately unauthenticated (it is
 * a container probe) and every connector below shares its own rate-limited client with the scan
 * and plan machinery. Without this cache an anonymous caller hammering /healthz could occupy every
 * concurrency slot on any one of them and stall an in-progress scan or plan build. Short enough
 * that a real outage still surfaces within a probe interval or two. One TTL for all four — there
 * is no reason for them to disagree on staleness. `indexCounts` (below) reuses this exact TTL too:
 * it is the same "an anonymous caller must not spend a per-request budget that scales with library
 * size" concern (finding MINOR 4), just against synchronous COUNT(*) scans instead of a network
 * round trip.
 */
const PING_TTL_MS = 5_000

/**
 * Finding MAJOR 2: none of the four connectors below sets an explicit `timeoutMs` on the
 * `HttpClient` that backs `ping()`, so each inherits the client's 30s default — and a GET is
 * idempotent, so `shouldRetry` (src/connectors/http.ts) retries it up to 3 more times with
 * backoff. Measured against a black-holing host: ~121.75s before a single ping's promise settles.
 * The route below used to `Promise.all` on `statusOf` with no ceiling of its own, so ONE hung
 * connector could stall the entire response that long — the route's concurrency protects the SUM
 * of four connectors finishing in parallel, not the MAX any one of them is allowed to take.
 *
 * Racing each probe against this deadline (2-3s, comfortably inside a real container orchestrator's
 * own health-check timeout) resolves it to `'timeout'` instead of waiting — the underlying
 * `statusOf` promise is left running in the background so its eventual result still populates the
 * cache for the next probe, it just no longer blocks THIS response.
 */
const DEFAULT_PROBE_DEADLINE_MS = 2_500

/**
 * Finding MINOR 3: `err.kind` used to be echoed into the (unauthenticated) response body with no
 * validation — `(err as { kind?: string }).kind ?? 'unreachable'` trusts an arbitrary property on
 * whatever was thrown. Only a `ConnectorError` reaches this catch today, and its `kind` is this
 * bounded union, but one catch-and-rethrow elsewhere would put attacker- or bug-supplied text
 * straight into the one endpoint with no auth. This is a runtime allowlist, not a type assertion —
 * `err` here is `unknown`, so the check must hold even if what's thrown was never really a
 * `ConnectorError` — but it is typed against `ConnectorErrorKind` (src/connectors/http.ts) so it
 * cannot silently drift from the real union without a compiler error at this array literal.
 */
const KNOWN_ERROR_KINDS = new Set<string>(
  ['unreachable', 'auth', 'rate-limited', 'bad-response', 'timeout', 'cancelled'] satisfies ConnectorErrorKind[],
)

/** `null` means "not configured", not "unreachable" — see statusOf below. */
type Pingable = { ping(): Promise<void> } | null

/**
 * Radarr/Sonarr also carry `inventory` (beyond plain `ping`) so the route below can compute
 * `arrUnmappable` (ship-audit MAJOR 2, carry-forward.md:49) from the same *arr read `resolveTarget`
 * (src/plan/resolve.ts) uses, without widening what jellyfin/qbittorrent need to supply.
 */
type ArrConnector = Pick<ArrClient, 'ping' | 'inventory'> | null

const CONNECTOR_NAMES = ['jellyfin', 'qbittorrent', 'radarr', 'sonarr'] as const
type ConnectorName = (typeof CONNECTOR_NAMES)[number]
const ARR_CONNECTOR_NAMES = ['radarr', 'sonarr'] as const
type ArrConnectorName = (typeof ARR_CONNECTOR_NAMES)[number]

interface IndexCounts {
  jellyfinItems: number
  fsEntries: number
  torrents: number
  findings: number
}

/**
 * Mirrors the `evaluated`/count split `findings/summary` (src/api/findings.ts) and `resolve.ts`'s
 * own `sourcesUnavailable` already use: the project's discipline is that "could not be measured"
 * must never collapse into a `count` of 0, or a genuinely clean install becomes indistinguishable
 * from a Radarr/Sonarr outage that made this look clean. `count` is meaningless (always 0) when
 * `evaluated` is false — callers must check `evaluated` first, same as `findings/summary.evaluated`.
 * Deliberately never rolled into the top-level `status` field below — see the route handler for why.
 */
interface ArrUnmappableStatus {
  evaluated: boolean
  count: number
}

export interface HealthDeps {
  db: Db
  jellyfin: Pingable
  qbittorrent: Pingable
  radarr: ArrConnector
  sonarr: ArrConnector
  pathMap: PathMap
  now?: () => number
  /** Overridable for tests; production keeps the 2-3s deadline documented above. */
  probeDeadlineMs?: number
}

/**
 * Races `promise` against a `ms`-long deadline, resolving to `onTimeout` if the deadline wins.
 * `promise` itself is never cancelled or awaited-away — it keeps running so its real result still
 * lands in whichever cache the caller populated, it just stops being able to hold up this
 * response. Every caller below already catches its own errors internally and therefore never
 * rejects, so there is no unhandled-rejection risk in leaving it running unobserved past the race.
 * Generic over the resolved type: `statusOf` races a connector-status string, `arrInventoryOf`
 * (finding MAJOR 2) races a small inventory-fetch outcome — both need the exact same "never let one
 * slow probe hold up the whole response" shape.
 */
async function withDeadline<T>(promise: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout), ms)
  })
  try {
    return await Promise.race([promise, deadline])
  } finally {
    clearTimeout(timer)
  }
}

export function registerHealthRoutes(app: FastifyInstance, deps: HealthDeps): void {
  const now = deps.now ?? Date.now
  const probeDeadlineMs = deps.probeDeadlineMs ?? DEFAULT_PROBE_DEADLINE_MS
  // One cache slot and one in-flight collapse PER connector, not one shared slot — a slow or
  // hanging qBittorrent probe must not delay reporting a healthy Jellyfin (or vice versa), and
  // each connector's TTL clock runs independently of the others.
  const cached = new Map<ConnectorName, { status: string; at: number }>()
  const inFlight = new Map<ConnectorName, Promise<string>>()
  // Finding MINOR 4: connector pings are TTL-cached specifically so an anonymous caller cannot
  // spend a rate-limited budget; indexCounts had no such protection and ran four fresh COUNT(*)
  // scans (measured 3.2ms of synchronous, event-loop-blocking work on a 250k-row index) on every
  // request. Reuses the exact same TTL and `now()` seam as the connector cache above.
  let indexCountsCache: { value: IndexCounts; at: number } | null = null

  function getIndexCounts(): IndexCounts {
    if (indexCountsCache && now() - indexCountsCache.at < PING_TTL_MS) return indexCountsCache.value
    const count = (sql: string) => (deps.db.prepare(sql).get() as { c: number }).c
    const value: IndexCounts = {
      jellyfinItems: count('SELECT COUNT(*) c FROM jellyfin_items'),
      fsEntries: count('SELECT COUNT(*) c FROM fs_entries'),
      torrents: count('SELECT COUNT(*) c FROM torrents'),
      findings: count("SELECT COUNT(*) c FROM findings WHERE status = 'open'"),
    }
    indexCountsCache = { value, at: now() }
    return value
  }

  async function statusOf(name: ConnectorName, client: Pingable): Promise<string> {
    // "Not configured" (an optional Radarr/Sonarr instance the operator never set up) must read
    // as its own state, never as `ok` (that would claim a measurement that was never taken) and
    // never as `unreachable` (that would claim a failure that never happened). Per
    // docs/superpowers/carry-forward.md: degraded means not evaluated, never zero — the same
    // discipline applies to "healthy", it must never mean "not evaluated" either.
    if (!client) return 'not-configured'
    const hit = cached.get(name)
    if (hit && now() - hit.at < PING_TTL_MS) return hit.status
    // Concurrent probes past the TTL share one ping rather than each starting their own.
    const running = inFlight.get(name)
    if (running) return running
    const promise = (async () => {
      let status = 'ok'
      try {
        await client.ping()
      } catch (err) {
        // Finding MINOR 3: validated against the known-kinds allowlist rather than echoed
        // verbatim — see KNOWN_ERROR_KINDS above for why this can't just trust `err`'s shape.
        const kind = (err as { kind?: unknown } | null)?.kind
        status = typeof kind === 'string' && KNOWN_ERROR_KINDS.has(kind) ? kind : 'unreachable'
      }
      cached.set(name, { status, at: now() })
      return status
    })().finally(() => { inFlight.delete(name) })
    inFlight.set(name, promise)
    return promise
  }

  // One cache slot and one in-flight collapse per *arr instance, same shape as the ping cache
  // above and the same TTL — an unauthenticated caller must not be able to spend a fresh
  // Radarr/Sonarr inventory fetch (a much heavier call than `ping`: the whole movie/series list)
  // on every probe. `ok: false` covers both a thrown error and a timed-out probe; the route below
  // only needs to know "this instance's records could not be trusted", not why.
  type ArrInventoryOutcome = { ok: true; records: ArrRecord[] } | { ok: false }
  const arrCached = new Map<ArrConnectorName, { outcome: ArrInventoryOutcome; at: number }>()
  const arrInFlight = new Map<ArrConnectorName, Promise<ArrInventoryOutcome>>()

  async function arrInventoryOf(name: ArrConnectorName, client: ArrConnector): Promise<ArrInventoryOutcome> {
    // Not configured: legitimately zero records, not a failed measurement — never cached, same as
    // `statusOf`'s `not-configured` short-circuit, since there is nothing to grow stale.
    if (!client) return { ok: true, records: [] }
    const hit = arrCached.get(name)
    if (hit && now() - hit.at < PING_TTL_MS) return hit.outcome
    const running = arrInFlight.get(name)
    if (running) return running
    const promise = (async () => {
      let outcome: ArrInventoryOutcome
      try {
        const { records } = await client.inventory()
        outcome = { ok: true, records }
      } catch {
        outcome = { ok: false }
      }
      arrCached.set(name, { outcome, at: now() })
      return outcome
    })().finally(() => { arrInFlight.delete(name) })
    arrInFlight.set(name, promise)
    return promise
  }

  app.get('/healthz', async (_req, reply) => {
    // Probed concurrently, not one at a time — a single hanging connector must not delay every
    // other connector's report by however long its own probe takes to time out. Concurrency alone
    // only bounds the SUM of four connectors finishing in parallel, though, not the MAX any one of
    // them is allowed to take — that is what `withDeadline` (finding MAJOR 2) is for: it races each
    // probe against `probeDeadlineMs` so this response can never be held up by any single hung
    // connector, however long its own retries would otherwise take to give up.
    const results = await Promise.all(
      CONNECTOR_NAMES.map(async (name): Promise<readonly [ConnectorName, string]> =>
        [name, await withDeadline(statusOf(name, deps[name]), probeDeadlineMs, 'timeout')]),
    )
    const connectors = Object.fromEntries(results) as Record<ConnectorName, string>

    // Ship-audit MAJOR 2 / carry-forward.md:49: `arrUnmappable` (src/plan/resolve.ts) blocks every
    // delete non-overridably, but until now was reachable only by building a plan and reading its
    // failure message. The count computed here does not depend on any specific target path — it is
    // the same global "how many *arr records does no path mapping cover" tally `resolveTarget` folds
    // into every resolution, recomputed directly from the *arr inventories rather than by calling
    // `resolveTarget` (which needs a real filesystem target, qBittorrent, and the rest of the plan
    // machinery this unauthenticated probe has no business touching).
    const arrResults = await Promise.all(
      ARR_CONNECTOR_NAMES.map(async (name): Promise<readonly [ArrConnectorName, ArrInventoryOutcome]> =>
        [name, await withDeadline(arrInventoryOf(name, deps[name]), probeDeadlineMs, { ok: false })]),
    )
    let arrUnmappableEvaluated = true
    let arrUnmappableCount = 0
    for (const [, outcome] of arrResults) {
      if (!outcome.ok) { arrUnmappableEvaluated = false; continue }
      for (const record of outcome.records) {
        // Same rule as resolve.ts: a record with no *arr path at all has nothing on disk to be
        // unmappable, and is not counted; a record whose path no mapping translates is a hole in
        // the path map. Only the COUNT crosses into this unauthenticated response — never
        // `record.arrPath` itself, which is host root-folder/library layout, not a bare number.
        if (record.arrPath && !deps.pathMap.toContainer(record.arrPath)) arrUnmappableCount += 1
      }
    }
    const arrUnmappable: ArrUnmappableStatus = arrUnmappableEvaluated
      ? { evaluated: true, count: arrUnmappableCount }
      : { evaluated: false, count: 0 }
    // `not-configured` is a deliberate operator choice, not a fault, so it must never flip the
    // service into `degraded`. Anything else that is not `ok` — `unreachable`, a probe that hit
    // `probeDeadlineMs` above (`timeout`), or any other `kind` a connector throws — fails closed
    // into `degraded`.
    //
    // `arrUnmappable` deliberately does NOT feed into `degraded`, in either direction:
    //  - a non-zero count is a data/config issue for the operator to fix (add a path mapping for a
    //    decommissioned *arr root) — the same category as `indexCounts.findings`, which also never
    //    degrades `status` despite representing something an operator should look at. It is not a
    //    liveness fault a container restart would resolve, and flipping `status` for it would make
    //    a legitimate library reorganisation look like an outage.
    //  - `evaluated: false` (a configured *arr's inventory fetch failed) would only duplicate a
    //    signal `connectors.radarr`/`connectors.sonarr` already carries: if that instance is
    //    genuinely unreachable, its `ping`-based connector status already reads non-`ok` and already
    //    drives `degraded` above. A second, redundant path to the same fact adds no information.
    //  - This is also why it is intentionally NOT coupled to the old "any non-`ok` `status` fails the
    //    container" HEALTHCHECK policy: that policy is being narrowed to liveness-only regardless,
    //    and `arrUnmappable` was never a liveness signal to begin with.
    const degraded = results.some(([, status]) => status !== 'ok' && status !== 'not-configured')

    return reply.send({
      // Finding MINOR 5: `degraded` is deliberately still HTTP 200, not 503 — this is a container
      // probe, and the Dockerfile's HEALTHCHECK (CMD ... fetch('/healthz').then(r=>r.json())...)
      // decides pass/fail from the `status` FIELD in this body, not the HTTP status code, so
      // encoding the same fact twice would add a second place for the two to disagree. A plain
      // `curl -f /healthz` intentionally reads `degraded` as "reachable", the same as `ok` — the
      // body is where the real answer lives.
      status: degraded ? 'degraded' : 'ok',
      schemaVersion: currentSchemaVersion(deps.db),
      connectors,
      lastScan: deps.db.prepare(
        'SELECT id, status, started_at, finished_at FROM scans ORDER BY id DESC LIMIT 1',
      ).get() ?? null,
      indexCounts: getIndexCounts(),
      arrUnmappable,
    })
  })
}
