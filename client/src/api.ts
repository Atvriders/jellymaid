export class ApiError extends Error {
  /**
   * The parsed response body, additive alongside `status`/`message` so existing callers (which
   * only ever read those two) are unaffected. Some refusals are domain statements, not bare
   * errors — e.g. `/api/scan/start`'s 412 sends `{ error, forcible: true }` — and a caller that
   * needs the rest of the statement should read it from here rather than re-deriving it from the
   * status code alone, which only tells you THAT the server refused, not what it said.
   */
  constructor(public readonly status: number, message: string, public readonly body: unknown = undefined) {
    super(message)
    this.name = 'ApiError'
  }
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
  'guard.untracked',
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

/** One file of a matched torrent (C11 `TorrentFileEntry`). */
export interface TorrentFileEntryView {
  relPath: string
  containerPath: string | null
  sizeBytes: number
}

/**
 * C11's `TorrentMatch` as it rides along in a plan action's stored resolution: one torrent the
 * delete would remove, on the box (`instanceId`) that owns it. A plan persisted before Plan 7 stored
 * an older shape without `instanceId`/`companionCount`, so a screen reads these defensively and
 * renders an unknown as unknown, never as a zero.
 */
export interface TorrentMatchView {
  instanceId: string
  hash: string
  name: string
  category: string | null
  tags: string[]
  state: string
  ratio: number
  seedingTimeSeconds: number
  isPrivate: boolean
  trackerHost: string | null
  sizeBytes: number
  matchedBy: 'inode' | 'file' | 'path'
  files: { count: number; entries: TorrentFileEntryView[] } | null
  /** Companion files (.nfo, .srt, samples) that go with the torrent; null when its file list is unknown. */
  companionCount: number | null
}

/**
 * The parts of the planner's `Resolution` (C11, stored in `payload_json`) that a screen reads. The
 * rest of it is the executor's internal detail and rides along untyped rather than being modelled
 * in full here and so silently contradicted by the server.
 */
export interface ResolutionView {
  torrents?: TorrentMatchView[]
}

export interface PlanActionView {
  id: string
  seq: number
  type: ActionType
  status: ActionStatus
  payload: RequestedAction & { resolution?: ResolutionView }
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
  /** Optional for the same reason as `directoriesSwept`: absent from any plan built before Plan 7. */
  companionFiles?: number
  /** Torrents and bytes each qBittorrent instance gives up. Absent from any plan built before Plan 7. */
  byInstance?: Record<string, { torrents: number; bytes: number }>
}

export type PlanStatus = 'draft' | 'approved' | 'running' | 'completed' | 'failed'

export interface PlanView {
  id: string
  status: PlanStatus
  createdBy: string
  createdAt: string
  approvedBy: string | null
  /** Why a background run failed (C12); null otherwise. */
  error: string | null
  actions: PlanActionView[]
  dryRun: PlanDryRun
  /** Actions that reached a final status, out of every action in the plan. */
  progress: { total: number; finished: number }
  /** Overrides a (re)build dropped because that guard no longer blocks the action with this `seq`. */
  droppedOverrides: Array<{ seq: number; guard: GuardId }>
}

/** POST /api/plans/:id/execute answers 202 with this; the run itself continues in the background. */
export interface ExecuteStarted {
  planId: string
  status: 'running'
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
  /** The root prefix exactly as qBittorrent instance `qbitInstance` reports it. */
  qbit: string | null
  /** Instance id owning `qbit`. Both null = this root is explicitly NOT torrent-backed. */
  qbitInstance: string | null
}

/** Jellyfin → container half of a verification (C7). */
export interface JellyfinVerifyReport {
  sampled: number
  resolved: number
  failures: Array<{ jellyfinPath: string; reason: string }>
}

/** One qBittorrent instance's half of a verification (C6 `QbitVerifyReport`). */
export interface QbitVerifyReport {
  instanceId: string
  sampled: number
  resolved: number
  failures: Array<{ qbitPath: string; reason: string }>
  /**
   * Completed torrents under none of the instance's mapped qBittorrent folders: not checked, not
   * failures, only counted, with up to five example paths. Absent when there are none, and in a
   * record written before the server reported it.
   */
  ignored?: { count: number; examples: string[] }
}

/** C7 `VerificationRecord` plus whether it still describes the mappings saved right now. */
export interface VerificationView {
  at: string
  mappingsHash: string
  jellyfin: JellyfinVerifyReport
  qbit: QbitVerifyReport[]
  current: boolean
}

/** GET and PUT /api/pathmap. */
export interface PathMapState {
  mappings: PathMapping[]
  /** `normalizeMappings` problems — each one is a mapping hole that fails closed. */
  problems: string[]
  lastVerification: VerificationView | null
}

/** GET /api/qbit/instances: one row per configured instance, credentials already stripped from `url`. */
export interface QbitInstanceView {
  id: string
  url: string
  reachable: boolean
  version: string | null
  error: string | null
  torrentCount: number | null
}

/** A /healthz connector entry for one qBittorrent instance. */
export interface QbitInstanceHealth {
  status: 'ok' | 'unreachable' | 'auth' | 'not-configured'
  version?: string
  error?: string
}

export interface HealthView {
  status: 'ok' | 'degraded'
  schemaVersion: number
  /**
   * Each connector's status string by name — plus, since Plan 7, `qbitInstances`: an OBJECT holding
   * one entry per qBittorrent instance, sitting among the strings. Never render
   * `Object.entries(connectors)` without separating the two.
   */
  connectors: { [name: string]: string | Record<string, QbitInstanceHealth> | undefined; qbitInstances?: Record<string, QbitInstanceHealth> }
}

export type KeeperPolicy = 'best-quality' | 'smallest' | 'none'

export interface GuardSettings {
  minRatio: number
  minSeedTimeDays: number
  protectedCategories: string[]
  protectedTags: string[]
  privateTrackerHosts: string[]
}

/** GET/PUT /api/config/settings. Saved settings apply live, without a restart. */
export interface SettingsView {
  guards: GuardSettings
  keeper: { policy: KeeperPolicy }
  /** Read-only here: the PUT accepts only `guards` and `keeper`. */
  trash: { maxBytes: number; retentionDays: number }
}

/** The PUT body: any subset of `guards` and `keeper`. Arrays replace; siblings are kept. */
export interface SettingsPatch {
  guards?: Partial<GuardSettings>
  keeper?: { policy?: KeeperPolicy }
}

export interface TrashEntry {
  id: string
  originalPath: string
  sizeBytes: number
  deletedAt: string
  purgeAfter: string
  /** null means still restorable; a restored entry stays listed rather than disappearing. */
  restoredAt: string | null
  planId: string | null
}

/** One torrent's facts as the Duplicates screen needs them (C12 `TorrentFactsView`). */
export interface TorrentFactsView {
  instanceId: string
  hash: string
  name: string
  state: string
  ratio: number
  seedingDays: number
  isPrivate: boolean
  trackerHost: string | null
  sizeBytes: number
  fileCount: number
  mediaFileCount: number
  /** `!isPrivate || (ratio >= minRatio && seedingDays >= minSeedTimeDays)` under the CURRENT thresholds. */
  hnrMet: boolean
}

/** One copy in a duplicate group (C12 `DupeMemberView`). */
export interface DupeMemberView {
  id: string
  name: string
  containerPath: string | null
  sizeBytes: number | null
  width: number | null
  height: number | null
  bitrate: number | null
  videoCodec: string | null
  audioChannels: number | null
  container: string | null
  libraryName: string | null
  /**
   * The video stream's colour range exactly as Jellyfin reported it ('SDR' | 'HDR10' | 'HLG' |
   * 'Dolby Vision' | ...), or null when this row predates the column or this Jellyfin does not
   * report one. Corroborates the keeper score's `hdr` weight (src/rules/keeper.ts) — that score
   * alone cannot say whether a 0 means "confirmed SDR" or "we never found out"; this is the fact
   * behind it.
   */
  videoRange: string | null
  /** Whether this item carries ANY subtitle stream — not a count or a language list. */
  hasSubtitles: boolean
  edition: string | null
  /** The box whose torrents may own this file (`torrentSourceFor`), else null. */
  instanceId: string | null
  /** The first torrent owning `containerPath` per the index; null when none does. */
  torrent: TorrentFactsView | null
  /** Torrents owning this file; more than one means it is cross-seeded. */
  torrentCount: number
}

/** One duplicate group (C12 `DupeGroupView`). */
export interface DupeGroupView {
  id: string
  tier: Confidence
  /**
   * Which duplicate matcher(s) (`dupe.provider-id`, `dupe.identical-file`, ...) actually agreed on
   * this group — never inferred from `tier` alone: `tier` is the HIGHEST confidence any single
   * matcher reported, and 'exact' does not mean byte-verified. `dupe.provider-id` and
   * `dupe.series-episode` both emit 'exact' from pure metadata, and `dupe.identical-file`'s 'exact'
   * rests on a head+tail SAMPLED hash, not the whole file (src/fs/hasher.ts). Empty when the group
   * has no corresponding `dupe.group` finding to join against — never fabricated.
   */
  matchedBy: string[]
  /** The copy the scan's keeper policy picked; null under policy `none` (the operator picks). */
  keeperItemId: string | null
  /** The policy that picked `keeperItemId` — the one in force at that scan, not necessarily now. */
  keeperPolicy: KeeperPolicy
  title: string
  year: number | null
  kind: 'movie' | 'episode'
  seriesName: string | null
  seasonNo: number | null
  episodeNo: number | null
  editionsDiffer: boolean
  /**
   * A member's file holds more than one episode (`S01E01E02`): deleting it loses the later
   * episodes too. The bulk queue skips such a group unless the operator includes it.
   */
  multiEpisode: boolean
  /** Members live on more than one qBittorrent instance. */
  crossInstance: boolean
  /** Sum of the non-keepers' sizes; 0 when `keeperItemId` is null. */
  reclaimableBytes: number
  scores: Record<string, { total: number; breakdown: Record<string, number> }>
  /** Members already deleted (deleted_paths) are left out; a group left with < 2 is omitted. */
  members: DupeMemberView[]
}

export interface DuplicatesResponse {
  /** False when the duplicate rule did not run in the latest scan — the list is then NOT a clean bill. */
  evaluated: boolean
  reason: string | null
  scanId: number | null
  scanFinishedAt: string | null
  /** Dismissed groups are not listed. */
  groups: DupeGroupView[]
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

/**
 * One page of a directory listing. `total`/`offset`/`limit` arrive with every listing below a root;
 * they are optional only because the top-level roots listing (no `path`) is a complete list that
 * need not page — a screen must treat a missing `total` as "this is everything", never as zero.
 */
export interface ExplorerPage {
  path: string
  parent: string | null
  entries: ExplorerEntry[]
  total?: number
  offset?: number
  limit?: number
}

/**
 * C12: every error is `{ error, reason? }`, and for the Plan 7 refusals `error` is a machine word
 * ('busy', 'verification', 'not-approved') while `reason` is the sentence an operator can act on
 * ("scan 12 is running", "the path mappings changed since they were last verified"). Showing the
 * bare word would tell an operator THAT something refused but not why, so the reason wins whenever
 * the server sent one. The parsed body still rides along on `ApiError.body` for a caller that needs
 * the machine word or any other field (`forcible`, say).
 */
function errorMessage(body: unknown, status: number): string {
  const { error, reason } = (typeof body === 'object' && body !== null ? body : {}) as { error?: unknown; reason?: unknown }
  if (typeof reason === 'string' && reason !== '') return reason
  if (typeof error === 'string' && error !== '') return error
  return `HTTP ${status}`
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
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
    if (!res.ok) throw new ApiError(res.status, errorMessage(body, res.status), body)
    return body as T
  }

  const post = <T>(path: string, payload?: unknown) =>
    call<T>(path, { method: 'POST', ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) })

  return {
    login: (username: string, password: string) =>
      post<{ username: string; userId: string }>('/api/auth/login', { username, password }),
    logout: () => post<{ ok: true }>('/api/auth/logout'),
    me: () => call<{ username: string; userId: string }>('/api/auth/me'),
    health: () => call<HealthView>('/healthz'),

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

    duplicates: () => call<DuplicatesResponse>('/api/duplicates'),
    mergeGroup: (groupId: string) => post<{ merged: string[] }>(`/api/duplicates/${groupId}/merge`),
    // Both answer 204 with no body. The dismiss body is always a JSON object (`{}` without a
    // reason) because it declares Content-Type; reopen sends none and so declares none.
    dismissDuplicate: async (groupId: string, reason?: string): Promise<void> => {
      await post(`/api/duplicates/${groupId}/dismiss`, reason === undefined ? {} : { reason })
    },
    reopenDuplicate: async (groupId: string): Promise<void> => {
      await post(`/api/duplicates/${groupId}/reopen`)
    },

    createPlan: (actions: RequestedAction[]) => post<PlanView>('/api/plans', { actions }),
    plans: () => call<{ plans: PlanSummary[] }>('/api/plans'),
    getPlan: (id: string) => call<PlanView>(`/api/plans/${id}`),
    approvePlan: (id: string) => post<PlanView>(`/api/plans/${id}/approve`),
    // 202: the run continues in the background; poll getPlan for progress and the final status.
    executePlan: (id: string) => post<ExecuteStarted>(`/api/plans/${id}/execute`),
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

    pathmapGet: () => call<PathMapState>('/api/pathmap'),
    pathmapPut: (mappings: PathMapping[]) =>
      call<PathMapState>('/api/pathmap', { method: 'PUT', body: JSON.stringify({ mappings }) }),
    pathmapVerify: () => post<VerificationView>('/api/pathmap/verify'),
    pathmapDetect: (mountRoots: string[]) => post<{ proposals: PathMapping[] }>('/api/pathmap/detect', { mountRoots }),
    qbitInstances: () => call<{ instances: QbitInstanceView[] }>('/api/qbit/instances'),

    // `opts` defaults to `{}` so existing zero-argument callers (`api.trash()`) keep working
    // unchanged — the query string it produces is identical to before pagination existed. `total`
    // is additive on the response: it lets a caller say "showing N of M" instead of the old
    // behaviour of silently truncating at a fixed 200-row limit with no way to page past it.
    trash: (opts: { limit?: number; offset?: number; includeRestored?: boolean } = {}) =>
      call<{ entries: TrashEntry[]; total: number }>(`/api/trash${qs(opts)}`),
    settings: () => call<SettingsView>('/api/config/settings'),
    saveSettings: (patch: SettingsPatch) =>
      call<SettingsView>('/api/config/settings', { method: 'PUT', body: JSON.stringify(patch) }),

    explorer: (path?: string, page: { offset?: number; limit?: number } = {}) =>
      call<ExplorerPage>(`/api/explorer${qs({ path, offset: page.offset, limit: page.limit })}`),
  }
}

export type Api = ReturnType<typeof createApi>
