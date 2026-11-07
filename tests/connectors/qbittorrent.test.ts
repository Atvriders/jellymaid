import { describe, it, expect, vi } from 'vitest'
import {
  createQbitClient, createQbitClients, QBIT_BAN_BACKOFF_MS, QBIT_LOGIN_BACKOFF_MS, QBIT_MAX_CONSECUTIVE_REJECTIONS,
  type QbitClientOptions,
} from '../../src/connectors/qbittorrent.js'
import { ConnectorError } from '../../src/connectors/http.js'

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

const client = (f: typeof fetch, privateHosts: QbitClientOptions['privateTrackerHosts'] = []) => createQbitClient({
  instanceId: 'box-a', url: 'http://qb:8080', user: 'u', pass: 'p',
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
      hash: 'h1', savePath: '/downloads/movies', contentPath: '/downloads/movies/Heat.1995.mkv',
      category: 'movies', state: 'stalledUP', ratio: 2.4, seedingTimeSeconds: 1_209_600,
      sizeBytes: 1000, trackerHost: 'tracker.private.example',
    })
    expect(t.tags).toEqual(['keep', 'hd'])
  })

  it('reports rootPath and addedOn as null when this qBittorrent does not', async () => {
    const t = (await client(stub({ '/torrents/info': RAW })).torrents())[0]!
    expect(t.rootPath).toBeNull()
    expect(t.addedOn).toBeNull()
  })

  it('uses the private flag when the qBittorrent version reports it', async () => {
    const t = (await client(stub({ '/torrents/info': [{ ...RAW[0], private: true }] })).torrents())[0]!
    expect(t.isPrivate).toBe(true)
    expect(t.privacySource).toBe('flag')
  })

  it('falls back to the configured private-host list', async () => {
    const t = (await client(stub({ '/torrents/info': RAW }), ['tracker.private.example']).torrents())[0]!
    expect(t.isPrivate).toBe(true)
    expect(t.privacySource).toBe('host-list')
  })

  it('treats unknown privacy as private — fail safe', async () => {
    const raw = [{ ...RAW[0], tracker: '' }]
    const t = (await client(stub({ '/torrents/info': raw })).torrents())[0]!
    expect(t.isPrivate).toBe(true)
    expect(t.privacySource).toBe('undetermined')
  })

  it('treats a known public tracker as public — the explicit flag is trusted in both directions', async () => {
    const raw = [{ ...RAW[0], tracker: 'http://tracker.opentrackr.org:1337/announce', private: false }]
    const t = (await client(stub({ '/torrents/info': raw })).torrents())[0]!
    expect(t.isPrivate).toBe(false)
    expect(t.privacySource).toBe('flag')
  })

  it('fails closed on a resolvable tracker host that is on neither the private flag nor the private-host list', async () => {
    // No explicit `private` field, and 'tracker.example.org' is not in the configured
    // privateTrackerHosts list. Neither signal establishes anything, so this must be
    // undetermined -> private, NOT public. Getting this backwards would silently drop the
    // ratio guard on private torrents whose tracker just hasn't been added to the list yet,
    // or on any torrent from a qBittorrent old enough not to report `private` at all.
    const raw = [{ ...RAW[0], tracker: 'http://tracker.example.org/announce' }]
    const t = (await client(stub({ '/torrents/info': raw })).torrents())[0]!
    expect(t.isPrivate).toBe(true)
    expect(t.privacySource).toBe('undetermined')
  })

  it('captures the SID cookie from login and sends it back as the Cookie header on later calls', async () => {
    const headersSeen: Array<Record<string, string> | undefined> = []
    const f = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      headersSeen.push(init?.headers as Record<string, string> | undefined)
      if (u.includes('/auth/login')) {
        return new Response('Ok.', { status: 200, headers: { 'set-cookie': 'SID=xyz789; path=/; HttpOnly' } })
      }
      return new Response(JSON.stringify(RAW), { status: 200 })
    }) as unknown as typeof fetch
    await client(f).torrents()
    const [loginHeaders, infoHeaders] = headersSeen
    expect(loginHeaders?.Cookie).toBeUndefined() // the login request itself must not send a stale cookie
    expect(infoHeaders?.Cookie).toBe('SID=xyz789') // attributes like path/HttpOnly are stripped
  })

  it('extracts SID from a set-cookie header that joins multiple cookies, as undici does for repeated headers', async () => {
    const headersSeen: Array<Record<string, string> | undefined> = []
    const f = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      headersSeen.push(init?.headers as Record<string, string> | undefined)
      if (u.includes('/auth/login')) {
        return new Response('Ok.', { status: 200, headers: { 'set-cookie': 'other=1; path=/, SID=abc; path=/' } })
      }
      return new Response(JSON.stringify(RAW), { status: 200 })
    }) as unknown as typeof fetch
    await client(f).torrents()
    expect(headersSeen[1]?.Cookie).toBe('SID=abc')
  })

  it('trims trailing whitespace from the captured SID value', async () => {
    const headersSeen: Array<Record<string, string> | undefined> = []
    const f = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      headersSeen.push(init?.headers as Record<string, string> | undefined)
      if (u.includes('/auth/login')) {
        return new Response('Ok.', { status: 200, headers: { 'set-cookie': 'SID=abc ; path=/' } })
      }
      return new Response(JSON.stringify(RAW), { status: 200 })
    }) as unknown as typeof fetch
    await client(f).torrents()
    expect(headersSeen[1]?.Cookie).toBe('SID=abc')
  })

  it('throws bad-response when login succeeds but returns no SID cookie', async () => {
    const f = (async (url: string | URL) => {
      const u = String(url)
      if (u.includes('/auth/login')) return new Response('Ok.', { status: 200 }) // no set-cookie at all
      return new Response(JSON.stringify(RAW), { status: 200 })
    }) as unknown as typeof fetch
    const err = (await client(f).torrents().catch((e) => e)) as ConnectorError
    expect(err).toBeInstanceOf(ConnectorError)
    expect(err.kind).toBe('bad-response')
  })

  it('logs in once and reuses the SID cookie', async () => {
    const urls: string[] = []
    const c = client(stub({ '/torrents/info': RAW }, (u) => urls.push(u)))
    await c.torrents(); await c.torrents()
    expect(urls.filter((u) => u.includes('/auth/login'))).toHaveLength(1)
  })

  it('re-logins after a 403 and retries the call with the NEW SID, never the stale one', async () => {
    let logins = 0; let infoCalls = 0
    const loginCookiesSeen: Array<string | undefined> = []
    const infoCookiesSeen: Array<string | undefined> = []
    const f = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      const cookie = (init?.headers as Record<string, string> | undefined)?.Cookie
      if (u.includes('/auth/login')) {
        logins += 1
        loginCookiesSeen.push(cookie)
        // Each login mints a DIFFERENT session id, so a bug that resent the stale cookie or
        // reused the first session after re-login would be visible below.
        return new Response('Ok.', { status: 200, headers: { 'set-cookie': `SID=session${logins}` } })
      }
      infoCalls += 1
      infoCookiesSeen.push(cookie)
      return infoCalls === 1 ? new Response('', { status: 403 }) : new Response(JSON.stringify(RAW), { status: 200 })
    }) as unknown as typeof fetch
    const t = await client(f).torrents()
    expect(logins).toBe(2)
    expect(t).toHaveLength(1)
    expect(loginCookiesSeen).toEqual([undefined, undefined]) // neither login sends a Cookie header
    expect(infoCookiesSeen).toEqual(['SID=session1', 'SID=session2']) // the retry carries the fresh SID
  })
})

