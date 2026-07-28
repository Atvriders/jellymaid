import type { FastifyInstance } from 'fastify'
import type { Db } from '../index/db.js'
import { currentSchemaVersion } from '../index/db.js'
import type { ConnectorErrorKind } from '../connectors/http.js'

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

const CONNECTOR_NAMES = ['jellyfin', 'qbittorrent', 'radarr', 'sonarr'] as const
type ConnectorName = (typeof CONNECTOR_NAMES)[number]

interface IndexCounts {
  jellyfinItems: number
  fsEntries: number
  torrents: number
  findings: number
}

export interface HealthDeps {
  db: Db
  jellyfin: Pingable
  qbittorrent: Pingable
  radarr: Pingable
  sonarr: Pingable
  now?: () => number
  /** Overridable for tests; production keeps the 2-3s deadline documented above. */
  probeDeadlineMs?: number
}

/**
 * Races `promise` against a `ms`-long deadline, resolving to `'timeout'` if the deadline wins.
 * `promise` itself is never cancelled or awaited-away — it keeps running so its real result still
 * lands in whichever cache the caller populated, it just stops being able to hold up this
 * response. `promise` here is always `statusOf`'s return value, which already catches every error
 * inside itself and therefore never rejects, so there is no unhandled-rejection risk in leaving it
 * running unobserved past the race.
 */
async function withDeadline(promise: Promise<string>, ms: number): Promise<string> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms)
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

  app.get('/healthz', async (_req, reply) => {
    // Probed concurrently, not one at a time — a single hanging connector must not delay every
    // other connector's report by however long its own probe takes to time out. Concurrency alone
    // only bounds the SUM of four connectors finishing in parallel, though, not the MAX any one of
    // them is allowed to take — that is what `withDeadline` (finding MAJOR 2) is for: it races each
    // probe against `probeDeadlineMs` so this response can never be held up by any single hung
    // connector, however long its own retries would otherwise take to give up.
    const results = await Promise.all(
      CONNECTOR_NAMES.map(async (name): Promise<readonly [ConnectorName, string]> =>
        [name, await withDeadline(statusOf(name, deps[name]), probeDeadlineMs)]),
    )
    const connectors = Object.fromEntries(results) as Record<ConnectorName, string>
    // `not-configured` is a deliberate operator choice, not a fault, so it must never flip the
    // service into `degraded`. Anything else that is not `ok` — `unreachable`, a probe that hit
    // `probeDeadlineMs` above (`timeout`), or any other `kind` a connector throws — fails closed
    // into `degraded`.
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
    })
  })
}
