import { createHash } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import type { Dirent, Stats } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import type { PathMapping, TorrentSource } from '../core/types.js'
import type { Torrent } from '../connectors/qbittorrent.js'

const strip = (p: string) => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p)

/**
 * Resolves symlinks in every existing ancestor of `p`, then re-appends whatever trailing
 * segments do not exist yet, lexically. `resolve()` alone is purely lexical and cannot see
 * symlinks — it would treat `<root>/link -> /etc` (or `<root>/link -> /nonexistent`) as staying
 * under `<root>`. Walks upward from `p` looking for the deepest ancestor `realpathSync` can
 * resolve; everything below that ancestor is collected and reappended in its original order.
 *
 * Fails CLOSED (returns `null`) rather than guessing, on:
 *  - any `realpathSync` failure that is not "this exact path doesn't exist yet" (EACCES, ELOOP, …);
 *  - a dangling symlink (the entry itself exists per `lstatSync`, but `realpathSync` still could
 *    not resolve it — most commonly because its target does not exist). This is the same
 *    attacker-planted-symlink escape as a symlink to a real outside path, just pointed at a
 *    missing target instead, so it gets the same answer;
 *  - reaching the filesystem root without ever finding an existing ancestor.
 * Only genuinely nonexistent-so-far path components (no entry at all, `lstatSync` itself throws
 * ENOENT) are treated as "not created yet" and walked past.
 */
function resolveReal(p: string): string | null {
  let current = resolve(p)
  const remainder: string[] = []
  for (;;) {
    try {
      const real = realpathSync(current)
      return remainder.length === 0 ? real : join(real, ...[...remainder].reverse())
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null // EACCES, ELOOP, … — fail closed

      try {
        lstatSync(current)
        // The entry exists (as a symlink or otherwise) yet realpath could not resolve it — most
        // commonly a dangling symlink. Fail closed rather than guess at what it would point to.
        return null
      } catch (lstatErr) {
        if ((lstatErr as NodeJS.ErrnoException).code !== 'ENOENT') return null
        // current genuinely does not exist yet — the normal case while probing a path that has
        // not been created. Record it and keep resolving one level up.
      }

      const parent = dirname(current)
      if (parent === current) return null // hit the filesystem root without an existing ancestor
      remainder.push(basename(current))
      current = parent
    }
  }
}

function underPrefix(path: string, prefix: string): boolean {
  const p = strip(path)
  const q = strip(prefix)
  return p === q || p.startsWith(q.endsWith('/') ? q : `${q}/`)
}

function rebase(path: string, from: string, to: string): string {
  const rest = strip(path).slice(strip(from).length)
  return `${strip(to)}${rest}`
}

/** What one mapping, on its own, says about the torrents under its root. */
function sourceOf(root: PathMapping): TorrentSource {
  if (root.qbit !== null && root.qbitInstance !== null) return { kind: 'instance', instanceId: root.qbitInstance }
  if (root.qbit === null && root.qbitInstance === null) return { kind: 'none' }
  return {
    kind: 'unknown',
    reason: root.qbit !== null
      ? `the mapping for ${root.container} names qBittorrent path ${root.qbit} but no instance`
      : `the mapping for ${root.container} names qBittorrent instance ${root.qbitInstance} but no path`,
  }
}

