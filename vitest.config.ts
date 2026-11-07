import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 20_000,
    // Points TMPDIR at one directory per run and removes it afterwards; see the file for why.
    globalSetup: ['tests/global-setup.ts'],
  },
})
