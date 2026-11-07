# Carry-forward

Findings that were deliberately deferred along the way (Plan 1's task loop and whole-branch review
first, then each later plan), kept here because the scratch workspaces that recorded them are
gone. Each says which slice should close it. Nothing here is a known-broken behaviour today; they
are traps set for later slices. A struck-through item is closed, with the plan that closed it;
what Plan 7 (the real-stack upgrade) deliberately leaves open is under "Open after Plan 7" near
the end.

## Must be closed by a specific slice

| Item | Where | Close in |
|---|---|---|
| The walker must write **NULL** for `dev`/`inode`/`nlink` when it cannot stat a path. Writing 0/1 would collide on the correlation index and, worse, make an unstattable file look like a single-link file whose deletion reclaims its full size. | `src/fs/walker.ts` (new) | Plan 2 |
| Each scan phase must **delete rows carrying a prior `scan_id`** on completion. The index holds one live snapshot; without the sweep, a file that disappeared lingers and the filesystem rules report on ghosts. | `src/scan/phases/*` | Plan 2 |
| `HttpClient` silently discards a caller-supplied `init.signal`, so external cancellation is a structural no-op. The scan worker owns an `AbortController`, and with retries a single request can run ~2 minutes — cooperative between-chunk cancellation cannot bound that on its own. | `src/connectors/http.ts` | Plan 2 |
| ~~Land the multi-migration ordering test **with** `002_*.sql`, not after. Only one migration exists, so the "apply newer, skip applied" branch is exercised trivially.~~ **Closed in Plan 2**: `002_torrent_files_error.sql` ships with tests that upgrade a 001-era database in place and that pin the `NNN_` naming, so lexicographic order is numeric order. | `tests/index/db.test.ts` | Closed |
| `deleteItem` must not reach the delete executor untested — it is the call that removes the Jellyfin entry. Also untested: `virtualFolders`, `splitVersions`, `ping`. | `tests/connectors/jellyfin.test.ts` | Plan 4 |
| ~~`saveConfig` shallow-merges, so a nested patch must resend the whole subtree. The Settings screen patches `guards`/`trash`/`rules` subtrees and would silently reset siblings.~~ **Closed in Plan 7**: `saveConfig` merges `guards`, `trash`, `keeper`, `rateLimits` and `rules` one level deep, so patching one threshold keeps its siblings. | `src/config/load.ts` | Closed |
| `/api/pathmap/detect` accepts any `mountRoots`, including `/` — ~~one blocking `readdirSync` walk~~ of the whole filesystem to depth 4. Admin-only, so a foot-gun rather than an attack path. **Half closed in Plan 7**: the walk is asynchronous and yields to the event loop, so a huge root can no longer stall the server (the test schedules a timer and checks it fires during detect). `/` is still accepted as a root. | `src/api/pathmap.ts` | Half closed |
| There is no operator unlock for the login lockout — no endpoint, no file, no env escape. The username dimension holds for 60 minutes. | `src/auth/lockout.ts` | Plan 5 or 6 |
| Sessions cannot be revoked: a captured cookie is a valid 7-day bearer token, and a demoted admin keeps authority until it expires. The signed payload now carries `isAdministrator`, which is what later routes assert, but there is no server-side kill switch. | `src/auth/session.ts` | Plan 6 |

## Added by Plan 2 — must be closed by a specific slice

