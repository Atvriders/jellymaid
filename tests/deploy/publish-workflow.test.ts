import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../../src/config/load.js'

const publish = () => readFileSync(new URL('../../.github/workflows/publish.yml', import.meta.url), 'utf8')

/**
 * The publish job's steps as raw text, split on the `      - ` that opens each one. Not a YAML
 * parse (the repo carries no YAML dependency; the workflow's syntax is checked separately), but
 * enough to ask "which step is this, and what order are they in" without being fooled by a word
 * that happens to appear in a comment.
 */
function publishSteps(): string[] {
  const text = publish()
  const start = text.indexOf('  publish:')
  if (start === -1) throw new Error('publish.yml has no `publish` job')
  return text.slice(start).split(/\n(?=      - )/).slice(1)
}

const stepIndex = (pred: (step: string) => boolean): number => publishSteps().findIndex(pred)
const isBuild = (s: string) => s.includes('docker/build-push-action')
const loadStep = () => stepIndex((s) => isBuild(s) && /^\s+load:\s*true\s*$/m.test(s))
const smokeStep = () => stepIndex((s) => /docker run -d/.test(s))
const pushStep = () => stepIndex((s) => isBuild(s) && /^\s+push:\s*true\s*$/m.test(s))

/** The step at `idx`, or a failure that says which step was expected instead of a TypeError on `undefined`. */
function stepAt(idx: number, expected: string): string {
  const step = idx < 0 ? undefined : publishSteps()[idx]
  if (step === undefined) throw new Error(`publish.yml has no ${expected}`)
  return step
}
const loadText = () => stepAt(loadStep(), 'docker/build-push-action step with `load: true`')
const smokeText = () => stepAt(smokeStep(), 'step that runs `docker run -d`')

describe('publish workflow: smoke-start the image before pushing it', () => {
  it('builds the image for the runner\'s own architecture and loads it into the local Docker (a multi-platform image cannot be loaded)', () => {
    const step = loadText()
    expect(step, 'a loaded image is a single-platform image: do not name platforms here').not.toMatch(/^\s+platforms:/m)
    expect(step, 'the smoke build must not push').not.toMatch(/^\s+push:\s*true\s*$/m)
  })

  it('saves the smoke build\'s layers to the shared cache, so the multi-architecture build after it really does reuse them', () => {
    // Without cache-to, the smoke build reads the gha cache but never writes it: its layers live
    // only in this job's builder, and a run where the push step fails saves nothing for the next one.
    const step = loadText()
    expect(step).toMatch(/^\s+cache-from:\s*type=gha\s*$/m)
    expect(step).toMatch(/^\s+cache-to:\s*type=gha,mode=max\s*$/m)
  })

  it('runs the loaded image with dummy Jellyfin and qBittorrent addresses that nothing answers', () => {
    const step = smokeText()
    expect(step).toContain('-e JELLYFIN_URL=http://192.0.2.1:8096')
    expect(step).toContain('-e JELLYFIN_API_KEY=x')
    expect(step).toContain('-e QBIT_INSTANCES=box-a=http://192.0.2.1:8080')
    expect(step).toMatch(/-p 8099:8099\b/)
    // The image that was just loaded, not a pulled or previously published one.
    const loaded = loadText().match(/^\s+tags:\s*(\S+)\s*$/m)?.[1]
    expect(loaded, 'the load step should tag the image it loads').toBeTruthy()
    expect(step).toContain(loaded as string)
  })

  it('uses only RFC 5737 documentation addresses for the dummy services (nothing real is ever contacted)', () => {
    const step = smokeText()
    const hosts = [...step.matchAll(/http:\/\/([0-9.]+):/g)].map((m) => m[1])
    expect(hosts.length).toBeGreaterThan(0)
    for (const host of hosts) expect(host, 'must be in 192.0.2.0/24').toMatch(/^192\.0\.2\.\d+$/)
  })

  it('passes the very environment the plan calls for through the real loadConfig (a new required variable would fail here, not in CI)', () => {
    const step = smokeText()
    const env: Record<string, string> = {}
    for (const m of step.matchAll(/-e ([A-Z_]+)=(\S+)/g)) env[m[1] as string] = m[2] as string
    const dir = mkdtempSync(join(tmpdir(), 'jm-smoke-env-'))
    const config = loadConfig({ ...env, DATA_DIR: dir })
    expect(config.env.qbittorrents.map((q) => q.id)).toEqual(['box-a'])
    expect(config.env.radarr).toBeNull()
    expect(config.env.sonarr).toBeNull()
  })

  it('polls /healthz with curl -fsS for at most 60 seconds, and fails the job if it never answers', () => {
    const step = smokeText()
    expect(step).toMatch(/curl -fsS\b[^\n]*localhost:8099\/healthz/)
    expect(step).toMatch(/\+\s*60\b/)
    expect(step, 'a poll that gives up must fail the step').toMatch(/exit 1/)
    expect(step, 'a container that already exited should fail at once, not after the full minute').toMatch(/State\.Running/)
  })

  it('pushes only after the smoke test: the multi-architecture push is the last build, after the image was loaded AND started', () => {
    const load = loadStep()
    const smoke = smokeStep()
    const push = pushStep()
    const pushText = stepAt(push, 'multi-architecture build with `push: true`')
    expect(load, 'the image must be loaded...').toBeGreaterThan(-1)
    expect(load).toBeLessThan(smoke)
    expect(smoke).toBeLessThan(push)
    expect(pushText).toMatch(/platforms:\s*linux\/amd64,linux\/arm64/)
    // Nothing earlier may push: the registry only ever sees an image that already started once.
    publishSteps().slice(0, push).filter(isBuild).forEach((s) => expect(s).not.toMatch(/^\s+push:\s*true\s*$/m))
  })

  it('removes the smoke container and prints its log whether or not the test passed', () => {
    const idx = stepIndex((s) => /docker rm -f/.test(s))
    const step = stepAt(idx, 'cleanup step that runs `docker rm -f`')
    expect(idx, 'cleanup must come after the smoke step').toBeGreaterThan(smokeStep())
    expect(step).toMatch(/^\s+if:\s*always\(\)\s*$/m)
    expect(step).toContain('docker logs')
  })
})
