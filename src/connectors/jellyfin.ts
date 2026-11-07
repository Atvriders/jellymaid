import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HttpClient, ConnectorError } from './http.js'

export interface JellyfinLibrary { id: string; name: string; collectionType: string | null; locations: string[] }

export interface JellyfinItem {
  id: string
  type: string
  name: string
  sortName: string | null
  year: number | null
  seriesId: string | null
  seriesName: string | null
  seasonNo: number | null
  episodeNo: number | null
  providerIds: Record<string, string>
  jfPath: string | null
  /**
   * Every non-empty `MediaSources[].Path`, deduplicated, including the primary source. Once two
   * items are merged via `mergeVersions`, `/Items?Recursive=true` stops returning the alternate
   * version as its own item row — it only survives inside the surviving item's `MediaSources[]`.
   * `jfPath` (the item's own top-level `Path`) is only ONE of these; without capturing the rest,
   * an alternate version's physical file becomes indistinguishable from a genuine orphan to
   * `fs.orphan-media`, even though Jellyfin still knows it and can still play it.
   */
  mediaSourcePaths: string[]
  sizeBytes: number | null
  runtimeTicks: number | null
  container: string | null
  videoCodec: string | null
  audioCodec: string | null
  audioChannels: number | null
  width: number | null
  height: number | null
  bitrate: number | null
  /**
   * The video stream's colour range exactly as Jellyfin reports it — 'SDR', 'HDR10', 'HLG',
   * 'Dolby Vision', … — or null when this Jellyfin does not report one. Never inferred from the
   * codec or the resolution: an absent signal is absent, and the keeper score treats it as such.
   */
  videoRange: string | null
  /** Whether the item carries any subtitle stream (embedded), per Jellyfin's own stream list. */
  hasSubtitles: boolean
  hasPrimaryImage: boolean
  dateCreated: string | null
  mediaSourceId: string | null
}

export interface JellyfinClientOptions {
  url: string
  apiKey: string
  concurrency: number
  minDelayMs: number
  fetchImpl?: typeof fetch
  /** Held by the caller for the client's whole lifetime; see HttpClientOptions.signal. */
  signal?: AbortSignal
}

const ITEM_FIELDS = 'Path,ProviderIds,MediaSources,MediaStreams,DateCreated,ParentId,ProductionYear,SortName'
const ITEM_TYPES = 'Movie,Episode,Series,Season'

/** Jellyfin's `/Library/Media/Updated` body is one POST; this keeps any single one a sane size. */
const NOTIFY_CHUNK = 200

/**
 * The `version` of the nearest package.json above this module: the repository root when run from
 * source, `/app` in the image (whose build copies package.json beside `dist/`). Read once.
 */
const PACKAGE_VERSION = ((): string => {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const candidate = join(dir, 'package.json')
    if (existsSync(candidate)) {
      try {
        const version = (JSON.parse(readFileSync(candidate, 'utf8')) as { version?: unknown }).version
        if (typeof version === 'string') return version
      } catch { /* unreadable: keep looking further up */ }
    }
    const parent = dirname(dir)
    if (parent === dir) return '0.0.0'
    dir = parent
  }
})()

/** `MediaBrowser Client="Jellymaid", Device="Jellymaid", DeviceId="<deviceId>", Version="<pkg version>"`
 *  plus `, Token="<token>"` when a token is given. deviceId defaults to "jellymaid-server". */
export function jellyfinAuthHeader(opts: { token?: string | null; deviceId?: string }): string {
  const base = `MediaBrowser Client="Jellymaid", Device="Jellymaid", DeviceId="${opts.deviceId ?? 'jellymaid-server'}", Version="${PACKAGE_VERSION}"`
  return opts.token ? `${base}, Token="${opts.token}"` : base
}

/**
 * The key two spellings of a username share when Jellyfin could resolve both to one account.
 * Jellyfin matches usernames case-insensitively, and JavaScript's lower-casing alone does not merge
 * every pair that upper-casing merges (U+017F, the long s, stays apart from `s` when only
 * lower-cased), so this folds through upper case and back: coarser than either step alone. Coarser
 * is the safe direction. Two names wrongly sharing a key cost one extra refused attempt or one
 * shared lockout bucket; a name wrongly kept apart would forward a failed login to the very account
 * the login guard protects, or hand an attacker a way round the lockout.
 */
export function usernameKey(name: string): string {
  return name.toUpperCase().toLowerCase()
}

