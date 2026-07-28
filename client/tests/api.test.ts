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
    return new Response(res.body, { status: res.statusCode })
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
