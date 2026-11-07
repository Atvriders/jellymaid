import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pathMappingSchema, type QbitInstanceConfig } from '../config/schema.js'
import type { ConfigStore } from '../config/store.js'
import {
  autoDetectMappings, autoDetectQbitMappings, verifyMappings, verifyQbitMappings, type QbitSampleSource,
} from '../fs/pathmap.js'
import { readVerification, writeVerification, type VerificationRecord } from '../scan/verification.js'
import { requireSession } from './auth.js'
import type { JellyfinClient } from '../connectors/jellyfin.js'
import type { QbitClient } from '../connectors/qbittorrent.js'
import type { Db } from '../index/db.js'

const putSchema = z.object({ mappings: z.array(pathMappingSchema) })
const detectSchema = z.object({ mountRoots: z.array(z.string().min(1)).min(1) })

const SAMPLE_TARGET = 20
/** Never more than this many requests, so a "verify" can never turn into a scan. */
const MAX_SAMPLE_REQUESTS = 5
const WINDOW = 10

/**
 * How long GET /api/qbit/instances waits for ONE call to ONE instance: its ping, then its torrent
 * list. The instances are probed side by side, so no matter how many are configured the page waits
 * at most twice this (a ping that answers, then a list that does not), and a box that is switched off
 * cannot hold the Settings screen for the connector's own retry schedule (a black-holed host takes
 * minutes to give up on). A box that fails its ping costs one wait, not two.
 */
export const QBIT_PROBE_TIMEOUT_MS = 3000

export interface PathMapRouteDeps {
  /**
   * The live config: mappings are read from it, and saved through it, on every request — never
   * captured when the routes are registered, or an edit would not reach the next Verify.
   */
  configStore: ConfigStore
  db: Db
  jellyfin: Pick<JellyfinClient, 'items'>
  /** Every configured instance's client, keyed by instance id. */
  qbittorrents: ReadonlyMap<string, Pick<QbitClient, 'ping' | 'torrents'>>
  sessionSecret: string
  /** Seeds the sampling windows; `Math.random` unless a test says otherwise. */
  random?: () => number
  /** Overrides `QBIT_PROBE_TIMEOUT_MS`. */
  probeTimeoutMs?: number
}

/** One row of GET /api/qbit/instances. */
export interface QbitInstanceStatus {
  id: string
  url: string
  reachable: boolean
  version: string | null
  error: string | null
  /** All torrents the instance holds; null when it could not be counted in time. */
  torrentCount: number | null
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: string }

/** Operator-facing text for an error from a connector, short enough to sit in a response. */
function describeError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

/**
 * An instance's address as the operator sees it: scheme, host, port and path. Never a username or
 * password, and never a query string or fragment either — whatever rides there (a proxy token, an API
 * key) is as private as a password in the authority. Credentials are already stripped when the
 * environment is loaded; this does not rely on that, because the address is about to leave the server.
 */
function displayUrl(raw: string): string {
  try {
    const url = new URL(raw)
    return `${url.origin}${url.pathname === '/' ? '' : url.pathname}`
  } catch {
    return raw.replace(/\/\/[^/?#]*@/, '//').replace(/[?#].*$/, '')
  }
}

/**
 * Waits for `promise`, but not longer than `ms`. The promise itself is NOT cancelled: it keeps
 * running, and its eventual result simply has nobody waiting for it any more.
 */
async function settleWithin<T>(promise: Promise<T>, ms: number): Promise<Settled<T>> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<Settled<T>>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: `did not answer within ${ms} ms` }), ms)
  })
  const settled = promise.then(
    (value): Settled<T> => ({ ok: true, value }),
    (err): Settled<T> => ({ ok: false, error: describeError(err) }),
  )
  try {
    return await Promise.race([settled, deadline])
  } finally {
    clearTimeout(timer)
  }
}

