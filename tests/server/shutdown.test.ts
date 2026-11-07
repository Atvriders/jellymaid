import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../../src/index/db.js'
import { createShutdown, type ShutdownDeps } from '../../src/shutdown.js'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

/** Lets every queued promise continuation run, so a shutdown parked on `idle()` has visibly parked there. */
const drain = () => new Promise((r) => setTimeout(r, 20))

function harness(over: Partial<ShutdownDeps> = {}) {
  const order: string[] = []
  const idle = deferred()
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'jm-shutdown-')), 'jellymaid.db'))
  const realClose = db.close.bind(db)
  const errors: string[] = []
  const deps: ShutdownDeps = {
    app: { close: async () => { order.push('app.close') } },
    scanRunner: { shutdown: async () => { order.push('scanRunner.shutdown') } },
    executor: {
      requestStop: () => { order.push('executor.requestStop') },
      idle: () => { order.push('executor.idle'); return idle.promise },
    },
    db: { close: () => { order.push('db.close'); realClose() } },
    schedulers: [{ stop: () => { order.push('scheduler.stop') } }],
    logger: { info: () => {}, error: (msg, fields) => { errors.push(`${msg} ${JSON.stringify(fields)}`) } },
    exit: vi.fn((code: number) => { order.push(`exit:${code}`) }),
    ...over,
  }
  return { order, idle, db, deps, errors }
}

describe('graceful shutdown', () => {
  it('shutdown closes the db after the executor is idle', async () => {
    const { order, idle, db, deps } = harness()
    const done = createShutdown(deps)('SIGTERM')
    await drain()
    // Parked on the executor: the action in flight is still writing its outcome to the database.
    expect(order).toContain('executor.idle')
    expect(order).not.toContain('db.close')
    expect(db.open).toBe(true)
    expect(deps.exit).not.toHaveBeenCalled()

    idle.resolve()
    await done
    expect(db.open).toBe(false)
    expect(order).toEqual([
      'scheduler.stop', 'executor.requestStop', 'app.close', 'scanRunner.shutdown', 'executor.requestStop', 'executor.idle',
      'db.close', 'exit:0',
    ])
  })

  it('asks the executor to stop again once the HTTP server is closed, so a claim that raced the close cannot undo the stop', async () => {
    const closed = deferred()
    const { order, idle, deps } = harness({ app: { close: () => closed.promise } })
    const done = createShutdown(deps)('SIGTERM')
    await drain()
    const stopsWhileClosing = order.filter((s) => s === 'executor.requestStop').length
    closed.resolve()
    idle.resolve()
    await done
    // A request that claimed a plan while the server was closing cleared the first stop; this one
    // follows the close, when nothing can claim any more.
    expect(order.filter((s) => s === 'executor.requestStop').length).toBe(stopsWhileClosing + 1)
    expect(order.lastIndexOf('executor.requestStop')).toBeLessThan(order.indexOf('executor.idle'))
  })

  it('asks the executor to stop BEFORE closing the HTTP server, and again after it, so the stop never waits on the close', async () => {
    // A close that never settles stands in for a Fastify close that waits on an in-flight handler —
    // POST /api/plans/:id/resume awaits a whole run. The stop must already have been asked.
    const closed = deferred()
    const { order, idle, deps } = harness({ app: { close: () => { order.push('app.close'); return closed.promise } } })
    const done = createShutdown(deps)('SIGTERM')
    await drain()
    expect(order).toEqual(['scheduler.stop', 'executor.requestStop', 'app.close'])

    closed.resolve()
    idle.resolve()
    await done
    // The second request re-arms a stop that a claim racing the close cleared (executor.ts `claim`).
    const stops = order.flatMap((s, i) => (s === 'executor.requestStop' ? [i] : []))
    expect(stops).toHaveLength(2)
    expect(stops[0]).toBeLessThan(order.indexOf('app.close'))
    expect(stops[1]).toBeGreaterThan(order.indexOf('app.close'))
    expect(stops[1]).toBeLessThan(order.indexOf('executor.idle'))
  })

  it('is idempotent: a second signal while shutting down closes nothing twice', async () => {
    const { order, idle, deps } = harness()
    const shutdown = createShutdown(deps)
    const first = shutdown('SIGTERM')
    const second = shutdown('SIGINT')
    idle.resolve()
    await Promise.all([first, second])
    await shutdown('SIGTERM')
    for (const step of ['app.close', 'scanRunner.shutdown', 'db.close']) {
      expect(order.filter((s) => s === step), step).toHaveLength(1)
    }
    // Once before the close and once after it — per shutdown, not per signal.
    expect(order.filter((s) => s === 'executor.requestStop')).toHaveLength(2)
    expect(deps.exit).toHaveBeenCalledTimes(1)
  })

  it('a step that fails is logged and the rest still run, so the database is still closed — and the exit code says so', async () => {
    const { order, idle, db, deps, errors } = harness({ app: { close: async () => { throw new Error('close failed') } } })
    idle.resolve()
    await createShutdown(deps)('SIGTERM')
    expect(db.open).toBe(false)
    expect(order.slice(-2)).toEqual(['db.close', 'exit:1'])
    expect(errors.join('\n')).toMatch(/close failed/)
  })
})
