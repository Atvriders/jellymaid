import { HttpClient, ConnectorError, type HttpRequestInit } from './http.js'
import type { QbitInstanceConfig } from '../config/schema.js'

const SERVICE = 'qbittorrent'
const LOGIN_PATH = '/api/v2/auth/login'

/**
 * How `isPrivate` was decided:
 *  - 'flag': the qBittorrent version reported the `private` field explicitly (trusted either way).
 *  - 'host-list': no explicit field, but the tracker host matched the configured private-host list.
 *  - 'undetermined': neither signal was available. Forced to isPrivate: true (fail safe) — this
 *    is the case a later guard should surface to the operator ("add this tracker to
 *    privateTrackerHosts or upgrade qBittorrent"), since it silently over-applies the ratio
 *    guard rather than under-applying it.
 */
export type PrivacySource = 'flag' | 'host-list' | 'undetermined'

export interface Torrent {
  /** The instance that reported this torrent — the only one that may ever be asked to delete it. */
  instanceId: string
  hash: string                  // lowercased
  name: string
  savePath: string | null
  contentPath: string | null
  rootPath: string | null       // '' for a single-file torrent on 5.x; null when not reported
  category: string | null
  tags: string[]
  state: string
  ratio: number
  seedingTimeSeconds: number
  isPrivate: boolean
  privacySource: PrivacySource
  trackerHost: string | null
  sizeBytes: number
  progress: number
  addedOn: number | null        // unix seconds
}

export interface TorrentFile { index: number; relPath: string; sizeBytes: number }

export interface QbitClientOptions {
  instanceId: string
  url: string
  /** Both or neither (config loading refuses exactly one). Neither = never log in; see `call`. */
  user: string | null
  pass: string | null
  concurrency: number
  minDelayMs: number
  /**
   * The operator's private-tracker hosts. A getter is evaluated on every `torrents()` call, so a list
   * edited in Settings applies to the next read without a restart; a plain array is fixed for the
   * client's life. A getter that throws fails that `torrents()` call, which is deliberate: an
   * unreadable list must not pass for an empty one.
   */
  privateTrackerHosts: string[] | (() => string[])
  fetchImpl?: typeof fetch
  /** Held by the caller for the client's whole lifetime; see HttpClientOptions.signal. */
  signal?: AbortSignal
  now?: () => number            // injectable clock for login backoff
}

/**
 * Login backoff windows: after a failed login no further attempt for QBIT_LOGIN_BACKOFF_MS, after a
 * ban for QBIT_BAN_BACKOFF_MS. qBittorrent bans the caller's address for an hour after five failed
 * logins, so retrying on every request is how a wrong password becomes an outage.
 */
export const QBIT_LOGIN_BACKOFF_MS = 300_000
export const QBIT_BAN_BACKOFF_MS = 3_600_000

/**
 * How many times in a row the server may refuse the login before this client stops trying for good.
 *
 * The windows above only SLOW a wrong password down, they do not stop it. qBittorrent counts failed
 * logins per address and the count does not fade with time (an accepted login clears it, and so
 * does the end of a ban), and the container health check calls /healthz every 30 s, which pings
 * every instance. A client that retried once per window would therefore spend its fifth failure
 * about 20 minutes after the first, and the address, with Sonarr and Radarr behind it, would sit
 * banned for an hour at a time, over and over. So after this many refusals in a row the remembered
 * error is returned with no expiry: only a client that is built again (for the long-lived ones, a
 * restart, which is also how corrected credentials reach them) tries a login again.
 *
 * Two is the first try plus one retry, for a password that was only just changed on the server.
 * Refused twice with a pause between, credentials are wrong, not unlucky, and every further attempt
 * only spends an allowance of five that every other caller behind the address shares.
 *
 * What counts as a refusal: `401`, `200 Fails.`, and a `403` that does not say "banned" (a refusal
 * from a layer in front is indistinguishable from one from qBittorrent, and the same answer twice
 * is not transient). What does not count: a ban (it has its own, longer window), an answer this
 * client cannot read (nothing judged the credentials, and a front proxy gets repaired without
 * touching Jellymaid), and trouble reaching the server at all. Only an accepted login clears the count.
 */
export const QBIT_MAX_CONSECUTIVE_REJECTIONS = 2

interface RawTorrent {
  hash: string; name?: string; save_path?: string; content_path?: string; root_path?: string
  category?: string; tags?: string; state?: string; ratio?: number; seeding_time?: number
  size?: number; progress?: number; tracker?: string; private?: boolean; added_on?: number
}

