import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, parseQbitInstances } from '../../src/config/load.js'

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
 * The `environment:` mapping of the jellymaid service, located by STRUCTURE (the line `    environment:`
 * through the next key at the same indent) rather than by searching for the words "environment:" and
 * "volumes:", which a comment is free to contain.
 */
function composeEnvironmentBlock(text: string): string[] {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => /^ {4}environment:\s*$/.test(l))
  if (start === -1) throw new Error('docker-compose.yml has no "    environment:" key')
  const rest = lines.slice(start + 1)
  const length = rest.findIndex((l) => /^ {4}[A-Za-z_]+:/.test(l))
  return length === -1 ? rest : rest.slice(0, length)
}

/**
 * Parses only the `environment:` mapping's `KEY: "value"` entries out of docker-compose.yml —
 * skips comments (including the commented-out SESSION_SECRET line and the optional *arr block) and
 * every other compose key (`volumes:`, `ports:`, `user:`, ...). With `uncommentOptional`, the
 * `# KEY: "value"` lines of the optional Radarr/Sonarr block are treated as the operator
 * uncommenting them; no other commented line is touched.
 */
function composeEnvironment(
  env: Record<string, string>,
  opts: { uncommentOptional?: boolean } = {},
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const raw of composeEnvironmentBlock(compose())) {
    const line = opts.uncommentOptional ? raw.replace(/^(\s*)#\s+((?:RADARR|SONARR)_)/, '$1$2') : raw
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*):\s*"(.*)"\s*$/)
    if (!m) continue
    const [, key, value] = m
    result[key as string] = interpolate(value as string, env)
  }
  return result
}

/** A `.env` the way an operator leaves it after `cp .env.example .env` and filling in only the API key. */
function minimalDotEnv(): Record<string, string> {
  const dotEnv: Record<string, string> = Object.fromEntries(envExampleKeys().map((k) => [k, '']))
  dotEnv.JELLYFIN_API_KEY = 'jf-key'
  return dotEnv
}

