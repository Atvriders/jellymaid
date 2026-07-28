import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const dockerignore = () => readFileSync(new URL('../../.dockerignore', import.meta.url), 'utf8')
const lines = () => dockerignore().split('\n').map((l) => l.trim()).filter(Boolean)

describe('.dockerignore (MINOR 4)', () => {
  it('excludes tests at every depth, not just the repo root', () => {
    // Docker ignore patterns are anchored to the ignore-file's directory unless the pattern starts
    // with "**/": a bare "tests" line matches ./tests but NOT client/tests, letting the 12 files
    // under client/tests leak into the client build stage's context. Build-context bloat only —
    // client/dist is the only thing copied out of that stage — but there is no reason to ship it.
    expect(lines()).toContain('**/tests')
    expect(lines()).not.toContain('tests')
  })
})
