import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const dockerfile = () => readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8')
const compose = () => readFileSync(new URL('../../docker-compose.yml', import.meta.url), 'utf8')

describe('Dockerfile', () => {
  it('builds in stages so the runtime carries no compiler', () => {
    const stages = dockerfile().match(/^FROM /gm) ?? []
    expect(stages.length).toBeGreaterThanOrEqual(3)
  })

  it('targets Node 22', () => {
    expect(dockerfile()).toMatch(/FROM node:22/)
  })

  it('installs only production dependencies in the runtime stage', () => {
    expect(dockerfile()).toMatch(/npm ci --omit=dev/)
  })

  it('copies the migration SQL into the image — the server cannot start without it', () => {
    expect(dockerfile()).toMatch(/migrations/)
  })

  it('copies the built client', () => {
    expect(dockerfile()).toMatch(/client\/dist/)
  })

  it('declares the data volume and a healthcheck', () => {
    expect(dockerfile()).toMatch(/VOLUME .*\/data/)
    expect(dockerfile()).toMatch(/HEALTHCHECK/)
  })

  it('does not run as root', () => {
    expect(dockerfile()).toMatch(/^USER (?!root)/m)
  })

  function fromLine(stage: string): string {
    const m = dockerfile().match(new RegExp(`^FROM .*AS ${stage}$`, 'm'))
    if (!m) throw new Error(`no FROM line for stage "${stage}"`)
    return m[0]
  }

  it('pins the client and server stages to $BUILDPLATFORM (MINOR 6) — both emit only arch-independent output (client/dist from vite, dist/ from tsc), so building them under QEMU emulation for every target arch wastes a redundant better-sqlite3 compile with nothing to show for it', () => {
    expect(fromLine('client')).toContain('--platform=$BUILDPLATFORM')
    expect(fromLine('server')).toContain('--platform=$BUILDPLATFORM')
  })

  it('does NOT pin the runtime stage — its own `npm ci` node_modules (including better-sqlite3\'s native addon) ships in the final image and must match the real target platform', () => {
    expect(fromLine('runtime')).not.toContain('$BUILDPLATFORM')
  })
})

describe('docker-compose.yml', () => {
  it('references the public GHCR image', () => {
    expect(compose()).toContain('ghcr.io/atvriders/jellymaid')
  })

  it('bind-mounts /data, which is required for the index and audit log', () => {
    expect(compose()).toMatch(/:\/data/)
  })

  it('documents every required environment variable', () => {
    for (const key of ['JELLYFIN_URL', 'JELLYFIN_API_KEY', 'QBIT_URL', 'QBIT_USER', 'QBIT_PASS']) {
      expect(compose()).toContain(key)
    }
  })

  it('mounts media read-write, since Jellymaid must remove empty folders and leftover links', () => {
    expect(compose()).toMatch(/\/mnt\/media/)
    expect(compose()).not.toMatch(/\/mnt\/media:ro/)
  })

  it('ships TRUST_PROXY "0" (CRITICAL 1) — the single service here is `ports: 8099:8099` with no proxy and no TLS in front of it; "1" would make the session cookie `secure` (permanent login loop over plain http://<host>:8099) and let a caller forge X-Forwarded-For to bypass the login lockout', () => {
    expect(compose()).toMatch(/TRUST_PROXY:\s*"0"/)
    expect(compose()).not.toMatch(/TRUST_PROXY:\s*"1"/)
  })
})
