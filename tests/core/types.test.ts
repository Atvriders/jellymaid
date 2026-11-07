import { describe, it, expect } from 'vitest'
import { findingId, torrentKey, FINDING_CLASSES, ACTION_TYPES, GUARD_IDS } from '../../src/core/types.js'

describe('findingId', () => {
  it('is stable for the same rule and subject key', () => {
    expect(findingId('dupe.provider-id', 'tmdb:603')).toBe(findingId('dupe.provider-id', 'tmdb:603'))
  })

  it('differs across rules and across subjects', () => {
    expect(findingId('dupe.provider-id', 'tmdb:603')).not.toBe(findingId('dupe.title-year', 'tmdb:603'))
    expect(findingId('dupe.provider-id', 'tmdb:603')).not.toBe(findingId('dupe.provider-id', 'tmdb:604'))
  })

  it('is independent of subject ordering within the key', () => {
    expect(findingId('dupe.provider-id', ['b', 'a'])).toBe(findingId('dupe.provider-id', ['a', 'b']))
  })

  it('is a 32-char hex string', () => {
    expect(findingId('fs.empty-folder', '/mnt/media/Movies/Old')).toMatch(/^[0-9a-f]{32}$/)
  })

  it('does not collide when subject elements contain spaces', () => {
    expect(findingId('r', ['x', 'y z'])).not.toBe(findingId('r', ['x y', 'z']))
  })

  it('does not collide when the boundary between ruleId and key contains a space', () => {
    // Same defect as above, one join further out: with a space separator both of these hash
    // the string "a b c".
    expect(findingId('a', 'b c')).not.toBe(findingId('a b', 'c'))
    expect(findingId('dupe.runtime', 'x y')).not.toBe(findingId('dupe.runtime x', 'y'))
  })
})

describe('enumerations', () => {
  it('covers the four finding classes', () => {
    expect([...FINDING_CLASSES].sort()).toEqual(['duplicate', 'filesystem', 'metadata', 'quality'])
  })

  it('covers the five action types', () => {
    expect([...ACTION_TYPES].sort()).toEqual([
      'delete-junk-file', 'delete-media', 'merge-versions', 'remove-empty-folder', 'split-versions',
    ])
  })

  it('covers the six guards', () => {
    expect([...GUARD_IDS].sort()).toEqual([
      'guard.cross-seed', 'guard.hardlink', 'guard.private-ratio', 'guard.protected', 'guard.torrent-scope',
      'guard.untracked',
    ])
  })
})

describe('torrentKey', () => {
  it('keys a torrent by instance AND hash, so one infohash on two boxes is two torrents', () => {
    expect(torrentKey({ instanceId: 'box-a', hash: 'abc' })).not.toBe(torrentKey({ instanceId: 'box-b', hash: 'abc' }))
  })

  it('lowercases the hash, so the casing a source happened to use cannot split one torrent in two', () => {
    expect(torrentKey({ instanceId: 'box-a', hash: 'ABC' })).toBe(torrentKey({ instanceId: 'box-a', hash: 'abc' }))
  })

  it('joins with a NUL byte, which can occur in neither an instance id nor a hash', () => {
    expect(torrentKey({ instanceId: 'box-a', hash: 'abc' })).toBe('box-a\0abc')
  })
})