describe('cancellation', () => {
  // The worker holds one AbortController for the whole scan and hands its signal to every
  // connector (see src/scan/worker.ts). Without this forwarding, cancelling a scan would still
  // wait out whatever request each connector had in flight.
  it('forwards the caller-supplied signal to the underlying http client', async () => {
    const controller = new AbortController()
    controller.abort()
    const f = vi.fn(async () => new Response('Ok.', { status: 200, headers: { 'set-cookie': 'SID=abc' } }))
    const c = createQbitClient({
      instanceId: 'box-a', url: 'http://qb:8080', user: 'u', pass: 'p', concurrency: 2, minDelayMs: 0,
      privateTrackerHosts: [], fetchImpl: f as unknown as typeof fetch, signal: controller.signal,
    })
    const err = await c.ping().catch((e) => e)
    expect(err).toBeInstanceOf(ConnectorError)
    expect((err as ConnectorError).kind).toBe('cancelled')
    expect(f).not.toHaveBeenCalled()
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

describe('createQbitClients', () => {
  it('builds one client per instance, keyed by id, each knowing its own id and URL', async () => {
    const urls: string[] = []
    const f = (async (url: string | URL) => {
      urls.push(String(url))
      return new Response(JSON.stringify([{ ...RAW[0] }]), { status: 200 })
    }) as unknown as typeof fetch
    const clients = createQbitClients(
      [
        { id: 'box-a', url: 'http://198.51.100.10:8080', user: null, pass: null },
        { id: 'box-b', url: 'http://198.51.100.11:8080', user: null, pass: null },
      ],
      { concurrency: 1, minDelayMs: 0, privateTrackerHosts: [], fetchImpl: f },
    )
    expect([...clients.keys()]).toEqual(['box-a', 'box-b'])
    expect(clients.get('box-a')!.instanceId).toBe('box-a')
    const fromB = await clients.get('box-b')!.torrents()
    expect(fromB[0]!.instanceId).toBe('box-b')
    expect(urls).toEqual(['http://198.51.100.11:8080/api/v2/torrents/info'])
  })
})

// =============================================================================================
// Login and session behaviour against qBittorrent 5.1 and 5.2
//
// FakeQbit answers exactly as real qBittorrent 5.2.2 and 5.1.2 did when they were recorded on the
// local test harness (outside this repository). The A-n / B-n ids in the comments are that
// recording's exchange ids for the 5.2.2 and 5.1.2 instance, kept so each response can be traced
// back: the status codes, bodies and Set-Cookie lines are the recorded ones, not invented protocol.
// Fixture paths and the tracker are generic, never the harness host's own.
// =============================================================================================

type Flavor = '5.2.2' | '5.1.2'
const FLAVORS = ['5.2.2', '5.1.2'] as const

interface Seen {
  method: string
  path: string
  headers: Record<string, string>
  cookie: string | undefined
  body: string
}

const LOGIN_PATH = '/api/v2/auth/login'
const BAN_TEXT = 'Your IP address has been banned after too many failed authentication attempts.' // A-16, A-17

function plain(status: number, body: string | null, setCookie?: string): Response {
  return new Response(body, {
    status,
    headers: {
      ...(body === null ? {} : { 'content-type': 'text/plain; charset=UTF-8' }),
      ...(setCookie ? { 'set-cookie': setCookie } : {}),
    },
  })
}

function json(body: unknown, setCookie?: string): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...(setCookie ? { 'set-cookie': setCookie } : {}) },
  })
}

/** `torrents/info` entries as recorded (A-19, B-5); only the keys the connector reads are kept. */
const RECORDED_TORRENT: Record<Flavor, Record<string, unknown>> = {
  // A movie in its own folder: root_path is that folder.
  '5.2.2': {
    added_on: 1793137674, category: 'movies',
    content_path: '/path/to/boxA/movies/Night.of.the.Living.Dead.1968.1080p.BluRay.x264-HARNESS',
    hash: 'ad3b30ed6755698f8dc7e17b74f73f53e83e1556',
    name: 'Night.of.the.Living.Dead.1968.1080p.BluRay.x264-HARNESS',
    private: true, progress: 1, ratio: 0,
    root_path: '/path/to/boxA/movies/Night.of.the.Living.Dead.1968.1080p.BluRay.x264-HARNESS',
    save_path: '/path/to/boxA/movies', seeding_time: 3, size: 1273256, state: 'forcedUP', tags: '',
    tracker: 'http://tracker.private.example/announce',
  },
  // A single file with no folder of its own: root_path is "".
  '5.1.2': {
    added_on: 1793137676, category: 'movies',
    content_path: '/path/to/boxB/movies/Nosferatu.1922.720p.BluRay.x264-HARNESS.mkv',
    hash: 'b9b17e40cba809723737a4eea9491a3a6581fc04',
    name: 'Nosferatu.1922.720p.BluRay.x264-HARNESS.mkv',
    private: true, progress: 1, ratio: 0, root_path: '',
    save_path: '/path/to/boxB/movies', seeding_time: 27, size: 262090, state: 'forcedUP', tags: '',
    tracker: 'http://tracker.private.example/announce',
  },
}

