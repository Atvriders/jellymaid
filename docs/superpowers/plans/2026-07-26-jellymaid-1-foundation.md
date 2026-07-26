# Jellymaid Plan 1 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Jellymaid container skeleton — typed config, the SQLite index schema, a resilient HTTP layer, the Jellyfin connector, path mapping with auto-detect/verify, Jellyfin-admin auth, and CI — so that an operator can log in and confirm their path mappings resolve.

**Architecture:** Single Node service. Fastify serves a JSON API plus (later) the built React SPA. All persistent state lives in one SQLite file under `DATA_DIR`, opened with `better-sqlite3` in WAL mode and evolved by forward-only numbered migrations. Every outbound integration goes through one shared HTTP core that owns retry, backoff, rate limiting and typed errors, so connectors contain protocol knowledge only.

**Tech Stack:** Node 22 (runtime/CI) · TypeScript 5.7 strict · Fastify 5 · better-sqlite3 11 · Zod 3.24 · Vitest 2 · React 19 + Vite 6 (client, wired in Plan 5)

**On Zod 3 rather than 4:** the config schema leans on nested `z.object({...}).default({})`, which relies on v3's *input*-typed defaults. Zod 4 types `.default()` against the output type, so every nested default would have to be spelled out in full. If the schema is ever reworked, migrating is fine — but do it deliberately, not as a drive-by `npm update`.

## Global Constraints

Copied verbatim from `docs/superpowers/specs/2026-07-26-jellymaid-design.md`. Every task's requirements implicitly include this section.

- **Node 22** is the runtime in the Docker image and in CI. `package.json` declares `"engines": { "node": ">=20.11" }` so the development sandbox (Node 20.20.2) can run the test suite locally.
- TypeScript **strict mode on**, `noUncheckedIndexedAccess: true`. No `any` in committed code; use `unknown` plus a Zod parse at every boundary.
- **Radarr/Sonarr are unmonitor-only.** No delete endpoint and no blocklist endpoint may appear anywhere in the codebase, in any slice, ever.
- Every threshold is configuration, never a literal buried in a rule.
- **Degraded means "not evaluated", never "zero".** Any code path that cannot check something must say so distinctly.
- All user-controlled strings (file names, torrent names, tracker hosts, dismiss reasons) render as text nodes only — never `innerHTML`.
- Secrets come from environment variables; everything else lives in `${DATA_DIR}/config.json`.
- Repo `Atvriders/jellymaid`, public. Image `ghcr.io/atvriders/jellymaid`, public, multi-arch.
- Dependency versions below are the tested pins, not floors. If `npm install` resolves a newer major, either pin back or fix the API drift in Task 1 — do not leave a half-migrated tree.
- Commit after every task. Conventional commit prefixes (`feat:`, `test:`, `chore:`, `docs:`).

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `vitest.config.ts` | Toolchain |
| `src/core/types.ts` | Shared domain types used by every later slice |
| `src/core/logger.ts` | Structured logging |
| `src/config/schema.ts` | Zod schemas for env and `config.json`, with defaults |
| `src/config/load.ts` | Load, merge, validate, persist configuration |
| `src/index/db.ts` | Open SQLite, apply migrations |
| `src/index/migrations/001_init.sql` | Full schema from spec §4 |
| `src/connectors/http.ts` | Retry, backoff, rate limit, typed connector errors |
| `src/connectors/jellyfin.ts` | Jellyfin protocol only |
| `src/fs/pathmap.ts` | Path translation, auto-detect, verification |
| `src/auth/lockout.ts` | Failure counting and lockout windows |
| `src/auth/session.ts` | Signed session cookie helpers |
| `src/api/auth.ts` | `/api/auth/*` routes |
| `src/api/health.ts` | `/healthz` |
| `src/api/pathmap.ts` | `/api/pathmap/*` routes |
| `src/server.ts` | Fastify app factory (no side effects on import) |
| `src/index.ts` | Process entry point |
| `.github/workflows/ci.yml` | typecheck → test → build |

---

### Task 1: Toolchain scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore` (exists — extend), `src/core/logger.ts`
- Test: `tests/core/logger.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `logger.info(msg, fields?)`, `logger.warn`, `logger.error`, `logger.child(bindings)` — every later module logs through this.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "jellymaid",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20.11" },
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@fastify/cookie": "^11.0.2",
    "@fastify/static": "^8.0.4",
    "better-sqlite3": "^11.7.0",
    "cron-parser": "^4.9.0",
    "fastify": "^5.2.0",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.12",
    "@types/node": "^22.10.5",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2023"],
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"],
  "exclude": ["node_modules", "dist", "client"]
}
```

- [ ] **Step 3: Write `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 20_000,
  },
})
```

- [ ] **Step 4: Write the failing test**

```ts
// tests/core/logger.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createLogger } from '../../src/core/logger.js'

describe('logger', () => {
  it('emits one JSON line per call with level, msg and fields', () => {
    const lines: string[] = []
    const log = createLogger({ level: 'info', sink: (l) => lines.push(l) })
    log.info('scan started', { scanId: 7 })
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0]!)
    expect(parsed.level).toBe('info')
    expect(parsed.msg).toBe('scan started')
    expect(parsed.scanId).toBe(7)
    expect(typeof parsed.ts).toBe('string')
  })

  it('suppresses messages below the configured level', () => {
    const lines: string[] = []
    const log = createLogger({ level: 'warn', sink: (l) => lines.push(l) })
    log.info('quiet')
    log.error('loud')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!).msg).toBe('loud')
  })

  it('child loggers merge their bindings into every line', () => {
    const lines: string[] = []
    const log = createLogger({ level: 'info', sink: (l) => lines.push(l) }).child({ module: 'scan' })
    log.info('tick')
    expect(JSON.parse(lines[0]!).module).toBe('scan')
  })
})
```

- [ ] **Step 5: Run it and confirm it fails**

Run: `npx vitest run tests/core/logger.test.ts`
Expected: FAIL — cannot resolve `src/core/logger.js`.

- [ ] **Step 6: Implement the logger**

```ts
// src/core/logger.ts
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
  child(bindings: Record<string, unknown>): Logger
}

export interface LoggerOptions {
  level: LogLevel
  sink?: (line: string) => void
  bindings?: Record<string, unknown>
}

export function createLogger(opts: LoggerOptions): Logger {
  const sink = opts.sink ?? ((line: string) => process.stdout.write(line + '\n'))
  const bindings = opts.bindings ?? {}
  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[level] < ORDER[opts.level]) return
    sink(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...bindings, ...fields }))
  }
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (extra) => createLogger({ ...opts, sink, bindings: { ...bindings, ...extra } }),
  }
}
```

- [ ] **Step 7: Install and run**

Run: `npm install && npx vitest run tests/core/logger.test.ts && npm run typecheck`
Expected: 3 tests PASS, typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts src/core/logger.ts tests/core/logger.test.ts
git commit -m "chore: toolchain scaffold and structured logger"
```

---

### Task 2: Shared domain types

**Files:**
- Create: `src/core/types.ts`
- Test: `tests/core/types.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the vocabulary every later slice imports — `PathRole`, `PathMapping`, `Subject`, `Finding`, `FindingClass`, `Severity`, `Confidence`, `RuleId`, `EvaluationStatus`, `ActionType`, `GuardId`, `GuardVerdict`, `ActionStatus`. Plans 2–6 must use these exact names.

- [ ] **Step 1: Write the failing test**

```ts
// tests/core/types.test.ts
import { describe, it, expect } from 'vitest'
import { findingId, FINDING_CLASSES, ACTION_TYPES, GUARD_IDS } from '../../src/core/types.js'

describe('findingId', () => {
  it('is stable for the same rule and subject key', () => {
    expect(findingId('dupe.provider-id', 'tmdb:603')).toBe(findingId('dupe.provider-id', 'tmdb:603'))
  })

  it('differs across rules and across subjects', () => {
    expect(findingId('dupe.provider-id', 'tmdb:603')).not.toBe(findingId('dupe.title-year', 'tmdb:603'))
    expect(findingId('dupe.provider-id', 'tmdb:603')).not.toBe(findingId('dupe.provider-id', 'tmdb:604'))
  })

  it('is independent of subject ordering within the key', () => {
    expect(findingId('dupe.provider-id', ['b', 'a'])).toBe(findingId('dupe.provider-id', ['a', 'b']))
  })

  it('does not collide when subject keys contain spaces', () => {
    // Paths and titles contain spaces; a space-joined key would make these identical.
    expect(findingId('r', ['x', 'y z'])).not.toBe(findingId('r', ['x y', 'z']))
  })

  it('is a 32-char hex string', () => {
    expect(findingId('fs.empty-folder', '/mnt/media/Movies/Old')).toMatch(/^[0-9a-f]{32}$/)
  })
})

describe('enumerations', () => {
  it('covers the four finding classes', () => {
    expect([...FINDING_CLASSES].sort()).toEqual(['duplicate', 'filesystem', 'metadata', 'quality'])
  })

  it('covers the five action types', () => {
    expect([...ACTION_TYPES].sort()).toEqual([
      'delete-junk-file', 'delete-media', 'merge-versions', 'remove-empty-folder', 'split-versions',
    ])
  })

  it('covers the four guards', () => {
    expect([...GUARD_IDS].sort()).toEqual([
      'guard.cross-seed', 'guard.hardlink', 'guard.private-ratio', 'guard.protected',
    ])
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/core/types.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the types**

```ts
// src/core/types.ts
import { createHash } from 'node:crypto'

export const FINDING_CLASSES = ['duplicate', 'filesystem', 'metadata', 'quality'] as const
export type FindingClass = (typeof FINDING_CLASSES)[number]

export const SEVERITIES = ['critical', 'warning', 'info'] as const
export type Severity = (typeof SEVERITIES)[number]

export const CONFIDENCES = ['exact', 'strong', 'possible'] as const
export type Confidence = (typeof CONFIDENCES)[number]

export type RuleId = string

/** A rule either ran, or could not run. There is no third state, and "ran with no results" is `evaluated`. */
export const EVALUATION_STATUSES = ['evaluated', 'not-evaluated'] as const
export type EvaluationStatus = (typeof EVALUATION_STATUSES)[number]

export type Subject =
  | { kind: 'item'; id: string; label: string; path?: string }
  | { kind: 'path'; path: string; label: string }

export interface Finding {
  id: string
  ruleId: RuleId
  class: FindingClass
  severity: Severity
  confidence: Confidence
  subjects: Subject[]
  evidence: Record<string, unknown>
  reclaimableBytes: number | null
  status: 'open' | 'dismissed' | 'resolved'
  firstSeen: string
  lastSeen: string
}

export const ACTION_TYPES = [
  'merge-versions', 'split-versions', 'delete-media', 'remove-empty-folder', 'delete-junk-file',
] as const
export type ActionType = (typeof ACTION_TYPES)[number]

export const ACTION_STATUSES = ['pending', 'running', 'done', 'failed', 'skipped', 'blocked'] as const
export type ActionStatus = (typeof ACTION_STATUSES)[number]

export const GUARD_IDS = [
  'guard.private-ratio', 'guard.cross-seed', 'guard.hardlink', 'guard.protected',
] as const
export type GuardId = (typeof GUARD_IDS)[number]

export interface GuardVerdict {
  guard: GuardId
  outcome: 'pass' | 'warn' | 'block'
  overridable: boolean
  reason: string
  evidence: Record<string, unknown>
}

export type PathRole = 'library' | 'download'