interface RawStream {
  Type?: string; Codec?: string; Width?: number; Height?: number; Channels?: number
  VideoRange?: string; VideoRangeType?: string
}
interface RawSource { Id?: string; Path?: string; Size?: number; Container?: string; Bitrate?: number; MediaStreams?: RawStream[] }
interface RawItem {
  Id: string; Type?: string; Name?: string; SortName?: string; ProductionYear?: number
  SeriesId?: string; SeriesName?: string; ParentIndexNumber?: number; IndexNumber?: number
  ProviderIds?: Record<string, string>; Path?: string; RunTimeTicks?: number
  ImageTags?: Record<string, string>; DateCreated?: string; MediaSources?: RawSource[]
}
interface RawUser {
  Name?: string
  Policy?: { InvalidLoginAttemptCount?: number; LoginAttemptsBeforeLockout?: number }
}

function normalize(raw: RawItem): JellyfinItem {
  const source = raw.MediaSources?.[0]
  const streams = source?.MediaStreams ?? []
  const video = streams.find((s) => s.Type === 'Video')
  const audio = streams.find((s) => s.Type === 'Audio')
  // `VideoRange` ('SDR' | 'HDR') is the field every supported Jellyfin reports; `VideoRangeType`
  // ('HDR10' | 'HLG' | 'DOVI' | 'Unknown' | …) is the newer, more specific one and is only used as
  // a fallback. Deliberately not the other way round: some versions report a useful VideoRange
  // alongside VideoRangeType='Unknown', and preferring the more specific field there would replace
  // a real answer with a placeholder that reads as "not SDR" downstream. Empty strings are
  // normalized to null — "not reported" and "reported as nothing" are the same absent signal.
  const videoRange = [video?.VideoRange, video?.VideoRangeType]
    .map((v) => v?.trim())
    .find((v) => Boolean(v)) ?? null
  const providerIds: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw.ProviderIds ?? {})) providerIds[k.toLowerCase()] = v
  // Every physical file behind this item, not just the primary. Order doesn't matter downstream
  // (the phase writes one row per path keyed on (item id, jf path)); dedup does, so a source list
  // that happens to repeat a path doesn't produce two identical rows for no reason.
  const mediaSourcePaths = [...new Set(
    (raw.MediaSources ?? []).map((s) => s.Path).filter((p): p is string => Boolean(p)),
  )]
  return {
    id: raw.Id,
    type: raw.Type ?? 'Unknown',
    name: raw.Name ?? '',
    sortName: raw.SortName ?? null,
    year: raw.ProductionYear ?? null,
    seriesId: raw.SeriesId ?? null,
    seriesName: raw.SeriesName ?? null,
    // Season rows carry their own season number in IndexNumber (ParentIndexNumber is unset),
    // unlike Episode rows where IndexNumber is the episode number and ParentIndexNumber is the
    // season. Do not "simplify" this back to a single unconditional mapping.
    seasonNo: raw.Type === 'Season' ? raw.IndexNumber ?? null : raw.ParentIndexNumber ?? null,
    episodeNo: raw.Type === 'Season' ? null : raw.IndexNumber ?? null,
    providerIds,
    jfPath: raw.Path ?? null,
    mediaSourcePaths,
    sizeBytes: source?.Size ?? null,
    runtimeTicks: raw.RunTimeTicks ?? null,
    container: source?.Container ?? null,
    videoCodec: video?.Codec ?? null,
    audioCodec: audio?.Codec ?? null,
    audioChannels: audio?.Channels ?? null,
    width: video?.Width ?? null,
    height: video?.Height ?? null,
    bitrate: source?.Bitrate ?? null,
    videoRange,
    hasSubtitles: streams.some((s) => s.Type === 'Subtitle'),
    hasPrimaryImage: Boolean(raw.ImageTags?.Primary),
    dateCreated: raw.DateCreated ?? null,
    mediaSourceId: source?.Id ?? null,
  }
}