class FakeQbit {
  readonly seen: Seen[] = []
  /** Every session id ever handed out, in order. */
  readonly minted: string[] = []
  /** Wrong-password logins the server has counted against this client's address. */
  failedLogins = 0
  banned = false
  password: string
  private readonly live = new Set<string>()

  constructor(
    readonly flavor: Flavor,
    private readonly cfg: {
      user?: string; pass?: string; bypass?: boolean; torrents?: unknown[]; maxAuthFails?: number
    } = {},
  ) {
    this.password = cfg.pass ?? 'p'
  }

  /** 5.2 names the cookie after the WebUI port; 5.1 and earlier call it SID (A-1, B-1). */
  get cookieName(): string { return this.flavor === '5.2.2' ? 'QBT_SID_18080' : 'SID' }
  logins(): Seen[] { return this.seen.filter((r) => r.path === LOGIN_PATH) }
  calls(): Seen[] { return this.seen.filter((r) => r.path !== LOGIN_PATH) }
  /** What qBittorrent does silently once web_ui_session_timeout has passed, or on a restart. */
  expireSessions(): void { this.live.clear() }

  readonly fetch = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    const req: Seen = {
      method: init?.method ?? 'GET', path: new URL(String(url)).pathname, headers,
      cookie: headers.Cookie, body: String(init?.body ?? ''),
    }
    this.seen.push(req)
    return req.path === LOGIN_PATH ? this.onLogin(req) : this.onApi(req)
  }) as unknown as typeof fetch

  private onLogin(req: Seen): Response {
    if (this.banned) return plain(403, BAN_TEXT) // A-16, A-17: even the right password is refused
    const form = new URLSearchParams(req.body)
    const accepted = this.cfg.bypass === true // A-2, A-3: a bypassed client logs in with anything
      || (form.get('username') === (this.cfg.user ?? 'u') && form.get('password') === this.password)
    if (!accepted) {
      this.failedLogins += 1
      // The Nth failure itself is still answered normally; the NEXT attempt is the refused one (A-16).
      if (this.failedLogins >= (this.cfg.maxAuthFails ?? 5)) this.banned = true
      return this.flavor === '5.2.2'
        ? plain(401, 'Unauthorized') // A-11, A-12
        : plain(200, 'Fails.') // B-11, B-12
    }
    const cookie = this.cookieFor(this.mint())
    return this.flavor === '5.2.2'
      ? plain(204, null, cookie) // A-1, A-8: no body at all
      : plain(200, 'Ok.', cookie) // B-1, B-8
  }

  private onApi(req: Seen): Response {
    if (this.banned) return plain(403, 'Forbidden') // A-18
    let setCookie: string | undefined
    if (!this.hasLiveSession(req.cookie)) {
      if (this.cfg.bypass !== true) return plain(403, 'Forbidden') // A-7, A-10, A-14
      setCookie = this.cookieFor(this.mint()) // A-4..A-6: a session of its own for every cookie-less call
    }
    switch (req.path) {
      case '/api/v2/app/version': return plain(200, `v${this.flavor}`, setCookie) // A-4, B-4
      case '/api/v2/torrents/info': return json(this.cfg.torrents ?? [RECORDED_TORRENT[this.flavor]], setCookie)
      default: return plain(404, 'Not Found', setCookie)
    }
  }

  private mint(): string {
    const sid = (this.minted.length + 1).toString(16).padStart(32, '0')
    this.minted.push(sid)
    this.live.add(sid)
    return sid
  }

  private cookieFor(sid: string): string {
    return this.flavor === '5.2.2'
      ? `QBT_SID_18080=${sid}; HttpOnly; SameSite=Lax; expires=Tue, 27-Oct-2026 22:53:17 GMT; path=/` // A-1
      : `SID=${sid}; HttpOnly; SameSite=Strict; path=/` // B-1
  }

  /** The server only knows its own cookie name: the same value under another name is refused (A-10). */
  private hasLiveSession(cookie: string | undefined): boolean {
    return (cookie ?? '').split(';').some((pair) => {
      const [name, value] = pair.trim().split('=')
      return name === this.cookieName && value !== undefined && this.live.has(value)
    })
  }
}

const sessionClient = (q: FakeQbit, over: Partial<QbitClientOptions> = {}) => createQbitClient({
  instanceId: 'box-a', url: 'http://198.51.100.10:8080', user: 'u', pass: 'p',
  concurrency: 4, minDelayMs: 0, privateTrackerHosts: [], fetchImpl: q.fetch, ...over,
})

