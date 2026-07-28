# Carry-forward from Plans 1–2

Findings that were deliberately deferred during Plan 1's task loop and its whole-branch review,
kept here because the scratch workspace that recorded them is gone. Each says which slice should
close it. Nothing here is a known-broken behaviour today; they are traps set for later slices.

## Must be closed by a specific slice

| Item | Where | Close in |
|---|---|---|
| The walker must write **NULL** for `dev`/`inode`/`nlink` when it cannot stat a path. Writing 0/1 would collide on the correlation index and, worse, make an unstattable file look like a single-link file whose deletion reclaims its full size. | `src/fs/walker.ts` (new) | Plan 2 |
| Each scan phase must **delete rows carrying a prior `scan_id`** on completion. The index holds one live snapshot; without the sweep, a file that disappeared lingers and the filesystem rules report on ghosts. | `src/scan/phases/*` | Plan 2 |
| `HttpClient` silently discards a caller-supplied `init.signal`, so external cancellation is a structural no-op. The scan worker owns an `AbortController`, and with retries a single request can run ~2 minutes — cooperative between-chunk cancellation cannot bound that on its own. | `src/connectors/http.ts` | Plan 2 |
| ~~Land the multi-migration ordering test **with** `002_*.sql`, not after. Only one migration exists, so the "apply newer, skip applied" branch is exercised trivially.~~ **Closed in Plan 2**: `002_torrent_files_error.sql` ships with tests that upgrade a 001-era database in place and that pin the `NNN_` naming, so lexicographic order is numeric order. | `tests/index/db.test.ts` | Closed |
| `deleteItem` must not reach the delete executor untested — it is the call that removes the Jellyfin entry. Also untested: `virtualFolders`, `splitVersions`, `ping`. | `tests/connectors/jellyfin.test.ts` | Plan 4 |
| `saveConfig` shallow-merges, so a nested patch must resend the whole subtree. The Settings screen patches `guards`/`trash`/`rules` subtrees and would silently reset siblings. | `src/config/load.ts` | Plan 5 |
| `/api/pathmap/detect` accepts any `mountRoots`, including `/` — one blocking `readdirSync` walk of the whole filesystem to depth 4. Admin-only, so a foot-gun rather than an attack path. | `src/api/pathmap.ts` | Plan 2 (when that route is next touched) |
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
| **Merge Versions changes what a delete means.** After a merge, Jellyfin returns ONE item and the alternate file's path lives only in `jellyfin_item_paths`. Deleting a non-keeper of a MERGED item removes a file the surviving item still references, so the executor must trigger a Jellyfin refresh for that item rather than a `DELETE /Items/{id}` — deleting the item would remove the version the operator kept. | `src/plan/executor.ts` | **Plan 4** |
| **`unmonitorByPath` returns three states now** (`unmonitored` / `not-managed` / `lookup-failed`) and the plan document still shows the old two-field shape. `lookup-failed` must be treated as fail-closed: skip the delete. A fourth path exists — the unmonitor `PUT` itself throwing — which is only fail-closed if the executor wraps the call. | `docs/…-4-actions.md`, `src/plan/executor.ts` | **Plan 4, first task** |
| The dupe-matcher memoization is keyed by `scanId` alone, so a reused id in one process would let `subRuns()` read a stale outcome map. Not reachable in production (ids autoincrement, one worker at a time) but the test suite already depends on incidental ordering to avoid it. Key it on something call-scoped before the pattern is reused. | `src/rules/dupes/adapter.ts` | Plan 4 or 5 |
| If the two retained scans both fail before reaching the rules phase, the last successful scan's row is pruned and the summary's `evaluated` flips false while `findings` still holds real open rows. Narrow, currently unreachable. | `src/scan/orchestrator.ts`, `src/api/findings.ts` | Plan 6 |
| `fuzzy-title`'s first-letter bucketing has no size bound and rebuilds trigram sets per comparison; a movie-heavy library with a skewed letter bucket could take minutes. Needs a size guard or timeout before running against a large library. | `src/rules/dupes/index.ts` | Plan 6 |

