// Tokens that are never words in a real title: resolutions, sources, codecs, audio codecs.
// Safe to break on wherever they appear (after the first token — see below).
const UNAMBIGUOUS_RELEASE_TOKENS = new Set([
  '1080p', '720p', '480p', '2160p', '4k',
  'bluray', 'bdrip', 'brrip', 'dvdrip', 'webrip', 'webdl', 'hdtv', 'remux',
  'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'xvid', 'divx', 'av1',
  'aac', 'ac3', 'dts', 'truehd', 'atmos', 'eac3', 'flac', 'ddp',
])

// Tokens that ARE ordinary English words ("Cut", "Internal", "Extended", "HD", ...). These only
// signal a release name when the input already looks like a filename — otherwise "Internal
// Affairs" and "Cut Bank" would collapse to nothing.
const AMBIGUOUS_RELEASE_TOKENS = new Set([
  'cut', 'extended', 'internal', 'limited', 'proper', 'repack', 'unrated', 'imax', 'directors',
  'hd', 'ma', 'dd', 'dv', 'sdr', 'hdr', 'hdr10', 'uhd', 'web', 'blu', 'ray',
])

const ARTICLES = new Set(['the', 'a', 'an'])

/**
 * Collapses a display or filename title to a comparison key.
 *
 * The subtle rule is the trailing year. "Heat.1995.1080p..." must lose its year, but
 * "Blade Runner 2049" must keep it — the year IS the title. The tell is whether the
 * string looks like a release name at all: dot/underscore separators, or a release
 * token we broke on. A clean display title keeps every token.
 */
export function normalizeTitle(raw: string): string {
  const looksLikeFilename = /[._]/.test(raw)

  let s = raw.normalize('NFKD').replace(/[̀-ͯ]/g, '')     // strip diacritics
  s = s.toLowerCase()
  s = s.replace(/\[[^\]]*\]/g, ' ')                                 // [1080p]
  s = s.replace(/\((?:19|20)\d{2}\)/g, ' ')                         // (1995)
  if (looksLikeFilename) {
    // A scene-group suffix only ever appears in a filename; on a bare display title a
    // trailing "-word" is just a hyphenated word ("Spider-Man", "X-Men").
    s = s.replace(/-[a-z0-9]+\s*$/i, ' ')                           // -GROUP suffix
  }
  s = s.replace(/[._]/g, ' ')
  s = s.replace(/[^\p{L}\p{N}\s]/gu, ' ')                           // keep all-script letters/digits

  const tokens = s.split(/\s+/).filter(Boolean)
  const kept: string[] = []
  let brokeOnReleaseToken = false
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!
    // If the very FIRST token is a release word, the string isn't a release name at all —
    // keep everything ("Internal Affairs", "Cut Bank", "The Limited" must not evaporate).
    const canBreakHere = i > 0
    const isUnambiguous = UNAMBIGUOUS_RELEASE_TOKENS.has(t)
    const isAmbiguous = looksLikeFilename && AMBIGUOUS_RELEASE_TOKENS.has(t)
    if (canBreakHere && (isUnambiguous || isAmbiguous)) {
      // Everything after the first release token is scene noise.
      brokeOnReleaseToken = true
      break
    }
    kept.push(t)
  }

  if ((looksLikeFilename || brokeOnReleaseToken) && kept.length > 1) {
    const last = kept[kept.length - 1]!
    if (/^(?:19|20)\d{2}$/.test(last)) kept.pop()
  }

  // "Matrix, The" is the same film as "The Matrix": drop at most one leading or trailing
  // article — never both loops away, or "The A Word" loses "A" too and collides with "Word".
  if (kept.length > 1 && ARTICLES.has(kept[kept.length - 1]!)) kept.pop()
  if (kept.length > 1 && ARTICLES.has(kept[0]!)) kept.shift()
  if (kept.length === 1 && ARTICLES.has(kept[0]!)) return ''

  return kept.join(' ').trim()
}