describe('login on qBittorrent 5.2 and 5.1', () => {
  it('logs in on 5.2.2 (204, empty body, QBT_SID_18080 cookie) and replays that cookie by name', async () => {
    const q = new FakeQbit('5.2.2')
    expect(await sessionClient(q).ping()).toEqual({ version: 'v5.2.2' })
    expect(q.logins()).toHaveLength(1)
    expect(q.logins()[0]).toMatchObject({
      method: 'POST', cookie: undefined, body: 'username=u&password=p',
      headers: expect.objectContaining({ 'Content-Type': 'application/x-www-form-urlencoded' }),
    })
    // The server called its cookie QBT_SID_18080 and refuses the same value under any other name
    // (A-10), so the only request that can have succeeded is the one that replayed it by that name.
    expect(q.calls()).toHaveLength(1)
    expect(q.calls()[0]!.cookie).toBe(`QBT_SID_18080=${q.minted[0]}`)
  })

  it('logs in on 5.1.2 (200 Ok., SID cookie)', async () => {
    const q = new FakeQbit('5.1.2')
    expect(await sessionClient(q).ping()).toEqual({ version: 'v5.1.2' })
    expect(q.logins()).toHaveLength(1)
    expect(q.calls()).toHaveLength(1)
    expect(q.calls()[0]!.cookie).toBe(`SID=${q.minted[0]}`)
  })

  it('form-encodes the credentials, so a password containing & = + % still arrives intact', async () => {
    // A mangled password is a FAILED login, and failed logins are what get an address banned.
    const creds = { user: 'me@example.org', pass: 'p&w=d +%' }
    const q = new FakeQbit('5.1.2', creds)
    await sessionClient(q, creds).ping()
    expect(q.logins()[0]!.body).toBe('username=me%40example.org&password=p%26w%3Dd+%2B%25')
    expect(q.failedLogins).toBe(0) // the server decoded exactly the configured password
  })

  it('treats 5.1.2 "200 Fails." as an auth failure', async () => {
    const q = new FakeQbit('5.1.2')
    const err = await sessionClient(q, { pass: 'definitely-wrong' }).ping().catch((e) => e) // B-11
    expect(err).toBeInstanceOf(ConnectorError)
    expect((err as ConnectorError).kind).toBe('auth')
    expect(q.calls()).toEqual([]) // no session, so the API was never tried
    expect(q.failedLogins).toBe(1)
  })

  it('treats 5.2.2 401 as an auth failure', async () => {
    const q = new FakeQbit('5.2.2')
    const err = await sessionClient(q, { pass: 'definitely-wrong' }).ping().catch((e) => e) // A-11
    expect(err).toBeInstanceOf(ConnectorError)
    expect((err as ConnectorError).kind).toBe('auth')
    expect((err as ConnectorError).status).toBe(401)
    expect(q.calls()).toEqual([])
    expect(q.failedLogins).toBe(1)
  })

  it('treats a login answer it does not recognise as a bad-response, never as a success', async () => {
    // e.g. a reverse proxy's own sign-in page answering 200 in qBittorrent's place, and setting a
    // cookie of its own whose name happens to contain SID: a cookie alone proves no login happened
    const f = vi.fn(async () => plain(200, '<html>Please sign in</html>', 'SID=proxy-session; path=/'))
    const err = (await client(f as unknown as typeof fetch).ping().catch((e) => e)) as ConnectorError
    expect(err).toBeInstanceOf(ConnectorError)
    expect(err.kind).toBe('bad-response')
    expect(f).toHaveBeenCalledTimes(1) // and no API call went out on that "session"
  })

  it('a 403 that does not say "banned" is a plain refusal: remembered for the login window, not the ban window', async () => {
    // e.g. a reverse proxy refusing the request, or qBittorrent's own host-header validation
    const f = vi.fn(async () => plain(403, 'Forbidden'))
    let now = 0
    const c = createQbitClient({
      instanceId: 'box-a', url: 'http://qb:8080', user: 'u', pass: 'p', concurrency: 1, minDelayMs: 0,
      privateTrackerHosts: [], fetchImpl: f as unknown as typeof fetch, now: () => now,
    })
    const err = (await c.ping().catch((e) => e)) as ConnectorError
    expect(err.kind).toBe('auth')
    expect(err.message).not.toMatch(/banned/i)
    now += QBIT_LOGIN_BACKOFF_MS - 1
    await c.ping().catch(() => undefined)
    expect(f).toHaveBeenCalledTimes(1)
    now += 1
    await c.ping().catch(() => undefined)
    expect(f).toHaveBeenCalledTimes(2) // the short window, not an hour
  })
})