## Added by Plan 4 — must be closed by a specific slice

| Item | Where | Close in |
|---|---|---|
| **`dryRun.directoriesSwept` is typed required but old rows read `undefined`.** `getPlan` and `GET /api/plans` parse `dry_run_json` with no schema, so a plan persisted before that field existed yields `undefined` behind a `number` type. It does not throw — it surfaces in the UI as "undefined directories will be removed". Make it optional or default it at parse time. | `src/plan/planner.ts`, `src/api/plans.ts` | **Plan 5, before the Plan screen** |
| **A rejected override fails the whole plan build with 400.** A UI that resubmits a previously built action list with its overrides attached gets a hard 400 for every action if live state moved (the torrent crossed its ratio, so `guard.private-ratio` no longer blocks) rather than dropping the now-pointless override. Correct per the ruling, but the UI must handle it — either strip overrides on resubmit or surface which one was unearned. | `src/api/plans.ts` | **Plan 5** |
| **The `arrUnmappable` block is invisible until an operator builds a plan.** It blocks every delete, non-overridably, and Radarr reports the movie *folder* for a filmless movie — so one decommissioned root folder wedges the whole install with a message only reachable by trying. Surface the unmapped count on the health page. | `src/api/health.ts` | **Plan 6, before ship** |
| Siblings are unmonitored before it is known the delete will happen. If a later sibling fails to confirm, the earlier ones are already `monitored: false` with their files intact — the conservative state, but an unrequested \*arr mutation, and `detail` names only the FAILING sibling so the audit cannot tell an operator which titles to re-monitor. Carry the confirmed list in `detail`. | `src/plan/executor.ts` | Plan 6 |
| `/resume`'s staleness window only covers the first five minutes: `started_at` is written once and never refreshed, so a legitimately long run elsewhere is resumable and would double-execute its tail. A heartbeat would close it. | `src/api/plans.ts` | Plan 6 |
| With `guard.torrent-scope` overridden, **out-of-plan** torrent files are still deleted with no unmonitor. The in-plan siblings are covered; an override deliberately accepts the rest. Worth an explicit warning in the override UI. | `src/plan/executor.ts` | Plan 5 (warning) / Plan 6 |
| The plans API suite builds an executor stub that always succeeds, so it proves nothing about execution semantics. Fine today because the routes check the DB themselves — remember it when the UI is wired to these routes. | `tests/api/plans.test.ts` | Plan 5 |

## Known limits, accepted

- **Hop-count over-counting reinstates the vulnerability it closes.** `TRUST_PROXY` set higher than the real number of proxies makes Fastify trust a caller-supplied `X-Forwarded-For` token again. Documented in `parseHopCount` and the compose file; unguardable in code, since only the operator knows the topology.
- **The IP lockout dimension is skipped for private and loopback addresses.** Such an address is either a LAN client (the username dimension still applies) or a reverse proxy collapsing every client into one address, where an IP lock would be a self-inflicted denial of service. Deliberate.
- **`/healthz` can report `ok` for up to 5 seconds after Jellyfin dies** — the ping is cached so unauthenticated probes cannot spend the scanner's rate-limit budget.
- **`resolveRootReal` memoizes a failed root resolution** for the life of a `PathMap`. Fail-closed, and PathMaps are short-lived today; revisit if the delete executor holds one across a long plan.
- **`autoDetectMappings`'s test double re-implements `walkDirs`** and will drift silently if the production skip rules change.
- **A single-flight on the username key only** means a burst of *different* usernames from one IP can overshoot the IP counter before it locks.
- Cosmetic: `/api/pathmap/detect`'s 400 returns a static string where `PUT` returns parsed issues; the `try` around `readFileSync`+`JSON.parse` reports an EACCES as "not valid JSON"; `src/fs/pathmap.ts` boundary-checks with `'/'` in one place and `path.sep` in another; a migration named `01_x.sql` would collide with `001_init.sql`; `src/index.ts` has no SIGTERM handler and never closes the database.
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
