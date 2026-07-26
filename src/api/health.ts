import type { FastifyInstance } from 'fastify'
import type { Db } from '../index/db.js'
import { currentSchemaVersion } from '../index/db.js'
import type { JellyfinClient } from '../connectors/jellyfin.js'

/**
 * How long a Jellyfin ping result is reused. `/healthz` is deliberately unauthenticated (it is a
 * container probe), and it shares ONE rate-limited Jellyfin client with the scan. Without this
 * cache an anonymous caller could occupy every Jellyfin concurrency slot and grow the client's
 * unbounded queue, stalling an in-progress scan. Short enough that a real outage still surfaces
 * within a probe interval or two.
 */
const PING_TTL_MS = 5_000

export function registerHealthRoutes(
  app: FastifyInstance,
  deps: { db: Db; jellyfin: Pick<JellyfinClient, 'ping'>; now?: () => number },
): void {
  const now = deps.now ?? Date.now
  let cached: { status: string; at: number } | null = null
  let inFlight: Promise<string> | null = null

  async function jellyfinStatus(): Promise<string> {
    if (cached && now() - cached.at < PING_TTL_MS) return cached.status
    // Concurrent probes past the TTL share one ping rather than each starting their own.
    inFlight ??= (async () => {
      let status = 'ok'
      try {
        await deps.jellyfin.ping()
      } catch (err) {
        status = (err as { kind?: string }).kind ?? 'unreachable'
      }
      cached = { status, at: now() }
      return status
    })().finally(() => { inFlight = null })
    return inFlight
  }

  app.get('/healthz', async (_req, reply) => {
    const jellyfin = await jellyfinStatus()
    return reply.send({
      status: jellyfin === 'ok' ? 'ok' : 'degraded',
      schemaVersion: currentSchemaVersion(deps.db),
      connectors: { jellyfin },
    })
  })
}
