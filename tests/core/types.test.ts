import { describe, it, expect } from 'vitest'
import { findingId, FINDING_CLASSES, ACTION_TYPES, GUARD_IDS } from '../../src/core/types.js'

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

  it('covers the four guards', () => {
    expect([...GUARD_IDS].sort()).toEqual([
      'guard.cross-seed', 'guard.hardlink', 'guard.private-ratio', 'guard.protected',
    ])
  })
})