export interface PathMap {
  toContainer(jellyfinPath: string): string | null
  fromContainer(containerPath: string): string | null
  /**
   * Only mappings whose qbitInstance === instanceId are considered. Two boxes routinely spell
   * different roots identically (both call their library `/movies`); translating box B's path
   * through box A's prefix would point box B's torrent at box A's files.
   */
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

export function createPathMap(mappings: PathMapping[]): PathMap {
  const byJf = [...mappings].filter((m) => m.jellyfin).sort((a, b) => b.jellyfin!.length - a.jellyfin!.length)
  const byContainer = [...mappings].sort((a, b) => b.container.length - a.container.length)
  // A prefix with no instance translates nothing: there is no telling whose torrents it describes.
  const byQbit = [...mappings].filter((m) => m.qbit && m.qbitInstance).sort((a, b) => b.qbit!.length - a.qbit!.length)
  const rootFor = (containerPath: string): PathMapping | null =>
    byContainer.find((x) => underPrefix(containerPath, x.container)) ?? null

  // A root's own resolution is repeated across many isWithinRoot calls (e.g. Plan 4's sweep
  // checks the same root against every ancestor directory it walks upward through), so a root that
  // resolved is cached here rather than re-resolved via realpathSync on every call.
  //
  // A root that could NOT be resolved is not cached: the next call tries it again. This map lives as
  // long as the PathMap, and ConfigStore keeps one PathMap for as long as the mappings are unchanged,
  // so a cached failure outlived its cause — one ESTALE or EACCES on an NFS root made every delete in
  // that root "outside every configured root" until a restart. Each failed call still answers false
  // (fail closed); it just does not decide the answer for every call after it.
  const rootRealCache = new Map<string, string>()
  function resolveRootReal(container: string): string | null {
    const cached = rootRealCache.get(container)
    if (cached !== undefined) return cached
    const real = resolveReal(container)
    if (real !== null) rootRealCache.set(container, real)
    return real
  }

  return {
    toContainer(jellyfinPath) {
      const m = byJf.find((x) => underPrefix(jellyfinPath, x.jellyfin!))
      return m ? rebase(jellyfinPath, m.jellyfin!, m.container) : null
    },
    fromContainer(containerPath) {
      const m = byContainer.find((x) => x.jellyfin && underPrefix(containerPath, x.container))
      return m ? rebase(containerPath, m.container, m.jellyfin!) : null
    },
    qbitToContainer(instanceId, qbitPath) {
      const m = byQbit.find((x) => x.qbitInstance === instanceId && underPrefix(qbitPath, x.qbit!))
      return m ? rebase(qbitPath, m.qbit!, m.container) : null
    },
    torrentSourceFor(containerPath) {
      // The DEEPEST root decides, so a non-torrent folder nested inside a torrent-backed root (or
      // the reverse) answers for its own files.
      const root = rootFor(containerPath)
      if (!root) return { kind: 'unknown', reason: `no path mapping covers ${containerPath}` }
      const source = sourceOf(root)
      // Two mappings for the very same root are equally deep. If they disagree about who owns it
      // there is no deepest answer, and picking whichever was listed first would hand one box's
      // files to the other's torrents: fail closed instead.
      for (const twin of byContainer) {
        if (twin !== root && strip(twin.container) === strip(root.container)
          && JSON.stringify(sourceOf(twin)) !== JSON.stringify(source)) {
          return { kind: 'unknown', reason: `the mappings for ${root.container} disagree about which qBittorrent instance owns it` }
        }
      }
      return source
    },
    rootFor,
    libraryRoots: () => mappings.filter((m) => m.role === 'library'),
    downloadRoots: () => mappings.filter((m) => m.role === 'download'),
    // Note: like any filesystem check, this is inherently time-of-check-to-time-of-use — a
    // symlink (or the target directory itself) can change immediately after this returns.
    // A caller must not treat a `true` result as a lasting guarantee; it only reflects a single
    // point in time, so re-check immediately before acting on it if the action is destructive.
    isWithinRoot(containerPath, root) {
      const target = resolveReal(containerPath)
      if (target === null) return false // unresolvable / dangling symlink — fail closed
      const base = resolveRootReal(root.container)
      if (base === null) return false
      return target === base || target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
    },
    all: () => mappings,
  }
}

/** One instance's qBittorrent prefix that two or more of its mappings send to different folders. */
export interface ShadowedPrefix {
  instanceId: string
  /** The prefix without trailing slashes, which do not change the paths it covers. */
  qbit: string
  /** Each folder once, as the first mapping naming it spells it, in mapping order. */
  containers: string[]
}

/** A prefix as a key: `/movies`, `/movies/` and `/movies//` cover the same torrents. */
const prefixKey = (qbit: string): string => qbit.replace(/\/+$/, '') || '/'

/**
 * Every (instance, qBittorrent prefix) that the instance's mappings send to more than one folder,
 * ordered by instance, then prefix (final re-review N1).
 *
 * One box saves its `/movies` into one folder, so two folders for it cannot both be right. Nor can
 * both be used: `qbitToContainer` translates through one of the rows only, so the other never finds a
 * single torrent of the instance, and every file under it reads as owned by no torrent. A film another
 * box is seeding there then meets `guard.untracked`, which is overridable, where `guard.private-ratio`
 * would have refused it. Verify never noticed: it samples per PREFIX, and the translating row checks
 * out. In practice the second row is the other box's, labelled with this box:
 * both of the owner's boxes report `/movies`, and that box's own torrents then lie under none of its
 * prefixes and are only counted as ignored. Two folders that happen to be mounts of one share are no
 * exception: the instance's torrents are still looked for in one of them only.
 *
 * Nested prefixes of one instance (`/data` and `/data/movies`) are NOT reported, whatever folders they
 * name. They are not ambiguous: `qbitToContainer` takes the deepest prefix, so every path has exactly
 * one translation, the nested row's under `/data/movies` and the parent's elsewhere; a box whose
 * qBittorrent mounts a second share inside its first is spelled exactly this way. Verify samples each
 * of the two as a folder of its own and fails one no completed torrent lies under.
 *
 * Only mappings that translate are considered (a `qbit` and a `qbitInstance` both set). Two rows
 * naming the same folder are not two folders, whatever else differs between them.
 */
export function shadowedPrefixes(mappings: readonly PathMapping[]): ShadowedPrefix[] {
  const folders = new Map<string, { instanceId: string; qbit: string; containers: Map<string, string> }>()
  for (const m of mappings) {
    if (m.qbit === null || m.qbitInstance === null) continue
    const qbit = prefixKey(m.qbit)
    const key = `${m.qbitInstance}\0${qbit}`
    let entry = folders.get(key)
    if (entry === undefined) {
      entry = { instanceId: m.qbitInstance, qbit, containers: new Map() }
      folders.set(key, entry)
    }
    if (!entry.containers.has(strip(m.container))) entry.containers.set(strip(m.container), m.container)
  }
  return [...folders.values()]
    .filter((e) => e.containers.size > 1)
    .sort((x, y) => (x.instanceId !== y.instanceId ? (x.instanceId < y.instanceId ? -1 : 1) : x.qbit < y.qbit ? -1 : x.qbit > y.qbit ? 1 : 0))
    .map((e) => ({ instanceId: e.instanceId, qbit: e.qbit, containers: [...e.containers.values()] }))
}

/** The operator-facing text for one shadowed prefix: the same words in Settings' problems and in Verify. */
function shadowedPrefixReason(s: ShadowedPrefix): string {
  const two = s.containers.length === 2
  return `${s.instanceId} maps ${s.qbit} to ${two ? 'two' : s.containers.length} folders (${s.containers.join(', ')}); `
    + `${two ? 'one of them probably belongs' : 'all but one of them probably belong'} to another box. `
    + `${s.instanceId}'s ${s.qbit} is one folder, so only one of these rows can ever find its torrents: `
    + `choose the right instance for the ${two ? 'other row' : 'others'}, or remove ${two ? 'it' : 'them'}`
}

/**
 * Fills qbitInstance for a mapping with qbit set and qbitInstance null ONLY when exactly one
 * instance exists; otherwise leaves it null and reports a problem. Also reports qbitInstance ids
 * that are not configured, and — once the instances are filled in — every instance that sends one
 * qBittorrent prefix to two different folders (`shadowedPrefixes`). Never mutates its input.
 *
 * With one instance there is exactly one possible owner, which is what every config written before
 * multi-instance support meant. With two there is no safe guess — both boxes may well report the
 * same prefix — so the hole stays a hole, and `torrentSourceFor` fails it closed. A shadowed prefix
 * fails closed through Verify instead: `verifyInstance` fails the instance for it, with the same
 * words, so the gate stays shut until it is fixed.
 */
export function normalizeMappings(
  mappings: PathMapping[], instanceIds: string[],
): { mappings: PathMapping[]; problems: string[] } {
  const configured = new Set(instanceIds)
  const problems: string[] = []
  const normalized = mappings.map((m): PathMapping => {
    if (m.qbit !== null && m.qbitInstance === null) {
      if (instanceIds.length === 1) return { ...m, qbitInstance: instanceIds[0]! }
      problems.push(
        `mapping ${m.container}: qBittorrent path ${m.qbit} names no instance and ${instanceIds.length} `
        + `instances are configured (${instanceIds.join(', ') || 'none'}) — choose the one that owns it`,
      )
    } else if (m.qbitInstance !== null && m.qbit === null) {
      problems.push(`mapping ${m.container}: qBittorrent instance ${m.qbitInstance} has no qBittorrent path`)
    }
    if (m.qbitInstance !== null && !configured.has(m.qbitInstance)) {
      problems.push(
        `mapping ${m.container}: qBittorrent instance "${m.qbitInstance}" is not configured `
        + `(configured: ${instanceIds.join(', ') || 'none'})`,
      )
    }
    return { ...m }
  })
  for (const shadowed of shadowedPrefixes(normalized)) problems.push(shadowedPrefixReason(shadowed))
  return { mappings: normalized, problems }
}

/** The same field order everywhere, whatever order a mapping object's own keys happen to be in. */
const canonicalMapping = (m: PathMapping): string =>
  JSON.stringify([m.role, m.jellyfin, m.container, m.qbit, m.qbitInstance])

/**
 * First 16 hex chars of sha256 over the canonical JSON of the mappings sorted by container.
 * Identifies a mapping SET: a verification result describes exactly the set it was run against,
 * and must stop counting the moment any field of any mapping changes. Ties on container (never
 * valid, but not this function's job to refuse) are broken by the whole canonical row, so input
 * order can never change the hash.
 */
export function mappingsHash(mappings: PathMapping[]): string {
  const rows = mappings.map(canonicalMapping)
  const sorted = mappings
    .map((m, i) => ({ container: m.container, row: rows[i]! }))
    .sort((a, b) => (a.container < b.container ? -1 : a.container > b.container ? 1 : a.row < b.row ? -1 : a.row > b.row ? 1 : 0))
    .map((x) => x.row)
  return createHash('sha256').update(`[${sorted.join(',')}]`).digest('hex').slice(0, 16)
}

/** One instance's half of a path-map verification (Task 4 produces these; the gate reads them). */
export interface QbitVerifyReport {
  instanceId: string
  sampled: number
  resolved: number
  failures: Array<{ qbitPath: string; reason: string }>
  /**
   * Added by the final fix wave. The instance's completed torrents that lie under none of its own
   * mapped qBittorrent prefixes (music, books, a downloads folder Jellymaid has nothing to do with):
   * never sampled and never a failure, only counted, with up to `IGNORED_EXAMPLES` of their paths.
   * Absent when there are none.
   */
  ignored?: { count: number; examples: string[] }
}
export interface QbitSampleSource { id: string; torrents: () => Promise<Torrent[]> }
export interface QbitMappingProposal { container: string; qbitInstance: string; qbit: string; support: number }

/** Torrents looked at per instance, by Verify and by Auto-detect alike, unless the caller says otherwise. */
const DEFAULT_SAMPLE_SIZE = 20

function sampleSizeOf(requested: number | undefined): number {
  // A size that could not sample anything would "verify" an instance by checking nothing.
  return requested !== undefined && Number.isFinite(requested) && requested >= 1 ? Math.floor(requested) : DEFAULT_SAMPLE_SIZE
}

const byHash = (x: Torrent, y: Torrent): number => (x.hash < y.hash ? -1 : x.hash > y.hash ? 1 : 0)

/**
 * Up to `size` FINISHED torrents (progress 1) of `torrents`, chosen by a stable spread over hash
 * order: sort by hash, then take evenly spaced entries across the whole list. Hashes are effectively
 * random with respect to what a torrent holds and where it was saved, so an even spread over their
 * order is a fair cross-section of the list — not its first twenty, which would be one tracker's
 * batch — and it is the same cross-section every time for the same list, so two runs are comparable
 * and a bad torrent cannot be dodged by running Verify again. An unfinished torrent proves nothing
 * about where finished data lives, so it is never sampled.
 */
function sampleCompleted(torrents: readonly Torrent[], size: number): Torrent[] {
  const finished = torrents.filter((t) => t.progress >= 1).sort(byHash)
  if (finished.length <= size) return finished
  return Array.from({ length: size }, (_, i) => finished[Math.floor((i * finished.length) / size)]!)
}

/**
 * Up to `size` torrents in all, dealt round-robin across `strata` (one per stratum per round, a
 * stratum that runs out dropping out of the deal), then taken from each stratum by `sampleCompleted`'s
 * stable spread. A spread over one combined list samples a folder in proportion to its share of the
 * box: a mapped folder holding two torrents among thousands would almost never be looked at, and a
 * wrong mapping for it would pass. Dealt this way every stratum with a torrent to give is sampled at
 * least once, as long as `size` reaches round to it — strata come in a fixed order, so which ones a
 * size smaller than their number leaves out is the same every run.
 */
function stratifiedSample(strata: ReadonlyArray<readonly Torrent[]>, size: number): Torrent[] {
  const quotas = strata.map(() => 0)
  let left = size
  for (let dealt = true; dealt && left > 0;) {
    dealt = false
    for (let i = 0; i < strata.length && left > 0; i += 1) {
      if (quotas[i]! < strata[i]!.length) {
        quotas[i] = quotas[i]! + 1
        left -= 1
        dealt = true
      }
    }
  }
  return strata.flatMap((stratum, i) => sampleCompleted(stratum, quotas[i]!)).sort(byHash)
}

/** The most paths a report names among the torrents it ignored. */
const IGNORED_EXAMPLES = 5

/** Where a torrent's data is, as its instance spells it: its content path, else the save path that holds it. */
const whereIs = (t: Torrent): string | null => t.contentPath ?? t.savePath

/** This instance's own qBittorrent prefixes — the ones `qbitToContainer` translates through — each once, in a fixed order. */
function prefixesOf(pathMap: PathMap, instanceId: string): string[] {
  return [...new Set(pathMap.all().filter((m) => m.qbit && m.qbitInstance === instanceId).map((m) => strip(m.qbit!)))].sort()
}

/** The deepest of `prefixes` that `path` lies under — the one whose mapping translates it — or null. */
function deepestPrefix(prefixes: readonly string[], path: string): string | null {
  let best: string | null = null
  for (const prefix of prefixes) {
    if (underPrefix(path, prefix) && (best === null || prefix.length > best.length)) best = prefix
  }
  return best
}

/**
 * Up to `IGNORED_EXAMPLES` paths among the ignored torrents: one per folder first, so the operator
 * sees which folders were passed over (music, books, downloads) rather than five albums, then the
 * rest in hash order. The same examples every run for the same list.
 */
function ignoredExamples(outside: readonly Torrent[]): string[] {
  const ordered = [...outside].sort(byHash)
  const picked: Torrent[] = []
  const folders = new Set<string>()
  for (const t of ordered) {
    if (picked.length >= IGNORED_EXAMPLES) break
    const folder = t.savePath ?? dirname(whereIs(t)!)
    if (folders.has(folder)) continue
    folders.add(folder)
    picked.push(t)
  }
  for (const t of ordered) {
    if (picked.length >= IGNORED_EXAMPLES) break
    if (!picked.includes(t)) picked.push(t)
  }
  return picked.map((t) => whereIs(t)!)
}

/**
 * States in which qBittorrent itself says a torrent's files are not where it put them. Such a
 * torrent's content path can only ever be "not found on disk", whatever the mapping says, so
 * sampling one failed every Verify, every time, with a reason that pointed at the mapping.
 */
const FILES_NOT_IN_PLACE: ReadonlySet<string> = new Set(['missingFiles', 'error'])

/** The most torrents one Verify report names as seeding into a root marked not torrent-backed. */
const NONE_ROOT_FAILURES_LISTED = 20

/** Operator-facing text for an error from a connector, short enough to sit in a stored record. */
function describeError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

/**
 * Why `target` is not what `torrent` says it is, or null when it is. It has to exist; and when the
 * torrent is a single file (qBittorrent reports an empty root path) the file there has to be exactly
 * the torrent's size. Existence alone cannot tell box A's copy from box B's when both boxes spell a
 * path the same way and both libraries happen to hold a file of that name.
 *
 * The size is compared only against a regular file. A multi-file torrent saved with no folder of its
 * own also reports an empty root path, but its content path is a directory — there is no single
 * file for the torrent's total size to be compared with.
 */
async function targetProblem(target: string, torrent: Torrent): Promise<string | null> {
  let info: Stats
  try {
    info = await stat(target)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR'
      ? `mapped to ${target} but not found on disk`
      : `mapped to ${target} but it could not be read (${code ?? 'unknown error'})`
  }
  if (torrent.rootPath === '' && info.isFile() && info.size !== torrent.sizeBytes) {
    return `mapped to ${target}, but the file there is ${info.size} bytes and qBittorrent says the torrent is ${torrent.sizeBytes} bytes`
  }
  return null
}

/**
 * Where, under a root marked "none (not torrent-backed)", this torrent's content turns up — or null.
 *
 * Such a root is one no instance is ever asked about (`instancesToAsk` in src/plan/resolve.ts), so
 * `guard.untracked` passes a file there and `guard.private-ratio` never sees a torrent to judge: a
 * torrent seeding into it is invisible to every guard, and a delete would unlink its data. The only
 * thing that can catch the mislabelled root is a torrent of the instance found there. A sample of
 * twenty cannot be trusted to land on one — a root holding a small share of an instance's torrents
 * is mostly not sampled — so every completed torrent of the instance is put through this.
 *
 * A torrent one of the instance's own mappings covers lands where that mapping translates it; the
 * question is only whether the deepest root there is a `none` one (a non-torrent folder nested in
 * the instance's root). A torrent no mapping covers is probed under every `none` root with the same
 * suffix test Auto-detect uses (`collectEvidence`): `<root>/<the last n segments>` must exist, and a
 * single file must be the torrent's size. Unmapped torrents that land under no such root (music,
 * books, anything Jellymaid never deletes) add nothing.
 */
async function noneRootLanding(
  pathMap: PathMap, instanceId: string, t: Torrent, noneRoots: readonly string[],
): Promise<{ root: string; at: string } | null> {
  if (!placeable(t)) return null
  const landing = (at: string): { root: string; at: string } | null => {
    if (pathMap.torrentSourceFor(at).kind !== 'none') return null
    return { root: pathMap.rootFor(at)!.container, at }
  }
  const translated = pathMap.qbitToContainer(instanceId, t.contentPath)
  if (translated !== null) {
    if (pathMap.torrentSourceFor(translated).kind !== 'none') return null
    return (await targetProblem(translated, t)) === null ? landing(translated) : null
  }
  const segments = t.contentPath.split('/').filter(Boolean)
  for (const root of noneRoots) {
    // Longest suffix first: the one a stray same-named folder is least likely to satisfy.
    for (let k = 1; k < segments.length; k += 1) {
      const at = join(root, ...segments.slice(k))
      if ((await targetProblem(at, t)) !== null) continue
      const found = landing(at)
      if (found !== null) return found
    }
  }
  return null
}

/**
 * Every completed torrent of the instance — the sample's error-state exclusion does not apply:
 * a torrent whose files come back would seed again — checked by `noneRootLanding`. Any hit fails
 * the report. Only the first `NONE_ROOT_FAILURES_LISTED` are named; the rest are counted in one
 * more line, so a whole mislabelled library does not become a record thousands of rows long.
 */
async function noneRootFailures(pathMap: PathMap, instanceId: string, torrents: readonly Torrent[]): Promise<QbitVerifyReport['failures']> {
  const noneRoots = [...new Set(pathMap.all().map((m) => m.container))]
    .filter((container) => pathMap.torrentSourceFor(container).kind === 'none')
  if (noneRoots.length === 0) return []
  const failures: QbitVerifyReport['failures'] = []
  let unlisted = 0
  const completed = torrents.filter((t) => t.progress >= 1).sort(byHash)
  for (const t of completed) {
    // A large instance is thousands of probes: the server keeps answering requests meanwhile.
    await yieldToEventLoop()
    const found = await noneRootLanding(pathMap, instanceId, t, noneRoots)
    if (found === null) continue
    if (failures.length >= NONE_ROOT_FAILURES_LISTED) { unlisted += 1; continue }
    failures.push({
      qbitPath: t.contentPath!,
      reason: `root ${found.root} is marked not torrent-backed, but qBittorrent instance "${instanceId}" seeds this `
        + `torrent there (${found.at}) — choose that instance for the root, or map the instance's path to it`,
    })
  }
  if (unlisted > 0) {
    failures.push({
      qbitPath: '',
      reason: `and ${unlisted} more torrents of qBittorrent instance "${instanceId}" lie in roots marked not torrent-backed`,
    })
  }
  return failures
}

/**
 * One instance's half of Verify. Its completed torrents fall into three kinds, by where each one's data
 * is (`whereIs`):
 *  - COVERED: under one of the instance's own mapped prefixes. Each belongs to the deepest such prefix,
 *    the one whose mapping translates it. These are the torrents whose files Jellymaid deletes or
 *    guards, so these are what the sample is drawn from (`stratifiedSample`, one stratum per prefix).
 *  - OUTSIDE: under none of them. Music, books, a downloads folder: no path of the library is ever
 *    attributed to this instance through them, so no guard asks this instance about them and no
 *    delete of Jellymaid's touches them through its mapping. Counted in `ignored`, never failed. A
 *    torrent whose data really sits in a root marked not torrent-backed is still caught, by
 *    `noneRootFailures`, which looks at every completed torrent whatever its kind.
 *  - UNPLACED: reports neither a content path nor a save path. Nothing says it lies outside, so it is
 *    not ignored: one or more of these fails the report.
 *
 * Failing, besides a sampled torrent that does not check out:
 *  - a prefix the instance's mappings send to two different folders (`shadowedPrefixes`), whatever
 *    its torrents say — listed first, so the gate names it. The sample cannot catch it: the row that
 *    translates checks out, and the other one is never used;
 *  - a prefix no completed torrent lies under, while the instance has completed torrents — the
 *    mapping translates nothing, which is a mistyped prefix far more often than an empty folder;
 *  - a prefix whose completed torrents are all `missingFiles` or `error` — none could be checked,
 *    which is not "nothing to check";
 *  - any unplaced torrent.
 */
async function verifyInstance(pathMap: PathMap, instance: QbitSampleSource, size: number): Promise<QbitVerifyReport> {
  // A fact about the mappings alone: it fails the instance even when there is no torrent to sample,
  // or no list to sample from.
  const shadowed = shadowedPrefixes(pathMap.all())
    .filter((s) => s.instanceId === instance.id)
    .map((s) => ({ qbitPath: s.qbit, reason: shadowedPrefixReason(s) }))
  let torrents: Torrent[]
  try {
    torrents = await instance.torrents()
  } catch (err) {
    // NOT "no completed torrents". That would be reported as sampled 0 with no failures, which the
    // gate reads as a clean pass for an instance nobody could even ask.
    return {
      instanceId: instance.id, sampled: 0, resolved: 0,
      failures: [...shadowed, { qbitPath: '', reason: `could not list torrents: ${describeError(err)}` }],
    }
  }
  const failures: QbitVerifyReport['failures'] = [...shadowed]
  const completed = torrents.filter((t) => t.progress >= 1)
  const prefixes = prefixesOf(pathMap, instance.id)
  const held = new Map<string, Torrent[]>(prefixes.map((p) => [p, []]))
  const outside: Torrent[] = []
  let unplaced = 0
  for (const t of completed) {
    const at = whereIs(t)
    if (at === null) { unplaced += 1; continue }
    const prefix = deepestPrefix(prefixes, at)
    if (prefix === null) outside.push(t)
    else held.get(prefix)!.push(t)
  }

  if (completed.length > 0) {
    for (const prefix of prefixes) {
      // Under the prefix at all, deeper prefixes included: a parent row whose torrents all sit in a
      // nested row's folder is not a typo.
      if (completed.some((t) => { const at = whereIs(t); return at !== null && underPrefix(at, prefix) })) continue
      failures.push({
        qbitPath: prefix,
        reason: `no completed torrent of "${instance.id}" reports a path under ${prefix} — check the qBittorrent path`,
      })
    }
  }

  const strata: Torrent[][] = []
  for (const [prefix, mine] of held) {
    // qBittorrent itself says these files are not where it put them: whatever the mapping says, the
    // path can only come back "not found on disk", so they are left out of the sample.
    const inPlace = mine.filter((t) => !FILES_NOT_IN_PLACE.has(t.state))
    if (mine.length > 0 && inPlace.length === 0) {
      // Not "nothing to check" (sampled 0, no failures — a clean pass at the gate): there is plenty
      // to check under this prefix, and none of it can be, until qBittorrent finds its files again.
      const states = [...new Set(mine.map((t) => t.state))].sort()
      failures.push({
        qbitPath: prefix,
        reason: `every completed torrent under ${prefix} is in a state where qBittorrent cannot find its files `
          + `(${states.join(', ')}), so none could be checked — fix them in qBittorrent (recheck, or set the location), then verify again`,
      })
    }
    strata.push(inPlace)
  }

  if (unplaced > 0) {
    failures.push({
      qbitPath: '',
      reason: `${unplaced} completed torrent${unplaced === 1 ? ' reports' : 's report'} neither a content path nor a save path, `
        + `so Verify cannot tell whether a mapped folder holds ${unplaced === 1 ? 'it' : 'them'}`,
    })
  }

  const sample = stratifiedSample(strata, size)
  let resolved = 0
  for (const t of sample) {
    if (t.contentPath === null) {
      // Placed by its save path, which is under a mapped prefix: there is no file to check it by.
      failures.push({ qbitPath: t.savePath ?? '', reason: 'qBittorrent reported no content path for this torrent' })
      continue
    }
    // Only THIS instance's mappings: see PathMap.qbitToContainer. A covered torrent always has one;
    // should it not, that is a failure, never a pass.
    const target = pathMap.qbitToContainer(instance.id, t.contentPath)
    if (target === null) {
      failures.push({ qbitPath: t.contentPath, reason: `no mapping covers this path for instance "${instance.id}"` })
      continue
    }
    const problem = await targetProblem(target, t)
    if (problem === null) resolved += 1
    else failures.push({ qbitPath: t.contentPath, reason: problem })
  }
  failures.push(...await noneRootFailures(pathMap, instance.id, torrents))
  const report: QbitVerifyReport = { instanceId: instance.id, sampled: sample.length, resolved, failures }
  if (outside.length > 0) report.ignored = { count: outside.length, examples: ignoredExamples(outside) }
  return report
}

/**
 * The qBittorrent half of a path-map verification. Per instance (`verifyInstance` has the details):
 *  - only torrents under one of THAT instance's own mapped prefixes are sampled: up to `sampleSize`
 *    (default 20) finished ones, dealt round-robin across its prefixes so every mapped folder is
 *    looked at, each folder's share taken by a stable spread over hash order, leaving out those
 *    qBittorrent reports as `missingFiles` or `error`. Each one's content path must map to a container
 *    path through that instance's mappings, and that path must exist (a single-file torrent's file
 *    must also be the torrent's size);
 *  - finished torrents under none of its prefixes are not failures: they are counted in `ignored`;
 *  - a prefix its mappings send to two different folders fails, whatever its torrents say: only one
 *    of the rows can ever translate, and the other is usually another box's row with this box's name;
 *  - a prefix no finished torrent lies under fails (a mistyped prefix translates nothing), and so does
 *    a prefix whose finished torrents are all `missingFiles` or `error` (none could be checked);
 *  - EVERY finished torrent is checked against the roots marked not torrent-backed
 *    (`noneRootFailures`): one found there fails the report, because no guard would ever see it.
 *
 * Reports come back in the order of `instances`, one per instance. An instance that could not be
 * asked reports a failure rather than an empty sample. One with no finished torrents, or with
 * finished torrents only outside every folder and no mapping of its own, reports sampled 0 with no
 * failures (unless one of its prefixes goes to two folders) — a legitimate answer (nothing of it to
 * translate), the other is not, and the gate tells them apart by exactly this.
 */
export async function verifyQbitMappings(deps: {
  pathMap: PathMap
  instances: QbitSampleSource[]
  sampleSize?: number
}): Promise<QbitVerifyReport[]> {
  const size = sampleSizeOf(deps.sampleSize)
  // Different boxes, independent answers: one slow instance must not make the rest wait for it.
  return Promise.all(deps.instances.map((instance) => verifyInstance(deps.pathMap, instance, size)))
}

/**
 * A torrent Auto-detect can reason from: its content path must be an absolute, already-normalized
 * POSIX path. A mapping prefix cannot even be written for another OS's spelling (`D:\Media`), and a
 * path with `.` or `..` segments would send a probe outside the container it is being tried under.
 */
function placeable(t: Torrent): t is Torrent & { contentPath: string } {
  if (t.contentPath === null || !t.contentPath.startsWith('/')) return false
  return !t.contentPath.split('/').some((segment) => segment === '.' || segment === '..')
}

/** One turn of the event loop, whatever else is queued behind it. */
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** Finds `key` in `map`, adding `make()` first when it is not there yet. */
function entry<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  let value = map.get(key)
  if (value === undefined) {
    value = make()
    map.set(key, value)
  }
  return value
}