| Item | Where | Close in |
|---|---|---|
| ~~**The index-side twin of the `unmonitorByPath` three-state fix is still open.** `client.inventory()` returns a *partial* Sonarr inventory when a per-series fetch fails, and the phase then does a wholesale `DELETE FROM arr_records WHERE kind = ? AND instance = ?` and rewrites only what it got. A flaky series therefore erases its files' rows, so Plan 4 reading the INDEX (rather than calling `unmonitorByPath`) sees "no \*arr record" and reads it as not-managed — the delete proceeds without unmonitoring and the \*arr re-downloads. `load()` already computes a `complete` flag; it just is not plumbed out through `inventory()`.~~ **Closed in Plan 3**: `inventory()` now returns `{ records, complete }` for both connectors; `arrPhase` only wipes an instance's rows when its fetch was complete, upserting-only on a partial one, and counts `partial` instances in a visible reason. | `src/connectors/arr.ts`, `src/scan/phases/arr.ts:33` | Closed |
| **Plan 4's document still shows the old `{ unmonitored, recordId }` return shape** at two places; the connector now returns `{ outcome: 'unmonitored' \| 'not-managed' \| 'lookup-failed'; recordId }`. If Plan 4's test doubles are cast, the mismatch compiles silently and `outcome` reads `undefined` — which fails closed, so the risk is a confusing skip rather than a wrong delete. | `docs/…-4-actions.md` | Plan 4, first task |
| **A fourth unmonitor failure path exists**: the unmonitor `PUT` itself throwing. That is fail-closed only if the executor wraps the call. State it in Plan 4's contract. | `src/connectors/arr.ts` | Plan 4 |
| ~~**Jellyfin's sweep licence is measured by resume-inclusive `startIndex`, not rows written.** If items are removed from Jellyfin *below* the cursor offset between a cancel and a resume, the shifted-down items are observed by neither attempt, `startIndex >= total` still holds, and their rows are swept. Cheap fix: persist `total` in the cursor and refuse the sweep when the current `total` is lower than the recorded one. (The same paging skew exists within a single uninterrupted pass, so this is a tightening, not a regression.)~~ **Closed in Plan 3**: the cursor now also persists `total`; a resume whose current `totalRecordCount` is lower than the recorded one skips the sweep with a reason, rather than trusting a stale offset. | `src/scan/phases/jellyfin.ts` | Closed |
| **`quick_hash IS NULL` conflates three states** — hashing off for the root, unstattable, and hash threw. SQLite's `GROUP BY` treats NULLs as *equal*, so a naive `dupe.identical-file` grouping would cluster every unhashed same-size file as an exact duplicate. Filter on `quick_hash IS NOT NULL` explicitly. | `src/rules/dupes/` | **Plan 3** |
| A synchronous throw from `new Worker(...)` leaves the just-inserted `scans` row at `running` with no worker; healed only by the boot reconcile. | `src/scan/runner.ts` | Plan 6 |
| `/healthz` still reports only Jellyfin though four connectors now exist. | `src/api/health.ts` | Plan 6 (already in its Task 1) |

## Added by Plan 3 — must be closed by a specific slice

| Item | Where | Close in |
|---|---|---|
| **Merge Versions changes what a delete means.** After a merge, Jellyfin returns ONE item and the alternate file's path lives only in `jellyfin_item_paths`. Deleting a non-keeper of a MERGED item removes a file the surviving item still references, so the executor must trigger a Jellyfin refresh for that item rather than a `DELETE /Items/{id}` — deleting the item would remove the version the operator kept. **Superseded in Plan 7**: the executor no longer deletes Jellyfin items or refreshes the library at all; every deleted path, a merged item's alternate file included, is reported once with `POST /Library/Media/Updated`. Whether Jellyfin then drops just that alternate version and keeps the one that survives has not been exercised (see "Open after Plan 7"). | `src/plan/executor.ts` | Superseded |
| **`unmonitorByPath` returns three states now** (`unmonitored` / `not-managed` / `lookup-failed`) and the plan document still shows the old two-field shape. `lookup-failed` must be treated as fail-closed: skip the delete. A fourth path exists — the unmonitor `PUT` itself throwing — which is only fail-closed if the executor wraps the call. | `docs/…-4-actions.md`, `src/plan/executor.ts` | **Plan 4, first task** |
| The dupe-matcher memoization is keyed by `scanId` alone, so a reused id in one process would let `subRuns()` read a stale outcome map. Not reachable in production (ids autoincrement, one worker at a time) but the test suite already depends on incidental ordering to avoid it. Key it on something call-scoped before the pattern is reused. | `src/rules/dupes/adapter.ts` | Plan 4 or 5 |
| If the two retained scans both fail before reaching the rules phase, the last successful scan's row is pruned and the summary's `evaluated` flips false while `findings` still holds real open rows. Narrow, currently unreachable. | `src/scan/orchestrator.ts`, `src/api/findings.ts` | Plan 6 |
| `fuzzy-title`'s first-letter bucketing has no size bound and rebuilds trigram sets per comparison; a movie-heavy library with a skewed letter bucket could take minutes. Needs a size guard or timeout before running against a large library. | `src/rules/dupes/index.ts` | Plan 6 |

## Added by Plan 4 — must be closed by a specific slice

