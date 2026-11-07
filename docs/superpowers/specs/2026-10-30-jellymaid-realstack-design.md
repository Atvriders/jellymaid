# Jellymaid — real-stack upgrade ("dupe flow first")

Date: 2026-10-30. Supersedes nothing; amends `2026-07-26-jellymaid-design.md` where they conflict.

## Why

Jellymaid shipped in July 2026 tested only against fakes. Its owner asked to "finish it, make sure it
all works". An audit against the owner's real stack, plus a local harness running the same software
versions (Jellyfin **12.1.0**, qBittorrent **5.2.2** and **5.1.2**), showed the core flow cannot work:

- Jellyfin 12.x ignores `X-Emby-Token`. Every Jellymaid call to Jellyfin returns 401, so scans get no
  data and administrator login is impossible.
- qBittorrent 5.2 answers a successful login with `204` and an empty body, and names its cookie
  `QBT_SID_<port>`. Jellymaid requires the body `Ok.` and a cookie named `SID`.
- The owner runs **two** qBittorrent instances on two machines ("box A", "box B"). Both save into
  paths they each call `/movies` and `/tv`. Jellymaid models exactly one instance, so a delete could
  hit the wrong box's copy.
- The executor's last step is `DELETE /Items/{id}`. When the item's files still exist, Jellyfin
  itself deletes the item's whole containing folder. Verified on the harness.
- Jellymaid deletes per file. The owner's torrents are saved straight into the library, so every
  video arrives with `.nfo`, `.srt` and sample files. `guard.torrent-scope` then blocks nearly every
  delete.
- Several dupe-rule bugs: every film in a TMDB collection groups as an "exact" duplicate of the
  others. Fuzzy links chain different films together. Dismissals never stick.

The owner's flow is: **scan → duplicate list → verify each group → queue the unwanted copies →
plan → approve → qBittorrent deletes the torrent with its files on the right box → Jellyfin forgets
the item.**

## Owner decisions (2026-10-30)

1. **Scope: the dupe flow first.** Make the flow above work end to end on the real stack. Side
   features get fixed only where they are broken or misleading (junk/orphan rules, Explorer,
   Findings). Everything else is written down, not built.
2. **Private-tracker guard stays strict.** A private torrent may be deleted only when it has
   **both** ratio ≥ `minRatio` **and** seeding time ≥ `minSeedTimeDays`. The defaults stay 1.0 and
   14 days. Thresholds become editable in Settings and take effect without a restart. Because this
   blocks roughly half of the owner's torrents, a bulk override must be quick to use.
3. **Keeper default: best quality.** The highest-quality copy is pre-selected to keep. The policy
   becomes a setting (`best-quality` | `smallest` | `none`).

## Goals

