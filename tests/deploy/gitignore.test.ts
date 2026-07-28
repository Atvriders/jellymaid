import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const gitignore = () => readFileSync(new URL('../../.gitignore', import.meta.url), 'utf8')
const lines = () => gitignore().split('\n').map((l) => l.trim()).filter(Boolean)

describe('.gitignore (MINOR 5 — this repo is about to go public)', () => {
  it('ignores common local-tooling artifacts that are not currently tracked but could be committed by accident', () => {
    for (const entry of ['coverage/', '.vite/', '.DS_Store']) {
      expect(lines()).toContain(entry)
    }
  })

  it('owns its own exclusion of .superpowers/ rather than relying on a nested .gitignore it does not control', () => {
    expect(lines()).toContain('.superpowers/')
  })
})
