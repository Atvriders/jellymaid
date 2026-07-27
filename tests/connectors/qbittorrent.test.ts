import { describe, it, expect, vi } from 'vitest'
import { createQbitClient } from '../../src/connectors/qbittorrent.js'

function stub(routes: Record<string, unknown>, spy?: (url: string, init?: RequestInit) => void) {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    spy?.(u, init)
    if (u.includes('/auth/login')) return new Response('Ok.', { status: 200, headers: { 'set-cookie': 'SID=abc; path=/' } })
    const key = Object.keys(routes).find((k) => u.includes(k))
    if (!key) return new Response('nf', { status: 404 })
    const body = routes[key]
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 })
  }) as unknown as typeof fetch
}

const client = (f: typeof fetch, privateHosts: string[] = []) => createQbitClient({
  url: 'http://qb:8080', user: 'u', pass: 'p',
  concurrency: 2, minDelayMs: 0, privateTrackerHosts: privateHosts, fetchImpl: f,
})

const RAW = [{
  hash: 'H1', name: 'Heat.1995.mkv', save_path: '/downloads/movies',
  content_path: '/downloads/movies/Heat.1995.mkv', category: 'movies', tags: 'keep, hd',
  state: 'stalledUP', ratio: 2.4, seeding_time: 1_209_600, size: 1000, progress: 1,
  tracker: 'http://tracker.private.example/announce',
}]

describe('torrents', () => {
  it('normalizes fields and splits tags', async () => {
    const t = (await client(stub({ '/torrents/info': RAW })).torrents())[0]!
    expect(t).toMatchObject({
      hash: 'H1', savePath: '/downloads/movies', contentPath: '/downloads/movies/Heat.1995.mkv',
      category: 'movies', state: 'stalledUP', ratio: 2.4, seedingTimeSeconds: 1_209_600,
      sizeBytes: 1000, trackerHost: 'tracker.private.example',
    })
    expect(t.tags).toEqual(['keep', 'hd'])
  })

  it('uses the private flag when the qBittorrent version reports it', async () => {
    const t = (await client(stub({ '/torrents/info': [{ ...RAW[0], private: true }] })).torrents())[0]!
    expect(t.isPrivate).toBe(true)
  })

  it('falls back to the configured private-host list', async () => {
    const t = (await client(stub({ '/torrents/info': RAW }), ['tracker.private.example']).torrents())[0]!
    expect(t.isPrivate).toBe(true)
  })

  it('treats unknown privacy as private — fail safe', async () => {
    const raw = [{ ...RAW[0], tracker: '' }]
    const t = (await client(stub({ '/torrents/info': raw })).torrents())[0]!
    expect(t.isPrivate).toBe(true)
  })

  it('treats a known public tracker as public', async () => {
    const raw = [{ ...RAW[0], tracker: 'http://tracker.opentrackr.org:1337/announce', private: false }]
    const t = (await client(stub({ '/torrents/info': raw })).torrents())[0]!
    expect(t.isPrivate).toBe(false)
  })

  it('logs in once and reuses the SID cookie', async () => {
    const urls: string[] = []
    const c = client(stub({ '/torrents/info': RAW }, (u) => urls.push(u)))
    await c.torrents(); await c.torrents()
    expect(urls.filter((u) => u.includes('/auth/login'))).toHaveLength(1)
  })

  it('re-logins after a 403 and retries the call', async () => {
    let logins = 0; let infoCalls = 0
    const f = (async (url: string | URL) => {
      const u = String(url)
      if (u.includes('/auth/login')) { logins += 1; return new Response('Ok.', { status: 200, headers: { 'set-cookie': 'SID=z' } }) }
      infoCalls += 1
      return infoCalls === 1 ? new Response('', { status: 403 }) : new Response(JSON.stringify(RAW), { status: 200 })
    }) as unknown as typeof fetch
    const t = await client(f).torrents()
    expect(logins).toBe(2)
    expect(t).toHaveLength(1)
  })
})

describe('files', () => {
  it('normalizes the file list', async () => {
    const files = await client(stub({ '/torrents/files': [{ index: 0, name: 'Heat/Heat.mkv', size: 900 }] })).files('H1')
    expect(files[0]).toEqual({ index: 0, relPath: 'Heat/Heat.mkv', sizeBytes: 900 })
  })
})

describe('deleteWithData', () => {
  it('posts deleteFiles=true with the joined hashes', async () => {
    let body = ''
    const f = stub({ '/torrents/delete': 'Ok.' }, (_u, init) => { body = String(init?.body) })
    await client(f).deleteWithData(['H1', 'H2'])
    expect(body).toContain('hashes=H1%7CH2')
    expect(body).toContain('deleteFiles=true')
  })

  it('refuses an empty hash list rather than issuing a wildcard delete', async () => {
    await expect(client(stub({})).deleteWithData([])).rejects.toThrow(/no torrent hashes/i)
  })
})

describe('awaitGone', () => {
  it('returns true once the hashes disappear', async () => {
    let calls = 0
    const f = (async (url: string | URL) => {
      const u = String(url)
      if (u.includes('/auth/login')) return new Response('Ok.', { status: 200, headers: { 'set-cookie': 'SID=z' } })
      calls += 1
      return new Response(JSON.stringify(calls < 2 ? RAW : []), { status: 200 })
    }) as unknown as typeof fetch
    await expect(client(f).awaitGone(['H1'], { timeoutMs: 500, pollMs: 1 })).resolves.toBe(true)
  })

  it('returns false when the torrent is still present at timeout', async () => {
    await expect(client(stub({ '/torrents/info': RAW })).awaitGone(['H1'], { timeoutMs: 20, pollMs: 5 }))
      .resolves.toBe(false)
  })
})