export interface JellyfinClient {
  /** Revokes the token before returning. Admin flag from the AuthenticateByName body. Fresh DeviceId per call. */
  authenticateByName(username: string, password: string): Promise<{ userId: string; isAdministrator: boolean }>
  /** Reads GET /Users with the service key. allowed=false when the (case-insensitive) user exists and one more
   *  failure would disable it: limit = LoginAttemptsBeforeLockout (0 -> 3, <0 -> unlimited), refuse when
   *  InvalidLoginAttemptCount >= limit - 1. Unknown user -> allowed (Jellyfin answers it like a wrong password). */
  loginRisk(username: string): Promise<{ allowed: boolean; reason: string | null }>
  virtualFolders(): Promise<JellyfinLibrary[]>
  /** Sorted SortBy=DateCreated,SortName SortOrder=Ascending. */
  items(opts: { startIndex: number; limit: number }): Promise<{ items: JellyfinItem[]; totalRecordCount: number }>
  mergeVersions(ids: string[]): Promise<void>
  splitVersions(id: string): Promise<void>
  /** POST /Library/Media/Updated {Updates:[{Path, UpdateType:'Deleted'}]}, chunks of 200; [] -> no request. */
  notifyPathsDeleted(jellyfinPaths: string[]): Promise<void>
  /** GET /ScheduledTasks: the task with Key 'RefreshLibrary' is Running or Cancelling. */
  libraryScanRunning(): Promise<boolean>
  ping(): Promise<{ version: string }>
}

