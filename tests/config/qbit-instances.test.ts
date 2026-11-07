import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { loadConfig, parseQbitInstances, ConfigError } from '../../src/config/load.js'

function parse(env: NodeJS.ProcessEnv) {
  const problems: string[] = []
  const instances = parseQbitInstances(env, problems)
  return { instances, problems }
}

describe('parseQbitInstances — QBIT_INSTANCES', () => {
  it('parses every id=url pair, percent-decoding embedded credentials and stripping them from the URL', () => {
    const { instances, problems } = parse({
      QBIT_INSTANCES: 'box-a=http://198.51.100.10:8080, box-b=http://u%40x:p%3Aw@198.51.100.11:8080',
    })
    expect(problems).toEqual([])
    expect(instances).toEqual([
      { id: 'box-a', url: 'http://198.51.100.10:8080', user: null, pass: null },
      { id: 'box-b', url: 'http://198.51.100.11:8080', user: 'u@x', pass: 'p:w' },
    ])
  })

  it('never leaves a credential in the URL it keeps', () => {
    const { instances } = parse({ QBIT_INSTANCES: 'box-b=http://u%40x:p%3Aw@198.51.100.11:8080/qbt/' })
    expect(instances[0]!.url).toBe('http://198.51.100.11:8080/qbt/')
    expect(instances[0]!.url).not.toContain('@')
  })

  it('lets QBIT_<ID>_USER / QBIT_<ID>_PASS override, with the id uppercased and - turned into _', () => {
    const { instances, problems } = parse({
      QBIT_INSTANCES: 'box-a=http://old:stale@198.51.100.10:8080,box-b=http://198.51.100.11:8080',
      QBIT_BOX_A_USER: 'admin',
      QBIT_BOX_A_PASS: 'hunter2',
    })
    expect(problems).toEqual([])
    expect(instances[0]).toEqual({ id: 'box-a', url: 'http://198.51.100.10:8080', user: 'admin', pass: 'hunter2' })
    expect(instances[1]).toEqual({ id: 'box-b', url: 'http://198.51.100.11:8080', user: null, pass: null })
  })

  it('reports a duplicated id and returns no instances', () => {
    const { instances, problems } = parse({
      QBIT_INSTANCES: 'box-a=http://198.51.100.10:8080,box-a=http://198.51.100.11:8080',
    })
    expect(instances).toEqual([])
    expect(problems.join('\n')).toMatch(/box-a/)
  })

  it('reports a repeated id in the same pass even when its first entry\'s URL is malformed', () => {
    const { instances, problems } = parse({
      QBIT_INSTANCES: 'box-a=not a url, box-a=http://198.51.100.11:8080',
    })
    expect(instances).toEqual([])
    expect(problems).toEqual([
      'QBIT_INSTANCES entry 1: its URL is not a valid URL',
      'QBIT_INSTANCES lists the instance id "box-a" more than once',
    ])
  })

  it('reports an id that does not match the id pattern by the entry\'s position, without quoting it', () => {
    const { instances, problems } = parse({
      QBIT_INSTANCES: 'box-a=http://198.51.100.10:8080, Box_A=http://198.51.100.11:8080',
    })
    expect(instances).toEqual([])
    expect(problems).toEqual([expect.stringMatching(/^QBIT_INSTANCES entry 2 has an invalid id/)])
    // Text that failed the pattern need not be an id at all — see "problems never leak credentials".
    expect(problems[0]).not.toContain('Box_A')
  })

  it('reports an entry that is not id=url', () => {
    const { instances, problems } = parse({ QBIT_INSTANCES: 'http://198.51.100.10:8080' })
    expect(instances).toEqual([])
    expect(problems).toHaveLength(1)
  })

  it('reports a URL that does not parse by the entry\'s position', () => {
    const { instances, problems } = parse({ QBIT_INSTANCES: 'box-a=not a url' })
    expect(instances).toEqual([])
    expect(problems).toEqual(['QBIT_INSTANCES entry 1: its URL is not a valid URL'])
  })

  it('reports a username without a password, whether it came from the URL or the environment', () => {
    const fromEnv = parse({ QBIT_INSTANCES: 'box-a=http://198.51.100.10:8080', QBIT_BOX_A_USER: 'admin' })
    expect(fromEnv.instances).toEqual([])
    expect(fromEnv.problems.join('\n')).toMatch(/box-a/)

    const fromUrl = parse({ QBIT_INSTANCES: 'box-a=http://admin@198.51.100.10:8080' })
    expect(fromUrl.instances).toEqual([])
    expect(fromUrl.problems).toHaveLength(1)
  })
})

describe('parseQbitInstances — single-instance fallback', () => {
  it('reads QBIT_URL alone as one instance named default with no credentials', () => {
    const { instances, problems } = parse({ QBIT_URL: 'http://198.51.100.10:8080' })
    expect(problems).toEqual([])
    expect(instances).toEqual([{ id: 'default', url: 'http://198.51.100.10:8080', user: null, pass: null }])
  })

  it('takes QBIT_USER / QBIT_PASS for the default instance', () => {
    const { instances } = parse({ QBIT_URL: 'http://198.51.100.10:8080', QBIT_USER: 'u', QBIT_PASS: 'p' })
    expect(instances).toEqual([{ id: 'default', url: 'http://198.51.100.10:8080', user: 'u', pass: 'p' }])
  })

  it('reports QBIT_USER without QBIT_PASS', () => {
    const { instances, problems } = parse({ QBIT_URL: 'http://198.51.100.10:8080', QBIT_USER: 'u' })
    expect(instances).toEqual([])
    expect(problems).toHaveLength(1)
  })

  it('prefers QBIT_INSTANCES when both are set', () => {
    const { instances } = parse({
      QBIT_INSTANCES: 'box-a=http://198.51.100.10:8080', QBIT_URL: 'http://198.51.100.11:8080',
    })
    expect(instances.map((i) => i.id)).toEqual(['box-a'])
  })

  it('reports a problem naming both variables when neither is set', () => {
    const { instances, problems } = parse({})
    expect(instances).toEqual([])
    expect(problems.join('\n')).toMatch(/QBIT_INSTANCES/)
    expect(problems.join('\n')).toMatch(/QBIT_URL/)
  })
})

