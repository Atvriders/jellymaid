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
const CLIENT_HEADER =
  'MediaBrowser Client="Jellymaid", Device="Jellymaid", DeviceId="jellymaid-server", Version="1.0.0"'

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
  authenticateByName(username: string, password: string): Promise<{ userId: string; token: string; isAdministrator: boolean }>
  virtualFolders(): Promise<JellyfinLibrary[]>
  items(opts: { startIndex: number; limit: number }): Promise<{ items: JellyfinItem[]; totalRecordCount: number }>
  /**
   * Jellyfin's LIVE view of one item, or null when it no longer has it. The delete executor gates
   * `deleteItem` on this: the index is a scan-time snapshot, and a Merge Versions performed outside
   * Jellymaid since then turns what looks like a sibling-free primary into a merged item whose
   * other versions `DELETE /Items/{id}` would take with it.
   */
  getItem(id: string): Promise<JellyfinItem | null>
  mergeVersions(ids: string[]): Promise<void>
  splitVersions(id: string): Promise<void>
  deleteItem(id: string): Promise<void>
  refreshLibrary(): Promise<void>
  ping(): Promise<void>
}

export function createJellyfinClient(opts: JellyfinClientOptions): JellyfinClient {
  const http = new HttpClient({
    service: 'jellyfin',
    baseUrl: opts.url,
    concurrency: opts.concurrency,
    minDelayMs: opts.minDelayMs,
    defaultHeaders: { 'X-Emby-Token': opts.apiKey, 'Content-Type': 'application/json' },
    fetchImpl: opts.fetchImpl,
    signal: opts.signal,
  })

  return {
    async authenticateByName(username, password) {
      const auth = await http.request<{ User?: { Id: string }; AccessToken?: string }>(
        '/Users/AuthenticateByName',
        {
          method: 'POST',
          headers: { Authorization: CLIENT_HEADER, 'X-Emby-Token': '' },
          body: JSON.stringify({ Username: username, Pw: password }),
        },
      )
      // Fail closed on a missing token instead of relying on Jellyfin treating the empty
      // X-Emby-Token below as "no token". If it ever fell back to the service API key instead,
      // /Users/Me would report the API KEY OWNER's IsAdministrator and every Jellyfin user
      // would be admitted as an admin. Classified 'bad-response', NOT 'auth': this is a
      // malformed reply, not evidence the credentials were wrong, so src/api/auth.ts's login
      // route must fail closed (never proceed to /Users/Me) WITHOUT counting it against the
      // caller's lockout — a malfunctioning Jellyfin must not lock operators out of their own
      // cleanup tool.
      if (!auth.AccessToken) {
        throw new ConnectorError('bad-response', 'jellyfin', 'authentication returned no access token')
      }
      const token = auth.AccessToken
      const userId = auth.User?.Id ?? ''
      try {
        const me = await http.request<{ Policy?: { IsAdministrator?: boolean } }>('/Users/Me', {
          headers: { 'X-Emby-Token': token },
        })
        return { userId, token, isAdministrator: Boolean(me.Policy?.IsAdministrator) }
      } finally {
        // The token exists only to answer "is this an admin". Revoke it immediately.
        await http.request('/Sessions/Logout', { method: 'POST', headers: { 'X-Emby-Token': token } }, 'none')
          .catch(() => undefined)
      }
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

    async getItem(id) {
      // Queried through /Items?Ids=… rather than /Items/{id}: the by-id route is user-scoped on
      // the Jellyfin versions this project supports, while this is the very endpoint the paged
      // scan already uses with the same API key, and it returns the same shape `normalize` reads.
      // IncludeItemTypes is deliberately omitted — the caller asks about a specific id, and a type
      // filter could answer "no such item" for an item that plainly exists.
      const qs = new URLSearchParams({
        Ids: id, Recursive: 'true', Fields: ITEM_FIELDS, EnableTotalRecordCount: 'false',
      })
      const raw = await http.request<{ Items?: RawItem[] }>(`/Items?${qs.toString()}`)
      const first = raw.Items?.[0]
      return first ? normalize(first) : null
    },

    async mergeVersions(ids) {
      if (ids.length < 2) throw new Error('mergeVersions requires at least two ids')
      await http.request(`/Videos/MergeVersions?Ids=${encodeURIComponent(ids.join(','))}`, { method: 'POST' }, 'none')
    },

    async splitVersions(id) {
      await http.request(`/Videos/${encodeURIComponent(id)}/AlternateSources`, { method: 'DELETE' }, 'none')
    },

    async deleteItem(id) {
      await http.request(`/Items/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'none')
    },

    async refreshLibrary() {
      await http.request('/Library/Refresh', { method: 'POST' }, 'none')
    },

    async ping() {
      await http.request('/System/Info', {}, 'json')
    },
  }
}
