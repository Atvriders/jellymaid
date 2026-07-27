import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pathMappingSchema } from '../config/schema.js'
import { readFileConfig, saveConfig } from '../config/load.js'
import { verifyMappings, autoDetectMappings } from '../fs/pathmap.js'
import { requireSession } from './auth.js'
import type { JellyfinClient } from '../connectors/jellyfin.js'
import type { Db } from '../index/db.js'

const putSchema = z.object({ mappings: z.array(pathMappingSchema) })
const detectSchema = z.object({ mountRoots: z.array(z.string().min(1)).min(1) })

const SAMPLE_TARGET = 20
/** Never more than this many requests, so a "verify" can never turn into a scan. */
const MAX_SAMPLE_REQUESTS = 5
const WINDOW = 10

export function registerPathMapRoutes(
  app: FastifyInstance,
  deps: {
    dataDir: string
    sessionSecret: string
    jellyfin: Pick<JellyfinClient, 'items'>
    db: Db
    random?: () => number
  },
): void {
  const guard = { preHandler: requireSession(deps.sessionSecret) }
  const random = deps.random ?? Math.random

  /**
   * Draws small windows from random offsets across the whole library rather than taking the first
   * 20 rows. Jellyfin's default ordering means offset 0 returns one library's items, so a
   * first-page sample reports "verification passing" while a second library's mapping is entirely
   * wrong. Only rows that actually carry a path count towards the target — Series and Season rows
   * are requested alongside playable items but have no path, and would otherwise shrink the
   * effective sample to near nothing.
   */
  const sampleItems = async () => {
    const first = await deps.jellyfin.items({ startIndex: 0, limit: 1 })
    const total = first.totalRecordCount
    const collected = new Map<string, { id: string; jfPath: string }>()
    const keep = (items: Array<{ id: string; jfPath: string | null }>) => {
      for (const i of items) if (i.jfPath) collected.set(i.id, { id: i.id, jfPath: i.jfPath })
    }
    keep(first.items)
    if (total <= 0) return [...collected.values()]

    const maxOffset = Math.max(0, total - WINDOW)
    for (let n = 0; n < MAX_SAMPLE_REQUESTS && collected.size < SAMPLE_TARGET; n += 1) {
      const startIndex = maxOffset === 0 ? 0 : Math.floor(random() * (maxOffset + 1))
      const { items } = await deps.jellyfin.items({ startIndex, limit: WINDOW })
      if (items.length === 0) break
      keep(items)
      if (maxOffset === 0) break // the whole library fits in one window; further requests add nothing
    }
    return [...collected.values()].slice(0, SAMPLE_TARGET)
  }

  app.get('/api/pathmap', guard, async (_req, reply) =>
    reply.send({ mappings: readFileConfig(deps.dataDir).pathMappings }))

  app.put('/api/pathmap', guard, async (req, reply) => {
    const parsed = putSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid mappings', issues: parsed.error.issues.map((i) => i.message) })
    }
    saveConfig(deps.dataDir, { pathMappings: parsed.data.mappings })
    // A verification result describes a SPECIFIC mapping set. Once the mappings change, that
    // result no longer means anything — an edited map must not ride on a pass recorded for the
    // map it replaced, or POST /api/scan/start's gate (src/api/scan.ts) would wave through a scan
    // against paths nobody has actually checked.
    deps.db.prepare("DELETE FROM kv WHERE key = 'pathmap.lastVerification'").run()
    return reply.send({ mappings: parsed.data.mappings })
  })

  app.post('/api/pathmap/verify', guard, async (_req, reply) => {
    const mappings = readFileConfig(deps.dataDir).pathMappings
    const report = await verifyMappings({ mappings, sampleItems })
    // Persisted so POST /api/scan/start's gate can read it later — verifying is a separate call
    // from starting a scan, so the pass/fail has to outlive this one request.
    deps.db.prepare("INSERT OR REPLACE INTO kv (key, value_json) VALUES ('pathmap.lastVerification', ?)")
      .run(JSON.stringify({ ...report, at: new Date().toISOString() }))
    return reply.send(report)
  })

  app.post('/api/pathmap/detect', guard, async (req, reply) => {
    const parsed = detectSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'mountRoots is required' })
    return reply.send({ proposed: await autoDetectMappings({ mountRoots: parsed.data.mountRoots, sampleItems }) })
  })
}
