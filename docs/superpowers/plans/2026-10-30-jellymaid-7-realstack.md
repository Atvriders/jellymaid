# Jellymaid 7 — Real-Stack Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Jellymaid's dupe flow work end to end against Jellyfin 12.1 and two qBittorrent 5.x
instances whose torrents are saved straight into the library: scan → duplicates → verify → plan →
delete torrent + files on the right box → Jellyfin forgets.

**Architecture:** Task 1 lands the whole cross-lane contract below — types, schema, migration,
config store, activity lock and instance registry — with every call site compiling and the suite
green. Tasks 2–10 then run in parallel in separate git worktrees, each owning a disjoint set of
files and filling in behavior test-first. Task 11 wires and integrates. Tasks 12–13 prove it on real
software and ship.

**Tech Stack:** Node 22 (CI/Docker) / Node 20 (local tests), TypeScript strict, Fastify 5,
better-sqlite3 11, zod 3, React 19 + Vite, vitest, Playwright (harness E2E only).

**Spec:** `docs/superpowers/specs/2026-10-30-jellymaid-realstack-design.md`. Read it first. Where
this plan's contract code and the spec's prose disagree, **the contract code wins**.

## Global Constraints

- Run tests with Node 20: `PATH=$HOME/.nvm/versions/node/v20.20.2/bin:$PATH npx vitest run`, from
  the repo root for the server and from `client/` for the client. The sandbox's default Node 24
  cannot load better-sqlite3 11.10. Typecheck: `npm run typecheck`, and
  `npm --prefix client run typecheck` if present, else `npx tsc -p client --noEmit`.
- **Never** add a call to Jellyfin `DELETE /Items/{id}` or `POST /Library/Refresh`. A test in Task 11 greps for them.
- **Never** retry qBittorrent login more than once per backoff window. 5 failures = 1-hour IP ban.
- No real LAN IPs, hostnames, share paths or credentials in anything committed: code, tests,
  fixtures, docs, screenshots. Use RFC 5737 addresses (`192.0.2.x`, `198.51.100.x`, `203.0.113.x`),
  `/path/to/...`, and the instance ids `box-a` / `box-b`. Sweep before every commit:
  `grep -rInE '192\.168\.|10\.[0-9]+\.[0-9]+\.|/mnt/[u]ser/' --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git .`
- Work happens in lane branches with WIP checkpoint commits (`wip(<lane>): …`) after every green
  step, so an agent killed by a usage limit loses nothing. Keep a `LANE_PROGRESS.md` at the worktree
  root (deleted in Task 11). `master` receives **one** squashed commit at the very end (Task 13).
- Fail closed: unknown = blocked. An empty answer from a source that failed is never "nothing found".
- Every existing invariant documented in code comments stays true unless this plan explicitly
  changes it. Read the comment before deleting the code under it.
- Keep the repo's style: long explanatory comments where a reviewer would otherwise "simplify" a
  safety property away, none elsewhere.

## Review Focus

1. **Two instances with the same internal path.** Box A and box B both report `/movies/X`. Deleting
   box B's copy calls only box B's `deleteWithData`, with box B's hash. Box A's client is never
   called. The reverse holds too. Pinned in Task 7 (`executor routes deletes to the owning instance
   only`) and Task 12 E2E.
2. **A movie release with sidecars.** Deleting the video of a torrent that also holds `.nfo`,
   `.srt` and `Sample/sample.mkv` passes `guard.torrent-scope` without an override and removes the
   whole torrent. A season pack with only one episode queued still blocks. Pinned in Task 7
   (`torrent-scope ignores companion files`, `torrent-scope still blocks a partially queued
   pack`).
3. **Jellyfin must never delete files.** No `DELETE /Items` or `/Library/Refresh` in `src/`.
   `notifyPathsDeleted` runs only for paths confirmed gone. Pinned in Task 11
   (`no destructive Jellyfin endpoints in src`) and Task 7 (`notifies Jellyfin only for paths that
   are gone`).
4. **qBittorrent 5.1/5.2 login semantics.** `200 Fails.` is a failure. `204` is success. The cookie
   is replayed under the name the server chose. After a failure there are no further login attempts
   inside the backoff window. Pinned in Task 2.
5. **A mapping hole fails closed.** A root with a qbit prefix but no instance, an instance id with
   no client, or an unverified mapping set blocks the delete or the plan build. A file in a
   torrent-backed root that no torrent owns needs an explicit `guard.untracked` override. Pinned in
   Task 7 and Task 1 (`verificationBlocker`).

---

## Locked Interface Contract

Everything below is authoritative for all tasks. Names, types, JSON keys, file names and the order
of operations are fixed. A task that needs something not listed here keeps it private to its own
files.

### C1. Core types — `src/core/types.ts`

```ts
export interface PathMapping {
  role: PathRole
  jellyfin: string | null
  container: string
  /** The root prefix exactly as qBittorrent instance `qbitInstance` reports it. */
  qbit: string | null
  /** Instance id owning `qbit`. Both null = this root is explicitly NOT torrent-backed. */
  qbitInstance: string | null
}

export const GUARD_IDS = [
  'guard.private-ratio', 'guard.cross-seed', 'guard.hardlink', 'guard.protected', 'guard.torrent-scope',
  'guard.untracked',
] as const

export interface TorrentRef { instanceId: string; hash: string }
/** NUL-joined, hash lowercased. */
export function torrentKey(ref: TorrentRef): string

export type TorrentSource =
  | { kind: 'instance'; instanceId: string }
  | { kind: 'none' }
  | { kind: 'unknown'; reason: string }
```

### C2. Companion files — `src/core/companions.ts` (new)

```ts
/** True when the file travels with its release rather than being the release itself: its
 *  extension (lowercased, with dot) is not in `mediaExtensions`, OR any directory segment of
 *  `relPath` (lowercased) is in rules['fs.junk'].directoryNames, OR its basename matches any
 *  rules['fs.junk'].namePatterns (case-insensitive). `Sample/sample.mkv` → true; `Movie.mkv` → false. */
export function isCompanionFile(relPath: string, config: Pick<FileConfig, 'mediaExtensions' | 'rules'>): boolean
```

### C3. Activity lock — `src/core/activity.ts` (new)

```ts
export type ActivityKind = 'scan' | 'plan'
export interface ActivityLock {
  tryAcquire(kind: ActivityKind, id: string): { ok: true } | { ok: false; heldBy: { kind: ActivityKind; id: string } }
  /** No-op unless currently held by exactly (kind, id). */
  release(kind: ActivityKind, id: string): void
  current(): { kind: ActivityKind; id: string } | null
}
export function createActivityLock(): ActivityLock
```

### C4. Config — `src/config/schema.ts`, `src/config/load.ts`, `src/config/store.ts` (new)