/** container -> instance id -> qbit prefix -> how many sampled torrents found the container at that prefix. */
type Evidence = Map<string, Map<string, Map<string, number>>>

/**
 * For each instance's sampled torrents, where under each root their files turn up. For a torrent whose
 * content path is `/a/b/c/Release`, a root C and a split after `k` segments, the question is whether
 * `C/<the rest>` exists (and, for a single file, is the torrent's size): if `C/c/Release` does, then C
 * is where this instance's `/a/b` lives. The first split that fits wins for that torrent, so the
 * LONGEST corroborated suffix decides — a short suffix is the one a stray same-named folder satisfies
 * by accident. The prefix is never empty: "/" cannot be written as a mapping prefix.
 *
 * A torrent that more than one instance reports is skipped: the same release cross-seeded from both
 * boxes sits in both libraries, so the file system alone cannot say whose it is, and counting it would
 * make every root look shared. An instance that could not be asked (`torrents: null`) adds nothing.
 *
 * Each torrent hands the event loop a turn before it is probed, and every probe goes through the
 * thread pool, so the server keeps answering requests while a large library is searched.
 */
async function collectEvidence(
  roots: string[], lists: Array<{ id: string; torrents: Torrent[] | null }>, size: number,
): Promise<Evidence> {
  const reportedBy = new Map<string, number>()
  for (const { torrents } of lists) {
    for (const hash of new Set((torrents ?? []).map((t) => t.hash))) reportedBy.set(hash, (reportedBy.get(hash) ?? 0) + 1)
  }
  const evidence: Evidence = new Map()
  for (const { id, torrents } of lists) {
    if (torrents === null) continue
    const sample = sampleCompleted(torrents.filter((t) => (reportedBy.get(t.hash) ?? 0) < 2 && placeable(t)), size)
    for (const t of sample) {
      await yieldToEventLoop()
      const segments = t.contentPath!.split('/').filter(Boolean)
      for (const root of roots) {
        for (let k = 1; k < segments.length; k += 1) {
          if ((await targetProblem(join(root, ...segments.slice(k)), t)) !== null) continue
          const votes = entry(entry(evidence, root, () => new Map()), id, () => new Map<string, number>())
          const prefix = `/${segments.slice(0, k).join('/')}`
          votes.set(prefix, (votes.get(prefix) ?? 0) + 1)
          break
        }
      }
    }
  }
  return evidence
}