describe('login backoff and bans', () => {
  it('uses the contract windows: five minutes after a failed login, an hour after a ban', () => {
    expect(QBIT_LOGIN_BACKOFF_MS).toBe(5 * 60_000)
    expect(QBIT_BAN_BACKOFF_MS).toBe(60 * 60_000)
  })

  it('detects a ban (403 + "banned") and makes no login attempt for QBIT_BAN_BACKOFF_MS', async () => {
    const q = new FakeQbit('5.2.2')
    q.banned = true // A-16: five failures from this address already happened, elsewhere
    let now = 1_000_000
    const c = sessionClient(q, { now: () => now })

    const first = (await c.ping().catch((e) => e)) as ConnectorError
    expect(first).toBeInstanceOf(ConnectorError)
    expect(first.kind).toBe('auth')
    expect(first.message).toMatch(/banned/i)
    expect(q.seen).toHaveLength(1) // the one login; nothing else was tried

    // A plain failure's window is shorter than a ban's: the ban is still remembered after it.
    now += QBIT_LOGIN_BACKOFF_MS
    expect(((await c.ping().catch((e) => e)) as ConnectorError).message).toMatch(/banned/i)
    now += QBIT_BAN_BACKOFF_MS - QBIT_LOGIN_BACKOFF_MS - 1
    expect(((await c.ping().catch((e) => e)) as ConnectorError).message).toMatch(/banned/i)
    expect(q.seen).toHaveLength(1)

    now += 1 // exactly QBIT_BAN_BACKOFF_MS after the ban was seen
    await c.ping().catch(() => undefined)
    expect(q.logins()).toHaveLength(2)
  })

  it.each(FLAVORS)(
    'after a failed login, makes no further login attempt for QBIT_LOGIN_BACKOFF_MS (%s)',
    async (flavor) => {
      // (The brief titles this one QBIT_BAN_BACKOFF_MS but asks for QBIT_LOGIN_BACKOFF_MS on a plain
      // failure; a ban's longer window is pinned by the test above.)
      const q = new FakeQbit(flavor)
      let now = 5_000
      const c = sessionClient(q, { pass: 'definitely-wrong', now: () => now })

      const first = (await c.ping().catch((e) => e)) as ConnectorError
      expect(first.kind).toBe('auth')
      expect(q.seen).toHaveLength(1)

      // Every kind of call, over and over, inside the window: not one more request of any sort.
      for (let i = 0; i < 5; i += 1) {
        const again = (await (i % 2 ? c.ping() : c.torrents()).catch((e) => e)) as ConnectorError
        expect(again.kind).toBe('auth')
        expect(again.message).toBe(first.message) // the remembered error, not a fresh failure
      }
      now += QBIT_LOGIN_BACKOFF_MS - 1
      await c.ping().catch(() => undefined)
      expect(q.seen).toHaveLength(1)
      expect(q.failedLogins).toBe(1)

      now += 1 // the window is over: exactly one more attempt, which fails and is remembered in turn
      await c.ping().catch(() => undefined)
      await c.ping().catch(() => undefined)
      expect(q.logins()).toHaveLength(2)
      expect(q.failedLogins).toBe(2)
    },
  )

  it.each(FLAVORS)('a refused re-login after the session lapses is remembered too (%s)', async (flavor) => {
    const q = new FakeQbit(flavor)
    let now = 10_000
    const c = sessionClient(q, { now: () => now })
    await c.ping() // logged in
    q.expireSessions()
    q.password = 'changed on the server' // the session lapsed and the password is no longer the configured one

    const first = (await c.ping().catch((e) => e)) as ConnectorError
    expect(first.kind).toBe('auth')
    expect(q.logins()).toHaveLength(2) // the first login and the one refused renewal
    for (let i = 0; i < 5; i += 1) await c.torrents().catch(() => undefined)
    expect(q.logins()).toHaveLength(2)

    now += QBIT_LOGIN_BACKOFF_MS
    await c.ping().catch(() => undefined)
    expect(q.logins()).toHaveLength(3)
    expect(q.failedLogins).toBe(2)
  })

  it.each(FLAVORS)('a wrong password costs one failed login however many calls are in flight (%s)', async (flavor) => {
    const q = new FakeQbit(flavor)
    const c = sessionClient(q, { pass: 'definitely-wrong' })
    const outcomes = await Promise.allSettled([c.ping(), c.torrents(), c.ping(), c.torrents()])
    for (const o of outcomes) {
      expect(o.status).toBe('rejected')
      expect(((o as PromiseRejectedResult).reason as ConnectorError).kind).toBe('auth')
    }
    expect(q.failedLogins).toBe(1) // five of these in one burst would have been a one-hour ban
  })

  it.each(FLAVORS)('concurrent first calls share one login (%s)', async (flavor) => {
    const q = new FakeQbit(flavor)
    const c = sessionClient(q)
    const results = await Promise.all([c.ping(), c.torrents(), c.ping(), c.torrents()])
    expect(results[0]).toEqual({ version: `v${flavor}` })
    expect(results[1]).toHaveLength(1)
    expect(q.logins()).toHaveLength(1)
    expect(q.calls().map((r) => r.cookie)).toEqual(Array(4).fill(`${q.cookieName}=${q.minted[0]}`))
  })

  it.each(FLAVORS)('requests that all find the session expired share one re-login (%s)', async (flavor) => {
    const q = new FakeQbit(flavor)
    const c = sessionClient(q)
    await c.ping()
    q.expireSessions()
    const results = await Promise.all([c.ping(), c.torrents(), c.ping(), c.torrents()])
    expect(results[0]).toEqual({ version: `v${flavor}` })
    expect(q.logins()).toHaveLength(2) // the first login and ONE renewal, not one per request
  })

  it.each(FLAVORS)('a request refused late finds the session already renewed and retries with it (%s)', async (flavor) => {
    const q = new FakeQbit(flavor)
    // One torrents() answer is held back: the server refuses it at once, but the refusal reaches the
    // client only after another request has finished renewing the session.
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    let holdNext = true
    const lagging = (async (url: string | URL, init?: RequestInit) => {
      const answer = q.fetch(url, init)
      if (holdNext && new URL(String(url)).pathname === '/api/v2/torrents/info') {
        holdNext = false
        await held
      }
      return answer
    }) as unknown as typeof fetch
    const c = sessionClient(q, { fetchImpl: lagging })
    await c.ping() // the first login
    q.expireSessions()

    const late = c.torrents() // sent with the old session; its refusal is held back
    await c.ping() // sent with the old session too: refused, renews the session, retries
    expect(q.logins()).toHaveLength(2)
    release()
    expect(await late).toHaveLength(1)

    // The late request must retry with the session that replaced its own: it does not log in a
    // third time, and above all does not throw away a session other requests are already using.
    expect(q.logins()).toHaveLength(2)
    const [first, second] = q.minted
    expect(q.calls().filter((r) => r.path === '/api/v2/torrents/info').map((r) => r.cookie)).toEqual([
      `${q.cookieName}=${first}`, `${q.cookieName}=${second}`,
    ])
  })

  it.each([
    ['a network error', (): Response => { throw new Error('ECONNREFUSED') }],
    ['an HTTP 503 from a proxy in front', (): Response => plain(503, 'Service Unavailable')],
  ])('%s on the login is not a failed login: no backoff, the next call tries again', async (_name, failOnce) => {
    const q = new FakeQbit('5.2.2')
    let tries = 0
    const flaky = (async (url: string | URL, init?: RequestInit) => {
      if (new URL(String(url)).pathname === LOGIN_PATH && (tries += 1) === 1) return failOnce()
      return q.fetch(url, init)
    }) as unknown as typeof fetch
    const c = sessionClient(q, { fetchImpl: flaky })

    const first = (await c.ping().catch((e) => e)) as ConnectorError
    expect(first).toBeInstanceOf(ConnectorError)
    expect(first.kind).toBe('unreachable')
    expect(await c.ping()).toEqual({ version: 'v5.2.2' }) // straight away: the server never judged the credentials
    expect(q.failedLogins).toBe(0)
  })

  it('a login that succeeds but sets no session cookie is a bad-response, remembered for the login window', async () => {
    let now = 0
    let logins = 0
    const f = (async (url: string | URL) => {
      if (new URL(String(url)).pathname === LOGIN_PATH) { logins += 1; return plain(204, null) }
      return plain(200, 'v5.2.2')
    }) as unknown as typeof fetch
    const c = createQbitClient({
      instanceId: 'box-a', url: 'http://qb:8080', user: 'u', pass: 'p', concurrency: 1, minDelayMs: 0,
      privateTrackerHosts: [], fetchImpl: f, now: () => now,
    })
    expect(((await c.ping().catch((e) => e)) as ConnectorError).kind).toBe('bad-response')
    expect(((await c.ping().catch((e) => e)) as ConnectorError).kind).toBe('bad-response')
    expect(logins).toBe(1) // the second call was answered from memory
    now += QBIT_LOGIN_BACKOFF_MS
    await c.ping().catch(() => undefined)
    expect(logins).toBe(2)
  })
})

// =============================================================================================
// A login the server keeps refusing
//
// A window alone only SLOWS a wrong password down. qBittorrent bans an address after FIVE failed
// logins in total (the count does not fade with time; only an accepted login or the ban's own
// expiry clears it), and the Dockerfile HEALTHCHECK hits /healthz every 30 s, which pings every
// instance: with one attempt per 5-minute window the fifth failure lands 20 minutes in and the
// address, with Sonarr and Radarr behind it, is banned for an hour, again and again. So a client
// that has been refused twice in a row stops trying altogether; only a rebuilt client (a restart,
// which is also how corrected credentials reach it) tries again.
// =============================================================================================

