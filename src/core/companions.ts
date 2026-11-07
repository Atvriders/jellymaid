import type { FileConfig } from '../config/schema.js'

export type CompanionConfig = Pick<FileConfig, 'mediaExtensions' | 'rules'>

type JunkRules = FileConfig['rules']['fs.junk']

interface Compiled {
  /** The lists this was compiled from, compared by identity on every lookup (see `compiled`). */
  mediaExtensions: readonly string[]
  junk: JunkRules
  media: Set<string>
  junkDirs: Set<string>
  patterns: RegExp[]
}

/**
 * One compiled form per config object. `guard.torrent-scope` classifies every file of every matched
 * torrent, all against one config snapshot, so rebuilding two sets and recompiling every name
 * pattern per file was the whole cost of a classification. Weak, so a config replaced by an edit is
 * collected along with its compiled form.
 */
const compiledByConfig = new WeakMap<object, Compiled>()

function compiled(config: CompanionConfig): Compiled {
  const junk = config.rules['fs.junk']
  const hit = compiledByConfig.get(config)
  // Re-checked by identity, not trusted: a caller that swaps a new list onto the same object (an
  // edited copy that was mutated rather than rebuilt) is served the new list, not the old compile.
  if (hit && hit.mediaExtensions === config.mediaExtensions && hit.junk === junk) return hit
  const fresh: Compiled = {
    mediaExtensions: config.mediaExtensions,
    junk,
    media: new Set(config.mediaExtensions.map((e) => e.toLowerCase())),
    junkDirs: new Set(junk.directoryNames.map((d) => d.toLowerCase())),
    patterns: junk.namePatterns.map(compile).filter((p): p is RegExp => p !== null),
  }
  compiledByConfig.set(config, fresh)
  return fresh
}

/** The lowercased extension, with its dot. A leading dot (".nfo" as a whole name) is a hidden file
 * with no extension, as path.extname says. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

/**
 * True when the file travels with its release rather than being the release itself: its extension
 * (lowercased, with dot) is not in `mediaExtensions`, OR any directory segment of `relPath`
 * (lowercased) is in rules['fs.junk'].directoryNames, OR its basename matches any
 * rules['fs.junk'].namePatterns (case-insensitive). `Sample/sample.mkv` → true; `Movie.mkv` → false.
 *
 * `relPath` must be the path RELATIVE TO THE TORRENT (a file list's own `relPath`), never a
 * container path: every directory segment is tested against the junk directory names, so the
 * mount's own ancestors (a share that happens to be called `proof`, say) would turn every file
 * under it into a companion.
 *
 * The two ways to be wrong are not equally bad. Calling a media file a companion is the dangerous
 * one — a torrent-scope check stops counting it as a file the plan would take without naming it —
 * so anything this cannot evaluate (an unparseable name pattern) counts towards "media".
 */
export function isCompanionFile(relPath: string, config: CompanionConfig): boolean {
  const rules = compiled(config)
  const segments = relPath.split('/').filter((s) => s.length > 0)
  const name = segments.at(-1) ?? ''
  if (!rules.media.has(extensionOf(name))) return true
  if (segments.slice(0, -1).some((dir) => rules.junkDirs.has(dir.toLowerCase()))) return true
  return rules.patterns.some((pattern) => pattern.test(name))
}

/**
 * Which of ONE torrent's files are companions for `guard.torrent-scope` — files that may go with the
 * release without the plan naming them. Index-aligned with `files`.
 *
 * A file with no media extension (an .nfo, a subtitle) is a companion whenever `isCompanionFile`
 * says so, which C2 makes "always". A MEDIA-extension file is a companion only when
 * `isCompanionFile` says so AND it is under a tenth of the torrent's largest media-extension file
 * (Ruling 11). The default `sample` name pattern also matches a film called "Sample City", and the
 * name alone would let a pack holding it go as a sidecar of something else; a real sample is a
 * sliver of its film, and no film is a tenth of the largest film in its own torrent. A size nobody
 * reported reads as 0 — which IS under a tenth of any film beside it, so it is excluded by name: an
 * unknown size is never taken as small, and such a file counts as media.
 */
export function companionFlags(
  files: ReadonlyArray<{ relPath: string; sizeBytes: number }>,
  config: CompanionConfig,
): boolean[] {
  const rules = compiled(config)
  const isMedia = files.map((f) => rules.media.has(extensionOf(f.relPath.split('/').at(-1) ?? '')))
  // A loop, not Math.max(...sizes): a pack with tens of thousands of files would overflow the stack.
  let largestMedia = 0
  files.forEach((f, i) => {
    if (isMedia[i] && f.sizeBytes > largestMedia) largestMedia = f.sizeBytes
  })
  return files.map((f, i) => {
    if (!isCompanionFile(f.relPath, config)) return false
    if (!isMedia[i]) return true
    return f.sizeBytes > 0 && f.sizeBytes * 10 < largestMedia
  })
}

/** The same case-insensitive compile the fs.junk rule applies; null for a pattern that cannot compile. */
function compile(source: string): RegExp | null {
  try {
    return new RegExp(source, 'i')
  } catch {
    return null
  }
}
