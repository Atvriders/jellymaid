import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// vite.config.ts does not set `test.globals: true`, so Testing Library's own auto-cleanup (which
// only registers itself when it finds a global `afterEach`) never fires. Without this, a render()
// in one test stays in the jsdom document for every test after it in the same file — harmless for
// Task 1's fetch-only tests, but this task adds the client's first render() calls, so it must be
// wired up now for every screen test from here on.
afterEach(() => cleanup())

// App mirrors its queue into localStorage, and one jsdom document serves every test in a file —
// without this, a queue built in one test would greet the next test's freshly mounted App.
afterEach(() => {
  try { localStorage.clear() } catch { /* a test replaced storage with one that throws */ }
})