| Item | Where | Close in |
|---|---|---|
| ~~**`dryRun.directoriesSwept` is typed required but old rows read `undefined`.** `getPlan` and `GET /api/plans` parse `dry_run_json` with no schema, so a plan persisted before that field existed yields `undefined` behind a `number` type. It does not throw — it surfaces in the UI as "undefined directories will be removed". Make it optional or default it at parse time.~~ **Closed in Plan 7**: the plan contract types it `directoriesSwept?: number`, which is what an older row actually holds. | `src/plan/planner.ts`, `src/api/plans.ts` | Closed |
| ~~**A rejected override fails the whole plan build with 400.** A UI that resubmits a previously built action list with its overrides attached gets a hard 400 for every action if live state moved (the torrent crossed its ratio, so `guard.private-ratio` no longer blocks) rather than dropping the now-pointless override. Correct per the ruling, but the UI must handle it — either strip overrides on resubmit or surface which one was unearned.~~ **Closed in Plan 7**: an override for a guard that no longer blocks is dropped and listed in `droppedOverrides` on the plan, never a 400; the Plan screen shows what was dropped. | `src/api/plans.ts` | Closed |
| **The `arrUnmappable` block is invisible until an operator builds a plan.** It blocks every delete, non-overridably, and Radarr reports the movie *folder* for a filmless movie — so one decommissioned root folder wedges the whole install with a message only reachable by trying. Surface the unmapped count on the health page. | `src/api/health.ts` | **Plan 6, before ship** |
| Siblings are unmonitored before it is known the delete will happen. If a later sibling fails to confirm, the earlier ones are already `monitored: false` with their files intact — the conservative state, but an unrequested \*arr mutation, and `detail` names only the FAILING sibling so the audit cannot tell an operator which titles to re-monitor. Carry the confirmed list in `detail`. | `src/plan/executor.ts` | Plan 6 |
| `/resume`'s staleness window only covers the first five minutes: `started_at` is written once and never refreshed, so a legitimately long run elsewhere is resumable and would double-execute its tail. A heartbeat would close it. | `src/api/plans.ts` | Plan 6 |
| With `guard.torrent-scope` overridden, **out-of-plan** torrent files are still deleted with no unmonitor. The in-plan siblings are covered; an override deliberately accepts the rest. Worth an explicit warning in the override UI. | `src/plan/executor.ts` | Plan 5 (warning) / Plan 6 |
| The plans API suite builds an executor stub that always succeeds, so it proves nothing about execution semantics. Fine today because the routes check the DB themselves — remember it when the UI is wired to these routes. | `tests/api/plans.test.ts` | Plan 5 |

## Known limits, accepted

- **Hop-count over-counting reinstates the vulnerability it closes.** `TRUST_PROXY` set higher than the real number of proxies makes Fastify trust a caller-supplied `X-Forwarded-For` token again. Documented in `parseHopCount` and the compose file; unguardable in code, since only the operator knows the topology.
- **The IP lockout dimension is skipped for private and loopback addresses.** Such an address is either a LAN client (the username dimension still applies) or a reverse proxy collapsing every client into one address, where an IP lock would be a self-inflicted denial of service. Deliberate.
- **`/healthz` can report `ok` for up to 5 seconds after Jellyfin dies** — the ping is cached so unauthenticated probes cannot spend the scanner's rate-limit budget.
- **`resolveRootReal` memoizes a failed root resolution** for the life of a `PathMap`. Fail-closed, and PathMaps are short-lived today; revisit if the delete executor holds one across a long plan. **That condition is now met (Plan 7)** — see "Open after Plan 7".
- **`autoDetectMappings`'s test double re-implements `walkDirs`** and will drift silently if the production skip rules change.
- **A single-flight on the username key only** means a burst of *different* usernames from one IP can overshoot the IP counter before it locks.
- Cosmetic: `/api/pathmap/detect`'s 400 returns a static string where `PUT` returns parsed issues; the `try` around `readFileSync`+`JSON.parse` reports an EACCES as "not valid JSON"; `src/fs/pathmap.ts` boundary-checks with `'/'` in one place and `path.sep` in another; a migration named `01_x.sql` would collide with `001_init.sql`; ~~`src/index.ts` has no SIGTERM handler and never closes the database~~ (**closed in Plan 7**: SIGTERM and SIGINT stop taking work, cancel a running scan, let a running plan finish its current action, then close the database).
- **No login is logged.** Successful logins, failures and lockout trips leave no record anywhere — Fastify's own logger is off so request bodies never reach stdout, but that also means no audit trail on the security boundary.

## Added by the Plan 5 UI review fix wave — known limits, accepted

`/api/duplicates` now exposes `matchedBy` and the raw `video_range`/`has_subtitles` facts behind
each member's keeper score (`src/api/findings.ts`), so the Duplicates screen can show WHICH
matcher(s) agreed on a group and corroborate the HDR/subtitles weights with something other than a
bare number. Two real limits remain underneath those facts, not fixable by a route change:

- **Subtitle and audio facts are coarser than what they corroborate.** `hasSubtitles` collapses
  subtitle count and language down to a single boolean at ingest (`src/connectors/jellyfin.ts:123`,
  `streams.some((s) => s.Type === 'Subtitle')`) — two members that both report `has_subtitles: 1`
  are not necessarily equally well-subtitled (one English track vs. five languages read the same).
  Worse, only the FIRST audio stream of a media source survives normalization at all
  (`jellyfin.ts:79` picks `streams.find((s) => s.Type === 'Audio')`, and `audioChannels` at
  `jellyfin.ts:118` is read from that one stream) — a file with a 2.0 commentary track listed before
  its 7.1 main track would report `audioChannels: 2`. Closing this needs a re-scan plus a schema
  change (a subtitle count/language column, a real audio-streams table), not a route change — it is
  an ingest-time information loss the API cannot recover after the fact.
- **`isHdr` cannot distinguish "confirmed SDR" from "Jellyfin never said."** `src/rules/keeper.ts`'s
  `hdr: isHdr ? w.hdr : 0` scores both identically at `0`: a genuinely SDR copy and a copy whose
  `video_range` is simply `null` (an older Jellyfin, or a library scan that predates the column)
  collect the same absence of bonus. Exposing the raw `video_range` per member (rather than only the
  derived boolean) lets an operator tell the two apart by eye on the Duplicates screen, but the
  SCORE itself still cannot — `isHdrRange` (`src/rules/dupes/adapter.ts`) folds `null` and `'SDR'`
  into the same `false`, by design (an absent signal must contribute nothing, not a guessed bonus),
  so a three-state score (confirmed-SDR / confirmed-HDR / unknown) would be a `keeper.ts` change,
  not a display one.

## Fixed during Plan 1 — do not reintroduce

Each of these was found by review, has a regression test, and has a comment at the site explaining
why the obvious simplification is wrong:

- `findingId` joins with NUL, not spaces. A space-joined key makes `['x', 'y z']` and `['x y', 'z']` hash identically, so dismissing one finding would silently dismiss another.
- The rate-limit gate reserves its start slot **synchronously**, before any await. Computing the wait and writing it back afterwards let every concurrent caller read the same stale value and start in the same tick.
- `isWithinRoot` resolves symlinks and **fails closed** on a dangling symlink, EACCES or ELOOP. `resolve()` alone is lexical, and a symlink planted inside a root escapes it — this is the guard the delete sweep depends on.
- Login attempts are **serialised per username**. Without it, 50 concurrent logins produced 50 real password guesses and zero lockouts.
- `trustProxy` is a **hop count, not a boolean**. `true` makes Fastify take the leftmost, caller-supplied `X-Forwarded-For` token, which handed the lockout key to the attacker.
- Only `kind === 'auth'` consumes a lockout attempt. Anything else — including an unclassifiable error — returns 503, or an outage locks the operator out of their own tool.
- POST is **not retried** by default. A timeout is not evidence the request did not land, and the executor later issues `torrents/delete?deleteFiles=true` down this path.
- A `Season` row's number lives in `IndexNumber`, not `ParentIndexNumber`.

## Open after Plan 6 — nothing here blocks ship, all are documented in the README

- **`arrUnmappable` is a count on `/healthz`, not an explanation.** `evaluated`/`count` is exposed
  deliberately without paths, because `/healthz` is unauthenticated. The operator still learns
  *which* root folder is unmappable only by building a plan and reading the failure. Surfacing the
  offending root behind the authenticated API is the follow-up.
- ~~**Config is boot-time only.** `loadConfig` runs once at `src/index.ts`, and `config.file` is
  captured by `pathMap`, the executor, `plannerDeps`, `trashDeps`, both schedulers, and
  qBittorrent's `privateTrackerHosts`. Hand-editing `/data/config.json` needs a container restart —
  and until that restart, an added private-tracker host **fails open**. A saved `pathMappings`
  change reaches the scan worker (which reloads) but not the executor's live sweep boundary.~~
  **Closed in Plan 7**: a `ConfigStore` re-reads `config.json` whenever it changes, and the
  planner, executor, Explorer, health, duplicates and settings routes ask it instead of holding a
  copy; one plan run uses one snapshot; a broken edit throws until fixed rather than reverting to
  the last good copy. Still read only at start: the environment, `scanCron`, and the `rateLimits`
  of the connectors that plan builds and runs use (a scan re-reads its own).
