# Jellymaid Plan 5 — UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A React SPA served by the same container that makes the whole flow drivable: log in, watch a scan, read findings, resolve duplicates, browse the mounted tree, build and approve a plan, watch it execute, and review history.

**Architecture:** Vite + React 19 in `client/`, built to `client/dist` and served by Fastify as static assets with an SPA fallback. One typed API module wraps every endpoint; screens are plain components with local state and a small polling hook. No global state library — the server is the state, and polling is the sync.

**Tech Stack:** React 19 · TypeScript strict · Vite 6 · Vitest 2 + Testing Library · `@fastify/static`

The spec names Vite 7; this pins Vite 6 so it pairs with the Vitest 2 already used server-side. Bump both together later — not one of them on its own.

## Global Constraints

Copied verbatim from `docs/superpowers/specs/2026-07-26-jellymaid-design.md`. Every task's requirements implicitly include this section.

- **All user-controlled strings** (file names, torrent names, tracker hosts, dismiss reasons) render as **text nodes only — never `innerHTML`**.
- **Degraded means "not evaluated", never "zero".** A rule that could not run must render visibly differently from a rule that found nothing.
- Guard verdicts are shown per plan row, with the override toggle only where `overridable` is true.
- Nothing destructive happens without an explicit approve step showing the dry-run totals first.
- TypeScript strict, no `any`. Commit after every task.

**Design:** Before Task 2, load the `frontend-design` skill and settle a visual direction. This is an admin tool that deletes media — the aesthetic should read as precise and calm, and destructive affordances must be unmistakable without the whole UI shouting. Pick the direction once, then apply it consistently across all seven screens.

## Prerequisites

Plans 1–4 complete; every API route exists and its tests pass.

---

## File Structure

| File | Responsibility |
|---|---|
| `client/index.html`, `client/vite.config.ts`, `client/tsconfig.json` | Client toolchain |
| `client/src/api.ts` | Typed wrappers for every endpoint |
| `client/src/hooks.ts` | `usePolling`, `useAsync` |
| `client/src/App.tsx` | Routing, auth gate, shell |
| `client/src/components/*` | `Bytes`, `SeverityBadge`, `TierBadge`, `GuardVerdictList`, `EmptyState`, `NotEvaluatedNotice` |
| `client/src/screens/Login.tsx` | Login |
| `client/src/screens/Dashboard.tsx` | Connector health, scan control, class counts |
| `client/src/screens/Findings.tsx` | Filter, select, dismiss, add to plan |
| `client/src/screens/Duplicates.tsx` | Group cards, keeper comparison, merge/delete |
| `client/src/screens/Explorer.tsx` | Mounted tree with overlays |
| `client/src/screens/PlanScreen.tsx` | Queue, guards, approve, execute progress |
| `client/src/screens/History.tsx` | Audit, trash restore |
| `client/src/screens/Settings.tsx` | Connections, path map, thresholds |
| `src/api/explorer.ts` | `/api/explorer` — server side of the Explorer screen |

---

### Task 1: Client scaffold, API module and static serving

**Files:**
- Create: `client/package.json`, `client/vite.config.ts`, `client/tsconfig.json`, `client/index.html`, `client/src/main.tsx`, `client/src/api.ts`, `client/src/hooks.ts`
- Modify: `src/server.ts` (serve `client/dist` with SPA fallback), root `package.json` (build script)
- Test: `client/tests/api.test.ts`, `tests/api/static.test.ts`

**Interfaces:**
- Produces: `api.login`, `api.logout`, `api.me`, `api.health`, `api.scanStart`, `api.scanCancel`, `api.scanStatus`, `api.findings`, `api.findingsSummary`, `api.dismissFinding`, `api.duplicates`, `api.mergeGroup`, `api.createPlan`, `api.getPlan`, `api.approvePlan`, `api.executePlan`, `api.plans`, `api.audit`, `api.restoreTrash`, `api.pathmapGet`, `api.pathmapPut`, `api.pathmapVerify`, `api.pathmapDetect`, `api.explorer`. Every one throws `ApiError { status, message }` on failure.

- [ ] **Step 1: Write the failing API-module test**

```ts
// client/tests/api.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createApi, ApiError } from '../src/api.js'

const api = (impl: typeof fetch) => createApi({ baseUrl: '', fetchImpl: impl })
afterEach(() => vi.restoreAllMocks())

describe('api', () => {
  it('sends credentials so the session cookie travels', async () => {
    let init: RequestInit | undefined
    const f = (async (_u: string, i?: RequestInit) => { init = i; return new Response('{}', { status: 200 }) }) as unknown as typeof fetch
    await api(f).me()
    expect(init?.credentials).toBe('include')
  })

  it('throws ApiError carrying the status and the server message', async () => {
    const f = (async () => new Response(JSON.stringify({ error: 'not authenticated' }), { status: 401 })) as unknown as typeof fetch
    const err = await api(f).me().catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(401)
    expect(err.message).toBe('not authenticated')
  })

  it('posts the login body as JSON', async () => {
    let body = ''
    const f = (async (_u: string, i?: RequestInit) => { body = String(i?.body); return new Response('{}', { status: 200 }) }) as unknown as typeof fetch
    await api(f).login('bob', 'pw')
    expect(JSON.parse(body)).toEqual({ username: 'bob', password: 'pw' })
  })

  it('serialises finding filters into the query string', async () => {
    let url = ''
    const f = (async (u: string) => { url = String(u); return new Response('{"findings":[],"total":0}', { status: 200 }) }) as unknown as typeof fetch
    await api(f).findings({ class: 'duplicate', limit: 25, offset: 50 })
    expect(url).toContain('class=duplicate')
    expect(url).toContain('limit=25')
    expect(url).toContain('offset=50')
  })

  it('omits undefined filters rather than sending the string "undefined"', async () => {
    let url = ''
    const f = (async (u: string) => { url = String(u); return new Response('{"findings":[],"total":0}', { status: 200 }) }) as unknown as typeof fetch
    await api(f).findings({ class: undefined, limit: 10 })
    expect(url).not.toContain('undefined')
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd client && npx vitest run tests/api.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Scaffold the client**

```json
// client/package.json
{
  "name": "jellymaid-client",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b --noEmit && vite build",
    "test": "vitest run"
  },
  "dependencies": { "react": "^19.0.0", "react-dom": "^19.0.0" },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.6.3",
    "@testing-library/react": "^16.1.0",
    "@testing-library/user-event": "^14.5.2",
    "@types/react": "^19.0.2",
    "@types/react-dom": "^19.0.2",
    "@vitejs/plugin-react": "^4.3.4",
    "jsdom": "^25.0.1",
    "typescript": "^5.7.2",
    "vite": "^6.0.5",
    "vitest": "^2.1.8"
  }
}
```

```ts
// client/vite.config.ts
// defineConfig comes from vitest/config, not vite — otherwise the `test` block below
// is not a known key and typecheck fails.
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { proxy: { '/api': 'http://localhost:8099', '/healthz': 'http://localhost:8099' } },
  test: { environment: 'jsdom', setupFiles: ['./tests/setup.ts'], include: ['tests/**/*.test.tsx', 'tests/**/*.test.ts'] },
})
```

```ts
// client/tests/setup.ts
import '@testing-library/jest-dom/vitest'
```

- [ ] **Step 4: Implement the API module and hooks**

```ts
// client/src/api.ts
export class ApiError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'ApiError' }
}