describe('loadConfig — qBittorrent instances', () => {
  const dataDir = () => mkdtempSync(join(tmpdir(), 'jm-qbi-'))

  it('no longer requires QBIT_USER / QBIT_PASS', () => {
    const cfg = loadConfig({
      DATA_DIR: dataDir(), JELLYFIN_URL: 'http://198.51.100.20:8096', JELLYFIN_API_KEY: 'k',
      QBIT_URL: 'http://198.51.100.10:8080',
    })
    expect(cfg.env.qbittorrents).toEqual([{ id: 'default', url: 'http://198.51.100.10:8080', user: null, pass: null }])
  })

  it('loads every configured instance', () => {
    const cfg = loadConfig({
      DATA_DIR: dataDir(), JELLYFIN_URL: 'http://198.51.100.20:8096', JELLYFIN_API_KEY: 'k',
      QBIT_INSTANCES: 'box-a=http://198.51.100.10:8080,box-b=http://198.51.100.11:8080',
    })
    expect(cfg.env.qbittorrents.map((i) => i.id)).toEqual(['box-a', 'box-b'])
  })

  it('reports an instance problem alongside every other environment problem, in one error', () => {
    let caught: unknown
    try {
      loadConfig({ DATA_DIR: dataDir(), QBIT_INSTANCES: 'Box_A=http://198.51.100.10:8080' })
    } catch (err) { caught = err }
    expect(caught).toBeInstanceOf(ConfigError)
    const message = (caught as ConfigError).message
    expect(message).toMatch(/JELLYFIN_URL/)
    expect(message).toMatch(/QBIT_INSTANCES entry 1 has an invalid id/)
  })
})

// Every problem is printed to stderr in the ConfigError that refuses the boot.
describe('parseQbitInstances — problems never leak credentials', () => {
  it('does not echo a URL, which may embed a password, into a problem', () => {
    const malformed = parse({ QBIT_INSTANCES: 'box-a=http://admin:s3cret@bad host:8080' })
    const noId = parse({ QBIT_INSTANCES: 'http://admin:s3cret@198.51.100.10:8080' })
    for (const problem of [...malformed.problems, ...noId.problems]) expect(problem).not.toContain('s3cret')
    expect(malformed.problems).toHaveLength(1)
    expect(noId.problems).toHaveLength(1)
  })

  it.each([
    ['base64 padding in the password', 'http://admin:c2VjcmV0=@198.51.100.10:8080', 'c2VjcmV0'],
    ['a query string', 'http://admin:s3cret@198.51.100.10:8080/?x=1', 's3cret'],
  ])('names an entry with no "id=" by its position when its URL holds an "=" of its own (%s)', (_, list, secret) => {
    // The first "=" is INSIDE the URL, so the text before it — what the parser takes for the id —
    // is the front of the URL, user:pass@ included.
    const { instances, problems } = parse({ QBIT_INSTANCES: list })
    expect(instances).toEqual([])
    expect(problems).toEqual([expect.stringMatching(/^QBIT_INSTANCES entry 1 has an invalid id/)])
    expect(problems[0]).not.toContain(secret)
    expect(problems[0]).not.toContain('admin')
    expect(problems[0]).not.toContain('198.51.100.10')
  })

  it.each([
    ['its URL then does not parse', 'box-a=http://admin:hunter,s3cret=pw@198.51.100.10:8080'],
    ['its URL then is not http', 'box-a=http://admin:hunter,s3cret=pw:x@198.51.100.10:8080'],
    ['it then repeats an id', 'box-a=http://admin:hunter,s3cret=pw,s3cret=pw@198.51.100.10:8080'],
  ])('quotes no piece of a password that an unencoded "," split into an entry of its own (%s)', (_, list) => {
    // The list splits at the "," inside the password, so the piece after it reads as an entry of
    // its own whose id, "s3cret", is password text that happens to match the id pattern.
    const { instances, problems } = parse({ QBIT_INSTANCES: list })
    expect(instances).toEqual([])
    expect(problems.length).toBeGreaterThan(0)
    for (const problem of problems) {
      expect(problem).not.toContain('s3cret')
      expect(problem).not.toContain('hunter')
    }
  })

  it('keeps the credential out of the ConfigError that refuses the boot', () => {
    let caught: unknown
    try {
      loadConfig({
        DATA_DIR: mkdtempSync(join(tmpdir(), 'jm-qbi-')),
        JELLYFIN_URL: 'http://198.51.100.20:8096', JELLYFIN_API_KEY: 'k',
        QBIT_INSTANCES: 'http://admin:c2VjcmV0=@198.51.100.10:8080',
      })
    } catch (err) { caught = err }
    expect(caught).toBeInstanceOf(ConfigError)
    // inspect() renders the stack (message included) and the `problems` property: what an uncaught
    // ConfigError puts on stderr when src/index.ts's loadConfig refuses to start.
    const printed = inspect(caught)
    expect(printed).toMatch(/QBIT_INSTANCES entry 1 has an invalid id/)
    expect(printed).not.toContain('c2VjcmV0')
  })
})