describe('a login the server keeps refusing', () => {
  const HOUR = 3_600_000
  const YEAR = 365 * 24 * HOUR

  it('allows two refusals in a row and no more', () => {
    expect(QBIT_MAX_CONSECUTIVE_REJECTIONS).toBe(2) // 5 is the server's limit; this leaves room for every other caller
  })

  it.each(FLAVORS)(
    'a wrong password nobody fixes costs two failed logins, however long it is probed (%s)',
    async (flavor) => {
      const q = new FakeQbit(flavor)
      let now = 0
      const c = sessionClient(q, { pass: 'definitely-wrong', now: () => now })

      // The container health check, every 30 s for three hours (the unfixed client reaches the ban in 20 minutes).
      let last: ConnectorError | undefined
      for (; now <= 3 * HOUR; now += 30_000) last = (await c.ping().catch((e) => e)) as ConnectorError

      expect(q.failedLogins).toBe(2)
      expect(q.banned).toBe(false) // the address was never put at risk
      expect(q.seen).toHaveLength(2) // two logins and nothing else: every later call was answered from memory
      expect(last).toBeInstanceOf(ConnectorError)
      expect(last!.kind).toBe('auth')
      expect(last!.message).toMatch(/restart/i) // the remembered answer says what will bring it back

      // No expiry: the clock running on for a year does not buy a third attempt.
      now += YEAR
      for (const call of [() => c.ping(), () => c.torrents(), () => c.files('h1'), () => c.deleteWithData(['h1'])]) {
        expect(((await call().catch((e) => e)) as ConnectorError).kind).toBe('auth')
      }
      expect(q.seen).toHaveLength(2)
      expect(q.failedLogins).toBe(2)
    },
  )

  it('counts a plain 403 as a refusal too: a proxy may send it, but twice is not transient', async () => {
    let now = 0
    const f = vi.fn(async () => plain(403, 'Forbidden'))
    const c = createQbitClient({
      instanceId: 'box-a', url: 'http://qb:8080', user: 'u', pass: 'p', concurrency: 1, minDelayMs: 0,
      privateTrackerHosts: [], fetchImpl: f as unknown as typeof fetch, now: () => now,
    })
    for (let i = 0; i < 50; i += 1, now += QBIT_LOGIN_BACKOFF_MS) await c.ping().catch(() => undefined)
    expect(f).toHaveBeenCalledTimes(2)
  })

  it.each(FLAVORS)('an accepted login clears the count; a later refusal is just a pause again (%s)', async (flavor) => {
    const q = new FakeQbit(flavor)
    let now = 0
    const c = sessionClient(q, { now: () => now })

    q.password = 'changed on the server'
    expect(((await c.ping().catch((e) => e)) as ConnectorError).kind).toBe('auth') // refusal 1
    q.password = 'p' // the operator put the configured password back
    now += QBIT_LOGIN_BACKOFF_MS
    expect(await c.ping()).toEqual({ version: `v${flavor}` }) // accepted: back to zero

    q.expireSessions()
    q.password = 'changed again'
    expect(((await c.ping().catch((e) => e)) as ConnectorError).kind).toBe('auth') // refusal 1 again, NOT refusal 2
    now += QBIT_LOGIN_BACKOFF_MS
    await c.ping().catch(() => undefined) // so this attempt is still allowed ...
    expect(q.logins()).toHaveLength(4)

    now += YEAR // ... and it was the second in a row: now it is over
    await c.ping().catch(() => undefined)
    expect(q.logins()).toHaveLength(4)
  })

  it('a login the server accepts but sets no session on still clears the count', async () => {
    let now = 0
    let logins = 0
    let answer: () => Response = () => plain(401, 'Unauthorized')
    const f = (async (url: string | URL) => {
      if (new URL(String(url)).pathname !== LOGIN_PATH) return plain(200, 'v5.2.2')
      logins += 1
      return answer()
    }) as unknown as typeof fetch
    const c = createQbitClient({
      instanceId: 'box-a', url: 'http://qb:8080', user: 'u', pass: 'p', concurrency: 1, minDelayMs: 0,
      privateTrackerHosts: [], fetchImpl: f, now: () => now,
    })

    await c.ping().catch(() => undefined) // refusal 1
    answer = () => plain(204, null) // accepted, but no cookie came with it
    now += QBIT_LOGIN_BACKOFF_MS
    expect(((await c.ping().catch((e) => e)) as ConnectorError).kind).toBe('bad-response')
    answer = () => plain(401, 'Unauthorized')
    now += QBIT_LOGIN_BACKOFF_MS
    await c.ping().catch(() => undefined) // refusal 1 again, not 2 ...
    now += QBIT_LOGIN_BACKOFF_MS
    await c.ping().catch(() => undefined) // ... so one more attempt is allowed
    expect(logins).toBe(4)

    now += YEAR
    await c.ping().catch(() => undefined)
    expect(logins).toBe(4)
  })

  it('trouble reaching the server in between neither counts as a refusal nor clears the count', async () => {
    // Only an ACCEPTED login clears the count. Were a dropped connection to clear it, a flaky link
    // would reset it between every two refusals and the failed logins would never stop.
    const q = new FakeQbit('5.2.2')
    let now = 0
    let dropNextLogin = false
    const flaky = (async (url: string | URL, init?: RequestInit) => {
      if (new URL(String(url)).pathname === LOGIN_PATH && dropNextLogin) {
        dropNextLogin = false
        throw new Error('ECONNREFUSED')
      }
      return q.fetch(url, init)
    }) as unknown as typeof fetch
    const c = sessionClient(q, { pass: 'definitely-wrong', now: () => now, fetchImpl: flaky })

    await c.ping().catch(() => undefined) // refusal 1
    now += QBIT_LOGIN_BACKOFF_MS
    dropNextLogin = true
    expect(((await c.ping().catch((e) => e)) as ConnectorError).kind).toBe('unreachable') // no answer, nothing judged
    await c.ping().catch(() => undefined) // nothing was remembered, so straight away: refusal 2, the last
    expect(q.failedLogins).toBe(2)

    now += YEAR
    await c.ping().catch(() => undefined)
    expect(q.failedLogins).toBe(2) // the dropped connection did not buy a third failed login
  })

  it('a ban in between neither counts as a refusal nor clears the count', async () => {
    const q = new FakeQbit('5.2.2')
    let now = 0
    const c = sessionClient(q, { pass: 'definitely-wrong', now: () => now })

    await c.ping().catch(() => undefined) // refusal 1
    q.banned = true // other callers behind this address burnt the rest of the allowance
    now += QBIT_LOGIN_BACKOFF_MS
    expect(((await c.ping().catch((e) => e)) as ConnectorError).message).toMatch(/banned/i)
    q.banned = false // an hour later the ban has run out
    now += QBIT_BAN_BACKOFF_MS
    await c.ping().catch(() => undefined) // refusal 2: the ban did not wipe refusal 1 ...
    expect(q.logins()).toHaveLength(3)

    now += YEAR // ... so this was the last attempt
    await c.ping().catch(() => undefined)
    expect(q.logins()).toHaveLength(3)
  })

  it('an answer it cannot read is not a refused credential: it never ends the attempts', async () => {
    // e.g. a proxy's sign-in page answering in qBittorrent's place. Nothing was judged about the
    // credentials (nothing reached qBittorrent's counter), and the operator fixes the proxy without
    // touching Jellymaid, so the client keeps trying once per window and recovers by itself.
    let now = 0
    let broken = true
    let logins = 0
    const f = (async (url: string | URL) => {
      if (new URL(String(url)).pathname !== LOGIN_PATH) return plain(200, 'v5.2.2')
      logins += 1
      return broken ? plain(200, '<html>Please sign in</html>') : plain(204, null, 'QBT_SID_18080=abc; path=/')
    }) as unknown as typeof fetch
    const c = createQbitClient({
      instanceId: 'box-a', url: 'http://qb:8080', user: 'u', pass: 'p', concurrency: 1, minDelayMs: 0,
      privateTrackerHosts: [], fetchImpl: f, now: () => now,
    })
    for (let i = 0; i < 6; i += 1, now += QBIT_LOGIN_BACKOFF_MS) {
      expect(((await c.ping().catch((e) => e)) as ConnectorError).kind).toBe('bad-response')
    }
    expect(logins).toBe(6) // one per window, with no limit
    broken = false
    expect(await c.ping()).toEqual({ version: 'v5.2.2' })
  })
})