- G1. Both qBittorrent instances configured at once, each with its own path prefix, credentials
  optional (the owner's instances bypass auth for the LAN).
- G2. Works against Jellyfin 12.1 and against qBittorrent 5.1 and 5.2.
- G3. Deleting a duplicate copy removes its torrent with all its data (companion files included),
  on the instance that owns that copy, and never touches the other box.
- G4. Jellyfin forgets deleted items through a path notification. Jellymaid never asks Jellyfin to
  delete anything.
- G5. The Duplicates screen works at the owner's scale (hundreds of groups). It shows each copy's
  box and torrent facts, supports bulk queueing, and keeps a dismissal dismissed.
- G6. Every new behavior is proven against the real software in the local harness, then with a
  read-only scan against the owner's real stack.

## Non-goals

- Hardlink layouts and Radarr/Sonarr improvements (they keep working as they do; the owner uses neither).
- Renaming, transcoding, or moving files.
- Session revocation and login-audit trail (carry-forward, unchanged).
- Explorer and Findings polish beyond the fixes listed below.

## Anti-goals (a build that does these has failed even if tests pass)

- Any code path that can make Jellyfin delete files (`DELETE /Items`).
- A delete routed to the wrong qBittorrent instance, or a raw unlink of a file a torrent is seeding
  because a mapping or match was missing.
- Repeated failed qBittorrent logins (5 failures ban the caller's IP for an hour).
- Repeated failed Jellyfin logins that let Jellyfin disable the owner's admin account.
- Real hostnames, LAN addresses or share paths in anything committed. The repository is public.

## Design

### 1. qBittorrent instances

- Env `QBIT_INSTANCES` is a comma-separated list of `id=url` pairs, for example
  `box-a=http://198.51.100.10:8080, box-b=http://198.51.100.11:8080`. The id matches
  `^[a-z0-9][a-z0-9-]{0,31}$`. The URL may embed `user:pass@`, percent-decoded. Per-instance
  `QBIT_<ID>_USER` / `QBIT_<ID>_PASS` override it, where `<ID>` is the id uppercased with `-` → `_`.
- Backward compatible: without `QBIT_INSTANCES`, `QBIT_URL` (+ optional `QBIT_USER`/`QBIT_PASS`)
  defines one instance with id `default`. Credentials are optional everywhere.
- Login, measured on the harness:
  - **Success** = `200` with body `Ok.`, **or** `204`.
  - **Failure** = `401`, **or** `200` with body `Fails.`.
  - **Banned** = `403` with a body containing `banned`.
- Keep whatever session cookie the server sets (`SID` or `QBT_SID_<port>`, whatever name contains
  `SID`) and send it back verbatim.
- After a failed login or a ban, the client makes no further login attempt for 5 minutes (60 for a
  ban) and returns the remembered error instead.
- With no credentials configured, the client never calls login. A 403 then means "this instance
  needs credentials" and is reported as an `auth` error. No login loop.
- `Torrent` and every index row carry `instanceId`. Index keys become `(instance_id, hash)`. The
  same infohash on both boxes is two torrents (the real instances share 10).

### 2. Path mapping per instance

- `PathMapping` gains `qbitInstance: string | null`. `qbit` is that instance's own spelling of the
  root. A root with `qbit = null` and `qbitInstance = null` is **explicitly not torrent-backed**.
- A root with a `qbit` prefix but no resolvable instance is **misconfigured** and fails closed.
  An old single-instance config with `qbit` set and no `qbitInstance` is filled in automatically
  only when exactly one instance exists.
- `torrentSourceFor(containerPath)` answers which instance may own a file (`instance` | `none` |
  `unknown`). The resolver asks only that instance. Box A's files can only be owned by box A's
  torrents.
- **Verify** now checks both halves:
  - Jellyfin → container (as before).
  - For every instance, up to 20 completed torrents' `content_path` → container path → exists,
    with the size matching for single-file torrents.
- The stored verification record carries a hash of the mapping set. A changed mapping set makes it
  stale. Scans **and plan builds** refuse to start on a stale or failing verification (a manual
  scan can still be forced; a plan cannot).
- **Auto-detect** also proposes `qbit`/`qbitInstance` per mapped container root, by finding which
  instance's content paths exist under it. It runs asynchronously and does not block the server.

### 3. Live configuration

A `ConfigStore` re-reads `config.json` when it changes. The planner, executor, Explorer, health,
duplicates and settings routes always use the current path map, guard thresholds and keeper policy.
No restart is needed after saving. One plan run uses one consistent snapshot.

### 4. Jellyfin

- Every call sends `Authorization: MediaBrowser Client="Jellymaid", Device="Jellymaid",
  DeviceId="…", Version="…", Token="…"`. No `X-Emby-Token` anywhere.
- Login:
  - Each login uses a fresh DeviceId. A second login with the same DeviceId revokes the first
    token.
  - Administrator status comes from the `AuthenticateByName` response.
  - The token is revoked with `POST /Sessions/Logout`, which returns 204 on 12.1.
- Before forwarding a password, Jellymaid reads the account's `InvalidLoginAttemptCount` and
  `LoginAttemptsBeforeLockout` (`-1` = never, `0` = default 3). It refuses — with the same
  "wrong username or password" response — when one more failure would disable the account.
  Jellymaid's own lockout key is case-insensitive.
- Forget: after a plan finishes, Jellymaid sends one `POST /Library/Media/Updated` listing every
  deleted path as `UpdateType: "Deleted"`. Harness facts:
  - With the file gone, the item drops after the server's `LibraryMonitorDelay` (60 s default;
    65 s observed).
  - With the file still present, nothing happens.
  - It does not restart a running library scan.
- `DELETE /Items/{id}` and `POST /Library/Refresh` are removed from the connector.
- Item paging sorts by `DateCreated` ascending. A pass is complete only when the unique ids fetched
  equal `TotalRecordCount`, and that count did not change between the first and last page.
  Otherwise the phase does not sweep.

### 5. The delete unit and guards

- A file is a **companion** when its extension is not a media extension, or when it matches the
  `fs.junk` sample/proof/screens patterns (so `sample.mkv` counts). `guard.torrent-scope` blocks
  only when a matched torrent holds **media** files the plan does not name. A movie release with
  its `.nfo`/`.srt`/sample passes. A season pack with one queued episode still blocks
  (overridable). The dry run lists how many companion files go with each torrent.
- New guard `guard.untracked` (overridable block): the file sits under a torrent-backed root but no
  torrent on that root's instance owns it. Overriding means "this is a leftover; delete it from
  disk".
- A root whose instance is unknown makes `guard.protected` block, with no override, the same as an
  unreachable instance.
- `guard.private-ratio` keeps its AND semantics (owner decision 2). Thresholds, protected
  categories/tags and private-tracker hosts are editable at `PUT /api/config/settings`.
- Executor:
  - Matched hashes are grouped by instance. Each group goes to its own client's
    `deleteWithData` + `awaitGone`.
  - After `awaitGone`, step 3 waits up to 30 s for the file to disappear. qBittorrent deletes
    asynchronously, and over NFS the client may see it late. An `ENOENT` during unlink counts as
    removed by qBittorrent, not as a failure.
  - Bytes freed are credited per torrent removed, not per action.
  - Every deleted container path is written to `deleted_paths`. The Duplicates list hides those
    members immediately; rows clear once a later Jellyfin pass no longer lists the path.
- Plans and scans are mutually exclusive (`ActivityLock`).
- Execute runs in the background: `POST /execute` returns 202 and the UI polls the plan.
- A plan build reuses one torrent-list snapshot per instance. Execution refreshes an instance's
  list at most every 10 s, and immediately after that instance deletes something.
- When an override is resubmitted for a guard that no longer blocks, the override is dropped and
  reported. It no longer fails the whole build with 400.

### 6. Duplicate rules

- `dupe.provider-id` uses only the identity namespaces `tmdb`, `imdb`, `tvdb` (lowercased), and
  only between items of the same type. Collection ids (`tmdbcollection`, anything containing
  `collection`) are never identities.
- Groups are connected components over `exact` and `strong` links only. A `possible` link never
  merges two groups. It forms a two-member `possible` group only when neither item is already
  grouped.
- `dupe.series-episode` keys on the **series' provider id** (tvdb, then tmdb, then imdb), plus season
  and episode. It falls back to Jellyfin's `series_id`. The same show in two library roots (two
  Series items) therefore still matches. A multi-episode file links as `strong`, not `exact`.