export interface Finding {
  id: string; ruleId: string; class: string; severity: string; confidence: string
  subjects: Array<{ kind: 'item' | 'path'; id?: string; path?: string; label: string }>
  evidence: Record<string, unknown>
  reclaimableBytes: number | null; status: string; firstSeen: string; lastSeen: string
  dismissedReason: string | null
}

export interface GuardVerdict {
  guard: string; outcome: 'pass' | 'warn' | 'block'; overridable: boolean
  reason: string; evidence: Record<string, unknown>
}

export interface PlanActionView {
  id: string; seq: number; type: string; status: string
  payload: { targetPath?: string; itemIds?: string[]; overrides?: string[] }
  guardVerdicts: GuardVerdict[]; error: string | null
}

export interface PlanView {
  id: string; status: string; createdBy: string; createdAt: string; approvedBy: string | null
  actions: PlanActionView[]
  dryRun: { deleteCount: number; bytesFreed: number; torrentsRemoved: number; blockedCount: number }
}

export interface RequestedAction {
  type: string; targetPath?: string; itemIds?: string[]; overrides?: string[]
}

function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined) sp.set(k, String(v))
  const s = sp.toString()
  return s ? `?${s}` : ''
}

export function createApi(opts: { baseUrl: string; fetchImpl?: typeof fetch }) {
  const doFetch = opts.fetchImpl ?? fetch

  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await doFetch(`${opts.baseUrl}${path}`, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(init.headers as Record<string, string>) },
      ...init,
    })
    const text = await res.text()
    const body = text ? JSON.parse(text) : {}
    if (!res.ok) throw new ApiError(res.status, (body as { error?: string }).error ?? `HTTP ${res.status}`)
    return body as T
  }

  const post = <T>(path: string, payload?: unknown) =>
    call<T>(path, { method: 'POST', body: payload === undefined ? undefined : JSON.stringify(payload) })

  return {
    login: (username: string, password: string) => post<{ username: string }>('/api/auth/login', { username, password }),
    logout: () => post<{ ok: true }>('/api/auth/logout'),
    me: () => call<{ username: string }>('/api/auth/me'),
    health: () => call<{ status: string; schemaVersion: number; connectors: Record<string, string> }>('/healthz'),

    scanStart: (resumeScanId?: number) => post<{ scanId: number }>('/api/scan/start', { resumeScanId }),
    scanCancel: () => post<{ cancelled: boolean }>('/api/scan/cancel'),
    scanStatus: () => call<{ running: boolean; scanId: number | null; phase: string | null; done: number; total: number | null; lastScan: unknown }>('/api/scan/status'),

    findings: (f: { class?: string; severity?: string; confidence?: string; status?: string; ruleId?: string; limit?: number; offset?: number } = {}) =>
      call<{ findings: Finding[]; total: number }>(`/api/findings${qs(f)}`),
    // `evaluated`/`basedOn`/`latestAttempt` are not decoration: `byClass` and `reclaimableBytes`
    // describe the last scan that actually reached the rules phase (`basedOn`), which is NOT
    // necessarily the newest scan. The Dashboard must say which scan it is reporting on, and must
    // surface `latestAttempt` when a newer scan failed before rules ran ("these results are from
    // scan 41; scan 42 failed") — otherwise a dead scan renders as a clean pass.
    findingsSummary: () => call<{
      evaluated: boolean
      basedOn: { scanId: number; status: string; finishedAt: string | null } | null
      latestAttempt: { scanId: number; status: string } | null
      byClass: Record<string, number>; reclaimableBytes: number
      notEvaluated: Array<{ ruleId: string; reason: string }>
    }>('/api/findings/summary'),
    dismissFinding: (id: string, reason: string) => post<{ ok: true }>(`/api/findings/${id}/dismiss`, { reason }),
    reopenFinding: (id: string) => post<{ ok: true }>(`/api/findings/${id}/reopen`),

    duplicates: () => call<{ groups: Array<{ id: string; tier: string; keeperItemId: string | null; scores: Record<string, { total: number; breakdown: Record<string, number> }>; members: Array<Record<string, unknown>> }> }>('/api/duplicates'),
    mergeGroup: (groupId: string) => post<{ merged: string[] }>(`/api/duplicates/${groupId}/merge`),

    createPlan: (actions: RequestedAction[]) => post<PlanView>('/api/plans', { actions }),
    plans: () => call<{ plans: Array<{ id: string; createdAt: string; createdBy: string; status: string; dryRun: PlanView['dryRun'] }> }>('/api/plans'),
    getPlan: (id: string) => call<PlanView>(`/api/plans/${id}`),
    approvePlan: (id: string) => post<PlanView>(`/api/plans/${id}/approve`),
    executePlan: (id: string) => post<{ planId: string; status: string; done: number; failed: number; skipped: number; blocked: number; bytesFreed: number }>(`/api/plans/${id}/execute`),

    audit: (limit = 200) => call<{ entries: Array<Record<string, unknown>> }>(`/api/audit${qs({ limit })}`),
    restoreTrash: (id: string) => post<{ restored: boolean; reason?: string }>(`/api/trash/${id}/restore`),

    pathmapGet: () => call<{ mappings: Array<{ role: string; jellyfin: string | null; container: string; qbit: string | null }> }>('/api/pathmap'),
    pathmapPut: (mappings: unknown[]) => call<{ mappings: unknown[] }>('/api/pathmap', { method: 'PUT', body: JSON.stringify({ mappings }) }),
    pathmapVerify: () => post<{ sampled: number; resolved: number; failures: Array<{ jellyfinPath: string; reason: string }> }>('/api/pathmap/verify'),
    pathmapDetect: (mountRoots: string[]) => post<{ proposed: unknown[] }>('/api/pathmap/detect', { mountRoots }),

    explorer: (path?: string) => call<{ path: string; parent: string | null; entries: Array<{ name: string; path: string; isDir: boolean; sizeBytes: number; fileCount: number; isMedia: boolean; flags: string[] }> }>(`/api/explorer${qs({ path })}`),
  }
}

export type Api = ReturnType<typeof createApi>
```

```ts
// client/src/hooks.ts
import { useCallback, useEffect, useRef, useState } from 'react'

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const reload = useCallback(() => {
    setLoading(true)
    fn().then((d) => { setData(d); setError(null) })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  useEffect(() => { reload() }, [reload])
  return { data, error, loading, reload }
}

/** Polls while `active` is true. Used for scan and plan progress; stops the moment work ends. */
export function usePolling<T>(fn: () => Promise<T>, intervalMs: number, active: boolean) {
  const [data, setData] = useState<T | null>(null)
  const saved = useRef(fn)
  saved.current = fn

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try { const d = await saved.current(); if (!cancelled) setData(d) } catch { /* transient */ }
    }
    void tick()
    if (!active) return () => { cancelled = true }
    const id = setInterval(() => void tick(), intervalMs)
    return () => { cancelled = true; clearInterval(id) }
  }, [intervalMs, active])

  return data
}
```

- [ ] **Step 5: Serve the SPA from Fastify**

Add `clientDir?: string` to `ServerDeps` first — it is optional so every existing route test keeps
working unchanged, and the tests below can point it at a temp directory. Then add to `src/server.ts`:

```ts
import fastifyStatic from '@fastify/static'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

  const clientDir = deps.clientDir ?? join(process.cwd(), 'client', 'dist')
  if (existsSync(clientDir)) {
    app.register(fastifyStatic, { root: clientDir, prefix: '/' })
    // SPA fallback — anything that is not an API route serves index.html.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/healthz')) {
        return reply.code(404).send({ error: 'not found' })
      }
      return reply.sendFile('index.html')
    })
  }
