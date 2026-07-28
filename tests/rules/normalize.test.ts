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