/**
 * A root gets a proposal only when the evidence for it is unambiguous: exactly one instance has
 * torrents under it (two boxes that both fit a root cannot be told apart by looking at the disk — the
 * operator chooses), and one prefix is backed by more torrents than any other (an even split is
 * conflicting evidence, not a coin to toss).
 */
function decide(roots: string[], evidence: Evidence): QbitMappingProposal[] {
  const proposals: QbitMappingProposal[] = []
  for (const root of roots) {
    const byInstance = evidence.get(root)
    if (byInstance === undefined || byInstance.size !== 1) continue
    const [[qbitInstance, votes]] = [...byInstance] as [[string, Map<string, number>]]
    const ranked = [...votes].sort((x, y) => y[1] - x[1])
    if (ranked.length > 1 && ranked[0]![1] === ranked[1]![1]) continue
    const [qbit, support] = ranked[0]!
    proposals.push({ container: root, qbitInstance, qbit, support })
  }
  return proposals
}

/**
 * One box's `/movies` is one folder, so two roots claiming the same (instance, prefix) cannot both be
 * right. The root with clearly the most evidence keeps it; on a tie neither does.
 */
function withoutRivals(proposals: QbitMappingProposal[]): QbitMappingProposal[] {
  const claims = new Map<string, QbitMappingProposal[]>()
  for (const p of proposals) entry(claims, `${p.qbitInstance}\0${p.qbit}`, () => []).push(p)
  return proposals.filter((p) => {
    const rivals = claims.get(`${p.qbitInstance}\0${p.qbit}`)!
    if (rivals.length === 1) return true
    const best = Math.max(...rivals.map((r) => r.support))
    return p.support === best && rivals.filter((r) => r.support === best).length === 1
  })
}

