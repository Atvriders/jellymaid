// defineConfig comes from vitest/config, not vite — otherwise the `test` block below
// is not a known key and typecheck fails.
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { proxy: { '/api': 'http://localhost:8099', '/healthz': 'http://localhost:8099' } },
  test: { environment: 'jsdom', setupFiles: ['./tests/setup.ts'], include: ['tests/**/*.test.tsx', 'tests/**/*.test.ts'] },
})