describe('session cookie jar', () => {
  it('updates the session cookie when any response sets a new one', async () => {
    const q = new FakeQbit('5.2.2', { bypass: true })
    const c = sessionClient(q)
    await c.ping() // logs in (S1), then the call carries S1
    q.expireSessions() // the server forgets S1 ...
    await c.ping() // ... and, bypassing auth for this address, answers anyway with a fresh session S2 (A-4)
    await c.ping()
    const [s1, s2] = q.minted
    expect(q.minted).toHaveLength(2)
    expect(q.calls().map((r) => r.cookie)).toEqual([
      `QBT_SID_18080=${s1}`, `QBT_SID_18080=${s1}`, `QBT_SID_18080=${s2}`,
    ])
    expect(q.logins()).toHaveLength(1) // a 200 is no reason to log in again
  })

  it('keeps only session cookies, whatever else the server sets', async () => {
    const sent: Array<string | undefined> = []
    const f = (async (url: string | URL, init?: RequestInit) => {
      sent.push((init?.headers as Record<string, string>).Cookie)
      if (new URL(String(url)).pathname !== LOGIN_PATH) return plain(200, 'v5.2.2')
      const headers = new Headers() // two separate Set-Cookie lines, as a real server sends them
      headers.append('set-cookie', 'theme=dark; path=/')
      headers.append('set-cookie', 'QBT_SID_18080=abc123; HttpOnly; SameSite=Lax; expires=Tue, 27-Oct-2026 22:53:17 GMT; path=/')
      return new Response(null, { status: 204, headers })
    }) as unknown as typeof fetch
    await client(f).ping()
    expect(sent[1]).toBe('QBT_SID_18080=abc123')
  })

  it('forgets a session cookie the server clears, and logs in again for the next call', async () => {
    // B-13 / A-13: a cleared session arrives as `Set-Cookie: <name>=; expires=<past>`.
    let logins = 0
    let apiCalls = 0
    const sent: Array<string | undefined> = []
    const f = (async (url: string | URL, init?: RequestInit) => {
      sent.push((init?.headers as Record<string, string>).Cookie)
      if (new URL(String(url)).pathname === LOGIN_PATH) {
        logins += 1
        return plain(204, null, `QBT_SID_18080=session${logins}; HttpOnly; path=/`)
      }
      apiCalls += 1
      return apiCalls === 1
        ? plain(200, 'v5.2.2', 'QBT_SID_18080=; expires=Mon, 26-Oct-2026 21:53:17 GMT; path=/')
        : plain(200, 'v5.2.2')
    }) as unknown as typeof fetch
    const c = client(f)
    await c.ping()
    await c.ping()
    expect(logins).toBe(2)
    expect(sent.filter((cookie) => cookie !== undefined)).toEqual(['QBT_SID_18080=session1', 'QBT_SID_18080=session2'])
  })
})

describe('without credentials', () => {
  // A login with no credentials can only fail, and failed logins are what get this host's address
  // banned. An instance that bypasses auth for this host answers without a session.
  it.each(FLAVORS)('never calls auth/login and reports 403 as auth: "requires credentials" (%s)', async (flavor) => {
    const q = new FakeQbit(flavor) // an instance that needs a login: no session, so 403 (A-7, B-7)
    const c = sessionClient(q, { user: null, pass: null })

    const err = (await c.ping().catch((e) => e)) as ConnectorError
    expect(err).toBeInstanceOf(ConnectorError)
    expect(err.kind).toBe('auth')
    expect(err.status).toBe(403)
    expect(err.message).toMatch(/requires credentials/i)

    // It stays that way: every further call is one plain request, never a login loop.
    for (const call of [() => c.torrents(), () => c.ping(), () => c.torrents()]) {
      expect(((await call().catch((e) => e)) as ConnectorError).message).toMatch(/requires credentials/i)
    }
    expect(q.logins()).toEqual([])
    expect(q.calls()).toHaveLength(4)
  })

  it('does not log in when only one half of the credentials is present', async () => {
    // Config loading refuses this combination; the client must not guess at the missing half either.
    const q = new FakeQbit('5.2.2')
    const err = (await sessionClient(q, { user: 'u', pass: null }).ping().catch((e) => e)) as ConnectorError
    expect(err.kind).toBe('auth')
    expect(q.logins()).toEqual([])
  })

  it.each(FLAVORS)('works unauthenticated against an instance that bypasses authentication for this host (%s)', async (flavor) => {
    const q = new FakeQbit(flavor, { bypass: true })
    const c = sessionClient(q, { user: null, pass: null })
    expect(await c.torrents()).toHaveLength(1)
    expect(await c.ping()).toEqual({ version: `v${flavor}` })
    expect(q.logins()).toEqual([])
    // It used the session the server gave it on the first call instead of making a new one per call (A-4..A-6).
    expect(q.minted).toHaveLength(1)
  })
})