/**
 * Proposes `{ qbit, qbitInstance }` for the mapping containers in `mappings`, from where each
 * instance's finished torrents actually are (see `collectEvidence`, `decide`, `withoutRivals` for the
 * rules). A proposal is a suggestion for the operator to review, not a change: an instance that cannot
 * be asked adds no evidence either way, and the verification that follows catches a proposal that
 * turns out wrong. A wrong mapping is far more dangerous than an absent one, so every doubt resolves
 * to "no proposal".
 *
 * Containers are used, and handed back, exactly as the caller spelled them: the caller matches a
 * proposal to its mapping by that string. With no container on disk to place anything against, no
 * instance is asked for its torrents at all.
 */
export async function autoDetectQbitMappings(deps: {
  mappings: PathMapping[]
  instances: QbitSampleSource[]
  sampleSize?: number
}): Promise<QbitMappingProposal[]> {
  const roots: string[] = []
  for (const container of new Set(deps.mappings.map((m) => m.container))) {
    if (await isDirectory(container)) roots.push(container)
  }
  if (roots.length === 0) return []

  const lists = await Promise.all(deps.instances.map(async (instance) => {
    try {
      return { id: instance.id, torrents: await instance.torrents() }
    } catch {
      return { id: instance.id, torrents: null }
    }
  }))
  return withoutRivals(decide(roots, await collectEvidence(roots, lists, sampleSizeOf(deps.sampleSize))))
}

