import type { FastifyInstance } from 'fastify'
import type { Db } from '../index/db.js'
import { currentSchemaVersion } from '../index/db.js'
import type { JellyfinClient } from '../connectors/jellyfin.js'

export function registerHealthRoutes(
  app: FastifyInstance,
  deps: { db: Db; jellyfin: Pick<JellyfinClient, 'ping'> },
): void {
  app.get('/healthz', async (_req, reply) => {
    let jellyfin = 'ok'
    try {
      await deps.jellyfin.ping()
    } catch (err) {
      jellyfin = (err as { kind?: string }).kind ?? 'unreachable'
    }
    return reply.send({
      status: jellyfin === 'ok' ? 'ok' : 'degraded',
      schemaVersion: currentSchemaVersion(deps.db),
      connectors: { jellyfin },
    })
  })
}
