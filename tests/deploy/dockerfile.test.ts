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
})
