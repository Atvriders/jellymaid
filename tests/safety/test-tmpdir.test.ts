import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

/**
 * The suite makes hundreds of mkdtemp directories and removes almost none of them; left in the
 * system temp directory they once reached 18,000 entries and 5.8 GB. tests/global-setup.ts points
 * TMPDIR at one directory per run and removes it when the run ends. This pins that the test workers
 * actually see it — a worker spawned before the variable was set would write to /tmp again.
 */
describe('test temp files', () => {
  it('are made under the per-run directory, which the run removes when it ends', () => {
    expect(basename(tmpdir())).toMatch(/^jellymaid-test-run-/)
    const dir = mkdtempSync(join(tmpdir(), 'jm-probe-'))
    expect(dirname(dir)).toBe(tmpdir())
    expect(existsSync(dir)).toBe(true)
  })
})
