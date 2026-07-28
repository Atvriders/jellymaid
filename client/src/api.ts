export class ApiError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'ApiError' }
}

// Mirrors src/core/types.ts. Duplicated here (not imported) because the client is its own
// package with its own tsconfig/build and does not reach into ../../src.
export const ACTION_TYPES = [
  'merge-versions', 'split-versions', 'delete-media', 'remove-empty-folder', 'delete-junk-file',
] as const
export type ActionType = (typeof ACTION_TYPES)[number]

export const ACTION_STATUSES = ['pending', 'running', 'done', 'failed', 'skipped', 'blocked'] as const
export type ActionStatus = (typeof ACTION_STATUSES)[number]

export const GUARD_IDS = [
  'guard.private-ratio', 'guard.cross-seed', 'guard.hardlink', 'guard.protected', 'guard.torrent-scope',
] as const
export type GuardId = (typeof GUARD_IDS)[number]

export const FINDING_CLASSES = ['duplicate', 'filesystem', 'metadata', 'quality'] as const
export type FindingClass = (typeof FINDING_CLASSES)[number]

export const SEVERITIES = ['critical', 'warning', 'info'] as const
export type Severity = (typeof SEVERITIES)[number]

export const CONFIDENCES = ['exact', 'strong', 'possible'] as const
export type Confidence = (typeof CONFIDENCES)[number]

export type FindingStatus = 'open' | 'dismissed' | 'resolved'
export type ScanStatusValue = 'running' | 'completed' | 'cancelled' | 'failed'

export type Subject =
  | { kind: 'item'; id: string; label: string; path?: string }
  | { kind: 'path'; path: string; label: string }

export interface Finding {
  id: string
  ruleId: string
  class: FindingClass
  severity: Severity
  confidence: Confidence
  subjects: Subject[]
  evidence: Record<string, unknown>
  reclaimableBytes: number | null
  status: FindingStatus
  firstSeen: string
  lastSeen: string
  dismissedReason: string | null
  dismissedBy: string | null
}

export interface GuardVerdict {
  guard: GuardId
  outcome: 'pass' | 'warn' | 'block'
  overridable: boolean
  reason: string
  evidence: Record<string, unknown>
}

export interface RequestedAction {
  type: ActionType
  targetPath?: string
  itemIds?: string[]
  overrides?: GuardId[]
}

export interface PlanActionView {
  id: string
  seq: number
  type: ActionType
  status: ActionStatus
  // `resolution` really is on the wire (buildPlan/getPlan embed it in payload_json), but its
  // shape is the executor's internal Resolution type — not something any Plan 5 screen reads
  // directly (isAlternateVersion below is the one part of it that is surfaced). Typed `unknown`
  // rather than modelled in full, and rather than omitted and so silently contradicted.
  payload: RequestedAction & { resolution?: unknown }
  guardVerdicts: GuardVerdict[]
  error: string | null
  isAlternateVersion: boolean | null
}

export interface PlanDryRun {
  deleteCount: number
  bytesFreed: number
  torrentsRemoved: number
  blockedCount: number
  /**
   * Undefined, not just absent-from-type: a plan persisted before this field existed has no
   * `directoriesSwept` key in its stored `dry_run_json` at all, and `JSON.parse` will not
   * manufacture one. A screen must not render "undefined directories swept" for one of these —
   * treat a missing value as "unknown", not as zero.
   */
  directoriesSwept?: number
}

export interface PlanView {
  id: string
  status: string
  createdBy: string
  createdAt: string
  approvedBy: string | null
  actions: PlanActionView[]
  dryRun: PlanDryRun
}

export interface PlanSummary {
  id: string
  createdAt: string
  createdBy: string
  status: string
  dryRun: PlanDryRun
}

export interface ExecutionSummary {
  planId: string
  status: 'completed' | 'failed'
  done: number
  failed: number
  skipped: number
  blocked: number
  bytesFreed: number
}

export interface PathMapping {
  role: 'library' | 'download'
  jellyfin: string | null
  container: string
  qbit: string | null
}

export interface VerifyReport {
  sampled: number
  resolved: number
  failures: Array<{ jellyfinPath: string; reason: string }>
}

export interface DupeMember {
  id: string
  name: string
  container_path: string | null
  size_bytes: number | null
  height: number | null
  bitrate: number | null
  video_codec: string | null
  audio_channels: number | null
  container: string | null
  library_name: string | null
}

export interface DupeGroup {
  id: string
  tier: string
  keeperItemId: string | null
  scores: Record<string, { total: number; breakdown: Record<string, number> }>
  members: DupeMember[]
}