/**
 * The editions `editionOf` recognises, in the one order a label lists them. Each pattern runs on a
 * segment flattened to lowercase words (apostrophes dropped, every other separator a space), so
 * `Directors.Cut`, `Director's Cut` and `DIRECTORS_CUT` read alike, and `\b` keeps "Ultimatum" from
 * reading as "Ultimate".
 */
const EDITIONS: ReadonlyArray<readonly [label: string, pattern: RegExp]> = [
  ['Extended', /\bextended\b/],
  ["Director's Cut", /\bdirectors? cut\b/],
  ['Unrated', /\bunrated\b/],
  ['Theatrical', /\btheatrical\b/],
  ['IMAX', /\bimax\b/],
  ['Final Cut', /\bfinal cut\b/],
  ['Ultimate', /\bultimate\b/],
  ['Special Edition', /\bspecial edition\b/],
  ['Remastered', /\bremaster(?:ed)?\b/],
  ['Criterion', /\bcriterion\b/],
]

function editionsIn(segment: string): string | null {
  const words = segment.toLowerCase().replace(/['’‘`ʼ]/g, '').replace(/[^a-z0-9]+/g, ' ')
  const found = EDITIONS.filter(([, pattern]) => pattern.test(words)).map(([label]) => label)
  return found.length ? found.join(', ') : null
}

/**
 * The edition a release names — "Extended", "Director's Cut", … — or null when it names none.
 *
 * Every edition named is listed, comma-joined in `EDITIONS` order, rather than only the first: a
 * "Remastered Director's Cut" is not the same release as a plain "Director's Cut", and collapsing it
 * would make two different cuts compare equal, which is the one mistake `editionsDiffer` exists to
 * prevent. A path is read by its file name first, then by its release folder (a torrent's video file
 * is often named `grp-aliens-1080p.mkv` inside `Aliens.1986.Special.Edition.1080p/`); folders above
 * that are libraries and shows, not releases, and are not read.
 */
export function editionOf(nameOrPath: string): string | null {
  const segments = nameOrPath.split('/').filter(Boolean)
  for (const segment of segments.slice(-2).reverse()) {
    const found = editionsIn(segment)
    if (found) return found
  }
  return null
}

/**
 * `S01E01E02`, `S01E01-E02`, `S01E01-02` or `S01E01-S01E02`, and the `1x01x02`, `1x01-02` and
 * `1x01-1x02` spellings: the season/episode token followed by a second, higher episode number. The
 * end number must not run into another digit or a `p` (so `S01E01-1080p`, `S01E01-720p` and
 * `S01E01-2019` are a resolution and a year, not episode 1080, 720 or 201), and the token must not
 * start mid-word (so a `1920x1080` frame size never reads as season 20).
 */
const MULTI_EPISODE =
  /(?<![a-z0-9])(?:s\d{1,4}e(\d{1,3})(?:-?e|-s\d{1,4}e|-)(\d{1,3})|\d{1,2}x(\d{1,3})(?:-\d{1,2}x|x|-)(\d{1,3}))(?![\dp])/gi

/**
 * Whether a file holds more than one episode, judged from its own file name (the last path
 * segment) only — a season-pack folder named `Show.S01E01-E10` holds single episodes. Jellyfin
 * knows the range (`IndexNumberEnd`) but the index does not keep it, so the name is the evidence.
 */
export function isMultiEpisodeFile(nameOrPath: string): boolean {
  const name = nameOrPath.slice(nameOrPath.lastIndexOf('/') + 1)
  for (const m of name.matchAll(MULTI_EPISODE)) {
    const [first, last] = m[1] !== undefined ? [m[1], m[2]] : [m[3], m[4]]
    if (Number(last) > Number(first)) return true
  }
  return false
}

function trigrams(s: string): Set<string> {
  const padded = `  ${s} `
  const out = new Set<string>()
  for (let i = 0; i < padded.length - 2; i += 1) out.add(padded.slice(i, i + 3))
  return out
}

export function trigramSimilarity(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1
  const ta = trigrams(a)
  const tb = trigrams(b)
  let shared = 0
  for (const g of ta) if (tb.has(g)) shared += 1
  return (2 * shared) / (ta.size + tb.size)
}
