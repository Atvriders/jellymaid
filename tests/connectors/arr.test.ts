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

  it('reports not-found rather than throwing when the path is unknown', async () => {
    const f = stub({
      '/api/v3/series': [{ id: 9, title: 'Show', monitored: true, path: '/tv/Show' }],
      '/api/v3/episodefile': [{ id: 77, seriesId: 9, path: '/tv/Show/S01E01.mkv' }],
      '/api/v3/episode': [{ id: 500, seriesId: 9, episodeFileId: 77, monitored: true, title: 'Pilot' }],
    })
    await expect(createSonarrClient(base(f)).unmonitorByPath('/nope.mkv'))
      .resolves.toEqual({ unmonitored: false, recordId: null })
  })

  it('isolates a per-series failure so unrelated series still return records', async () => {
    // Series 9's /episodefile call fails outright (HTTP 400 → thrown immediately, no retry).
    // A flaky series must not blank out the whole library: unmonitoring (and therefore
    // deletion) of every unrelated file would otherwise be blocked by one bad series.
    const f = (async (url: string | URL) => {
      const u = String(url)
      if (u.includes('/api/v3/series')) {
        return new Response(JSON.stringify([
          { id: 9, title: 'Broken', monitored: true, path: '/tv/Broken' },
          { id: 10, title: 'Show', monitored: true, path: '/tv/Show' },
        ]), { status: 200 })
      }
      if (u.includes('seriesId=9')) return new Response('boom', { status: 400 })
      if (u.includes('/api/v3/episodefile')) {
        return new Response(JSON.stringify([{ id: 77, seriesId: 10, path: '/tv/Show/S01E01.mkv' }]), { status: 200 })
      }
      if (u.includes('/api/v3/episode')) {
        return new Response(JSON.stringify([{ id: 500, seriesId: 10, episodeFileId: 77, monitored: true, title: 'Pilot' }]), { status: 200 })
      }
      return new Response('nf', { status: 404 })
    }) as unknown as typeof fetch

    const recs = await createSonarrClient(base(f)).inventory()
    expect(recs).toHaveLength(1)
    expect(recs[0]).toMatchObject({ seriesId: 10, arrPath: '/tv/Show/S01E01.mkv' })
    expect(recs.some((r) => r.seriesId === 9)).toBe(false)
  })
})

describe('safety', () => {
  // This is the enforcement point for a hard product constraint — Jellymaid unmonitors and
  // nothing else, never deleting a movie/series/file or blocklisting a release — so it is
  // deliberately stricter than a single `method: 'DELETE'` literal check, which is trivially
  // bypassed by double quotes, a template literal, lowercase 'delete' (fetch uppercases the
  // method for you), or any other indirection.
  it('the source contains no delete or blocklist call', () => {
    const src = readFileSync(new URL('../../src/connectors/arr.ts', import.meta.url), 'utf8')
    // Strip comments first — this file's own explanatory prose is allowed to say "delete"
    // (e.g. explaining why something is NOT a delete); only executable source is banned below.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

    expect(code).not.toMatch(/\bdelete\b/i)
    expect(src.toLowerCase()).not.toContain('blocklist')
    expect(src.toLowerCase()).not.toContain('blacklist')
    expect(src.toLowerCase()).not.toContain('deletefiles')

    // Enumerate every HTTP method literal actually used, however it's quoted, and require each
    // one to be PUT — GET is the implicit default and is never spelled out in this file. This
    // catches a DELETE (or anything else) introduced under a spelling the word-ban above
    // wouldn't anticipate.
    const methodKeywords = code.match(/\bmethod\s*:/g) ?? []
    const quotedMethods = [...code.matchAll(/method\s*:\s*['"`]([a-zA-Z]+)['"`]/g)].map((m) => m[1]!.toUpperCase())
    // Every `method:` must resolve to a literal right there — a `method:` whose value comes from
    // a variable or expression (e.g. an assembled string) would dodge the literal scan above.
    expect(methodKeywords.length).toBe(quotedMethods.length)
    expect(quotedMethods.length).toBeGreaterThan(0)
    for (const method of quotedMethods) expect(method).toBe('PUT')
  })
})
