import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Db } from '../index/db.js'
import type { ScanRunner } from '../scan/runner.js'
import { requireSession } from './auth.js'

const startSchema = z.object({
  resumeScanId: z.number().int().positive().optional(),
  force: z.boolean().optional(),
}).default({})

interface VerificationRecord { sampled: number; resolved: number; failures: unknown[]; at: string }

/** Spec §11: indexing against an unverified path map is how the wrong files get identified. */
function verificationBlocker(db: Db): string | null {
  const row = db.prepare("SELECT value_json FROM kv WHERE key = 'pathmap.lastVerification'").get() as
    { value_json: string } | undefined
  if (!row) return 'path mappings have never been verified — run Verify in Settings first'
  const record = JSON.parse(row.value_json) as VerificationRecord
  if (record.failures.length > 0 || record.resolved < record.sampled) {
    return `last path-map verification resolved ${record.resolved} of ${record.sampled} sampled items`
  }
  return null
}

export function registerScanRoutes(
  app: FastifyInstance,
  deps: { runner: ScanRunner; sessionSecret: string; db: Db },
): void {
  const guard = { preHandler: requireSession(deps.sessionSecret) }

  app.post('/api/scan/start', guard, async (req, reply) => {
    const parsed = startSchema.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' })
    if (!parsed.data.force) {
      const blocker = verificationBlocker(deps.db)
      if (blocker) return reply.code(412).send({ error: blocker, forcible: true })
    }
    const result = deps.runner.start(parsed.data.resumeScanId)
    if ('error' in result) return reply.code(409).send(result)
    return reply.code(202).send(result)
  })

  app.post('/api/scan/cancel', guard, async (_req, reply) => {
    return deps.runner.cancel()
      ? reply.send({ cancelled: true })
      : reply.code(409).send({ error: 'no scan is running' })
  })

  app.get('/api/scan/status', guard, async (_req, reply) => reply.send(deps.runner.status()))
}
