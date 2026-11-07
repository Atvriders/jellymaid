import type { Logger } from './core/logger.js'
import type { ScanRunner } from './scan/runner.js'
import type { Scheduler } from './scan/scheduler.js'

export interface ShutdownDeps {
  app: { close(): Promise<unknown> }
  scanRunner: Pick<ScanRunner, 'shutdown'>
  executor: { requestStop(): void; idle(): Promise<void> }
  db: { close(): unknown }
  /** Stopped first, so no scheduled scan or trash purge starts while everything else winds down. */
  schedulers?: ReadonlyArray<Pick<Scheduler, 'stop'>>
  logger: Pick<Logger, 'info' | 'error'>
  /** `process.exit` in production; a spy in tests. */
  exit: (code: number) => void
}

/**
 * The SIGTERM/SIGINT handler. Returns a function that runs the shutdown ONCE however many signals
 * arrive: a second signal (an impatient Ctrl-C, `docker stop` after a `kill`) gets the shutdown
 * already in progress, never a second app.close() or a second db.close() under a run still going.
 *
 * The order is the safety property, not a style choice:
 * 1. The executor is asked to stop BEFORE the HTTP server closes, so the stop never depends on how
 *    Fastify closes. Today close() drops a fully received in-flight request and resolves at once,
 *    but if it ever waited for in-flight handlers, POST /api/plans/:id/resume (which awaits the
 *    whole run) would hold the close open for the entire plan, and a stop asked only afterwards
 *    would arrive after the last action.
 * 2. The HTTP server closes and is AWAITED. Until it has, an in-flight POST /execute can still claim
 *    a plan, and a claim clears any earlier stop request (src/plan/executor.ts, `claim`) — the stop
 *    from step 1 can be undone by the very request it raced.
 * 3. The scan worker is cancelled and its exit awaited; it holds its own database connection.
 * 4. The executor is asked to stop AGAIN. This second request is the one that cannot be raced: no
 *    request can claim a plan any more, so it re-arms a stop that a claim during step 2 cleared.
 *    Both requests are needed; neither one alone covers both failure modes above.
 * 5. The executor finishes the action in flight (it stops between actions, never inside one) and
 *    goes idle; its remaining actions stay pending and the plan resumable.
 * 6. Only then is the database closed: closing it under a running action would fail that action's
 *    bookkeeping after its delete had already happened.
 *
 * A step that throws is logged and the rest still run — a server that failed to close must not
 * leave the database open behind a plan run — and the exit code is then 1, so the failure is visible.
 */
export function createShutdown(deps: ShutdownDeps): (signal: string) => Promise<void> {
  let inProgress: Promise<void> | null = null

  async function run(signal: string): Promise<void> {
    deps.logger.info('shutting down', { signal })
    let failed = false
    const step = async (name: string, fn: () => unknown): Promise<void> => {
      try {
        await fn()
      } catch (err) {
        failed = true
        deps.logger.error('shutdown step failed', { step: name, err: (err as Error).message })
      }
    }
    for (const scheduler of deps.schedulers ?? []) await step('scheduler.stop', () => scheduler.stop())
    await step('executor.requestStop', () => deps.executor.requestStop())
    await step('app.close', () => deps.app.close())
    await step('scanRunner.shutdown', () => deps.scanRunner.shutdown())
    await step('executor.requestStop', () => deps.executor.requestStop())
    await step('executor.idle', () => deps.executor.idle())
    await step('db.close', () => deps.db.close())
    deps.logger.info('shut down', { signal })
    deps.exit(failed ? 1 : 0)
  }

  return (signal) => {
    inProgress ??= run(signal)
    return inProgress
  }
}