export function createJellyfinClient(opts: JellyfinClientOptions): JellyfinClient {
  const http = new HttpClient({
    service: 'jellyfin',
    baseUrl: opts.url,
    concurrency: opts.concurrency,
    minDelayMs: opts.minDelayMs,
    // Jellyfin 12.x answers 401 to X-Emby-Token (and to ?api_key=); only an `Authorization:
    // MediaBrowser … Token="…"` header carries the service key (probe.md, section 2). A request that
    // must NOT act as the service (the login below) replaces this header outright.
    defaultHeaders: { Authorization: jellyfinAuthHeader({ token: opts.apiKey }), 'Content-Type': 'application/json' },
    fetchImpl: opts.fetchImpl,
    signal: opts.signal,
  })

  return {
    async authenticateByName(username, password) {
      // A fresh DeviceId per login. Jellyfin revokes the token it previously issued under the same
      // DeviceId (probe.md 2.6), so with one fixed id two operators logging in at the same moment
      // would revoke each other's token before either had been read.
      const deviceId = `jellymaid-login-${randomUUID()}`
      const auth = await http.request<{
        User?: { Id?: string; Policy?: { IsAdministrator?: unknown } }; AccessToken?: string
      }>(
        '/Users/AuthenticateByName',
        {
          method: 'POST',
          // Replaces the default Authorization header outright, so the service key is not sent: this
          // request checks the USER's credentials and must not be made as the service.
          headers: { Authorization: jellyfinAuthHeader({ deviceId }) },
          body: JSON.stringify({ Username: username, Pw: password }),
        },
      )
      // No token means nothing to revoke and nothing trustworthy in the reply: fail closed.
      // Classified 'bad-response', NOT 'auth': this is a malformed reply, not evidence the
      // credentials were wrong, so src/api/auth.ts's login route must fail closed WITHOUT counting
      // it against the caller's lockout — a malfunctioning Jellyfin must not lock operators out of
      // their own cleanup tool.
      const token = auth.AccessToken
      if (!token) {
        throw new ConnectorError('bad-response', 'jellyfin', 'authentication returned no access token')
      }
      try {
        // The role comes from this very reply. GET /Users/Me is no alternative: with the service key
        // it answers 400 (an API key has no user), and with the user's token it is one more call.
        const isAdministrator = auth.User?.Policy?.IsAdministrator
        // Anything but a boolean cannot answer "is this an administrator?". Not `false`: a reply that
        // says nothing is malformed, which is not a verdict on the credentials (see above).
        if (typeof isAdministrator !== 'boolean') {
          throw new ConnectorError('bad-response', 'jellyfin', 'authentication response does not say whether the user is an administrator')
        }
        return { userId: auth.User?.Id ?? '', isAdministrator }
      } finally {
        // The token exists only to answer "is this an admin". Revoke it before returning, under the
        // DeviceId it was issued to. A failed revocation does not fail a login whose credentials
        // were good: it only leaves a session Jellymaid never uses.
        await http.request(
          '/Sessions/Logout',
          { method: 'POST', headers: { Authorization: jellyfinAuthHeader({ token, deviceId }) } },
          'none',
        ).catch(() => undefined)
      }
    },

    async loginRisk(username) {
      const users = await http.request<RawUser[]>('/Users')
      // A body that is not a list says nothing about this account, and "nothing" must never read as
      // "safe to try": it is a failure the caller treats as Jellyfin being unavailable.
      if (!Array.isArray(users)) {
        throw new ConnectorError('bad-response', 'jellyfin', 'GET /Users did not return a list of users')
      }
      const wanted = usernameKey(username)
      // The most cautious verdict among every account Jellyfin could resolve this name to. It resolves
      // to one; were a list ever to hold more, there is no telling which one it would pick.
      // An unknown name matches none and is allowed: it cannot be disabled, and refusing it here would
      // tell a caller which names exist — Jellyfin answers an unknown user exactly like a wrong password.
      let refusal: string | null = null
      for (const user of users) {
        if (usernameKey(user.Name ?? '') !== wanted) continue
        const configured = user.Policy?.LoginAttemptsBeforeLockout
        // Lockout switched off (-1): no number of failures disables this account.
        if (typeof configured === 'number' && configured < 0) continue
        const failures = user.Policy?.InvalidLoginAttemptCount
        // Without the counter there is no telling how close the account is to being disabled.
        if (typeof failures !== 'number') {
          throw new ConnectorError('bad-response', 'jellyfin', 'user policy does not report InvalidLoginAttemptCount')
        }
        // 0 is the dashboard's "default", which Jellyfin stores and reads back as 3 (probe.md section 4).
        // A policy that names no limit at all is read the same, cautious, way.
        const limit = typeof configured === 'number' && configured > 0 ? configured : 3
        // Jellyfin disables the account when the counter, after the failure it is recording, reaches
        // the limit, so the attempt that starts at limit - 1 is the one that does it.
        if (failures >= limit - 1) {
          refusal ??= `${failures} failed login(s) recorded against a limit of ${limit}; one more would disable the account`
        }
      }
      return refusal === null ? { allowed: true, reason: null } : { allowed: false, reason: refusal }
    },

    async virtualFolders() {
      const raw = await http.request<Array<{ ItemId?: string; Id?: string; Name?: string; CollectionType?: string; Locations?: string[] }>>(
        '/Library/VirtualFolders',
      )
      return raw.map((f) => ({
        id: f.ItemId ?? f.Id ?? f.Name ?? '',
        name: f.Name ?? '',
        collectionType: f.CollectionType ?? null,
        locations: f.Locations ?? [],
      }))
    },

    async items({ startIndex, limit }) {
      const qs = new URLSearchParams({
        Recursive: 'true',
        IncludeItemTypes: ITEM_TYPES,
        Fields: ITEM_FIELDS,
        // Oldest first, ties by name. An item added while a scan is paging lands at the END of this
        // order, so it can neither push an already-fetched item onto a later page (fetched twice) nor
        // pull a not-yet-fetched one back onto an earlier page (never fetched).
        SortBy: 'DateCreated,SortName',
        SortOrder: 'Ascending',
        StartIndex: String(startIndex),
        Limit: String(limit),
        EnableTotalRecordCount: 'true',
      })
      const raw = await http.request<{ Items?: RawItem[]; TotalRecordCount?: number }>(`/Items?${qs.toString()}`)
      return {
        items: (raw.Items ?? []).map(normalize),
        totalRecordCount: raw.TotalRecordCount ?? 0,
      }
    },

    async mergeVersions(ids) {
      if (ids.length < 2) throw new Error('mergeVersions requires at least two ids')
      await http.request(`/Videos/MergeVersions?Ids=${encodeURIComponent(ids.join(','))}`, { method: 'POST' }, 'none')
    },

    async splitVersions(id) {
      await http.request(`/Videos/${encodeURIComponent(id)}/AlternateSources`, { method: 'DELETE' }, 'none')
    },

    async notifyPathsDeleted(jellyfinPaths) {
      // One request per chunk, never retried: a POST is not idempotent by contract, and a lost
      // notification only delays Jellyfin forgetting the item until its next library scan.
      for (let i = 0; i < jellyfinPaths.length; i += NOTIFY_CHUNK) {
        const Updates = jellyfinPaths.slice(i, i + NOTIFY_CHUNK).map((Path) => ({ Path, UpdateType: 'Deleted' }))
        await http.request('/Library/Media/Updated', { method: 'POST', body: JSON.stringify({ Updates }) }, 'none')
      }
    },

    async libraryScanRunning() {
      const tasks = await http.request<Array<{ Key?: string; State?: string }>>('/ScheduledTasks')
      const refresh = tasks.find((t) => t.Key === 'RefreshLibrary')
      return refresh?.State === 'Running' || refresh?.State === 'Cancelling'
    },

    async ping() {
      const info = await http.request<{ Version?: unknown }>('/System/Info', {}, 'json')
      return { version: typeof info.Version === 'string' ? info.Version : 'unknown' }
    },
  }
}
