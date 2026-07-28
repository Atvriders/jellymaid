const RELEASE_TOKENS = new Set([
  '1080p', '720p', '480p', '2160p', '4k', 'uhd', 'hdr', 'hdr10', 'dv', 'sdr',
  'bluray', 'blu', 'ray', 'bdrip', 'brrip', 'dvdrip', 'webrip', 'web', 'webdl', 'hdtv', 'remux',
  'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'xvid', 'divx', 'av1',
  'aac', 'ac3', 'dts', 'hd', 'ma', 'truehd', 'atmos', 'ddp', 'dd', 'eac3', 'flac',
  'proper', 'repack', 'internal', 'limited', 'extended', 'unrated', 'imax', 'directors', 'cut',
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
  s = s.replace(/-[a-z0-9]+\s*$/i, ' ')                             // -GROUP suffix
  s = s.replace(/[._]/g, ' ')
  s = s.replace(/[^a-z0-9\s]/g, ' ')

  const tokens = s.split(/\s+/).filter(Boolean)
  const kept: string[] = []
  let brokeOnReleaseToken = false
  for (const t of tokens) {
    if (RELEASE_TOKENS.has(t)) {
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

  // "Matrix, The" is the same film as "The Matrix": drop a leading or trailing article.
  while (kept.length > 1 && ARTICLES.has(kept[kept.length - 1]!)) kept.pop()
  while (kept.length > 1 && ARTICLES.has(kept[0]!)) kept.shift()
  if (kept.length === 1 && ARTICLES.has(kept[0]!)) return ''

  return kept.join(' ').trim()
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
