import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pathMappingSchema } from '../config/schema.js'
import { readFileConfig, saveConfig } from '../config/load.js'
import { verifyMappings, autoDetectMappings } from '../fs/pathmap.js'
import { requireSession } from './auth.js'
import type { JellyfinClient } from '../connectors/jellyfin.js'

const putSchema = z.object({ mappings: z.array(pathMappingSchema) })
const detectSchema = z.object({ mountRoots: z.array(z.string().min(1)).min(1) })

export function registerPathMapRoutes(
  app: FastifyInstance,
  deps: { dataDir: string; sessionSecret: string; jellyfin: Pick<JellyfinClient, 'items'> },
): void {
  const guard = { preHandler: requireSession(deps.sessionSecret) }

  const sampleItems = async () => {
    const { items } = await deps.jellyfin.items({ startIndex: 0, limit: 20 })
    return items.filter((i) => i.jfPath).map((i) => ({ id: i.id, jfPath: i.jfPath! }))
  }

  app.get('/api/pathmap', guard, async (_req, reply) =>
    reply.send({ mappings: readFileConfig(deps.dataDir).pathMappings }))

  app.put('/api/pathmap', guard, async (req, reply) => {
    const parsed = putSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid mappings', issues: parsed.error.issues.map((i) => i.message) })
    }
    saveConfig(deps.dataDir, { pathMappings: parsed.data.mappings })
    return reply.send({ mappings: parsed.data.mappings })
  })

  app.post('/api/pathmap/verify', guard, async (_req, reply) => {
    const mappings = readFileConfig(deps.dataDir).pathMappings
    return reply.send(await verifyMappings({ mappings, sampleItems }))
  })

  app.post('/api/pathmap/detect', guard, async (req, reply) => {
    const parsed = detectSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'mountRoots is required' })
    return reply.send({ proposed: await autoDetectMappings({ mountRoots: parsed.data.mountRoots, sampleItems }) })
  })
}