describe('torrents() and ping() on the recorded servers', () => {
  it('normalizes hash to lowercase and carries instanceId, rootPath, addedOn', async () => {
    // 5.2.2: a movie folder; the hash is upper-cased here to prove it is lowercased on the way out
    const a = new FakeQbit('5.2.2', {
      torrents: [{ ...RECORDED_TORRENT['5.2.2'], hash: 'AD3B30ED6755698F8DC7E17B74F73F53E83E1556' }],
    })
    const fromA = (await sessionClient(a, { instanceId: 'box-a' }).torrents())[0]!
    expect(fromA).toMatchObject({
      instanceId: 'box-a', hash: 'ad3b30ed6755698f8dc7e17b74f73f53e83e1556',
      rootPath: '/path/to/boxA/movies/Night.of.the.Living.Dead.1968.1080p.BluRay.x264-HARNESS',
      addedOn: 1793137674, isPrivate: true, privacySource: 'flag', trackerHost: 'tracker.private.example',
    })
    // 5.1.2: a single file; root_path "" must stay "" (null would mean "not reported")
    const b = new FakeQbit('5.1.2')
    const fromB = (await sessionClient(b, { instanceId: 'box-b' }).torrents())[0]!
    expect(fromB).toMatchObject({
      instanceId: 'box-b', hash: 'b9b17e40cba809723737a4eea9491a3a6581fc04', rootPath: '', addedOn: 1793137676,
    })
  })

  it('ping returns the app/version text', async () => {
    expect(await sessionClient(new FakeQbit('5.2.2')).ping()).toEqual({ version: 'v5.2.2' }) // A-4
    expect(await sessionClient(new FakeQbit('5.1.2')).ping()).toEqual({ version: 'v5.1.2' }) // B-4
    // whitespace around the text is not part of the version
    expect(await client(stub({ '/app/version': 'v5.2.2\n' })).ping()).toEqual({ version: 'v5.2.2' })
  })
})

describe('privateTrackerHosts as a live list', () => {
  const unflagged = { ...RAW[0], tracker: 'http://tracker.private.example/announce' } // no `private` field: only the list can say

  it('takes a plain list', async () => {
    const t = (await client(stub({ '/torrents/info': [unflagged] }), ['tracker.private.example']).torrents())[0]!
    expect(t).toMatchObject({ isPrivate: true, privacySource: 'host-list' })
  })

  it('takes a getter, evaluated on every torrents() call, so an edited list applies without a restart', async () => {
    let hosts: string[] = []
    let evaluations = 0
    const c = client(stub({ '/torrents/info': [unflagged] }), () => { evaluations += 1; return hosts })

    expect((await c.torrents())[0]!.privacySource).toBe('undetermined')
    hosts = ['Tracker.Private.Example'] // edited in Settings; hosts match case-insensitively
    expect((await c.torrents())[0]!.privacySource).toBe('host-list')
    hosts = [] // and taking a host back out applies as promptly
    expect((await c.torrents())[0]!.privacySource).toBe('undetermined')
    expect(evaluations).toBe(3)
  })

  it('evaluates the getter once per call, not once per torrent', async () => {
    let evaluations = 0
    const many = Array.from({ length: 5 }, (_, i) => ({ ...unflagged, hash: `h${i}` }))
    const c = client(stub({ '/torrents/info': many }), () => { evaluations += 1; return ['tracker.private.example'] })
    expect(await c.torrents()).toHaveLength(5)
    expect(evaluations).toBe(1)
  })

  it('fails torrents() when the getter throws, rather than quietly classifying with an empty list', async () => {
    const c = client(stub({ '/torrents/info': [unflagged] }), () => { throw new Error('config.json is invalid') })
    await expect(c.torrents()).rejects.toThrow('config.json is invalid')
  })
})

// Ruling 18: the scan worker builds fresh clients for every scan, so a login block held by the
// long-lived main-thread clients would reset each night unless the runner can ask for it.
describe('loginBlocked', () => {
  it.each(FLAVORS)('is true while a refused login is remembered, and false again once the window has passed (%s)', async (flavor) => {
    const q = new FakeQbit(flavor)
    let now = 5_000
    const c = sessionClient(q, { pass: 'definitely-wrong', now: () => now })
    expect(c.loginBlocked()).toBe(false)

    await c.ping().catch(() => undefined)
    expect(c.loginBlocked()).toBe(true)
    now += QBIT_LOGIN_BACKOFF_MS - 1
    expect(c.loginBlocked()).toBe(true)
    now += 1
    expect(c.loginBlocked()).toBe(false)
    // Asking is free: it never touches the network.
    expect(q.seen).toHaveLength(1)
  })

  it('stays true for good once the credentials have been refused too often in a row', async () => {
    const q = new FakeQbit('5.2.2')
    let now = 0
    const c = sessionClient(q, { pass: 'definitely-wrong', now: () => now })
    for (let i = 0; i < QBIT_MAX_CONSECUTIVE_REJECTIONS; i += 1) {
      await c.ping().catch(() => undefined)
      now += QBIT_LOGIN_BACKOFF_MS
    }
    expect(q.failedLogins).toBe(QBIT_MAX_CONSECUTIVE_REJECTIONS)
    now += 365 * 24 * 3_600_000
    expect(c.loginBlocked()).toBe(true)
  })

  it('is true for the ban window after a ban', async () => {
    const q = new FakeQbit('5.2.2')
    q.banned = true
    let now = 0
    const c = sessionClient(q, { now: () => now })
    await c.ping().catch(() => undefined)
    now += QBIT_BAN_BACKOFF_MS - 1
    expect(c.loginBlocked()).toBe(true)
    now += 1
    expect(c.loginBlocked()).toBe(false)
  })

  it('is false once a login has been accepted, and for a client that never logs in', async () => {
    const accepted = sessionClient(new FakeQbit('5.1.2'))
    await accepted.ping()
    expect(accepted.loginBlocked()).toBe(false)
    const anonymous = sessionClient(new FakeQbit('5.2.2', { bypass: true }), { user: null, pass: null })
    await anonymous.ping()
    expect(anonymous.loginBlocked()).toBe(false)
  })
})