```

```ts
// tests/api/static.test.ts
import { describe, it, expect } from 'vitest'
import { buildServer } from '../../src/server.js'
// ...build with the same stub deps used in tests/api/health.test.ts, plus clientDir pointing at a temp dir
// containing index.html.

describe('spa fallback', () => {
  it('serves index.html for an unknown non-api path', async () => {
    // expect 200 and the html body
  })

  it('still 404s an unknown /api path as JSON', async () => {
    // expect 404 and { error: 'not found' }
  })
})
```

Fill both test bodies following the pattern in `tests/api/health.test.ts`: create a temp dir, write `index.html` containing `<div id="root"></div>`, pass it as `clientDir`, and assert the two behaviours above.

- [ ] **Step 6: Run tests and typecheck**

Run: `cd client && npm install && npx vitest run` then `cd .. && npx vitest run && npm run typecheck`
Expected: 5 client tests + 2 static tests PASS.

- [ ] **Step 7: Commit**

```bash
git add client src/server.ts tests/api/static.test.ts package.json
git commit -m "feat: client scaffold, typed api module and spa serving"
```

---

### Task 2: App shell, auth gate and login

**Files:**
- Create: `client/src/App.tsx`, `client/src/screens/Login.tsx`, `client/src/components/*`, `client/src/styles.css`
- Test: `client/tests/login.test.tsx`, `client/tests/shell.test.tsx`

**Interfaces:**
- Produces: `<App api={api} />`, `<Login onSuccess={fn} api={api} />`, shared components `Bytes`, `SeverityBadge`, `TierBadge`, `GuardVerdictList`, `NotEvaluatedNotice`.

**Before writing any component:** load the `frontend-design` skill and choose the visual direction described at the top of this plan. Apply it in `styles.css` and keep every screen consistent with it.

- [ ] **Step 1: Write the failing tests**

```tsx
// client/tests/login.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Login } from '../src/screens/Login.js'
import { ApiError } from '../src/api.js'

const api = (login: (u: string, p: string) => Promise<{ username: string }>) => ({ login } as never)

describe('Login', () => {
  it('submits the username and password', async () => {
    const login = vi.fn(async () => ({ username: 'bob' }))
    render(<Login api={api(login)} onSuccess={() => {}} />)
    await userEvent.type(screen.getByLabelText(/username/i), 'bob')
    await userEvent.type(screen.getByLabelText(/password/i), 'pw')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    expect(login).toHaveBeenCalledWith('bob', 'pw')
  })

  it('calls onSuccess with the username', async () => {
    const onSuccess = vi.fn()
    render(<Login api={api(async () => ({ username: 'bob' }))} onSuccess={onSuccess} />)
    await userEvent.type(screen.getByLabelText(/username/i), 'bob')
    await userEvent.type(screen.getByLabelText(/password/i), 'pw')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    expect(onSuccess).toHaveBeenCalledWith('bob')
  })

  it('shows the admin-required message on 403 rather than a generic failure', async () => {
    render(<Login api={api(async () => { throw new ApiError(403, 'a Jellyfin administrator account is required') })} onSuccess={() => {}} />)
    await userEvent.type(screen.getByLabelText(/username/i), 'eve')
    await userEvent.type(screen.getByLabelText(/password/i), 'pw')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    expect(await screen.findByText(/administrator account is required/i)).toBeInTheDocument()
  })

  it('distinguishes a lockout from bad credentials', async () => {
    render(<Login api={api(async () => { throw new ApiError(429, 'too many failed attempts') })} onSuccess={() => {}} />)
    await userEvent.type(screen.getByLabelText(/username/i), 'bob')
    await userEvent.type(screen.getByLabelText(/password/i), 'x')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    expect(await screen.findByText(/too many failed attempts/i)).toBeInTheDocument()
  })

  it('says Jellyfin is unreachable on 503', async () => {
    render(<Login api={api(async () => { throw new ApiError(503, 'Jellyfin is unreachable') })} onSuccess={() => {}} />)
    await userEvent.type(screen.getByLabelText(/username/i), 'bob')
    await userEvent.type(screen.getByLabelText(/password/i), 'x')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    expect(await screen.findByText(/unreachable/i)).toBeInTheDocument()
  })

  it('never renders the typed password anywhere but the password input', async () => {
    render(<Login api={api(async () => { throw new ApiError(401, 'invalid credentials') })} onSuccess={() => {}} />)
    await userEvent.type(screen.getByLabelText(/password/i), 'hunter2')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    const input = screen.getByLabelText(/password/i) as HTMLInputElement
    expect(input.type).toBe('password')
    expect(document.body.textContent).not.toContain('hunter2')
  })
})
```

```tsx
// client/tests/shell.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { GuardVerdictList, Bytes, NotEvaluatedNotice } from '../src/components/index.js'

describe('Bytes', () => {
  it.each([[0, '0 B'], [1024, '1.0 KB'], [1_572_864, '1.5 MB'], [3_221_225_472, '3.0 GB']])(
    'formats %i as %s', (input, expected) => {
      render(<Bytes value={input} />)
      expect(screen.getByText(expected)).toBeInTheDocument()
    })

  it('renders an em dash for null rather than "null"', () => {
    render(<Bytes value={null} />)
    expect(screen.getByText('—')).toBeInTheDocument()
  })
})

describe('GuardVerdictList', () => {
  const verdict = (over = {}) => ({ guard: 'guard.protected', outcome: 'block' as const, overridable: false, reason: 'state downloading', evidence: {}, ...over })

  it('renders the reason as text', () => {
    render(<GuardVerdictList verdicts={[verdict()]} overrides={[]} onToggleOverride={() => {}} />)
    expect(screen.getByText(/state downloading/)).toBeInTheDocument()
  })

  it('offers an override control only for overridable guards', () => {
    const { rerender } = render(<GuardVerdictList verdicts={[verdict()]} overrides={[]} onToggleOverride={() => {}} />)
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    rerender(<GuardVerdictList verdicts={[verdict({ guard: 'guard.private-ratio', overridable: true })]} overrides={[]} onToggleOverride={() => {}} />)
    expect(screen.getByRole('checkbox')).toBeInTheDocument()
  })

  it('escapes a malicious torrent name instead of interpreting it', () => {
    render(<GuardVerdictList verdicts={[verdict({ reason: '<img src=x onerror=alert(1)>' })]} overrides={[]} onToggleOverride={() => {}} />)
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument()
  })
})

describe('NotEvaluatedNotice', () => {
  it('renders nothing when every rule ran', () => {
    const { container } = render(<NotEvaluatedNotice items={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('names each rule that could not run and why', () => {
    render(<NotEvaluatedNotice items={[{ ruleId: 'dupe.identical-file', reason: 'hashes disabled' }]} />)
    expect(screen.getByText(/dupe.identical-file/)).toBeInTheDocument()
    expect(screen.getByText(/hashes disabled/)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd client && npx vitest run`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the shared components**

```tsx
// client/src/components/index.tsx
import type { GuardVerdict } from '../api.js'

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

export function Bytes({ value }: { value: number | null }) {
  if (value === null) return <span>—</span>
  if (value === 0) return <span>0 B</span>
  const exp = Math.min(Math.floor(Math.log(value) / Math.log(1024)), UNITS.length - 1)
  const scaled = value / 1024 ** exp
  return <span>{exp === 0 ? `${value} B` : `${scaled.toFixed(1)} ${UNITS[exp]}`}</span>
}

export function SeverityBadge({ severity }: { severity: string }) {
  return <span className={`badge badge-${severity}`}>{severity}</span>
}

export function TierBadge({ tier }: { tier: string }) {
  return <span className={`badge tier-${tier}`}>{tier}</span>
}

export function GuardVerdictList({ verdicts, overrides, onToggleOverride }: {
  verdicts: GuardVerdict[]
  overrides: string[]
  onToggleOverride: (guard: string) => void
}) {
  return (
    <ul className="guards">
      {verdicts.map((v) => (
        <li key={v.guard} className={`guard guard-${v.outcome}`}>
          <span className="guard-name">{v.guard}</span>
          {/* Reason may contain a torrent or file name: text node only, never innerHTML. */}
          <span className="guard-reason">{v.reason}</span>
          {v.outcome === 'block' && v.overridable ? (
            <label className="guard-override">
              <input
                type="checkbox"
                checked={overrides.includes(v.guard)}
                onChange={() => onToggleOverride(v.guard)}
              />
              override
            </label>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

export function NotEvaluatedNotice({ items }: { items: Array<{ ruleId: string; reason: string }> }) {
  if (!items.length) return null
  return (
    <aside className="not-evaluated" role="status">
      <strong>Not evaluated in the last scan</strong>
      <ul>
        {items.map((i) => (
          <li key={i.ruleId}>
            <code>{i.ruleId}</code> — {i.reason}
          </li>
        ))}
      </ul>
      <p>These checks did not run. Their absence from the results below is not a clean bill of health.</p>
    </aside>
  )
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="empty">{children}</p>
}
```

- [ ] **Step 4: Implement Login and App**

```tsx
// client/src/screens/Login.tsx
import { useState, type FormEvent } from 'react'
import type { Api } from '../api.js'

export function Login({ api, onSuccess }: { api: Pick<Api, 'login'>; onSuccess: (username: string) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await api.login(username, password)
      setPassword('')
      onSuccess(res.username)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="login" onSubmit={submit}>
      <h1>Jellymaid</h1>
      <label htmlFor="username">Username</label>
      <input id="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
      <label htmlFor="password">Password</label>
      <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
      <button type="submit" disabled={busy}>Sign in</button>
      {error ? <p className="error" role="alert">{error}</p> : null}
      <p className="hint">Sign in with a Jellyfin administrator account.</p>
    </form>
  )
}
```

Write `client/src/App.tsx` as the shell: it calls `api.me()` on mount, renders `<Login>` when that 401s, and otherwise renders a nav (Dashboard · Findings · Duplicates · Explorer · Plan · History · Settings) plus the selected screen, with a logout button. Use `useState` for the current screen — no router dependency needed for seven flat screens.

- [ ] **Step 5: Run tests**

Run: `cd client && npx vitest run`
Expected: 12 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src client/tests
git commit -m "feat: app shell, login and shared components"
```

---

### Task 3: Dashboard and Findings screens

**Files:**
- Create: `client/src/screens/Dashboard.tsx`, `client/src/screens/Findings.tsx`
- Test: `client/tests/dashboard.test.tsx`, `client/tests/findings.test.tsx`

**Interfaces:**
- Produces: `<Dashboard api={api} />`, `<Findings api={api} onQueue={(actions) => void} />` where `onQueue` hands `RequestedAction[]` to the Plan screen.

- [ ] **Step 1: Write the failing tests**

```tsx
// client/tests/dashboard.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Dashboard } from '../src/screens/Dashboard.js'

const api = (over = {}) => ({
  health: async () => ({ status: 'ok', schemaVersion: 1, connectors: { jellyfin: 'ok' } }),
  scanStatus: async () => ({ running: false, scanId: null, phase: null, done: 0, total: null, lastScan: null }),
  findingsSummary: async () => ({ evaluated: true, basedOn: { scanId: 41, status: 'completed', finishedAt: 'T' }, latestAttempt: null, byClass: { duplicate: 3, filesystem: 7 }, reclaimableBytes: 3_221_225_472, notEvaluated: [] }),
  scanStart: vi.fn(async () => ({ scanId: 1 })),
  scanCancel: vi.fn(async () => ({ cancelled: true })),
  ...over,
} as never)

describe('Dashboard', () => {
  it('shows per-class counts and total reclaimable space', async () => {
    render(<Dashboard api={api()} />)
    expect(await screen.findByText('3')).toBeInTheDocument()
    expect(await screen.findByText('7')).toBeInTheDocument()
    expect(await screen.findByText('3.0 GB')).toBeInTheDocument()
  })

  it('shows a connector as unreachable when health says so', async () => {
    render(<Dashboard api={api({ health: async () => ({ status: 'degraded', schemaVersion: 1, connectors: { jellyfin: 'unreachable' } }) })} />)
    expect(await screen.findByText(/unreachable/i)).toBeInTheDocument()
  })

  it('surfaces rules that were not evaluated', async () => {
    render(<Dashboard api={api({
      findingsSummary: async () => ({ evaluated: true, basedOn: { scanId: 41, status: 'completed', finishedAt: 'T' }, latestAttempt: null, byClass: {}, reclaimableBytes: 0, notEvaluated: [{ ruleId: 'dupe.identical-file', reason: 'hashes disabled' }] }),
    })} />)
    expect(await screen.findByText(/hashes disabled/)).toBeInTheDocument()
  })

  it('starts a scan on click', async () => {
    const scanStart = vi.fn(async () => ({ scanId: 1 }))
    render(<Dashboard api={api({ scanStart })} />)
    await userEvent.click(await screen.findByRole('button', { name: /scan now/i }))
    expect(scanStart).toHaveBeenCalled()
  })

  it('shows progress and a cancel button while a scan runs', async () => {
    render(<Dashboard api={api({
      scanStatus: async () => ({ running: true, scanId: 4, phase: 'filesystem', done: 120, total: 500, lastScan: null }),
    })} />)
    expect(await screen.findByText(/filesystem/)).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /cancel/i })).toBeInTheDocument()
  })
})
```

```tsx
// client/tests/findings.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Findings } from '../src/screens/Findings.js'

const finding = (over = {}) => ({
  id: 'f1', ruleId: 'fs.junk', class: 'filesystem', severity: 'warning', confidence: 'exact',
  subjects: [{ kind: 'path', path: '/mnt/m/sample.mkv', label: '/mnt/m/sample.mkv' }],
  evidence: { reason: 'sample file' }, reclaimableBytes: 1024, status: 'open',
  firstSeen: 'T', lastSeen: 'T', dismissedReason: null, ...over,
})

const api = (over = {}) => ({
  findings: vi.fn(async () => ({ findings: [finding()], total: 1 })),
  dismissFinding: vi.fn(async () => ({ ok: true as const })),
  ...over,
} as never)

describe('Findings', () => {
  it('lists findings with their rule and subject path', async () => {
    render(<Findings api={api()} onQueue={() => {}} />)
    expect(await screen.findByText('fs.junk')).toBeInTheDocument()
    expect(await screen.findByText('/mnt/m/sample.mkv')).toBeInTheDocument()
  })

  it('refetches with the class filter applied', async () => {
    const findings = vi.fn(async () => ({ findings: [], total: 0 }))
    render(<Findings api={api({ findings })} onQueue={() => {}} />)
    await userEvent.selectOptions(await screen.findByLabelText(/class/i), 'duplicate')
    await waitFor(() => expect(findings).toHaveBeenLastCalledWith(expect.objectContaining({ class: 'duplicate' })))
  })

  it('requires a reason before dismissing', async () => {
    const dismissFinding = vi.fn(async () => ({ ok: true as const }))
    render(<Findings api={api({ dismissFinding })} onQueue={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /dismiss/i }))
    expect(dismissFinding).not.toHaveBeenCalled()
    await userEvent.type(screen.getByLabelText(/reason/i), 'intentional')
    await userEvent.click(screen.getByRole('button', { name: /confirm dismiss/i }))
    expect(dismissFinding).toHaveBeenCalledWith('f1', 'intentional')
  })

  it('queues selected findings as delete actions', async () => {
    const onQueue = vi.fn()
    render(<Findings api={api()} onQueue={onQueue} />)
    await userEvent.click(await screen.findByRole('checkbox', { name: /select/i }))
    await userEvent.click(screen.getByRole('button', { name: /add to plan/i }))
    expect(onQueue).toHaveBeenCalledWith([{ type: 'delete-junk-file', targetPath: '/mnt/m/sample.mkv' }])
  })

  it('queues an empty-folder finding as remove-empty-folder, not a delete', async () => {
    const onQueue = vi.fn()
    render(<Findings api={api({ findings: async () => ({ findings: [finding({ ruleId: 'fs.empty-folder', subjects: [{ kind: 'path', path: '/mnt/m/Old', label: '/mnt/m/Old' }] })], total: 1 }) })} onQueue={onQueue} />)
    await userEvent.click(await screen.findByRole('checkbox', { name: /select/i }))
    await userEvent.click(screen.getByRole('button', { name: /add to plan/i }))
    expect(onQueue).toHaveBeenCalledWith([{ type: 'remove-empty-folder', targetPath: '/mnt/m/Old' }])
  })

  it('renders a malicious file name as text', async () => {
    render(<Findings api={api({
      findings: async () => ({ findings: [finding({ subjects: [{ kind: 'path', path: '<img src=x onerror=alert(1)>', label: '<img src=x onerror=alert(1)>' }] })], total: 1 }),
    })} onQueue={() => {}} />)
    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeInTheDocument()
    expect(document.querySelector('img')).toBeNull()
  })
})
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd client && npx vitest run tests/dashboard.test.tsx tests/findings.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement both screens**

Dashboard: `useAsync` for health and summary, `usePolling(api.scanStatus, 2000, running)` for scan state; render connector chips, per-class count tiles, total reclaimable via `<Bytes>`, `<NotEvaluatedNotice>`, and a Scan now / Cancel button pair.

Findings: filter selects (class, severity, confidence, status), a table of findings with a per-row checkbox, `<SeverityBadge>`, subject paths as text, a dismiss flow that reveals a reason input and only calls the API once a non-empty reason exists, and an **Add to plan** button mapping rule ids to action types:

```ts
// client/src/screens/Findings.tsx (mapping fragment)
export function actionForFinding(f: { ruleId: string; subjects: Array<{ path?: string }> }): RequestedAction | null {
  const path = f.subjects[0]?.path
  if (!path) return null
  if (f.ruleId === 'fs.empty-folder') return { type: 'remove-empty-folder', targetPath: path }
  if (f.ruleId === 'fs.junk' || f.ruleId === 'fs.stray-sidecar') return { type: 'delete-junk-file', targetPath: path }
  if (f.ruleId === 'fs.orphan-media') return { type: 'delete-media', targetPath: path }
  return null   // metadata and quality findings are informational; they queue nothing
}
```

- [ ] **Step 4: Run tests**

Run: `cd client && npx vitest run`
Expected: 11 new tests PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/screens/Dashboard.tsx client/src/screens/Findings.tsx client/tests
git commit -m "feat: dashboard and findings screens"
```

---

### Task 4: Duplicates screen

**Files:**
- Create: `client/src/screens/Duplicates.tsx`
- Test: `client/tests/duplicates.test.tsx`

**Interfaces:**
- Produces: `<Duplicates api={api} onQueue={fn} />`.

- [ ] **Step 1: Write the failing test**

```tsx
// client/tests/duplicates.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Duplicates } from '../src/screens/Duplicates.js'

const group = (over = {}) => ({
  id: 'g1', tier: 'exact', keeperItemId: 'b',
  scores: { a: { total: 900, breakdown: { resolution: 500 } }, b: { total: 1800, breakdown: { resolution: 1000 } } },
  members: [
    { id: 'a', name: 'Heat', container_path: '/mnt/m/Heat-1080.mkv', size_bytes: 8_000_000_000, height: 1080, bitrate: 8_000_000, video_codec: 'h264', library_name: 'Movies' },
    { id: 'b', name: 'Heat', container_path: '/mnt/m/Heat-2160.mkv', size_bytes: 40_000_000_000, height: 2160, bitrate: 40_000_000, video_codec: 'hevc', library_name: 'Movies' },
  ],
  ...over,
})

const api = (over = {}) => ({
  duplicates: async () => ({ groups: [group()] }),
  mergeGroup: vi.fn(async () => ({ merged: ['a', 'b'] })),
  dismissFinding: vi.fn(async () => ({ ok: true as const })),
  ...over,
} as never)

describe('Duplicates', () => {
  it('shows the tier and every member side by side', async () => {
    render(<Duplicates api={api()} onQueue={() => {}} />)
    expect(await screen.findByText('exact')).toBeInTheDocument()
    expect(await screen.findByText('/mnt/m/Heat-1080.mkv')).toBeInTheDocument()
    expect(await screen.findByText('/mnt/m/Heat-2160.mkv')).toBeInTheDocument()
  })

  it('marks the pre-selected keeper', async () => {
    render(<Duplicates api={api()} onQueue={() => {}} />)
    const keeperRow = (await screen.findByText('/mnt/m/Heat-2160.mkv')).closest('tr')!
    expect(keeperRow).toHaveAttribute('data-keeper', 'true')
  })

  it('lets the operator choose a different keeper', async () => {
    const onQueue = vi.fn()
    render(<Duplicates api={api()} onQueue={onQueue} />)
    await userEvent.click(await screen.findByRole('radio', { name: /keep .*Heat-1080/i }))
    await userEvent.click(screen.getByRole('button', { name: /delete non-keepers/i }))
    expect(onQueue).toHaveBeenCalledWith([{ type: 'delete-media', targetPath: '/mnt/m/Heat-2160.mkv' }])
  })

  it('queues every non-keeper by default', async () => {
    const onQueue = vi.fn()
    render(<Duplicates api={api()} onQueue={onQueue} />)
    await userEvent.click(await screen.findByRole('button', { name: /delete non-keepers/i }))
    expect(onQueue).toHaveBeenCalledWith([{ type: 'delete-media', targetPath: '/mnt/m/Heat-1080.mkv' }])
  })

  it('merges versions through the api', async () => {
    const mergeGroup = vi.fn(async () => ({ merged: ['a', 'b'] }))
    render(<Duplicates api={api({ mergeGroup })} onQueue={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /merge versions/i }))
    expect(mergeGroup).toHaveBeenCalledWith('g1')
  })

  it('shows the score breakdown so the keeper choice is auditable', async () => {
    render(<Duplicates api={api()} onQueue={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /why/i }))
    expect(await screen.findByText(/resolution/i)).toBeInTheDocument()
  })

  it('flags a cross-library group', async () => {
    render(<Duplicates api={api({
      duplicates: async () => ({ groups: [group({ members: [
        { id: 'a', name: 'Heat', container_path: '/mnt/m/a.mkv', size_bytes: 1, height: 1080, library_name: 'Movies' },
        { id: 'b', name: 'Heat', container_path: '/mnt/n/b.mkv', size_bytes: 1, height: 1080, library_name: 'Movies 4K' },
      ] })] }),
    })} onQueue={() => {}} />)
    expect(await screen.findByText(/across libraries/i)).toBeInTheDocument()
  })

  it('shows an empty state when there are no duplicates', async () => {
    render(<Duplicates api={api({ duplicates: async () => ({ groups: [] }) })} onQueue={() => {}} />)
    expect(await screen.findByText(/no duplicate groups/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd client && npx vitest run tests/duplicates.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the screen**

Group cards, each with a `<TierBadge>`, a member table (radio per row to choose the keeper, `data-keeper` on the chosen row, columns: path, resolution, bitrate, codec, size via `<Bytes>`, library), a **Why** toggle revealing the score breakdown, a cross-library note when `new Set(members.map(m => m.library_name)).size > 1`, and three buttons: **Merge versions**, **Delete non-keepers** (queues `delete-media` for every non-keeper path), **Dismiss**.

- [ ] **Step 4: Run tests and commit**

Run: `cd client && npx vitest run`

```bash
git add client/src/screens/Duplicates.tsx client/tests/duplicates.test.tsx
git commit -m "feat: duplicates screen with keeper comparison"
```

---

### Task 5: Explorer — server route and screen

**Files:**
- Create: `src/api/explorer.ts`, `client/src/screens/Explorer.tsx`
- Modify: `src/server.ts`
- Test: `tests/api/explorer.test.ts`, `client/tests/explorer.test.tsx`

**Interfaces:**
- Produces: `GET /api/explorer?path=` returning `{ path, parent, entries: Array<{ name, path, isDir, sizeBytes, fileCount, isMedia, flags }> }`, where `flags` ⊆ `['orphan', 'junk', 'empty', 'missing']` derived from open findings. Reads the **index**, not the live filesystem, so it stays fast at 100k+ entries.

- [ ] **Step 1: Write the failing server test**

```ts
// tests/api/explorer.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../src/index/db.js'
import { registerExplorerRoutes } from '../../src/api/explorer.js'
import { signSession } from '../../src/auth/session.js'
import { createPathMap } from '../../src/fs/pathmap.js'

const SECRET = 'e'.repeat(32)
const auth = () => ({ cookie: `jellymaid_session=${signSession({ username: 'bob', userId: 'u', issuedAt: Date.now() }, SECRET)}` })

let db: Db
function build() {
  const app = Fastify()
  app.register(cookie)
  registerExplorerRoutes(app, {
    db, sessionSecret: SECRET,
    pathMap: createPathMap([{ role: 'library', jellyfin: '/media', container: '/mnt/m', qbit: null }]),
  })
  return app
}

function entry(path: string, over: Record<string, unknown> = {}) {
  db.prepare(`INSERT OR REPLACE INTO fs_entries (container_path, scan_id, parent_path, name, ext,
    is_dir, size_bytes, mtime, dev, inode, nlink, is_media, library_root, root_role)
    VALUES (@container_path,1,@parent_path,@name,@ext,@is_dir,@size_bytes,0,1,1,1,@is_media,'/mnt/m','library')`)
    .run({
      container_path: path, parent_path: path.slice(0, path.lastIndexOf('/')) || '/',
      name: path.slice(path.lastIndexOf('/') + 1), ext: null, is_dir: 0, size_bytes: 100, is_media: 0, ...over,
    })
}

beforeEach(() => { db = openDb(join(mkdtempSync(join(tmpdir(), 'jm-exp-')), 'db.sqlite')) })

describe('/api/explorer', () => {
  it('requires a session', async () => {
    expect((await build().inject({ method: 'GET', url: '/api/explorer' })).statusCode).toBe(401)
  })

  it('lists the configured roots when no path is given', async () => {
    const body = (await build().inject({ method: 'GET', url: '/api/explorer', headers: auth() })).json()
    expect(body.entries.map((e: { path: string }) => e.path)).toEqual(['/mnt/m'])
    expect(body.parent).toBeNull()
  })

  it('lists the children of a directory', async () => {
    entry('/mnt/m/Heat', { is_dir: 1 })
    entry('/mnt/m/Heat/Heat.mkv', { is_media: 1, size_bytes: 500 })
    const body = (await build().inject({ method: 'GET', url: '/api/explorer?path=/mnt/m/Heat', headers: auth() })).json()
    expect(body.entries).toHaveLength(1)
    expect(body.entries[0].name).toBe('Heat.mkv')
    expect(body.entries[0].sizeBytes).toBe(500)
  })

  it('rolls up directory size and file count from descendants', async () => {
    entry('/mnt/m/Heat', { is_dir: 1 })
    entry('/mnt/m/Heat/a.mkv', { is_media: 1, size_bytes: 300 })
    entry('/mnt/m/Heat/b.mkv', { is_media: 1, size_bytes: 200 })
    const body = (await build().inject({ method: 'GET', url: '/api/explorer?path=/mnt/m', headers: auth() })).json()
    const dir = body.entries.find((e: { name: string }) => e.name === 'Heat')
    expect(dir.sizeBytes).toBe(500)
    expect(dir.fileCount).toBe(2)
  })

  it('flags entries that have open findings', async () => {
    entry('/mnt/m/orphan.mkv', { is_media: 1 })
    db.prepare(`INSERT INTO findings (id, rule_id, class, severity, confidence, subjects_json,
      evidence_json, reclaimable_bytes, status, first_seen, last_seen)
      VALUES ('f1','fs.orphan-media','filesystem','warning','exact',
              '[{"kind":"path","path":"/mnt/m/orphan.mkv","label":"x"}]','{}',1,'open','T','T')`).run()
    const body = (await build().inject({ method: 'GET', url: '/api/explorer?path=/mnt/m', headers: auth() })).json()
    expect(body.entries.find((e: { name: string }) => e.name === 'orphan.mkv').flags).toContain('orphan')
  })

  it('refuses a path outside every configured root', async () => {
    expect((await build().inject({ method: 'GET', url: '/api/explorer?path=/etc', headers: auth() })).statusCode).toBe(400)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/api/explorer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the route**

```ts
// src/api/explorer.ts
import type { FastifyInstance } from 'fastify'
import type { Db } from '../index/db.js'
import type { PathMap } from '../fs/pathmap.js'
import { requireSession } from './auth.js'

const FLAG_BY_RULE: Record<string, string> = {
  'fs.orphan-media': 'orphan',
  'fs.junk': 'junk',
  'fs.stray-sidecar': 'junk',
  'fs.empty-folder': 'empty',
  'fs.missing-file': 'missing',
}

export function registerExplorerRoutes(
  app: FastifyInstance,
  deps: { db: Db; sessionSecret: string; pathMap: PathMap },
): void {
  app.get('/api/explorer', { preHandler: requireSession(deps.sessionSecret) }, async (req, reply) => {
    const requested = (req.query as { path?: string }).path

    if (!requested) {
      return reply.send({
        path: '',
        parent: null,
        entries: deps.pathMap.all().map((m) => ({
          name: m.container, path: m.container, isDir: true,
          sizeBytes: rollupSize(deps.db, m.container), fileCount: rollupCount(deps.db, m.container),
          isMedia: false, flags: [] as string[],
        })),
      })
    }

    const root = deps.pathMap.rootFor(requested)
    if (!root || !deps.pathMap.isWithinRoot(requested, root)) {
      return reply.code(400).send({ error: 'path is outside every configured root' })
    }

    const rows = deps.db.prepare(
      'SELECT container_path, name, is_dir, size_bytes, is_media FROM fs_entries WHERE parent_path = ? ORDER BY is_dir DESC, name',
    ).all(requested) as Array<{ container_path: string; name: string; is_dir: number; size_bytes: number; is_media: number }>

    const flags = flagMap(deps.db, rows.map((r) => r.container_path))

    return reply.send({
      path: requested,
      parent: requested === root.container ? null : requested.slice(0, requested.lastIndexOf('/')) || '/',
      entries: rows.map((r) => ({
        name: r.name,
        path: r.container_path,
        isDir: r.is_dir === 1,
        sizeBytes: r.is_dir === 1 ? rollupSize(deps.db, r.container_path) : r.size_bytes,
        fileCount: r.is_dir === 1 ? rollupCount(deps.db, r.container_path) : 0,
        isMedia: r.is_media === 1,
        flags: flags.get(r.container_path) ?? [],
      })),
    })
  })
}

const rollupSize = (db: Db, prefix: string): number =>
  (db.prepare(
    "SELECT COALESCE(SUM(size_bytes),0) s FROM fs_entries WHERE is_dir = 0 AND container_path LIKE ? || '/%'",
  ).get(prefix) as { s: number }).s

const rollupCount = (db: Db, prefix: string): number =>
  (db.prepare(
    "SELECT COUNT(*) c FROM fs_entries WHERE is_dir = 0 AND container_path LIKE ? || '/%'",
  ).get(prefix) as { c: number }).c

function flagMap(db: Db, paths: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  if (!paths.length) return out
  const rows = db.prepare(
    "SELECT rule_id, subjects_json FROM findings WHERE status = 'open' AND class = 'filesystem'",
  ).all() as Array<{ rule_id: string; subjects_json: string }>
  const wanted = new Set(paths)
  for (const row of rows) {
    const flag = FLAG_BY_RULE[row.rule_id]
    if (!flag) continue
    for (const subject of JSON.parse(row.subjects_json) as Array<{ path?: string }>) {
      if (!subject.path || !wanted.has(subject.path)) continue
      const list = out.get(subject.path) ?? []
      if (!list.includes(flag)) list.push(flag)
      out.set(subject.path, list)
    }
  }
  return out
}
```

- [ ] **Step 4: Implement the Explorer screen**

Breadcrumb from the path, a table of entries (directory rows clickable to descend, `..` row when `parent` is non-null), size via `<Bytes>`, file count, and a flag chip per `flags` entry. Selecting rows queues actions the same way Findings does. Write `client/tests/explorer.test.tsx` covering: renders entries, descends on click, shows the up row only when `parent` exists, renders flags, and renders a hostile filename as text.

- [ ] **Step 5: Run tests and commit**

Run: `npx vitest run tests/api/explorer.test.ts && cd client && npx vitest run`

```bash
git add src/api/explorer.ts src/server.ts client/src/screens/Explorer.tsx tests/api/explorer.test.ts client/tests/explorer.test.tsx
git commit -m "feat: explorer route and screen over the index"
```

---

### Task 6: Plan, History and Settings screens

**Files:**
- Create: `client/src/screens/PlanScreen.tsx`, `client/src/screens/History.tsx`, `client/src/screens/Settings.tsx`
- Test: `client/tests/plan.test.tsx`, `client/tests/settings.test.tsx`

**Interfaces:**
- Produces: `<PlanScreen api={api} queued={RequestedAction[]} onClear={fn} />`, `<History api={api} />`, `<Settings api={api} />`.

- [ ] **Step 1: Write the failing plan test**

```tsx
// client/tests/plan.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PlanScreen } from '../src/screens/PlanScreen.js'

const plan = (over = {}) => ({
  id: 'p1', status: 'draft', createdBy: 'bob', createdAt: 'T', approvedBy: null,
  dryRun: { deleteCount: 2, bytesFreed: 3_221_225_472, torrentsRemoved: 1, blockedCount: 0 },
  actions: [{
    id: 'a1', seq: 0, type: 'delete-media', status: 'pending',
    payload: { targetPath: '/mnt/m/Heat.mkv' },
    guardVerdicts: [{ guard: 'guard.hardlink', outcome: 'warn', overridable: false, reason: '2 links point at these bytes', evidence: { otherLinks: ['/mnt/d/Heat.mkv'] } }],
    error: null,
  }],
  ...over,
})

const api = (over = {}) => ({
  createPlan: vi.fn(async () => plan()),
  getPlan: vi.fn(async () => plan()),
  approvePlan: vi.fn(async () => plan({ status: 'approved' })),
  executePlan: vi.fn(async () => ({ planId: 'p1', status: 'completed', done: 2, failed: 0, skipped: 0, blocked: 0, bytesFreed: 3_221_225_472 })),
  ...over,
} as never)

const queued = [{ type: 'delete-media', targetPath: '/mnt/m/Heat.mkv' }]

describe('PlanScreen', () => {
  it('builds a plan from the queue and shows the dry-run totals', async () => {
    const createPlan = vi.fn(async () => plan())
    render(<PlanScreen api={api({ createPlan })} queued={queued} onClear={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /build plan/i }))
    expect(createPlan).toHaveBeenCalledWith(queued)
    expect(await screen.findByText('3.0 GB')).toBeInTheDocument()
    expect(await screen.findByText(/1 torrent/i)).toBeInTheDocument()
  })

  it('shows each action with its guard verdicts', async () => {
    render(<PlanScreen api={api()} queued={queued} onClear={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /build plan/i }))
    expect(await screen.findByText(/2 links point at these bytes/)).toBeInTheDocument()
  })

  it('will not offer execute before approval', async () => {
    render(<PlanScreen api={api()} queued={queued} onClear={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /build plan/i }))
    expect(screen.queryByRole('button', { name: /^execute/i })).not.toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /approve/i })).toBeInTheDocument()
  })

  it('offers execute once approved, and reports the outcome', async () => {
    render(<PlanScreen api={api()} queued={queued} onClear={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /build plan/i }))
    await userEvent.click(await screen.findByRole('button', { name: /approve/i }))
    await userEvent.click(await screen.findByRole('button', { name: /^execute/i }))
    expect(await screen.findByText(/2 done/i)).toBeInTheDocument()
  })

  it('marks blocked actions and explains why', async () => {
    render(<PlanScreen api={api({
      createPlan: async () => plan({
        dryRun: { deleteCount: 1, bytesFreed: 0, torrentsRemoved: 0, blockedCount: 1 },
        actions: [{
          id: 'a1', seq: 0, type: 'delete-media', status: 'blocked',
          payload: { targetPath: '/mnt/m/Heat.mkv' },
          guardVerdicts: [{ guard: 'guard.protected', outcome: 'block', overridable: false, reason: 'state downloading', evidence: {} }],
          error: null,
        }],
      }),
    })} queued={queued} onClear={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /build plan/i }))
    expect(await screen.findByText(/blocked/i)).toBeInTheDocument()
    expect(await screen.findByText(/state downloading/)).toBeInTheDocument()
  })

  it('rebuilds the plan when an overridable guard is overridden', async () => {
    const createPlan = vi.fn(async () => plan({
      actions: [{
        id: 'a1', seq: 0, type: 'delete-media', status: 'blocked',
        payload: { targetPath: '/mnt/m/Heat.mkv' },
        guardVerdicts: [{ guard: 'guard.private-ratio', outcome: 'block', overridable: true, reason: 'ratio below 1', evidence: {} }],
        error: null,
      }],
    }))
    render(<PlanScreen api={api({ createPlan })} queued={queued} onClear={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /build plan/i }))
    await userEvent.click(await screen.findByRole('checkbox', { name: /override/i }))
    await userEvent.click(screen.getByRole('button', { name: /rebuild/i }))
    expect(createPlan).toHaveBeenLastCalledWith([
      { type: 'delete-media', targetPath: '/mnt/m/Heat.mkv', overrides: ['guard.private-ratio'] },
    ])
  })

  it('shows an empty state when nothing is queued', () => {
    render(<PlanScreen api={api()} queued={[]} onClear={() => {}} />)
    expect(screen.getByText(/nothing queued/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Write the failing settings test**

```tsx
// client/tests/settings.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Settings } from '../src/screens/Settings.js'

const api = (over = {}) => ({
  pathmapGet: async () => ({ mappings: [{ role: 'library', jellyfin: '/media/Movies', container: '/mnt/m', qbit: null }] }),
  pathmapPut: vi.fn(async (m: unknown[]) => ({ mappings: m })),
  pathmapVerify: vi.fn(async () => ({ sampled: 20, resolved: 18, failures: [{ jellyfinPath: '/media/Movies/x.mkv', reason: 'not found on disk' }] })),
  pathmapDetect: vi.fn(async () => ({ proposed: [{ role: 'library', jellyfin: '/media/TV', container: '/mnt/tv', qbit: null }] })),
  ...over,
} as never)

describe('Settings', () => {
  it('lists the configured mappings', async () => {
    render(<Settings api={api()} />)
    expect(await screen.findByDisplayValue('/media/Movies')).toBeInTheDocument()
  })

  it('verifies mappings and shows the resolved ratio and each failure', async () => {
    render(<Settings api={api()} />)
    await userEvent.click(await screen.findByRole('button', { name: /verify/i }))
    expect(await screen.findByText(/18 of 20/i)).toBeInTheDocument()
    expect(await screen.findByText(/not found on disk/)).toBeInTheDocument()
  })

  it('proposes detected mappings without saving them automatically', async () => {
    const pathmapPut = vi.fn(async (m: unknown[]) => ({ mappings: m }))
    render(<Settings api={api({ pathmapPut })} />)
    await userEvent.type(await screen.findByLabelText(/mount roots/i), '/mnt')
    await userEvent.click(screen.getByRole('button', { name: /auto-detect/i }))
    expect(await screen.findByText('/media/TV')).toBeInTheDocument()
    expect(pathmapPut).not.toHaveBeenCalled()
  })

  it('saves mappings on demand', async () => {
    const pathmapPut = vi.fn(async (m: unknown[]) => ({ mappings: m }))
    render(<Settings api={api({ pathmapPut })} />)
    await userEvent.click(await screen.findByRole('button', { name: /save mappings/i }))
    expect(pathmapPut).toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: Run both and confirm they fail**

Run: `cd client && npx vitest run tests/plan.test.tsx tests/settings.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement the three screens**

- **PlanScreen** — Build plan → render dry-run totals (`deleteCount`, `<Bytes>` freed, torrents removed, blocked count) and a row per action with `<GuardVerdictList>`; override checkboxes accumulate into per-action `overrides` and enable a **Rebuild** button that re-posts the queue with them; **Approve** appears only for `draft`, **Execute** only for `approved`; after execute, render the summary (`N done`, failures, skips, blocks, bytes freed).
- **History** — audit table (timestamp, actor, action, subject, outcome), plan list with statuses, a trash list with **Restore** buttons calling `api.restoreTrash`, an **Undo merge** button on completed `merge-versions` entries that queues a `split-versions` action for that item, and a **Resume** button on any plan stuck in `running` (calls `POST /api/plans/:id/resume`, the crash-recovery path).
- **Settings** — editable path-mapping rows (role select, jellyfin/container/qbit inputs, add/remove), **Verify**, **Auto-detect** (mount roots input, proposals shown but never auto-saved), **Save mappings**, and read-only display of the current thresholds.

- [ ] **Step 5: Run everything**

Run: `cd client && npx vitest run && npm run build` then `cd .. && npx vitest run && npm run typecheck && npm run build`
Expected: all tests PASS, `client/dist` produced.

- [ ] **Step 6: Commit**

```bash
git add client/src/screens client/tests
git commit -m "feat: plan, history and settings screens"
```

---

## Definition of done

- Every client and server test passes; both builds are clean.
- The whole flow is drivable in a browser: log in → scan → findings → duplicates → queue → build plan
  → see guard verdicts → approve → execute → see it in history.
- A file named `<img src=x onerror=alert(1)>.mkv` placed in a library appears as literal text on the
  Findings, Explorer and Plan screens, and no `img` element is created.
- With qBittorrent stopped, the Dashboard shows it unreachable and the plan screen refuses to build
  delete actions rather than silently treating the file as torrent-free.
