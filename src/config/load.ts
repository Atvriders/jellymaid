// src/config/load.ts
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  envConfigSchema, fileConfigSchema, QBIT_INSTANCE_ID_PATTERN,
  type AppConfig, type FileConfig, type QbitInstanceConfig,
} from './schema.js'

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

/**
 * The subtrees a settings screen edits one field at a time. Replacing them wholesale would make
 * `{ guards: { minRatio: 2 } }` silently reset every OTHER guard threshold to its default — on the
 * one object whose fields decide whether a private torrent may be deleted.
 */
const MERGED_SUBTREES = new Set(['guards', 'trash', 'keeper', 'rateLimits', 'rules'])

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Applies `patch` over the current config.json and writes the result atomically. The subtrees
 * `guards`, `trash`, `keeper`, `rateLimits` and `rules` are merged ONE level deep (patch keys
 * replace, siblings are kept; arrays and nested objects replace); every other key replaces
 * wholesale. A key whose value is `undefined` is ignored rather than reset.
 */
export function saveConfig(dataDir: string, patch: Partial<FileConfig>): FileConfig {
  mkdirSync(dataDir, { recursive: true })
  const current: Record<string, unknown> = { ...readFileConfig(dataDir) }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const prior = current[key]
    current[key] = MERGED_SUBTREES.has(key) && isPlainObject(value) && isPlainObject(prior)
      ? { ...prior, ...value }
      : value
  }
  const parsed = fileConfigSchema.safeParse(current)
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

  for (const key of ['JELLYFIN_URL', 'JELLYFIN_API_KEY']) {
    if (!env[key]) problems.push(`${key} is required`)
  }
  const qbittorrents = parseQbitInstances(env, problems)
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
    qbittorrents,
    radarr,
    sonarr,
  })
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`))
  }
  return { env: parsed.data, file: readFileConfig(dataDir) }
}

/**
 * QBIT_INSTANCES="id=url, id=url" (URL may embed user:pass@, percent-decoded; per-instance
 * QBIT_<ID>_USER / QBIT_<ID>_PASS override, <ID> = id uppercased, '-' -> '_'). Without it,
 * QBIT_URL (+ optional QBIT_USER/QBIT_PASS) defines id 'default'. Pushes a problem (and returns [])
 * when neither is set, an id is invalid or duplicated, a URL does not parse, or exactly one of
 * user/pass is set for an instance.
 *
 * Credentials are optional: an instance that bypasses authentication for this host needs none.
 * Half a credential is never optional, though — a username with no password can only ever produce
 * a failed login, and five of those get this host's address banned for an hour.
 *
 * All or nothing: one bad entry returns no instances at all, so a typo can never quietly shrink
 * the set of boxes Jellymaid believes exist.
 */
export function parseQbitInstances(env: NodeJS.ProcessEnv, problems: string[]): QbitInstanceConfig[] {
  const list = env.QBIT_INSTANCES?.trim()
  if (list) {
    const instances: QbitInstanceConfig[] = []
    const seen = new Set<string>()
    let failed = false
    // These problems become the ConfigError printed at boot, so none may carry a credential, and
    // an entry's text can hold one even where the parser expects an id. Until an entry has proved
    // to be an id=url pair (an id matching QBIT_INSTANCE_ID_PATTERN and a URL that parses as
    // http/https), a problem names it by its POSITION and quotes none of its text:
    //  - an entry that omits its "id=" is cut at the first "=" INSIDE its URL (base64 padding in a
    //    password, a query string), so its "id" is the front of the URL, user:pass@ included;
    //  - an unencoded "," inside a URL splits one entry in two. The second piece's "id" is the
    //    password text before its first "=", which can match the id pattern; its "URL" is the rest
    //    of the password plus the host, which does not parse as http(s) unless that password text
    //    itself happens to continue with "http:" or "https:".
    for (const [position, raw] of list.split(',').entries()) {
      const entry = raw.trim()
      if (!entry) continue
      const where = `QBIT_INSTANCES entry ${position + 1}`
      const eq = entry.indexOf('=')
      if (eq <= 0) {
        problems.push(`${where} must be id=url`)
        failed = true
        continue
      }
      const id = entry.slice(0, eq).trim()
      if (!QBIT_INSTANCE_ID_PATTERN.test(id)) {
        problems.push(`${where} has an invalid id: an id is 1-32 lowercase letters, digits or "-", starting with a letter or digit`)
        failed = true
        continue
      }
      // Recorded before the URL is checked but reported only once it has parsed: a repeat of an
      // id whose first entry was malformed still surfaces in the same restart, and a second piece
      // of the same split password is never quoted as "the id listed more than once".
      const repeated = seen.has(id)
      seen.add(id)
      const envKey = `QBIT_${id.toUpperCase().replaceAll('-', '_')}`
      const instance = qbitInstance(id, where, entry.slice(eq + 1).trim(), env[`${envKey}_USER`], env[`${envKey}_PASS`], problems)
      if (!instance) {
        failed = true
        continue
      }
      if (repeated) {
        problems.push(`QBIT_INSTANCES lists the instance id "${id}" more than once`)
        failed = true
        continue
      }
      instances.push(instance)
    }
    if (failed) return []
    if (instances.length === 0) {
      problems.push('QBIT_INSTANCES is set but names no instance')
      return []
    }
    return instances
  }

  if (env.QBIT_URL) {
    const instance = qbitInstance('default', 'qBittorrent instance "default"', env.QBIT_URL, env.QBIT_USER, env.QBIT_PASS, problems)
    return instance ? [instance] : []
  }
  problems.push('QBIT_INSTANCES (id=url, comma-separated) or QBIT_URL (a single instance) is required')
  return []
}

/**
 * One instance: credentials pulled out of the URL (env values win), the URL kept without them.
 * `where` names the instance in a problem about the URL itself. Until the URL has parsed as
 * http(s), `id` is not yet known to be an id at all (see parseQbitInstances), so it is not quoted.
 */
function qbitInstance(
  id: string, where: string, urlText: string, envUser: string | undefined, envPass: string | undefined,
  problems: string[],
): QbitInstanceConfig | null {
  let url: URL
  try {
    url = new URL(urlText)
  } catch {
    problems.push(`${where}: its URL is not a valid URL`)
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    problems.push(`${where}: the URL must be http:// or https://`)
    return null
  }
  let urlUser: string
  let urlPass: string
  try {
    urlUser = decodeURIComponent(url.username)
    urlPass = decodeURIComponent(url.password)
  } catch {
    problems.push(`qBittorrent instance "${id}": the credentials in its URL are not valid percent-encoding`)
    return null
  }
  const user = envUser || urlUser || null
  const pass = envPass || urlPass || null
  if ((user === null) !== (pass === null)) {
    problems.push(`qBittorrent instance "${id}" has a ${user === null ? 'password' : 'username'} but no ${user === null ? 'username' : 'password'} — set both or neither`)
    return null
  }
  // Rebuilt from its parts rather than by blanking username/password, which would leave the
  // trailing "/" URL serialisation adds to a bare origin. `origin` never carries credentials.
  const path = url.pathname === '/' ? '' : url.pathname
  return { id, url: `${url.origin}${path}${url.search}`, user, pass }
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
