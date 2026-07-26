# Jellymaid — Design Spec

**Date:** 2026-07-26
**Status:** Approved for planning
**Repo:** `Atvriders/jellymaid` (public, GitHub) · image `ghcr.io/atvriders/jellymaid` (public, multi-arch)

---

## 1. Overview

Jellymaid is a standalone Dockerized web app that audits a Jellyfin media library for problems —
duplicates, filesystem junk, metadata gaps, quality outliers — and then cleans them up under
explicit human approval, coordinating with qBittorrent and Radarr/Sonarr so a deletion doesn't
break a seeding torrent or trigger an immediate re-download.

It talks to Jellyfin over an API key, mounts the media paths read-write so it can see and act on
the filesystem directly, and never performs a destructive action that the operator has not
reviewed in a plan and approved.

### Goals

1. Find duplicates across a 100k+ item library with confidence tiers, and resolve them by either
   Jellyfin **Merge Versions** or deletion of non-keepers.
2. Find and remove filesystem rot: empty folders, orphan media, junk, stray sidecars, dead
   Jellyfin entries.
3. Report metadata integrity problems and quality/space outliers that inform keeper decisions.
4. Never break seeding. Never cause a silent re-download. Never delete something the operator
   didn't see on screen first.

### Non-goals (explicitly out of scope for v1)

- Renaming/reorganising files into a canonical layout (report-only via `meta.bad-naming`).
- Transcoding, re-encoding, or any media mutation.
- Deleting movies/series from Radarr/Sonarr, or blocklisting releases. **Unmonitor only.**
- Acting as a Jellyfin plugin. Jellymaid is a separate container.
- Multi-user roles. Any Jellyfin **admin** gets full access; non-admins get none.

---

## 2. Decisions log

Settled during brainstorming; these are constraints, not suggestions.

| # | Decision |
|---|---|
| D1 | **Standalone Docker app**, not a Jellyfin plugin. |
| D2 | Scan scope covers all four classes: duplicates, filesystem hygiene, metadata integrity, quality/space. |
| D3 | "Merge" means **Jellyfin `MergeVersions`** — a library-level grouping, no files touched, reversible via split. Deletion is a separate, explicit action. |
| D4 | Destructive flow is **queue → approve → qBittorrent → delete**. Empty folders use the same queue. |
| D5 | For torrent-backed files: **remove the torrent WITH data** (`deleteFiles=true`), then sweep leftovers. qBittorrent is the single authority for its own data. |
| D6 | All four guards enforced: private-tracker ratio/seed-time, cross-seed detection, hardlink awareness, protected categories/tags/active state. |
| D7 | **Read-write mounts + explicit path mapping** between Jellyfin paths, container paths, and qBittorrent content paths. |
| D8 | Duplicate matching is **layered and confidence-scored** (exact / strong / possible). |
| D9 | Scale target: **100k+ items, many TB.** Chunked, resumable, rate-limited; hashing is opt-in. |
| D10 | Stack: **Node 22 + TypeScript + Fastify + better-sqlite3 + React 19 + Vite**, one container. |
| D11 | Auth: **Jellyfin admin login** via `AuthenticateByName`; token revoked immediately; session cookie after. |
| D12 | Radarr/Sonarr integrated, **unmonitor only** — never delete, never blocklist. |
| D13 | **Scheduled scans, manual actions.** No auto-apply of any destructive rule in v1. |
| D14 | Architecture: **index-first** (SQLite snapshots + pure rules), with **live re-query of qBittorrent and \*arr** at plan-build and again per-action at execute. |
| D15 | **No quarantine for torrent-managed or large files.** A small trash folder covers non-torrent junk only (default: files < 1 GB, 30-day retention, both configurable). |

---

## 3. Architecture

One container. Two runtime pieces:

- **Fastify HTTP server** — JSON API plus the built React SPA as static assets.
- **Job runner on `worker_threads`** — scans and plan execution run off the request thread so a
  100k-item pass never blocks the UI.

