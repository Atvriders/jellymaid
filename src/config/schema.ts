// src/config/schema.ts
import { resolve } from 'node:path'
import { z } from 'zod'

/**
 * Every path in a mapping is a filesystem ROOT, not a hint. `container` in particular is the
 * boundary a later plan's delete sweep is forbidden to climb above, so it must be unambiguous:
 * a relative path would be resolved against `process.cwd()` (whatever that happens to be), and
 * "/" would put the entire filesystem inside the sweep's permitted area.
 */
const absolutePath = z.string().min(1).refine((p) => p.startsWith('/'), {
  message: 'must be an absolute path starting with /',
})

export const pathMappingSchema = z.object({
  role: z.enum(['library', 'download']),
  jellyfin: absolutePath.nullable(),
  container: absolutePath,
  qbit: absolutePath.nullable(),
}).superRefine((m, ctx) => {
  if (m.role === 'library' && m.jellyfin === null) {
    ctx.addIssue({ code: 'custom', message: 'library mappings require a jellyfin path' })
  }
  if (m.role === 'download' && m.jellyfin !== null) {
    ctx.addIssue({ code: 'custom', message: 'download mappings must set jellyfin to null' })
  }
  // A merely-textual check against the literal string "/" is not enough: "/..", "//", and
  // "/mnt/../.." all pass `startsWith('/')` and all NORMALIZE to "/" once resolved, so any of
  // them would put the entire filesystem inside the sweep's permitted area. Require the path to
  // already be in normalized form and reject the root either way.
  const resolvedContainer = resolve(m.container)
  if (resolvedContainer !== m.container || resolvedContainer === '/') {
    ctx.addIssue({
      code: 'custom',
      path: ['container'],
      message: 'container must be a normalized absolute path (no ".", "..", or repeated "/") and must not be the filesystem root "/"',
    })
  }
})

