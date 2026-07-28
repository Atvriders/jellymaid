import { describe, it, expect } from 'vitest'
import { buildDupeGroups } from '../../src/rules/grouping.js'
import type { DupeLink } from '../../src/rules/types.js'

const link = (a: string, b: string, confidence: DupeLink['confidence'], ruleId = 'dupe.test'): DupeLink =>
  ({ ruleId, a, b, confidence, evidence: {} })

describe('buildDupeGroups', () => {
  it('merges transitively linked items into one group', () => {
    const groups = buildDupeGroups([link('a', 'b', 'exact'), link('b', 'c', 'strong')])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.memberIds.sort()).toEqual(['a', 'b', 'c'])
  })

  it('keeps unrelated pairs in separate groups', () => {
    const groups = buildDupeGroups([link('a', 'b', 'exact'), link('c', 'd', 'exact')])
    expect(groups).toHaveLength(2)
  })

  it('takes the strongest tier that formed the group', () => {
    expect(buildDupeGroups([link('a', 'b', 'possible'), link('b', 'c', 'exact')])[0]!.tier).toBe('exact')
    expect(buildDupeGroups([link('a', 'b', 'possible'), link('b', 'c', 'strong')])[0]!.tier).toBe('strong')
    expect(buildDupeGroups([link('a', 'b', 'possible')])[0]!.tier).toBe('possible')
  })

  it('produces a stable id independent of link order', () => {
    const one = buildDupeGroups([link('a', 'b', 'exact'), link('b', 'c', 'exact')])[0]!
    const two = buildDupeGroups([link('c', 'b', 'exact'), link('b', 'a', 'exact')])[0]!
    expect(one.id).toBe(two.id)
  })

  it('carries every contributing link for evidence display', () => {
    const groups = buildDupeGroups([link('a', 'b', 'exact', 'dupe.provider-id'), link('a', 'b', 'strong', 'dupe.title-year')])
    expect(groups[0]!.links.map((l) => l.ruleId).sort()).toEqual(['dupe.provider-id', 'dupe.title-year'])
  })

  it('returns nothing for no links', () => {
    expect(buildDupeGroups([])).toEqual([])
  })

  it('never emits a single-member group', () => {
    expect(buildDupeGroups([link('a', 'a', 'exact')])).toEqual([])
  })
})
