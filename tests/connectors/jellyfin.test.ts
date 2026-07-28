import { describe, it, expect, vi } from 'vitest'
import { createJellyfinClient } from '../../src/connectors/jellyfin.js'
import { ConnectorError } from '../../src/connectors/http.js'

function stub(routes: Record<string, unknown>, spy?: (url: string, init?: RequestInit) => void) {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    spy?.(u, init)
    const key = Object.keys(routes).find((k) => u.includes(k))
    if (!key) return new Response('not found', { status: 404 })
    return new Response(JSON.stringify(routes[key]), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
}

const opts = (fetchImpl: typeof fetch) => ({
  url: 'http://jf:8096', apiKey: 'K', concurrency: 4, minDelayMs: 0, fetchImpl,
})

describe('authenticateByName', () => {
  it('sends the MediaBrowser Authorization header and the password only in the body', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = []
    const f = stub({
      '/Users/AuthenticateByName': { User: { Id: 'u1' }, AccessToken: 'T' },
      '/Users/Me': { Id: 'u1', Policy: { IsAdministrator: true } },
      '/Sessions/Logout': {},
    }, (url, init) => seen.push({ url, init }))

    const client = createJellyfinClient(opts(f))
    const res = await client.authenticateByName('bob', 'hunter2')
    expect(res).toEqual({ userId: 'u1', token: 'T', isAdministrator: true })

    const auth = seen.find((s) => s.url.includes('AuthenticateByName'))!
    const header = (auth.init!.headers as Record<string, string>)['Authorization']
    expect(header).toMatch(/^MediaBrowser Client="Jellymaid"/)
    expect(header).not.toContain('hunter2')
    expect(String(auth.init!.body)).toContain('hunter2')
  })

  it('revokes the user token before returning', async () => {
    const urls: string[] = []
    const f = stub({
      '/Users/AuthenticateByName': { User: { Id: 'u1' }, AccessToken: 'T' },
      '/Users/Me': { Id: 'u1', Policy: { IsAdministrator: false } },
      '/Sessions/Logout': {},
    }, (u) => urls.push(u))
    await createJellyfinClient(opts(f)).authenticateByName('bob', 'pw')
    expect(urls.some((u) => u.includes('/Sessions/Logout'))).toBe(true)
  })

  it('fails closed with a bad-response error (NOT auth) when the response carries no AccessToken', async () => {
    // Never reach /Users/Me on an empty token: if Jellyfin ever treated it as "no token" and
    // fell back to the service API key, /Users/Me would report the API KEY OWNER's
    // IsAdministrator and every Jellyfin user would be admitted as an admin.
    // Classified 'bad-response', not 'auth': this is a malformed reply, not a credential
    // rejection, so src/api/auth.ts's login route must not consume a lockout attempt for it.
    const urls: string[] = []
    const f = stub({
      '/Users/AuthenticateByName': { User: { Id: 'u1' } },
      '/Users/Me': { Id: 'owner', Policy: { IsAdministrator: true } },
      '/Sessions/Logout': {},
    }, (u) => urls.push(u))
    const err = await createJellyfinClient(opts(f)).authenticateByName('eve', 'pw').catch((e) => e)
    expect(err).toBeInstanceOf(ConnectorError)
    expect((err as ConnectorError).kind).toBe('bad-response')
    expect(urls.some((u) => u.includes('/Users/Me'))).toBe(false)
  })

  it('fails closed on an empty-string AccessToken too', async () => {
    const f = stub({
      '/Users/AuthenticateByName': { User: { Id: 'u1' }, AccessToken: '' },
      '/Users/Me': { Id: 'owner', Policy: { IsAdministrator: true } },
      '/Sessions/Logout': {},
    })
    const err = await createJellyfinClient(opts(f)).authenticateByName('eve', 'pw').catch((e) => e)
    expect((err as ConnectorError).kind).toBe('bad-response')
  })

  it('reports non-admins as isAdministrator false rather than throwing', async () => {
    const f = stub({
      '/Users/AuthenticateByName': { User: { Id: 'u2' }, AccessToken: 'T' },
      '/Users/Me': { Id: 'u2', Policy: { IsAdministrator: false } },
      '/Sessions/Logout': {},
    })
    const res = await createJellyfinClient(opts(f)).authenticateByName('eve', 'pw')
    expect(res.isAdministrator).toBe(false)
  })
})