```ts
export const QBIT_INSTANCE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/
export const qbitInstanceSchema = z.object({
  id: z.string().regex(QBIT_INSTANCE_ID_PATTERN),
  url: z.string().url(),            // credentials stripped
  user: z.string().min(1).nullable(),
  pass: z.string().min(1).nullable(),
})
export type QbitInstanceConfig = z.infer<typeof qbitInstanceSchema>
// envConfigSchema: `qbittorrent` is REPLACED by
//   qbittorrents: z.array(qbitInstanceSchema).min(1)   (+ refine: ids unique)
// pathMappingSchema gains
//   qbitInstance: z.string().regex(QBIT_INSTANCE_ID_PATTERN).nullable().default(null)
//   superRefine: qbitInstance !== null requires qbit !== null
// fileConfigSchema gains
//   keeper: z.object({ policy: z.enum(['best-quality', 'smallest', 'none']).default('best-quality') }).default({})
// and changes defaults:
//   rules['meta.bad-naming'].enabled -> false
//   rateLimits.qbittorrent -> { concurrency: 4, minDelayMs: 25 }
export type KeeperPolicy = 'best-quality' | 'smallest' | 'none'
```

```ts
// load.ts
/** QBIT_INSTANCES="id=url, id=url" (URL may embed user:pass@, percent-decoded; per-instance
 *  QBIT_<ID>_USER / QBIT_<ID>_PASS override, <ID> = id uppercased, '-' -> '_'). Without it,
 *  QBIT_URL (+ optional QBIT_USER/QBIT_PASS) defines id 'default'. Pushes a problem (and returns [])
 *  when neither is set, an id is invalid or duplicated, a URL does not parse, or exactly one of
 *  user/pass is set for an instance. */
export function parseQbitInstances(env: NodeJS.ProcessEnv, problems: string[]): QbitInstanceConfig[]
// loadConfig: only JELLYFIN_URL and JELLYFIN_API_KEY are individually required; QBIT_USER/QBIT_PASS no longer.
// saveConfig(dataDir, patch): the subtrees `guards`, `trash`, `keeper`, `rateLimits`, `rules` are merged ONE
// level deep (patch keys replace, siblings kept; arrays replace); every other key replaces wholesale.
```

```ts
// store.ts
export interface ConfigStore {
  readonly env: EnvConfig
  /** Cached; re-read when config.json's mtimeMs or size changes. Throws ConfigError if invalid. */
  file(): FileConfig
  /** createPathMap(normalizeMappings(file().pathMappings, instanceIds()).mappings), memoized on the mappings' JSON. */
  pathMap(): PathMap
  mappingProblems(): string[]
  /** mappingsHash() of the NORMALIZED mappings. */
  mappingsHash(): string
  instanceIds(): string[]
  /** saveConfig + cache invalidation. */
  save(patch: Partial<FileConfig>): FileConfig
}
export function createConfigStore(env: EnvConfig): ConfigStore
```

### C5. Index — `src/index/migrations/005_multi_instance.sql` (new) and `src/index/db.ts`

```sql
DROP TABLE IF EXISTS torrent_files;
DROP TABLE IF EXISTS torrents;
CREATE TABLE torrents (
  instance_id            TEXT NOT NULL,
  hash                   TEXT NOT NULL,
  fetched_at             TEXT NOT NULL,
  name                   TEXT NOT NULL,
  save_path              TEXT,
  content_path           TEXT,
  root_path              TEXT,
  container_content_path TEXT,
  category               TEXT,
  tags                   TEXT,
  state                  TEXT,
  ratio                  REAL,
  seeding_time           INTEGER,
  is_private             INTEGER,
  tracker_host           TEXT,
  size_bytes             INTEGER,
  progress               REAL,
  added_on               INTEGER,
  files_error            TEXT,
  PRIMARY KEY (instance_id, hash)
);
CREATE TABLE torrent_files (
  instance_id    TEXT NOT NULL,
  hash           TEXT NOT NULL,
  file_index     INTEGER NOT NULL,
  rel_path       TEXT NOT NULL,
  container_path TEXT,
  size_bytes     INTEGER,
  dev            INTEGER,
  inode          INTEGER,
  PRIMARY KEY (instance_id, hash, file_index)
);
CREATE INDEX idx_torrent_files_inode ON torrent_files (dev, inode);
CREATE INDEX idx_torrent_files_path ON torrent_files (container_path);
CREATE TABLE deleted_paths (
  container_path TEXT PRIMARY KEY,
  plan_id        TEXT NOT NULL,
  deleted_at     TEXT NOT NULL
);
ALTER TABLE plans ADD COLUMN error TEXT;
```

`openDb` additionally sets `busy_timeout = 15000`.

### C6. Path map — `src/fs/pathmap.ts`

```ts
export interface PathMap {
  toContainer(jellyfinPath: string): string | null
  fromContainer(containerPath: string): string | null
  /** CHANGED: only mappings whose qbitInstance === instanceId are considered. */
  qbitToContainer(instanceId: string, qbitPath: string): string | null
  /** Deepest root containing the path: qbit+qbitInstance -> instance; neither -> none;
   *  qbit without qbitInstance, or no root -> unknown. */
  torrentSourceFor(containerPath: string): TorrentSource
  rootFor(containerPath: string): PathMapping | null
  libraryRoots(): PathMapping[]
  downloadRoots(): PathMapping[]
  isWithinRoot(containerPath: string, root: PathMapping): boolean
  all(): PathMapping[]
}
/** Fills qbitInstance for a mapping with qbit set and qbitInstance null ONLY when exactly one
 *  instance exists; otherwise leaves it null and reports a problem. Also reports qbitInstance ids
 *  that are not configured. Never mutates its input.
 *  Final fix wave (part 3, re-review N1): also reports, after filling, each instance that maps one
 *  qbit prefix (trailing slashes ignored) to two or more different containers: "<id> maps <prefix>
 *  to two folders (<A>, <B>); one of them probably belongs to another box. …". Nested prefixes of one
 *  instance are not reported (the deepest translates; no path has two translations). */
export function normalizeMappings(mappings: PathMapping[], instanceIds: string[]): { mappings: PathMapping[]; problems: string[] }
/** First 16 hex chars of sha256 over the canonical JSON of the mappings sorted by container. */
export function mappingsHash(mappings: PathMapping[]): string

export interface QbitVerifyReport {
  instanceId: string
  sampled: number
  resolved: number
  failures: Array<{ qbitPath: string; reason: string }>
  ignored?: { count: number; examples: string[] }   // added by the final fix wave (part 2): completed torrents under
                                                    // none of the instance's own qbit prefixes — never sampled, never
                                                    // failures; up to 5 example paths; absent when count would be 0
}
export interface QbitSampleSource { id: string; torrents: () => Promise<Torrent[]> }
/** Task 4. Per instance: up to sampleSize (default 20) torrents with progress === 1, chosen by
 *  stable spread over hash order. Maps content_path -> container, which must exist; for a
 *  single-file torrent (rootPath === '') the file size must equal the torrent size.
 *  Final fix wave (part 2): only torrents whose content_path lies under one of THIS instance's
 *  qbit prefixes are sampled, dealt round-robin across those prefixes (each prefix's share by the
 *  same stable spread), so every mapped prefix is sampled when sampleSize allows. The rest are
 *  reported in `ignored`, not as failures. A prefix that no completed torrent lies under fails
 *  ("no completed torrent of "<id>" reports a path under <prefix> — check the qBittorrent path")
 *  while the instance has completed torrents; so does a prefix whose completed torrents are all
 *  missingFiles/error. The every-torrent check against roots marked not torrent-backed is unchanged.
 *  Final fix wave (part 3, re-review N1): a prefix the instance's mappings send to two different
 *  containers fails that instance with normalizeMappings' text, listed first, whatever its torrents
 *  say (also with no completed torrent, and beside "could not list torrents"). */
export async function verifyQbitMappings(deps: { pathMap: PathMap; instances: QbitSampleSource[]; sampleSize?: number }): Promise<QbitVerifyReport[]>
export interface QbitMappingProposal { container: string; qbitInstance: string; qbit: string; support: number }
/** Task 4. Proposes {qbit, qbitInstance} for existing mapping containers. Async; yields to the
 *  event loop between torrents. */
export async function autoDetectQbitMappings(deps: { mappings: PathMapping[]; instances: QbitSampleSource[]; sampleSize?: number }): Promise<QbitMappingProposal[]>
```