export interface PathMapping {
  role: PathRole
  /** null for download-only roots that have no Jellyfin equivalent. */
  jellyfin: string | null
  container: string
  qbit: string | null
}

/**
 * Stable identity for a finding. Must not change across rescans, or dismissals
 * would resurrect. Arrays are sorted so subject ordering cannot perturb the id.
 *
 * The array separator is NUL, not a space: subject keys are file paths and titles,
 * which contain spaces freely. Joining on a space would make ['x', 'y z'] and
 * ['x y', 'z'] hash identically, silently fusing two unrelated findings.
 */
export function findingId(ruleId: RuleId, subjectKey: string | string[]): string {
  const key = Array.isArray(subjectKey) ? [...subjectKey].sort().join('\\0') : subjectKey
  return createHash('sha256').update(`${ruleId} ${key}`).digest('hex').slice(0, 32)
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run tests/core/types.test.ts && npm run typecheck`
Expected: 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts tests/core/types.test.ts
git commit -m "feat: shared domain types and stable finding ids"
```

---

### Task 3: Configuration schema and loader

**Files:**
- Create: `src/config/schema.ts`, `src/config/load.ts`
- Test: `tests/config/load.test.ts`

**Interfaces:**
- Consumes: `PathMapping` from Task 2.
- Produces:
  - `loadConfig(env: NodeJS.ProcessEnv): AppConfig` — merges env secrets with `${DATA_DIR}/config.json`, applying defaults; throws `ConfigError` listing every problem at once.
  - `saveConfig(dataDir: string, patch: Partial<FileConfig>): FileConfig`
  - `AppConfig = { env: EnvConfig; file: FileConfig }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/config/load.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, saveConfig, ConfigError } from '../../src/config/load.js'

let dir: string
const baseEnv = () => ({
  DATA_DIR: dir,
  JELLYFIN_URL: 'http://jf:8096',
  JELLYFIN_API_KEY: 'k',
  QBIT_URL: 'http://qb:8080',
  QBIT_USER: 'u',
  QBIT_PASS: 'p',
})

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'jm-cfg-')) })

describe('loadConfig', () => {
  it('applies documented defaults when config.json is absent', () => {
    const cfg = loadConfig(baseEnv())
    expect(cfg.file.scanCron).toBe('0 3 * * *')
    expect(cfg.file.guards.minRatio).toBe(1.0)
    expect(cfg.file.guards.minSeedTimeDays).toBe(14)
    expect(cfg.file.trash.maxBytes).toBe(1_073_741_824)
    expect(cfg.file.trash.retentionDays).toBe(30)
    expect(cfg.file.rules['dupe.fuzzy-title'].similarity).toBe(0.88)
    expect(cfg.file.pathMappings).toEqual([])
  })

  it('reports every missing required secret in one error', () => {
    let caught: unknown
    try { loadConfig({ DATA_DIR: dir }) } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(ConfigError)
    const msg = (caught as ConfigError).message
    for (const k of ['JELLYFIN_URL', 'JELLYFIN_API_KEY', 'QBIT_URL', 'QBIT_USER', 'QBIT_PASS']) {
      expect(msg).toContain(k)
    }
  })

  it('treats Radarr and Sonarr as optional', () => {
    const cfg = loadConfig(baseEnv())
    expect(cfg.env.radarr).toBeNull()
    expect(cfg.env.sonarr).toBeNull()
    const withArr = loadConfig({ ...baseEnv(), RADARR_URL: 'http://r:7878', RADARR_API_KEY: 'rk' })
    expect(withArr.env.radarr).toEqual({ url: 'http://r:7878', apiKey: 'rk' })
  })

  it('rejects a half-configured *arr instead of silently ignoring it', () => {
    expect(() => loadConfig({ ...baseEnv(), RADARR_URL: 'http://r:7878' })).toThrow(/RADARR_API_KEY/)
  })

  it('merges config.json over defaults without dropping unspecified keys', () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ scanCron: '30 4 * * *' }))
    const cfg = loadConfig(baseEnv())
    expect(cfg.file.scanCron).toBe('30 4 * * *')
    expect(cfg.file.guards.minRatio).toBe(1.0)
  })

  it('rejects a download mapping that declares a jellyfin path', () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      pathMappings: [{ role: 'download', jellyfin: '/media/X', container: '/mnt/d', qbit: '/downloads' }],
    }))
    expect(() => loadConfig(baseEnv())).toThrow(/download/i)
  })

  it('rejects a library mapping without a jellyfin path', () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      pathMappings: [{ role: 'library', jellyfin: null, container: '/mnt/m', qbit: null }],
    }))
    expect(() => loadConfig(baseEnv())).toThrow(/library/i)
  })

  it('reports malformed JSON as a ConfigError, not a raw SyntaxError', () => {
    writeFileSync(join(dir, 'config.json'), '{ not valid json')
    expect(() => loadConfig(baseEnv())).toThrow(ConfigError)
    expect(() => loadConfig(baseEnv())).toThrow(/not valid JSON/)
  })
})

describe('saveConfig', () => {
  it('persists a patch and leaves other keys at their prior values', () => {
    saveConfig(dir, { scanCron: '0 5 * * *' })
    saveConfig(dir, { trash: { maxBytes: 500, retentionDays: 7 } })
    const written = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
    expect(written.scanCron).toBe('0 5 * * *')
    expect(written.trash.maxBytes).toBe(500)
  })

  it('writes atomically via a temp file so a crash cannot truncate config', () => {
    saveConfig(dir, { scanCron: '0 6 * * *' })
    const cfg = loadConfig(baseEnv())
    expect(cfg.file.scanCron).toBe('0 6 * * *')
  })

  it('throws ConfigError, not a raw ZodError, on an invalid patch', () => {
    expect(() => saveConfig(dir, {
      pathMappings: [{ role: 'library', jellyfin: null, container: '/mnt/m', qbit: null }],
    } as never)).toThrow(ConfigError)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/config/load.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the schema**

```ts
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
```

- [ ] **Step 4: Write the loader**

```ts
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
  let raw: unknown = {}
  if (existsSync(path)) {
    // A hand-edited or truncated config.json must surface as ConfigError like every
    // other config problem — never as a raw SyntaxError from the JSON parser.
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
  // safeParse, not parse: an invalid patch must throw the same ConfigError shape a
  // caller already handles, or a settings route renders a 500 where it means 400.
  const candidate = fileConfigSchema.safeParse({ ...readFileConfig(dataDir), ...patch })
  if (!candidate.success) {
    throw new ConfigError(candidate.error.issues.map((i) => `config patch ${i.path.join('.') || '(root)'}: ${i.message}`))
  }
  const merged = candidate.data
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
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run tests/config/load.test.ts && npm run typecheck`
Expected: 9 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/config tests/config
git commit -m "feat: typed configuration with env secrets and config.json overlay"
```

---

### Task 4: SQLite index and migrations

**Files:**
- Create: `src/index/db.ts`, `src/index/migrations/001_init.sql`
- Test: `tests/index/db.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `openDb(path: string): Database` (WAL, foreign keys on, migrations applied), `migrate(db)`, `currentSchemaVersion(db): number`. Plans 2–4 write to these tables and must not alter this file's schema except by adding a new numbered migration.

- [ ] **Step 1: Write the failing test**

```ts
// tests/index/db.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, currentSchemaVersion } from '../../src/index/db.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'jm-db-')) })

describe('openDb', () => {
  it('creates every table the spec requires', () => {
    const db = openDb(join(dir, 'test.db'))
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
      .map((r) => (r as { name: string }).name)
    for (const t of [
      'scans', 'jellyfin_items', 'fs_entries', 'torrents', 'torrent_files', 'arr_records',
      'findings', 'dupe_groups', 'plans', 'plan_actions', 'audit', 'trash', 'kv', 'rule_runs',
    ]) {
      expect(names).toContain(t)
    }
  })

  it('enables WAL and foreign keys', () => {
    const db = openDb(join(dir, 'test.db'))
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
  })

  it('indexes the (dev, inode) join key on both filesystem and torrent files', () => {
    const db = openDb(join(dir, 'test.db'))
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all()
      .map((r) => (r as { name: string }).name)
    expect(idx).toContain('idx_fs_entries_inode')
    expect(idx).toContain('idx_torrent_files_inode')
  })

  it('is idempotent — reopening applies no further migrations', () => {
    const path = join(dir, 'test.db')
    const first = openDb(path)
    const v = currentSchemaVersion(first)
    first.close()
    const second = openDb(path)
    expect(currentSchemaVersion(second)).toBe(v)
  })

  it('round-trips a finding row', () => {
    const db = openDb(join(dir, 'test.db'))
    db.prepare(`INSERT INTO findings
      (id, rule_id, class, severity, confidence, subjects_json, evidence_json,
       reclaimable_bytes, status, first_seen, last_seen)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run('abc', 'dupe.provider-id', 'duplicate', 'warning', 'exact', '[]', '{}', 42, 'open', 't', 't')
    const row = db.prepare('SELECT * FROM findings WHERE id = ?').get('abc') as { reclaimable_bytes: number }
    expect(row.reclaimable_bytes).toBe(42)
  })

  it('cascades plan_actions when a plan is deleted', () => {
    const db = openDb(join(dir, 'test.db'))
    db.prepare('INSERT INTO plans (id, created_at, created_by, status) VALUES (?,?,?,?)')
      .run('p1', 't', 'admin', 'draft')
    db.prepare('INSERT INTO plan_actions (id, plan_id, seq, type, payload_json, status) VALUES (?,?,?,?,?,?)')
      .run('a1', 'p1', 0, 'delete-media', '{}', 'pending')
    db.prepare('DELETE FROM plans WHERE id = ?').run('p1')
    expect(db.prepare('SELECT COUNT(*) c FROM plan_actions').get()).toEqual({ c: 0 })
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/index/db.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the migration**

```sql
-- src/index/migrations/001_init.sql
CREATE TABLE scans (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  status        TEXT NOT NULL,           -- running | completed | cancelled | failed
  phase         TEXT,                    -- jellyfin | filesystem | qbittorrent | arr | rules | reconcile
  cursor_json   TEXT NOT NULL DEFAULT '{}',
  stats_json    TEXT NOT NULL DEFAULT '{}',
  error         TEXT
);

CREATE TABLE jellyfin_items (
  id                TEXT PRIMARY KEY,
  scan_id           INTEGER NOT NULL,
  type              TEXT NOT NULL,
  name              TEXT NOT NULL,
  sort_name         TEXT,
  year              INTEGER,
  series_id         TEXT,
  series_name       TEXT,
  season_no         INTEGER,
  episode_no        INTEGER,
  provider_ids_json TEXT NOT NULL DEFAULT '{}',
  jf_path           TEXT,
  container_path    TEXT,
  size_bytes        INTEGER,
  runtime_ticks     INTEGER,
  container         TEXT,
  video_codec       TEXT,
  audio_codec       TEXT,
  audio_channels    INTEGER,
  width             INTEGER,
  height            INTEGER,
  bitrate           INTEGER,
  has_primary_image INTEGER NOT NULL DEFAULT 0,
  library_id        TEXT,
  library_name      TEXT,
  date_created      TEXT,
  media_source_id   TEXT
);
CREATE INDEX idx_jellyfin_items_container_path ON jellyfin_items (container_path);
CREATE INDEX idx_jellyfin_items_episode ON jellyfin_items (series_id, season_no, episode_no);
CREATE INDEX idx_jellyfin_items_scan ON jellyfin_items (scan_id);

CREATE TABLE fs_entries (
  container_path TEXT PRIMARY KEY,
  scan_id        INTEGER NOT NULL,
  parent_path    TEXT NOT NULL,
  name           TEXT NOT NULL,
  ext            TEXT,
  is_dir         INTEGER NOT NULL,
  size_bytes     INTEGER NOT NULL DEFAULT 0,
  mtime          INTEGER NOT NULL DEFAULT 0,
  dev            INTEGER NOT NULL DEFAULT 0,
  inode          INTEGER NOT NULL DEFAULT 0,
  nlink          INTEGER NOT NULL DEFAULT 1,
  is_media       INTEGER NOT NULL DEFAULT 0,
  library_root   TEXT,
  root_role      TEXT,                   -- library | download
  quick_hash     TEXT
);
CREATE INDEX idx_fs_entries_inode ON fs_entries (dev, inode);
CREATE INDEX idx_fs_entries_parent ON fs_entries (parent_path);
CREATE INDEX idx_fs_entries_root ON fs_entries (library_root, is_media);
CREATE INDEX idx_fs_entries_hash ON fs_entries (quick_hash) WHERE quick_hash IS NOT NULL;

CREATE TABLE torrents (
  hash                   TEXT PRIMARY KEY,
  fetched_at             TEXT NOT NULL,
  name                   TEXT NOT NULL,
  save_path              TEXT,
  content_path           TEXT,
  container_content_path TEXT,
  category               TEXT,
  tags                   TEXT,
  state                  TEXT,
  ratio                  REAL,
  seeding_time           INTEGER,
  is_private             INTEGER,
  tracker_host           TEXT,
  size_bytes             INTEGER,
  progress               REAL
);

CREATE TABLE torrent_files (
  hash           TEXT NOT NULL,
  file_index     INTEGER NOT NULL,
  rel_path       TEXT NOT NULL,
  container_path TEXT,
  size_bytes     INTEGER,
  dev            INTEGER,
  inode          INTEGER,
  PRIMARY KEY (hash, file_index)
);
CREATE INDEX idx_torrent_files_inode ON torrent_files (dev, inode);
CREATE INDEX idx_torrent_files_path ON torrent_files (container_path);

CREATE TABLE arr_records (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,          -- radarr | sonarr
  instance        TEXT NOT NULL,
  remote_id       INTEGER NOT NULL,
  title           TEXT NOT NULL,
  arr_path        TEXT,
  container_path  TEXT,
  monitored       INTEGER NOT NULL DEFAULT 1,
  series_id       INTEGER,
  episode_id      INTEGER,
  episode_file_id INTEGER
);
CREATE INDEX idx_arr_records_path ON arr_records (container_path);

CREATE TABLE findings (
  id                TEXT PRIMARY KEY,
  rule_id           TEXT NOT NULL,
  class             TEXT NOT NULL,
  severity          TEXT NOT NULL,
  confidence        TEXT NOT NULL,
  subjects_json     TEXT NOT NULL,
  evidence_json     TEXT NOT NULL,
  reclaimable_bytes INTEGER,
  status            TEXT NOT NULL,        -- open | dismissed | resolved
  first_seen        TEXT NOT NULL,
  last_seen         TEXT NOT NULL,
  dismissed_reason  TEXT,
  dismissed_by      TEXT,
  dismissed_at      TEXT
);
CREATE INDEX idx_findings_class_status ON findings (class, status);
CREATE INDEX idx_findings_rule ON findings (rule_id);

-- One row per rule per scan. This is how "not evaluated" is distinguished from "zero findings".
CREATE TABLE rule_runs (
  scan_id   INTEGER NOT NULL,
  rule_id   TEXT NOT NULL,
  status    TEXT NOT NULL,                -- evaluated | not-evaluated
  reason    TEXT,
  found     INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  PRIMARY KEY (scan_id, rule_id)
);

CREATE TABLE dupe_groups (
  id             TEXT PRIMARY KEY,
  tier           TEXT NOT NULL,
  members_json   TEXT NOT NULL,
  keeper_item_id TEXT,
  scores_json    TEXT NOT NULL DEFAULT '{}',
  status         TEXT NOT NULL DEFAULT 'open'
);

CREATE TABLE plans (
  id            TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  status        TEXT NOT NULL,            -- draft | approved | running | completed | failed
  dry_run_json  TEXT NOT NULL DEFAULT '{}',
  approved_at   TEXT,
  approved_by   TEXT,
  started_at    TEXT,
  finished_at   TEXT
);

CREATE TABLE plan_actions (
  id                  TEXT PRIMARY KEY,
  plan_id             TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  seq                 INTEGER NOT NULL,
  type                TEXT NOT NULL,
  payload_json        TEXT NOT NULL,
  guard_verdicts_json TEXT NOT NULL DEFAULT '[]',
  status              TEXT NOT NULL,
  started_at          TEXT,
  finished_at         TEXT,
  error               TEXT,
  result_json         TEXT,
  override_by         TEXT,
  override_reason     TEXT
);
CREATE INDEX idx_plan_actions_plan ON plan_actions (plan_id, seq);

CREATE TABLE audit (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             TEXT NOT NULL,
  actor          TEXT NOT NULL,
  action_type    TEXT NOT NULL,
  subject        TEXT NOT NULL,
  before_json    TEXT,
  after_json     TEXT,
  outcome        TEXT NOT NULL,
  plan_id        TEXT,
  plan_action_id TEXT
);
CREATE INDEX idx_audit_ts ON audit (ts DESC);

CREATE TABLE trash (
  id            TEXT PRIMARY KEY,
  original_path TEXT NOT NULL,
  trash_path    TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  deleted_at    TEXT NOT NULL,
  purge_after   TEXT NOT NULL,
  restored_at   TEXT,
  plan_id       TEXT
);

CREATE TABLE kv (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);
```

- [ ] **Step 4: Write the database module**

```ts
// src/index/db.ts
import Database from 'better-sqlite3'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type Db = Database.Database

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations')

export function currentSchemaVersion(db: Db): number {
  return db.pragma('user_version', { simple: true }) as number
}

export function migrate(db: Db): void {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
  for (const file of files) {
    const version = Number.parseInt(file.slice(0, 3), 10)
    if (Number.isNaN(version)) throw new Error(`migration ${file} must start with a 3-digit version`)
    if (version <= currentSchemaVersion(db)) continue
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
    db.exec('BEGIN')
    try {
      db.exec(sql)
      db.pragma(`user_version = ${version}`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw new Error(`migration ${file} failed: ${(err as Error).message}`)
    }
  }
}

export function openDb(path: string): Db {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('synchronous = NORMAL')
  migrate(db)
  return db
}
```

- [ ] **Step 5: Ensure the SQL ships with the build**

Add to `package.json` scripts so compiled output can find migrations:

```json
"build": "tsc -p tsconfig.json && node -e \"require('fs').cpSync('src/index/migrations','dist/src/index/migrations',{recursive:true})\""
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npx vitest run tests/index/db.test.ts && npm run typecheck`
Expected: 6 tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/index tests/index package.json
git commit -m "feat: sqlite index schema and forward-only migrations"
```

---

### Task 5: HTTP core — retry, rate limit, typed errors

**Files:**
- Create: `src/connectors/http.ts`
- Test: `tests/connectors/http.test.ts`

**Interfaces:**
- Consumes: nothing. (This module deliberately does not log — it has no way to know which of a caller's retries are expected, and a shared client that narrates would drown the scan log. Callers decide what is worth reporting.)
- Produces: `class HttpClient { constructor(opts: HttpClientOptions); request<T>(path, init?, parse?): Promise<T> }` and `class ConnectorError extends Error { kind: ConnectorErrorKind; service: string; status?: number }` with `ConnectorErrorKind = 'unreachable' | 'auth' | 'rate-limited' | 'bad-response' | 'timeout'`. Every connector in Plans 1–2 is built on this and throws only `ConnectorError`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/connectors/http.test.ts
import { describe, it, expect, vi } from 'vitest'
import { HttpClient, ConnectorError } from '../../src/connectors/http.js'

const client = (fetchImpl: typeof fetch, over: Partial<ConstructorParameters<typeof HttpClient>[0]> = {}) =>
  new HttpClient({
    service: 'test', baseUrl: 'http://x', fetchImpl,
    concurrency: 2, minDelayMs: 0, maxRetries: 2, backoffBaseMs: 1, timeoutMs: 50,
    ...over,
  })

describe('HttpClient', () => {
  it('returns parsed JSON on success', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 }))
    await expect(client(f as unknown as typeof fetch).request('/a')).resolves.toEqual({ ok: 1 })
  })

  it('retries 5xx and succeeds on a later attempt', async () => {
    let n = 0
    const f = vi.fn(async () => {
      n += 1
      return n < 3 ? new Response('boom', { status: 503 }) : new Response('{"ok":2}', { status: 200 })
    })
    await expect(client(f as unknown as typeof fetch).request('/a')).resolves.toEqual({ ok: 2 })
    expect(n).toBe(3)
  })

  it('does NOT retry a 401 — auth failures are permanent', async () => {
    const f = vi.fn(async () => new Response('nope', { status: 401 }))
    const err = await client(f as unknown as typeof fetch).request('/a').catch((e) => e)
    expect(err).toBeInstanceOf(ConnectorError)
    expect(err.kind).toBe('auth')
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('classifies 429 as rate-limited and retries it', async () => {
    let n = 0
    const f = vi.fn(async () => (++n < 2 ? new Response('', { status: 429 }) : new Response('{}', { status: 200 })))
    await expect(client(f as unknown as typeof fetch).request('/a')).resolves.toEqual({})
    expect(n).toBe(2)
  })

  it('classifies a network throw as unreachable after exhausting retries', async () => {
    const f = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    const err = await client(f as unknown as typeof fetch).request('/a').catch((e) => e)
    expect(err.kind).toBe('unreachable')
    expect(f).toHaveBeenCalledTimes(3)
  })

  it('classifies unparseable JSON as bad-response without retrying', async () => {
    const f = vi.fn(async () => new Response('<html>', { status: 200 }))
    const err = await client(f as unknown as typeof fetch).request('/a').catch((e) => e)
    expect(err.kind).toBe('bad-response')
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('never exceeds the configured concurrency', async () => {
    let inFlight = 0
    let peak = 0
    const f = vi.fn(async () => {
      inFlight += 1; peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight -= 1
      return new Response('{}', { status: 200 })
    })
    const c = client(f as unknown as typeof fetch)
    await Promise.all(Array.from({ length: 10 }, () => c.request('/a')))
    expect(peak).toBeLessThanOrEqual(2)
  })

  it('times out a hung request', async () => {
    const f = vi.fn((_u: string, init?: RequestInit) => new Promise<Response>((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))
    }))
    const err = await client(f as unknown as typeof fetch, { maxRetries: 0 }).request('/a').catch((e) => e)
    expect(err.kind).toBe('timeout')
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/connectors/http.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the HTTP core**

```ts
// src/connectors/http.ts
export type ConnectorErrorKind = 'unreachable' | 'auth' | 'rate-limited' | 'bad-response' | 'timeout'

export class ConnectorError extends Error {
  constructor(
    public readonly kind: ConnectorErrorKind,
    public readonly service: string,
    message: string,
    public readonly status?: number,
  ) {
    super(`[${service}] ${kind}: ${message}`)
    this.name = 'ConnectorError'
  }
}

export interface HttpClientOptions {
  service: string
  baseUrl: string
  concurrency: number
  minDelayMs: number
  maxRetries?: number
  backoffBaseMs?: number
  timeoutMs?: number
  defaultHeaders?: Record<string, string>
  fetchImpl?: typeof fetch
}

/** Serialises work so no more than `concurrency` requests are in flight, with a floor delay between starts. */
class Gate {
  private active = 0
  private queue: Array<() => void> = []
  private lastStart = 0
  constructor(private readonly concurrency: number, private readonly minDelayMs: number) {}

  async acquire(): Promise<void> {
    if (this.active >= this.concurrency) {
      await new Promise<void>((resolve) => this.queue.push(resolve))
    }
    this.active += 1
    // Reserve the start slot SYNCHRONOUSLY, before any await. Computing the wait from
    // lastStart and only writing it back after sleeping lets every concurrent waiter
    // read the same stale value, sleep in parallel, and start in the same tick —
    // silently defeating the rate limit at exactly the concurrency it exists for.
    const now = Date.now()
    const startAt = Math.max(now, this.lastStart + this.minDelayMs)
    this.lastStart = startAt
    const wait = startAt - now
    if (wait > 0) await sleep(wait)
  }

  release(): void {
    this.active -= 1
    this.queue.shift()?.()
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class HttpClient {
  private readonly gate: Gate
  private readonly fetchImpl: typeof fetch

  constructor(private readonly opts: HttpClientOptions) {
    this.gate = new Gate(opts.concurrency, opts.minDelayMs)
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  async request<T>(path: string, init: RequestInit = {}, parse: 'json' | 'text' | 'none' = 'json'): Promise<T> {
    const maxRetries = this.opts.maxRetries ?? 3
    const backoffBase = this.opts.backoffBaseMs ?? 250
    const url = path.startsWith('http') ? path : `${this.opts.baseUrl.replace(/\/$/, '')}${path}`
    let lastError: ConnectorError | null = null

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      await this.gate.acquire()
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 30_000)
      try {
        const res = await this.fetchImpl(url, {
          ...init,
          signal: controller.signal,
          headers: { ...this.opts.defaultHeaders, ...(init.headers as Record<string, string> | undefined) },
        })
        // Undici keeps a connection out of the keep-alive pool until its body is
        // consumed. This client polls qBittorrent and *arr forever and meets 429/5xx
        // routinely, so every non-success branch discards the body before leaving.
        const discardBody = () => res.body?.cancel().catch(() => undefined)

        if (res.status === 401 || res.status === 403) {
          await discardBody()
          throw new ConnectorError('auth', this.opts.service, `HTTP ${res.status}`, res.status)
        }
        if (res.status === 429) {
          await discardBody()
          lastError = new ConnectorError('rate-limited', this.opts.service, 'HTTP 429', 429)
        } else if (res.status >= 500) {
          await discardBody()
          lastError = new ConnectorError('unreachable', this.opts.service, `HTTP ${res.status}`, res.status)
        } else if (!res.ok) {
          await discardBody()
          throw new ConnectorError('bad-response', this.opts.service, `HTTP ${res.status}`, res.status)
        } else {
          if (parse === 'none') return undefined as T
          const body = await res.text()
          if (parse === 'text') return body as T
          try {
            return (body.length ? JSON.parse(body) : {}) as T
          } catch {
            throw new ConnectorError('bad-response', this.opts.service, 'response was not JSON', res.status)
          }
        }
      } catch (err) {
        if (err instanceof ConnectorError) {
          if (err.kind === 'auth' || err.kind === 'bad-response') throw err
          lastError = err
        } else if ((err as Error).name === 'AbortError') {
          lastError = new ConnectorError('timeout', this.opts.service, `no response in ${this.opts.timeoutMs ?? 30_000}ms`)
        } else {
          lastError = new ConnectorError('unreachable', this.opts.service, (err as Error).message)
        }
      } finally {
        clearTimeout(timer)
        this.gate.release()
      }
      if (attempt < maxRetries) await sleep(backoffBase * 2 ** attempt)
    }
    throw lastError ?? new ConnectorError('unreachable', this.opts.service, 'exhausted retries')
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run tests/connectors/http.test.ts && npm run typecheck`
Expected: 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/connectors/http.ts tests/connectors/http.test.ts
git commit -m "feat: http core with typed connector errors, retry and rate limiting"
```

---

### Task 6: Jellyfin connector

**Files:**
- Create: `src/connectors/jellyfin.ts`
- Test: `tests/connectors/jellyfin.test.ts`

**Interfaces:**
- Consumes: `HttpClient`, `ConnectorError` (Task 5).
- Produces:
  - `createJellyfinClient(opts): JellyfinClient`
  - `JellyfinClient.authenticateByName(username, password): Promise<{ userId: string; token: string; isAdministrator: boolean }>` — logs out the token before returning.
  - `.virtualFolders(): Promise<JellyfinLibrary[]>` where `JellyfinLibrary = { id: string; name: string; collectionType: string | null; locations: string[] }`
  - `.items(opts: { startIndex: number; limit: number }): Promise<{ items: JellyfinItem[]; totalRecordCount: number }>`
  - `.mergeVersions(ids: string[]): Promise<void>` · `.splitVersions(id): Promise<void>` · `.deleteItem(id): Promise<void>` · `.refreshLibrary(): Promise<void>`
  - `JellyfinItem` — normalized row shape consumed by Plan 2's scan phase.

- [ ] **Step 1: Write the failing test**

```ts
// tests/connectors/jellyfin.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createJellyfinClient } from '../../src/connectors/jellyfin.js'

function stub(routes: Record<string, unknown>, spy?: (url: string, init?: RequestInit) => void) {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    spy?.(u, init)
    const key = Object.keys(routes).find((k) => u.includes(k))
    if (!key) return new Response('not found', { status: 404 })
    return new Response(JSON.stringify(routes[key]), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
}

const opts = (fetchImpl: typeof fetch) => ({
  url: 'http://jf:8096', apiKey: 'K', concurrency: 4, minDelayMs: 0, fetchImpl,
})

describe('authenticateByName', () => {
  it('sends the MediaBrowser Authorization header and the password only in the body', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = []
    const f = stub({
      '/Users/AuthenticateByName': { User: { Id: 'u1' }, AccessToken: 'T' },
      '/Users/Me': { Id: 'u1', Policy: { IsAdministrator: true } },
      '/Sessions/Logout': {},
    }, (url, init) => seen.push({ url, init }))

    const client = createJellyfinClient(opts(f))
    const res = await client.authenticateByName('bob', 'hunter2')
    expect(res).toEqual({ userId: 'u1', token: 'T', isAdministrator: true })

    const auth = seen.find((s) => s.url.includes('AuthenticateByName'))!
    const header = (auth.init!.headers as Record<string, string>)['Authorization']
    expect(header).toMatch(/^MediaBrowser Client="Jellymaid"/)
    expect(header).not.toContain('hunter2')
    expect(String(auth.init!.body)).toContain('hunter2')
  })

  it('revokes the user token before returning', async () => {
    const urls: string[] = []
    const f = stub({
      '/Users/AuthenticateByName': { User: { Id: 'u1' }, AccessToken: 'T' },
      '/Users/Me': { Id: 'u1', Policy: { IsAdministrator: false } },
      '/Sessions/Logout': {},
    }, (u) => urls.push(u))
    await createJellyfinClient(opts(f)).authenticateByName('bob', 'pw')
    expect(urls.some((u) => u.includes('/Sessions/Logout'))).toBe(true)
  })

  it('reports non-admins as isAdministrator false rather than throwing', async () => {
    const f = stub({
      '/Users/AuthenticateByName': { User: { Id: 'u2' }, AccessToken: 'T' },
      '/Users/Me': { Id: 'u2', Policy: { IsAdministrator: false } },
      '/Sessions/Logout': {},
    })
    const res = await createJellyfinClient(opts(f)).authenticateByName('eve', 'pw')
    expect(res.isAdministrator).toBe(false)
  })
})

describe('items', () => {
  it('normalizes a movie row including media stream details', async () => {
    const f = stub({
      '/Items': {
        TotalRecordCount: 1,
        Items: [{
          Id: 'i1', Type: 'Movie', Name: 'Heat', ProductionYear: 1995,
          Path: '/media/Movies/Heat (1995)/Heat.mkv',
          ProviderIds: { Tmdb: '949', Imdb: 'tt0113277' },
          RunTimeTicks: 106_920_000_000,
          ImageTags: { Primary: 'abc' },
          MediaSources: [{
            Id: 'ms1', Size: 12345, Container: 'mkv', Bitrate: 8_000_000,
            MediaStreams: [
              { Type: 'Video', Codec: 'h264', Width: 1920, Height: 1080 },
              { Type: 'Audio', Codec: 'dts', Channels: 6 },
            ],
          }],
        }],
      },
    })
    const { items, totalRecordCount } = await createJellyfinClient(opts(f)).items({ startIndex: 0, limit: 500 })
    expect(totalRecordCount).toBe(1)
    expect(items[0]).toMatchObject({
      id: 'i1', type: 'Movie', name: 'Heat', year: 1995,
      jfPath: '/media/Movies/Heat (1995)/Heat.mkv',
      providerIds: { tmdb: '949', imdb: 'tt0113277' },
      sizeBytes: 12345, container: 'mkv', bitrate: 8_000_000,
      videoCodec: 'h264', width: 1920, height: 1080,
      audioCodec: 'dts', audioChannels: 6,
      hasPrimaryImage: true,
    })
  })

  it('lowercases provider id keys so rules can match on one spelling', async () => {
    const f = stub({ '/Items': { TotalRecordCount: 1, Items: [{ Id: 'i', Type: 'Movie', Name: 'X', ProviderIds: { TvDb: '55' } }] } })
    const { items } = await createJellyfinClient(opts(f)).items({ startIndex: 0, limit: 1 })
    expect(items[0]!.providerIds).toEqual({ tvdb: '55' })
  })

  it('requests Series and Season alongside playable items', async () => {
    let seen = ''
    const f = stub({ '/Items': { TotalRecordCount: 0, Items: [] } }, (u) => { seen = u })
    await createJellyfinClient(opts(f)).items({ startIndex: 0, limit: 500 })
    expect(decodeURIComponent(seen)).toContain('IncludeItemTypes=Movie,Episode,Series,Season')
    expect(seen).toContain('Recursive=true')
  })

  it('survives an item with no MediaSources', async () => {
    const f = stub({ '/Items': { TotalRecordCount: 1, Items: [{ Id: 's1', Type: 'Series', Name: 'Show' }] } })
    const { items } = await createJellyfinClient(opts(f)).items({ startIndex: 0, limit: 1 })
    expect(items[0]!.sizeBytes).toBeNull()
    expect(items[0]!.hasPrimaryImage).toBe(false)
  })
})

describe('mutations', () => {
  it('merges versions by comma-joined ids', async () => {
    let seen = ''
    const f = stub({ '/Videos/MergeVersions': {} }, (u) => { seen = u })
    await createJellyfinClient(opts(f)).mergeVersions(['a', 'b'])
    expect(decodeURIComponent(seen)).toContain('Ids=a,b')
  })

  it('refuses to merge fewer than two ids', async () => {
    const f = stub({})
    await expect(createJellyfinClient(opts(f)).mergeVersions(['only'])).rejects.toThrow(/at least two/i)
  })

  it('sends the api key header on non-auth calls', async () => {
    let headers: Record<string, string> = {}
    const f = stub({ '/Library/Refresh': {} }, (_u, init) => { headers = init!.headers as Record<string, string> })
    await createJellyfinClient(opts(f)).refreshLibrary()
    expect(headers['X-Emby-Token']).toBe('K')
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/connectors/jellyfin.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the connector**

```ts
// src/connectors/jellyfin.ts
import { HttpClient } from './http.js'

export interface JellyfinLibrary { id: string; name: string; collectionType: string | null; locations: string[] }

export interface JellyfinItem {
  id: string
  type: string
  name: string
  sortName: string | null
  year: number | null
  seriesId: string | null
  seriesName: string | null
  seasonNo: number | null
  episodeNo: number | null
  providerIds: Record<string, string>
  jfPath: string | null
  sizeBytes: number | null
  runtimeTicks: number | null
  container: string | null
  videoCodec: string | null
  audioCodec: string | null
  audioChannels: number | null
  width: number | null
  height: number | null
  bitrate: number | null
  hasPrimaryImage: boolean
  dateCreated: string | null
  mediaSourceId: string | null
}

export interface JellyfinClientOptions {
  url: string
  apiKey: string
  concurrency: number
  minDelayMs: number
  fetchImpl?: typeof fetch
}

const ITEM_FIELDS = 'Path,ProviderIds,MediaSources,MediaStreams,DateCreated,ParentId,ProductionYear,SortName'
const ITEM_TYPES = 'Movie,Episode,Series,Season'
const CLIENT_HEADER =
  'MediaBrowser Client="Jellymaid", Device="Jellymaid", DeviceId="jellymaid-server", Version="1.0.0"'

interface RawStream { Type?: string; Codec?: string; Width?: number; Height?: number; Channels?: number }
interface RawSource { Id?: string; Size?: number; Container?: string; Bitrate?: number; MediaStreams?: RawStream[] }
interface RawItem {
  Id: string; Type?: string; Name?: string; SortName?: string; ProductionYear?: number
  SeriesId?: string; SeriesName?: string; ParentIndexNumber?: number; IndexNumber?: number
  ProviderIds?: Record<string, string>; Path?: string; RunTimeTicks?: number
  ImageTags?: Record<string, string>; DateCreated?: string; MediaSources?: RawSource[]
}

function normalize(raw: RawItem): JellyfinItem {
  const source = raw.MediaSources?.[0]
  const streams = source?.MediaStreams ?? []
  const video = streams.find((s) => s.Type === 'Video')
  const audio = streams.find((s) => s.Type === 'Audio')
  const providerIds: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw.ProviderIds ?? {})) providerIds[k.toLowerCase()] = v
  return {
    id: raw.Id,
    type: raw.Type ?? 'Unknown',
    name: raw.Name ?? '',
    sortName: raw.SortName ?? null,
    year: raw.ProductionYear ?? null,
    seriesId: raw.SeriesId ?? null,
    seriesName: raw.SeriesName ?? null,
    // Jellyfin puts a Season's own number in IndexNumber and leaves ParentIndexNumber
    // unset, so the Episode mapping would record "Season 1" as episode 1 of no season.
    seasonNo: raw.Type === 'Season' ? raw.IndexNumber ?? null : raw.ParentIndexNumber ?? null,
    episodeNo: raw.Type === 'Season' ? null : raw.IndexNumber ?? null,
    providerIds,
    jfPath: raw.Path ?? null,
    sizeBytes: source?.Size ?? null,
    runtimeTicks: raw.RunTimeTicks ?? null,
    container: source?.Container ?? null,
    videoCodec: video?.Codec ?? null,
    audioCodec: audio?.Codec ?? null,
    audioChannels: audio?.Channels ?? null,
    width: video?.Width ?? null,
    height: video?.Height ?? null,
    bitrate: source?.Bitrate ?? null,
    hasPrimaryImage: Boolean(raw.ImageTags?.Primary),
    dateCreated: raw.DateCreated ?? null,
    mediaSourceId: source?.Id ?? null,
  }
}

export interface JellyfinClient {
  authenticateByName(username: string, password: string): Promise<{ userId: string; token: string; isAdministrator: boolean }>
  virtualFolders(): Promise<JellyfinLibrary[]>
  items(opts: { startIndex: number; limit: number }): Promise<{ items: JellyfinItem[]; totalRecordCount: number }>
  mergeVersions(ids: string[]): Promise<void>
  splitVersions(id: string): Promise<void>
  deleteItem(id: string): Promise<void>
  refreshLibrary(): Promise<void>
  ping(): Promise<void>
}

export function createJellyfinClient(opts: JellyfinClientOptions): JellyfinClient {
  const http = new HttpClient({
    service: 'jellyfin',
    baseUrl: opts.url,
    concurrency: opts.concurrency,
    minDelayMs: opts.minDelayMs,
    defaultHeaders: { 'X-Emby-Token': opts.apiKey, 'Content-Type': 'application/json' },
    fetchImpl: opts.fetchImpl,
  })

  return {
    async authenticateByName(username, password) {
      const auth = await http.request<{ User?: { Id: string }; AccessToken?: string }>(
        '/Users/AuthenticateByName',
        {
          method: 'POST',
          headers: { Authorization: CLIENT_HEADER, 'X-Emby-Token': '' },
          body: JSON.stringify({ Username: username, Pw: password }),
        },
      )
      const token = auth.AccessToken ?? ''
      const userId = auth.User?.Id ?? ''
      try {
        const me = await http.request<{ Policy?: { IsAdministrator?: boolean } }>('/Users/Me', {
          headers: { 'X-Emby-Token': token },
        })
        return { userId, token, isAdministrator: Boolean(me.Policy?.IsAdministrator) }
      } finally {
        // The token exists only to answer "is this an admin". Revoke it immediately.
        await http.request('/Sessions/Logout', { method: 'POST', headers: { 'X-Emby-Token': token } }, 'none')
          .catch(() => undefined)
      }
    },

    async virtualFolders() {
      const raw = await http.request<Array<{ ItemId?: string; Id?: string; Name?: string; CollectionType?: string; Locations?: string[] }>>(
        '/Library/VirtualFolders',
      )
      return raw.map((f) => ({
        id: f.ItemId ?? f.Id ?? f.Name ?? '',
        name: f.Name ?? '',
        collectionType: f.CollectionType ?? null,
        locations: f.Locations ?? [],
      }))
    },

    async items({ startIndex, limit }) {
      const qs = new URLSearchParams({
        Recursive: 'true',
        IncludeItemTypes: ITEM_TYPES,
        Fields: ITEM_FIELDS,
        StartIndex: String(startIndex),
        Limit: String(limit),
        EnableTotalRecordCount: 'true',
      })
      const raw = await http.request<{ Items?: RawItem[]; TotalRecordCount?: number }>(`/Items?${qs.toString()}`)
      return {
        items: (raw.Items ?? []).map(normalize),
        totalRecordCount: raw.TotalRecordCount ?? 0,
      }
    },

    async mergeVersions(ids) {
      if (ids.length < 2) throw new Error('mergeVersions requires at least two ids')
      await http.request(`/Videos/MergeVersions?Ids=${encodeURIComponent(ids.join(','))}`, { method: 'POST' }, 'none')
    },

    async splitVersions(id) {
      await http.request(`/Videos/${encodeURIComponent(id)}/AlternateSources`, { method: 'DELETE' }, 'none')
    },

    async deleteItem(id) {
      await http.request(`/Items/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'none')
    },

    async refreshLibrary() {
      await http.request('/Library/Refresh', { method: 'POST' }, 'none')
    },

    async ping() {
      await http.request('/System/Info', {}, 'json')
    },
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run tests/connectors/jellyfin.test.ts && npm run typecheck`
Expected: 9 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/connectors/jellyfin.ts tests/connectors/jellyfin.test.ts
git commit -m "feat: jellyfin connector with admin auth, paging and version operations"
```

---

### Task 7: Path mapping, auto-detect and verification

**Files:**
- Create: `src/fs/pathmap.ts`
- Test: `tests/fs/pathmap.test.ts`

**Interfaces:**
- Consumes: `PathMapping` (Task 2), `JellyfinClient` (Task 6).
- Produces:
  - `createPathMap(mappings: PathMapping[]): PathMap`
  - `PathMap.toContainer(jellyfinPath: string): string | null` · `.fromContainer(containerPath): string | null` · `.qbitToContainer(qbitPath): string | null` · `.rootFor(containerPath): PathMapping | null` · `.libraryRoots(): PathMapping[]` · `.downloadRoots(): PathMapping[]` · `.isWithinRoot(containerPath, root): boolean`
  - `verifyMappings(deps): Promise<VerifyReport>` where `VerifyReport = { sampled: number; resolved: number; failures: Array<{ jellyfinPath: string; reason: string }> }`
  - `autoDetectMappings(deps): Promise<PathMapping[]>`

Plan 4's sweep depends on `isWithinRoot` to guarantee it never deletes above a root.

- [ ] **Step 1: Write the failing test**

```ts
// tests/fs/pathmap.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPathMap, verifyMappings, autoDetectMappings } from '../../src/fs/pathmap.js'
import type { PathMapping } from '../../src/core/types.js'

const MAPPINGS: PathMapping[] = [
  { role: 'library', jellyfin: '/media/Movies', container: '/mnt/media/Movies', qbit: '/downloads/movies' },
  { role: 'library', jellyfin: '/media/TV', container: '/mnt/media/TV', qbit: null },
  { role: 'download', jellyfin: null, container: '/mnt/downloads', qbit: '/downloads' },
]

describe('createPathMap', () => {
  const map = createPathMap(MAPPINGS)

  it('translates a jellyfin path to a container path', () => {
    expect(map.toContainer('/media/Movies/Heat (1995)/Heat.mkv')).toBe('/mnt/media/Movies/Heat (1995)/Heat.mkv')
  })

  it('translates back', () => {
    expect(map.fromContainer('/mnt/media/TV/Show/S01E01.mkv')).toBe('/media/TV/Show/S01E01.mkv')
  })

  it('returns null for a path under no mapping rather than guessing', () => {
    expect(map.toContainer('/somewhere/else/x.mkv')).toBeNull()
  })

  it('prefers the longest matching prefix', () => {
    const m = createPathMap([
      { role: 'library', jellyfin: '/media', container: '/mnt/a', qbit: null },
      { role: 'library', jellyfin: '/media/Movies', container: '/mnt/b', qbit: null },
    ])
    expect(m.toContainer('/media/Movies/x.mkv')).toBe('/mnt/b/x.mkv')
  })

  it('does not match a partial path segment', () => {
    expect(map.toContainer('/media/MoviesArchive/x.mkv')).toBeNull()
  })

  it('translates qbittorrent content paths, longest prefix first', () => {
    expect(map.qbitToContainer('/downloads/movies/Heat/Heat.mkv')).toBe('/mnt/media/Movies/Heat/Heat.mkv')
    expect(map.qbitToContainer('/downloads/other/x.mkv')).toBe('/mnt/downloads/other/x.mkv')
  })

  it('separates library roots from download roots', () => {
    expect(map.libraryRoots()).toHaveLength(2)
    expect(map.downloadRoots()).toHaveLength(1)
  })

  it('confines paths to their root', () => {
    const root = MAPPINGS[0]!
    expect(map.isWithinRoot('/mnt/media/Movies/a/b.mkv', root)).toBe(true)
    expect(map.isWithinRoot('/mnt/media/Movies', root)).toBe(true)
    expect(map.isWithinRoot('/mnt/media', root)).toBe(false)
    expect(map.isWithinRoot('/mnt/media/MoviesOther/x', root)).toBe(false)
    expect(map.isWithinRoot('/mnt/media/Movies/../../etc', root)).toBe(false)
  })
})

describe('verifyMappings', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jm-pm-'))
    mkdirSync(join(dir, 'Movies'), { recursive: true })
    writeFileSync(join(dir, 'Movies', 'Heat.mkv'), 'x')
  })

  it('reports full success when every sampled item resolves', async () => {
    const report = await verifyMappings({
      mappings: [{ role: 'library', jellyfin: '/media/Movies', container: join(dir, 'Movies'), qbit: null }],
      sampleItems: async () => [{ id: 'i1', jfPath: '/media/Movies/Heat.mkv' }],
    })
    expect(report.sampled).toBe(1)
    expect(report.resolved).toBe(1)
    expect(report.failures).toEqual([])
  })

  it('reports the unmapped path as a failure with a reason', async () => {
    const report = await verifyMappings({
      mappings: [{ role: 'library', jellyfin: '/media/Movies', container: join(dir, 'Movies'), qbit: null }],
      sampleItems: async () => [{ id: 'i2', jfPath: '/other/Heat.mkv' }],
    })
    expect(report.resolved).toBe(0)
    expect(report.failures[0]!.reason).toMatch(/no mapping/i)
  })

  it('reports a mapped-but-missing file distinctly from an unmapped path', async () => {
    const report = await verifyMappings({
      mappings: [{ role: 'library', jellyfin: '/media/Movies', container: join(dir, 'Movies'), qbit: null }],
      sampleItems: async () => [{ id: 'i3', jfPath: '/media/Movies/Gone.mkv' }],
    })
    expect(report.failures[0]!.reason).toMatch(/not found on disk/i)
  })
})

describe('autoDetectMappings', () => {
  it('proposes a mapping by locating a sampled file under the mount roots', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jm-ad-'))
    mkdirSync(join(dir, 'Movies', 'Heat (1995)'), { recursive: true })
    writeFileSync(join(dir, 'Movies', 'Heat (1995)', 'Heat.mkv'), 'x')
    const proposed = await autoDetectMappings({
      mountRoots: [dir],
      sampleItems: async () => [{ id: 'i1', jfPath: '/media/Movies/Heat (1995)/Heat.mkv' }],
    })
    expect(proposed).toEqual([
      { role: 'library', jellyfin: '/media/Movies', container: join(dir, 'Movies'), qbit: null },
    ])
  })

  it('returns an empty proposal rather than a wrong one when nothing matches', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jm-ad2-'))
    const proposed = await autoDetectMappings({
      mountRoots: [dir],
      sampleItems: async () => [{ id: 'i1', jfPath: '/media/Movies/Nope.mkv' }],
    })
    expect(proposed).toEqual([])
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/fs/pathmap.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement path mapping**

```ts
// src/fs/pathmap.ts
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import type { PathMapping } from '../core/types.js'

const strip = (p: string) => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p)

/**
 * Resolves symlinks as far as the filesystem allows, then appends whatever tail does
 * not exist yet. Returns null when the truth cannot be established — a dangling
 * symlink, EACCES, ELOOP — so callers can fail closed rather than trust a lexical guess.
 */
function resolveReal(p: string): string | null {
  let current = resolve(p)
  const remainder: string[] = []
  for (;;) {
    try {
      const real = realpathSync(current)
      return remainder.length ? join(real, ...[...remainder].reverse()) : real
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null
      try {
        if (lstatSync(current).isSymbolicLink()) return null   // dangling symlink
      } catch { /* genuinely absent — keep walking up */ }
      const parent = dirname(current)
      if (parent === current) return null
      remainder.push(basename(current))
      current = parent
    }
  }
}

function underPrefix(path: string, prefix: string): boolean {
  const p = strip(path)
  const q = strip(prefix)
  return p === q || p.startsWith(q.endsWith('/') ? q : `${q}/`)
}

function rebase(path: string, from: string, to: string): string {
  const rest = strip(path).slice(strip(from).length)
  return `${strip(to)}${rest}`
}

export interface PathMap {
  toContainer(jellyfinPath: string): string | null
  fromContainer(containerPath: string): string | null
  qbitToContainer(qbitPath: string): string | null
  rootFor(containerPath: string): PathMapping | null
  libraryRoots(): PathMapping[]
  downloadRoots(): PathMapping[]
  isWithinRoot(containerPath: string, root: PathMapping): boolean
  all(): PathMapping[]
}

export function createPathMap(mappings: PathMapping[]): PathMap {
  const byJf = [...mappings].filter((m) => m.jellyfin).sort((a, b) => b.jellyfin!.length - a.jellyfin!.length)
  const byContainer = [...mappings].sort((a, b) => b.container.length - a.container.length)
  const byQbit = [...mappings].filter((m) => m.qbit).sort((a, b) => b.qbit!.length - a.qbit!.length)

  return {
    toContainer(jellyfinPath) {
      const m = byJf.find((x) => underPrefix(jellyfinPath, x.jellyfin!))
      return m ? rebase(jellyfinPath, m.jellyfin!, m.container) : null
    },
    fromContainer(containerPath) {
      const m = byContainer.find((x) => x.jellyfin && underPrefix(containerPath, x.container))
      return m ? rebase(containerPath, m.container, m.jellyfin!) : null
    },
    qbitToContainer(qbitPath) {
      const m = byQbit.find((x) => underPrefix(qbitPath, x.qbit!))
      return m ? rebase(qbitPath, m.qbit!, m.container) : null
    },
    rootFor(containerPath) {
      return byContainer.find((x) => underPrefix(containerPath, x.container)) ?? null
    },
    libraryRoots: () => mappings.filter((m) => m.role === 'library'),
    downloadRoots: () => mappings.filter((m) => m.role === 'download'),
    isWithinRoot(containerPath, root) {
      // resolve() alone is purely lexical, so a symlink planted inside the root escapes it.
      // resolveReal() walks down to the deepest EXISTING ancestor, realpaths that, and
      // re-appends the not-yet-existing remainder. It returns null — and this returns
      // false — for a dangling symlink, EACCES, or ELOOP. Fail closed: refusing a
      // legitimate delete is recoverable, deleting outside the library is not.
      //
      // Inherently time-of-check-to-time-of-use: a true result is not a lasting guarantee.
      const target = resolveReal(containerPath)
      const base = resolveReal(root.container)
      if (target === null || base === null) return false
      return target === base || target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
    },
    all: () => mappings,
  }
}

export interface SampledItem { id: string; jfPath: string }

export interface VerifyReport {
  sampled: number
  resolved: number
  failures: Array<{ jellyfinPath: string; reason: string }>
}

export async function verifyMappings(deps: {
  mappings: PathMapping[]
  sampleItems: () => Promise<SampledItem[]>
}): Promise<VerifyReport> {
  const map = createPathMap(deps.mappings)
  const items = await deps.sampleItems()
  const failures: VerifyReport['failures'] = []
  let resolved = 0
  for (const item of items) {
    const container = map.toContainer(item.jfPath)
    if (!container) {
      failures.push({ jellyfinPath: item.jfPath, reason: 'no mapping covers this path' })
      continue
    }
    if (!existsSync(container)) {
      failures.push({ jellyfinPath: item.jfPath, reason: `mapped to ${container} but not found on disk` })
      continue
    }
    resolved += 1
  }
  return { sampled: items.length, resolved, failures }
}

/**
 * Proposes mappings by taking sampled Jellyfin paths and searching the mounts for a
 * matching suffix. Proposes nothing when nothing matches — a wrong mapping is far more
 * dangerous than an absent one.
 *
 * Two rules keep it honest without crippling it:
 *   - a match must corroborate at least MIN_CORROBORATED_SEGMENTS trailing path
 *     segments, so a bare filename collision cannot mint a mapping;
 *   - per sampled item only the DEEPEST matching Jellyfin root is kept, since several
 *     nested roots can all match the same file and the most specific one over-claims least.
 * There is deliberately NO floor on root depth: a single-bind-mount layout like
 * `/movies/Heat (1995)/Heat.mkv` is the common Docker/Unraid shape and must resolve.
 * A truly flat library (`/movies/Heat.mkv`) proposes nothing — one filename is not
 * enough corroboration to bet a delete on.
 */
const MIN_CORROBORATED_SEGMENTS = 2
export async function autoDetectMappings(deps: {
  mountRoots: string[]
  sampleItems: () => Promise<SampledItem[]>
  maxDepth?: number
}): Promise<PathMapping[]> {
  const maxDepth = deps.maxDepth ?? 4
  const items = await deps.sampleItems()
  const proposals = new Map<string, PathMapping>()

  for (const item of items) {
    const parts = item.jfPath.split('/').filter(Boolean)
    let best: PathMapping | null = null
    let bestDepth = -1
    for (const mount of deps.mountRoots) {
      for (const candidateDir of walkDirs(mount, maxDepth)) {
        for (let start = 1; start <= parts.length - MIN_CORROBORATED_SEGMENTS; start += 1) {
          const suffix = parts.slice(start)
          if (!existsSync(join(candidateDir, ...suffix))) continue
          const jellyfinRoot = `/${parts.slice(0, start).join('/')}`
          if (start > bestDepth) {
            bestDepth = start
            best = { role: 'library', jellyfin: jellyfinRoot, container: candidateDir, qbit: null }
          }
        }
      }
    }
    if (best?.jellyfin) proposals.set(best.jellyfin, best)
  }
  return [...proposals.values()]
}

function walkDirs(root: string, maxDepth: number, depth = 0): string[] {
  if (depth > maxDepth || !existsSync(root)) return []
  const out = [root]
  let entries: string[] = []
  try { entries = readdirSync(root) } catch { return out }
  for (const name of entries) {
    if (name.startsWith('.')) continue
    const child = join(root, name)
    try { if (statSync(child).isDirectory()) out.push(...walkDirs(child, maxDepth, depth + 1)) } catch { /* unreadable */ }
  }
  return out
}

export { posix as _posix }
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run tests/fs/pathmap.test.ts && npm run typecheck`
Expected: 14 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/fs/pathmap.ts tests/fs/pathmap.test.ts
git commit -m "feat: path mapping with longest-prefix translation, verification and auto-detect"
```

---

### Task 8: Auth — lockout, sessions, routes

**Files:**
- Create: `src/auth/lockout.ts`, `src/auth/session.ts`, `src/api/auth.ts`
- Test: `tests/auth/lockout.test.ts`, `tests/api/auth.test.ts`

**Interfaces:**
- Consumes: `JellyfinClient` (Task 6), `EnvConfig` (Task 3).
- Produces:
  - `createLockout(opts: { maxFailures: number; windowMs: number; lockMs: number; now?: () => number }): Lockout` with `.check(key): { locked: boolean; retryAfterMs: number }`, `.recordFailure(key): void`, `.reset(key): void`
  - `registerAuthRoutes(app, deps)` mounting `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`
  - `requireSession(app)` — a Fastify `preHandler` every mutating route uses in later plans.

- [ ] **Step 1: Write the failing lockout test**

```ts
// tests/auth/lockout.test.ts
import { describe, it, expect } from 'vitest'
import { createLockout } from '../../src/auth/lockout.js'

describe('lockout', () => {
  it('locks after the configured failures inside the window', () => {
    let t = 0
    const l = createLockout({ maxFailures: 3, windowMs: 5 * 60_000, lockMs: 60 * 60_000, now: () => t })
    l.recordFailure('bob'); l.recordFailure('bob')
    expect(l.check('bob').locked).toBe(false)
    l.recordFailure('bob')
    expect(l.check('bob').locked).toBe(true)
  })

  it('forgets failures that fall outside the window', () => {
    let t = 0
    const l = createLockout({ maxFailures: 3, windowMs: 5 * 60_000, lockMs: 60 * 60_000, now: () => t })
    l.recordFailure('bob'); l.recordFailure('bob')
    t = 6 * 60_000
    l.recordFailure('bob')
    expect(l.check('bob').locked).toBe(false)
  })

  it('expires the lock after lockMs and reports the remaining time', () => {
    let t = 0
    const l = createLockout({ maxFailures: 1, windowMs: 1000, lockMs: 10_000, now: () => t })
    l.recordFailure('bob')
    expect(l.check('bob').retryAfterMs).toBe(10_000)
    t = 10_001
    expect(l.check('bob').locked).toBe(false)
  })

  it('tracks keys independently so one user cannot lock out another', () => {
    let t = 0
    const l = createLockout({ maxFailures: 1, windowMs: 1000, lockMs: 1000, now: () => t })
    l.recordFailure('bob')
    expect(l.check('alice').locked).toBe(false)
  })

  it('reset clears both failures and an active lock', () => {
    let t = 0
    const l = createLockout({ maxFailures: 1, windowMs: 1000, lockMs: 1000, now: () => t })
    l.recordFailure('bob')
    l.reset('bob')
    expect(l.check('bob').locked).toBe(false)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/auth/lockout.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement lockout and session**

```ts
// src/auth/lockout.ts
export interface Lockout {
  check(key: string): { locked: boolean; retryAfterMs: number }
  recordFailure(key: string): void
  reset(key: string): void
  /**
   * Serialises attempts for one key and returns a release function.
   *
   * Without this the lockout is decorative: the handler checks, awaits a network
   * round-trip, and only then records the failure — so N concurrent requests all
   * pass the check before any of them records anything. Measured: 50 concurrent
   * logins produced 50 real password guesses and zero 429s.
   */
  beginAttempt(key: string): Promise<() => void>
}

export function createLockout(opts: {
  maxFailures: number; windowMs: number; lockMs: number; now?: () => number
}): Lockout {
  const now = opts.now ?? Date.now
  const failures = new Map<string, number[]>()
  const locks = new Map<string, number>()
  const queues = new Map<string, Promise<void>>()

  return {
    check(key) {
      const until = locks.get(key)
      if (until === undefined) return { locked: false, retryAfterMs: 0 }
      const remaining = until - now()
      if (remaining <= 0) { locks.delete(key); return { locked: false, retryAfterMs: 0 } }
      return { locked: true, retryAfterMs: remaining }
    },
    recordFailure(key) {
      const cutoff = now() - opts.windowMs
      const recent = (failures.get(key) ?? []).filter((t) => t > cutoff)
      recent.push(now())
      failures.set(key, recent)
      if (recent.length >= opts.maxFailures) {
        locks.set(key, now() + opts.lockMs)
        failures.set(key, [])
      }
    },
    reset(key) { failures.delete(key); locks.delete(key) },
    async beginAttempt(key) {
      // Wait for whoever is currently holding this key's turn.
      const prior = queues.get(key) ?? Promise.resolve()
      let release!: () => void
      const done = new Promise<void>((resolve) => { release = resolve })
      // The new queue tail resolves only once the prior holder AND we are both done,
      // so the next caller in line waits for us too.
      const tail = prior.then(() => done)
      queues.set(key, tail)
      await prior
      return () => {
        release()
        // Only the last-enqueued holder for this key clears the map entry, so it
        // doesn't grow without bound once nobody is waiting on this key anymore.
        if (queues.get(key) === tail) queues.delete(key)
      }
    },
  }
}
```

```ts
// src/auth/session.ts
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto'

export interface SessionPayload { username: string; userId: string; issuedAt: number }

export const SESSION_COOKIE = 'jellymaid_session'
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export function signSession(payload: SessionPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}.${sig}`
}

export function verifySession(token: string, secret: string, now = Date.now()): SessionPayload | null {
  const [body, sig] = token.split('.')
  if (!body || !sig) return null
  const expected = createHmac('sha256', secret).update(body).digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload
    if (now - payload.issuedAt > MAX_AGE_MS) return null
    return payload
  } catch {
    return null
  }
}

export const newSessionId = () => randomUUID()
export const SESSION_MAX_AGE_SECONDS = MAX_AGE_MS / 1000
```

- [ ] **Step 4: Write the failing route test**

```ts
// tests/api/auth.test.ts
import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import { registerAuthRoutes } from '../../src/api/auth.js'
import { createLockout } from '../../src/auth/lockout.js'
import { SESSION_COOKIE } from '../../src/auth/session.js'

function build(authenticate: (u: string, p: string) => Promise<{ userId: string; token: string; isAdministrator: boolean }>) {
  const app = Fastify()
  app.register(cookie)
  registerAuthRoutes(app, {
    jellyfin: { authenticateByName: authenticate } as never,
    sessionSecret: 'a-very-long-test-secret',
    lockout: createLockout({ maxFailures: 3, windowMs: 300_000, lockMs: 3_600_000 }),
    secureCookie: false,
  })
  return app
}

const admin = async () => ({ userId: 'u1', token: 'T', isAdministrator: true })

describe('POST /api/auth/login', () => {
  it('sets an httpOnly session cookie for an admin', async () => {
    const app = build(admin)
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'bob', password: 'pw' } })
    expect(res.statusCode).toBe(200)
    const setCookie = String(res.headers['set-cookie'])
    expect(setCookie).toContain(SESSION_COOKIE)
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Lax')
  })

  it('rejects a valid non-admin with 403 and no cookie', async () => {
    const app = build(async () => ({ userId: 'u2', token: 'T', isAdministrator: false }))
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'eve', password: 'pw' } })
    expect(res.statusCode).toBe(403)
    expect(res.headers['set-cookie']).toBeUndefined()
    expect(res.json().error).toMatch(/administrator/i)
  })

  it('locks out after three failures in the window', async () => {
    const app = build(async () => { const e = new Error('bad'); (e as never as { kind: string }).kind = 'auth'; throw e })
    for (let i = 0; i < 3; i += 1) {
      await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'bob', password: 'x' } })
    }
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'bob', password: 'x' } })
    expect(res.statusCode).toBe(429)
  })

  it('does NOT consume an attempt when Jellyfin is unreachable', async () => {
    const err = Object.assign(new Error('down'), { kind: 'unreachable', name: 'ConnectorError' })
    const app = build(async () => { throw err })
    for (let i = 0; i < 5; i += 1) {
      const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'bob', password: 'x' } })
      expect(r.statusCode).toBe(503)
    }
  })

  it('never echoes the password back in any response', async () => {
    const app = build(async () => { throw Object.assign(new Error('nope'), { kind: 'auth', name: 'ConnectorError' }) })
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'bob', password: 'hunter2' } })
    expect(res.body).not.toContain('hunter2')
  })
})

describe('GET /api/auth/me', () => {
  it('returns 401 without a session', async () => {
    const app = build(admin)
    expect((await app.inject({ method: 'GET', url: '/api/auth/me' })).statusCode).toBe(401)
  })

  it('returns the username with a valid session', async () => {
    const app = build(admin)
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'bob', password: 'pw' } })
    const cookieHeader = String(login.headers['set-cookie']).split(';')[0]!
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: cookieHeader } })
    expect(me.json()).toMatchObject({ username: 'bob' })
  })

  it('rejects a tampered session cookie', async () => {
    const app = build(admin)
    const res = await app.inject({
      method: 'GET', url: '/api/auth/me',
      headers: { cookie: `${SESSION_COOKIE}=eyJhIjoxfQ.forged` },
    })
    expect(res.statusCode).toBe(401)
  })
})
```

- [ ] **Step 5: Run it and confirm it fails**

Run: `npx vitest run tests/api/auth.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 6: Implement the auth routes**

```ts
// src/api/auth.ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { JellyfinClient } from '../connectors/jellyfin.js'
import type { Lockout } from '../auth/lockout.js'
import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, signSession, verifySession } from '../auth/session.js'

const loginSchema = z.object({ username: z.string().min(1), password: z.string() })

export interface AuthDeps {
  jellyfin: Pick<JellyfinClient, 'authenticateByName'>
  sessionSecret: string
  lockout: Lockout
  secureCookie: boolean
}

function clientKey(req: FastifyRequest, username: string): string {
  return `${username} ${req.ip}`
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps): void {
  app.post('/api/auth/login', async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'username and password are required' })
    const { username, password } = parsed.data
    const key = clientKey(req, username)

    // Serialise attempts for this key. Everything from the check to the record must
    // happen without another request for the same key interleaving, or a burst of
    // concurrent logins all pass the check before any of them records a failure.
    const release = await deps.lockout.beginAttempt(key)
    try {
      const lock = deps.lockout.check(key)
      if (lock.locked) {
        return reply.code(429).send({ error: 'too many failed attempts', retryAfterMs: lock.retryAfterMs })
      }

      let result: { userId: string; token: string; isAdministrator: boolean }
      try {
        result = await deps.jellyfin.authenticateByName(username, password)
      } catch (err) {
        // ONLY a genuine credential rejection counts against the operator. An
        // unreachable Jellyfin — or any error we cannot classify — must not consume
        // an attempt, or an outage locks the operator out of their own cleanup tool.
        if ((err as { kind?: string }).kind !== 'auth') {
          return reply.code(503).send({ error: 'Jellyfin is unreachable' })
        }
        deps.lockout.recordFailure(key)
        return reply.code(401).send({ error: 'invalid credentials' })
      }

      if (!result.isAdministrator) {
        deps.lockout.recordFailure(key)
        return reply.code(403).send({ error: 'a Jellyfin administrator account is required' })
      }

      deps.lockout.reset(key)
      return sendSession(reply, username, result.userId)
    } finally {
      release()
    }
  })

  function sendSession(reply: FastifyReply, username: string, userId: string) {
    const token = signSession({ username, userId, issuedAt: Date.now() }, deps.sessionSecret)
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true, sameSite: 'lax', secure: deps.secureCookie, path: '/', maxAge: SESSION_MAX_AGE_SECONDS,
    })
    return reply.send({ username, userId })
  }

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return reply.send({ ok: true })
  })

  app.get('/api/auth/me', async (req, reply) => {
    const session = readSession(req, deps.sessionSecret)
    if (!session) return reply.code(401).send({ error: 'not authenticated' })
    return reply.send({ username: session.username, userId: session.userId })
  })
}

export function readSession(req: FastifyRequest, secret: string) {
  const raw = req.cookies?.[SESSION_COOKIE]
  return raw ? verifySession(raw, secret) : null
}

/** preHandler used by every mutating route in later plans. */
export function requireSession(secret: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const session = readSession(req, secret)
    if (!session) return reply.code(401).send({ error: 'not authenticated' })
    ;(req as FastifyRequest & { session?: unknown }).session = session
    return undefined
  }
}
```

- [ ] **Step 7: Run tests and typecheck**

Run: `npx vitest run tests/auth tests/api/auth.test.ts && npm run typecheck`
Expected: 13 tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/auth src/api/auth.ts tests/auth tests/api/auth.test.ts
git commit -m "feat: jellyfin-admin login with signed sessions and lockout"
```

---

### Task 9: Server assembly, health, path-map routes and CI

**Files:**
- Create: `src/server.ts`, `src/index.ts`, `src/api/health.ts`, `src/api/pathmap.ts`, `.github/workflows/ci.yml`
- Test: `tests/api/health.test.ts`, `tests/api/pathmap.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `buildServer(deps: ServerDeps): FastifyInstance` — pure factory, no listening and no side effects on import, so every later plan's route tests can build the real app. `ServerDeps = { config: AppConfig; db: Db; jellyfin: JellyfinClient; logger: Logger }`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/api/health.test.ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildServer } from '../../src/server.js'
import { openDb } from '../../src/index/db.js'
import { createLogger } from '../../src/core/logger.js'
import { fileConfigSchema } from '../../src/config/schema.js'

function testDeps(pingImpl: () => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'jm-srv-'))
  return {
    config: {
      env: {
        dataDir: dir, port: 0, trustProxy: false, sessionSecret: 'x'.repeat(32),
        jellyfin: { url: 'http://jf', apiKey: 'k' },
        qbittorrent: { url: 'http://qb', user: 'u', pass: 'p' },
        radarr: null, sonarr: null,
      },
      file: fileConfigSchema.parse({}),
    },
    db: openDb(join(dir, 'db.sqlite')),
    jellyfin: { ping: pingImpl } as never,
    logger: createLogger({ level: 'error', sink: () => {} }),
  }
}

describe('GET /healthz', () => {
  it('reports ok with schema version and a reachable jellyfin', async () => {
    const app = buildServer(testDeps(async () => {}))
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('ok')
    expect(body.schemaVersion).toBeGreaterThan(0)
    expect(body.connectors.jellyfin).toBe('ok')
  })

  it('reports degraded, not failed, when jellyfin is unreachable', async () => {
    const app = buildServer(testDeps(async () => { throw Object.assign(new Error('x'), { kind: 'unreachable' }) }))
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('degraded')
    expect(res.json().connectors.jellyfin).toBe('unreachable')
  })

  it('needs no session — it is a container probe', async () => {
    const app = buildServer(testDeps(async () => {}))
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200)
  })
})
```

```ts
// tests/api/pathmap.test.ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildServer } from '../../src/server.js'
import { openDb } from '../../src/index/db.js'
import { createLogger } from '../../src/core/logger.js'
import { fileConfigSchema } from '../../src/config/schema.js'
import { signSession } from '../../src/auth/session.js'

const SECRET = 'y'.repeat(32)

function app() {
  const dir = mkdtempSync(join(tmpdir(), 'jm-pmapi-'))
  return buildServer({
    config: {
      env: {
        dataDir: dir, port: 0, trustProxy: false, sessionSecret: SECRET,
        jellyfin: { url: 'http://jf', apiKey: 'k' },
        qbittorrent: { url: 'http://qb', user: 'u', pass: 'p' },
        radarr: null, sonarr: null,
      },
      file: fileConfigSchema.parse({}),
    },
    db: openDb(join(dir, 'db.sqlite')),
    jellyfin: {
      ping: async () => {},
      items: async () => ({ items: [], totalRecordCount: 0 }),
    } as never,
    logger: createLogger({ level: 'error', sink: () => {} }),
  })
}

const authCookie = () => `jellymaid_session=${signSession({ username: 'bob', userId: 'u', issuedAt: Date.now() }, SECRET)}`

describe('/api/pathmap', () => {
  it('requires a session', async () => {
    expect((await app().inject({ method: 'GET', url: '/api/pathmap' })).statusCode).toBe(401)
  })

  it('returns the configured mappings for an authenticated admin', async () => {
    const res = await app().inject({ method: 'GET', url: '/api/pathmap', headers: { cookie: authCookie() } })
    expect(res.statusCode).toBe(200)
    expect(res.json().mappings).toEqual([])
  })

  it('rejects a library mapping with a null jellyfin path', async () => {
    const res = await app().inject({
      method: 'PUT', url: '/api/pathmap', headers: { cookie: authCookie() },
      payload: { mappings: [{ role: 'library', jellyfin: null, container: '/mnt/m', qbit: null }] },
    })
    expect(res.statusCode).toBe(400)
  })

  it('persists a valid mapping set', async () => {
    const a = app()
    const put = await a.inject({
      method: 'PUT', url: '/api/pathmap', headers: { cookie: authCookie() },
      payload: { mappings: [{ role: 'library', jellyfin: '/media/Movies', container: '/mnt/m', qbit: null }] },
    })
    expect(put.statusCode).toBe(200)
    const get = await a.inject({ method: 'GET', url: '/api/pathmap', headers: { cookie: authCookie() } })
    expect(get.json().mappings[0].jellyfin).toBe('/media/Movies')
  })

  it('verifies mappings and reports the failures', async () => {
    const a = app()
    await a.inject({
      method: 'PUT', url: '/api/pathmap', headers: { cookie: authCookie() },
      payload: { mappings: [{ role: 'library', jellyfin: '/media/Movies', container: '/nope', qbit: null }] },
    })
    const res = await a.inject({ method: 'POST', url: '/api/pathmap/verify', headers: { cookie: authCookie() } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveProperty('sampled')
    expect(res.json()).toHaveProperty('failures')
  })
})
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run tests/api/health.test.ts tests/api/pathmap.test.ts`
Expected: FAIL — `src/server.js` not found.

- [ ] **Step 3: Implement health and path-map routes**

```ts
// src/api/health.ts
import type { FastifyInstance } from 'fastify'
import type { Db } from '../index/db.js'
import { currentSchemaVersion } from '../index/db.js'
import type { JellyfinClient } from '../connectors/jellyfin.js'

export function registerHealthRoutes(
  app: FastifyInstance,
  deps: { db: Db; jellyfin: Pick<JellyfinClient, 'ping'> },
): void {
  app.get('/healthz', async (_req, reply) => {
    let jellyfin = 'ok'
    try {
      await deps.jellyfin.ping()
    } catch (err) {
      jellyfin = (err as { kind?: string }).kind ?? 'unreachable'
    }
    return reply.send({
      status: jellyfin === 'ok' ? 'ok' : 'degraded',
      schemaVersion: currentSchemaVersion(deps.db),
      connectors: { jellyfin },
    })
  })
}
```

```ts
// src/api/pathmap.ts
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pathMappingSchema } from '../config/schema.js'
import { readFileConfig, saveConfig } from '../config/load.js'
import { verifyMappings, autoDetectMappings } from '../fs/pathmap.js'
import { requireSession } from './auth.js'
import type { JellyfinClient } from '../connectors/jellyfin.js'

const putSchema = z.object({ mappings: z.array(pathMappingSchema) })
const detectSchema = z.object({ mountRoots: z.array(z.string().min(1)).min(1) })

export function registerPathMapRoutes(
  app: FastifyInstance,
  deps: { dataDir: string; sessionSecret: string; jellyfin: Pick<JellyfinClient, 'items'> },
): void {
  const guard = { preHandler: requireSession(deps.sessionSecret) }

  const sampleItems = async () => {
    const { items } = await deps.jellyfin.items({ startIndex: 0, limit: 20 })
    return items.filter((i) => i.jfPath).map((i) => ({ id: i.id, jfPath: i.jfPath! }))
  }

  app.get('/api/pathmap', guard, async (_req, reply) =>
    reply.send({ mappings: readFileConfig(deps.dataDir).pathMappings }))

  app.put('/api/pathmap', guard, async (req, reply) => {
    const parsed = putSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid mappings', issues: parsed.error.issues.map((i) => i.message) })
    }
    saveConfig(deps.dataDir, { pathMappings: parsed.data.mappings })
    return reply.send({ mappings: parsed.data.mappings })
  })

  app.post('/api/pathmap/verify', guard, async (_req, reply) => {
    const mappings = readFileConfig(deps.dataDir).pathMappings
    return reply.send(await verifyMappings({ mappings, sampleItems }))
  })

  app.post('/api/pathmap/detect', guard, async (req, reply) => {
    const parsed = detectSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'mountRoots is required' })
    return reply.send({ proposed: await autoDetectMappings({ mountRoots: parsed.data.mountRoots, sampleItems }) })
  })
}
```

- [ ] **Step 4: Implement the server factory and entry point**

```ts
// src/server.ts
import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import type { AppConfig } from './config/schema.js'
import type { Db } from './index/db.js'
import type { JellyfinClient } from './connectors/jellyfin.js'
import type { Logger } from './core/logger.js'
import { createLockout } from './auth/lockout.js'
import { registerAuthRoutes } from './api/auth.js'
import { registerHealthRoutes } from './api/health.js'
import { registerPathMapRoutes } from './api/pathmap.js'

export interface ServerDeps {
  config: AppConfig
  db: Db
  jellyfin: JellyfinClient
  logger: Logger
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({
    trustProxy: deps.config.env.trustProxy,
    bodyLimit: 2 * 1024 * 1024,
    logger: false,
  })
  app.register(cookie)

  registerHealthRoutes(app, { db: deps.db, jellyfin: deps.jellyfin })
  registerAuthRoutes(app, {
    jellyfin: deps.jellyfin,
    sessionSecret: deps.config.env.sessionSecret,
    lockout: createLockout({ maxFailures: 3, windowMs: 5 * 60_000, lockMs: 60 * 60_000 }),
    secureCookie: deps.config.env.trustProxy,
  })
  registerPathMapRoutes(app, {
    dataDir: deps.config.env.dataDir,
    sessionSecret: deps.config.env.sessionSecret,
    jellyfin: deps.jellyfin,
  })

  app.setErrorHandler((err, _req, reply) => {
    deps.logger.error('unhandled route error', { err: err.message })
    return reply.code(500).send({ error: 'internal error' })
  })

  return app
}
```

```ts
// src/index.ts
import { loadConfig } from './config/load.js'
import { openDb } from './index/db.js'
import { createLogger } from './core/logger.js'
import { createJellyfinClient } from './connectors/jellyfin.js'
import { buildServer } from './server.js'
import { join } from 'node:path'

const logger = createLogger({ level: (process.env.LOG_LEVEL as 'info') ?? 'info' })
const config = loadConfig(process.env)
const db = openDb(join(config.env.dataDir, 'jellymaid.db'))
const jellyfin = createJellyfinClient({
  url: config.env.jellyfin.url,
  apiKey: config.env.jellyfin.apiKey,
  concurrency: config.file.rateLimits.jellyfin.concurrency,
  minDelayMs: config.file.rateLimits.jellyfin.minDelayMs,
})

const app = buildServer({ config, db, jellyfin, logger })
app.listen({ port: config.env.port, host: '0.0.0.0' })
  .then(() => logger.info('jellymaid listening', { port: config.env.port }))
  .catch((err) => { logger.error('failed to start', { err: (err as Error).message }); process.exit(1) })
```

- [ ] **Step 5: Write the CI workflow**

```yaml
# .github/workflows/ci.yml
name: CI
on:
  push:
    branches: [master]
  pull_request:
  workflow_dispatch:

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
```

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run && npm run typecheck && npm run build`
Expected: all tests PASS, typecheck clean, `dist/` produced with `dist/src/index/migrations/001_init.sql` present.

- [ ] **Step 7: Commit**

```bash
git add src/server.ts src/index.ts src/api tests/api .github/workflows/ci.yml
git commit -m "feat: server assembly, health probe, path-map api and CI"
```

---

## Definition of done

- `npm test` passes with every task's tests green.
- `npm run typecheck` and `npm run build` are clean.
- Running the server against the real Jellyfin: an admin can log in, a non-admin is refused,
  `GET /healthz` reports the connector state, and `POST /api/pathmap/verify` resolves real
  library paths to real files.
- No Radarr/Sonarr delete or blocklist endpoint exists anywhere in the tree
  (`grep -rn "api/v3/movie" src/` returns nothing yet — Plan 2 adds only the read and
  unmonitor calls).