- **`%2e%2e/`-style traversal returns 500, not 404.** `@fastify/static` throws `Forbidden` and the
  generic error handler widens it. Pre-existing on both the 8.x and 10.x versions; no content leaks,
  it is the status code that is wrong.
- ~~**No SIGTERM handler.** Shipping a container makes SIGTERM the normal stop path for a process that
  deletes files mid-plan.~~ **Closed in Plan 7**: SIGTERM and SIGINT now stop taking work, cancel a
  running scan, let a running plan finish its current action, and close the database (compose runs
  Jellymaid under `init: true` so the signal arrives). **Still open from this item:** the recovery
  path (History → Resume) exists, but the Plan screen does not mention it, and a plan stuck in
  `running` shows no controls there.
- **No session revocation**, and the `/resume` staleness check is still the 5-minute age heuristic
  documented at `src/api/plans.ts` rather than a real heartbeat.
- **The hash-evaluated flag is global, not per-root.** With one library root hashed and another not,
  the unhashed root contributes a silent zero to duplicate counts. Documented in the README.

## Open after Plan 7 — nothing here blocks the dupe flow

Plan 7 made the dupe flow work end to end on the real software (the README's "Verified against"
says exactly what was checked). It deliberately did **not** do the following; each is written down
here rather than built.

### Production dependency advisories left open on purpose

`npm audit --omit=dev` on 2026-10-31: server 7 findings (4 high, 3 moderate), client 0. The
non-breaking fixes are applied (`brace-expansion` 5.0.8 → 5.0.12; `fast-uri` 3.1.4 → 3.1.9 and
4.1.1 → 4.2.3, both copies in the tree), which leaves 5 (2 high, 3 moderate). Each of those needs a
breaking change, for these reasons — all checked, not assumed:

| Package | Advisory | Why it is not upgraded | Reachable here? | Closes when |
|---|---|---|---|---|
| `fastify` 5.10.0 (high) | Seven advisories, fixed in 5.12.1 through 5.12.5. The one that bears on this app is GHSA-3m5p-2c4r-xxw2: `X-Forwarded-*` spoofing under a numeric `trustProxy`. | **Every fixed release removes the numeric `trustProxy` form at runtime** (and from its types), and `TRUST_PROXY` is exactly that hop count, handed straight to Fastify in `src/server.ts`. Checked by installing 5.12.7: `tests/server/trust-proxy.test.ts` fails 2 of 3, and `req.ip` becomes the proxy's own address — behind a proxy every client would share one lockout bucket. | The `trustProxy` one only with `TRUST_PROXY` of 1 or more and port 8099 reachable around the proxy (the default is 0). The other six need route schemas (there are none), HTTP/2 (not used) or a plugin-scoped not-found handler serving protected data (the only not-found handler is the root-level SPA fallback). | `TRUST_PROXY` stops being a hop count and becomes the proxies' own addresses (an IP or CIDR list, a form Fastify still honours), `secureCookie` and the lockout tests are rewritten around real addresses, and Fastify moves to 5.12.5 or later. |
| `zod` 3.25.76 (high) | GHSA-mrhx-c7xc-m3w5: memory exhaustion validating a very large array. Fixed only in 4.6.6 and later. | **Zod 4 changes `.default({})`**: the default is returned as written instead of being parsed through the inner schema. Checked on 4.6.7: a config with no `guards` block parses to `{}`, so `minRatio` and `minSeedTimeDays` are `undefined`, `ratio < undefined` is false, and **`guard.private-ratio` would never block**. A mechanical bump fails open on exactly the setting that protects private-tracker accounts. | Arrays are validated only in authenticated administrator requests (Fastify's default 1 MiB body limit) and in `config.json`. | Every nested `.default({})` in `src/config/schema.ts` becomes `.prefault({})`, then the bump. `tests/config/load.test.ts` already pins the defaults of an empty config (three of its tests fail on 4.6.7), so a mechanical bump cannot slip through CI. |
| `@fastify/static` 10.1.2, through `glob` 13.0.6 and `minimatch` 10.2.6 (moderate) | GHSA-3g3m-2fjr-6pw4 (glob: post-timeout traversal) and a minimatch pattern-amplification denial of service. | **No fix inside range.** The latest `@fastify/static` (10.1.8) still depends on `glob ^13`, and the "fix" `npm audit` offers is a downgrade to `@fastify/static` 6.12.0, a different major with different options. | No. `glob()` is only called in `@fastify/static`'s `wildcard: false` branch, with the fixed pattern `**/**`; Jellymaid registers it with the default `wildcard: true`. | `@fastify/static` ships on a `glob` release past 14.0.1. |

### Other open items

- **The real-stack read-only scan is pending.** This build has not yet scanned the owner's Jellyfin
  and qBittorrent instances, and the first-run checklist (one disposable item) has not been run.
  Everything in the README's "Verified against" comes from the local harness.
- **The harness cannot exercise some of what the design promises.** It runs identity path mappings
  on local disks, so per-instance translation (two boxes both saying `/movies`) rests on tests over
  real temporary directories; it runs no Radarr or Sonarr, no merged Jellyfin versions, and no NFS,
  where a deletion may be seen late (the executor's 30-second wait for a file to disappear is a
  design figure, not a measurement from the real mounts).
- **Merged versions and the path notification.** Merge and split are unchanged, but with no item
  delete and no library refresh left, removing one version of a merged item relies on
  `POST /Library/Media/Updated` dropping just that version and keeping the other. Not exercised.
- **A `PathMap` now lives as long as its mapping set.** `ConfigStore` hands out one `PathMap` per
  mapping set for the life of the process, and `createPathMap` caches a root's resolution
  (`rootRealCache`) for the life of that map. Fixed in the final fix wave (final review m4): only a
  root that resolved is cached. A failed resolution (an unmounted share, ESTALE, EACCES) fails that
  one call closed and is tried again on the next, so a share that comes back is seen without a
  restart. A cached success is still kept: a root repointed behind Jellymaid's back (its symlink
  retargeted) is not noticed until the mappings are edited or the container restarts.