### C7. Verification gate — `src/scan/verification.ts`

```ts
export interface VerificationRecord {
  at: string
  mappingsHash: string
  jellyfin: { sampled: number; resolved: number; failures: Array<{ jellyfinPath: string; reason: string }> }
  qbit: QbitVerifyReport[]
}
export const VERIFICATION_KV_KEY = 'pathmap.lastVerification'
/** Reads the legacy shape {sampled,resolved,failures,at} as jellyfin-only with mappingsHash '' (stale). */
export function readVerification(db: Db): VerificationRecord | null
export function writeVerification(db: Db, record: VerificationRecord): void
/** Null when scans/plans may proceed, else the operator-facing reason. Blocks on: no record;
 *  mappingsHash !== current.mappingsHash; jellyfin.sampled <= 0; any jellyfin failure or
 *  resolved < sampled; any id in current.instanceIds with no report; any report with failures or
 *  resolved < sampled. A report with sampled 0 and no failures passes (that instance has no
 *  completed torrents — or, since the final fix wave (part 2), none under a mapped folder and no
 *  mapping of its own). A report's optional `ignored` never blocks; readVerification keeps it. */
export function verificationBlocker(db: Db, current: { mappingsHash: string; instanceIds: string[] }): string | null
```

### C8. qBittorrent — `src/connectors/qbittorrent.ts`

```ts
export interface Torrent {
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
export interface QbitClientOptions {
  instanceId: string
  url: string
  user: string | null
  pass: string | null
  concurrency: number
  minDelayMs: number
  privateTrackerHosts: string[]
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  now?: () => number            // injectable clock for login backoff
}
export interface QbitClient {
  readonly instanceId: string
  torrents(): Promise<Torrent[]>
  files(hash: string): Promise<TorrentFile[]>
  trackers(hash: string): Promise<string[]>
  deleteWithData(hashes: string[]): Promise<void>
  awaitGone(hashes: string[], opts?: { timeoutMs?: number; pollMs?: number }): Promise<boolean>
  ping(): Promise<{ version: string }>
}
export type QbitClients = ReadonlyMap<string, QbitClient>
export function createQbitClients(
  instances: QbitInstanceConfig[],
  common: Omit<QbitClientOptions, 'instanceId' | 'url' | 'user' | 'pass'>,
): QbitClients
// Login backoff windows (Task 2): failure 5 min, ban 60 min.
export const QBIT_LOGIN_BACKOFF_MS = 300_000
export const QBIT_BAN_BACKOFF_MS = 3_600_000
```

### C9. Jellyfin — `src/connectors/jellyfin.ts`

```ts
/** `MediaBrowser Client="Jellymaid", Device="Jellymaid", DeviceId="<deviceId>", Version="<pkg version>"`
 *  plus `, Token="<token>"` when a token is given. deviceId defaults to "jellymaid-server". */
export function jellyfinAuthHeader(opts: { token?: string | null; deviceId?: string }): string
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
  getItem(id: string): Promise<JellyfinItem | null>
  mergeVersions(ids: string[]): Promise<void>
  splitVersions(id: string): Promise<void>
  /** POST /Library/Media/Updated {Updates:[{Path, UpdateType:'Deleted'}]}, chunks of 200; [] -> no request. */
  notifyPathsDeleted(jellyfinPaths: string[]): Promise<void>
  /** GET /ScheduledTasks: the task with Key 'RefreshLibrary' is Running or Cancelling. */
  libraryScanRunning(): Promise<boolean>
  ping(): Promise<{ version: string }>
}
```

`deleteItem` and `refreshLibrary` stay on the interface, marked `@deprecated`, until Task 11
deletes them once nothing calls them.

### C10. Scan deps — `src/scan/phases/types.ts`, `src/scan/runner.ts`

```ts
export interface ScanDeps {
  config: FileConfig
  pathMap: PathMap
  jellyfin: JellyfinClient | null
  qbittorrents: QbitClients          // REPLACES qbittorrent
  radarr: ArrClient | null
  sonarr: ArrClient | null
  hasher: ReturnType<typeof createHasher> | null
}
// createScanRunner(opts) gains: activity: ActivityLock; configStore: ConfigStore
// ScanRunner gains: shutdown(): Promise<void>   // cancel the running scan, await worker exit
// start() refuses with { error: 'busy', reason } when activity.tryAcquire('scan', …) fails, and the
// verification gate uses verificationBlocker(db, { mappingsHash: configStore.mappingsHash(), instanceIds: configStore.instanceIds() }).
```

### C11. Plan pipeline — `src/plan/*`