describe('items', () => {
  it('normalizes a movie row including media stream details', async () => {
    const f = stub({
      '/Items': {
        TotalRecordCount: 1,
        Items: [{
          Id: 'i1', Type: 'Movie', Name: 'Heat', ProductionYear: 1995,
          Path: '/media/Movies/Heat (1995)/Heat.mkv',
          ProviderIds: { Tmdb: '949', Imdb: 'tt0113277' },
          RunTimeTicks: 106_920_000_000,
          ImageTags: { Primary: 'abc' },
          MediaSources: [{
            Id: 'ms1', Size: 12345, Container: 'mkv', Bitrate: 8_000_000,
            MediaStreams: [
              { Type: 'Video', Codec: 'h264', Width: 1920, Height: 1080 },
              { Type: 'Audio', Codec: 'dts', Channels: 6 },
            ],
          }],
        }],
      },
    })
    const { items, totalRecordCount } = await createJellyfinClient(opts(f)).items({ startIndex: 0, limit: 500 })
    expect(totalRecordCount).toBe(1)
    expect(items[0]).toMatchObject({
      id: 'i1', type: 'Movie', name: 'Heat', year: 1995,
      jfPath: '/media/Movies/Heat (1995)/Heat.mkv',
      providerIds: { tmdb: '949', imdb: 'tt0113277' },
      sizeBytes: 12345, container: 'mkv', bitrate: 8_000_000,
      videoCodec: 'h264', width: 1920, height: 1080,
      audioCodec: 'dts', audioChannels: 6,
      hasPrimaryImage: true,
    })
  })

  it('captures the video range and the presence of a subtitle stream', async () => {
    const f = stub({
      '/Items': {
        TotalRecordCount: 1,
        Items: [{
          Id: 'i1', Type: 'Movie', Name: 'Heat',
          MediaSources: [{
            MediaStreams: [
              { Type: 'Video', Codec: 'hevc', Height: 2160, VideoRange: 'HDR', VideoRangeType: 'HDR10' },
              { Type: 'Audio', Codec: 'dts', Channels: 6 },
              { Type: 'Subtitle', Codec: 'subrip' },
            ],
          }],
        }],
      },
    })
    const { items } = await createJellyfinClient(opts(f)).items({ startIndex: 0, limit: 1 })
    expect(items[0]).toMatchObject({ videoRange: 'HDR', hasSubtitles: true })
  })

  it('falls back to VideoRangeType only when VideoRange is absent, and reports null when neither is', async () => {
    const f = stub({
      '/Items': {
        TotalRecordCount: 2,
        Items: [
          { Id: 'a', Type: 'Movie', Name: 'A', MediaSources: [{ MediaStreams: [{ Type: 'Video', VideoRangeType: 'DOVI' }] }] },
          { Id: 'b', Type: 'Movie', Name: 'B', MediaSources: [{ MediaStreams: [{ Type: 'Video', Codec: 'hevc', Height: 2160 }] }] },
        ],
      },
    })
    const { items } = await createJellyfinClient(opts(f)).items({ startIndex: 0, limit: 2 })
    expect(items[0]!.videoRange).toBe('DOVI')
    // A 4K HEVC stream with no range reported is NOT inferred to be HDR here or anywhere else.
    expect(items[1]!.videoRange).toBeNull()
    expect(items[1]!.hasSubtitles).toBe(false)
  })

  it('lowercases provider id keys so rules can match on one spelling', async () => {
    const f = stub({ '/Items': { TotalRecordCount: 1, Items: [{ Id: 'i', Type: 'Movie', Name: 'X', ProviderIds: { TvDb: '55' } }] } })
    const { items } = await createJellyfinClient(opts(f)).items({ startIndex: 0, limit: 1 })
    expect(items[0]!.providerIds).toEqual({ tvdb: '55' })
  })

  it('requests Series and Season alongside playable items', async () => {
    let seen = ''
    const f = stub({ '/Items': { TotalRecordCount: 0, Items: [] } }, (u) => { seen = u })
    await createJellyfinClient(opts(f)).items({ startIndex: 0, limit: 500 })
    expect(decodeURIComponent(seen)).toContain('IncludeItemTypes=Movie,Episode,Series,Season')
    expect(seen).toContain('Recursive=true')
  })

  it('survives an item with no MediaSources', async () => {
    const f = stub({ '/Items': { TotalRecordCount: 1, Items: [{ Id: 's1', Type: 'Series', Name: 'Show' }] } })
    const { items } = await createJellyfinClient(opts(f)).items({ startIndex: 0, limit: 1 })
    expect(items[0]!.sizeBytes).toBeNull()
    expect(items[0]!.hasPrimaryImage).toBe(false)
    expect(items[0]!.mediaSourcePaths).toEqual([])
  })

  it('collects every MediaSources path, not just the primary — this is how a merged item\'s alternate version stays visible', async () => {
    // Once two items are merged via mergeVersions, /Items stops returning the alternate version
    // as its own row; the only place its physical path still shows up is here.
    const f = stub({
      '/Items': {
        TotalRecordCount: 1,
        Items: [{
          Id: 'i1', Type: 'Movie', Name: 'Heat', Path: '/media/Movies/Heat (1995)/Heat.mkv',
          MediaSources: [
            { Id: 'ms1', Path: '/media/Movies/Heat (1995)/Heat.mkv', Size: 100 },
            { Id: 'ms2', Path: '/media/Movies/Heat (1995)/Heat.2160p.mkv', Size: 200 },
          ],
        }],
      },
    })
    const { items } = await createJellyfinClient(opts(f)).items({ startIndex: 0, limit: 1 })
    expect(items[0]!.mediaSourcePaths).toEqual([
      '/media/Movies/Heat (1995)/Heat.mkv',
      '/media/Movies/Heat (1995)/Heat.2160p.mkv',
    ])
  })

  it('deduplicates identical MediaSources paths', async () => {
    const f = stub({
      '/Items': {
        TotalRecordCount: 1,
        Items: [{
          Id: 'i1', Type: 'Movie', Name: 'Heat', Path: '/media/Movies/Heat.mkv',
          MediaSources: [
            { Id: 'ms1', Path: '/media/Movies/Heat.mkv', Size: 100 },
            { Id: 'ms2', Path: '/media/Movies/Heat.mkv', Size: 100 },
          ],
        }],
      },
    })
    const { items } = await createJellyfinClient(opts(f)).items({ startIndex: 0, limit: 1 })
    expect(items[0]!.mediaSourcePaths).toEqual(['/media/Movies/Heat.mkv'])
  })

  it('maps a Season row\'s IndexNumber to seasonNo, not episodeNo', async () => {
    const f = stub({ '/Items': { TotalRecordCount: 1, Items: [{ Id: 'se2', Type: 'Season', Name: 'Season 2', IndexNumber: 2 }] } })
    const { items } = await createJellyfinClient(opts(f)).items({ startIndex: 0, limit: 1 })
    expect(items[0]).toMatchObject({ seasonNo: 2, episodeNo: null })
  })

  it('still maps an Episode row\'s ParentIndexNumber/IndexNumber to seasonNo/episodeNo', async () => {
    const f = stub({ '/Items': { TotalRecordCount: 1, Items: [{ Id: 'ep5', Type: 'Episode', Name: 'Ep 5', ParentIndexNumber: 1, IndexNumber: 5 }] } })
    const { items } = await createJellyfinClient(opts(f)).items({ startIndex: 0, limit: 1 })
    expect(items[0]).toMatchObject({ seasonNo: 1, episodeNo: 5 })
  })
})

