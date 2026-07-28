import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const readme = () => readFileSync(new URL('../../README.md', import.meta.url), 'utf8')

describe('README', () => {
  it('warns that Jellymaid deletes media', () => {
    expect(readme().toLowerCase()).toMatch(/deletes? (your )?media|permanently delete/)
  })

  it('states that Radarr and Sonarr are unmonitor-only', () => {
    expect(readme().toLowerCase()).toContain('unmonitor')
    expect(readme().toLowerCase()).toMatch(/never delet\w+ (from )?(radarr|sonarr)|does not delete/)
  })

  it('documents the required /data bind mount', () => {
    expect(readme()).toContain('/data')
  })

  it('documents the path map including download roots', () => {
    expect(readme()).toContain('pathMappings')
    expect(readme()).toContain('download')
  })

  it('documents the guard defaults', () => {
    expect(readme()).toContain('minRatio')
    expect(readme()).toContain('minSeedTimeDays')
  })

  it('lists every required environment variable', () => {
    for (const key of ['JELLYFIN_URL', 'JELLYFIN_API_KEY', 'QBIT_URL', 'QBIT_USER', 'QBIT_PASS']) {
      expect(readme()).toContain(key)
    }
  })
})