```ts
export interface TorrentFileEntry { relPath: string; containerPath: string | null; sizeBytes: number }
/** REPLACES { count, paths }. entries.length === count. Complete = count > 0 and every containerPath non-null. */
export interface TorrentFileSet { count: number; entries: TorrentFileEntry[] }
export interface TorrentMatch {
  instanceId: string
  hash: string; name: string; category: string | null; tags: string[]; state: string
  ratio: number; seedingTimeSeconds: number; isPrivate: boolean; privacySource: PrivacySource
  trackerHost: string | null; sizeBytes: number
  matchedBy: 'inode' | 'file' | 'path'
  files: TorrentFileSet | null
  /** Companion files in `files` (C2); null when files is null. */
  companionCount: number | null
}
// Resolution gains: torrentSource: TorrentSource
// sourcesUnavailable labels: 'qbittorrent' (no instance could be determined) and 'qbittorrent:<id>' (that instance failed or has no client).
export interface TorrentListCache {
  get(client: Pick<QbitClient, 'instanceId' | 'torrents'>): Promise<Torrent[]>
  invalidate(instanceId: string): void
}
export function createTorrentListCache(opts: { maxAgeMs: number; now?: () => number }): TorrentListCache
export interface ResolveDeps {
  db: Db
  pathMap: PathMap
  qbittorrents: ReadonlyMap<string, Pick<QbitClient, 'instanceId' | 'torrents'> & Partial<Pick<QbitClient, 'files'>>>
  radarr: Pick<ArrClient, 'inventory'> | null
  sonarr: Pick<ArrClient, 'inventory'> | null
  torrentLists?: TorrentListCache
}
export interface PlannerDeps extends Omit<ResolveDeps, 'pathMap'> { configStore: ConfigStore; activity: ActivityLock }
export interface ExecutorDeps {
  db: Db
  configStore: ConfigStore           // one file()/pathMap() snapshot per run
  qbittorrents: ReadonlyMap<string, Pick<QbitClient, 'instanceId' | 'torrents' | 'files' | 'deleteWithData' | 'awaitGone'>>
  radarr: Pick<ArrClient, 'inventory' | 'unmonitorByPath'> | null
  sonarr: Pick<ArrClient, 'inventory' | 'unmonitorByPath'> | null
  jellyfin: Pick<JellyfinClient, 'notifyPathsDeleted' | 'mergeVersions' | 'splitVersions'>
  activity: ActivityLock
}
// createExecutor(deps) returns { execute(planId, actor): Promise<ExecutionSummary>; start(planId, actor): { ok: true } | { ok: false; error: string };
//                                requestStop(): void; idle(): Promise<void> }
// start() = fire-and-forget execute with errors recorded in plans.error; used by POST /execute.
```

Executor order per delete action (Task 7):
1. Resolve and guard live, as today.
2. *arr unmonitor, as today.
3. Group hashes by instanceId, then per instance `deleteWithData`, `awaitGone`, and invalidate that
   instance's cache.
4. Wait ≤ 30 s (poll 500 ms) for the target to disappear. If it is still there, run the
   identity-checked unlink; `ENOENT` counts as `removed-by-qbittorrent`.
5. Sweep empty parents.
6. Insert into `deleted_paths`.
7. Remember the path's Jellyfin spelling (`fromContainer`) for the end-of-plan
   `notifyPathsDeleted`.

After the last action, call `notifyPathsDeleted(collected)` **once**, only with paths whose files
are confirmed gone, and audit the outcome. Merge/split stay as today.

### C12. HTTP contract (server tasks produce, Task 9 consumes)

All JSON. Errors are `{ error: string, reason?: string }`. Auth and guard behavior are unchanged
unless noted.

```ts
// GET /api/qbit/instances                                   (Task 4)
{ instances: Array<{ id: string; url: string; reachable: boolean; version: string | null; error: string | null; torrentCount: number | null }> }

// GET /api/pathmap                                          (Task 4)
{ mappings: PathMapping[]; problems: string[]; lastVerification: (VerificationRecord & { current: boolean }) | null }
// PUT /api/pathmap  body { mappings: PathMapping[] }        -> same shape as GET
// POST /api/pathmap/verify                                  -> VerificationRecord & { current: true }
// POST /api/pathmap/detect body { mountRoots: string[] }    -> { proposals: PathMapping[] }   (qbit/qbitInstance filled where detected)

// GET /api/duplicates                                       (Task 8)
interface DuplicatesResponse { evaluated: boolean; reason: string | null; scanId: number | null; scanFinishedAt: string | null; groups: DupeGroupView[] }
interface DupeGroupView {
  id: string; tier: 'exact' | 'strong' | 'possible'; matchedBy: string[]
  keeperItemId: string | null; keeperPolicy: KeeperPolicy
  title: string; year: number | null; kind: 'movie' | 'episode'
  seriesName: string | null; seasonNo: number | null; episodeNo: number | null
  editionsDiffer: boolean; crossInstance: boolean
  multiEpisode: boolean              // added by the final-review fix wave (Task 6 minor 4): a member's file holds >1 episode;
                                     // the bulk queue skips the group unless included, like editionsDiffer
  reclaimableBytes: number           // sum of non-keeper members' sizeBytes; 0 when keeperItemId is null
  scores: Record<string, { total: number; breakdown: Record<string, number> }>
  members: DupeMemberView[]          // deleted_paths members already removed; groups left with < 2 members are omitted
}
interface DupeMemberView {
  id: string; name: string; containerPath: string | null; sizeBytes: number | null
  width: number | null; height: number | null; bitrate: number | null; videoCodec: string | null
  audioChannels: number | null; container: string | null; libraryName: string | null
  videoRange: string | null; hasSubtitles: boolean; edition: string | null
  instanceId: string | null          // torrentSourceFor(containerPath).instanceId, else null
  torrent: TorrentFactsView | null   // first torrent owning containerPath per the index
  torrentCount: number               // torrents owning this file (>1 = cross-seed)
}
interface TorrentFactsView {
  instanceId: string; hash: string; name: string; state: string; ratio: number; seedingDays: number
  isPrivate: boolean; trackerHost: string | null; sizeBytes: number; fileCount: number; mediaFileCount: number
  hnrMet: boolean                    // !isPrivate || (ratio >= minRatio && seedingDays >= minSeedTimeDays), current thresholds
}
// POST /api/duplicates/:groupId/dismiss  body { reason?: string } -> 204    (Task 8; also flips the dupe.group finding)
// POST /api/duplicates/:groupId/reopen                              -> 204

// GET /api/config/settings                                  (Task 8, new file src/api/settings.ts)
interface SettingsView {
  guards: { minRatio: number; minSeedTimeDays: number; protectedCategories: string[]; protectedTags: string[]; privateTrackerHosts: string[] }
  keeper: { policy: KeeperPolicy }
  trash: { maxBytes: number; retentionDays: number }
}
// PUT /api/config/settings  body: DeepPartial<Pick<SettingsView,'guards'|'keeper'>> -> SettingsView (live, no restart)
// GET /api/config/thresholds stays (compat), moved into settings.ts.

// /healthz                                                  (Task 8)
// connectors gains qbitInstances: Record<string, { status: 'ok' | 'unreachable' | 'auth' | 'not-configured'; version?: string; error?: string }>
// connectors.qbittorrent stays = the worst instance status (compat). Overall status 'degraded' when any configured connector is not ok.

// Plans                                                     (Task 7)
// POST /api/plans body { actions: RequestedAction[] }   -> PlanView
//   412 { error: 'verification', reason }  when verificationBlocker(...) is non-null
//   409 { error: 'busy', reason }          when a scan or plan holds the ActivityLock
//   Overrides for guards that no longer block are dropped and listed in droppedOverrides (never a 400).
// POST /api/plans/:id/execute -> 202 { planId, status: 'running' } | 409 busy | 409 not-approved
// GET  /api/plans/:id -> PlanView
interface PlanView {
  id: string; status: 'draft' | 'approved' | 'running' | 'completed' | 'failed'
  createdBy: string; createdAt: string; approvedBy: string | null; error: string | null
  actions: PlanActionView[]
  dryRun: PlanDryRun
  progress: { total: number; finished: number }
  droppedOverrides: Array<{ seq: number; guard: GuardId }>
}
interface PlanDryRun {
  deleteCount: number; bytesFreed: number; torrentsRemoved: number; blockedCount: number
  directoriesSwept?: number
  companionFiles: number
  byInstance: Record<string, { torrents: number; bytes: number }>
}
// PlanActionView.payload.resolution (when present) serializes Resolution with C11's TorrentMatch/TorrentFileSet.

// GET /api/explorer?path=…&offset=0&limit=500               (Task 8)
// -> today's response plus { total: number; offset: number; limit: number }; limit max 1000.
```