describe('cancellation', () => {
  // The worker holds one AbortController for the whole scan and hands its signal to every
  // connector (see src/scan/worker.ts). Without this forwarding, cancelling a scan would still
  // wait out whatever request each connector had in flight.
  it('forwards the caller-supplied signal to the underlying http client', async () => {
    const controller = new AbortController()
    controller.abort()
    const f = vi.fn(async () => new Response('{}', { status: 200 }))
    const client = createJellyfinClient({ ...opts(f as unknown as typeof fetch), signal: controller.signal })
    const err = await client.ping().catch((e) => e)
    expect(err).toBeInstanceOf(ConnectorError)
    expect((err as ConnectorError).kind).toBe('cancelled')
    expect(f).not.toHaveBeenCalled()
  })
})

describe('mutations', () => {
  it('merges versions by comma-joined ids', async () => {
    let seen = ''
    const f = stub({ '/Videos/MergeVersions': {} }, (u) => { seen = u })
    await createJellyfinClient(opts(f)).mergeVersions(['a', 'b'])
    expect(decodeURIComponent(seen)).toContain('Ids=a,b')
  })

  it('refuses to merge fewer than two ids', async () => {
    const f = stub({})
    await expect(createJellyfinClient(opts(f)).mergeVersions(['only'])).rejects.toThrow(/at least two/i)
  })

  it('sends the api key header on non-auth calls', async () => {
    let headers: Record<string, string> = {}
    const f = stub({ '/Library/Refresh': {} }, (_u, init) => { headers = init!.headers as Record<string, string> })
    await createJellyfinClient(opts(f)).refreshLibrary()
    expect(headers['X-Emby-Token']).toBe('K')
  })
})
