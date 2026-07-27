import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRadarrClient, createSonarrClient } from '../../src/connectors/arr.js'

function stub(routes: Record<string, unknown>, spy?: (url: string, init?: RequestInit) => void) {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    spy?.(u, init)
    const key = Object.keys(routes).find((k) => u.includes(k))
    if (!key) return new Response('nf', { status: 404 })
    return new Response(JSON.stringify(routes[key]), { status: 200 })
  }) as unknown as typeof fetch
}

const base = (f: typeof fetch) => ({ url: 'http://arr', apiKey: 'K', concurrency: 2, minDelayMs: 0, fetchImpl: f })

describe('radarr', () => {
  it('maps movies to records including the file path', async () => {
    const f = stub({ '/api/v3/movie': [
      { id: 5, title: 'Heat', monitored: true, path: '/movies/Heat', movieFile: { path: '/movies/Heat/Heat.mkv' } },
    ] })
    const recs = await createRadarrClient(base(f)).inventory()
    expect(recs[0]).toMatchObject({ kind: 'radarr', remoteId: 5, title: 'Heat', arrPath: '/movies/Heat/Heat.mkv', monitored: true })
  })

  it('sends the api key header', async () => {
    let headers: Record<string, string> = {}
    const f = stub({ '/api/v3/movie': [] }, (_u, init) => { headers = init!.headers as Record<string, string> })
    await createRadarrClient(base(f)).inventory()
    expect(headers['X-Api-Key']).toBe('K')
  })

  it('unmonitors by path with a PUT that only flips monitored', async () => {
    let method = ''; let body: Record<string, unknown> = {}
    const f = stub({
      '/api/v3/movie': [{ id: 5, title: 'Heat', monitored: true, path: '/movies/Heat', movieFile: { path: '/movies/Heat/Heat.mkv' } }],
    }, (u, init) => { if (u.includes('/movie/5')) { method = init!.method!; body = JSON.parse(String(init!.body)) } })
    const res = await createRadarrClient(base(f)).unmonitorByPath('/movies/Heat/Heat.mkv')
    expect(res).toEqual({ unmonitored: true, recordId: 5 })
    expect(method).toBe('PUT')
    expect(body.monitored).toBe(false)
    expect(body.id).toBe(5)
  })

  it('reports not-found rather than throwing when the path is unknown', async () => {
    const f = stub({ '/api/v3/movie': [] })
    await expect(createRadarrClient(base(f)).unmonitorByPath('/nope.mkv'))
      .resolves.toEqual({ unmonitored: false, recordId: null })
  })
})

describe('sonarr', () => {
  it('maps episode files to records carrying seriesId and episodeId', async () => {
    const f = stub({
      '/api/v3/series': [{ id: 9, title: 'Show', monitored: true, path: '/tv/Show' }],
      '/api/v3/episodefile': [{ id: 77, seriesId: 9, path: '/tv/Show/S01E01.mkv' }],
      '/api/v3/episode': [{ id: 500, seriesId: 9, episodeFileId: 77, monitored: true, title: 'Pilot' }],
    })
    const recs = await createSonarrClient(base(f)).inventory()
    expect(recs.find((r) => r.arrPath === '/tv/Show/S01E01.mkv')).toMatchObject({
      kind: 'sonarr', seriesId: 9, episodeId: 500, episodeFileId: 77,
    })
  })

  it('unmonitors via the episode monitor endpoint', async () => {
    let url = ''; let body: Record<string, unknown> = {}
    const f = stub({
      '/api/v3/series': [{ id: 9, title: 'Show', monitored: true, path: '/tv/Show' }],
      '/api/v3/episodefile': [{ id: 77, seriesId: 9, path: '/tv/Show/S01E01.mkv' }],
      '/api/v3/episode': [{ id: 500, seriesId: 9, episodeFileId: 77, monitored: true, title: 'Pilot' }],
    }, (u, init) => { if (u.includes('/episode/monitor')) { url = u; body = JSON.parse(String(init!.body)) } })
    const res = await createSonarrClient(base(f)).unmonitorByPath('/tv/Show/S01E01.mkv')
    expect(res.unmonitored).toBe(true)
    expect(url).toContain('/api/v3/episode/monitor')
    expect(body).toEqual({ episodeIds: [500], monitored: false })
  })
})

describe('safety', () => {
  it('the source contains no delete or blocklist call', () => {
    const src = readFileSync(new URL('../../src/connectors/arr.ts', import.meta.url), 'utf8')
    expect(src).not.toMatch(/method:\s*'DELETE'/)
    expect(src.toLowerCase()).not.toContain('blocklist')
    expect(src.toLowerCase()).not.toContain('blacklist')
    expect(src).not.toMatch(/deleteFiles/)
  })
})
