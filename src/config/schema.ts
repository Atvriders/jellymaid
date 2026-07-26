// src/config/schema.ts
import { z } from 'zod'

export const pathMappingSchema = z.object({
  role: z.enum(['library', 'download']),
  jellyfin: z.string().min(1).nullable(),
  container: z.string().min(1),
  qbit: z.string().min(1).nullable(),
}).superRefine((m, ctx) => {
  if (m.role === 'library' && m.jellyfin === null) {
    ctx.addIssue({ code: 'custom', message: 'library mappings require a jellyfin path' })
  }
  if (m.role === 'download' && m.jellyfin !== null) {
    ctx.addIssue({ code: 'custom', message: 'download mappings must set jellyfin to null' })
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
  trustProxy: z.boolean().default(false),
  sessionSecret: z.string().min(16),
  jellyfin: z.object({ url: z.string().url(), apiKey: z.string().min(1) }),
  qbittorrent: z.object({ url: z.string().url(), user: z.string().min(1), pass: z.string().min(1) }),
  radarr: arrSchema.nullable(),
  sonarr: arrSchema.nullable(),
})

export type EnvConfig = z.infer<typeof envConfigSchema>
export interface AppConfig { env: EnvConfig; file: FileConfig }
