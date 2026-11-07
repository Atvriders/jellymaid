import type { KeeperPolicy } from '../config/schema.js'

export interface MemberFacts {
  itemId: string
  height: number | null
  bitrate: number | null
  videoCodec: string | null
  audioChannels: number | null
  isHdr: boolean
  hasSubtitles: boolean
  sizeBytes: number | null
}

export interface KeeperWeights {
  resolution: number
  hdr: number
  bitrate: number
  codec: number
  audioChannels: number
  subtitles: number
  size: number
  codecRank: Record<string, number>
}

/**
 * Weights are ordered so resolution dominates: a 4K copy wins over a 1080p copy
 * even when the 1080p file has a far higher bitrate. Everything is normalized to
 * roughly 0–1 before weighting so one signal cannot silently swamp the rest.
 */
export const DEFAULT_KEEPER_WEIGHTS: KeeperWeights = {
  resolution: 1000,
  hdr: 300,
  bitrate: 200,
  codec: 100,
  audioChannels: 80,
  subtitles: 40,
  size: 10,
  codecRank: { av1: 1, hevc: 0.9, h265: 0.9, h264: 0.7, avc: 0.7, mpeg4: 0.3, xvid: 0.2 },
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

export function scoreMember(m: MemberFacts, w: KeeperWeights): { total: number; breakdown: Record<string, number> } {
  const breakdown = {
    resolution: w.resolution * clamp01((m.height ?? 0) / 2160),
    hdr: m.isHdr ? w.hdr : 0,
    bitrate: w.bitrate * clamp01((m.bitrate ?? 0) / 40_000_000),
    codec: w.codec * (w.codecRank[(m.videoCodec ?? '').toLowerCase()] ?? 0),
    audioChannels: w.audioChannels * clamp01((m.audioChannels ?? 0) / 8),
    subtitles: m.hasSubtitles ? w.subtitles : 0,
    size: w.size * clamp01((m.sizeBytes ?? 0) / 100_000_000_000),
  }
  const total = Object.values(breakdown).reduce((a, b) => a + b, 0)
  return { total, breakdown }
}

/**
 * Which copy of a duplicate group is pre-selected to KEEP, per `config.keeper.policy`:
 *  - `best-quality`: the highest score under `w`, ties going to the larger file, then the lower id;
 *  - `smallest`: the smallest file, ties going to the higher score, then the lower id. A copy whose
 *    size is unknown, or zero (a broken file — `fs.junk` reports zero-byte media), is not shown to
 *    be the smallest and never wins; with no copy of known size there is no smallest and the keeper
 *    is null;
 *  - `none`: null — the operator picks.
 * A null keeper pre-selects nothing for deletion. Scores are returned for every member under every
 * policy, so the comparison the operator decides from is the same whichever policy is set.
 */
export function pickKeeper(
  members: MemberFacts[],
  w: KeeperWeights,
  policy: KeeperPolicy = 'best-quality',
): { keeperId: string | null; scores: Record<string, { total: number; breakdown: Record<string, number> }> } {
  const scores: Record<string, { total: number; breakdown: Record<string, number> }> = {}
  for (const m of members) scores[m.itemId] = scoreMember(m, w)
  if (policy === 'none') return { keeperId: null, scores }

  const byQuality = (a: MemberFacts, b: MemberFacts): number => {
    const diff = scores[b.itemId]!.total - scores[a.itemId]!.total
    if (Math.abs(diff) > 1e-9) return diff
    const size = (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0)
    if (size !== 0) return size
    return a.itemId.localeCompare(b.itemId)
  }

  if (policy === 'smallest') {
    const sized = members.filter((m) => m.sizeBytes !== null && m.sizeBytes > 0)
    const sorted = sized.sort((a, b) => (a.sizeBytes! - b.sizeBytes!) || byQuality(a, b))
    return { keeperId: sorted[0]?.itemId ?? null, scores }
  }

  const sorted = [...members].sort(byQuality)
  return { keeperId: sorted[0]?.itemId ?? null, scores }
}