export interface SampledItem { id: string; jfPath: string }

export interface VerifyReport {
  sampled: number
  resolved: number
  failures: Array<{ jellyfinPath: string; reason: string }>
}

export async function verifyMappings(deps: {
  mappings: PathMapping[]
  sampleItems: () => Promise<SampledItem[]>
}): Promise<VerifyReport> {
  const map = createPathMap(deps.mappings)
  const items = await deps.sampleItems()
  const failures: VerifyReport['failures'] = []
  let resolved = 0
  for (const item of items) {
    const container = map.toContainer(item.jfPath)
    if (!container) {
      failures.push({ jellyfinPath: item.jfPath, reason: 'no mapping covers this path' })
      continue
    }
    if (!(await exists(container))) {
      failures.push({ jellyfinPath: item.jfPath, reason: `mapped to ${container} but not found on disk` })
      continue
    }
    resolved += 1
  }
  return { sampled: items.length, resolved, failures }
}

/** At least this many trailing path segments must be corroborated on disk before a candidate
 * directory counts as evidence — a single matching filename is not enough (it could be any file
 * with that name), but a matching directory-plus-filename pair is. */
const MIN_CORROBORATED_SEGMENTS = 2

/**
 * Proposes mappings by taking sampled Jellyfin paths and searching the mounts for a directory
 * whose contents corroborate a suffix of the path. The only floor is
 * `MIN_CORROBORATED_SEGMENTS`: there is deliberately no floor on how many segments remain in the
 * Jellyfin root. A single bind-mounted library — Jellyfin sees `/movies/Heat (1995)/Heat.mkv`
 * with `/movies` itself as the mount, a 1-segment root — is this project's most common real
 * deployment shape (single-bind-mount Docker/Unraid setups); requiring a 2+-segment root would
 * silently propose nothing for it.
 *
 * Because every real ancestor directory of a sampled file trivially corroborates *some* suffix
 * (the whole point of it being a real ancestor), multiple candidate splits are always "valid" in
 * isolation. This resolves the ambiguity by always preferring the DEEPEST (longest) possible
 * Jellyfin root: splits are tried longest-root-first (across every mount and candidate
 * directory) and the first one satisfied wins, so shallower/coarser roots for the same item are
 * never even considered once a deeper one matches.
 *
 * Known limit, by design: a truly flat layout with fewer than `MIN_CORROBORATED_SEGMENTS`
 * segments below the root (e.g. `/movies/Heat.mkv`, where corroboration would rest on the bare
 * filename alone) still proposes nothing — not enough evidence to guess a root from.
 *
 * Proposes nothing when no candidate satisfies the floor — a wrong mapping is far more dangerous
 * than an absent one. For the same reason, two sampled items that agree on a Jellyfin root but
 * disagree on its container produce NO proposal for that root: silently letting the last item win
 * would emit a mapping that is wrong for at least one of them.
 */
