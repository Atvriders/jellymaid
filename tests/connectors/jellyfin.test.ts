import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createJellyfinClient, jellyfinAuthHeader, type JellyfinClient } from '../../src/connectors/jellyfin.js'
import { ConnectorError } from '../../src/connectors/http.js'

const PACKAGE_VERSION = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version

/** Long and distinctive, so a leak into a header or URL it does not belong in is unmistakable. */
const API_KEY = 'service-key-0123456789abcdef'

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
  url: 'http://jf:8096', apiKey: API_KEY, concurrency: 4, minDelayMs: 0, fetchImpl,
})

interface Call { url: string; path: string; method: string; body: string | null; headers: Record<string, string> }

/** A fetch double that records every call (header names lowercased) and answers each by its URL. */
function recorder(answer: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = []
  const f = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      path: new URL(String(url)).pathname,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : null,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    })
    return answer(String(url), init)
  }) as unknown as typeof fetch
  return { f, calls }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const noContent = () => new Response(null, { status: 204 })

/** The DeviceId a MediaBrowser Authorization header carries. */
const deviceIdOf = (header: string | undefined) => /DeviceId="([^"]*)"/.exec(header ?? '')?.[1]

describe('every request carries Authorization: MediaBrowser … Token=<key> and no X-Emby-Token', () => {
  // Jellyfin 12.x answers 401 to X-Emby-Token, X-MediaBrowser-Token and ?api_key= (probe.md, section 2):
  // only the Authorization header (or ?ApiKey=) is accepted, and the header is what logout needs too.
  const answer = (url: string): Response => {
    switch (new URL(url).pathname) {
      case '/Users':
      case '/Library/VirtualFolders':
      case '/ScheduledTasks':
        return json([])
      case '/Items':
        return json({ Items: [], TotalRecordCount: 0 })
      case '/System/Info':
        return json({ Version: '12.1.0' })
      default:
        return noContent()
    }
  }

  // One call per client method that talks to Jellyfin with the service key. `authenticateByName`
  // is the exception on purpose and has its own tests below: it must NOT carry the key.
  const withServiceKey: Record<string, (c: JellyfinClient) => Promise<unknown>> = {
    loginRisk: (c) => c.loginRisk('someone'),
    virtualFolders: (c) => c.virtualFolders(),
    items: (c) => c.items({ startIndex: 0, limit: 10 }),
    mergeVersions: (c) => c.mergeVersions(['a', 'b']),
    splitVersions: (c) => c.splitVersions('a'),
    notifyPathsDeleted: (c) => c.notifyPathsDeleted(['/data/movies/A.mkv']),
    libraryScanRunning: (c) => c.libraryScanRunning(),
    ping: (c) => c.ping(),
  }

  it.each(Object.entries(withServiceKey))('%s', async (_name, call) => {
    const { f, calls } = recorder(answer)
    await call(createJellyfinClient(opts(f)))
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) {
      expect(c.headers['authorization']).toBe(jellyfinAuthHeader({ token: API_KEY }))
      expect(c.headers['authorization']).toMatch(/^MediaBrowser Client="Jellymaid", .*Token="/)
      for (const legacy of ['x-emby-token', 'x-mediabrowser-token', 'x-emby-authorization']) {
        expect(c.headers[legacy], `${legacy} on ${c.method} ${c.path}`).toBeUndefined()
      }
      expect(c.url).not.toContain(API_KEY)
    }
  })

  it('is exhaustive: a method added to the client must be added to the table above', () => {
    const methods = Object.keys(createJellyfinClient(opts(recorder(answer).f))).sort()
    expect(methods).toEqual([...Object.keys(withServiceKey), 'authenticateByName'].sort())
  })
})

