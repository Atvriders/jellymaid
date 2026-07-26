export type ConnectorErrorKind = 'unreachable' | 'auth' | 'rate-limited' | 'bad-response' | 'timeout'

export class ConnectorError extends Error {
  constructor(
    public readonly kind: ConnectorErrorKind,
    public readonly service: string,
    message: string,
    public readonly status?: number,
  ) {
    super(`[${service}] ${kind}: ${message}`)
    this.name = 'ConnectorError'
  }
}

export interface HttpClientOptions {
  service: string
  baseUrl: string
  concurrency: number
  minDelayMs: number
  maxRetries?: number
  backoffBaseMs?: number
  timeoutMs?: number
  defaultHeaders?: Record<string, string>
  fetchImpl?: typeof fetch
}

/** Serialises work so no more than `concurrency` requests are in flight, with a floor delay between starts. */
class Gate {
  private active = 0
  private queue: Array<() => void> = []
  private lastStart = 0
  constructor(private readonly concurrency: number, private readonly minDelayMs: number) {}

  async acquire(): Promise<void> {
    if (this.active >= this.concurrency) {
      await new Promise<void>((resolve) => this.queue.push(resolve))
    }
    this.active += 1
    const now = Date.now()
    const startAt = Math.max(now, this.lastStart + this.minDelayMs)
    this.lastStart = startAt // reserved synchronously, before any await, so concurrent acquires don't race on a stale value
    const wait = startAt - now
    if (wait > 0) await sleep(wait)
  }

  release(): void {
    this.active -= 1
    this.queue.shift()?.()
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class HttpClient {
  private readonly gate: Gate
  private readonly fetchImpl: typeof fetch

  constructor(private readonly opts: HttpClientOptions) {
    this.gate = new Gate(opts.concurrency, opts.minDelayMs)
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  async request<T>(path: string, init: RequestInit = {}, parse: 'json' | 'text' | 'none' = 'json'): Promise<T> {
    const maxRetries = this.opts.maxRetries ?? 3
    const backoffBase = this.opts.backoffBaseMs ?? 250
    const url = path.startsWith('http') ? path : `${this.opts.baseUrl.replace(/\/$/, '')}${path}`
    let lastError: ConnectorError | null = null

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      await this.gate.acquire()
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 30_000)
      try {
        const res = await this.fetchImpl(url, {
          ...init,
          signal: controller.signal,
          headers: { ...this.opts.defaultHeaders, ...(init.headers as Record<string, string> | undefined) },
        })
        if (res.status === 401 || res.status === 403) {
          await res.body?.cancel().catch(() => undefined)
          throw new ConnectorError('auth', this.opts.service, `HTTP ${res.status}`, res.status)
        }
        if (res.status === 429) {
          await res.body?.cancel().catch(() => undefined)
          lastError = new ConnectorError('rate-limited', this.opts.service, 'HTTP 429', 429)
        } else if (res.status >= 500) {
          await res.body?.cancel().catch(() => undefined)
          lastError = new ConnectorError('unreachable', this.opts.service, `HTTP ${res.status}`, res.status)
        } else if (!res.ok) {
          await res.body?.cancel().catch(() => undefined)
          throw new ConnectorError('bad-response', this.opts.service, `HTTP ${res.status}`, res.status)
        } else {
          if (parse === 'none') return undefined as T
          const body = await res.text()
          if (parse === 'text') return body as T
          try {
            return (body.length ? JSON.parse(body) : {}) as T
          } catch {
            throw new ConnectorError('bad-response', this.opts.service, 'response was not JSON', res.status)
          }
        }
      } catch (err) {
        if (err instanceof ConnectorError) {
          if (err.kind === 'auth' || err.kind === 'bad-response') throw err
          lastError = err
        } else if ((err as Error).name === 'AbortError') {
          lastError = new ConnectorError('timeout', this.opts.service, `no response in ${this.opts.timeoutMs ?? 30_000}ms`)
        } else {
          lastError = new ConnectorError('unreachable', this.opts.service, (err as Error).message)
        }
      } finally {
        clearTimeout(timer)
        this.gate.release()
      }
      if (attempt < maxRetries) await sleep(backoffBase * 2 ** attempt)
    }
    throw lastError ?? new ConnectorError('unreachable', this.opts.service, 'exhausted retries')
  }
}
