import { HttpClient } from './http.js'

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
}

export interface ArrClient {
  inventory(): Promise<ArrRecord[]>
  unmonitorByPath(path: string): Promise<{ unmonitored: boolean; recordId: number | null }>
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
      const all = await load()
      const hit = all.find((x) => x.rec.arrPath === path)
      if (!hit) return { unmonitored: false, recordId: null }
      // PUT the whole record back with monitored flipped — Radarr replaces the document.
      await http.request(`/api/v3/movie/${hit.raw.id}`, {
        method: 'PUT',
        body: JSON.stringify({ ...hit.raw, monitored: false }),
      }, 'none')
      return { unmonitored: true, recordId: hit.raw.id }
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
   * therefore deletion — of every unrelated file in the library. Failures are still surfaced via
   * `problems`, never swallowed: a quietly incomplete inventory would be worse than a loud one.
   */
  const load = async (): Promise<{ records: ArrRecord[]; problems: string[] }> => {
    const series = await http.request<RawSeries[]>('/api/v3/series')
    const out: ArrRecord[] = []
    const problems: string[] = []
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
        problems.push(`series ${s.id} (${s.title ?? 'untitled'}): ${(err as Error).message}`)
      }
    }
    if (problems.length) {
      console.error(`[sonarr] inventory incomplete — ${problems.length} series skipped:\n${problems.join('\n')}`)
    }
    return { records: out, problems }
  }

  return {
    async inventory() { return (await load()).records },

    async unmonitorByPath(path) {
      const { records } = await load()
      const hit = records.find((r) => r.arrPath === path)
      if (!hit?.episodeId) return { unmonitored: false, recordId: null }
      await http.request('/api/v3/episode/monitor', {
        method: 'PUT',
        body: JSON.stringify({ episodeIds: [hit.episodeId], monitored: false }),
      }, 'none')
      return { unmonitored: true, recordId: hit.episodeId }
    },

    async ping() { await http.request('/api/v3/system/status') },
  }
}