describe('authenticateByName', () => {
  const loginBody = (over: Record<string, unknown> = {}) => ({
    User: { Id: 'u1', Name: 'bob', Policy: { IsAdministrator: true } },
    AccessToken: 'USER-TOKEN-1',
    ServerId: 'srv',
    ...over,
  })
  /** AuthenticateByName answers `body(n)` (n = how many logins came before); logout answers `logout()`. */
  const loginServer = (
    body: (n: number) => unknown,
    logout: () => Response | Promise<Response> = noContent,
  ) => {
    let logins = 0
    return recorder((url) => {
      if (url.endsWith('/Users/AuthenticateByName')) return json(body(logins++))
      if (url.endsWith('/Sessions/Logout')) return logout()
      return new Response('unexpected request', { status: 500 })
    })
  }

  it('sends the MediaBrowser header without Token, reads Policy.IsAdministrator from the response, and revokes via /Sessions/Logout with Token=<user token>', async () => {
    const { f, calls } = loginServer(() => loginBody())
    const result = await createJellyfinClient(opts(f)).authenticateByName('bob', 'hunter2')

    // The token is revoked before this returns, so it is not handed to the caller at all.
    expect(result).toEqual({ userId: 'u1', isAdministrator: true })
    // Exactly the login and the revocation: no /Users/Me (an API key has no user, and the body already says).
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /Users/AuthenticateByName', 'POST /Sessions/Logout'])

    const [login, logout] = calls as [Call, Call]
    const deviceId = deviceIdOf(login.headers['authorization'])
    expect(deviceId).toBeTruthy()
    // Token-less: it is the USER's credentials being checked, not the service key.
    expect(login.headers['authorization']).toBe(jellyfinAuthHeader({ deviceId }))
    expect(login.headers['authorization']).not.toContain('Token=')
    expect(JSON.parse(login.body!)).toEqual({ Username: 'bob', Pw: 'hunter2' })

    // Revoked with the user's own token, under the DeviceId it was issued to.
    expect(logout.headers['authorization']).toBe(jellyfinAuthHeader({ token: 'USER-TOKEN-1', deviceId }))

    // Neither request carries the service key or a legacy token header, and the password stays in the body.
    for (const c of calls) {
      expect(c.headers['x-emby-token']).toBeUndefined()
      expect(JSON.stringify([c.headers, c.url])).not.toContain(API_KEY)
      expect(JSON.stringify([c.headers, c.url])).not.toContain('hunter2')
    }
  })

  it('uses a different DeviceId per call, and revokes each token under the DeviceId it was issued to', async () => {
    // A second login under the SAME DeviceId revokes the first token (probe.md 2.6): with one fixed id,
    // two operators logging in together would revoke each other's token mid-check.
    const { f, calls } = loginServer((n) => loginBody({ AccessToken: `TOKEN-${n}` }))
    const client = createJellyfinClient(opts(f))
    for (let i = 0; i < 3; i += 1) await client.authenticateByName('bob', 'pw')

    const logins = calls.filter((c) => c.path === '/Users/AuthenticateByName')
    const logouts = calls.filter((c) => c.path === '/Sessions/Logout')
    const ids = logins.map((c) => deviceIdOf(c.headers['authorization']))
    expect(ids).toHaveLength(3)
    expect(new Set(ids).size).toBe(3)
    // Safe inside a quoted header value.
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9._-]+$/)
    expect(logouts.map((c) => deviceIdOf(c.headers['authorization']))).toEqual(ids)
    expect(logouts.map((c) => c.headers['authorization']?.match(/Token="([^"]*)"/)?.[1])).toEqual(['TOKEN-0', 'TOKEN-1', 'TOKEN-2'])
  })

  it('has revoked the token by the time it returns', async () => {
    let revoked = false
    const { f } = loginServer(() => loginBody(), async () => {
      await new Promise((r) => setTimeout(r, 25))
      revoked = true
      return noContent()
    })
    await createJellyfinClient(opts(f)).authenticateByName('bob', 'pw')
    expect(revoked).toBe(true)
  })

  it('reports a non-admin as isAdministrator false rather than throwing, and still revokes', async () => {
    const { f, calls } = loginServer(() => loginBody({ User: { Id: 'u2', Policy: { IsAdministrator: false } } }))
    const res = await createJellyfinClient(opts(f)).authenticateByName('eve', 'pw')
    expect(res).toEqual({ userId: 'u2', isAdministrator: false })
    expect(calls.map((c) => c.path)).toEqual(['/Users/AuthenticateByName', '/Sessions/Logout'])
  })

  it('does not take a missing or non-boolean role for "not an admin": bad-response, and the token is still revoked', async () => {
    // A reply that cannot answer "is this an administrator?" is a malformed reply, not evidence the
    // credentials were wrong, so src/api/auth.ts must not count it against the operator's lockout.
    for (const User of [{ Id: 'u1' }, { Id: 'u1', Policy: {} }, { Id: 'u1', Policy: { IsAdministrator: 'true' } }]) {
      const { f, calls } = loginServer(() => loginBody({ User }))
      const err = await createJellyfinClient(opts(f)).authenticateByName('eve', 'pw').catch((e) => e)
      expect(err).toBeInstanceOf(ConnectorError)
      expect((err as ConnectorError).kind).toBe('bad-response')
      expect(calls.map((c) => c.path)).toEqual(['/Users/AuthenticateByName', '/Sessions/Logout'])
    }
  })

  it('fails closed with a bad-response error (NOT auth) when the response carries no AccessToken', async () => {
    // There is nothing to revoke and nothing trustworthy to read: never treat the reply as a login.
    // Classified 'bad-response', not 'auth': this is a malformed reply, not a credential rejection,
    // so src/api/auth.ts's login route must not consume a lockout attempt for it.
    for (const AccessToken of [undefined, '']) {
      const { f, calls } = loginServer(() => loginBody({ AccessToken }))
      const err = await createJellyfinClient(opts(f)).authenticateByName('eve', 'pw').catch((e) => e)
      expect(err).toBeInstanceOf(ConnectorError)
      expect((err as ConnectorError).kind).toBe('bad-response')
      expect(calls.map((c) => c.path)).toEqual(['/Users/AuthenticateByName'])
    }
  })

  it('does not turn a good login into an error because the revocation failed', async () => {
    for (const logout of [() => new Response('nope', { status: 500 }), () => new Response('nope', { status: 401 })]) {
      const { f } = loginServer(() => loginBody(), logout)
      await expect(createJellyfinClient(opts(f)).authenticateByName('bob', 'pw'))
        .resolves.toEqual({ userId: 'u1', isAdministrator: true })
    }
  })

  it('maps a wrong password (401) and a disabled account (403, even with the right password) to an auth error, with nothing to revoke', async () => {
    for (const status of [401, 403]) {
      const { f, calls } = recorder(() => new Response('Error processing request.', { status }))
      const err = await createJellyfinClient(opts(f)).authenticateByName('bob', 'pw').catch((e) => e)
      expect(err).toBeInstanceOf(ConnectorError)
      expect((err as ConnectorError).kind).toBe('auth')
      expect(calls.map((c) => c.path)).toEqual(['/Users/AuthenticateByName'])
    }
  })

  it('never replays the login POST: a 5xx is one request, because a replay would double-count against Jellyfin\'s lockout', async () => {
    const { f, calls } = recorder(() => new Response('boom', { status: 502 }))
    const err = await createJellyfinClient(opts(f)).authenticateByName('bob', 'pw').catch((e) => e)
    expect((err as ConnectorError).kind).toBe('unreachable')
    expect(calls).toHaveLength(1)
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

  it('requests SortBy=DateCreated,SortName ascending, so an item added mid-scan appends instead of shifting earlier pages', async () => {
    const { f, calls } = recorder(() => json({ Items: [], TotalRecordCount: 0 }))
    await createJellyfinClient(opts(f)).items({ startIndex: 40, limit: 20 })
    expect(calls).toHaveLength(1)
    const q = new URL(calls[0]!.url).searchParams
    expect(q.get('SortBy')).toBe('DateCreated,SortName')
    expect(q.get('SortOrder')).toBe('Ascending')
    expect(q.get('StartIndex')).toBe('40')
    expect(q.get('Limit')).toBe('20')
    expect(q.get('EnableTotalRecordCount')).toBe('true')
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
})

describe('jellyfinAuthHeader', () => {
  it('names the client, the device and the package version, with no token unless given one', () => {
    expect(jellyfinAuthHeader({})).toBe(
      `MediaBrowser Client="Jellymaid", Device="Jellymaid", DeviceId="jellymaid-server", Version="${PACKAGE_VERSION}"`,
    )
  })

  it('appends the token and honours a device id', () => {
    expect(jellyfinAuthHeader({ token: 'K', deviceId: 'login-1' })).toBe(
      `MediaBrowser Client="Jellymaid", Device="Jellymaid", DeviceId="login-1", Version="${PACKAGE_VERSION}", Token="K"`,
    )
    expect(jellyfinAuthHeader({ token: null })).not.toContain('Token=')
  })
})

describe('notifyPathsDeleted', () => {
  it('posts every path as a Deleted update, in chunks of at most 200', async () => {
    const { f, calls } = recorder(noContent)
    const paths = Array.from({ length: 450 }, (_, i) => `/data/movies/M${i}.mkv`)
    await createJellyfinClient(opts(f)).notifyPathsDeleted(paths)
    expect(calls.map((c) => c.method)).toEqual(['POST', 'POST', 'POST'])
    expect(calls.every((c) => c.url.endsWith('/Library/Media/Updated'))).toBe(true)
    const bodies = calls.map((c) => JSON.parse(c.body!) as { Updates: Array<{ Path: string; UpdateType: string }> })
    expect(bodies.map((b) => b.Updates.length)).toEqual([200, 200, 50])
    expect(bodies[0]!.Updates[0]).toEqual({ Path: '/data/movies/M0.mkv', UpdateType: 'Deleted' })
    expect(bodies.flatMap((b) => b.Updates.map((u) => u.Path))).toEqual(paths)
  })

  it('sends exactly 200 paths in one request and 201 in two', async () => {
    const sizes = async (n: number) => {
      const { f, calls } = recorder(noContent)
      await createJellyfinClient(opts(f)).notifyPathsDeleted(Array.from({ length: n }, (_, i) => `/data/movies/M${i}.mkv`))
      return calls.map((c) => (JSON.parse(c.body!) as { Updates: unknown[] }).Updates.length)
    }
    expect(await sizes(200)).toEqual([200])
    expect(await sizes(201)).toEqual([200, 1])
  })

  it('sends nothing for an empty list', async () => {
    const { f, calls } = recorder(noContent)
    await createJellyfinClient(opts(f)).notifyPathsDeleted([])
    expect(calls).toEqual([])
  })

  it('does not replay a notification that failed: a lost one only delays Jellyfin forgetting the item', async () => {
    const { f, calls } = recorder(() => new Response('boom', { status: 500 }))
    await expect(createJellyfinClient(opts(f)).notifyPathsDeleted(['/data/movies/A.mkv'])).rejects.toBeInstanceOf(ConnectorError)
    expect(calls).toHaveLength(1)
  })
})

describe('libraryScanRunning', () => {
  const withTasks = (tasks: unknown[]) => createJellyfinClient(opts(recorder(() => json(tasks)).f))

  it('reads the RefreshLibrary scheduled task from GET /ScheduledTasks', async () => {
    const { f, calls } = recorder(() => json([{ Key: 'RefreshLibrary', State: 'Idle' }]))
    await createJellyfinClient(opts(f)).libraryScanRunning()
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /ScheduledTasks'])

    expect(await withTasks([{ Key: 'RefreshLibrary', State: 'Running' }]).libraryScanRunning()).toBe(true)
    expect(await withTasks([{ Key: 'RefreshLibrary', State: 'Cancelling' }]).libraryScanRunning()).toBe(true)
    expect(await withTasks([{ Key: 'RefreshLibrary', State: 'Idle' }]).libraryScanRunning()).toBe(false)
  })

  it('ignores every other task', async () => {
    expect(await withTasks([{ Key: 'CleanCache', State: 'Running' }, { Key: 'RefreshLibrary', State: 'Idle' }]).libraryScanRunning())
      .toBe(false)
  })
})

describe('loginRisk', () => {
  const user = (name: string, failures: number | undefined, limit: number | undefined) =>
    ({ Name: name, Id: `id-${name}`, Policy: { InvalidLoginAttemptCount: failures, LoginAttemptsBeforeLockout: limit } })
  const risk = (users: unknown, name: string) => createJellyfinClient(opts(recorder(() => json(users)).f)).loginRisk(name)

  it('reads GET /Users with the service key and nothing else', async () => {
    const { f, calls } = recorder(() => json([user('Admin', 0, 3)]))
    await createJellyfinClient(opts(f)).loginRisk('Admin')
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /Users'])
    expect(calls[0]!.headers['authorization']).toBe(jellyfinAuthHeader({ token: API_KEY }))
  })

  // [LoginAttemptsBeforeLockout, InvalidLoginAttemptCount, allowed]. Jellyfin disables the account when
  // the counter, after the failure it is recording, reaches the limit, so the attempt that starts at
  // limit - 1 is the one that disables it (probe.md section 4: the 3rd wrong password at limit 3).
  it.each([
    [3, 0, true], [3, 1, true], [3, 2, false], [3, 3, false],
    // The counter reads 4 once a limit-3 account is disabled (the lockout path increments twice).
    [3, 4, false],
    [5, 3, true], [5, 4, false],
    [2, 0, true], [2, 1, false],
    // One failure disables the account, so no attempt is ever safe.
    [1, 0, false],
    // A policy that reads 0 is the dashboard default: 3.
    [0, 1, true], [0, 2, false],
  ])('limit %i with %i failed logins recorded: allowed=%s', async (limit, failures, allowed) => {
    const verdict = await risk([user('Admin', failures, limit)], 'Admin')
    expect(verdict.allowed).toBe(allowed)
    if (allowed) expect(verdict).toEqual({ allowed: true, reason: null })
    else expect(verdict.reason).toMatch(new RegExp(`\\b${failures}\\b.*\\b${limit === 0 ? 3 : limit}\\b`))
  })

  it.each([-1, -2])('never refuses an account whose lockout is off (limit %i)', async (limit) => {
    expect(await risk([user('Admin', 50, limit)], 'Admin')).toEqual({ allowed: true, reason: null })
  })

  it('treats a policy that names no limit as the default of 3, which is the cautious reading', async () => {
    expect((await risk([user('Admin', 2, undefined)], 'Admin')).allowed).toBe(false)
    expect((await risk([user('Admin', 1, undefined)], 'Admin')).allowed).toBe(true)
  })

  it('matches the username case-insensitively, in both directions', async () => {
    expect((await risk([user('Admin', 2, 0)], 'admin')).allowed).toBe(false)
    expect((await risk([user('admin', 2, 0)], 'ADMIN')).allowed).toBe(false)
    expect((await risk([user('Zoë', 2, 0)], 'ZOË')).allowed).toBe(false)
  })

  it('matches at least as broadly as Jellyfin does: a name Jellyfin could resolve to the account must not slip past', async () => {
    // Jellyfin compares names ordinally and case-insensitively, and .NET and JavaScript disagree on a
    // few characters (U+017F, the long s, upper-cases to S in .NET). Over-matching only refuses one
    // extra attempt; under-matching would forward a failure to the very account this guard protects.
    expect((await risk([user('sam', 2, 0)], 'ſam')).allowed).toBe(false)
  })

  it('refuses when any account matching the name is at risk', async () => {
    expect((await risk([user('Bob', 0, 3), user('bob', 2, 3)], 'BOB')).allowed).toBe(false)
  })

  it('allows a username Jellyfin does not know — Jellyfin answers that like a wrong password', async () => {
    expect(await risk([user('Admin', 2, 0)], 'nobody')).toEqual({ allowed: true, reason: null })
    expect(await risk([], 'nobody')).toEqual({ allowed: true, reason: null })
  })

  it('does not let an at-risk account make a differently named one look risky', async () => {
    expect(await risk([user('Admin', 2, 0), user('Bob', 0, 0)], 'Bob')).toEqual({ allowed: true, reason: null })
  })

  describe('fails closed — an answer it cannot read is a failure, never an allowance', () => {
    const rejectsAsBadResponse = async (users: unknown, name = 'Admin') => {
      const err = await risk(users, name).catch((e) => e)
      expect(err).toBeInstanceOf(ConnectorError)
      expect((err as ConnectorError).kind).toBe('bad-response')
    }

    it('rejects a body that is not a list of users', async () => {
      await rejectsAsBadResponse({})
      await rejectsAsBadResponse({ Items: [] })
    })

    it('rejects when the matching account does not report how many failures it has', async () => {
      await rejectsAsBadResponse([{ Name: 'Admin' }])
      await rejectsAsBadResponse([{ Name: 'Admin', Policy: { LoginAttemptsBeforeLockout: 3 } }])
      await rejectsAsBadResponse([user('Admin', undefined, 3)])
    })

    it('does not need the count of an account whose lockout is off, or of an account that is not the one asked about', async () => {
      expect((await risk([{ Name: 'Admin', Policy: { LoginAttemptsBeforeLockout: -1 } }], 'Admin')).allowed).toBe(true)
      expect((await risk([{ Name: 'Other' }, user('Admin', 0, 3)], 'Admin')).allowed).toBe(true)
    })

    it('rejects when Jellyfin refuses the service key (401) instead of reading it as "no such user"', async () => {
      const { f } = recorder(() => new Response('', { status: 401 }))
      const err = await createJellyfinClient(opts(f)).loginRisk('Admin').catch((e) => e)
      expect(err).toBeInstanceOf(ConnectorError)
      expect((err as ConnectorError).kind).toBe('auth')
    })

    it('rejects when Jellyfin is down or answers 5xx', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout'] })
      try {
        for (const answer of [() => new Response('boom', { status: 503 }), () => { throw new TypeError('fetch failed') }]) {
          const settled = createJellyfinClient(opts(recorder(answer).f)).loginRisk('Admin').catch((e) => e)
          await vi.runAllTimersAsync() // the client retries a GET with backoff before giving up
          const err = await settled
          expect(err).toBeInstanceOf(ConnectorError)
          expect((err as ConnectorError).kind).toBe('unreachable')
        }
      } finally {
        vi.useRealTimers()
      }
    })
  })
})

describe('ping', () => {
  it('returns the server version', async () => {
    const { f } = recorder(() => json({ Version: '12.1.0', ServerName: 'x' }))
    expect(await createJellyfinClient(opts(f)).ping()).toEqual({ version: '12.1.0' })
  })

  it('reports an unreadable version as "unknown" rather than failing the health probe', async () => {
    const { f } = recorder(() => json({ ServerName: 'x' }))
    expect(await createJellyfinClient(opts(f)).ping()).toEqual({ version: 'unknown' })
  })
})