export async function autoDetectMappings(deps: {
  mountRoots: string[]
  sampleItems: () => Promise<SampledItem[]>
  maxDepth?: number
  /** Directory enumeration seam; injected in tests to assert each mount is walked exactly once. */
  walk?: (root: string, maxDepth: number) => string[] | Promise<string[]>
}): Promise<PathMapping[]> {
  const maxDepth = deps.maxDepth ?? 4
  const walk = deps.walk ?? walkDirs
  const items = await deps.sampleItems()
  const proposals = new Map<string, PathMapping>()
  const conflicted = new Set<string>()

  // Each mount is enumerated ONCE per call, not once per item per candidate split. Re-walking it
  // inside the loops blocked the event loop for seconds on a real library (~1.4s for 2,500
  // directories, and the walk ran once per item per split), freezing every other request including
  // an in-progress scan.
  const dirCache = new Map<string, string[]>()
  const dirsUnder = async (mount: string): Promise<string[]> => {
    let dirs = dirCache.get(mount)
    if (dirs === undefined) {
      dirs = await walk(mount, maxDepth)
      dirCache.set(mount, dirs)
    }
    return dirs
  }

  for (const item of items) {
    const parts = item.jfPath.split('/').filter(Boolean)
    const maxStart = parts.length - MIN_CORROBORATED_SEGMENTS
    if (maxStart < 1) continue // not enough segments to keep both a root and the corroboration floor

    let found: PathMapping | undefined
    findDeepestRoot: for (let start = maxStart; start >= 1; start -= 1) {
      const suffix = parts.slice(start)
      for (const mount of deps.mountRoots) {
        const dirs = await dirsUnder(mount)
        const at = await firstMatch(dirs, (candidateDir) => exists(join(candidateDir, ...suffix)))
        if (at === -1) continue
        found = {
          role: 'library', jellyfin: `/${parts.slice(0, start).join('/')}`, container: dirs[at]!,
          qbit: null, qbitInstance: null,
        }
        break findDeepestRoot
      }
    }
    if (!found) continue

    const root = found.jellyfin!
    const prior = proposals.get(root)
    if (prior && prior.container !== found.container) {
      // Two items place the same Jellyfin root in two different containers. At most one can be
      // right and we cannot tell which, so propose neither and let the operator decide.
      conflicted.add(root)
      proposals.delete(root)
      continue
    }
    if (!conflicted.has(root)) proposals.set(root, found)
  }
  return [...proposals.values()]
}

