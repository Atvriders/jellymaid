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

export function pickKeeper(
  members: MemberFacts[],
  w: KeeperWeights,
): { keeperId: string; scores: Record<string, { total: number; breakdown: Record<string, number> }> } {
  const scores: Record<string, { total: number; breakdown: Record<string, number> }> = {}
  for (const m of members) scores[m.itemId] = scoreMember(m, w)

  const sorted = [...members].sort((a, b) => {
    const diff = scores[b.itemId]!.total - scores[a.itemId]!.total
    if (Math.abs(diff) > 1e-9) return diff
    const size = (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0)
    if (size !== 0) return size
    return a.itemId.localeCompare(b.itemId)
  })
  return { keeperId: sorted[0]!.itemId, scores }
}
