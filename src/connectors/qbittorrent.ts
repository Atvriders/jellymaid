import { HttpClient, ConnectorError } from './http.js'

export interface Torrent {
  hash: string
  name: string
  savePath: string | null
  contentPath: string | null
  category: string | null
  tags: string[]
  state: string
  ratio: number
  seedingTimeSeconds: number
  isPrivate: boolean
  trackerHost: string | null
  sizeBytes: number
  progress: number
}

export interface TorrentFile { index: number; relPath: string; sizeBytes: number }

export interface QbitClientOptions {
  url: string
  user: string
  pass: string
  concurrency: number
  minDelayMs: number
  privateTrackerHosts: string[]
  fetchImpl?: typeof fetch
}

interface RawTorrent {
  hash: string; name?: string; save_path?: string; content_path?: string
  category?: string; tags?: string; state?: string; ratio?: number; seeding_time?: number
  size?: number; progress?: number; tracker?: string; private?: boolean
}

function hostOf(tracker: string | undefined): string | null {
  if (!tracker) return null
  try { return new URL(tracker).hostname } catch { return null }
}

export interface QbitClient {
  torrents(): Promise<Torrent[]>
  files(hash: string): Promise<TorrentFile[]>
  trackers(hash: string): Promise<string[]>
  deleteWithData(hashes: string[]): Promise<void>
  awaitGone(hashes: string[], opts?: { timeoutMs?: number; pollMs?: number }): Promise<boolean>
  ping(): Promise<void>
}

export function createQbitClient(opts: QbitClientOptions): QbitClient {
  let sid: string | null = null
  const privateHosts = new Set(opts.privateTrackerHosts.map((h) => h.toLowerCase()))

  const http = new HttpClient({
    service: 'qbittorrent',
    baseUrl: opts.url,
    concurrency: opts.concurrency,
    minDelayMs: opts.minDelayMs,
    fetchImpl: opts.fetchImpl,
  })

  async function login(): Promise<void> {
    const body = new URLSearchParams({ username: opts.user, password: opts.pass }).toString()
    const raw = await http.request<string>('/api/v2/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: opts.url },
      body,
    }, 'text')
    if (!raw.includes('Ok')) throw new ConnectorError('auth', 'qbittorrent', 'login rejected')
    sid = 'authenticated'
  }

  /** qBittorrent expires sessions silently; a 403 means "log in again", not "wrong password". */
  async function call<T>(path: string, init: RequestInit = {}, parse: 'json' | 'text' | 'none' = 'json'): Promise<T> {
    if (!sid) await login()
    try {
      return await http.request<T>(path, withCookie(init), parse)
    } catch (err) {
      if (err instanceof ConnectorError && err.kind === 'auth') {
        sid = null
        await login()
        return await http.request<T>(path, withCookie(init), parse)
      }
      throw err
    }
  }

  function withCookie(init: RequestInit): RequestInit {
    return { ...init, credentials: 'include', headers: { ...(init.headers as Record<string, string>), Referer: opts.url } }
  }

  function isPrivate(raw: RawTorrent, host: string | null): boolean {
    if (typeof raw.private === 'boolean') return raw.private
    if (host && privateHosts.has(host.toLowerCase())) return true
    if (!host) return true // undeterminable → treat as private
    return false
  }

  return {
    async torrents() {
      const raw = await call<RawTorrent[]>('/api/v2/torrents/info')
      return raw.map((t) => {
        const trackerHost = hostOf(t.tracker)
        return {
          hash: t.hash,
          name: t.name ?? '',
          savePath: t.save_path ?? null,
          contentPath: t.content_path ?? null,
          category: t.category?.length ? t.category : null,
          tags: (t.tags ?? '').split(',').map((s) => s.trim()).filter(Boolean),
          state: t.state ?? 'unknown',
          ratio: t.ratio ?? 0,
          seedingTimeSeconds: t.seeding_time ?? 0,
          isPrivate: isPrivate(t, trackerHost),
          trackerHost,
          sizeBytes: t.size ?? 0,
          progress: t.progress ?? 0,
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

    async ping() { await call('/api/v2/app/version', {}, 'text') },
  }
}