describe('the documented copy .env.example -> .env path (MAJOR 2)', () => {
  it('starts the container with nothing but the Jellyfin API key filled in: two qBittorrent instances that need no login, no Radarr, no Sonarr', () => {
    // An operator who filled in the one REQUIRED secret from .env.example and left everything else
    // blank — no docker-compose.yml edits at all, which is the whole point of "documented
    // copy-and-go". Both example instances are assumed to let this host in without a login.
    const containerEnv = composeEnvironment(minimalDotEnv())
    const dir = mkdtempSync(join(tmpdir(), 'jm-compose-'))

    expect(() => loadConfig({ ...containerEnv, DATA_DIR: dir })).not.toThrow()
    const config = loadConfig({ ...containerEnv, DATA_DIR: dir })
    expect(config.env.radarr).toBeNull()
    expect(config.env.sonarr).toBeNull()
    expect(config.env.qbittorrents.map((q) => [q.id, q.user, q.pass])).toEqual([
      ['box-a', null, null],
      ['box-b', null, null],
    ])
  })

  it('ships a two-instance QBIT_INSTANCES example (box-a, box-b) on RFC 5737 documentation addresses, and no single-instance QBIT_URL', () => {
    const containerEnv = composeEnvironment(minimalDotEnv())
    expect(containerEnv).not.toHaveProperty('QBIT_URL')
    const problems: string[] = []
    const instances = parseQbitInstances({ QBIT_INSTANCES: containerEnv.QBIT_INSTANCES }, problems)
    expect(problems).toEqual([])
    expect(instances.map((i) => i.id)).toEqual(['box-a', 'box-b'])
    for (const i of instances) expect(new URL(i.url).hostname).toMatch(/^198\.51\.100\.\d{1,3}$/)
  })

  it('hands each instance its own credentials, from the per-instance variables .env.example declares', () => {
    const dotEnv = minimalDotEnv()
    dotEnv.QBIT_BOX_B_USER = 'qbuser'
    dotEnv.QBIT_BOX_B_PASS = 'pa,ss' // a comma is fine here: these variables are taken verbatim
    const containerEnv = composeEnvironment(dotEnv)
    const dir = mkdtempSync(join(tmpdir(), 'jm-compose-'))

    const config = loadConfig({ ...containerEnv, DATA_DIR: dir })
    expect(config.env.qbittorrents.map((q) => [q.id, q.user, q.pass])).toEqual([
      ['box-a', null, null],
      ['box-b', 'qbuser', 'pa,ss'],
    ])
  })

  it('refuses to start on half a credential (user without password) instead of making a login that can only fail', () => {
    // Five failed logins ban the caller's address for an hour on qBittorrent's side.
    const dotEnv = minimalDotEnv()
    dotEnv.QBIT_BOX_A_USER = 'admin'
    const containerEnv = composeEnvironment(dotEnv)
    const dir = mkdtempSync(join(tmpdir(), 'jm-compose-'))
    expect(() => loadConfig({ ...containerEnv, DATA_DIR: dir })).toThrow(/box-a.*password/)
  })

  it('declares in .env.example a USER and PASS variable for every instance of the compose example, and compose forwards them', () => {
    const ids = parseQbitInstances({ QBIT_INSTANCES: composeEnvironment(minimalDotEnv()).QBIT_INSTANCES }, []).map((i) => i.id)
    expect(ids.length).toBeGreaterThan(1)
    const containerEnv = composeEnvironment(minimalDotEnv())
    for (const id of ids) {
      const prefix = `QBIT_${id.toUpperCase().replaceAll('-', '_')}`
      for (const suffix of ['USER', 'PASS']) {
        expect(envExampleKeys(), `${prefix}_${suffix} should be declared in .env.example`).toContain(`${prefix}_${suffix}`)
        expect(Object.keys(containerEnv), `${prefix}_${suffix} should be forwarded by docker-compose.yml`).toContain(`${prefix}_${suffix}`)
      }
    }
  })

  it('never declares a variable in .env.example that docker-compose.yml does not reference (an operator would fill in a dead setting)', () => {
    const text = compose()
    for (const key of envExampleKeys()) {
      expect(text, `${key} is declared in .env.example but docker-compose.yml never references it`).toMatch(new RegExp(`\\$\\{${key}[:}]`))
    }
  })

  it('offers Radarr and Sonarr only as a commented block: nothing is forwarded until the operator uncomments it', () => {
    expect(Object.keys(composeEnvironment(minimalDotEnv())).filter((k) => /RADARR|SONARR/.test(k))).toEqual([])
    expect(Object.keys(composeEnvironment(minimalDotEnv(), { uncommentOptional: true })).filter((k) => /RADARR|SONARR/.test(k)).sort())
      .toEqual(['RADARR_API_KEY', 'RADARR_URL', 'SONARR_API_KEY', 'SONARR_URL'])
  })

  it('once uncommented, leaves Radarr and Sonarr genuinely optional when their .env lines are left blank', () => {
    const containerEnv = composeEnvironment(minimalDotEnv(), { uncommentOptional: true })
    const dir = mkdtempSync(join(tmpdir(), 'jm-compose-'))
    const config = loadConfig({ ...containerEnv, DATA_DIR: dir })
    expect(config.env.radarr).toBeNull()
    expect(config.env.sonarr).toBeNull()
  })

  it('once uncommented, still refuses to start a genuinely half-configured *arr (URL set, key blank) rather than guessing', () => {
    const dotEnv = minimalDotEnv()
    dotEnv.RADARR_URL = 'http://198.51.100.20:7878' // RFC 5737 TEST-NET-2 — set...
    // ...RADARR_API_KEY left blank on purpose: this must still be rejected, not silently allowed.

    const containerEnv = composeEnvironment(dotEnv, { uncommentOptional: true })
    const dir = mkdtempSync(join(tmpdir(), 'jm-compose-'))
    expect(() => loadConfig({ ...containerEnv, DATA_DIR: dir })).toThrow(/RADARR_API_KEY is required/)
  })
})