function hostOf(tracker: string | undefined): string | null {
  if (!tracker) return null
  try { return new URL(tracker).hostname } catch { return null }
}

/** A session cookie as the server set it: `name=value`, attributes dropped. */
interface SessionCookie { name: string; value: string }

/**
 * Every session cookie a response sets: each `Set-Cookie` whose NAME contains `SID`.
 *
 * qBittorrent calls its cookie `SID` up to 5.1 and `QBT_SID_<WebUI port>` from 5.2, and 5.2 refuses
 * the same value under any other name (the value sent back as `SID` gets a 403), so the name is the server's choice and is kept
 * verbatim instead of being matched against a literal. Any other cookie, such as one a reverse proxy
 * in front sets for itself, is not ours to keep.
 *
 * `getSetCookie()` hands back the header lines separately, but a line can still hold several cookies
 * joined with ", " (how `get('set-cookie')` and some fakes present repeats), so each line is split
 * again — only at a comma followed by `name=`: the comma inside `expires=Tue, 27-Oct-2026 ...` is
 * followed by a date, not a name, and must survive.
 */
function sessionCookiesOf(headers: Headers): SessionCookie[] {
  const cookies: SessionCookie[] = []
  for (const line of headers.getSetCookie()) {
    for (const cookie of line.split(/,(?=\s*[^;,=\s]+=)/)) {
      const pair = cookie.split(';', 1)[0] ?? ''
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      const name = pair.slice(0, eq).trim()
      if (name.includes('SID')) cookies.push({ name, value: pair.slice(eq + 1).trim() })
    }
  }
  return cookies
}

type LoginVerdict = 'accepted' | 'rejected' | 'banned' | 'unrecognized'

/**
 * What a login answer means, from its status and body (measured against real 5.2.2 and 5.1.2 servers):
 *  - 5.2: success is `204` with no body; wrong credentials are `401`.
 *  - 5.1 and before: success is `200 Ok.`, and wrong credentials are ALSO a `200`, with the body
 *    `Fails.` — so the status alone proves nothing, and a check for a 2xx would log a wrong password in.
 *  - After five failures from this address, both answer `403` with text saying it is banned. Any
 *    other 403 is just a refusal.
 * Anything else is not an answer this client understands. It is never taken for a success.
 */
function classifyLogin(status: number, body: string): LoginVerdict {
  const text = body.trim()
  if (status === 204) return 'accepted'
  if (status === 200) {
    if (/^ok\.?$/i.test(text)) return 'accepted'
    if (/^fails\.?$/i.test(text)) return 'rejected'
    return 'unrecognized'
  }
  if (status === 401) return 'rejected'
  if (status === 403) return /banned/i.test(text) ? 'banned' : 'rejected'
  return 'unrecognized'
}

const minutes = (ms: number): number => Math.round(ms / 60_000)

export interface QbitClient {
  readonly instanceId: string
  torrents(): Promise<Torrent[]>
  files(hash: string): Promise<TorrentFile[]>
  trackers(hash: string): Promise<string[]>
  deleteWithData(hashes: string[]): Promise<void>
  awaitGone(hashes: string[], opts?: { timeoutMs?: number; pollMs?: number }): Promise<boolean>
  ping(): Promise<{ version: string }>
  /**
   * True while this client is holding off logging in: a login was refused, banned or answered
   * unreadably, and its window has not passed — or the credentials were refused
   * QBIT_MAX_CONSECUTIVE_REJECTIONS times in a row, which lasts until restart. Every call that
   * needs a session fails at once meanwhile. Answered from memory; never touches the network.
   *
   * The scan runner reads it before each scan (Ruling 18): the scan worker builds fresh clients, so
   * without it every scan would start with no memory of a refusal and spend another failed login.
   */
  loginBlocked(): boolean
}

/** Every configured instance's client, keyed by instance id. */
export type QbitClients = ReadonlyMap<string, QbitClient>

/**
 * One client per instance, each with its own session, its own rate-limit gate and its own id —
 * so a delete grouped under an instance id can only ever reach that instance's own WebUI.
 */
export function createQbitClients(
  instances: QbitInstanceConfig[],
  common: Omit<QbitClientOptions, 'instanceId' | 'url' | 'user' | 'pass'>,
): QbitClients {
  return new Map(instances.map((i) => [
    i.id,
    createQbitClient({ ...common, instanceId: i.id, url: i.url, user: i.user, pass: i.pass }),
  ]))
}