export const fileConfigSchema = z.object({
  scanCron: z.string().default('0 3 * * *'),
  pathMappings: z.array(pathMappingSchema).default([]),
  hashedLibraryRoots: z.array(z.string()).default([]),
  ignorableFiles: z.array(z.string()).default(['.DS_Store', 'Thumbs.db', '.nfo', '.srt', '.jpg', '.png']),
  mediaExtensions: z.array(z.string())
    .default(['.mkv', '.mp4', '.avi', '.m4v', '.mov', '.wmv', '.ts', '.m2ts', '.mpg', '.mpeg']),
  guards: z.object({
    minRatio: z.number().min(0).default(1.0),
    minSeedTimeDays: z.number().min(0).default(14),
    privateTrackerHosts: z.array(z.string()).default([]),
    protectedCategories: z.array(z.string()).default([]),
    protectedTags: z.array(z.string()).default([]),
  }).default({}),
  trash: z.object({
    maxBytes: z.number().int().min(0).default(1_073_741_824),
    retentionDays: z.number().int().min(1).default(30),
  }).default({}),
  rateLimits: z.object({
    jellyfin: z.object({ concurrency: z.number().int().min(1).default(4), minDelayMs: z.number().int().min(0).default(50) }).default({}),
    qbittorrent: z.object({ concurrency: z.number().int().min(1).default(2), minDelayMs: z.number().int().min(0).default(100) }).default({}),
    arr: z.object({ concurrency: z.number().int().min(1).default(2), minDelayMs: z.number().int().min(0).default(100) }).default({}),
  }).default({}),
  rules: z.object({
    'dupe.fuzzy-title': z.object({
      enabled: z.boolean().default(true),
      similarity: z.number().min(0).max(1).default(0.88),
      minTitleLength: z.number().int().min(1).default(3),
    }).default({}),
    'dupe.runtime': z.object({ enabled: z.boolean().default(true), toleranceSeconds: z.number().min(0).default(2) }).default({}),
    'quality.low-bitrate': z.object({
      enabled: z.boolean().default(true),
      floorsKbpsByHeight: z.record(z.string(), z.number()).default({ '480': 1000, '720': 2500, '1080': 5000, '2160': 15000 }),
    }).default({}),
    // `minPeers` is the size a same-resolution cohort must reach before its median is treated as
    // meaningful enough to call one member "tiny". Two files are not a distribution.
    'quality.tiny-file': z.object({
      enabled: z.boolean().default(true),
      peerRatio: z.number().min(0).max(1).default(0.4),
      minPeers: z.number().int().min(2).default(3),
    }).default({}),
    'quality.transcode-risk': z.object({
      enabled: z.boolean().default(true),
      allowedVideoCodecs: z.array(z.string()).default(['h264', 'hevc', 'av1']),
      allowedContainers: z.array(z.string()).default(['mkv', 'mp4']),
    }).default({}),
    'quality.biggest': z.object({ enabled: z.boolean().default(true), topN: z.number().int().min(1).default(50) }).default({}),
    // Which sidecar extensions count as "this file has external subtitles". An operator whose
    // library uses .vtt, or who burns subtitles in and does not want the rule at all, had no way
    // to say so while the list and the rule's very existence were compiled in.
    'quality.missing-subs': z.object({
      enabled: z.boolean().default(true),
      extensions: z.array(z.string()).default(['.srt', '.ass', '.sub']),
    }).default({}),
    // Case-insensitive regex SOURCES (compiled by the rule, not stored compiled): a hardcoded
    // `/sample/i` flags a real title like "Sample City" for every operator, with no way to turn
    // it off. `zeroByteIsJunk` is its own flag because a 0-byte file mid-write from a slow network
    // copy is a real, if rare, false positive some operators may want to disable independently of
    // every other junk signal.
    'fs.junk': z.object({
      namePatterns: z.array(z.string()).default(['(^|[.\\-_ ])sample([.\\-_ ]|$)']),
      extensions: z.array(z.string()).default(['.part', '.tmp', '.!qb', '.crdownload']),
      directoryNames: z.array(z.string()).default(['proof', 'screens', 'sample']),
      zeroByteIsJunk: z.boolean().default(true),
    }).default({}),
    'fs.stray-sidecar': z.object({
      extensions: z.array(z.string()).default(['.srt', '.sub', '.idx', '.ass', '.nfo', '.jpg', '.png']),
    }).default({}),
    // Regex SOURCES for "does this path follow the expected naming scheme", compiled by the rule.
    // Hardcoded, these encoded one house style — the Jellyfin-recommended `Title (Year)/` movie
    // folder and an `S01E01` episode token — and flagged every library organized any other way,
    // every scan, with no way to correct or silence them. `moviePattern` is matched
    // case-sensitively (it only concerns digits and brackets) and `episodePattern`
    // case-insensitively, preserving each expression's original behaviour exactly.
    'meta.bad-naming': z.object({
      enabled: z.boolean().default(true),
      moviePattern: z.string().default('\\((?:19|20)\\d{2}\\)/[^/]+$'),
      episodePattern: z.string().default('s\\d{1,2}[ ._-]?e\\d{1,3}'),
    }).default({}),
  }).default({}),
})

export type FileConfig = z.infer<typeof fileConfigSchema>

const arrSchema = z.object({ url: z.string().url(), apiKey: z.string().min(1) })

export const envConfigSchema = z.object({
  dataDir: z.string().min(1),
  port: z.coerce.number().int().default(8099),
  /**
   * Number of proxy hops in front of this service, NOT a boolean. Fastify treats a number as
   * "trust N hops from the right", which makes the RIGHTMOST X-Forwarded-For token authoritative.
   * `true` would trust every proxy and take the LEFTMOST token — a value the caller writes — and
   * the login lockout keys on req.ip, so an attacker could mint a fresh lockout bucket per request.
   */
  trustProxy: z.number().int().min(0).default(0),
  sessionSecret: z.string().min(16),
  jellyfin: z.object({ url: z.string().url(), apiKey: z.string().min(1) }),
  qbittorrent: z.object({ url: z.string().url(), user: z.string().min(1), pass: z.string().min(1) }),
  radarr: arrSchema.nullable(),
  sonarr: arrSchema.nullable(),
})

export type EnvConfig = z.infer<typeof envConfigSchema>
export interface AppConfig { env: EnvConfig; file: FileConfig }
