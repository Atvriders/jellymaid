import { HttpClient, ConnectorError } from './http.js'

export interface ArrRecord {
  kind: 'radarr' | 'sonarr'
  instance: string
  remoteId: number
  title: string
  arrPath: string | null
  monitored: boolean
  seriesId: number | null
  episodeId: number | null
  episodeFileId: number | null
}

export interface ArrClientOptions {
  url: string
  apiKey: string
  concurrency: number
  minDelayMs: number
  instance?: string
  fetchImpl?: typeof fetch
  /** Held by the caller for the client's whole lifetime; see HttpClientOptions.signal. */
  signal?: AbortSignal
  /**
   * Called once per unit of work skipped due to a connector failure — currently just a Sonarr
   * series whose per-series fetch failed. A partial inventory must never be silently
   * indistinguishable from a complete one. This module has no logger dependency of its own
   * (matching the other connectors), so — as with `logger` elsewhere in this codebase — the
   * caller decides where the message goes; the scan phase wires this to the real logger and its
   * own counts.
   */
  onProblem?: (message: string) => void
}

/**
 * Three states, not a boolean, because a later executor is fail-closed: an unmonitor that did not
 * happen must skip the file's deletion, or the *arr simply re-downloads what was just removed.
 *
 *  - `unmonitored`  — the record was found and the flip was accepted.
 *  - `not-managed`  — a COMPLETE inventory was fetched and this path is genuinely not in it, so
 *                     there is nothing to unmonitor and the delete may proceed.
 *  - `lookup-failed`— we could not tell. The inventory fetch failed, or came back partial (a
 *                     Sonarr series whose per-series fetch was skipped), or the record was found
 *                     but carries nothing to unmonitor. "Not found in an incomplete list" and
 *                     "not there" are the same value from a boolean's point of view, which is
 *                     exactly the confusion that lets a monitored file be deleted.
 */
export interface UnmonitorResult {
  outcome: 'unmonitored' | 'not-managed' | 'lookup-failed'
  recordId: number | null
}

export interface ArrClient {
  inventory(): Promise<ArrRecord[]>
  unmonitorByPath(path: string): Promise<UnmonitorResult>
  ping(): Promise<void>
}

function makeHttp(opts: ArrClientOptions, service: string) {
  return new HttpClient({
    service,
    baseUrl: opts.url,
    concurrency: opts.concurrency,
    minDelayMs: opts.minDelayMs,
    defaultHeaders: { 'X-Api-Key': opts.apiKey, 'Content-Type': 'application/json' },
    fetchImpl: opts.fetchImpl,
    signal: opts.signal,
  })
}

interface RawMovie { id: number; title?: string; monitored?: boolean; path?: string; movieFile?: { path?: string } }

export function createRadarrClient(opts: ArrClientOptions): ArrClient {
  const http = makeHttp(opts, 'radarr')
  const instance = opts.instance ?? 'radarr'

  const load = async (): Promise<Array<{ raw: RawMovie; rec: ArrRecord }>> => {
    const movies = await http.request<RawMovie[]>('/api/v3/movie')
    return movies.map((m) => ({
      raw: m,
      rec: {
        kind: 'radarr' as const, instance, remoteId: m.id, title: m.title ?? '',
        arrPath: m.movieFile?.path ?? m.path ?? null,
        monitored: Boolean(m.monitored), seriesId: null, episodeId: null, episodeFileId: null,
      },
    }))
  }

  return {
    async inventory() { return (await load()).map((x) => x.rec) },

    async unmonitorByPath(path) {
      let all
      try {
        all = await load()
      } catch (err) {
        // A failed fetch is "I could not look", never "it is not there". Only a connector
        // failure is downgraded this way; a programming error still propagates, as in the
        // Sonarr client below.
        if (!(err instanceof ConnectorError)) throw err
        opts.onProblem?.(`movie inventory: ${err.message}`)
        return { outcome: 'lookup-failed', recordId: null }
      }
      const hit = all.find((x) => x.rec.arrPath === path)
      if (!hit) return { outcome: 'not-managed', recordId: null }
      // PUT the whole record back with monitored flipped — Radarr replaces the document.
      await http.request(`/api/v3/movie/${hit.raw.id}`, {
        method: 'PUT',
        body: JSON.stringify({ ...hit.raw, monitored: false }),
      }, 'none')
      return { outcome: 'unmonitored', recordId: hit.raw.id }
    },

    async ping() { await http.request('/api/v3/system/status') },
  }
}