/**
 * Every directory under `root` (itself included) down to `maxDepth` levels, parents before their
 * children, hidden entries skipped. A symlink to a directory is followed (a dangling one is not a
 * directory), and the depth limit is what ends a symlink loop.
 *
 * Asynchronous on purpose. The walk it replaces was a recursive readdirSync/statSync over a whole
 * media mount, which on a real library held the event loop for seconds (~1.4s for 2,500
 * directories): every other request, an in-progress scan's progress included, stood still until it
 * returned. Each readdir here is a round trip through the thread pool, so the loop keeps serving
 * between directories. Entries come back with their type, so a directory costs one call rather than
 * one per child; only a symlink needs the extra stat to learn what it points at.
 *
 * A root that does not exist has no directories. A directory that cannot be read is listed but not
 * descended into.
 */
export async function walkDirs(root: string, maxDepth: number): Promise<string[]> {
  if (!(await exists(root))) return []
  const out: string[] = []
  const visit = async (dir: string, depth: number): Promise<void> => {
    out.push(dir)
    if (depth >= maxDepth) return
    let entries: Dirent[]
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const child = join(dir, entry.name)
      if (entry.isDirectory() || (entry.isSymbolicLink() && await isDirectory(child))) await visit(child, depth + 1)
    }
  }
  await visit(root, 0)
  return out
}

/** `fs.existsSync`, without holding the event loop on a slow or hung mount. */
const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false)

const isDirectory = (path: string): Promise<boolean> => stat(path).then((st) => st.isDirectory(), () => false)

/**
 * Candidates are probed this many at a time. Awaited one by one, an async stat costs ~70µs against
 * ~6µs for the synchronous call (measured), which turns a search over a few thousand directories per
 * sampled item into many seconds; side by side the thread pool is kept busy and it is ~25µs. Wide
 * enough for that, narrow enough that a search which finds its answer early wastes little.
 */
const PROBE_BATCH = 32

/**
 * Index of the FIRST item `test` accepts, or -1. Probed `PROBE_BATCH` at a time, but the answer is
 * always the first accepting item in list order — exactly what testing them one by one would give —
 * because which candidate directory wins can decide which container a mapping is proposed for.
 */
async function firstMatch<T>(items: readonly T[], test: (item: T) => Promise<boolean>): Promise<number> {
  for (let i = 0; i < items.length; i += PROBE_BATCH) {
    const accepted = await Promise.all(items.slice(i, i + PROBE_BATCH).map(test))
    const hit = accepted.indexOf(true)
    if (hit !== -1) return i + hit
  }
  return -1
}