- `editionOf(name)` recognises Extended, Unrated, Director's Cut, Theatrical, Final Cut, IMAX,
  Ultimate, Special Edition, Remastered and Criterion. A group whose members differ in edition is
  marked `editionsDiffer`. Its non-keepers are never pre-selected for deletion.
- `keeper.policy`:
  - `best-quality` (default): today's weights.
  - `smallest`: the smallest file wins.
  - `none`: no keeper; the operator picks.
- Dismissal sticks: `persist()` keeps a group's `dismissed` status while its id (its member set) is
  unchanged. `/api/duplicates` hides dismissed groups.
- Side rules:
  - `meta.bad-naming` is off by default (it flagged 5,416 of 5,417 real releases).
  - `fs.orphan-media` ignores `BDMV`/`VIDEO_TS` trees and Jellyfin extras folders.

### 7. API read model and UI

- `/api/duplicates` returns:
  - Per group: title, year, series/season/episode, tier, matchedBy, keeper, `editionsDiffer`,
    `crossInstance`, and `reclaimableBytes`.
  - Per member: its instance (box), and its torrent facts — name, state, ratio, seeding days,
    private, tracker host, size, file count, media file count, and `hnrMet` under the current
    thresholds.
  - Whether dupe matching was evaluated, and from which scan.
