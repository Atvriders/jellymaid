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

/**
 * How close a `possible` link says its pair is, for ordering pairs best-first. Only the fuzzy-title
 * matcher emits `possible` links today and it records `evidence.similarity`; a link without one
 * sorts last, behind every scored pair, and ties fall back to the pair's ids.
 */
function similarityOf(l: DupeLink): number {
  const s = l.evidence.similarity
  return typeof s === 'number' && Number.isFinite(s) ? s : 0
}

/** Id = hash of the sorted member ids, so the same member set always yields the same group id. */
function makeGroup(memberIds: string[], links: DupeLink[]): DupeGroup {
  const sorted = [...memberIds].sort()
  return {
    id: createHash('sha256').update(sorted.join(' ')).digest('hex').slice(0, 32),
    tier: links.reduce<Confidence>((best, l) => (RANK[l.confidence] > RANK[best] ? l.confidence : best), 'possible'),
    memberIds: sorted,
    links,
  }
}

/**
 * Groups are the connected components over `exact` and `strong` links ONLY.
 *
 * A `possible` link (a fuzzy title match) never joins anything to a group, and never joins two
 * groups. Under plain single-linkage it did both: "Alien" ~ "Aliens" chained two different films'
 * groups into one, and every member of the merged group then counted as a copy of every other — so
 * queueing that group's non-keepers deleted a film. A possible link instead forms a two-member
 * `possible` group of its own, and only when NEITHER item is already in a group. Possible pairs are
 * taken best-first (highest similarity, then pair ids) and an item that has joined one pair is
 * "already grouped" for the rest, so no item ever belongs to two groups. Do not reintroduce a union
 * over possible links.
 */
export function buildDupeGroups(links: DupeLink[]): DupeGroup[] {
  const real = links.filter((l) => l.a !== l.b)

  const parent = new Map<string, string>()
  const find = (x: string): string => {
    const p = parent.get(x)
    if (p === undefined || p === x) { parent.set(x, x); return x }
    const root = find(p)
    parent.set(x, root)
    return root
  }
  for (const l of real) {
    if (l.confidence === 'possible') continue
    const ra = find(l.a); const rb = find(l.b)
    if (ra !== rb) parent.set(ra, rb)
  }

  const membersByRoot = new Map<string, string[]>()
  for (const key of parent.keys()) {
    const root = find(key)
    const list = membersByRoot.get(root)
    if (list) list.push(key); else membersByRoot.set(root, [key])
  }

  // Every link whose two ends sit in the same component is that group's evidence, a possible link
  // between two members included; a link spanning two components belongs to neither.
  const linksByRoot = new Map<string, DupeLink[]>()
  for (const l of real) {
    if (!parent.has(l.a) || !parent.has(l.b)) continue
    const root = find(l.a)
    if (root !== find(l.b)) continue
    const list = linksByRoot.get(root)
    if (list) list.push(l); else linksByRoot.set(root, [l])
  }

  const groups: DupeGroup[] = []
  const grouped = new Set<string>()
  for (const [root, members] of membersByRoot) {
    if (members.length < 2) continue
    groups.push(makeGroup(members, linksByRoot.get(root) ?? []))
    for (const m of members) grouped.add(m)
  }

  const possiblePairs = new Map<string, DupeLink[]>()
  for (const l of real) {
    if (l.confidence !== 'possible' || grouped.has(l.a) || grouped.has(l.b)) continue
    const key = [l.a, l.b].sort().join('\0')
    const list = possiblePairs.get(key)
    if (list) list.push(l); else possiblePairs.set(key, [l])
  }
  const bestFirst = [...possiblePairs.entries()].map(([key, pairLinks]) => ({
    key, pairLinks, similarity: Math.max(...pairLinks.map(similarityOf)),
  })).sort((x, y) => y.similarity - x.similarity || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))
  for (const { pairLinks } of bestFirst) {
    const { a, b } = pairLinks[0]!
    if (grouped.has(a) || grouped.has(b)) continue
    groups.push(makeGroup([a, b], pairLinks))
    grouped.add(a); grouped.add(b)
  }

  return groups.sort((a, b) => a.id.localeCompare(b.id))
}
