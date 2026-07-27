import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ScanRunner } from '../scan/runner.js'
import { requireSession } from './auth.js'

const startSchema = z.object({
  resumeScanId: z.number().int().positive().optional(),
  force: z.boolean().optional(),
}).default({})

export function registerScanRoutes(
  app: FastifyInstance,
  deps: { runner: ScanRunner; sessionSecret: string },
): void {
  const guard = { preHandler: requireSession(deps.sessionSecret) }

  app.post('/api/scan/start', guard, async (req, reply) => {
    const parsed = startSchema.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' })
    // The path-map verification gate is the runner's, not this route's — see
    // src/scan/verification.ts. This route only maps its refusal onto a status code.
    const result = deps.runner.start(parsed.data)
    if ('error' in result) {
      return result.reason === 'unverified'
        ? reply.code(412).send({ error: result.error, forcible: true })
        : reply.code(409).send({ error: result.error })
    }
    return reply.code(202).send(result)
  })

  app.post('/api/scan/cancel', guard, async (_req, reply) => {
    return deps.runner.cancel()
      ? reply.send({ cancelled: true })
      : reply.code(409).send({ error: 'no scan is running' })
  })

  app.get('/api/scan/status', guard, async (_req, reply) => reply.send(deps.runner.status()))
}