- Duplicates screen:
  - Sort (reclaimable bytes by default, or title, or tier), filters (tier, box, cross-box only,
    H&R-blocked) and search.
  - Paged rendering, 50 groups per page.
  - "Queue non-keepers" for one group or for every visible group. Bulk skips `possible` groups and
    `editionsDiffer` groups unless the operator ticks a box to include them.
  - The queue persists in `localStorage`.
  - Dismiss replaces session-only hide. Merge is secondary and asks for confirmation.
- Plan screen:
  - Shows each action's torrents with box, ratio, seed days and companion count.
  - "Override <guard> for all N blocked rows" with a confirmation. Rebuild keeps earlier overrides.
  - Execution progress, by polling.
  - The Jellyfin note: "Jellyfin drops deleted items within about a minute."
- Settings:
  - Mapping rows get a qBittorrent-instance picker.
  - Verify shows Jellyfin and per-instance qBittorrent results.
  - Thresholds and keeper policy become editable.
- Dashboard and `/healthz` report each qBittorrent instance separately, with its version.

### 8. Scan robustness

- The qBittorrent phase:
  - Runs per instance and sweeps per instance.
  - Reports progress.
  - Synthesizes the file list of a single-file torrent (`root_path === ""`) without an extra call.
  - Default qBittorrent rate limit becomes concurrency 4, 25 ms.
- A filesystem root that walks empty while the index holds rows for it is treated as unmounted.
  It is not swept, and the phase says so.
- SQLite `busy_timeout` is 15 s on every connection.
- `SIGTERM`/`SIGINT` handling: the server stops taking work, a running scan is cancelled, a running
  plan finishes its current action and is left resumable, then the database closes. The compose
  file sets `init: true`.

### 9. Ops

The compose file targets Unraid's Compose Manager:
- `PUID`/`PGID` default to 99/100.
- `/data` maps to a placeholder appdata path.
- Two-instance `QBIT_INSTANCES` example.
- No Radarr/Sonarr in the quick start.
- `init: true`.

CI smoke-starts the built image and checks `/healthz` before publishing. Production dependency
advisories are fixed only where the upgrade is non-breaking. Otherwise they are documented with
the reason. The README documents the multi-instance setup, the Unraid same-host auth caveat, and
exactly which versions were verified.

## Verification

1. Typecheck. Server and client suites pass on Node 20 and Node 22. `npm run build` succeeds.
2. Harness end-to-end (real Jellyfin 12.1.0, qBittorrent 5.2.2 + 5.1.2, library of attached
   torrents):
   - scan → the expected groups appear: within-box, cross-box, and season pack vs single episode;
   - a cross-seed is detected;
   - deleting box B's copy removes only B's torrent and files;
   - companions go with the torrent;
   - Jellyfin drops the item;
   - the other box is untouched.
   Driven through the real UI with Playwright and screenshots.
3. Read-only scan against the owner's real stack (API key from the owner): groups found, mapping
   verified, no writes.
4. Owner's first-run checklist on Unraid with one disposable item.

## Left to the builder

Exact UI layout, copy tone, internal helper names not listed in the plan's contract, and test
structure — within the plan's Global Constraints.
