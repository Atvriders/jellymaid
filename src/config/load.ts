// src/config/load.ts
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { envConfigSchema, fileConfigSchema, type AppConfig, type FileConfig } from './schema.js'

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Configuration is invalid:\n  - ${problems.join('\n  - ')}`)
    this.name = 'ConfigError'
  }
}

function requireArr(env: NodeJS.ProcessEnv, prefix: 'RADARR' | 'SONARR', problems: string[]) {
  const url = env[`${prefix}_URL`]
  const key = env[`${prefix}_API_KEY`]
  if (!url && !key) return null
  if (!url) problems.push(`${prefix}_URL is required when ${prefix}_API_KEY is set`)
  if (!key) problems.push(`${prefix}_API_KEY is required when ${prefix}_URL is set`)
  return url && key ? { url, apiKey: key } : null
}

export function configPath(dataDir: string): string {
  return join(dataDir, 'config.json')
}

export function readFileConfig(dataDir: string): FileConfig {
  const path = configPath(dataDir)
  const raw = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
  const parsed = fileConfigSchema.safeParse(raw)
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `config.json ${i.path.join('.') || '(root)'}: ${i.message}`))
  }
  return parsed.data
}

export function saveConfig(dataDir: string, patch: Partial<FileConfig>): FileConfig {
  mkdirSync(dataDir, { recursive: true })
  const merged = fileConfigSchema.parse({ ...readFileConfig(dataDir), ...patch })
  const target = configPath(dataDir)
  const tmp = `${target}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(merged, null, 2))
  renameSync(tmp, target)
  return merged
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const problems: string[] = []
  const dataDir = env.DATA_DIR ?? '/data'
  mkdirSync(dataDir, { recursive: true })

  for (const key of ['JELLYFIN_URL', 'JELLYFIN_API_KEY', 'QBIT_URL', 'QBIT_USER', 'QBIT_PASS']) {
    if (!env[key]) problems.push(`${key} is required`)
  }
  const radarr = requireArr(env, 'RADARR', problems)
  const sonarr = requireArr(env, 'SONARR', problems)
  if (problems.length) throw new ConfigError(problems)

  const parsed = envConfigSchema.safeParse({
    dataDir,
    port: env.PORT ?? 8099,
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
    sessionSecret: env.SESSION_SECRET ?? persistentSecret(dataDir),
    jellyfin: { url: env.JELLYFIN_URL, apiKey: env.JELLYFIN_API_KEY },
    qbittorrent: { url: env.QBIT_URL, user: env.QBIT_USER, pass: env.QBIT_PASS },
    radarr,
    sonarr,
  })
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`))
  }
  return { env: parsed.data, file: readFileConfig(dataDir) }
}

/** Session secret survives restarts so logins are not invalidated on every deploy. */
function persistentSecret(dataDir: string): string {
  const path = join(dataDir, '.session-secret')
  if (existsSync(path)) return readFileSync(path, 'utf8').trim()
  const secret = randomBytes(32).toString('hex')
  writeFileSync(path, secret, { mode: 0o600 })
  return secret
}
