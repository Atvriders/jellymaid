import { describe, it, expect } from 'vitest'
import { companionFlags, isCompanionFile } from '../../src/core/companions.js'
import { fileConfigSchema, type FileConfig } from '../../src/config/schema.js'

const config = fileConfigSchema.parse({})

/** A config whose junk name patterns count every read, so a test can see how often they are compiled. */
function countingConfig(namePatterns: string[]): { config: FileConfig; reads: () => number } {
  let reads = 0
  const base = fileConfigSchema.parse({})
  const junk = { ...base.rules['fs.junk'] }
  Object.defineProperty(junk, 'namePatterns', {
    enumerable: true,
    get: () => { reads += 1; return namePatterns },
  })
  return { config: { ...base, rules: { ...base.rules, 'fs.junk': junk } }, reads: () => reads }
}

describe('isCompanionFile', () => {
  it('treats a file whose extension is not a media extension as a companion', () => {
    expect(isCompanionFile('Movie.nfo', config)).toBe(true)
    expect(isCompanionFile('Subs/Eng.srt', config)).toBe(true)
    expect(isCompanionFile('Movie/poster.jpg', config)).toBe(true)
  })

  it('treats a video inside a junk directory as a companion, whatever its extension', () => {
    expect(isCompanionFile('Sample/sample.mkv', config)).toBe(true)
    expect(isCompanionFile('Movie/Proof/proof.mkv', config)).toBe(true)
  })

  it('treats a video whose own name matches a junk name pattern as a companion', () => {
    expect(isCompanionFile('movie-sample.mkv', config)).toBe(true)
  })

  it('treats the release video itself as media, not a companion', () => {
    expect(isCompanionFile('Movie.2160p.mkv', config)).toBe(false)
    expect(isCompanionFile('Movie/Movie.mkv', config)).toBe(false)
  })

  it('compares extensions, directory names and name patterns case-insensitively', () => {
    expect(isCompanionFile('MOVIE.MKV', config)).toBe(false)
    expect(isCompanionFile('SAMPLE/x.mkv', config)).toBe(true)
    expect(isCompanionFile('Movie.SAMPLE.mkv', config)).toBe(true)
  })

  it('reads the media extensions and junk rules from the config it is given', () => {
    const custom = fileConfigSchema.parse({
      mediaExtensions: ['.webm'],
      rules: { 'fs.junk': { directoryNames: ['extras'], namePatterns: [] } },
    })
    expect(isCompanionFile('Movie.mkv', custom)).toBe(true) // .mkv is no longer a media extension here
    expect(isCompanionFile('Movie.webm', custom)).toBe(false)
    expect(isCompanionFile('Extras/Making Of.webm', custom)).toBe(true)
    expect(isCompanionFile('Sample/sample.webm', custom)).toBe(false) // neither rule names it any more
  })

  it('ignores an invalid name pattern rather than throwing, which can only ever classify a file as media', () => {
    // Classifying a media file as a companion is the unsafe direction (torrent-scope stops counting
    // it); classifying a companion as media only makes the guard block. An unparseable pattern
    // therefore contributes nothing.
    const broken = fileConfigSchema.parse({ rules: { 'fs.junk': { namePatterns: ['(unclosed'] } } })
    expect(isCompanionFile('Movie.mkv', broken)).toBe(false)
  })

  it('compiles a config once, however many files it classifies', () => {
    // torrent-scope classifies every file of every matched torrent, against one config snapshot.
    const { config: counted, reads } = countingConfig(['(^|[.\\-_ ])sample([.\\-_ ]|$)'])
    for (let i = 0; i < 50; i += 1) isCompanionFile(`Movie ${i}.mkv`, counted)
    expect(isCompanionFile('movie-sample.mkv', counted)).toBe(true)
    expect(reads()).toBe(1)
  })

  it('classifies against each config object its own rules, so an edited config is never served a stale compile', () => {
    const before = fileConfigSchema.parse({})
    const after = fileConfigSchema.parse({ rules: { 'fs.junk': { namePatterns: [] } } })
    expect(isCompanionFile('Sample City.mkv', before)).toBe(true)
    expect(isCompanionFile('Sample City.mkv', after)).toBe(false)
    expect(isCompanionFile('Sample City.mkv', before)).toBe(true)
  })

  it('recompiles when a list on the same config object is replaced', () => {
    const edited = fileConfigSchema.parse({})
    expect(isCompanionFile('Movie.webm', edited)).toBe(true)
    edited.mediaExtensions = [...edited.mediaExtensions, '.webm']
    expect(isCompanionFile('Movie.webm', edited)).toBe(false)
  })
})

describe('companionFlags — which files of one torrent travel with the release', () => {
  const file = (relPath: string, sizeBytes: number) => ({ relPath, sizeBytes })

  it('flags the sidecars and the sample of a movie release, never the movie itself', () => {
    expect(companionFlags([
      file('Movie (2020)/Movie.mkv', 8_000_000_000),
      file('Movie (2020)/Movie.nfo', 4_000),
      file('Movie (2020)/Subs/Eng.srt', 90_000),
      file('Movie (2020)/Sample/sample.mkv', 60_000_000),
    ], config)).toEqual([false, true, true, true])
  })

  it('counts a sample-named media file as media when it is not small beside the largest media file (Ruling 11)', () => {
    // The default `sample` name pattern matches a film called "Sample City". A film is never a
    // tenth of the largest film in its own torrent, so it is never waved through as a sidecar.
    expect(companionFlags([file('Sample City (1999).mkv', 4_000_000_000)], config)).toEqual([false])
    expect(companionFlags([
      file('Pack/Sample City (1999).mkv', 4_000_000_000),
      file('Pack/Other Film (2001).mkv', 5_000_000_000),
    ], config)).toEqual([false, false])
  })

  it('draws the line at a tenth of the largest media file, exclusive', () => {
    expect(companionFlags([file('Movie.mkv', 1000), file('Sample/sample.mkv', 99)], config)).toEqual([false, true])
    expect(companionFlags([file('Movie.mkv', 1000), file('Sample/sample.mkv', 100)], config)).toEqual([false, false])
  })

  it('treats media files of unknown size as media — nothing is small beside an unknown', () => {
    expect(companionFlags([file('Movie.mkv', 0), file('Sample/sample.mkv', 0)], config)).toEqual([false, false])
  })

  it('treats a media file of unknown size as media even beside one whose size is known', () => {
    // An index row with no size reads as 0, and 0 is under a tenth of any real film; the unknown must
    // still land on the media side, where a torrent-scope check counts it.
    expect(companionFlags([file('Movie.mkv', 1_000_000_000), file('Sample/sample.mkv', 0)], config)).toEqual([false, false])
  })

  it('flags a non-media file whatever its size', () => {
    expect(companionFlags([file('Movie.mkv', 10), file('Movie.nfo', 5_000)], config)).toEqual([false, true])
  })
})
