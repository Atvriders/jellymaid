import { describe, it, expect } from 'vitest'
import { editionOf, isMultiEpisodeFile, normalizeTitle, trigramSimilarity } from '../../src/rules/normalize.js'

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

describe('editionOf', () => {
  it("editionOf recognises Extended, Director's Cut, Unrated, Theatrical, IMAX, Final Cut, Ultimate, Special Edition, Remastered, Criterion", () => {
    const cases: Array<[string, string]> = [
      ['Aliens.1986.Extended.Cut.1080p.BluRay.x264-GRP.mkv', 'Extended'],
      ["Kingdom of Heaven (2005) - Director's Cut.mkv", "Director's Cut"],
      ['Blade.Runner.1982.Directors.Cut.1080p.BluRay.mkv', "Director's Cut"],
      ['Kingdom of Heaven (2005) - Director’s Cut.mkv', "Director's Cut"],
      ['Kingdom of Heaven (2005) - Directorʼs Cut.mkv', "Director's Cut"],
      ['Kingdom.of.Heaven.2005.Director`s.Cut.mkv', "Director's Cut"],
      ['Old.School.2003.UNRATED.720p.BluRay.mkv', 'Unrated'],
      ['Aliens 1986 Theatrical 1080p.mkv', 'Theatrical'],
      ['Dune.Part.Two.2024.IMAX.2160p.WEB-DL.mkv', 'IMAX'],
      ['Blade Runner: The Final Cut', 'Final Cut'],
      ['Batman.v.Superman.2016.Ultimate.Edition.1080p.BluRay.mkv', 'Ultimate'],
      ['Aliens (1986) {edition-Special Edition}.mkv', 'Special Edition'],
      ['Jaws.1975.REMASTERED.1080p.BluRay.mkv', 'Remastered'],
      ['Seven.Samurai.1954.Criterion.1080p.BluRay.mkv', 'Criterion'],
    ]
    for (const [input, expected] of cases) expect(editionOf(input), input).toBe(expected)
  })

  it('returns null when no edition is named', () => {
    for (const input of ['Heat.1995.1080p.BluRay.x264-GROUP.mkv', 'The Bourne Ultimatum', 'Cut Bank (2014)', 'Heat']) {
      expect(editionOf(input), input).toBeNull()
    }
  })

  it('lists every edition a name carries, in one canonical order', () => {
    // "Remastered Director's Cut" and "Director's Cut Remastered" are one edition; both differ from
    // a plain Director's Cut.
    expect(editionOf('Movie.1990.Remastered.Directors.Cut.mkv')).toBe("Director's Cut, Remastered")
    expect(editionOf('Movie.1990.Directors.Cut.Remastered.mkv')).toBe("Director's Cut, Remastered")
  })

  it("reads a path's file name first and falls back to its release folder", () => {
    expect(editionOf('/path/to/movies/Aliens (1986)/Aliens (1986) - Theatrical.mkv')).toBe('Theatrical')
    expect(editionOf('/path/to/movies/Aliens.1986.Special.Edition.1080p/grp-aliens-1080p.mkv')).toBe('Special Edition')
    expect(editionOf('/path/to/movies/Movie.Extended/Movie.Theatrical.mkv')).toBe('Theatrical')
    expect(editionOf('/path/to/movies/Aliens (1986)/Aliens (1986).mkv')).toBeNull()
  })
})

describe('isMultiEpisodeFile', () => {
  it.each([
    'Show.S01E01E02.1080p.WEB-DL.mkv',
    'Show.S01E01-E02.1080p.WEB-DL.mkv',
    'Show.S01E01-02.1080p.WEB-DL.mkv',
    'show - s1e9e10 - Two Parter.mkv',
    'Show.S01E01E02E03.mkv',
    '/path/to/tv/Show (1962)/Season 01/Show - S01E01-E02.mkv',
    // Task 6 minor 1: the spellings the first pass missed.
    'Show.S01E01-S01E02.1080p.mkv',
    'Show.1x01-02.mkv',
    'Show.1x01x02.mkv',
    'Show - 1x01-1x02 - Two Parter.mkv',
  ])('recognises %s', (name) => expect(isMultiEpisodeFile(name)).toBe(true))

  it.each([
    'Show.S01E01.1080p.WEB-DL.mkv',
    'Show.S01E01-720p.mkv',             // a resolution, not an episode
    'Show.S01E01-1080p.mkv',
    'Show.S01E01-2019.mkv',             // a year
    'Show.S01E02-01.mkv',               // a range never runs backwards
    'Show.S01.1080p.WEB-DL',
    'Show.1x01.mkv',
    'Show.1x01-720p.mkv',
    'Show.2x02-01.mkv',
    'Show.1920x1080.mkv',               // a frame size
    'Show.S01E01.3840x2160.mkv',
    // Only the file's own name counts: a pack folder named for its range holds single episodes.
    '/path/to/tv/Show.S01E01-E10.Pack/Show.S01E03.mkv',
  ])('does not treat %s as multi-episode', (name) => expect(isMultiEpisodeFile(name)).toBe(false))
})