---

## Phase A — foundation (sequential, on branch `realstack`)

### Task 1: Land the contract with every call site compiling

**Files:**
- Modify: `src/core/types.ts`, `src/config/schema.ts`, `src/config/load.ts`, `src/index/db.ts`,
  `src/fs/pathmap.ts` (C6 members except verify/detect), `src/scan/verification.ts`,
  `src/connectors/qbittorrent.ts` (types, options, registry, `instanceId`, lowercase hash,
  `rootPath`, `addedOn`, `ping` version; login logic untouched), `src/connectors/jellyfin.ts` (add
  `jellyfinAuthHeader`, `notifyPathsDeleted`, `libraryScanRunning`, `loginRisk`,
  `ping`→version, using the existing header style; Task 3 fixes headers), `src/scan/phases/types.ts`,
  `src/scan/phases/qbittorrent.ts` (loop instances, write `instance_id`/`root_path`/`added_on`,
  sweep per instance), `src/scan/worker.ts`, `src/scan/runner.ts` (new opts accepted; gate call
  updated), `src/plan/resolve.ts`, `src/plan/guards.ts` (`guard.untracked` returns pass for now),
  `src/plan/planner.ts`, `src/plan/executor.ts` (deps per C11; group deletes by instance; keep
  today's Jellyfin step), `src/api/*.ts` call sites, `src/index.ts`, `src/server.ts`, the
  `client/src/api.ts` `PathMapping` type plus a `qbitInstance` field in the Settings row editor
  (text input only).
- Create: `src/core/companions.ts`, `src/core/activity.ts`, `src/config/store.ts`,
  `src/index/migrations/005_multi_instance.sql`.
- Test: create `tests/core/companions.test.ts`, `tests/core/activity.test.ts`,
  `tests/config/store.test.ts`, `tests/config/qbit-instances.test.ts`. Extend
  `tests/fs/pathmap.test.ts`, `tests/scan/verification.test.ts` and `tests/index/db.test.ts`.
  Update every existing test that constructs the changed types.

**Interfaces:** Produces C1–C10 exactly. From C11, Task 1 lands only:
- `TorrentMatch.instanceId`, `Resolution.torrentSource`, `ResolveDeps.qbittorrents`;
- the `PlannerDeps`/`ExecutorDeps` shapes;
- `createExecutor`'s `start`/`requestStop`/`idle`, minimal: `start` fires `execute` and records
  errors in `plans.error`; `requestStop` sets a flag checked between actions; `idle` resolves when
  no run is active.

`TorrentFileSet.entries`, `companionCount`, `sizeBytes`, the torrent-list cache and every behavior
change belong to Task 7. Consumes nothing new.

- [ ] **Step 1: Write the failing tests**
  - `parseQbitInstances`:
    - `"box-a=http://198.51.100.10:8080, box-b=http://u%40x:p%3Aw@198.51.100.11:8080"` →
      two instances; box-b has `user 'u@x'`, `pass 'p:w'`, and a URL with the credentials stripped.
    - `QBIT_BOX_A_USER`/`QBIT_BOX_A_PASS` override.
    - `QBIT_URL` alone → `[{id:'default', user:null, pass:null}]`.
    - Duplicate id → problem. `Box_A` → problem. User without pass → problem. Neither var set → problem.
  - `normalizeMappings`:
    - One instance plus legacy `{qbit:'/movies', qbitInstance:null}` → filled.
    - Two instances with the same legacy mapping → unfilled, plus one problem.
    - `qbitInstance:'nope'` → problem.
  - `torrentSourceFor` covers all four outcomes, deepest root first.
  - `qbitToContainer('box-b','/movies/X')` ignores box-a's `/movies` mapping.
  - `mappingsHash` is stable under reordering.
  - `verificationBlocker`: one test per blocking clause in C7, plus the passing case and
    `sampled 0, no failures` passing.
  - Migration 005 upgrades a v4 database. The same hash on two `instance_id`s inserts twice;
    `deleted_paths` and `plans.error` exist.
  - `isCompanionFile`: `Movie.nfo` true, `Sample/sample.mkv` true, `Movie.2160p.mkv` false,
    `Subs/Eng.srt` true.
  - `createActivityLock`: a second acquire is refused with `heldBy`; release by a non-holder is a no-op.
  - `createConfigStore`: an edit to config.json is visible from `file()` without restart, and
    `pathMap()` is rebuilt; an invalid edit throws `ConfigError`.
  - `saveConfig` patching `{guards:{minRatio:2}}` keeps `minSeedTimeDays`.
- [ ] **Step 2: Run them; expect failures** (`npx vitest run tests/core tests/config tests/fs/pathmap.test.ts tests/scan/verification.test.ts tests/index`).
- [ ] **Step 3: Implement C1–C10 and the C11 type changes.** This is a mechanical update of every
  call site:
  - Resolve queries **every** configured instance and tags each match with its `instanceId` (Task
    7 narrows this to `torrentSourceFor`).
  - The executor groups hashes by `instanceId`.
  - `index.ts` and `worker.ts` build `createQbitClients(env.qbittorrents, …)`.
  - `index.ts` builds the `ConfigStore` and `ActivityLock` and passes them where C10/C11 say.
- [ ] **Step 4: Full verification:** `npm run typecheck`, then the full server and client suites
  on Node 20 (all green, with existing tests updated rather than deleted), then `npm run build`.
- [ ] **Step 5: Commit** `wip(foundation): multi-instance contract, config store, activity lock, migration 005` on `realstack`.

---

## Phase B — parallel lanes (each in its own worktree, branched from Task 1's commit)

Before coding, each lane confirms the **premises** listed in its task: open the named file and check
that the claim is true. A premise that turns out false is reported, never coded around silently.

### Task 2: qBittorrent connector for 5.1 and 5.2 (lane `qbit`)

**Files:** `src/connectors/qbittorrent.ts`, `src/connectors/http.ts` (only if a hook is needed);
tests `tests/connectors/qbittorrent.test.ts`, `tests/connectors/http.test.ts`.
**Premises:**
- `HttpClient.request` calls `onResponse` before its 401/403 check (`http.ts` ~line 120).
- `login()` currently requires `Ok` and an `SID` cookie.

**Interfaces:** Produces C8 behavior. Consumes `QbitInstanceConfig`.

- [ ] Failing tests, each against a fake fetch that returns the harness-recorded responses:
  - `logs in on 5.2.2 (204, empty body, QBT_SID_18080 cookie) and replays that cookie by name`
  - `logs in on 5.1.2 (200 Ok., SID cookie)`
  - `treats 5.1.2 "200 Fails." as an auth failure`
  - `treats 5.2.2 401 as an auth failure`
  - `detects a ban (403 + "banned") and makes no login attempt for QBIT_BAN_BACKOFF_MS`
  - `after a failed login, makes no further login attempt for QBIT_BAN_BACKOFF_MS`, using the
    injected `now`. Use QBIT_LOGIN_BACKOFF_MS for a plain failure; assert the fetch call count.
  - `without credentials never calls auth/login and reports 403 as auth: "requires credentials"`
  - `updates the session cookie when any response sets a new one`
  - `normalizes hash to lowercase and carries instanceId, rootPath, addedOn`
  - `ping returns the app/version text`
- [ ] Implement:
  - Classify login responses per the spec.
  - Use a cookie jar for any `Set-Cookie` whose name contains `SID`.
  - Keep a backoff state of `{ until, error }`.
  - With no credentials, the login path is never taken.
- [ ] Suite green. Commit `wip(qbit): …`.

### Task 3: Jellyfin connector and login (lane `jellyfin`)

**Files:** `src/connectors/jellyfin.ts`, `src/api/auth.ts`, `src/auth/lockout.ts`; tests
`tests/connectors/jellyfin.test.ts`, `tests/api/auth.test.ts`, `tests/auth/lockout.test.ts`.
**Premises:**
- `auth.ts` calls `authenticateByName` and reads `isAdministrator`.
- The lockout keys on the raw username.

**Interfaces:** Produces C9 behavior. Consumes nothing new.

- [ ] Failing tests:
  - `every request carries Authorization: MediaBrowser … Token=<key> and no X-Emby-Token`
  - `authenticateByName sends the MediaBrowser header without Token, reads Policy.IsAdministrator
    from the response, revokes via /Sessions/Logout with Token=<user token>, and uses a different
    DeviceId per call`
  - `loginRisk refuses at InvalidLoginAttemptCount = limit-1, treats 0 as 3 and -1 as unlimited,
    matches the username case-insensitively, and allows unknown users`
  - `notifyPathsDeleted posts Deleted updates in chunks of 200 and sends nothing for []`
  - `libraryScanRunning reads Key RefreshLibrary`
  - `items requests SortBy=DateCreated,SortName ascending`
  - Login route:
    - Refused risk → the same 401 body and timing class as a wrong password, and Jellyfin's
      AuthenticateByName is not called.
    - Lockout keys are case-insensitive (`Admin` and `admin` share one bucket).
- [ ] Implement. `Version` in the header is the package version. Remove the
  `X-Emby-Token: ''` hack.
- [ ] Suite green. Commit.

### Task 4: Path mapping — qBittorrent verify, auto-detect, routes (lane `pathmap`)

**Files:** `src/fs/pathmap.ts` (`verifyQbitMappings`, `autoDetectQbitMappings`, async non-blocking
walk replacing `walkDirs`), `src/api/pathmap.ts` (C12 pathmap routes, `GET /api/qbit/instances`);
tests `tests/fs/pathmap*.test.ts`, `tests/api/pathmap.test.ts`.
**Premises:**
- Task 1 put `readVerification`/`writeVerification` in `src/scan/verification.ts`.
- `createQbitClients` returns a `ReadonlyMap`.

**Interfaces:** Consumes C6, C7, C8 and `ConfigStore`. `registerPathMapRoutes(app, { configStore,
db, jellyfin, qbittorrents, guard })` is called by Task 11.

- [ ] Failing tests, on real temporary directories:
  - `verify resolves box-a and box-b torrents through their own prefixes`
  - `verify fails a single-file torrent whose on-disk size differs`
  - `verify reports an instance whose content paths map nowhere`
  - `detect proposes {qbit:'/movies', qbitInstance:'box-b'} for the container holding box-b's files, and nothing when two instances both fit`
  - `detect does not block the event loop` (a timer scheduled before detect fires during it)
  - Routes:
    - Verify writes a record with the current `mappingsHash`.
    - PUT returns `problems` from `normalizeMappings`.
    - `GET /api/qbit/instances` strips credentials from URLs and reports per-instance reachability.
- [ ] Implement per C6/C12.
- [ ] Suite green. Commit.

### Task 5: Scan pipeline (lane `scan`)

**Files:** `src/scan/phases/{qbittorrent,jellyfin,filesystem,rules}.ts`,
`src/scan/{orchestrator,runner,worker,scheduler}.ts`; tests `tests/scan/**`.
**Premises:**
- Task 1's qbittorrent phase already loops instances and sweeps per instance.
- The jellyfin phase sweeps when `fetched >= total`.

**Interfaces:** Consumes C8, C10, `ActivityLock`, `ConfigStore`. Produces `ScanRunner.shutdown()`.

- [ ] Failing tests:
  - `qbittorrent phase synthesizes single-file torrents' file lists without calling files()`
  - `qbittorrent phase reports progress across instances`
  - `one failing instance leaves its rows untouched, sweeps the other, and returns skipped with the failing id in reason`
  - `jellyfin phase does not sweep when TotalRecordCount changes between first and last page or unique ids < total`
  - `jellyfin phase clears deleted_paths rows Jellyfin no longer lists`
  - `filesystem phase does not sweep a root that walks empty while the index holds rows for it`
  - `rules phase reports per-rule progress`
  - `runner refuses to start while the ActivityLock is held by a plan and releases it when the worker exits (also on crash)`
  - `runner gate uses configStore.mappingsHash() and instanceIds()`
  - `shutdown cancels the running scan and resolves after the worker exits`
- [ ] Implement.
- [ ] Suite green. Commit.

### Task 6: Duplicate rules (lane `rules`)

**Files:** `src/rules/**` (including `normalize.ts`: export
`editionOf(nameOrPath: string): string | null`); tests `tests/rules/**`.
**Premises:**
- `buildDupeGroups` unions every link single-linkage.
- `persist()` rewrites `dupe_groups` as open.
- The keeper reads hardcoded weights.

**Interfaces:**
- Produces `editionOf` (consumed by Task 8).
- `dupe_groups.status` mirrors the `dupe.group` finding status. `persist()` preserves `dismissed`
  for an unchanged group id.
- `pickKeeper` honours `config.keeper.policy` (`none` → `keeperItemId` null).
- The dupe finding's evidence gains `editions: Record<itemId, string | null>` and `editionsDiffer: boolean`
  (and, from the final-review fix wave, `multiEpisode: boolean`).

- [ ] Failing tests:
  - `provider-id ignores tmdbcollection and *collection* keys`
  - `provider-id links only items of the same type`
  - `possible links never merge two strong groups`
  - `possible pair emitted only between ungrouped items`
  - `series-episode matches the same show across two Series items via series tvdb id`
  - `multi-episode file links strong, not exact`
  - `editionOf recognises Extended, Director's Cut, Unrated, Theatrical, IMAX, Final Cut, Ultimate, Special Edition, Remastered, Criterion`
  - `group with differing editions sets editionsDiffer`
  - `keeper policy smallest and none`
  - `dismissed group stays dismissed across persist() when membership is unchanged`
  - `bad-naming disabled by default emits no findings`
  - `orphan-media ignores BDMV, VIDEO_TS and extras folders`
- [ ] Implement.
- [ ] Suite green. Commit.

### Task 7: Plan pipeline (lane `plan`)

**Files:** `src/plan/{resolve,guards,planner,executor,sweep,trash,audit}.ts`, `src/api/plans.ts`
(drop the thresholds route; Task 8 re-adds it); tests `tests/plan/**`, `tests/api/plans.test.ts`.
**Premises:**
- Task 1's resolver queries every instance.
- The executor already groups by instance.
- `guard.untracked` currently always passes.
- `TorrentFileSet` still has `paths` at this point; this task converts it to `entries`.

**Interfaces:** Produces C11 and the C12 plan routes. Consumes C1–C9 and `ConfigStore`/`ActivityLock`.

- [ ] Failing tests:
  - `resolver asks only the instance from torrentSourceFor`
  - `resolver marks qbittorrent:<id> unavailable when that instance throws or has no client`
  - `resolver marks qbittorrent unavailable for a root with an unknown instance`
  - `torrent list cache serves one snapshot per plan build`
  - `torrent-scope ignores companion files`
  - `torrent-scope still blocks a partially queued pack`
  - `torrent-scope blocks an unreadable file list`
  - `guard.untracked blocks (overridable) a file in a torrent-backed root that no torrent owns, and passes in a root with source none`
  - `private-ratio keeps AND semantics with thresholds read from configStore at build time`
  - `executor routes deletes to the owning instance only` (Review Focus 1)
  - `executor waits for qBittorrent's asynchronous delete and treats ENOENT as removed-by-qbittorrent`
  - `notifies Jellyfin only for paths that are gone, once per plan` (Review Focus 3)
  - `executor never calls deleteItem or refreshLibrary`
  - `deleted paths are recorded in deleted_paths`
  - `bytes freed credit each removed torrent once`
  - `execute route returns 202 and runs in the background; GET shows progress; a crash sets plans.error and status failed`
  - `plan build refuses 412 on a stale or failing verification and 409 while a scan holds the lock`
  - `stale overrides are dropped into droppedOverrides instead of a 400`
  - `dry run reports companionFiles and byInstance`
  - `requestStop finishes the current action, leaves the rest pending, and resumes cleanly`
- [ ] Implement per C11's executor order.
- [ ] Suite green. Commit.

### Task 8: Read-model and settings APIs (lane `api`)

**Files:** `src/api/{findings,health,explorer,scan}.ts`, `src/api/settings.ts` (new); tests
`tests/api/{findings,health,explorer,settings,scan}.test.ts`.
**Premises:**
- `/api/duplicates` reads only `jellyfin_items`.
- The health connector list is fixed at four names.
- Explorer caps a directory at 500 entries.

**Interfaces:**
- Produces the C12 duplicates, settings and health routes.
- Explorer gains `offset`/`limit` query parameters and returns `total`.
- Consumes `editionOf` (Task 6; until it merges, a local stub that returns `null`, replaced in
  Task 11), `isCompanionFile`, `ConfigStore`, `QbitClients`.

- [ ] Failing tests:
  - `duplicates returns per-member instance and torrent facts with hnrMet under current thresholds`
  - `duplicates omits deleted_paths members and groups left with fewer than two members`
  - `duplicates hides dismissed groups; dismiss and reopen flip both dupe_groups and the finding`
  - `duplicates reports evaluated false when the dupe rule did not run in the latest scan`
  - `reclaimableBytes sums non-keepers`
  - `crossInstance is true when members span instances`
  - `settings PUT changes minRatio live and keeps siblings; rejects negative values`
  - `healthz lists every qBittorrent instance with version; connectors.qbittorrent is the worst`
  - `explorer pages a 3,000-entry directory and reports total`
- [ ] Implement.
- [ ] Suite green. Commit.

### Task 9: Client (lane `client`)

**Files:** `client/src/**` and client tests.
**Premises:**
- `App.tsx` holds the queue in memory.
- `Duplicates.tsx` renders every group at once.
- Settings' mapping row has a free-text qbit field.

**Interfaces:** Consumes C12 only, with a mocked `api.ts`. Must not import server code.

- [ ] Failing tests (Testing Library):
  - `duplicates paginates 50 groups and sorts by reclaimable bytes by default`
  - `filters by box, tier, cross-box and H&R-blocked`
  - `bulk queue skips possible and editionsDiffer groups unless included`
  - `member row shows box, torrent name, ratio, seed days, private and an H&R badge`
  - `dismiss calls the API and removes the group`
  - `merge asks for confirmation`
  - `queue survives a reload via localStorage and tolerates storage that throws`
  - Plan screen:
    - `plan screen override-all for a guard sets every blocked row and rebuild keeps them`
    - `execute polls until completed and shows progress`
    - `shows droppedOverrides`
    - `shows the Jellyfin one-minute note`
  - Settings:
    - `settings mapping row offers the instance picker from /api/qbit/instances`
    - `verify shows Jellyfin and per-instance results`
    - `thresholds and keeper policy save via PUT /api/config/settings`
  - `dashboard shows each qBittorrent instance`
  - `explorer pages with offset/limit and shows the total`
- [ ] Implement.
- [ ] Client suite and client typecheck green. `npm --prefix client run build` succeeds.
- [ ] Commit.

### Task 10: Ops and docs (lane `ops`)

**Files:** `Dockerfile`, `docker-compose.yml`, `.env.example`, `.github/workflows/*.yml`,
`README.md`, `docs/superpowers/carry-forward.md`, `package.json`, `package-lock.json`,
`client/package.json`, `client/package-lock.json`.
**Premises:**
- The compose file defaults to PUID 1000.
- CI never starts the image.
- `npm audit` reports 4 high advisories in production dependencies.

- [ ] Compose:
  - `init: true`.
  - `PUID`/`PGID` default to 99/100.
  - `/path/to/appdata/jellymaid:/data`.
  - A two-instance `QBIT_INSTANCES` example using `box-a`/`box-b` and 198.51.100.x.
  - Radarr/Sonarr moved to a commented optional block.
  - A comment on Unraid same-host auth: a bridged container reaches a same-box qBittorrent from
    the Docker bridge address, so the LAN bypass does not apply. Set that instance's credentials.
- [ ] `.env.example` gets the per-instance credential variables.
- [ ] Publish workflow: after the image build, `docker run -d` with dummy env against no services,
  `curl /healthz` until it answers, and fail the job otherwise.
- [ ] Dependency advisories: apply only non-breaking upgrades, keeping the suite green. Document
  any that need a breaking upgrade (fastify's numeric `trustProxy`, zod 4) in carry-forward, with
  the reason.
- [ ] README:
  - Multi-instance setup, path mapping with instances, the verify gate's qBittorrent half.
  - Settings now live.
  - The H&R rule (AND).
  - "Jellyfin drops deleted items within about a minute".
  - A "Verified against" section: Jellyfin 12.1.0, qBittorrent 5.2.2 and 5.1.2 on the harness, with
    the date.
  - The first-run checklist updated.
  - Every stale claim removed (boot-time-only config, single qBittorrent, Jellyfin item delete).
- [ ] Carry-forward gets the items this plan closes, struck through, and the ones it leaves open.
- [ ] Commit.

---

## Phase C — integration and proof (sequential)

### Task 11: Merge lanes, wire, delete the deprecated paths

- [ ] Merge lane branches into `realstack` in this order: foundation is already there, then `qbit`,
  `jellyfin`, `pathmap`, `rules`, `scan`, `plan`, `api`, `client`, `ops`. File sets are disjoint,
  so conflicts mean a lane broke ownership: stop and fix.
- [ ] `src/index.ts` / `src/server.ts`:
  - Register the settings routes.
  - Pass `configStore`, `activity` and `qbittorrents` everywhere.
  - `process.on('SIGTERM'|'SIGINT')`: `app.close()`, `scanRunner.shutdown()`,
    `executor.requestStop()`, `await executor.idle()`, `db.close()`, exit 0.
  - Test: `shutdown closes the db after the executor is idle`.
- [ ] Delete `deleteItem`/`refreshLibrary` from the Jellyfin connector. Replace Task 8's `editionOf`
  stub with Task 6's.
- [ ] Add `tests/safety/no-destructive-jellyfin.test.ts`: grep `src/` for `/Items/` with DELETE and
  for `Library/Refresh`; expect none.
- [ ] Full verification:
  - Typecheck (server and client).
  - Server and client suites on Node 20, then on Node 22 (`nvm install 22` if missing).
  - `npm run build`.
- [ ] Delete every `LANE_PROGRESS.md`. Commit `wip(integration): …`.

### Task 12: Real-software E2E on the harness

Harness: `~/jellymaid-e2e` (outside the repo). It runs real Jellyfin 12.1.0 on :18096, qBittorrent
5.2.2 (A) on :18080 and 5.1.2 (B) on :18081. `./reset.sh` restores everything; `state/env.sh` and
`state/creds.env` hold URLs and credentials; `state/manifest.json` lists torrents and dupe groups.

- [ ] Run the built server against the harness. Env: `QBIT_INSTANCES=box-a=<A>,box-b=<B>`,
  `JELLYFIN_*`, `DATA_DIR` under the scratchpad. Path mappings are identity mappings, one per box root.
- [ ] Drive the real UI with Playwright (screenshots saved, and looked at):
  1. Log in as the harness admin. Confirm the viewer account is refused.
  2. Verify: Jellyfin and both instances pass.
  3. Scan.
  4. Duplicates shows these groups, each member with the right box and torrent facts:
     - NOTLD 1080p vs 2160p (box A);
     - Nosferatu box A vs box B (cross-box);
     - Beverly Hillbillies S01E02, pack (A) vs single (B).
  5. The General's cross-seed shows a torrent count of 2.
  6. Queue the NOTLD 1080p non-keeper and Nosferatu's box-B copy, then build the plan.
     The guards are as expected: private-ratio blocks unless overridden, because harness torrents
     are fresh. Override all, approve, execute.
- [ ] Assert on disk and via APIs:
  - Box B's Nosferatu torrent is gone with its folder; box A's Nosferatu is untouched.
  - The NOTLD 1080p torrent is gone, with its `.nfo`/sample companions; the 2160p copy is untouched.
  - Both items are gone from Jellyfin within 120 s.
  - No other file changed (compare against the manifest).
- [ ] Negative runs, each preceded by `./reset.sh`:
  - Queueing one episode of the pack → torrent-scope blocks.
  - A mapping with a wrong qbit prefix → Verify fails and plan build answers 412.
  - qBittorrent A stopped → the delete is blocked by `guard.protected`.
  - qBittorrent B with credentials required and wrong ones configured → exactly one login attempt
    per backoff window; `/healthz` reports `auth` for box-b.
- [ ] Fix every failure in the owning file, with a regression test, and re-run until clean.
  Commit `wip(e2e): …`.

### Task 13: Real stack (read-only), final review, ship

- [ ] With the owner's Jellyfin API key (from `~/.config/jellymaid/jellyfin_api_key`, never
  committed), run the server in the sandbox against the real Jellyfin and both qBittorrent
  instances. The real media is not mounted here, so the filesystem phase degrades. Confirm:
  - The Jellyfin phase completes.
  - Both qBittorrent phases complete with the real torrent counts.
  - Duplicates are evaluated, with group counts in the expected range (hundreds; ~889 by the
    audit's simulation) and plausible spot-checked groups.
  - **No POST or DELETE** reaches the real services. Enforce this with a fetch wrapper that throws
    on anything but GET, plus qBittorrent `auth/login`.
- [ ] Whole-branch adversarial review (correctness, safety and security lenses). Fix the confirmed
  findings, each with a test.
- [ ] Final verification: typecheck, both suites on Node 20 and 22, build, harness E2E rerun.
  The host-detail grep is clean.
- [ ] Squash `realstack` onto `master` as **one** commit. Push to GitHub. Watch CI and Publish to
  green, and confirm the new image is anonymously pullable.
- [ ] Update memory. Give the owner the Unraid compose snippet and the first-run checklist (one
  disposable item first).
