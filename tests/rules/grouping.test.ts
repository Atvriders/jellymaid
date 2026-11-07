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

  const membersOf = (groups: ReturnType<typeof buildDupeGroups>) => groups.map((g) => g.memberIds.join(',')).sort()
  const fuzzy = (a: string, b: string, similarity: number): DupeLink =>
    ({ ruleId: 'dupe.fuzzy-title', a, b, confidence: 'possible', evidence: { similarity } })

  it('possible links never merge two strong groups', () => {
    // "Alien" ~ "Aliens" is a near-title, not a copy. Chained single-linkage used to fold two
    // separate films' groups into one, so queueing that group's non-keepers deleted a film.
    const groups = buildDupeGroups([
      link('a', 'b', 'strong'), link('c', 'd', 'exact'), fuzzy('b', 'c', 0.95),
    ])
    expect(membersOf(groups)).toEqual(['a,b', 'c,d'])
    expect(groups.find((g) => g.memberIds.includes('a'))!.tier).toBe('strong')
    expect(groups.find((g) => g.memberIds.includes('c'))!.tier).toBe('exact')
    // The cross-group possible link is evidence for neither group.
    for (const g of groups) expect(g.links.every((l) => l.confidence !== 'possible')).toBe(true)
  })

  it('possible pair emitted only between ungrouped items', () => {
    const groups = buildDupeGroups([
      link('a', 'b', 'exact'),
      fuzzy('a', 'e', 0.99),          // a is already grouped: no pair, and e is not pulled in
      fuzzy('e', 'f', 0.9),           // both ungrouped: a two-member possible group
    ])
    expect(membersOf(groups)).toEqual(['a,b', 'e,f'])
    const pair = groups.find((g) => g.memberIds.includes('e'))!
    expect(pair.tier).toBe('possible')
    expect(pair.links).toEqual([fuzzy('e', 'f', 0.9)])
  })

  it('pairs possible links best-first so no item lands in two groups', () => {
    // x~y and y~z are both possible. y can belong to one pair only; the closer match wins and x is
    // left ungrouped rather than forming an overlapping {x,y} group.
    const groups = buildDupeGroups([fuzzy('x', 'y', 0.9), fuzzy('y', 'z', 0.95)])
    expect(membersOf(groups)).toEqual(['y,z'])
    // Input order does not change the outcome.
    expect(membersOf(buildDupeGroups([fuzzy('y', 'z', 0.95), fuzzy('x', 'y', 0.9)]))).toEqual(['y,z'])
  })

  it('keeps a possible link between two members of the same group as that group\'s evidence', () => {
    const groups = buildDupeGroups([link('a', 'b', 'exact'), link('b', 'c', 'strong'), fuzzy('a', 'c', 0.9)])
    expect(membersOf(groups)).toEqual(['a,b,c'])
    expect(groups[0]!.tier).toBe('exact')
    expect(groups[0]!.links).toHaveLength(3)
  })
})
