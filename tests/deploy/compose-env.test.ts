import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../../src/config/load.js'

const compose = () => readFileSync(new URL('../../docker-compose.yml', import.meta.url), 'utf8')
const envExample = () => readFileSync(new URL('../../.env.example', import.meta.url), 'utf8')

/** Every `KEY=` line .env.example declares — each defaults to the empty string it ships with. */
function envExampleKeys(): string[] {
  return envExample()
    .split('\n')
    .map((l) => l.match(/^([A-Z_][A-Z0-9_]*)=/)?.[1])
    .filter((k): k is string => Boolean(k))
}

/**
 * A minimal stand-in for docker-compose's variable interpolation — just the two forms this repo's
 * compose file uses ("${VAR}" and "${VAR:-default}") — so this test exercises the SAME
 * substitution an operator running `docker compose up` would actually get, not a hand-simulated
 * approximation that could quietly drift from real compose semantics.
 */
function interpolate(raw: string, env: Record<string, string>): string {
  return raw.replace(
    /\$\{(\w+)(:-(.*?))?\}/g,
    (_all, name: string, hasDefault: string | undefined, def: string | undefined) => {
      const v = env[name]
      if (v !== undefined && v !== '') return v
      if (hasDefault !== undefined) return def ?? ''
      return v ?? ''
    },
  )
}

/**
 * Parses only the `environment:` mapping's `KEY: "value"` entries out of docker-compose.yml —
 * skips comments (including the commented-out SESSION_SECRET line) and every other top-level
 * compose key (`volumes:`, `ports:`, `user:`, ...).
 */
function composeEnvironment(env: Record<string, string>): Record<string, string> {
  const text = compose()
  const block = text.slice(text.indexOf('environment:'), text.indexOf('volumes:'))
  const result: Record<string, string> = {}
  for (const line of block.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*):\s*"(.*)"\s*$/)
    if (!m) continue
    const [, key, value] = m
    result[key as string] = interpolate(value as string, env)
  }
  return result
}

describe('the documented copy .env.example -> .env path (MAJOR 2)', () => {
  it('starts the container with Radarr and Sonarr genuinely optional when their lines are left blank, exactly as .env.example instructs', () => {
    // An operator who filled in every REQUIRED key from .env.example and left the two optional
    // *arr pairs untouched (blank) — no docker-compose.yml edits at all, which is the whole point
    // of "documented copy-and-go".
    const dotEnv: Record<string, string> = Object.fromEntries(envExampleKeys().map((k) => [k, '']))
    dotEnv.JELLYFIN_API_KEY = 'jf-key'
    dotEnv.QBIT_USER = 'admin'
    dotEnv.QBIT_PASS = 'pass'

    const containerEnv = composeEnvironment(dotEnv)
    const dir = mkdtempSync(join(tmpdir(), 'jm-compose-'))

    expect(() => loadConfig({ ...containerEnv, DATA_DIR: dir })).not.toThrow()
    const config = loadConfig({ ...containerEnv, DATA_DIR: dir })
    expect(config.env.radarr).toBeNull()
    expect(config.env.sonarr).toBeNull()
  })

  it('still refuses to start a genuinely half-configured *arr (URL set, key blank) rather than guessing', () => {
    const dotEnv: Record<string, string> = Object.fromEntries(envExampleKeys().map((k) => [k, '']))
    dotEnv.JELLYFIN_API_KEY = 'jf-key'
    dotEnv.QBIT_USER = 'admin'
    dotEnv.QBIT_PASS = 'pass'
    dotEnv.RADARR_URL = 'http://198.51.100.20:7878' // RFC 5737 TEST-NET-2 — set...
    // ...RADARR_API_KEY left blank on purpose: this must still be rejected, not silently allowed.

    const containerEnv = composeEnvironment(dotEnv)
    const dir = mkdtempSync(join(tmpdir(), 'jm-compose-'))
    expect(() => loadConfig({ ...containerEnv, DATA_DIR: dir })).toThrow(/RADARR_API_KEY is required/)
  })
})