interface RawSeries { id: number; title?: string; monitored?: boolean; path?: string }
interface RawEpisodeFile { id: number; seriesId: number; path?: string }
interface RawEpisode { id: number; seriesId: number; episodeFileId?: number; monitored?: boolean; title?: string }

export function createSonarrClient(opts: ArrClientOptions): ArrClient {
  const http = makeHttp(opts, 'sonarr')
  const instance = opts.instance ?? 'sonarr'

  /**
   * Per-series failures are isolated rather than aborting the whole walk: a rejected
   * unmonitorByPath lookup makes the later executor skip that file's deletion entirely
   * (fail-closed by design), so one flaky series must not silently block unmonitoring — and
   * therefore deletion — of every unrelated file in the library. Only a ConnectorError (the two
   * HTTP calls' only failure mode) is treated as "this series is unreachable right now" and
   * skipped; anything else — a programming error such as a TypeError from a wrong assumption
   * about the API shape — propagates instead of being downgraded to a skipped series. A skipped
   * series is reported via `onProblem`, never swallowed silently.
   *
   * `complete` says whether every series was actually read. `unmonitorByPath` needs it to tell
   * "this path is not managed by Sonarr" from "this path is not in the part of Sonarr I managed
   * to read" — the same distinction, one file at a time, that `onProblem` reports in aggregate.
   */
  const load = async (): Promise<{ records: ArrRecord[]; complete: boolean }> => {
    const series = await http.request<RawSeries[]>('/api/v3/series')
    const out: ArrRecord[] = []
    let complete = true
    for (const s of series) {
      try {
        const [files, episodes] = await Promise.all([
          http.request<RawEpisodeFile[]>(`/api/v3/episodefile?seriesId=${s.id}`),
          http.request<RawEpisode[]>(`/api/v3/episode?seriesId=${s.id}`),
        ])
        const episodeByFile = new Map<number, RawEpisode>()
        for (const e of episodes) if (e.episodeFileId) episodeByFile.set(e.episodeFileId, e)
        for (const f of files) {
          const ep = episodeByFile.get(f.id)
          out.push({
            kind: 'sonarr', instance, remoteId: f.id, title: ep?.title ?? s.title ?? '',
            arrPath: f.path ?? null, monitored: Boolean(ep?.monitored),
            seriesId: s.id, episodeId: ep?.id ?? null, episodeFileId: f.id,
          })
        }
      } catch (err) {
        if (!(err instanceof ConnectorError)) throw err
        complete = false
        opts.onProblem?.(`series ${s.id} (${s.title ?? 'untitled'}): ${err.message}`)
      }
    }
    return { records: out, complete }
  }

  return {
    async inventory() { return (await load()).records },

    async unmonitorByPath(path) {
      let loaded
      try {
        loaded = await load()
      } catch (err) {
        // The series list itself failed — nothing at all was read.
        if (!(err instanceof ConnectorError)) throw err
        opts.onProblem?.(`series inventory: ${err.message}`)
        return { outcome: 'lookup-failed', recordId: null }
      }
      const hit = loaded.records.find((r) => r.arrPath === path)
      if (!hit) {
        // Absent from a COMPLETE inventory means genuinely not managed here; absent from a
        // partial one means only that we never looked at part of the library.
        return { outcome: loaded.complete ? 'not-managed' : 'lookup-failed', recordId: null }
      }
      if (!hit.episodeId) {
        // Sonarr does manage this file, but the episode it belongs to could not be resolved, so
        // there is no episode to unmonitor. Deleting it anyway is how a file comes straight back.
        return { outcome: 'lookup-failed', recordId: null }
      }
      await http.request('/api/v3/episode/monitor', {
        method: 'PUT',
        body: JSON.stringify({ episodeIds: [hit.episodeId], monitored: false }),
      }, 'none')
      return { outcome: 'unmonitored', recordId: hit.episodeId }
    },

    async ping() { await http.request('/api/v3/system/status') },
  }
}
