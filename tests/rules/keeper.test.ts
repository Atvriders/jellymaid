import { describe, it, expect } from 'vitest'
import { scoreMember, pickKeeper, DEFAULT_KEEPER_WEIGHTS } from '../../src/rules/keeper.js'

const facts = (over: Partial<Parameters<typeof scoreMember>[0]> = {}) => ({
  itemId: 'a', height: 1080, bitrate: 8_000_000, videoCodec: 'h264',
  audioChannels: 6, isHdr: false, hasSubtitles: false, sizeBytes: 10_000_000_000,
  ...over,
})

describe('scoreMember', () => {
  it('scores higher resolution above lower', () => {
    const uhd = scoreMember(facts({ height: 2160 }), DEFAULT_KEEPER_WEIGHTS).total
    const hd = scoreMember(facts({ height: 1080 }), DEFAULT_KEEPER_WEIGHTS).total
    expect(uhd).toBeGreaterThan(hd)
  })

  it('weights resolution above bitrate — a 4K low-bitrate beats a 1080p high-bitrate', () => {
    const uhd = scoreMember(facts({ height: 2160, bitrate: 6_000_000 }), DEFAULT_KEEPER_WEIGHTS).total
    const hd = scoreMember(facts({ height: 1080, bitrate: 40_000_000 }), DEFAULT_KEEPER_WEIGHTS).total
    expect(uhd).toBeGreaterThan(hd)
  })

  it('rewards HDR, more audio channels and subtitles', () => {
    const base = scoreMember(facts(), DEFAULT_KEEPER_WEIGHTS).total
    expect(scoreMember(facts({ isHdr: true }), DEFAULT_KEEPER_WEIGHTS).total).toBeGreaterThan(base)
    expect(scoreMember(facts({ audioChannels: 8 }), DEFAULT_KEEPER_WEIGHTS).total).toBeGreaterThan(base)
    expect(scoreMember(facts({ hasSubtitles: true }), DEFAULT_KEEPER_WEIGHTS).total).toBeGreaterThan(base)
  })

  it('exposes a breakdown whose parts sum to the total', () => {
    const { total, breakdown } = scoreMember(facts(), DEFAULT_KEEPER_WEIGHTS)
    const sum = Object.values(breakdown).reduce((a, b) => a + b, 0)
    expect(Math.abs(sum - total)).toBeLessThan(1e-6)
  })

  it('handles missing facts without producing NaN', () => {
    const { total } = scoreMember(
      { itemId: 'x', height: null, bitrate: null, videoCodec: null, audioChannels: null, isHdr: false, hasSubtitles: false, sizeBytes: null },
      DEFAULT_KEEPER_WEIGHTS,
    )
    expect(Number.isFinite(total)).toBe(true)
  })
})

describe('pickKeeper', () => {
  it('picks the highest total', () => {
    const { keeperId } = pickKeeper([facts({ itemId: 'a', height: 1080 }), facts({ itemId: 'b', height: 2160 })], DEFAULT_KEEPER_WEIGHTS)
    expect(keeperId).toBe('b')
  })

  it('breaks an exact tie by larger size, then by id, so the choice is deterministic', () => {
    const a = pickKeeper([facts({ itemId: 'a', sizeBytes: 1 }), facts({ itemId: 'b', sizeBytes: 2 })], DEFAULT_KEEPER_WEIGHTS)
    expect(a.keeperId).toBe('b')
    const b = pickKeeper([facts({ itemId: 'z', sizeBytes: 5 }), facts({ itemId: 'y', sizeBytes: 5 })], DEFAULT_KEEPER_WEIGHTS)
    expect(b.keeperId).toBe('y')
  })

  it('returns a score for every member so the UI can show the comparison', () => {
    const { scores } = pickKeeper([facts({ itemId: 'a' }), facts({ itemId: 'b' })], DEFAULT_KEEPER_WEIGHTS)
    expect(Object.keys(scores).sort()).toEqual(['a', 'b'])
  })
})