export interface ExplorerEntry {
  name: string
  path: string
  isDir: boolean
  sizeBytes: number
  fileCount: number
  isMedia: boolean
  flags: string[]
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
    // Content-Type is attached ONLY when there is a body. Fastify's JSON body parser treats a
    // request that DECLARES 'application/json' but sends no body as an error
    // (FST_ERR_CTP_EMPTY_JSON_BODY, a 400) — verified against this project's own Fastify version.
    // Most of this module's POSTs (logout, scanCancel, approvePlan, executePlan, resumePlan,
    // dismiss/reopen-less merge, pathmapVerify, trash restore) carry no body at all, so a helper
    // that always sets this header would 400 every one of them against the real server despite
    // passing tests that mock `fetch` directly. See client/tests/api.test.ts's Fastify-backed
    // regression test.
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) }
    if (init.body !== undefined && headers['Content-Type'] === undefined) headers['Content-Type'] = 'application/json'

    const res = await doFetch(`${opts.baseUrl}${path}`, {
      credentials: 'include',
      ...init,
      headers,
    })
    const text = await res.text()
    const body = text ? JSON.parse(text) : {}
    if (!res.ok) throw new ApiError(res.status, (body as { error?: string }).error ?? `HTTP ${res.status}`)
    return body as T
  }

  const post = <T>(path: string, payload?: unknown) =>
    call<T>(path, { method: 'POST', ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) })

  return {
    login: (username: string, password: string) =>
      post<{ username: string; userId: string }>('/api/auth/login', { username, password }),
    logout: () => post<{ ok: true }>('/api/auth/logout'),
    me: () => call<{ username: string; userId: string }>('/api/auth/me'),
    health: () => call<{ status: 'ok' | 'degraded'; schemaVersion: number; connectors: Record<string, string> }>('/healthz'),

    scanStart: (options: { resumeScanId?: number; force?: boolean } = {}) =>
      post<{ scanId: number }>('/api/scan/start', options),
    scanCancel: () => post<{ cancelled: true }>('/api/scan/cancel'),
    scanStatus: () => call<{
      running: boolean; scanId: number | null; phase: string | null; done: number; total: number | null
      lastScan: unknown
    }>('/api/scan/status'),

    findings: (f: {
      class?: FindingClass; severity?: Severity; confidence?: Confidence; status?: FindingStatus
      ruleId?: string; limit?: number; offset?: number
    } = {}) => call<{ findings: Finding[]; total: number }>(`/api/findings${qs(f)}`),

    // `evaluated`/`basedOn`/`latestAttempt` are not decoration: `byClass` and `reclaimableBytes`
    // describe the last scan that actually reached the rules phase (`basedOn`), which is NOT
    // necessarily the newest scan. A screen must be able to say which scan it is reporting on, and
    // must surface `latestAttempt` when a newer scan failed before rules ran ("these results are
    // from scan 41; scan 42 failed") — otherwise a dead scan renders as a clean pass.
    findingsSummary: () => call<{
      evaluated: boolean
      basedOn: { scanId: number; status: ScanStatusValue; finishedAt: string | null } | null
      latestAttempt: { scanId: number; status: ScanStatusValue } | null
      byClass: Record<string, number>
      reclaimableBytes: number
      notEvaluated: Array<{ ruleId: string; reason: string }>
    }>('/api/findings/summary'),
    dismissFinding: (id: string, reason: string) => post<{ ok: true }>(`/api/findings/${id}/dismiss`, { reason }),
    reopenFinding: (id: string) => post<{ ok: true }>(`/api/findings/${id}/reopen`),

    duplicates: () => call<{ groups: DupeGroup[] }>('/api/duplicates'),
    mergeGroup: (groupId: string) => post<{ merged: string[] }>(`/api/duplicates/${groupId}/merge`),

    createPlan: (actions: RequestedAction[]) => post<PlanView>('/api/plans', { actions }),
    plans: () => call<{ plans: PlanSummary[] }>('/api/plans'),
    getPlan: (id: string) => call<PlanView>(`/api/plans/${id}`),
    approvePlan: (id: string) => post<PlanView>(`/api/plans/${id}/approve`),
    executePlan: (id: string) => post<ExecutionSummary>(`/api/plans/${id}/execute`),
    // Spec §13 crash recovery: resumes a plan a killed process left stuck in `running`.
    resumePlan: (id: string) => post<ExecutionSummary>(`/api/plans/${id}/resume`),

    audit: (limit = 200) => call<{
      entries: Array<{
        ts: string; actor: string; actionType: string; subject: string; outcome: string
        planId: string | null; afterJson: string | null
      }>
    }>(`/api/audit${qs({ limit })}`),

    /**
     * NOT built on `post()`/`call()`: this is the one route in the app whose REFUSAL is a domain
     * result, not an error. `restoreFromTrash` (src/plan/trash.ts) always returns
     * `{ restored, reason? }`, and the route sends it on a 409 when `restored` is false — with no
     * `error` key at all. `call()`'s generic handling treats any non-2xx as a failure and looks
     * for `.error`, which is not there; it would throw `ApiError(409, 'HTTP 409')` and silently
     * drop the actual reason ("trashed file is gone", "a file already exists at the original
     * path", …) the route went out of its way to report. So 409 is read here as a normal
     * resolved value, same as 200 — and anything else (401 unauthenticated, 500) still throws.
     */
    restoreTrash: async (id: string): Promise<{ restored: boolean; reason?: string }> => {
      const res = await doFetch(`${opts.baseUrl}/api/trash/${id}/restore`, { method: 'POST', credentials: 'include' })
      const text = await res.text()
      const body = text ? JSON.parse(text) : {}
      if (res.ok || res.status === 409) return body as { restored: boolean; reason?: string }
      throw new ApiError(res.status, (body as { error?: string }).error ?? `HTTP ${res.status}`)
    },

    pathmapGet: () => call<{ mappings: PathMapping[] }>('/api/pathmap'),
    pathmapPut: (mappings: PathMapping[]) =>
      call<{ mappings: PathMapping[] }>('/api/pathmap', { method: 'PUT', body: JSON.stringify({ mappings }) }),
    pathmapVerify: () => post<VerifyReport>('/api/pathmap/verify'),
    pathmapDetect: (mountRoots: string[]) => post<{ proposed: PathMapping[] }>('/api/pathmap/detect', { mountRoots }),

    // Task 5 wires the server side of this (src/api/explorer.ts is not registered yet); the
    // wrapper is built now so no later screen ever hand-rolls the fetch, per this task's own
    // contract. Shape matches task-5-brief.md's route exactly.
    explorer: (path?: string) =>
      call<{ path: string; parent: string | null; entries: ExplorerEntry[] }>(`/api/explorer${qs({ path })}`),
  }
}

export type Api = ReturnType<typeof createApi>
