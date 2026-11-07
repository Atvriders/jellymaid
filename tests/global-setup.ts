import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * One temp directory per test run, removed when the run ends. The suite makes hundreds of mkdtemp
 * directories (a database, a library tree, a config.json per test) and cleans up almost none of
 * them; left in the system temp directory they once reached 18,000 entries and 5.8 GB and filled
 * the disk. Rather than teach every test to clean up after itself, every test's `tmpdir()` is
 * pointed here: os.tmpdir() reads TMPDIR on each call, and vitest builds the workers' environment
 * from process.env after global setup has run, so every worker — and every scan worker thread a
 * test spawns, which inherits it — writes inside this directory.
 */
export default function setup(): () => void {
  const previous = process.env.TMPDIR
  const dir = mkdtempSync(join(tmpdir(), 'jellymaid-test-run-'))
  process.env.TMPDIR = dir
  return () => {
    rmSync(dir, { recursive: true, force: true })
    if (previous === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previous
  }
}