### 3.1 Modules

Each module has one purpose, a typed interface, and is testable without the others.

| Module | Responsibility | Depends on |
|---|---|---|
| `connectors/jellyfin` | Paged item fetch, virtual folders, MergeVersions, split, item delete, library refresh, `AuthenticateByName` | HTTP |
| `connectors/qbittorrent` | Cookie login, torrent list/files/properties/trackers, delete-with-data | HTTP |
| `connectors/arr` | Radarr + Sonarr: lookup by path, **unmonitor** | HTTP |
| `fs/walker` | Chunked async directory walk; per entry captures size, mtime, `dev`, `inode`, `nlink` | `fs/pathmap` |
| `fs/pathmap` | Bidirectional translation: Jellyfin path ↔ container path ↔ qBittorrent content path | config |
| `fs/hasher` | Opt-in quick-hash (size + head 1 MB + tail 1 MB), cached by `(dev, inode, mtime, size)` | — |
| `index/db` | SQLite schema, migrations, typed query helpers (`better-sqlite3`) | — |
| `scan/orchestrator` | Job lifecycle, phase cursors, resume, progress, cancel, per-service rate limits | connectors, walker, db |
| `rules/*` | Pure `(db, config) => Finding[]`, one file per rule, registered by id | db (read-only) |
| `plan/planner` | Selected findings → ordered `Action[]`; evaluates guards against **live** qBittorrent/\*arr | connectors, db |
| `plan/executor` | Runs actions, re-verifies guards immediately before each, writes audit rows | connectors, fs, db |
| `auth/*` | Jellyfin-account login, session cookies, lockout | `connectors/jellyfin` |
| `api/*` | Fastify routes; thin — no business logic | everything above |
| `web/*` | React 19 SPA | API |

### 3.2 Data flow

```
scan job ──▶ snapshots (jellyfin_items, fs_entries, torrents, torrent_files, arr_records)
                    │
                    ▼  rule pass (pure functions over SQLite)
               findings ──▶ UI review ──▶ operator selects
                                              │
                        live qBit / *arr re-query ▼
                                         plan + guard verdicts + dry-run totals
                                              │  operator approves
                                              ▼
                              executor (re-verify guard → act → audit)
```

### 3.3 The join key

`(dev, inode)` captured during the filesystem walk is the primary correlation key across all four
sources. It is what proves:

- the Jellyfin file and the torrent file are the **same bytes** (hardlink),
- **two or more torrents** back one file (cross-seed),
- deleting a given path **frees zero bytes** because other links survive.

Path-string comparison cannot establish any of these. The walker therefore records `dev`, `inode`
and `nlink` up front rather than statting on demand, and `fs_entries(dev, inode)` is indexed.

### 3.4 Freshness policy

| Source | Indexed | Trusted for guard decisions |
|---|---|---|
| Jellyfin items | yes | yes (re-checked at execute for existence only) |
| Filesystem entries | yes | yes (re-stat at execute) |
| qBittorrent torrents | yes, for display | **no** — re-fetched at plan-build and per-action at execute |
| Radarr/Sonarr records | yes, for display | **no** — re-fetched at plan-build and per-action at execute |

Ratio, seeding time, category, tags and torrent state change between a nightly scan and a click.
A guard evaluated against indexed data is a broken guard.

---

## 4. Data model

SQLite at `/data/jellymaid.db`, WAL mode, `better-sqlite3`. Schema is versioned with forward-only
migrations.

