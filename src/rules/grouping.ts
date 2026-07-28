import { createHash } from 'node:crypto'
import type { Confidence } from '../core/types.js'
import type { DupeLink } from './types.js'

export interface DupeGroup {
  id: string
  tier: Confidence
  memberIds: string[]
  links: DupeLink[]
}

const RANK: Record<Confidence, number> = { possible: 1, strong: 2, exact: 3 }

export function buildDupeGroups(links: DupeLink[]): DupeGroup[] {
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    const p = parent.get(x)
    if (p === undefined || p === x) { parent.set(x, x); return x }
    const root = find(p)
    parent.set(x, root)
    return root
  }
  const union = (a: string, b: string) => {
    const ra = find(a); const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }

  for (const l of links) {
    if (l.a === l.b) continue
    find(l.a); find(l.b)
    union(l.a, l.b)
  }

  const members = new Map<string, Set<string>>()
  for (const key of parent.keys()) {
    const root = find(key)
    if (!members.has(root)) members.set(root, new Set())
    members.get(root)!.add(key)
  }

  const groups: DupeGroup[] = []
  for (const memberSet of members.values()) {
    if (memberSet.size < 2) continue
    const memberIds = [...memberSet].sort()
    const groupLinks = links.filter((l) => memberSet.has(l.a) && memberSet.has(l.b) && l.a !== l.b)
    const tier = groupLinks.reduce<Confidence>(
      (best, l) => (RANK[l.confidence] > RANK[best] ? l.confidence : best),
      'possible',
    )
    groups.push({
      id: createHash('sha256').update(memberIds.join(' ')).digest('hex').slice(0, 32),
      tier,
      memberIds,
      links: groupLinks,
    })
  }
  return groups.sort((a, b) => a.id.localeCompare(b.id))
}
