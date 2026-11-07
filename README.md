# Jellymaid

Jellymaid audits a [Jellyfin](https://jellyfin.org/) media library for duplicates and filesystem
rot, then — once an operator has reviewed and approved a plan — **permanently deletes media files
and removes their torrents with data** from the qBittorrent instance that owns them. It works with
one qBittorrent or several (a library fed by two download boxes, say), coordinates with
Radarr/Sonarr so a delete doesn't trigger an immediate silent re-download, and it never touches a
private-tracker torrent that hasn't met a configurable ratio **and** seed-time floor.

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
- **Never asks Jellyfin to delete anything.** Jellyfin's own item delete removes an item's whole
  containing folder when its files still exist, so Jellymaid has no such call and no library
  refresh either. Jellyfin forgets a deleted item because Jellymaid tells it which paths are gone
  (see [How Jellyfin forgets a deleted item](#how-jellyfin-forgets-a-deleted-item)).
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
    init: true
    user: "${PUID:-99}:${PGID:-100}"
    ports:
      - "8099:8099"
    environment:
      JELLYFIN_URL: "http://192.0.2.10:8096"
      JELLYFIN_API_KEY: "${JELLYFIN_API_KEY}"
      QBIT_INSTANCES: "box-a=http://198.51.100.10:8080,box-b=http://198.51.100.11:8080"
      # Only for an instance that asks for a login — see "qBittorrent instances" below.
      QBIT_BOX_A_USER: "${QBIT_BOX_A_USER:-}"
      QBIT_BOX_A_PASS: "${QBIT_BOX_A_PASS:-}"
      QBIT_BOX_B_USER: "${QBIT_BOX_B_USER:-}"
      QBIT_BOX_B_PASS: "${QBIT_BOX_B_PASS:-}"
      TZ: "UTC"
      TRUST_PROXY: "0"
    volumes:
      - /path/to/appdata/jellymaid:/data
      - /path/to/media:/mnt/media
      - /path/to/downloads:/mnt/downloads
```

A ready-to-edit copy lives at [`docker-compose.yml`](docker-compose.yml), with an
[`.env.example`](.env.example) for the secrets it references. It is written for Unraid's Compose
Manager but is plain Compose. Replace every `192.0.2.x` and `198.51.100.x` address and every
`/path/to/...` mount with your own — those are placeholders (RFC 5737 example addresses), never
real hosts. The shipped file also carries a commented-out optional block for Radarr and Sonarr;
the quick start needs neither.

- **`/data` is a required bind mount.** The SQLite index, `config.json`, the audit log and the
  trash manifest all live there. Losing it loses your scan history, plan history and settings (not
  your media — nothing under `/data` is media).
- **Media and download mounts are read-write, not read-only.** Jellymaid removes empty folders and
  leftover hardlinks directly on disk — no Jellyfin or qBittorrent API can do that — and its trash
  folder for small non-torrent files lives *inside* each of these mounts (see [Trash](#trash)
  below), which only works if the mount is writable and is the true root of one filesystem. With
  several qBittorrent instances, every directory any of them reports files under must be visible
  inside the container: add one mount per box and root, then describe each in
  [Path mapping](#path-mapping).
- **`PUID`/`PGID`** (via Compose's `user:` field) control which uid:gid the container runs as.
  They default to **99:100**, Unraid's `nobody:users`, which owns its shares — so on Unraid no
  override is needed; anywhere else, match them to whoever owns your media on the host, or
  Jellymaid will create root-owned trash and replacement files in a library your own account owns.
  The `/data` directory must exist and be `chown`-ed to that same uid:gid *before* the first
  start — Docker creates a missing bind-mount directory as root, and a non-root container can't
  then write to it.
- **`init: true`** puts Docker's own init in front of Jellymaid, so the SIGTERM from `docker stop`
  reaches it and it can shut down gracefully (see
  [Troubleshooting](#troubleshooting)).
- **Required environment variables:** `JELLYFIN_URL`, `JELLYFIN_API_KEY`, and `QBIT_INSTANCES`
  (the qBittorrent instances; a single one can instead be given as `QBIT_URL`, see
  [qBittorrent instances](#qbittorrent-instances)). The container refuses to start if any of
  these is missing. `RADARR_URL` + `RADARR_API_KEY` and `SONARR_URL` + `SONARR_API_KEY` are
  optional, but each pair is all-or-nothing — setting one half without the other is also a startup
  failure, so the mistake is loud rather than silently ignored.
- **First login must be a Jellyfin administrator account.** Login is `POST /Users/AuthenticateByName`
  against your Jellyfin server; Jellymaid then confirms `Policy.IsAdministrator` and immediately
  revokes that Jellyfin token, replacing it with its own signed session cookie. A non-admin
  Jellyfin account is refused outright — this app deletes things, so there are no lesser roles.
  Before it forwards a password, Jellymaid reads that account's failed-login counter
  (`InvalidLoginAttemptCount`) and its limit (`LoginAttemptsBeforeLockout`; Jellyfin treats 0 as 3
  and -1 as never) and, if one more failure would make Jellyfin disable the account, refuses with
  the same "wrong username or password" answer instead — so a mistyped password cannot lock your
  Jellyfin administrator out of Jellyfin itself. The catch: while the account sits one failure from
  that lockout, **even the correct password** gets that same answer (Jellymaid's log says why:
  `login refused: one more failed attempt would disable the Jellyfin account`), and it keeps getting
  it, because Jellyfin resets its counter only when a login succeeds on Jellyfin itself (or an
  administrator resets it). The fix is to **sign in to Jellyfin once**, in Jellyfin's own web UI,
  with the right password, then log in to Jellymaid again. Each refused try still counts towards
  Jellymaid's own lockout below, so three of them also start its one-hour username lock (held in
  memory: restarting Jellymaid clears it). Three failed logins in five minutes locks that
  username (compared without regard to case) for an hour. A separate, shorter lockout
  applies per public IP address too — three failures in five minutes locks that address for
  **15 minutes**, not the same hour the username dimension uses — because an IP can be shared
  infrastructure rather than one attacker, so a false-positive lock recovers faster (private and
  loopback addresses are exempt from this dimension entirely, since a proxy in front of Jellymaid
  can otherwise collapse every real client onto one address — see
  [`TRUST_PROXY`](#troubleshooting) below).

## qBittorrent instances

Every qBittorrent that holds your library's torrents is one **instance**, named in `QBIT_INSTANCES`
as comma-separated `id=url` pairs:

```
QBIT_INSTANCES=box-a=http://198.51.100.10:8080,box-b=http://198.51.100.11:8080
```

- **The id** is 1–32 lowercase letters, digits or `-`, starting with a letter or digit. It names
  the instance everywhere else — Settings, the index, the audit log, `/healthz` — so pick names
  that tell your boxes apart and don't rename them casually: a path mapping that names an id that
  is no longer configured fails closed (see [Path mapping](#path-mapping)).
- **The same torrent on two boxes is two torrents.** The index is keyed by instance and hash, so a
  release that both boxes seed is never confused with itself.
- **One instance** can still be given the older way: `QBIT_URL` (with optional `QBIT_USER` and
  `QBIT_PASS`). It is used only while `QBIT_INSTANCES` is unset, and names the instance
  `"default"`.
- **Credentials are optional, and per instance.** An instance that lets this host in without a
  login (qBittorrent's "bypass authentication for clients in whitelisted subnets") needs none, and
  Jellymaid then never calls its login at all. For one that asks, there are two ways:
  - **Per-instance variables** `QBIT_<ID>_USER` and `QBIT_<ID>_PASS`, where `<ID>` is the instance
    id in uppercase with `-` written `_` (`box-a` becomes `QBIT_BOX_A_USER` and `QBIT_BOX_A_PASS`).
    The value is taken exactly as written — no encoding of any kind — and wins over anything in
    the URL. This is the easy way, and the one `.env.example` is laid out for.
  - **Embedded in the URL** (`http://user:password@host:8080`), percent-decoded.

  Set both or neither: a username without a password (or the reverse) stops the container at
  start, because a login that can only fail is never worth making.
- **Percent-encoding, for a password embedded in a URL.** Encode everything that is not a letter,
  a digit or one of `-._~`. The one that bites is the comma: it separates the entries, so a `,` in
  an embedded password **must be written `%2C`** — a raw comma cuts the entry in two and the
  container refuses to start (the message names the entry's position and never quotes the
  password). `#`, `?`, `/` and `%` break the URL the same way (`%23`, `%3F`, `%2F`, `%25`).
  For example, this gives `box-b` the password `s3cr,t`:

  ```
  QBIT_INSTANCES=box-a=http://198.51.100.10:8080,box-b=http://admin:s3cr%2Ct@198.51.100.11:8080
  ```

  Per-instance variables sidestep all of this; use them for any password with punctuation in it.
- **Unraid, and any qBittorrent on the same host as Jellymaid.** qBittorrent's authentication
  bypass is normally set to your LAN subnet, which is why a qBittorrent on *another* machine needs
  no credentials. A qBittorrent on the **same host** is different: a container on Docker's default
  bridge network reaches it from the Docker bridge address (typically `172.17.x.x`), which is
  outside that whitelist — so the LAN bypass does not apply, and the instance answers `403` until
  it is given credentials. Set that instance's credentials. An instance that needs credentials it
  was not given shows as `auth` in `/healthz` and on the Dashboard.
- **Login behaviour: a wrong password is tried twice, then not again until a restart.**
  qBittorrent bans an address for an hour after five failed logins, and the ban hits every client
  behind that address. Jellymaid treats `401`, `200 Fails.` and a `403` that does not say "banned"
  as a refused login, `200 Ok.` and `204` as success (5.1 and 5.2 differ here), and keeps whatever
  session cookie the server sets, under the name the server chose. At most one login is in flight
  per instance. After a first refused login it makes no further attempt on that instance for 5
  minutes (the second try is for a password that was only just changed on the server); after **two
  refused logins in a row it stops logging in to that instance until Jellymaid is restarted**, and
  the instance shows `auth` meanwhile — every call that needs a session fails at once, without
  touching qBittorrent. A ban (`403` with "banned") is waited out for an hour, and a login answer it
  cannot read as accepted or refused for 5 minutes. So when an instance shows `auth`, fix the
  credentials and restart Jellymaid. With no credentials configured it never logs in at all.
- **Health.** `/healthz` and the Dashboard list every instance separately — reachable, `auth` or
  unreachable, with its version — and `connectors.qbittorrent` stays as the worst of them.

## Path mapping

Jellymaid sees your library through several namespaces at once — the path Jellyfin reports, the
path Jellymaid's own container sees it at, and, for each qBittorrent instance, the path *that
instance* reports for a torrent's content — and has to translate between them to do anything
useful. That translation table is `pathMappings` in `/data/config.json`, editable from Settings.
Each entry has a `role` and up to four paths:

```json
[
  { "role": "library", "jellyfin": "/media/Movies", "container": "/mnt/box-a/Movies", "qbit": "/movies", "qbitInstance": "box-a" },
  { "role": "library", "jellyfin": "/media-b/Movies", "container": "/mnt/box-b/Movies", "qbit": "/movies", "qbitInstance": "box-b" },
  { "role": "download", "jellyfin": null, "container": "/mnt/box-a/downloads", "qbit": "/downloads", "qbitInstance": "box-a" }
]
```

- **`role: "library"`** — a root Jellyfin actually indexes. These are walked for orphans, empty
  folders and junk, and are the boundary a delete's directory sweep is never allowed to climb
  above. Requires a `jellyfin` path.
- **`role: "download"`** — a root with no Jellyfin equivalent (set `jellyfin` to `null`). Download
  roots exist purely so qBittorrent's content paths can be resolved to real `(dev, inode)` pairs —
  that resolution is what the hardlink and cross-seed guards depend on. You need a download root
  only for torrents whose data Jellymaid must see: torrents saved outside the library whose files
  back library items (a downloads folder Radarr or Sonarr hardlinks into the library, say). Give it
  the instance's `qbit` prefix and `qbitInstance`, and mount the folder into the container. A box's
  other folders — music, books, a downloads folder nothing in the library comes from — need no
  mapping and no mount: Verify ignores them and counts them (below). A download root is never
  scanned for orphan media, since everything in it is legitimately outside Jellyfin's library.
- **`qbit` and `qbitInstance`** — `qbit` is the root exactly as *that instance* spells it, and
  `qbitInstance` is the id of the instance that owns it. In the example both boxes call their
  library `/movies`, and they are two different disks: each root is only ever resolved against its
  own instance, so box A's files can only be owned by box A's torrents, and a delete for box B's
  copy is sent to box B and to nobody else.
- **`qbit: null` with `qbitInstance: null`** says the root is **explicitly not torrent-backed**:
  nothing there is ever matched to a torrent, so a file in it is removed from disk directly. No
  guard asks any instance about such a root, which is why Verify checks that no instance seeds
  into it (below). In Settings a new row has no default for this: its instance picker starts at
  "choose an instance, or none", and the mappings will not save until you make that choice
  explicitly (a root Auto-detect could not place starts the same way).
- **A `qbit` prefix with no resolvable instance is a mistake, and it fails closed.** That is a root
  with no `qbitInstance` while more than one instance exists, or one naming an id that is not
  configured. Deletes in it are blocked without an override (`guard.protected`), the plan says why,
  and saving the mapping lists the problem. An older config that has `qbit` but no `qbitInstance`
  is filled in automatically only when exactly one instance exists.

A misconfigured path map is the single most likely way a tool in this category deletes the wrong
thing, so it gets two dedicated Settings tools:

- **Auto-detect** samples Jellyfin item paths, searches your mounted volumes for matching files by
  size and directory structure, and proposes a mapping — proposing nothing rather than guessing
  when the evidence is ambiguous. For every mapped container root it also finds which instance's
  content paths exist under it and proposes that `qbitInstance` and its `qbit` prefix, again
  proposing nothing when two instances both fit. It runs in the background and does not block
  the server.
- **Verify** checks **both halves** of the map. Jellyfin to container: it resolves 20 random
  Jellyfin items end-to-end (Jellyfin path → container path → exists on disk). Then, for **each
  instance**:
  - **Only torrents in its mapped folders are checked.** A completed torrent counts when the
    content path that instance reports lies under one of *that instance's own* `qbit` prefixes.
    Torrents the box keeps anywhere else — music, books, a downloads folder nothing in the library
    comes from — are not failures: Verify ignores them and counts them, and Settings shows the
    count ("819 torrents outside every mapped folder were ignored") with a few example paths.
  - **A sample** of up to 20 of the counted torrents, dealt round-robin across the instance's
    mapped prefixes so that every mapped folder is looked at, however few torrents it holds: the
    content path → container path → exists, and for a single-file torrent the size on disk must
    also equal the torrent's size. Torrents qBittorrent itself reports as `missingFiles` or `error`
    are left out of the sample — their files are not where qBittorrent put them, whatever the
    mapping says — but when every completed torrent under a mapped folder is in one of those
    states, that folder fails ("none could be checked") until qBittorrent finds its files again.
  - **A mapped folder with no torrents fails.** A `qbit` prefix that no completed torrent of its
    instance lies under fails Verify ("no completed torrent of … reports a path under …") whenever
    the instance has completed torrents at all: a prefix that translates nothing is almost always
    mistyped (`/move` for `/movies`). An instance with no completed torrents has nothing to sample
    and passes, and so does one with no mapping of its own whose torrents all lie outside every
    mapped folder.
  - **One `qbit` prefix, one folder.** Two rows of the same instance with the same `qbit` prefix
    but different container folders fail Verify for that instance, whatever its torrents say, and
    Settings lists them as a mapping problem ("box-a maps /movies to two folders (…); one of them
    probably belongs to another box"). A box keeps its `/movies` in one folder, so only one of the
    rows could ever find its torrents. Nested prefixes (`/data` and `/data/movies`) are fine: the
    deeper one translates its own folder.
  - **Every** completed torrent, against the roots marked not torrent-backed: a torrent whose
    content turns up in such a root (the same path-suffix and size test Auto-detect uses) fails
    Verify, naming the root and the instance. A sample of 20 can miss a root that holds a small
    share of a box's torrents; this check cannot. Unmapped torrents that land in no such root are
    left alone.

**Scans and plan builds refuse to start while the last verification didn't fully pass** — a half
that resolved fewer than its full sample, any failure listed, an instance that was never checked,
or nothing verified yet. Ignored torrents never hold anything up. A verification also goes
**stale** as soon as the mappings change: it records a fingerprint of the mapping set, so any edit
to a mapping means Verify has to run again before anything proceeds, and an instance added since
has no result yet, which blocks the same way. This applies
to the nightly scheduled scan too, and there is no way to make the schedule bypass it. The manual
"Scan now" button can be forced past a failing verification if you explicitly choose to; a plan
build cannot be forced, because a plan is what deletes.

## Settings are live

Jellymaid keeps `/data/config.json` under watch and re-reads it whenever the file changes, so what
you save in Settings takes effect **without a restart**: the path mappings, the guard thresholds
(`minRatio`, `minSeedTimeDays`), the protected categories and tags, the private-tracker hosts and
the keeper policy. The planner, the executor, Explorer, `/healthz`, the Duplicates list and the
Settings screens all read the current values, never a copy taken at boot. A plan run takes **one
snapshot** when it starts and uses it for every action, so a setting you change mid-run applies to
the next plan, not the one in flight.

A hand-edited `config.json` is picked up the same way. An invalid edit (broken JSON, a value the
schema rejects) is refused: whatever needs the config reports the error until the file is fixed,
instead of quietly falling back to the last good copy — a guard threshold must never silently
revert.

Three things are still read only when the container starts, so change them and restart: the
environment (`QBIT_INSTANCES`, `TRUST_PROXY`, the URLs and keys), the scan schedule (`scanCron`)
and the connector rate limits (`rateLimits`) that plan builds and plan runs use — a scan re-reads
its own each time it starts. The keeper policy is live too, but it decides which copy a duplicate
group pre-selects when the group is built, so a change applies from the next scan.

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
2. **qBittorrent delete-with-data, on the instance that owns the file.** The matched torrents are
   grouped by instance, and each group is sent with `deleteFiles=true` to its own instance's client
   and to no other: box B's copy is never deleted through box A, even when both report the same
   internal path. A file whose instance cannot be determined blocks the delete rather than guess.
   Jellymaid then polls that instance until it confirms the hash is actually gone before moving on.
3. **Whatever qBittorrent left: this path's own link.** When a torrent was just removed for this
   file, qBittorrent deletes asynchronously (and over NFS the client can see the removal late), so
   Jellymaid first waits up to 30 seconds for the file to disappear; a file that is already gone
   counts as removed by qBittorrent, not as a failure. Anything still there is dealt with
   directly: a junk file with no torrent behind it is moved to
   trash (see [Trash](#trash) below) if it qualifies; a media file, or any file a torrent backs, is
   unlinked directly here and cannot be recovered — one "Delete" vocabulary covering two different
   outcomes. Space for a hardlinked file is only reclaimed once its **last** remaining link is
   removed (`nlink <= 1` at the moment of unlink) — removing just this one path frees 0 bytes if
   another link to the same inode survives.
4. **Sweep leftover empty directories.** The now-empty parent directories this leaves behind are
   removed, walking upward one level at a time but never above the mapped library or torrent root.
5. **Jellyfin**, last: it is not asked to delete anything. Once the whole plan has finished,
   Jellymaid sends **one** notification listing every path that is confirmed gone, and Jellyfin
   forgets those items itself (see [below](#how-jellyfin-forgets-a-deleted-item)). Merging and
   splitting Jellyfin versions work as they always did.

Every path removed this way is also recorded, so the Duplicates list stops showing that copy at
once instead of waiting for the next scan. A plan runs in the background: starting it answers
immediately, the Plan screen follows its progress, and a scan cannot start while a plan is
executing (or the reverse) — a scan rewrites the index a plan resolves against.

**There is no step that unlinks "remaining hardlinks the operator selected."** That capability
does not exist — there is no hardlink-unlink action type and no selection UI for it. The *only*
way another hardlink to the same bytes is ever removed is if that other path is itself queued,
approved and executed as its own delete action; `guard.hardlink` only ever warns that other links
survive, it never offers or performs a way to remove them from here.

A file with no matching torrent skips straight to steps 3–5.

**"Merge" is a different, non-destructive operation.** Selecting "Merge Versions" on a duplicate
group calls Jellyfin's own `MergeVersions` API: no files are touched, Jellyfin just presents the
group as one item with a version picker. It's reversible from History via split. Deleting
non-keepers from a duplicate group is a separate, explicit choice that goes through the same
queue → approve → delete pipeline as everything else.

### The unit of a delete is the torrent

Torrents are usually saved straight into the library, so a movie release is a folder holding the
video **and** its `.nfo`, its `.srt` and a `Sample/sample.mkv`. Deleting the video therefore removes
the whole torrent, companion files included, and the dry run counts how many companion files go with
each one; the Plan screen shows every action's torrents with their box, ratio, seeding days and
companion count. What `guard.torrent-scope` watches for is the opposite case — a torrent that holds
*more media* than the plan named (see [The guards](#the-guards)). Bytes freed are credited once per
removed torrent, not once per action.

### How Jellyfin forgets a deleted item

Jellymaid never asks Jellyfin to delete anything and never triggers a library refresh. When a plan
has finished, it sends Jellyfin one `POST /Library/Media/Updated` listing every deleted path as
`Deleted` — only paths whose files are confirmed gone, in Jellyfin's spelling of the path. Jellyfin
then drops each item after its own `LibraryMonitorDelay` (60 seconds unless you changed it), so
**Jellyfin drops deleted items within about a minute** (65 seconds were observed on the test
harness); the Plan screen says so too. While a file is still on disk, nothing happens in Jellyfin,
and the notification does not restart a library scan that is already running. If an item lingers,
wait a minute, check that the file is really gone, and look at the plan's record in History.

## The guards

Every path-based action is judged against six guards before it can run. Guards are re-resolved
against live services immediately before each action runs — but "live" has one caveat worth
naming: the target's own identity (`nlink`, size, `dev`/`inode`) always comes from a fresh
`stat()` right then, and qBittorrent's own torrent list and file counts are re-fetched (one
snapshot per instance for a whole plan build; during a run, at most every 10 seconds per instance,
and straight after that instance deletes something). What is *not* re-walked from disk each time
is the **set of other paths** that share this file's inode: `guard.hardlink`'s list of other
hardlinks, and one of the two sources `guard.torrent-scope` can use for a torrent's file count,
both come from the last scan's `fs_entries`/`torrent_files` index rows. In practice
`guard.torrent-scope` prefers a live qBittorrent file listing when the index can't answer
completely, but a complete indexed answer is used as-is without a live re-check. A hardlink
created, or a torrent file added, since the last scan will not be reflected until the next one.

| Guard | Protects against | Overridable? |
|---|---|---|
| `guard.private-ratio` | Deleting a private-tracker torrent's data before it has met **both** the ratio and the seed-time minimums (getting your account banned) | Yes — an explicit per-row toggle, or one action for every blocked row, recorded in the audit log |
| `guard.cross-seed` | Removing one torrent's data when a second torrent shares the exact same bytes, breaking the other | Yes, and confirming expands the action to remove all matching torrents together |
| `guard.hardlink` | Overstating reclaimed space — warns (never blocks) that other hardlinks to the same bytes survive, so removing just this path frees 0 bytes | Not applicable — this guard warns, it never blocks |
| `guard.protected` | Acting on a torrent that's busy (downloading/checking/moving), tagged/categorized as protected, or whose true state can't be verified because a qBittorrent instance or a configured \*arr instance is unreachable — or because the file's root names no instance that could own it | **No.** This is the one guard with no override, by design |
| `guard.torrent-scope` | A torrent covering more *media* than the plan named (e.g. one queued episode of a whole season pack) — deleting it with data would take video nobody reviewed. **Companion files do not count:** anything that is not a media file (`.nfo`, `.srt`, artwork), anything in a `Sample`/`Proof`/`Screens` folder, and a small sample video (under a tenth of the torrent's largest media file) travel with their release | Yes — the operator is explicitly accepting that the rest of the torrent goes too |
| `guard.untracked` | A file in a torrent-backed root that no torrent on that root's instance owns — a leftover, with nothing to cross-check it against | Yes — overriding means "this is a leftover; delete it from disk" |

A movie release with its sidecars therefore passes `guard.torrent-scope` without an override and is
removed whole; a season pack with only one episode queued still blocks.

### Private trackers: the H&R rule (AND)

`guard.private-ratio` is deliberately strict. A private torrent may be deleted only when it has met
**both** minimums: a ratio of at least `minRatio` **and** a seeding time of at least
`minSeedTimeDays`. Neither one alone is enough. Trackers differ — some count ratio *or* time toward
their own hit-and-run (H&R) rule — and Jellymaid cannot know which yours enforces, so it requires
both.
Public torrents are exempt, and a torrent whose privacy can't be determined is treated as
private — fail-safe, not fail-open.

The thresholds are yours to set. **Settings** edits `minRatio` (default `1.0`) and
`minSeedTimeDays` (default `14`), along with the protected categories and tags and the
private-tracker hosts, and a save takes effect immediately, without a restart (see
[Settings are live](#settings-are-live)).

Because the AND rule blocks a large share of a typical private collection, the Plan screen can
**override a guard for all N blocked rows at once**, after a confirmation, and a rebuild keeps the
overrides you already made; each one is recorded in the audit log. For `guard.untracked` the
confirmation says plainly that those files, which no torrent owns, will be deleted from disk, and for
`guard.torrent-scope` that the other files in those torrents will be deleted too. The Duplicates screen shows every
copy's H&R status before you queue it. An override for a guard that no longer blocks (the torrent
has since crossed its ratio) is dropped and reported on the plan, not an error.

Defaults (`config.json`'s `guards` block):

- `minRatio`: `1.0`
- `minSeedTimeDays`: `14`
- `protectedCategories` / `protectedTags`: empty (populate with your own qBittorrent categories/tags)
- `privateTrackerHosts`: empty (operator-populated; qBittorrent's own `private` flag is preferred
  when the connected version reports it, and a torrent whose privacy can't be determined is
  treated as private — fail-safe, not fail-open)

All of it is editable from Settings and live. A host you add to `privateTrackerHosts` counts from
the next guard evaluation — no restart, so there is no window in which a tracker you just listed is
still treated as public.

An unreachable qBittorrent instance, or an unreachable/incomplete Radarr or Sonarr inventory, makes
`guard.protected` block with **no override** — an empty answer from a source that can't be
verified is read as "unknown," never as "not managed," because an unmonitor call that silently
never ran is exactly how a deleted file gets re-downloaded. Each instance is judged on its own: a
file under box A's root only ever asks box A, so box B being down does not block it.

## Confidence tiers — read this before trusting "exact"

Duplicate findings carry a confidence tier: `exact`, `strong`, or `possible`. **"Exact" does not
mean byte-identical.** Of the three rules that produce an `exact` link:

- `dupe.provider-id` — two items share the same TMDB/IMDB/TVDB id. Pure metadata; the underlying
  files are never compared. (Collection ids never count: every film in a collection shares one.)
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

## Duplicate groups and the keeper

- Groups are built from `exact` and `strong` links only. A `possible` link never merges two groups;
  it only pairs two items that are not in any group yet.
- A show matches across library roots: episodes are keyed on the **series'** provider id plus season
  and episode, so the same show sitting in two roots still groups. A file holding several episodes
  links as `strong`, not `exact`.
- Editions (Extended, Director's Cut, Unrated, Theatrical, Final Cut, IMAX, Ultimate, Special
  Edition, Remastered, Criterion) are recognised from the name. A group whose members differ in
  edition is marked, and its non-keepers are never pre-selected for deletion. When the scan did not
  record whether they differ, the members' own names decide — never a silent "no".
- A file holding several episodes (`S01E01E02`, `S01E01-E02`, `1x01-02`, …) is filed by Jellyfin
  under its first episode, so it groups with that episode's copies — but it is not a spare copy:
  deleting it deletes the later episodes too. Such a group is marked **multi-episode**, and the
  bulk queue skips it unless you tick the box that includes groups holding a multi-episode file.
- The **keeper policy** (Settings) decides which copy is pre-selected to keep: `best-quality`
  (default), `smallest`, or `none` (you choose). A change applies from the next scan.
- Each copy shows its box and its torrent: name, state, ratio, seeding days, private or public,
  tracker, size, file count, and whether it clears the H&R rule under your current thresholds. A
  torrent count above one marks a cross-seed.
- The list is sorted by reclaimable bytes, filterable by tier, box, cross-box and H&R-blocked, and
  paged 50 groups at a time. "Queue non-keepers" works on one group or every visible group; the bulk
  form skips `possible` groups, edition-differing groups and multi-episode groups unless you tick
  the box that includes them. The queue survives a reload (it lives in your browser). **Dismiss** —
  here, or the group's finding on the Findings screen, which is the same dismissal — hides the group
  and keeps it dismissed for as long as its membership does not change; reopening on either screen
  brings it back. Merging is secondary and asks first.

## Trash

Torrent-backed files are never trashed — qBittorrent deletes its own data directly in step 2 of
the delete pipeline above, and pre-copying a large file to a trash folder before removing it would
defeat the point of reclaiming the space.

**Trash only ever applies to a `delete-junk-file` action with no torrent behind it.** That is a
narrower condition than "small and torrentless" — it is a specific action *type*. A
`delete-media` action — the kind that removes an actual movie or episode file — is **always
unlinked directly, with no trash and no recovery, regardless of size or whether a torrent backs
it.** Only a junk file identified by the filesystem rules (leftover `.nfo`/sample/partial-download
debris, not a Jellyfin-known media file) ever gets a trash pass. Read "Delete" on a `delete-media`
row as unconditionally permanent.

For the files that do qualify: one below `trash.maxBytes` (default **1 GiB**) is **moved**
(same-filesystem rename, not copied) into `<library-or-download-root>/.jellymaid-trash/<plan-id>/`
and purged after `trash.retentionDays` (default **30 days**), on a nightly schedule. Restore is
available from History while the entry survives. Both `trash.maxBytes` and `trash.retentionDays`
are shown, read-only, on the Settings screen; change them by editing `/data/config.json` by hand,
which is picked up without a restart (see [Settings are live](#settings-are-live)).

**Trash must live on the same filesystem as the media** — this is why it's placed inside each
configured root rather than at some fixed global path. If a root spans a read-only mount, isn't
the true root of one filesystem (e.g. two different filesystems bind-mounted under what looks like
one path), or the file is over `trash.maxBytes`, the trash move is skipped entirely and the file is
unlinked outright instead — the exact same unrecoverable path a `delete-media` action always takes.
**The trash *database row* for that attempt is deleted, not marked** — trash entries only ever
describe files that still exist. The only surviving trace that a trash attempt was refused is
`trashRefused` in that action's audit-log detail, alongside the eventual `disposition: 'unlinked'`.
Nothing on screen distinguishes "too big for trash" from "read-only mount" from any other reason
the move failed — all three land on the same unlinked outcome and the same audit note.
`.jellymaid-trash` itself is excluded from every scan phase and every rule — it never shows up as
orphan media, junk, or an empty folder, and never counts toward folder sizes in Explorer.

A trash entry that fails to purge (permission error, read-only mount, etc.) keeps its database row
on purpose — that row is the only record the file still exists. It shows up as a purge failure in
the logs rather than being silently forgotten.

## Scanning

- **There is no `SCAN_CRON` environment variable.** The schedule is `scanCron` in `/data/config.json`
  (default `0 3 * * *`). It is read when the container starts — change it and restart to pick up
  the new schedule. **It is evaluated in UTC, always**, regardless of the container's `TZ` — the
  scheduler pins `tz: 'UTC'` explicitly so the schedule cannot silently drift with wherever it
  happens to be deployed. If you want "3am local", convert your timezone's offset to UTC yourself
  when writing the cron string. A scheduled scan never starts while one is already running or while
  a plan is executing, and never bypasses the path-map verification gate.
- A scan walks Jellyfin, then the filesystem, then qBittorrent (each instance in turn), then
  \*arr, then runs every rule over the results, in that order, with a resumable cursor per phase —
  a killed or crashed scan picks back up where it left off rather than starting over. It reports
  its progress phase by phase, instance by instance and rule by rule.
- **One qBittorrent instance being down does not erase the others.** An instance that cannot be
  read keeps its existing rows untouched, the other instances are refreshed and swept, and the
  phase says which instance it skipped.
- **A filesystem root that walks empty while the index still holds rows for it is treated as
  unmounted**: it is not swept, and the phase says so. An unmounted share must not look like a
  library that was deleted.
- **Hashing is opt-in per library root** (`hashedLibraryRoots` in `config.json`), but whether
  `dupe.identical-file` counts as "evaluated" for this scan is decided **globally, not per root**:
  the check is simply "does any row anywhere have a `quick_hash`". If even one root is hashed, the
  whole scan is marked evaluated for that rule — files in a *different*, unhashed root then just
  never match anything by hash, which surfaces as an ordinary lack of findings for that root's
  files, **not** as the distinct "not evaluated" state described below. Only a library where *no*
  root anywhere has hashing on gets the honest "not evaluated" treatment. Turn hashing on for every
  root you want covered by `dupe.identical-file`, or don't rely on this rule for the ones you leave off.
- **"Not evaluated" is a real, distinct state — it is never rendered as "no findings."** If
  a qBittorrent instance or an \*arr instance is unreachable during a scan, or hashing is off for
  every root, the rules that depend on that source say so explicitly rather than silently
  reporting zero results. "No duplicates found" and "couldn't check for duplicates" are never
  allowed to look the same — except for the per-root hashing gap just above, which is the one
  place that guarantee currently has a hole.

## Troubleshooting

- **"Path mappings resolved fewer than the full sample" / "scan refuses to start" / a plan build
  answering "verification".** This is the verification gate described under
  [Path mapping](#path-mapping), working as intended — and it also trips when the mappings changed
  since the last Verify, or when an instance has never been checked. Fix your `pathMappings` in
  Settings (or run Auto-detect again) until Verify passes for Jellyfin and for every instance — the
  full sample resolved and no failure listed — then re-scan or rebuild the plan. The gate applies to the scheduled scan
  too, so an unattended nightly scan will simply not run — check `/healthz`'s `lastScan` if scans
  seem to have stopped.
- **The container reads healthy while a connector is down.** Deliberate. The Docker `HEALTHCHECK`
  is *liveness-only*: it passes as long as the process is up and `/healthz` answers with a
  well-formed body, and ignores the value of `status`. Making a `degraded` connector mark the
  container unhealthy would let an unreachable — and entirely optional — Radarr get Jellymaid
  restarted by autoheal or an Unraid monitor **in the middle of executing a plan**, which is how
  you end up with the stuck `running` plan described below. Connector health is a condition for
  you to see and act on in the UI, not a reason to kill a process that deletes files. Watch
  `connectors` and `qbitInstances` in `/healthz` (or the Settings screen) rather than the
  container's health state.
- **A qBittorrent instance shows `auth`.** It needs credentials it was not given, or was given
  the wrong ones — see [qBittorrent instances](#qbittorrent-instances), especially the same-host
  note. Once they are right, restart Jellymaid, whether you corrected them in its environment or in
  qBittorrent: after two refused logins in a row it makes no further login to that instance until
  it is restarted (after a single refusal it tries once more 5 minutes later, after a ban an hour
  later).
- **Verify fails with "no completed torrent of … reports a path under …".** That row's `qbit`
  prefix is not how the box spells the folder: usually a typo (`/move` for `/movies`), or the box
  now saves somewhere else. Look up the qBittorrent path in qBittorrent itself (a torrent's save
  path, in its properties), correct the row, and Verify again. A mapped folder that genuinely has
  no completed torrent yet fails the same way while the box has completed torrents elsewhere;
  Verify passes once one finishes there.
- **Settings says "N torrents outside every mapped folder were ignored".** Not a failure: those
  torrents lie in folders no mapping of that instance names, so Jellymaid never deletes or guards
  anything through them, and needs no mount for them. If one of the examples is a folder whose
  files back library items (a downloads folder Radarr or Sonarr hardlinks into the library), give
  it a `role: "download"` mapping for that instance, mount it, and Verify again — see
  [Path mapping](#path-mapping).
- **Verify fails with "box-a maps /movies to two folders (…)".** When both boxes call their library
  `/movies`, this is almost always the other box's row with the wrong instance chosen. Choose the
  right instance on that row (each box should map `/movies` once), save, and Verify again. Left as
  it was, the other box's films would read as owned by no torrent, and a delete would meet only the
  overridable `guard.untracked` while that box is still seeding them.
- **Verify fails with "root … is marked not torrent-backed, but qBittorrent instance … seeds this
  torrent there".** That row says no torrent ever saves into the root, and a box does. Choose that
  instance (and its qBittorrent path) for the row. Left as it was, a delete there would unlink a
  file the box is seeding, and no guard would stop it.
- **Verify fails because every completed torrent under a mapped folder is `missingFiles` or
  `error`.** qBittorrent cannot find any of that box's files there — usually a mount missing on the
  qBittorrent side. Fix it there (recheck the torrents, or set their location), then Verify again.
- **"qBittorrent unreachable" blocking deletes.** This is deliberate, not a bug: `guard.protected`
  has no override, and an unreachable instance means Jellymaid cannot confirm a torrent isn't
  mid-download, cross-seeded, or otherwise unsafe to touch. It blocks the deletes that depend on
  that instance only. Fix the qBittorrent connection; there is no way to force past this one.
- **Jellyfin still lists an item I deleted.** Give it a minute (see
  [How Jellyfin forgets a deleted item](#how-jellyfin-forgets-a-deleted-item)). If it is still
  there, check the file is really gone from disk — Jellyfin ignores the notification for a file
  that exists.
- **Stopping and resuming.** On `docker stop` (SIGTERM) or SIGINT, Jellymaid stops taking work,
  cancels a running scan, lets a running plan finish its *current* action and leaves the rest of
  the plan resumable, then closes the database. A scan interrupted mid-phase (or killed outright)
  resumes from its saved cursor on the next scan trigger. A plan interrupted mid-execution is left
  in a `running` state that only an explicit resume can clear — every action is idempotent and
  every guard is re-checked live, so resuming re-verifies everything rather than blindly
  continuing. Docker's default stop timeout is 10 seconds; if the current action takes longer,
  Docker kills the process and the plan simply stays `running` until you resume it.
- **`TRUST_PROXY`.** This must equal the exact number of reverse proxies actually sitting in front
  of Jellymaid — for example `1` behind a single Cloudflare Tunnel or reverse proxy, `0` if nothing
  is in front of it (the default). Getting this wrong is dangerous in both directions:
  - **Too low** (e.g. `0` behind a real proxy) collapses every real client onto the proxy's own
    address, so the per-IP login lockout locks *every* caller out together after a handful of
    failed logins from any one of them.
  - **Too high** lets a caller forge the `X-Forwarded-For` header and pick whatever "client IP"
    Jellymaid trusts, defeating that same lockout by minting a fresh bucket on every request.

  With a value of `1` or more, also make sure clients cannot reach port 8099 directly around the
  proxy: trusting a hop count is only safe when every request really did pass through that many
  proxies (a known limitation of hop counts; see the [carry-forward notes](docs/superpowers/carry-forward.md)).
- **Session secret.** There is no `JWT_SECRET` or similar variable to configure — Jellymaid mints
  a random 32-byte session secret on first boot and persists it at `/data/.session-secret` (mode
  `0600`), so sessions already survive container restarts and image upgrades with zero
  configuration. Set the optional `SESSION_SECRET` environment variable only if you specifically
  want to force a fixed value or invalidate every session on your own schedule.

## Verified against

- **Versions:** Jellyfin 12.1.0, qBittorrent 5.2.2 and qBittorrent 5.1.2 — the two qBittorrent
  releases running side by side, as two instances.
- **Where, and when:** a local harness of real binaries, on 2026-10-31. Those are the actual
  Jellyfin and qBittorrent releases, not stubs, on one machine with a synthetic library built to
  contain the awkward cases: duplicates within one box, across two boxes, a season pack against a
  single episode, and one set of files seeded by two torrents. No Docker, no root, none of your
  data.
- **What that settled** — each of these was wrong in the fakes the July 2026 release was tested
  against: Jellyfin 12 ignores the old `X-Emby-Token` header and wants
  `Authorization: MediaBrowser …`; qBittorrent 5.1 answers a good login `200 Ok.` with a `SID`
  cookie, while 5.2 answers `204` with a cookie named `QBT_SID_<port>`; a wrong password is `401`
  on 5.2 and `200 Fails.` on 5.1; Jellyfin's own item delete removes the item's whole containing
  folder when its files still exist; and a notification of the kind described above does make
  Jellyfin drop an item, about a minute later.
- **Still pending: the read-only scan against a real stack** — Jellyfin and both qBittorrent
  instances of an actual deployment, writing nothing — and, after it, the first-run checklist below
  on your own hardware.
- **Never verified:** Radarr and Sonarr — the harness runs neither, so the unmonitor path is
  checked against fakes only. The harness also uses identity path mappings on local disks, so
  per-instance path translation (two boxes both saying `/movies`) is covered by tests on real
  temporary directories rather than by the harness; **Verify** on your own stack is the check for
  your layout. CI builds the Docker image and starts it against unreachable dummy services, waiting
  for `/healthz`, before it publishes anything — but only on the CI runner's own architecture: the
  arm64 image is built, never started.

Do not treat any claim in this document as validated beyond that until you've personally run the
checklist below. The test suites (`npm test`, `npm --prefix client test`) run against fixtures,
in-memory SQLite, real temporary directories (including real hardlinks) and recorded HTTP
responses; their counts change with every commit, so run them for the number that is true now.

### Known limitations

These are known-open items, not bugs waiting to be noticed — accepted gaps an operator should know
about going in:

- **An unmapped Radarr/Sonarr folder can wedge every delete, and nothing on the health page says
  so.** A record whose *arr path resolves to no configured mapping (`arrUnmappable`) blocks that
  path's delete, non-overridably, but the only way to discover it today is to try to build a plan
  and read the block reason. One decommissioned root folder in Radarr/Sonarr can silently stop
  every delete in the whole install until an operator happens to hit it.
- **Sessions cannot be revoked.** Logging out only clears the cookie in your own browser — there is
  no server-side session list or kill switch. A captured session cookie remains a valid credential
  for the rest of its 7-day life even after you log out, and there is no way to force it to expire
  early short of changing `SESSION_SECRET` (which invalidates every session at once, not just one).
- **A stop that outlasts Docker's timeout leaves a plan `running`.** Graceful shutdown lets the
  current action finish, but Docker waits only 10 seconds by default before it kills the process.
  The recovery path is: go to **History**, find the plan (it will show status `running`), and click
  **Resume** — the executor re-verifies every guard live before continuing, so this is safe, but it
  is a manual step an operator has to know to take.
- **A plan stuck `running` after a crash shows no controls on the Plan screen itself.** The Plan
  screen only offers rebuild/approve/execute controls for a `draft` or `approved` plan; a plan a
  crash left `running` looks the same there as one that is genuinely still executing, with nothing
  to click. The only place to act on it is History, per the point above — the Plan screen gives no
  hint that History is where to go.

### First-run checklist

Run through this in order, on your own real stack, before trusting Jellymaid with anything you'd
miss if it were gone:

1. `docker compose up -d`, then `curl -fsS localhost:8099/healthz` — expect `"status":"ok"`, the
   other connectors `ok` or `not-configured` (never `unreachable`), and every qBittorrent instance
   listed under `qbitInstances` with its version. An instance showing `auth` needs credentials —
   see [qBittorrent instances](#qbittorrent-instances).
2. Log in with a Jellyfin **administrator** account; confirm a non-admin Jellyfin account is
   refused.
3. Settings → path mapping: give each root its qBittorrent instance and prefix (Auto-detect
   proposes them), then Verify — fix mappings until Jellyfin **and every instance** resolve their
   full sample (20 of 20, or however many items, or completed torrents in mapped folders, you
   actually have) with no failure listed. Read the ignored count too: it should be only folders
   you meant Jellymaid to leave alone.
4. Look at Settings' thresholds: `minRatio`, `minSeedTimeDays` and the keeper policy are what you
   mean them to be. Remember that a private torrent needs **both** minimums before it may go.
5. Trigger a scan; watch it progress through phases and through each instance; confirm the index
   counts on `/healthz` and the Dashboard's snapshot tables actually fill in.
6. Check Findings and Duplicates; confirm every copy shows the right box and torrent, and
   spot-check at least three duplicate groups by hand against the real files — one of them a
   cross-box group — before trusting the grouping.
7. **Pick one deliberately chosen, genuinely disposable duplicate** — not something you'd miss.
   Queue its non-keeper, build the plan, read the dry-run preview carefully (which box, how many
   torrents and companion files, how many bytes), override only a guard you understand, approve,
   and execute.
8. Confirm afterward, by hand: the files are actually gone from disk; the torrent is gone from the
   **right** qBittorrent instance and the other one is untouched; if the file was Radarr/Sonarr-
   managed, that entry is now **unmonitored and still present** in Radarr/Sonarr (not deleted, not
   blocklisted); the now-empty parent folder was swept away; Jellyfin stops listing the item
   within about a minute; and History shows the full chain of what happened.

Only after step 8 behaves exactly as documented here should you point Jellymaid at anything that
matters.

## License

MIT — see [`LICENSE`](LICENSE).