/**
 * Fail-closed precedence: an explicit `private` field is trusted in BOTH directions (it's
 * authoritative). Absent that, a host-list match proves private. Absent BOTH — no explicit
 * field and no list match — privacy is undetermined, and undetermined must mean private:
 * older qBittorrent versions don't report `private` at all, and `privateTrackerHosts` is a
 * human-maintained list that will always lag reality. Treating "not on the list" as proof of
 * "public" would silently drop the ratio guard on exactly the private torrents it exists to
 * protect. A blocked delete is recoverable; a hit-and-run on a private tracker is not.
 */
function classifyPrivacy(
  raw: RawTorrent,
  host: string | null,
  privateHosts: ReadonlySet<string>,
): { isPrivate: boolean; privacySource: PrivacySource } {
  if (typeof raw.private === 'boolean') return { isPrivate: raw.private, privacySource: 'flag' }
  if (host && privateHosts.has(host.toLowerCase())) return { isPrivate: true, privacySource: 'host-list' }
  return { isPrivate: true, privacySource: 'undetermined' }
}

export function createQbitClient(opts: QbitClientOptions): QbitClient {
  const now = opts.now ?? Date.now
  // Without credentials there is nothing to log in WITH: a login attempt could only fail, and
  // every failure counts towards qBittorrent's one-hour ban on this host's address. An instance
  // that bypasses authentication for this host answers without a session; one that does not
  // answers 403, which surfaces as an `auth` error from the request itself.
  const credentials = opts.user !== null && opts.pass !== null
    ? { username: opts.user, password: opts.pass }
    : null

  const http = new HttpClient({
    service: SERVICE,
    baseUrl: opts.url,
    concurrency: opts.concurrency,
    minDelayMs: opts.minDelayMs,
    fetchImpl: opts.fetchImpl,
    signal: opts.signal,
  })

  // ---- Session --------------------------------------------------------------------------------
  // Five failed logins from one address ban it for an hour, for EVERY client behind that address,
  // and a banned address is refused on every endpoint. So the rules below are safety properties, not
  // conveniences: at most one login is ever in flight, after the server has answered a login without
  // accepting it no further attempt is made until the backoff window has passed, and once the server
  // has refused the credentials QBIT_MAX_CONSECUTIVE_REJECTIONS times in a row no further attempt is
  // made at all (see that constant for why a window alone is not enough).

  /**
   * The session cookies the server has handed out, by name, replayed verbatim. A real jar, kept by
   * hand: undici (Node's fetch) ignores `credentials: 'include'` and stores nothing, so without an
   * explicit `Cookie` header every request after the login would arrive unauthenticated.
   */
  const jar = new Map<string, string>()
  /**
   * Set when a login was answered but not accepted: until when to stay quiet, and what to say
   * meanwhile. `until` is Infinity once the credentials have been refused too often in a row, so
   * the block outlives any clock: it lasts as long as this client object does.
   */
  let loginBlock: { until: number; error: ConnectorError } | null = null
  /** Logins in a row the server refused (see QBIT_MAX_CONSECUTIVE_REJECTIONS); an accepted one resets it to zero. */
  let rejections = 0
  /** The one login under way, shared by every caller that needs a session in the meantime. */
  let loginInFlight: Promise<void> | null = null

  const cookieHeader = (): string => [...jar].map(([name, value]) => `${name}=${value}`).join('; ')

  /** An empty value is how a server clears a session (a logout answers `Set-Cookie: <name>=; expires=<past>`): drop it instead of replaying nothing. */
  function absorb(cookies: SessionCookie[]): void {
    for (const { name, value } of cookies) {
      if (value === '') jar.delete(name)
      else jar.set(name, value)
    }
  }

  /**
   * Remembers a login the server answered without accepting, for `windowMs` (Infinity = for good).
   * Returns the error so the caller can throw it.
   */
  function block(windowMs: number, error: ConnectorError): ConnectorError {
    loginBlock = { until: now() + windowMs, error }
    return error
  }

  async function login(creds: { username: string; password: string }): Promise<void> {
    // Read in the hook, which runs before HttpClient looks at the status. A 401/403 is thrown with
    // its body already cancelled, and a ban differs from a plain refusal only by that body, so the
    // text of a 403 is taken from a clone (which stays readable after the original is cancelled).
    const seen: { status: number; cookies: SessionCookie[]; refusal: Promise<string> | null } =
      { status: 0, cookies: [], refusal: null }
    let text = ''
    try {
      text = await http.request<string>(LOGIN_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: opts.url },
        body: new URLSearchParams(creds).toString(),
        onResponse: (res) => {
          seen.status = res.status
          seen.cookies = sessionCookiesOf(res.headers)
          if (res.status === 403) seen.refusal = res.clone().text().catch(() => '')
        },
      }, 'text')
    } catch (err) {
      // Only an answer about THESE credentials is remembered. No answer at all (unreachable, timeout,
      // cancelled), a 5xx or a 429 say nothing about them, and qBittorrent counts failed logins, not
      // failed connections: the next call may try again at once.
      if (!(err instanceof ConnectorError) || (err.kind !== 'auth' && err.kind !== 'bad-response')) throw err
      text = seen.refusal ? await seen.refusal : ''
    }

    const verdict = classifyLogin(seen.status, text)
    if (verdict === 'accepted') {
      // The server took these credentials, which also clears ITS count of failures for this address,
      // so ours starts again from zero — even if the answer then turns out to carry no session.
      rejections = 0
      const session = seen.cookies.filter((c) => c.value !== '')
      if (session.length === 0) {
        throw block(QBIT_LOGIN_BACKOFF_MS, new ConnectorError(
          'bad-response', SERVICE,
          `instance "${opts.instanceId}" accepted the login (HTTP ${seen.status}) but set no session cookie; `
          + `not trying again for ${minutes(QBIT_LOGIN_BACKOFF_MS)} minutes`,
          seen.status,
        ))
      }
      jar.clear() // a new session replaces whatever was held
      absorb(session)
      loginBlock = null
      return
    }
    if (verdict === 'banned') {
      throw block(QBIT_BAN_BACKOFF_MS, new ConnectorError(
        'auth', SERVICE,
        `instance "${opts.instanceId}" has banned this host's address after too many failed logins (HTTP 403); `
        + `not trying again for ${minutes(QBIT_BAN_BACKOFF_MS)} minutes`,
        403,
      ))
    }
    const wait = `not trying again for ${minutes(QBIT_LOGIN_BACKOFF_MS)} minutes`
    if (verdict === 'rejected') {
      rejections += 1
      const final = rejections >= QBIT_MAX_CONSECUTIVE_REJECTIONS
      const rejected = `rejected the login (HTTP ${seen.status}${seen.status === 200 ? ' "Fails."' : ''})`
      // A final block never expires: it is the one thing standing between a wrong password and a ban.
      throw block(final ? Number.POSITIVE_INFINITY : QBIT_LOGIN_BACKOFF_MS, new ConnectorError(
        'auth', SERVICE,
        final
          ? `instance "${opts.instanceId}" ${rejected} ${rejections} times in a row; check the username and password; `
            + 'not trying again until Jellymaid is restarted'
          : `instance "${opts.instanceId}" ${rejected}; check the username and password; ${wait}`,
        seen.status,
      ))
    }
    throw block(QBIT_LOGIN_BACKOFF_MS, new ConnectorError(
      'bad-response', SERVICE,
      `instance "${opts.instanceId}" answered the login with HTTP ${seen.status} and nothing that says accepted or refused; ${wait}`,
      seen.status,
    ))
  }

  /** Makes sure there is a session, logging in at most once however many callers ask at the same time. */
  async function ensureSession(creds: { username: string; password: string }): Promise<void> {
    if (jar.size > 0) return
    if (loginBlock) {
      // The remembered answer; the network is not touched. A final block's `until` is Infinity.
      if (now() < loginBlock.until) throw loginBlock.error
      loginBlock = null
    }
    loginInFlight ??= login(creds).finally(() => { loginInFlight = null })
    await loginInFlight
  }

  /**
   * A request was refused: qBittorrent drops sessions silently and answers 403. `stale` is the cookie
   * header that request carried. Several requests usually find out together, so the dead session is
   * dropped only if it is still the one held and nobody is renewing it: a login in flight is joined
   * (inside `ensureSession`), and a session that already replaced `stale` is used as it is.
   */
  async function renewSession(creds: { username: string; password: string }, stale: string): Promise<void> {
    if (!loginInFlight && cookieHeader() === stale) jar.clear()
    await ensureSession(creds)
  }

  function withSession(init: HttpRequestInit, cookie: string): HttpRequestInit {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined), Referer: opts.url }
    // The session mechanism: qBittorrent authenticates by this cookie, not by Referer.
    if (cookie) headers.Cookie = cookie
    // Any response may set a new session (a bypassed client gets one on every cookie-less call, and
    // an expired one is replaced), so every response is read, not only the login's.
    return { ...init, headers, onResponse: (res) => absorb(sessionCookiesOf(res.headers)) }
  }

  async function call<T>(path: string, init: HttpRequestInit = {}, parse: 'json' | 'text' | 'none' = 'json'): Promise<T> {
    if (credentials) await ensureSession(credentials)
    const sent = cookieHeader()
    try {
      return await http.request<T>(path, withSession(init, sent), parse)
    } catch (err) {
      if (!(err instanceof ConnectorError) || err.kind !== 'auth') throw err
      if (!credentials) {
        // Never log in without credentials (see above). Here a 401/403 means this instance wants a login
        // this client has nothing to make. (It could also mean this address is banned; only a login
        // answer can tell those apart, and there is none to read.)
        throw new ConnectorError(
          'auth', SERVICE,
          `HTTP ${err.status ?? 403}: instance "${opts.instanceId}" requires credentials and none are configured`,
          err.status,
        )
      }
      // qBittorrent expires sessions silently; a 403 means "log in again", not "wrong password".
      // Renewed once, and the retry is not renewed again: a second refusal is the answer.
      await renewSession(credentials, sent)
      return await http.request<T>(path, withSession(init, cookieHeader()), parse)
    }
  }

  return {
    instanceId: opts.instanceId,

    async torrents() {
      // One snapshot of the list per call, taken before the request: a throwing getter then fails fast.
      const privateHosts = new Set(
        (typeof opts.privateTrackerHosts === 'function' ? opts.privateTrackerHosts() : opts.privateTrackerHosts)
          .map((h) => h.toLowerCase()),
      )
      const raw = await call<RawTorrent[]>('/api/v2/torrents/info')
      return raw.map((t) => {
        const trackerHost = hostOf(t.tracker)
        const { isPrivate, privacySource } = classifyPrivacy(t, trackerHost, privateHosts)
        return {
          instanceId: opts.instanceId,
          // Lowercased once, here, so every key built from it downstream agrees (see torrentKey).
          hash: t.hash.toLowerCase(),
          name: t.name ?? '',
          savePath: t.save_path ?? null,
          contentPath: t.content_path ?? null,
          // Kept verbatim, '' included: on 5.x an EMPTY root path is how qBittorrent says "a single
          // file with no folder of its own", which is not the same as "not reported" (null).
          rootPath: typeof t.root_path === 'string' ? t.root_path : null,
          category: t.category?.length ? t.category : null,
          tags: (t.tags ?? '').split(',').map((s) => s.trim()).filter(Boolean),
          state: t.state ?? 'unknown',
          ratio: t.ratio ?? 0,
          seedingTimeSeconds: t.seeding_time ?? 0,
          isPrivate,
          privacySource,
          trackerHost,
          sizeBytes: t.size ?? 0,
          progress: t.progress ?? 0,
          addedOn: typeof t.added_on === 'number' && t.added_on > 0 ? t.added_on : null,
        }
      })
    },

    async files(hash) {
      const raw = await call<Array<{ index?: number; name?: string; size?: number }>>(
        `/api/v2/torrents/files?hash=${encodeURIComponent(hash)}`,
      )
      return raw.map((f, i) => ({ index: f.index ?? i, relPath: f.name ?? '', sizeBytes: f.size ?? 0 }))
    },

    async trackers(hash) {
      const raw = await call<Array<{ url?: string }>>(`/api/v2/torrents/trackers?hash=${encodeURIComponent(hash)}`)
      return raw.map((t) => t.url ?? '').filter(Boolean)
    },

    async deleteWithData(hashes) {
      if (!hashes.length) throw new Error('deleteWithData called with no torrent hashes')
      const body = new URLSearchParams({ hashes: hashes.join('|'), deleteFiles: 'true' }).toString()
      await call('/api/v2/torrents/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      }, 'text')
    },

    async awaitGone(hashes, awaitOpts = {}) {
      const timeoutMs = awaitOpts.timeoutMs ?? 60_000
      const pollMs = awaitOpts.pollMs ?? 1000
      const deadline = Date.now() + timeoutMs
      const wanted = new Set(hashes.map((h) => h.toLowerCase()))
      while (Date.now() < deadline) {
        const present = await call<RawTorrent[]>('/api/v2/torrents/info')
        if (!present.some((t) => wanted.has(t.hash.toLowerCase()))) return true
        await new Promise((r) => setTimeout(r, pollMs))
      }
      return false
    },

    async ping() {
      const version = await call<string>('/api/v2/app/version', {}, 'text')
      return { version: version.trim() }
    },

    loginBlocked() {
      return loginBlock !== null && now() < loginBlock.until
    },
  }
}
