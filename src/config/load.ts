// src/config/load.ts
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
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

/**
 * Unique PER CALL, not per process: worker threads share a pid, so a `${target}.${pid}.tmp` name
 * would have two concurrent savers writing the same temp file and renaming a torn copy into place.
 */
export function tempConfigPath(dataDir: string): string {
  return `${configPath(dataDir)}.${process.pid}.${randomUUID()}.tmp`
}

export function readFileConfig(dataDir: string): FileConfig {
  const path = configPath(dataDir)
  let raw: unknown = {}
  if (existsSync(path)) {
    try {
      raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
    } catch (err) {
      throw new ConfigError([`config.json is not valid JSON: ${(err as Error).message}`])
    }
  }
  const parsed = fileConfigSchema.safeParse(raw)
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `config.json ${i.path.join('.') || '(root)'}: ${i.message}`))
  }
  return parsed.data
}

export function saveConfig(dataDir: string, patch: Partial<FileConfig>): FileConfig {
  mkdirSync(dataDir, { recursive: true })
  const parsed = fileConfigSchema.safeParse({ ...readFileConfig(dataDir), ...patch })
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `config patch ${i.path.join('.') || '(root)'}: ${i.message}`))
  }
  const merged = parsed.data
  const target = configPath(dataDir)
  const tmp = tempConfigPath(dataDir)
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
  const trustProxy = parseHopCount(env.TRUST_PROXY, problems)
  // Every environment problem is reported together, so one restart surfaces all of them.
  if (problems.length) throw new ConfigError(problems)

  const parsed = envConfigSchema.safeParse({
    dataDir,
    port: env.PORT ?? 8099,
    trustProxy,
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

/**
 * TRUST_PROXY is a HOP COUNT, but it was historically a boolean, so `true`/`false` are still
 * accepted and mean 1/0. Anything else that is not an integer is a configuration error rather
 * than a silent 0: getting this wrong silently means the login lockout keys on a value the
 * caller controls.
 *
 * Both directions are dangerous, not just under-specifying it. Set it LOWER than the real proxy
 * count (0, behind a proxy) and every client collapses onto the proxy's own address, so the IP
 * lockout dimension locks EVERYONE at once after a few failed logins from any stranger. Set it
 * HIGHER than the real count and Fastify trusts an X-Forwarded-For token the CALLER wrote,
 * letting an attacker forge whatever "client IP" they like — picking a fresh lockout bucket
 * per request, or framing another address for one. It must equal the actual number of proxies
 * in front of this service, exactly — not a safety margin in either direction.
 */
function parseHopCount(raw: string | undefined, problems: string[]): number {
  if (raw === undefined || raw === '') return 0
  if (raw === 'false') return 0
  if (raw === 'true') return 1
  if (!/^\d+$/.test(raw.trim())) {
    problems.push(`TRUST_PROXY must be a proxy hop count (a non-negative integer), got ${JSON.stringify(raw)}`)
    return 0
  }
  return Number.parseInt(raw.trim(), 10)
}

/** Session secret survives restarts so logins are not invalidated on every deploy. */
function persistentSecret(dataDir: string): string {
  const path = join(dataDir, '.session-secret')
  // A pre-existing file wins outright — nothing to mint or write.
  if (existsSync(path)) return readFileSync(path, 'utf8').trim()
  const secret = randomBytes(32).toString('hex')
  // Unique per call, the same way tempConfigPath is: a pid-only name would have two concurrent
  // loaders (which share a pid across worker threads) write the same temp file.
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    // Write the FULL secret to a private temp file, then rename it into place. A concurrent
    // reader of `path` can now only ever observe "absent" or "fully written" — never the
    // empty/partial content that create-then-write ('wx') could expose in the window between
    // the create and the write completing.
    writeFileSync(tmp, secret, { mode: 0o600 })
    renameSync(tmp, path)
    return secret
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    // Another loader's write-then-rename won the race between our existsSync check and ours;
    // theirs is now the file on disk, and it is authoritative.
    return readFileSync(path, 'utf8').trim()
  }
}
