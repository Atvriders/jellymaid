# Jellymaid

Jellymaid audits a [Jellyfin](https://jellyfin.org/) media library for duplicates and filesystem
rot, then — once an operator has reviewed and approved a plan — **permanently deletes media files
and removes their torrents with data** from qBittorrent. It coordinates with Radarr/Sonarr so a
delete doesn't trigger an immediate silent re-download, and it never touches a seeding torrent
that hasn't met a configurable ratio/seed-time floor.

> **Jellymaid deletes things. Permanently.** There is no undo for a file removal or a
> qBittorrent delete-with-data. Read this whole document, run the first-run checklist at the
> bottom against a throwaway file before you trust it with anything you care about, and keep a
> backup strategy that does not depend on Jellymaid behaving correctly.

## What it is not

- **Not a Jellyfin plugin.** Jellymaid is a separate, standalone Docker container that talks to
  Jellyfin over its HTTP API (`JELLYFIN_API_KEY`). It does not install into Jellyfin's plugin
  system and does not appear in Jellyfin's own admin dashboard.
- **Never deletes from Radarr or Sonarr, and never blocklists a release.** The one hard rule this
  project was built around: when Jellymaid removes a file that Radarr or Sonarr manages, it
  **unmonitors** the movie or episode in that \*arr instance first — it never calls a delete or
  blocklist endpoint. The movie/series entry stays in Radarr/Sonarr, unmonitored, so nothing
  re-grabs it.
- **Never acts without an approved plan.** Every destructive action — deleting a file, removing a
  torrent with its data, merging or splitting Jellyfin versions — is queued into a plan, shown to
  an operator with a dry-run preview (exact paths, exact byte totals, what's blocked and why), and
  only runs after that specific plan is approved by an authenticated Jellyfin administrator.
- **Not a general file manager or renamer.** It does not reorganize your library into a canonical
  folder layout, transcode anything, or mutate media files in place. Bad naming is reported, never
  fixed automatically.

## Quick start

```yaml
services:
  jellymaid:
    image: ghcr.io/atvriders/jellymaid:latest
    container_name: jellymaid
    restart: unless-stopped
    user: "${PUID:-1000}:${PGID:-1000}"
    ports:
      - "8099:8099"
    environment:
      JELLYFIN_URL: "http://192.0.2.10:8096"
      JELLYFIN_API_KEY: "${JELLYFIN_API_KEY}"
      QBIT_URL: "http://192.0.2.10:8080"
      QBIT_USER: "${QBIT_USER}"
      QBIT_PASS: "${QBIT_PASS}"
      # Optional. Jellymaid only ever unmonitors in these — it never deletes or blocklists.
      RADARR_URL: "http://192.0.2.11:7878"
      RADARR_API_KEY: "${RADARR_API_KEY}"
      SONARR_URL: "http://192.0.2.11:8989"
      SONARR_API_KEY: "${SONARR_API_KEY}"
      TZ: "UTC"
      TRUST_PROXY: "0"
    volumes:
      - ./data:/data
      - /path/to/media:/mnt/media
      - /path/to/downloads:/mnt/downloads
```

A ready-to-edit copy lives at [`docker-compose.yml`](docker-compose.yml), with an
[`.env.example`](.env.example) for the secrets it references. Replace every `192.0.2.x` address
and `/path/to/...` mount with your own — those are placeholders (RFC 5737 example addresses),
never real hosts.

- **`/data` is a required bind mount.** The SQLite index, `config.json`, the audit log and the
  trash manifest all live there. Losing it loses your scan history, plan history and settings (not
  your media — nothing under `/data` is media).
- **Media and download mounts are read-write, not read-only.** Jellymaid removes empty folders and
  leftover hardlinks directly on disk — no Jellyfin or qBittorrent API can do that — and its trash
  folder for small non-torrent files lives *inside* each of these mounts (see [Trash](#trash)
  below), which only works if the mount is writable and is the true root of one filesystem.
- **`PUID`/`PGID`** (via Compose's `user:` field) control which uid:gid the container runs as.
  Match these to whoever owns your media on the host, or Jellymaid will create root-owned trash
  and replacement files in a library your own account owns. `./data` must exist and be
  `chown`-ed to that same uid:gid *before* the first start — Docker creates a missing bind-mount
  directory as root, and a non-root container can't then write to it.
- **Required environment variables:** `JELLYFIN_URL`, `JELLYFIN_API_KEY`, `QBIT_URL`, `QBIT_USER`,
  `QBIT_PASS`. The container refuses to start if any of these are missing. `RADARR_URL` +
  `RADARR_API_KEY` and `SONARR_URL` + `SONARR_API_KEY` are optional, but each pair is all-or-nothing
  — setting one half without the other is also a startup failure, so the mistake is loud rather
  than silently ignored.
- **First login must be a Jellyfin administrator account.** Login is `POST /Users/AuthenticateByName`
  against your Jellyfin server; Jellymaid then confirms `Policy.IsAdministrator` and immediately
  revokes that Jellyfin token, replacing it with its own signed session cookie. A non-admin
  Jellyfin account is refused outright — this app deletes things, so there are no lesser roles.
  Three failed logins in five minutes locks that username for an hour; the same applies per public
  IP address (private/loopback addresses are exempt from the IP dimension, since a proxy in front
  of Jellymaid can otherwise collapse every real client onto one address — see
  [`TRUST_PROXY`](#troubleshooting) below).

## Path mapping

Jellymaid sees your library through three different namespaces at once — the path Jellyfin
reports, the path Jellymaid's own container sees it at, and the path qBittorrent reports for a
torrent's content — and has to translate between them to do anything useful. That translation
table is `pathMappings` in `/data/config.json`, editable from Settings. Each entry has three
fields plus a `role`:

```json
{ "role": "library", "jellyfin": "/media/Movies", "container": "/mnt/media/Movies", "qbit": "/downloads/movies" }
```

- **`role: "library"`** — a root Jellyfin actually indexes. These are walked for orphans, empty
  folders and junk, and are the boundary a delete's directory sweep is never allowed to climb
  above. Requires a `jellyfin` path.
- **`role: "download"`** — a root with no Jellyfin equivalent (set `jellyfin` to `null`). Download
  roots exist purely so qBittorrent's content paths can be resolved to real `(dev, inode)` pairs —
  that resolution is what the hardlink and cross-seed guards depend on. A download root is never
  scanned for orphan media, since everything in it is legitimately outside Jellyfin's library.

A misconfigured path map is the single most likely way a tool in this category deletes the wrong
thing, so it gets two dedicated Settings tools:

- **Auto-detect** samples Jellyfin item paths, searches your mounted volumes for matching files by
  size and directory structure, and proposes a mapping — proposing nothing rather than guessing
  when the evidence is ambiguous.
- **Verify** resolves 20 random Jellyfin items end-to-end (Jellyfin path → container path → exists
  on disk) and reports how many resolved. **Scans refuse to start while the last verification
  didn't fully pass** (fewer than the full sample resolved, or nothing has been verified yet) —
  this applies to the nightly scheduled scan too, not just the manual button, and there is no way
  to make the schedule bypass it. The manual "Scan now" button can be force-started past a failing
  verification if you explicitly choose to; the schedule cannot.

## How a delete actually runs

Every `delete-media` and `delete-junk-file` action runs through these steps, in this fixed order,
on a plan the operator has already approved. Guards (below) are checked once when the plan is
built against live data, and **re-checked immediately before each action executes** — ratio,
seeding time, torrent state and \*arr monitoring can all change between a nightly scan and a click,
so a guard evaluated only against yesterday's index would be a guard evaluated against nothing.

1. **Radarr/Sonarr unmonitor.** If the file is \*arr-managed, Jellymaid flips it (and, when a torrent
   backs more than one file this plan will remove, every sibling file's own \*arr record) to
   unmonitored before anything is deleted. This is **fail-closed**: if the unmonitor call cannot be
   confirmed for any of them, the whole delete is skipped and marked so, precisely so nothing can
   re-grab a title mid-delete. Radarr and Sonarr are never called to delete or blocklist anything —
   ever, for any reason.
2. **qBittorrent delete-with-data.** Every torrent whose content resolves to this file is removed
   with `deleteFiles=true`, and Jellymaid polls until qBittorrent confirms the hash is actually
   gone before moving on.
3. **Sweep leftover empty directories.** Whatever qBittorrent didn't own — this path's own link,
   plus any now-empty parent directories — is removed, walking upward but never above the mapped
   library or torrent root.
4. **Remaining hardlinks** the operator explicitly selected in the plan are unlinked here. This is
   the step that actually reclaims space in a hardlinked \*arr/qBittorrent layout — removing only
   the first link frees nothing.
5. **Jellyfin**, last: the item is deleted once its bytes are actually gone (or the library is
   refreshed instead, if the item still has a surviving sibling version or was merged). **One**
   batched `Library/Refresh` runs after the whole plan finishes — never per file.

A file with no matching torrent skips straight to steps 3–5.

**"Merge" is a different, non-destructive operation.** Selecting "Merge Versions" on a duplicate
group calls Jellyfin's own `MergeVersions` API: no files are touched, Jellyfin just presents the
group as one item with a version picker. It's reversible from History via split. Deleting
non-keepers from a duplicate group is a separate, explicit choice that goes through the same
queue → approve → delete pipeline as everything else.

## The five guards

Every path-based action is judged against five guards before it can run. Guards are pure checks
against live data — no guard is ever evaluated from a stale scan snapshot.

| Guard | Protects against | Overridable? |
|---|---|---|
| `guard.private-ratio` | Deleting a private-tracker torrent's data before it has met ratio/seed-time minimums (getting your account banned) | Yes — an explicit per-row toggle, recorded in the audit log |
| `guard.cross-seed` | Removing one torrent's data when a second torrent shares the exact same bytes, breaking the other | Yes, and confirming expands the action to remove all matching torrents together |
| `guard.hardlink` | Overstating reclaimed space — warns (never blocks) that other hardlinks to the same bytes survive, so removing just this path frees 0 bytes | Not applicable — this guard warns, it never blocks |
| `guard.protected` | Acting on a torrent that's busy (downloading/checking/moving), tagged/categorized as protected, or whose true state can't be verified because qBittorrent or a configured \*arr instance is unreachable | **No.** This is the one guard with no override, by design |
| `guard.torrent-scope` | A file's torrent covering *more* files than the plan named (e.g. a `sample.mkv` inside a whole season pack) — deleting it with data would take files nobody reviewed | Yes — the operator is explicitly accepting that the rest of the torrent goes too |

Defaults, all editable in Settings (`config.json`'s `guards` block):

- `minRatio`: `1.0`
- `minSeedTimeDays`: `14`
- `protectedCategories` / `protectedTags`: empty (populate with your own qBittorrent categories/tags)
- `privateTrackerHosts`: empty (operator-populated; qBittorrent's own `private` flag is preferred
  when the connected version reports it, and a torrent whose privacy can't be determined is
  treated as private — fail-safe, not fail-open)

An unreachable qBittorrent, or an unreachable/incomplete Radarr or Sonarr inventory, makes
`guard.protected` block with **no override** — an empty answer from a source that can't be
verified is read as "unknown," never as "not managed," because an unmonitor call that silently
never ran is exactly how a deleted file gets re-downloaded.

## Confidence tiers — read this before trusting "exact"

Duplicate findings carry a confidence tier: `exact`, `strong`, or `possible`. **"Exact" does not
mean byte-identical.** Of the three rules that produce an `exact` link:

- `dupe.provider-id` — two items share the same TMDB/IMDB/TVDB id. Pure metadata; the underlying
  files are never compared.
- `dupe.series-episode` — two items share the same series + season + episode number. Also pure
  metadata.
- `dupe.identical-file` — two files have the same size **and** the same quick-hash. The quick-hash
  is a **sampled** hash: file size plus up to 1&nbsp;MB from the head and up to 1&nbsp;MB from the
  tail of the file, not the whole file. Two different files that happen to share a size and the
  same first/last megabyte would collide under this rule. It is opt-in per library root (hashing
  is not free at 100k+ items) and disabled roots report duplicate-by-hash as **not evaluated**,
  never as a silent zero.

None of the three "exact" matchers reads the entire file byte-for-byte. Treat `exact` as "very
likely the same," not "cryptographically proven identical," and use the side-by-side comparison
in the Duplicates screen before approving a delete.

`strong` (normalized title+year, or title+runtime within tolerance) and `possible` (fuzzy title
similarity) are progressively weaker signals built for the same reason — spend more scrutiny on
them, not less, before approving anything.

## Trash

Torrent-backed files are never trashed — qBittorrent deletes its own data directly in step 2 of
the delete pipeline above, and pre-copying a large file to a trash folder before removing it would
defeat the point of reclaiming the space.

A small trash *is* used for non-torrent junk: a file below `trash.maxBytes` (default **1 GB**)
that isn't backed by any torrent is **moved** (same-filesystem rename, not copied) into
`<library-or-download-root>/.jellymaid-trash/<plan-id>/` and purged after `trash.retentionDays`
(default **30 days**), on a nightly schedule. Both values live in `config.json` and are editable
in Settings. Restore is available from History while the entry survives.

**Trash must live on the same filesystem as the media** — this is why it's placed inside each
configured root rather than at some fixed global path. If a root spans a read-only mount, or isn't
the true root of one filesystem (e.g. two different filesystems bind-mounted under what looks like
one path), the trash move fails and the file is deleted outright instead, with the trash row
marked to say so. `.jellymaid-trash` itself is excluded from every scan phase and every rule — it
never shows up as orphan media, junk, or an empty folder, and never counts toward folder sizes in
Explorer.

A trash entry that fails to purge (permission error, read-only mount, etc.) keeps its database row
on purpose — that row is the only record the file still exists. It shows up as a purge failure in
the logs rather than being silently forgotten.

## Scanning

- **`SCAN_CRON`** (default `0 3 * * *`, evaluated in the container's `TZ`) schedules a full scan. A
  scheduled scan never starts while one is already running, and never bypasses the path-map
  verification gate.
- A scan walks Jellyfin, then the filesystem, then qBittorrent, then \*arr, then runs every rule
  over the results, in that order, with a resumable cursor per phase — a killed or crashed scan
  picks back up where it left off rather than starting over.
- **Hashing is opt-in per library root** (`hashedLibraryRoots` in `config.json`). Only
  `dupe.identical-file` needs it. A root left out of that list still gets every other rule; that
  rule alone reports **not evaluated** for it.
- **"Not evaluated" is a real, distinct state — it is never rendered as "no findings."** If
  qBittorrent or an \*arr instance is unreachable during a scan, or hashing is off for a root, the
  rules that depend on that source say so explicitly rather than silently reporting zero results.
  "No duplicates found" and "couldn't check for duplicates" are never allowed to look the same.

## Troubleshooting

- **"Path mappings resolved fewer than the full sample" / "scan refuses to start."** This is the
  verification gate described above, working as intended. Fix your `pathMappings` in Settings (or
  run Auto-detect again) until Verify reports the full sample resolved, then re-scan. This gate
  applies to the scheduled scan too, so an unattended nightly scan will simply not run — check
  `/healthz`'s `lastScan` if scans seem to have stopped.
- **"qBittorrent unreachable" blocking deletes.** This is deliberate, not a bug: `guard.protected`
  has no override, and an unreachable qBittorrent means Jellymaid cannot confirm a torrent isn't
  mid-download, cross-seeded, or otherwise unsafe to touch. Fix the qBittorrent connection; there
  is no way to force past this one.
- **Resuming an interrupted scan or plan.** A scan interrupted mid-phase (container restart,
  crash) resumes from its saved cursor on the next scan trigger. A plan interrupted mid-execution
  is left in a `running` state that only an explicit resume can clear — every action is idempotent
  and every guard is re-checked live, so resuming re-verifies everything rather than blindly
  continuing.
- **`TRUST_PROXY`.** This must equal the exact number of reverse proxies actually sitting in front
  of Jellymaid — for example `1` behind a single Cloudflare Tunnel or reverse proxy, `0` if nothing
  is in front of it (the default). Getting this wrong is dangerous in both directions:
  - **Too low** (e.g. `0` behind a real proxy) collapses every real client onto the proxy's own
    address, so the per-IP login lockout locks *every* caller out together after a handful of
    failed logins from any one of them.
  - **Too high** lets a caller forge the `X-Forwarded-For` header and pick whatever "client IP"
    Jellymaid trusts, defeating that same lockout by minting a fresh bucket on every request.
- **Session secret.** There is no `JWT_SECRET` or similar variable to configure — Jellymaid mints
  a random 32-byte session secret on first boot and persists it at `/data/.session-secret` (mode
  `0600`), so sessions already survive container restarts and image upgrades with zero
  configuration. Set the optional `SESSION_SECRET` environment variable only if you specifically
  want to force a fixed value or invalidate every session on your own schedule.

## What has NOT been verified against a live stack

Jellymaid has ~770 server tests and ~179 client tests, all passing against fixtures, in-memory
SQLite, real temporary directories (including real hardlinks), and recorded/stubbed HTTP
responses. **None of that is the same as running against a real deployment.** As of this writing:

- No real Jellyfin server has ever been contacted.
- No real qBittorrent instance has ever been contacted.
- No real Radarr or Sonarr instance has ever been contacted.
- No real scan has ever run against a real library.
- **No real delete has ever been executed.** The entire delete pipeline — guards, the five-step
  execution order, the fail-closed \*arr unmonitor, trash, sweep — is verified by tests against
  fakes and fixtures only.
- The multi-arch Docker image has not been confirmed to build and run `better-sqlite3` cleanly on
  both `linux/amd64` and `linux/arm64` outside of CI.

Do not treat any claim in this document as validated by anything stronger than test coverage
against simulated services until you've personally run the checklist below.

### First-run checklist

Run through this in order, on your own real stack, before trusting Jellymaid with anything you'd
miss if it were gone:

1. `docker compose up -d`, then `curl -fsS localhost:8099/healthz` — expect `"status":"ok"` and
   all four connector states reported (`ok` or `not-configured`, never `unreachable`).
2. Log in with a Jellyfin **administrator** account; confirm a non-admin Jellyfin account is
   refused.
3. Settings → path mapping → Auto-detect, then Verify — fix mappings until the full sample
   resolves (20 of 20, or however many items your library actually has).
4. Trigger a scan; watch it progress through phases; confirm the index counts on `/healthz` and
   the Dashboard's snapshot tables actually fill in.
5. Check Findings and Duplicates; spot-check at least three duplicate groups by hand against the
   real files before trusting the grouping.
6. **Pick one deliberately chosen, genuinely disposable file** — not something you'd miss. Queue
   it for deletion, build the plan, read the dry-run preview carefully, approve it, and execute.
7. Confirm afterward, by hand: the file is actually gone from disk; qBittorrent no longer lists
   that torrent (if one was involved); if the file was Radarr/Sonarr-managed, that entry is now
   **unmonitored and still present** in Radarr/Sonarr (not deleted, not blocklisted); the now-empty
   parent folder was swept away; and History shows the full chain of what happened.

Only after step 7 behaves exactly as documented here should you point Jellymaid at anything that
matters.
