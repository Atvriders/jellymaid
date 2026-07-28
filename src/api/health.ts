import type { FastifyInstance } from 'fastify'
import type { Db } from '../index/db.js'
import { currentSchemaVersion } from '../index/db.js'

/**
 * How long a connector's ping result is reused. `/healthz` is deliberately unauthenticated (it is
 * a container probe) and every connector below shares its own rate-limited client with the scan
 * and plan machinery. Without this cache an anonymous caller hammering /healthz could occupy every
 * concurrency slot on any one of them and stall an in-progress scan or plan build. Short enough
 * that a real outage still surfaces within a probe interval or two. One TTL for all four — there
 * is no reason for them to disagree on staleness.
 */
const PING_TTL_MS = 5_000

/** `null` means "not configured", not "unreachable" — see statusOf below. */
type Pingable = { ping(): Promise<void> } | null

const CONNECTOR_NAMES = ['jellyfin', 'qbittorrent', 'radarr', 'sonarr'] as const
type ConnectorName = (typeof CONNECTOR_NAMES)[number]

export interface HealthDeps {
  db: Db
  jellyfin: Pingable
  qbittorrent: Pingable
  radarr: Pingable
  sonarr: Pingable
  now?: () => number
}

export function registerHealthRoutes(app: FastifyInstance, deps: HealthDeps): void {
  const now = deps.now ?? Date.now
  // One cache slot and one in-flight collapse PER connector, not one shared slot — a slow or
  // hanging qBittorrent probe must not delay reporting a healthy Jellyfin (or vice versa), and
  // each connector's TTL clock runs independently of the others.
  const cached = new Map<ConnectorName, { status: string; at: number }>()
  const inFlight = new Map<ConnectorName, Promise<string>>()

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
        status = (err as { kind?: string }).kind ?? 'unreachable'
      }
      cached.set(name, { status, at: now() })
      return status
    })().finally(() => { inFlight.delete(name) })
    inFlight.set(name, promise)
    return promise
  }

  app.get('/healthz', async (_req, reply) => {
    // Probed concurrently, not one at a time — a single hanging connector must not delay every
    // other connector's report by however long its own probe takes to time out.
    const results = await Promise.all(
      CONNECTOR_NAMES.map(async (name): Promise<readonly [ConnectorName, string]> => [name, await statusOf(name, deps[name])]),
    )
    const connectors = Object.fromEntries(results) as Record<ConnectorName, string>
    // `not-configured` is a deliberate operator choice, not a fault, so it must never flip the
    // service into `degraded`. Anything else that is not `ok` — `unreachable`, or any other
    // `kind` a connector throws — fails closed into `degraded`.
    const degraded = results.some(([, status]) => status !== 'ok' && status !== 'not-configured')

    const count = (sql: string) => (deps.db.prepare(sql).get() as { c: number }).c
    return reply.send({
      status: degraded ? 'degraded' : 'ok',
      schemaVersion: currentSchemaVersion(deps.db),
      connectors,
      lastScan: deps.db.prepare(
        'SELECT id, status, started_at, finished_at FROM scans ORDER BY id DESC LIMIT 1',
      ).get() ?? null,
      indexCounts: {
        jellyfinItems: count('SELECT COUNT(*) c FROM jellyfin_items'),
        fsEntries: count('SELECT COUNT(*) c FROM fs_entries'),
        torrents: count('SELECT COUNT(*) c FROM torrents'),
        findings: count("SELECT COUNT(*) c FROM findings WHERE status = 'open'"),
      },
    })
  })
}
