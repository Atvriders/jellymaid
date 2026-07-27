import { describe, it, expect, vi } from 'vitest'
import { HttpClient, ConnectorError } from '../../src/connectors/http.js'

const client = (fetchImpl: typeof fetch, over: Partial<ConstructorParameters<typeof HttpClient>[0]> = {}) =>
  new HttpClient({
    service: 'test', baseUrl: 'http://x', fetchImpl,
    concurrency: 2, minDelayMs: 0, maxRetries: 2, backoffBaseMs: 1, timeoutMs: 50,
    ...over,
  })

describe('HttpClient', () => {
  it('returns parsed JSON on success', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 }))
    await expect(client(f as unknown as typeof fetch).request('/a')).resolves.toEqual({ ok: 1 })
  })

  it('retries 5xx and succeeds on a later attempt', async () => {
    let n = 0
    const f = vi.fn(async () => {
      n += 1
      return n < 3 ? new Response('boom', { status: 503 }) : new Response('{"ok":2}', { status: 200 })
    })
    await expect(client(f as unknown as typeof fetch).request('/a')).resolves.toEqual({ ok: 2 })
    expect(n).toBe(3)
  })

  it('does NOT retry a POST — a replayed non-idempotent request is worse than a failed one', async () => {
    const f = vi.fn(async () => new Response('boom', { status: 503 }))
    const err = (await client(f as unknown as typeof fetch)
      .request('/a', { method: 'POST' }).catch((e) => e)) as ConnectorError
    expect(err).toBeInstanceOf(ConnectorError)
    expect(err.kind).toBe('unreachable')
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('does NOT replay a timed-out POST — a timeout is not evidence the request did not land', async () => {
    const f = vi.fn((_u: string, init?: RequestInit) => new Promise<Response>((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))
    }))
    const err = (await client(f as unknown as typeof fetch)
      .request('/a', { method: 'POST' }).catch((e) => e)) as ConnectorError
    expect(err.kind).toBe('timeout')
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('retries a POST when the caller explicitly opts in', async () => {
    let n = 0
    const f = vi.fn(async () => (++n < 2 ? new Response('boom', { status: 503 }) : new Response('{}', { status: 200 })))
    await expect(client(f as unknown as typeof fetch).request('/a', { method: 'POST', retry: true })).resolves.toEqual({})
    expect(n).toBe(2)
  })

  it('still retries the idempotent methods on a 503', async () => {
    for (const method of [undefined, 'GET', 'HEAD', 'PUT', 'DELETE']) {
      const f = vi.fn(async () => new Response('boom', { status: 503 }))
      await client(f as unknown as typeof fetch).request('/a', method ? { method } : {}).catch(() => undefined)
      expect(f, `method ${method ?? '(default GET)'} should retry`).toHaveBeenCalledTimes(3)
    }
  })

  it('does NOT retry a 401 — auth failures are permanent', async () => {
    const f = vi.fn(async () => new Response('nope', { status: 401 }))
    const err = (await client(f as unknown as typeof fetch).request('/a').catch((e) => e)) as ConnectorError
    expect(err).toBeInstanceOf(ConnectorError)
    expect(err.kind).toBe('auth')
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('classifies 429 as rate-limited and retries it', async () => {
    let n = 0
    const f = vi.fn(async () => (++n < 2 ? new Response('', { status: 429 }) : new Response('{}', { status: 200 })))
    await expect(client(f as unknown as typeof fetch).request('/a')).resolves.toEqual({})
    expect(n).toBe(2)
  })

  it('classifies a network throw as unreachable after exhausting retries', async () => {
    const f = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    const err = (await client(f as unknown as typeof fetch).request('/a').catch((e) => e)) as ConnectorError
    expect(err.kind).toBe('unreachable')
    expect(f).toHaveBeenCalledTimes(3)
  })

  it('classifies unparseable JSON as bad-response without retrying', async () => {
    const f = vi.fn(async () => new Response('<html>', { status: 200 }))
    const err = (await client(f as unknown as typeof fetch).request('/a').catch((e) => e)) as ConnectorError
    expect(err.kind).toBe('bad-response')
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('never exceeds the configured concurrency', async () => {
    let inFlight = 0
    let peak = 0
    const f = vi.fn(async () => {
      inFlight += 1; peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight -= 1
      return new Response('{}', { status: 200 })
    })
    const c = client(f as unknown as typeof fetch)
    await Promise.all(Array.from({ length: 10 }, () => c.request('/a')))
    expect(peak).toBeLessThanOrEqual(2)
  })

  it('times out a hung request', async () => {
    const f = vi.fn((_u: string, init?: RequestInit) => new Promise<Response>((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))
    }))
    const err = (await client(f as unknown as typeof fetch, { maxRetries: 0 }).request('/a').catch((e) => e)) as ConnectorError
    expect(err.kind).toBe('timeout')
  })

  it("parse: 'none' returns undefined and does not throw on an empty 200 body", async () => {
    const f = vi.fn(async () => new Response('', { status: 200 }))
    await expect(client(f as unknown as typeof fetch).request('/a', {}, 'none')).resolves.toBeUndefined()
  })

  it("parse: 'text' returns the raw body string", async () => {
    const f = vi.fn(async () => new Response('hello world', { status: 200 }))
    await expect(client(f as unknown as typeof fetch).request('/a', {}, 'text')).resolves.toBe('hello world')
  })

  it('invokes onResponse with the real Response before any status branching', async () => {
    const f = vi.fn(async () => new Response('{"ok":1}', { status: 200, headers: { 'x-test': 'yes' } }))
    let seen: Response | null = null
    await client(f as unknown as typeof fetch).request('/a', { onResponse: (res) => { seen = res } })
    expect(seen).not.toBeNull()
    expect(seen!.status).toBe(200)
    expect(seen!.headers.get('x-test')).toBe('yes')
  })

  it('does not forward onResponse to fetchImpl', async () => {
    let sawOnResponse = false
    const f = vi.fn(async (_u: string, init?: RequestInit) => {
      sawOnResponse = 'onResponse' in (init ?? {})
      return new Response('{}', { status: 200 })
    })
    await client(f as unknown as typeof fetch).request('/a', { onResponse: () => undefined })
    expect(sawOnResponse).toBe(false)
  })

  it('honours minDelayMs between every request start, even under concurrency > 1', async () => {
    const starts: number[] = []
    const f = vi.fn(async () => {
      starts.push(Date.now())
      return new Response('{}', { status: 200 })
    })
    const c = client(f as unknown as typeof fetch, { concurrency: 2, minDelayMs: 20 })
    await Promise.all(Array.from({ length: 4 }, () => c.request('/a')))
    const sorted = [...starts].sort((a, b) => a - b)
    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(15)
    }
  })
})