```sql
-- scan lifecycle
scans(id, started_at, finished_at, status, phase, cursor_json, stats_json, error)

-- snapshot: Jellyfin
jellyfin_items(
  id TEXT PRIMARY KEY, scan_id, type, name, sort_name, year,
  series_id, series_name, season_no, episode_no,
  provider_ids_json, jf_path, container_path,
  size_bytes, runtime_ticks, container, video_codec, audio_codec,
  audio_channels, width, height, bitrate, has_primary_image,
  library_id, library_name, date_created, media_source_id
)

-- snapshot: filesystem
fs_entries(
  container_path TEXT PRIMARY KEY, scan_id, parent_path, name, ext,
  is_dir, size_bytes, mtime, dev, inode, nlink,
  is_media, library_root, quick_hash
)

-- snapshot: qBittorrent (display only; re-queried live for guards)
torrents(
  hash TEXT PRIMARY KEY, fetched_at, name, save_path, content_path,
  container_content_path, category, tags, state, ratio, seeding_time,
  is_private, tracker_host, size_bytes, progress
)
torrent_files(hash, file_index, rel_path, container_path, size_bytes, dev, inode,
              PRIMARY KEY(hash, file_index))

-- snapshot: *arr (display only)
arr_records(id, kind, instance, remote_id, title, arr_path, container_path,
            monitored, series_id, episode_id, episode_file_id)

-- results
findings(
  id TEXT PRIMARY KEY, rule_id, class, severity, confidence,
  subjects_json, evidence_json, reclaimable_bytes, status,
  first_seen, last_seen, dismissed_reason, dismissed_by, dismissed_at
)
dupe_groups(id TEXT PRIMARY KEY, tier, members_json, keeper_item_id,
            scores_json, status)

-- actions
plans(id, created_at, created_by, status, dry_run_json, approved_at, approved_by,
      started_at, finished_at)
plan_actions(id, plan_id, seq, type, payload_json, guard_verdicts_json,
             status, started_at, finished_at, error, result_json,
             override_by, override_reason)

-- forensics
audit(id, ts, actor, action_type, subject, before_json, after_json, outcome,
      plan_id, plan_action_id)
trash(id, original_path, trash_path, size_bytes, deleted_at, purge_after, restored_at)

-- misc
kv(key TEXT PRIMARY KEY, value_json)
```

Indexes: `fs_entries(dev, inode)`, `fs_entries(parent_path)`, `fs_entries(library_root, is_media)`,
`jellyfin_items(container_path)`, `jellyfin_items(series_id, season_no, episode_no)`,
`torrent_files(dev, inode)`, `findings(class, status)`, `plan_actions(plan_id, seq)`.

