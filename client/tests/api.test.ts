import { describe, it, expect, vi, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { createApi, ApiError } from '../src/api.js'

/**
 * Adapts a real Fastify instance's `inject` to the `fetch` signature `createApi` expects, so this
 * suite can prove requests are shaped in a way the ACTUAL server accepts — not just in a way a
 * hand-rolled `Response` mock accepts. Fastify's own body parsing runs here, which is exactly the
 * layer a plain mocked `fetch` cannot exercise.
 */
function fastifyFetch(app: FastifyInstance): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const res = await app.inject({
      method: (init?.method as 'GET' | 'POST' | 'PUT') ?? 'GET',
      url: String(url),
      headers: init?.headers as Record<string, string> | undefined,
      payload: init?.body as string | undefined,
    })
    // A 204 must reach `createApi` exactly as a browser delivers it — with a null body. undici's
    // Response constructor refuses ANY body (even '') on a null-body status, so pass null there.
    return new Response(res.statusCode === 204 ? null : res.body, { status: res.statusCode })
  }) as unknown as typeof fetch
}

const api = (impl: typeof fetch) => createApi({ baseUrl: '', fetchImpl: impl })
afterEach(() => vi.restoreAllMocks())

describe('api', () => {
  it('sends credentials so the session cookie travels', async () => {
    let init: RequestInit | undefined
    const f = (async (_u: string, i?: RequestInit) => { init = i; return new Response('{}', { status: 200 }) }) as unknown as typeof fetch
    await api(f).me()
    expect(init?.credentials).toBe('include')
  })

  it('throws ApiError carrying the status and the server message', async () => {
    const f = (async () => new Response(JSON.stringify({ error: 'not authenticated' }), { status: 401 })) as unknown as typeof fetch
    const err = await api(f).me().catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(401)
    expect(err.message).toBe('not authenticated')
  })

  it('posts the login body as JSON', async () => {
    let body = ''
    const f = (async (_u: string, i?: RequestInit) => { body = String(i?.body); return new Response('{}', { status: 200 }) }) as unknown as typeof fetch
    await api(f).login('bob', 'pw')
    expect(JSON.parse(body)).toEqual({ username: 'bob', password: 'pw' })
  })

  it('serialises finding filters into the query string', async () => {
    let url = ''
    const f = (async (u: string) => { url = String(u); return new Response('{"findings":[],"total":0}', { status: 200 }) }) as unknown as typeof fetch
    await api(f).findings({ class: 'duplicate', limit: 25, offset: 50 })
    expect(url).toContain('class=duplicate')
    expect(url).toContain('limit=25')
    expect(url).toContain('offset=50')
  })

  it('omits undefined filters rather than sending the string "undefined"', async () => {
    let url = ''
    const f = (async (u: string) => { url = String(u); return new Response('{"findings":[],"total":0}', { status: 200 }) }) as unknown as typeof fetch
    await api(f).findings({ class: undefined, limit: 10 })
    expect(url).not.toContain('undefined')
  })

  it('carries the 412 status on a scan start refused for an unverified path map', async () => {
    const f = (async () => new Response(JSON.stringify({ error: 'path map is not verified', forcible: true }), { status: 412 })) as unknown as typeof fetch
    const err = await api(f).scanStart().catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(412)
    expect(err.message).toBe('path map is not verified')
  })

  it('posts scanStart options as JSON without a literal "undefined" for the omitted field', async () => {
    let body = ''
    const f = (async (_u: string, i?: RequestInit) => { body = String(i?.body); return new Response('{"scanId":1}', { status: 202 }) }) as unknown as typeof fetch
    await api(f).scanStart({ force: true })
    expect(JSON.parse(body)).toEqual({ force: true })
    expect(body).not.toContain('undefined')
  })

  it('posts to the resume route for a plan stuck running after a crash', async () => {
    let url = ''
    const f = (async (u: string) => { url = String(u); return new Response('{"planId":"p1","status":"completed","done":1,"failed":0,"skipped":0,"blocked":0,"bytesFreed":0}', { status: 200 }) }) as unknown as typeof fetch
    await api(f).resumePlan('p1')
    expect(url).toBe('/api/plans/p1/resume')
  })

  it('reads findingsSummary basedOn/latestAttempt so a dead newer scan cannot masquerade as a clean pass', async () => {
    const f = (async () => new Response(JSON.stringify({
      evaluated: true,
      basedOn: { scanId: 41, status: 'completed', finishedAt: 'T' },
      latestAttempt: { scanId: 42, status: 'failed' },
      byClass: {}, reclaimableBytes: 0, notEvaluated: [],
    }), { status: 200 })) as unknown as typeof fetch
    const summary = await api(f).findingsSummary()
    expect(summary.basedOn?.scanId).toBe(41)
    expect(summary.latestAttempt?.scanId).toBe(42)
  })

  describe('against a real Fastify instance', () => {
    // Fastify's JSON content-type parser 400s a request that DECLARES 'application/json' but
    // sends no body at all (FST_ERR_CTP_EMPTY_JSON_BODY) — confirmed against this project's own
    // Fastify version. Most of this module's POSTs (logout, scanCancel, approvePlan, executePlan,
    // resumePlan, mergeGroup, reopenFinding, pathmapVerify, restoreTrash) carry no body, so a
    // client that always attaches Content-Type would 400 every one of them for real while still
    // passing a suite that only ever mocks `fetch` directly.
    function bodylessPostApp() {
      const app = Fastify()
      app.post('/api/auth/logout', async (_req, reply) => reply.send({ ok: true }))
      app.post('/api/scan/cancel', async (_req, reply) => reply.send({ cancelled: true }))
      return app
    }

    it('logs out without tripping the empty-json-body guard', async () => {
      const res = await api(fastifyFetch(bodylessPostApp())).logout()
      expect(res).toEqual({ ok: true })
    })

    it('cancels a scan without tripping the empty-json-body guard', async () => {
      const res = await api(fastifyFetch(bodylessPostApp())).scanCancel()
      expect(res).toEqual({ cancelled: true })
    })
  })

  describe('trash', () => {
    // Finding 4: GET /api/trash grew limit/offset/includeRestored query params and a `total` in
    // its response. `trash()` must keep working with zero arguments — every existing caller — and
    // only add a query string when the caller actually asks for pagination.
    it('requests the bare route with no query string when called with no arguments', async () => {
      let url = ''
      const f = (async (u: string) => { url = String(u); return new Response('{"entries":[],"total":0}', { status: 200 }) }) as unknown as typeof fetch
      await api(f).trash()
      expect(url).toBe('/api/trash')
    })

    it('serialises limit/offset/includeRestored into the query string, including the boolean', async () => {
      let url = ''
      const f = (async (u: string) => { url = String(u); return new Response('{"entries":[],"total":0}', { status: 200 }) }) as unknown as typeof fetch
      await api(f).trash({ limit: 10, offset: 20, includeRestored: false })
      expect(url).toContain('limit=10')
      expect(url).toContain('offset=20')
      expect(url).toContain('includeRestored=false')
    })

    it('resolves the total alongside the entries', async () => {
      const f = (async () => new Response('{"entries":[],"total":42}', { status: 200 })) as unknown as typeof fetch
      const result = await api(f).trash()
      expect(result.total).toBe(42)
    })
  })

  describe('duplicates', () => {
    // C12's DuplicatesResponse. createApi does not reshape response bodies, so the point of this
    // test is to pin the wire shape the client contract promises (camelCase members, per-member
    // torrent facts, the evaluated/scan provenance), not to exercise any transformation logic.
    it('passes the C12 duplicates shape through untouched', async () => {
      const f = (async () => new Response(JSON.stringify({
        evaluated: true, reason: null, scanId: 7, scanFinishedAt: 'T',
        groups: [{
          id: 'g1', tier: 'exact', keeperItemId: 'b', keeperPolicy: 'best-quality', scores: {}, matchedBy: ['dupe.provider-id'],
          title: 'Heat', year: 1995, kind: 'movie', seriesName: null, seasonNo: null, episodeNo: null,
          editionsDiffer: false, multiEpisode: false, crossInstance: true, reclaimableBytes: 10,
          members: [{
            id: 'a', name: 'Heat', videoRange: 'SDR', hasSubtitles: false, instanceId: 'box-a', torrentCount: 1,
            torrent: { instanceId: 'box-a', hash: 'h', name: 'Heat.1995', state: 'uploading', ratio: 2, seedingDays: 30, isPrivate: true, trackerHost: null, sizeBytes: 10, fileCount: 3, mediaFileCount: 1, hnrMet: true },
          }],
        }],
      }), { status: 200 })) as unknown as typeof fetch
      const res = await api(f).duplicates()
      expect(res.scanId).toBe(7)
      expect(res.groups[0]!.matchedBy).toEqual(['dupe.provider-id'])
      expect(res.groups[0]!.crossInstance).toBe(true)
      expect(res.groups[0]!.members[0]!.videoRange).toBe('SDR')
      expect(res.groups[0]!.members[0]!.torrent?.hnrMet).toBe(true)
    })
  })

  // --- Plan 7 / C12 routes --------------------------------------------------------------------
  describe('real-stack routes', () => {
    it('dismisses a duplicate group with its reason and accepts the 204 empty body', async () => {
      let received: unknown
      const app = Fastify()
      app.post('/api/duplicates/:groupId/dismiss', async (req, reply) => {
        received = { params: req.params, body: req.body }
        return reply.code(204).send()
      })
      await expect(api(fastifyFetch(app)).dismissDuplicate('g1', 'same release twice')).resolves.toBeUndefined()
      expect(received).toEqual({ params: { groupId: 'g1' }, body: { reason: 'same release twice' } })
    })

    it('dismisses without a reason as an empty JSON object, never a literal "undefined"', async () => {
      let received: unknown
      const app = Fastify()
      app.post('/api/duplicates/:groupId/dismiss', async (req, reply) => {
        received = req.body
        return reply.code(204).send()
      })
      await api(fastifyFetch(app)).dismissDuplicate('g1')
      expect(received).toEqual({})
    })

    it('reopens a duplicate group with a bodyless POST that survives the empty-json-body guard', async () => {
      const app = Fastify()
      app.post('/api/duplicates/:groupId/reopen', async (_req, reply) => reply.code(204).send())
      await expect(api(fastifyFetch(app)).reopenDuplicate('g1')).resolves.toBeUndefined()
    })

    it('reads the 202 body of an execute that now runs in the background', async () => {
      let url = ''
      const f = (async (u: string) => {
        url = String(u)
        return new Response(JSON.stringify({ planId: 'p1', status: 'running' }), { status: 202 })
      }) as unknown as typeof fetch
      expect(await api(f).executePlan('p1')).toEqual({ planId: 'p1', status: 'running' })
      expect(url).toBe('/api/plans/p1/execute')
    })

    it('lists the qBittorrent instances', async () => {
      let url = ''
      const body = { instances: [{ id: 'box-a', url: 'http://198.51.100.10:8080/', reachable: true, version: 'v5.2.2', error: null, torrentCount: 12 }] }
      const f = (async (u: string) => { url = String(u); return new Response(JSON.stringify(body), { status: 200 }) }) as unknown as typeof fetch
      expect(await api(f).qbitInstances()).toEqual(body)
      expect(url).toBe('/api/qbit/instances')
    })

    it('reads settings and saves a partial patch with a PUT the real server parses', async () => {
      let received: unknown
      const view = {
        guards: { minRatio: 1.5, minSeedTimeDays: 14, protectedCategories: [], protectedTags: [], privateTrackerHosts: [] },
        keeper: { policy: 'smallest' }, trash: { maxBytes: 1, retentionDays: 30 },
      }
      const app = Fastify()
      app.get('/api/config/settings', async (_req, reply) => reply.send(view))
      app.put('/api/config/settings', async (req, reply) => { received = req.body; return reply.send(view) })
      const client = api(fastifyFetch(app))
      expect(await client.settings()).toEqual(view)
      expect(await client.saveSettings({ guards: { minRatio: 1.5 }, keeper: { policy: 'smallest' } })).toEqual(view)
      expect(received).toEqual({ guards: { minRatio: 1.5 }, keeper: { policy: 'smallest' } })
    })

    it('pages the explorer with offset and limit in the query string', async () => {
      let url = ''
      const f = (async (u: string) => {
        url = String(u)
        return new Response('{"path":"/movies","parent":null,"entries":[],"total":0,"offset":500,"limit":500}', { status: 200 })
      }) as unknown as typeof fetch
      await api(f).explorer('/movies', { offset: 500, limit: 500 })
      const query = new URLSearchParams(url.split('?')[1])
      expect(query.get('path')).toBe('/movies')
      expect(query.get('offset')).toBe('500')
      expect(query.get('limit')).toBe('500')
    })

    it('reads auto-detect proposals under the C12 key', async () => {
      const proposals = [{ role: 'library', jellyfin: '/media/movies', container: '/movies', qbit: '/movies', qbitInstance: 'box-b' }]
      const f = (async () => new Response(JSON.stringify({ proposals }), { status: 200 })) as unknown as typeof fetch
      expect((await api(f).pathmapDetect(['/movies'])).proposals).toEqual(proposals)
    })

    it('uses the server reason as the error message when one is given, and keeps the body', async () => {
      const f = (async () => new Response(JSON.stringify({ error: 'busy', reason: 'scan 12 is running' }), { status: 409 })) as unknown as typeof fetch
      const err = await api(f).createPlan([{ type: 'delete-media', targetPath: '/movies/x.mkv' }]).catch((e) => e)
      expect(err).toBeInstanceOf(ApiError)
      expect(err.status).toBe(409)
      expect(err.message).toBe('scan 12 is running')
      expect(err.body).toEqual({ error: 'busy', reason: 'scan 12 is running' })
    })

    it('shows why a scan start was refused as busy — the holder, not the bare word (Ruling 14)', async () => {
      const reason = 'plan p1 is running; scans and plan runs never overlap, so start the scan once it has finished'
      const f = (async () => new Response(JSON.stringify({ error: 'busy', reason }), { status: 409 })) as unknown as typeof fetch
      const err = await api(f).scanStart().catch((e) => e)
      expect(err).toBeInstanceOf(ApiError)
      expect(err.status).toBe(409)
      expect(err.message).toBe(reason)
    })
  })

  describe('restoreTrash', () => {
    // src/api/plans.ts sends restoreFromTrash's own refusal — { restored: false, reason } — on a
    // 409, with no `error` key at all (unlike every other route's failure shape). A generic
    // post()-based wrapper would throw ApiError(409, 'HTTP 409') here and the caller would never
    // learn the file was already gone; restoreTrash must resolve instead.
    it('resolves with the reason on a 409 refusal rather than throwing', async () => {
      const f = (async () => new Response(JSON.stringify({ restored: false, reason: 'trashed file is gone' }), { status: 409 })) as unknown as typeof fetch
      const result = await api(f).restoreTrash('t1')
      expect(result).toEqual({ restored: false, reason: 'trashed file is gone' })
    })

    it('resolves true on a successful restore', async () => {
      const f = (async () => new Response(JSON.stringify({ restored: true }), { status: 200 })) as unknown as typeof fetch
      const result = await api(f).restoreTrash('t1')
      expect(result).toEqual({ restored: true })
    })

    it('still throws for a genuine auth failure', async () => {
      const f = (async () => new Response(JSON.stringify({ error: 'not authenticated' }), { status: 401 })) as unknown as typeof fetch
      const err = await api(f).restoreTrash('t1').catch((e) => e)
      expect(err).toBeInstanceOf(ApiError)
      expect(err.status).toBe(401)
    })
  })
})