- **`docker stop` grace period.** The compose file sets `stop_grace_period: 2m` (Docker's default
  is 10 s): one action may wait up to 60 s for qBittorrent to let a torrent go and up to 30 s more
  for its asynchronous delete to show on disk. A plan whose current action outlasts even that is
  killed and left `running` (resumable from History). Revisit once the worst action time is
  measured on real mounts.
- **The CI smoke gate has not run on GitHub yet.** It starts the image on the runner's own
  architecture (amd64) only: the arm64 image is built and never started. The step's script was
  checked against a stub `docker` and the real server booted with the same dummy environment, not
  inside Docker (none was available).
- **`engines.node` is wrong.** `package.json` declares `>=20.11`, but the production tree needs
  Node 22: `@fastify/cookie` depends on `cookie@2`, which declares `node >= 22` (npm prints
  `EBADENGINE` on Node 20). CI and the image run Node 22 and local runs on 20 work, so nothing
  breaks; the declared floor is simply untrue.
- **The keeper policy applies from the next scan.** Changing it in Settings does not re-pick the
  keepers of groups that already exist (recomputing on read was rejected to avoid a signature
  shared across lanes).
- **An oversized "sample" counts as media in `guard.torrent-scope`.** A companion that is itself a
  media file only counts as a companion while it is under a tenth of the torrent's largest media
  file, so a real film named "Sample City" is never swept away as a sidecar; the price is that a
  genuinely large sample needs an override.
- **The suites leave their temp directories behind.** Test files create `mkdtemp` directories and
  never remove them: about 180 MB per full server run (roughly 16,800 directories, 5 GB, had piled
  up in `/tmp` on the build machine, which filled a shared disk and made unrelated tests fail with
  `ENOSPC`). Point `TMPDIR` somewhere disposable, or add cleanup.
- **Non-goals, unchanged:** hardlink layouts and Radarr/Sonarr improvements (the owner uses
  neither), renaming, transcoding or moving files, session revocation and a login audit trail,
  and Explorer and Findings polish beyond the fixes Plan 7 made.

## Verification status

Verified on a local harness of real binaries on 2026-10-31: Jellyfin 12.1.0 with qBittorrent 5.2.2
and 5.1.2 as two instances. **Not yet verified against a real stack:** the read-only scan of the
owner's deployment is pending, and the README's first-run checklist — which starts with one
deliberately disposable item — is the real acceptance test the owner has to run. No real Radarr or
Sonarr instance has ever been contacted; their paths are verified against fakes and fixtures only.
The Docker image has still never been built or started in the build sandbox (no Docker there); the
publish workflow now builds it and starts it (amd64) before pushing anything, and confirming that
workflow's first green run is part of shipping. See the README's "Verified against" section for
exactly what the harness settled.
