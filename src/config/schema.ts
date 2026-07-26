// src/config/schema.ts
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
  if (m.container === '/') {
    ctx.addIssue({ code: 'custom', path: ['container'], message: 'container must not be the filesystem root "/"' })
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
    'dupe.fuzzy-title': z.object({ enabled: z.boolean().default(true), similarity: z.number().min(0).max(1).default(0.88) }).default({}),
    'dupe.runtime': z.object({ enabled: z.boolean().default(true), toleranceSeconds: z.number().min(0).default(2) }).default({}),
    'quality.low-bitrate': z.object({
      enabled: z.boolean().default(true),
      floorsKbpsByHeight: z.record(z.string(), z.number()).default({ '480': 1000, '720': 2500, '1080': 5000, '2160': 15000 }),
    }).default({}),
    'quality.tiny-file': z.object({ enabled: z.boolean().default(true), peerRatio: z.number().min(0).max(1).default(0.4) }).default({}),
    'quality.transcode-risk': z.object({
      enabled: z.boolean().default(true),
      allowedVideoCodecs: z.array(z.string()).default(['h264', 'hevc', 'av1']),
      allowedContainers: z.array(z.string()).default(['mkv', 'mp4']),
    }).default({}),
    'quality.biggest': z.object({ enabled: z.boolean().default(true), topN: z.number().int().min(1).default(50) }).default({}),
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
