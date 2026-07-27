# Carry-forward from Plan 1

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

## Known limits, accepted

- **Hop-count over-counting reinstates the vulnerability it closes.** `TRUST_PROXY` set higher than the real number of proxies makes Fastify trust a caller-supplied `X-Forwarded-For` token again. Documented in `parseHopCount` and the compose file; unguardable in code, since only the operator knows the topology.
- **The IP lockout dimension is skipped for private and loopback addresses.** Such an address is either a LAN client (the username dimension still applies) or a reverse proxy collapsing every client into one address, where an IP lock would be a self-inflicted denial of service. Deliberate.
- **`/healthz` can report `ok` for up to 5 seconds after Jellyfin dies** — the ping is cached so unauthenticated probes cannot spend the scanner's rate-limit budget.
- **`resolveRootReal` memoizes a failed root resolution** for the life of a `PathMap`. Fail-closed, and PathMaps are short-lived today; revisit if the delete executor holds one across a long plan.
- **`autoDetectMappings`'s test double re-implements `walkDirs`** and will drift silently if the production skip rules change.
- **A single-flight on the username key only** means a burst of *different* usernames from one IP can overshoot the IP counter before it locks.
- Cosmetic: `/api/pathmap/detect`'s 400 returns a static string where `PUT` returns parsed issues; the `try` around `readFileSync`+`JSON.parse` reports an EACCES as "not valid JSON"; `src/fs/pathmap.ts` boundary-checks with `'/'` in one place and `path.sep` in another; a migration named `01_x.sql` would collide with `001_init.sql`; `src/index.ts` has no SIGTERM handler and never closes the database.
- **No login is logged.** Successful logins, failures and lockout trips leave no record anywhere — Fastify's own logger is off so request bodies never reach stdout, but that also means no audit trail on the security boundary.

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
