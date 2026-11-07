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
      if (result.reason === 'unverified') return reply.code(412).send({ error: result.error, forcible: true })
      // Busy: another scan, a plan that holds the ActivityLock, or a server shutting down. The
      // runner's result puts its prose in `error` and the machine word in `reason`; on the wire it is
      // C12's shape, the same as the plans route's 409 — `error` the word, `reason` the prose — since
      // the client shows `reason` whenever one is sent. Forwarded the runner's way round, the
      // operator would read "busy" and never learn WHAT holds the lock (Ruling 14).
      return reply.code(409).send({ error: 'busy', reason: result.error })
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
