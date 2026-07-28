import { describe, it, expect } from 'vitest'
import { normalizeTitle, trigramSimilarity } from '../../src/rules/normalize.js'

describe('normalizeTitle', () => {
  const cases: Array<[string, string]> = [
    ['Heat', 'heat'],
    ['The Matrix', 'matrix'],
    ['A Quiet Place', 'quiet place'],
    ['Heat (1995)', 'heat'],
    ['Heat.1995.1080p.BluRay.x264-GROUP', 'heat'],
    ['Heat 1995 2160p UHD BluRay REMUX HDR HEVC DTS-HD MA 5.1-FraMeSToR', 'heat'],
    ['Spider-Man: No Way Home', 'spider man no way home'],
    ['WALL·E', 'wall e'],
    ['Amélie', 'amelie'],
    ['Mission: Impossible — Fallout', 'mission impossible fallout'],
    ['   Extra   Spaces   ', 'extra spaces'],
    ['Blade Runner 2049', 'blade runner 2049'],
    // Ambiguous release-token words that are also ordinary English words: only a
    // filename-shaped string may break on these, and never at token index 0.
    ['Internal Affairs', 'internal affairs'],
    ['Cut Bank', 'cut bank'],
    ['The Cut', 'cut'],
    ['Extended Family', 'extended family'],
    ['The Final Cut', 'final cut'],
    // A bare hyphen in a display title is part of the word, not a scene-group suffix.
    ['Spider-Man', 'spider man'],
    ['X-Men', 'x men'],
    // Drop at most one leading article, never chain into a second one.
    ['The A Word', 'a word'],
  ]
  for (const [input, expected] of cases) {
    it(`normalizes ${JSON.stringify(input)}`, () => expect(normalizeTitle(input)).toBe(expected))
  }

  it('keeps a year that is part of the title, but strips a trailing release year', () => {
    expect(normalizeTitle('2012 (2009)')).toBe('2012')
    expect(normalizeTitle('Blade Runner 2049 (2017)')).toBe('blade runner 2049')
  })

  it('returns an empty string for input that is only noise', () => {
    expect(normalizeTitle('(2019) [1080p]')).toBe('')
  })

  it('does not fold "Spider-Man" onto the unrelated film "Spider"', () => {
    expect(normalizeTitle('Spider-Man')).not.toBe(normalizeTitle('Spider'))
  })

  it('still strips a real release-name year and scene tags behind a filename separator', () => {
    expect(normalizeTitle('Heat.1995.1080p.BluRay.x264-GROUP')).toBe('heat')
  })

  it('keeps non-Latin scripts instead of erasing them to an empty, colliding key', () => {
    const spiritedAway = normalizeTitle('千と千尋の神隠し')
    const princessMononoke = normalizeTitle('もののけ姫')
    expect(spiritedAway).not.toBe('')
    expect(princessMononoke).not.toBe('')
    expect(spiritedAway).not.toBe(princessMononoke)
  })
})

describe('trigramSimilarity', () => {
  it('is 1 for identical strings', () => {
    expect(trigramSimilarity('the matrix', 'the matrix')).toBe(1)
  })

  it('is high for near-identical titles', () => {
    expect(trigramSimilarity('the lord of the rings', 'lord of the rings')).toBeGreaterThan(0.8)
  })

  it('is low for unrelated titles', () => {
    expect(trigramSimilarity('heat', 'frozen')).toBeLessThan(0.3)
  })

  it('is 0 when either side is empty', () => {
    expect(trigramSimilarity('', 'heat')).toBe(0)
  })

  it('is symmetric', () => {
    expect(trigramSimilarity('alien', 'aliens')).toBe(trigramSimilarity('aliens', 'alien'))
  })
})
