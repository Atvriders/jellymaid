import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ConfigStore } from '../config/store.js'
import type { FileConfig, KeeperPolicy } from '../config/schema.js'
import { requireSession } from './auth.js'

/**
 * What the Settings screen reads and edits (C12). Only these three groups of config.json: a rate
 * limit, a rule setting or the path mappings are not Settings, and the mappings have their own
 * routes (src/api/pathmap.ts).
 */
export interface SettingsView {
  guards: {
    minRatio: number
    minSeedTimeDays: number
    protectedCategories: string[]
    protectedTags: string[]
    privateTrackerHosts: string[]
  }
  keeper: { policy: KeeperPolicy }
  trash: { maxBytes: number; retentionDays: number }
}

/**
 * Field by field, never a spread of `config.guards`: this is the one place the private tracker
 * host list is published, and it is published because the operator edits it here. A spread would
 * make every field a later edit adds to the guards object part of this response without anyone
 * deciding that it should be.
 */
function settingsView(config: FileConfig): SettingsView {
  return {
    guards: {
      minRatio: config.guards.minRatio,
      minSeedTimeDays: config.guards.minSeedTimeDays,
      protectedCategories: config.guards.protectedCategories,
      protectedTags: config.guards.protectedTags,
      privateTrackerHosts: config.guards.privateTrackerHosts,
    },
    keeper: { policy: config.keeper.policy },
    trash: { maxBytes: config.trash.maxBytes, retentionDays: config.trash.retentionDays },
  }
}

/** Typed against `KeeperPolicy`, so a policy added to the config schema cannot be missing here unnoticed. */
const KEEPER_POLICIES = ['best-quality', 'smallest', 'none'] as const satisfies readonly KeeperPolicy[]

/**
 * `.finite()` is not decoration. JSON has no Infinity, but `JSON.parse('1e999')` is one, and zod's
 * `number()` lets it through; `JSON.stringify` then writes it into config.json as `null`, which the
 * file schema rejects on every later read. One request could make config.json unloadable, from the
 * route whose whole job is editing the guard thresholds.
 */
const nonNegative = z.number().finite().min(0)

/**
 * DeepPartial<Pick<SettingsView, 'guards' | 'keeper'>>. `.strict()` at every level: a key this
 * schema does not know (`trash`, a misspelled threshold) is a 400, never silently dropped — a
 * caller whose change was ignored must be told so. Lists replace; they are not merged.
 */
const putBody = z.object({
  guards: z.object({
    minRatio: nonNegative,
    minSeedTimeDays: nonNegative,
    protectedCategories: z.array(z.string()),
    protectedTags: z.array(z.string()),
    privateTrackerHosts: z.array(z.string()),
  }).partial().strict(),
  keeper: z.object({ policy: z.enum(KEEPER_POLICIES) }).partial().strict(),
}).partial().strict()

export function registerSettingsRoutes(
  app: FastifyInstance,
  deps: { configStore: Pick<ConfigStore, 'file' | 'save'>; sessionSecret: string },
): void {
  const guard = { preHandler: requireSession(deps.sessionSecret) }

  app.get('/api/config/settings', guard, async (_req, reply) => reply.send(settingsView(deps.configStore.file())))

  app.put('/api/config/settings', guard, async (req, reply) => {
    const parsed = putBody.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid settings',
        issues: parsed.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)),
      })
    }
    // `save` merges the `guards` and `keeper` subtrees one level deep (src/config/load.ts), so
    // `{ guards: { minRatio: 2 } }` leaves every other threshold as it was. Its parameter is typed
    // for a whole FileConfig subtree, hence the cast: a partial subtree is exactly what it accepts.
    // The store re-reads the file on its next call, so the change is live for the planner, the
    // executor and every read model without a restart.
    const saved = deps.configStore.save(parsed.data as Partial<FileConfig>)
    return reply.send(settingsView(saved))
  })

  /**
   * Kept for callers written against the route that used to live in plans.ts: the thresholds that
   * explain why a guard fired (min ratio / seed days, the protected category and tag lists) or why
   * a delete went to the trash, and nothing that could be written back through it.
   *
   * It deliberately does NOT carry `guards.privateTrackerHosts`, though the settings view above now
   * does. This route's shape is the compatibility promise; the host list is the operator's
   * private-tracker list, and a caller that only wants thresholds has no business receiving it.
   * Reading each field off the live config, instead of destructuring `guards`/`trash` into locals,
   * leaves no object in scope for a later edit to shortcut with `...guards` and republish the host
   * list by accident.
   */
  app.get('/api/config/thresholds', guard, async (_req, reply) => {
    const config = deps.configStore.file()
    return reply.send({
      minRatio: config.guards.minRatio,
      minSeedTimeDays: config.guards.minSeedTimeDays,
      protectedCategories: config.guards.protectedCategories,
      protectedTags: config.guards.protectedTags,
      trashMaxBytes: config.trash.maxBytes,
      trashRetentionDays: config.trash.retentionDays,
    })
  })
}