**Snapshot retention:** the current scan and the previous scan are kept (enables "new since last
scan" and diffing); older scan rows are pruned on completion.

---

## 5. Connectors

Endpoint paths below are the implementation starting point; exact shapes are verified against the
live server during Plan 1 (Jellyfin 10.11.x, qBittorrent WebUI API v2, \*arr v3).

### 5.1 Jellyfin

| Purpose | Call |
|---|---|
| Admin login | `POST /Users/AuthenticateByName` with `Authorization: MediaBrowser Client="Jellymaid", Device="Jellymaid", DeviceId=<stable>, Version=<ver>` |
| Revoke that token | `POST /Sessions/Logout` |
| Confirm admin | `GET /Users/Me` → `Policy.IsAdministrator` |
| Library roots | `GET /Library/VirtualFolders` |
| Items (paged) | `GET /Items?Recursive=true&IncludeItemTypes=Movie,Episode,Series,Season&Fields=Path,ProviderIds,MediaSources,MediaStreams,DateCreated,ParentId,ProductionYear&StartIndex=&Limit=500` |
| Merge versions | `POST /Videos/MergeVersions?Ids=a,b,c` |
| Split versions | `DELETE /Videos/{id}/AlternateSources` |
| Delete item | `DELETE /Items/{id}` |
| Refresh | `POST /Library/Refresh` |

`Series` and `Season` are fetched alongside playable items because `meta.episode-no-season`,
`meta.mixed-content` and `dupe.series-episode` need the container hierarchy, not just leaf files.

Long-lived operations use the configured **API key** (`X-Emby-Token`); the login flow uses a
short-lived user token that is revoked immediately after the admin check.

### 5.2 qBittorrent

| Purpose | Call |
|---|---|
| Login | `POST /api/v2/auth/login` → `SID` cookie (re-login transparently on 403) |
| Torrent list | `GET /api/v2/torrents/info` → hash, name, save_path, content_path, category, tags, state, ratio, seeding_time, size, progress |
| Per-torrent files | `GET /api/v2/torrents/files?hash=` |
| Properties | `GET /api/v2/torrents/properties?hash=` |
| Trackers | `GET /api/v2/torrents/trackers?hash=` |
| Delete with data | `POST /api/v2/torrents/delete` body `hashes=<h>&deleteFiles=true` |

**Private detection:** prefer the `private` field where the qBittorrent version exposes it; fall
back to tracker-host matching against a configurable private-tracker list. If privacy cannot be
determined, the torrent is treated as **private** (fail-safe).

### 5.3 Radarr / Sonarr

| Purpose | Call |
|---|---|
| Radarr inventory | `GET /api/v3/movie` (path, `movieFile.path`, `monitored`) |
| Radarr unmonitor | `PUT /api/v3/movie/{id}` with `monitored: false` (or `POST /api/v3/movie/editor`) |
| Sonarr inventory | `GET /api/v3/series`, `GET /api/v3/episodefile?seriesId=` |
| Sonarr unmonitor | `PUT /api/v3/episode/monitor` body `{ episodeIds: [...], monitored: false }` |

No delete endpoints are ever called. No blocklist endpoints are ever called. Multiple instances of
each are supported by config (array-shaped connector), even though v1 expects one of each.

---

## 6. Scan orchestration

Phases, executed in order, each with its own resumable cursor:

1. **Jellyfin** — virtual folders, then paged items (`Limit=500`), rate-limited with backoff.
2. **Filesystem** — walk each mapped library root and each mapped torrent root. Batched inserts in
   transactions of 1000 rows. Captures `dev`/`inode`/`nlink`.
3. **qBittorrent** — torrents plus per-torrent files, mapped into container paths and stat'd for
   `(dev, inode)`.
4. **\*arr** — inventory from each configured instance.
5. **Rule pass** — every registered rule runs over the completed snapshots.
6. **Reconciliation** — findings are upserted by stable id: still present → `lastSeen` bumped;
   gone → `resolved`; previously `dismissed` → stays dismissed.

**Resumability:** a cancelled or crashed scan resumes from `scans.cursor_json` at the phase it
died in. **Cancellation** is cooperative and checked between chunks.

**Rate limiting:** per-service concurrency cap and minimum inter-request delay, both configurable.
Defaults: Jellyfin 4 concurrent / 50 ms, qBittorrent 2 / 100 ms, \*arr 2 / 100 ms.

**Quick-hash** (`fs/hasher`) is **opt-in per library root**, never global. Cache key
`(dev, inode, mtime, size)` so a rescan doesn't re-read unchanged files.

**Schedule:** `SCAN_CRON` (default `0 3 * * *`). A scheduled scan never starts if one is running.

---

## 7. Rules catalog

Every rule is a pure function over the index and emits the shared `Finding` shape:

```ts
type Finding = {
  id: string            // stable hash(ruleId, subjectKey) — survives rescans
  ruleId: string
  class: 'duplicate' | 'filesystem' | 'metadata' | 'quality'
  severity: 'critical' | 'warning' | 'info'
  confidence: 'exact' | 'strong' | 'possible'
  subjects: Subject[]   // { kind: 'item' | 'path', id | path, label }
  evidence: Record<string, unknown>
  reclaimableBytes: number | null
  status: 'open' | 'dismissed' | 'resolved'
  firstSeen: string
  lastSeen: string
}
```

The stable `id` is load-bearing: dismissing "these two cuts are not duplicates" must survive every
future rescan.

### 7.1 Duplicates

| Rule id | Match | Tier |
|---|---|---|
| `dupe.provider-id` | Same tmdb / imdb / tvdb id across 2+ items | exact |
| `dupe.series-episode` | Same series + season + episode number | exact |
| `dupe.identical-file` | Equal size **and** equal quick-hash across different paths | exact |
| `dupe.title-year` | Normalized title + production year | strong |
| `dupe.runtime` | Normalized title match + runtime within ±2 s | strong |
| `dupe.fuzzy-title` | Trigram similarity ≥ threshold (default 0.88) | possible |

A **duplicate group** is a union-find cluster over all links produced by these rules; the group's
tier is the strongest tier that formed it. Groups spanning different libraries are allowed and
flagged as such.

Title normalization: lowercase, strip articles, punctuation, release tags, years in brackets,
scene group suffixes, and collapse whitespace. Normalization is a shared, unit-tested function.

`dupe.identical-file` depends on quick-hash, which is opt-in per library root (§6). Where hashing
is disabled the rule reports **not evaluated** for that root — it never silently reports zero.

### 7.2 Filesystem hygiene

| Rule id | Detects |
|---|---|
| `fs.empty-folder` | Directory with no media anywhere beneath it, ignoring a configurable ignorable-file list (`.DS_Store`, `Thumbs.db`, `.nfo`, …). Reports the **topmost** empty root, not every nested descendant |
| `fs.orphan-media` | Media file under a mapped library root that no Jellyfin item references |
| `fs.missing-file` | Jellyfin item whose path does not exist on disk |
| `fs.junk` | Sample files, `.part` / `.tmp` / `.!qB`, zero-byte files, `proof`/`screens` dirs, RAR remnants |
| `fs.stray-sidecar` | `.srt` / `.nfo` / `.jpg` with no matching media file beside it |
| `fs.permission` | Path Jellymaid cannot read or write — surfaced **before** an action that would fail on it is queued |

### 7.3 Metadata integrity

`meta.unidentified` (no provider IDs) · `meta.missing-artwork` (no primary image) ·
`meta.missing-year` · `meta.episode-no-season` · `meta.mixed-content` (one library root containing
both movie and series layouts) · `meta.bad-naming` (path violates Jellyfin naming conventions —
the root cause behind most unidentified items and many duplicates).

All are informational: they never produce a destructive action in v1.

### 7.4 Quality / space

`quality.low-bitrate` (below per-resolution threshold) · `quality.tiny-file` (far below peers of
the same runtime and resolution) · `quality.transcode-risk` (codec/container outside the
configured client profile) · `quality.missing-subs` · `quality.biggest` (top-N largest files and
folders).

These feed the keeper score; only `quality.tiny-file` is severity `warning`, the rest are `info`.

### 7.5 Thresholds

Every numeric threshold above (fuzzy similarity, runtime tolerance, bitrate floors per resolution,
tiny-file ratio, top-N) lives in `/data/config.json` and is editable in Settings. Defaults ship in
code and are documented in the README.

---

## 8. Duplicate resolution

### 8.1 Keeper score

For each member of a group, a weighted score picks a **pre-selected** keeper. It is never acted on
automatically.

| Signal | Weight |
|---|---|
| Resolution (height) | highest |
| HDR / Dolby Vision present | high |
| Bitrate | high |
| Video codec rank (configurable preference list) | medium |
| Audio channels | medium |
| Embedded/external subtitles present | low |
| File size (tiebreak) | lowest |

The UI shows the score breakdown per member so the pre-selection is auditable, not magic.

### 8.2 Group actions

- **Merge Versions** — `POST /Videos/MergeVersions`. All files stay on disk; Jellyfin presents one
  item with a version picker. Reversible from the History screen via split.
- **Delete non-keepers** — queues one `delete-media` action per non-keeper into the plan.
- **Dismiss** — with a required reason; persists across rescans via the stable finding id.

---

## 9. Action pipeline

### 9.1 Action types

`merge-versions` · `split-versions` · `delete-media` · `remove-empty-folder` · `delete-junk-file`

### 9.2 `delete-media` — resolve

Given a target path: `path → (dev, inode) →` every hardlink to those bytes, every torrent whose
mapped content path lands on that inode, every \*arr record referencing the path.

### 9.3 Guards

Evaluated at plan-build against live data, then **re-verified immediately before the action runs**.

| Guard | Condition | Verdict |
|---|---|---|
| `guard.private-ratio` | Torrent is private (or privacy undeterminable) and `ratio < minRatio` or `seeding_time < minSeedTime` | **Block.** Per-row override allowed via an explicit toggle; override actor and reason are recorded in `plan_actions` and `audit` |
| `guard.cross-seed` | 2+ torrents resolve to the same inode | **Block** until confirmed; on confirmation the action expands to remove **all** matching torrents together |
| `guard.hardlink` | `nlink > 1` | **Warn.** Every other link path is listed; each link is its own selectable plan row. Reclaimed bytes shown as 0 unless the last link is included |
| `guard.protected` | State is downloading/checking/moving, or category/tag is on the protect list | **Block, no override** |

Defaults: `minRatio 1.0`, `minSeedTime 14d`, protect list empty, private-tracker host list
user-populated. All configurable.

### 9.4 Execution order

The order is the design. For each `delete-media` action:

1. **\*arr unmonitor** (Radarr `monitored:false`, Sonarr episode monitor off). Nothing can re-grab
   the title while the delete is in flight. **Fail-closed:** if unmonitor fails, this file's
   delete is skipped entirely and marked `skipped` with the reason.
2. **qBittorrent** `torrents/delete` with `deleteFiles=true` for every matched torrent, then poll
   `torrents/info` until the hash is gone (bounded timeout; on timeout the action fails and the
   rest of the plan continues).
3. **Sweep** — remove leftovers qBittorrent doesn't: extra files in the torrent directory, then
   empty parent directories walked upward, **never above the mapped library or torrent root**.
4. **Remaining hardlinks** the operator selected are unlinked here. This is the step that actually
   reclaims space in a hardlinked setup.
5. **Jellyfin** — `DELETE /Items/{id}` for entries whose file is now gone, then **one** batched
   `POST /Library/Refresh` after the whole plan completes.

Files with no torrent match skip 1–2 where inapplicable and go straight to 3–5.

### 9.5 Execution semantics

- Every action is **idempotent** — re-running a completed action is a no-op.
- The executor holds a **mutex**; two plans can never run concurrently.
- An approved plan is an **immutable snapshot**; edits require a new plan.
- Per-action status: `pending | running | done | failed | skipped | blocked`.
- A failure does **not** abort the plan — remaining actions continue — except the fail-closed
  \*arr case above.
- Every action writes an `audit` row with before/after state, guard verdicts, actor, and outcome.

### 9.6 Trash policy

No quarantine for torrent-managed or large files: qBittorrent deletes its own data in step 2, and
pre-copying a 60 GB remux to a trash folder defeats the purpose of reclaiming space.

A trash folder **is** used for non-torrent junk: files below `trash.maxBytes` (default 1 GB) that
are not backed by any torrent are **moved** to `<library-root>/.jellymaid-trash/<plan-id>/` with a
manifest, and purged after `trash.retentionDays` (default 30). Both are `config.json` keys, editable
in Settings. Restore is available from History while the entry survives. Same-filesystem move only;
if the trash target is on a different device, the file is deleted directly and the row is marked as
such.

`.jellymaid-trash` is excluded from every scan phase and every rule — it must never surface as
orphan media, junk, or an empty folder, and it must never be counted in folder sizes shown in
Explorer. The exclusion is enforced in `fs/walker`, not per rule.

Before approval, every plan shows a **dry-run preview**: exact paths, exact byte totals, which
torrents will be removed, which links survive, and what is blocked and why.

---

## 10. Authentication

Login is a Jellyfin account: `POST /Users/AuthenticateByName`, then `GET /Users/Me` to require
`Policy.IsAdministrator`, then `POST /Sessions/Logout` to revoke the token immediately. Jellymaid
holds a signed, httpOnly, `SameSite=Lax` session cookie afterwards; the Jellyfin password is only
ever present in the body of that one auth request.

- Non-admin Jellyfin users are rejected — this app deletes things.
- Lockout: 3 failures in 5 minutes → 1 hour, per username and per IP.
- Jellyfin being unreachable consumes **no** attempt.
- `TRUST_PROXY=1` makes the rightmost `X-Forwarded-For` token authoritative when behind Cloudflare
  or another reverse proxy.
- All mutating API routes require an authenticated session; all destructive routes additionally
  require the plan id to match an approved plan.

---

## 11. Configuration

Secrets come from the environment; everything else lives in `/data/config.json` and is editable in
Settings.

| Env var | Purpose |
|---|---|
| `JELLYFIN_URL`, `JELLYFIN_API_KEY` | Required |
| `QBIT_URL`, `QBIT_USER`, `QBIT_PASS` | Required |
| `RADARR_URL`, `RADARR_API_KEY` | Optional |
| `SONARR_URL`, `SONARR_API_KEY` | Optional |
| `DATA_DIR` | Default `/data` — SQLite, config, audit |
| `SCAN_CRON` | Default `0 3 * * *` |
| `TRUST_PROXY`, `TZ`, `PORT` | Deployment |

### 11.1 Path mapping

```json
[
  { "role": "library",  "jellyfin": "/media/Movies", "container": "/mnt/media/Movies", "qbit": "/downloads/movies" },
  { "role": "library",  "jellyfin": "/media/TV",     "container": "/mnt/media/TV",     "qbit": "/downloads/tv" },
  { "role": "download", "jellyfin": null,            "container": "/mnt/downloads",    "qbit": "/downloads" }
]
```

`role: "library"` roots are walked for orphans, empty folders and junk, and are the boundary the
sweep never climbs above. `role: "download"` roots have no Jellyfin equivalent — they exist so
torrent content paths can be resolved to real inodes for the hardlink and cross-seed guards. A
download root is never scanned for orphan media (everything in it is legitimately not in Jellyfin).

A misconfigured path map is the single most likely way a tool in this category deletes the wrong
thing, so it gets two safeguards:

- **Auto-detect** — takes a sample of Jellyfin item paths, searches the mounts for matching files
  by size and inode, and proposes the mapping.
- **Verify mappings** — resolves 20 random Jellyfin items end-to-end (Jellyfin path → container
  path → stat → torrent match) and reports the success rate. Scans refuse to start while
  verification is failing, unless explicitly forced.

---

## 12. UI

React 19 + Vite, served by the same container. Seven screens:

1. **Dashboard** — connector health (Jellyfin / qBittorrent / Radarr / Sonarr, each reachable or
   not), last scan summary, findings by class with total reclaimable bytes, scan button + progress.
2. **Findings** — filter by class, severity, confidence, library, rule; bulk select; dismiss with
   reason; add to plan.
3. **Duplicates** — group cards, side-by-side member comparison, keeper score breakdown, tier
   badge, per-group Merge / Delete non-keepers / Dismiss.
4. **Explorer** — browse the mounted tree with per-folder size, file count, and orphan/junk/empty
   overlays. This is the "mount the folders to view" capability: it reads the index, not the live
   filesystem, so it stays fast at 100k+ items, with a per-folder refresh.
5. **Plan** — the queue, per-row guard verdicts and overrides, dry-run totals, approve, then live
   execution progress with per-action status.
6. **History** — audit log with filters and export; split-versions undo; trash restore.
7. **Settings** — connections, path map (+ auto-detect and verify), rule thresholds, protect lists,
   private-tracker hosts, schedule, trash policy.

All user-controlled strings (file names, torrent names, tracker hosts, dismiss reasons) render as
text nodes only — never `innerHTML`.

---

## 13. Error handling

- **Typed connector errors** — unreachable, auth-failed, rate-limited, unexpected-shape — each
  surfaced per service on the Dashboard.
- **Degraded scans** — a scan proceeds with whatever is reachable, and any rule whose inputs are
  missing is recorded as **not evaluated**, never as zero findings. "No duplicates found" and
  "couldn't check for duplicates" must never render identically. Rules declare their required
  sources; the orchestrator skips and marks accordingly.
- **Plan-build refuses** to include an action whose required connector is down.
- **Retry with exponential backoff** on 5xx and rate-limit responses; auth failures do not retry.
- **Crash recovery** — a scan interrupted mid-phase resumes from its cursor; a plan interrupted
  mid-execution resumes from the first non-`done` action after the operator confirms.

---

## 14. Testing strategy

Vitest, with coverage required on every rule and every guard.

| Layer | Approach |
|---|---|
| Rules | Pure functions against fixture SQLite databases. No network, no filesystem. One fixture per scenario, including the messy ones (mixed libraries, unidentified items, cross-library dupes). |
| Title normalization / keeper score | Table-driven unit tests with real-world-ugly names. |
| Connectors | Recorded HTTP fixtures; plus contract tests that run only when live env vars are present (skipped in CI). |
| `fs/walker`, sweep, hardlink logic | Real temp directories with **real hardlinks**. Inode logic tested against mocks is inode logic untested. |
| Guards | Exhaustive table tests over the state matrix (private × ratio × seed-time × cross-seed × nlink × category × torrent state). |
| Executor | Fake connectors + real tmpdir; asserts ordering (unmonitor before delete), fail-closed behaviour, idempotency, and resume. |
| API | Route-level tests including auth enforcement and the approved-plan requirement. |
| UI | Component tests for the duplicate group card and plan row; XSS assertions on user-controlled strings. |

---

## 15. Deployment

- Repo `Atvriders/jellymaid`, public, master branch.
- GitHub Actions: typecheck → test → build → publish multi-arch (`linux/amd64`, `linux/arm64`)
  image to `ghcr.io/atvriders/jellymaid`, public.
- `docker-compose.yml` with the media and download bind mounts, `/data` bind mount (**required** —
  the index, config, audit log and trash manifest all live there), and the env vars from §11.
- `GET /healthz` returns index status and per-connector reachability.
- README documents the path map, the guard defaults, and an explicit warning that Jellymaid
  deletes media.

---

## 16. Delivery slices

The spec is one system but too large for a single implementation plan. It splits along the data
flow, each slice independently verifiable:

| Slice | Contents | Done when |
|---|---|---|
| **1 — Foundation** | Repo, TS/Fastify/Vite skeleton, SQLite schema + migrations, config loading, path map + auto-detect + verify, Jellyfin connector, auth, `/healthz`, CI | You can log in as a Jellyfin admin and verify path mappings resolve |
| **2 — Index** | `fs/walker` (dev/inode/nlink), `fs/hasher`, qBittorrent + \*arr connectors, scan orchestrator with phases/cursors/resume/rate limits, scheduler | A full scan of the real library completes, resumes after kill, and populates all four snapshots |
| **3 — Rules** | Finding model, all four rule classes, union-find dupe grouping, keeper scoring, reconciliation, not-evaluated handling | Findings appear for the real library with correct tiers and stable ids across rescans |
| **4 — Actions** | Planner, all four guards, executor with the §9.4 ordering, trash, audit, undo (split versions, trash restore) | A plan against fixture data executes in the right order and every guard blocks what it should |
| **5 — UI** | The seven screens, progress streaming, XSS-safe rendering | Whole flow is drivable from the browser |
| **6 — Ship** | Multi-arch GHCR build, compose, README with the deletion warning | Image pulls and runs against the live stack |

Slices 1–2 are strictly sequential. Slice 3 depends only on the schema, so its rules can be built
against fixture databases in parallel with slice 2.

## 17. Future (not v1)

- Auto-apply for rules the operator marks safe, with a kill switch and mandatory audit.
- Renaming/reorganising into Jellyfin-canonical layout.
- A thin Jellyfin plugin that adds a Jellymaid entry to the admin dashboard.
- Additional download clients (Deluge, Transmission) behind the same connector interface.
- Lidarr/Readarr, if the library ever grows those.