export function registerPathMapRoutes(app: FastifyInstance, deps: PathMapRouteDeps): void {
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

  /**
   * Every CONFIGURED instance, whether or not a client exists for it. One with no client is not
   * left out: it is asked, fails with a reason, and so shows up in a verification as the failure it
   * is rather than as an instance nobody mentioned.
   */
  const sampleSources = (): QbitSampleSource[] =>
    deps.configStore.instanceIds().map((id) => {
      const client = deps.qbittorrents.get(id)
      return {
        id,
        torrents: client
          ? () => client.torrents()
          : () => Promise.reject(new Error('no qBittorrent client is configured for this instance')),
      }
    })

  /**
   * The mappings as the scan, the planner and the gate actually read them (legacy rows resolved to
   * their only possible instance), what is wrong with them, and the last verification — flagged
   * `current` only when it was taken against exactly this set.
   */
  const view = () => {
    const record = readVerification(deps.db)
    return {
      mappings: deps.configStore.pathMap().all(),
      problems: deps.configStore.mappingProblems(),
      lastVerification: record === null ? null : { ...record, current: record.mappingsHash === deps.configStore.mappingsHash() },
    }
  }

  app.get('/api/pathmap', guard, async (_req, reply) => reply.send(view()))

  app.put('/api/pathmap', guard, async (req, reply) => {
    const parsed = putSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid mappings', issues: parsed.error.issues.map((i) => i.message) })
    }
    // The stored verification is left alone. It carries the hash of the set it was taken against,
    // so an edited set simply stops matching it: the gate blocks, and `view()` still shows the old
    // result, flagged not current. Deleting it would also throw away the answer to "what failed
    // last time?" and would force a re-verify after saving a set that did not change.
    deps.configStore.save({ pathMappings: parsed.data.mappings })
    return reply.send(view())
  })

  app.post('/api/pathmap/verify', guard, async (_req, reply) => {
    // One path map and the hash that names it, taken together: nothing awaits between the two reads.
    const pathMap = deps.configStore.pathMap()
    const stamp = deps.configStore.mappingsHash()
    const [jellyfin, qbit] = await Promise.all([
      verifyMappings({ mappings: pathMap.all(), sampleItems }),
      verifyQbitMappings({ pathMap, instances: sampleSources() }),
    ])
    // A record describes the set it was run against. If the mappings were edited while this ran, it
    // describes a set that is no longer in force: stamped with the old hash it could overwrite a
    // newer, valid record (and `current: true` would be a lie); stamped with the new one it would
    // vouch for mappings nobody checked. Saving nothing is the only honest answer.
    if (deps.configStore.mappingsHash() !== stamp) {
      return reply.code(409).send({
        error: 'mappings changed',
        reason: 'The path mappings were changed while verification was running, so its result was not saved. Run Verify again.',
      })
    }
    // Persisted so the scan and plan gate (verificationBlocker) can read it later — verifying is a
    // separate call from starting a scan, so the pass/fail has to outlive this one request.
    const record: VerificationRecord = { at: new Date().toISOString(), mappingsHash: stamp, jellyfin, qbit }
    writeVerification(deps.db, record)
    return reply.send({ ...record, current: true })
  })

  app.post('/api/pathmap/detect', guard, async (req, reply) => {
    const parsed = detectSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'mountRoots is required' })
    const found = await autoDetectMappings({ mountRoots: parsed.data.mountRoots, sampleItems })
    // With nothing proposed there is no root to place a torrent against, and no instance is asked
    // for its list (see autoDetectQbitMappings).
    const owners = new Map(
      (await autoDetectQbitMappings({ mappings: found, instances: sampleSources() })).map((p) => [p.container, p]),
    )
    return reply.send({
      proposals: found.map((mapping) => {
        const owner = owners.get(mapping.container)
        return owner === undefined ? mapping : { ...mapping, qbit: owner.qbit, qbitInstance: owner.qbitInstance }
      }),
    })
  })

  /**
   * One call per instance at a time. A client's requests share a rate-limited gate with everything
   * else that talks to that instance (a plan deleting torrents among it), so a screen polling while
   * a box is hung must not queue a fresh call behind the last one every time: a request that
   * arrives while the previous call is still unanswered joins it, even if the previous request
   * already stopped waiting.
   */
  const inFlight = new Map<string, Promise<unknown>>()
  function shared<T>(key: string, start: () => Promise<T>): Promise<T> {
    const running = inFlight.get(key) as Promise<T> | undefined
    if (running !== undefined) return running
    const call = (async () => start())().finally(() => { inFlight.delete(key) })
    inFlight.set(key, call)
    return call
  }

  async function probe(config: QbitInstanceConfig): Promise<QbitInstanceStatus> {
    const url = displayUrl(config.url)
    const client = deps.qbittorrents.get(config.id)
    if (client === undefined) {
      return { id: config.id, url, reachable: false, version: null, error: 'no qBittorrent client is configured for this instance', torrentCount: null }
    }
    const budget = deps.probeTimeoutMs ?? QBIT_PROBE_TIMEOUT_MS
    const pinged = await settleWithin(shared(`ping:${config.id}`, () => client.ping()), budget)
    // An instance that could not answer a ping is not asked for its whole torrent list as well.
    // That second call would fail the same way, and where the failure is a rejected login it is a
    // second login attempt: qBittorrent bans an address after five.
    if (!pinged.ok) return { id: config.id, url, reachable: false, version: null, error: pinged.error, torrentCount: null }
    const listed = await settleWithin(shared(`torrents:${config.id}`, async () => (await client.torrents()).length), budget)
    return {
      id: config.id, url, reachable: true, version: pinged.value.version, error: null,
      torrentCount: listed.ok ? listed.value : null,
    }
  }

  app.get('/api/qbit/instances', guard, async (_req, reply) =>
    reply.send({ instances: await Promise.all(deps.configStore.env.qbittorrents.map(probe)) }))
}
