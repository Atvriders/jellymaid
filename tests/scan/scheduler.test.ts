import { describe, it, expect, vi } from 'vitest'
import { createScheduler } from '../../src/scan/scheduler.js'

describe('scheduler', () => {
  it('does not run before the cron time is due', async () => {
    const run = vi.fn(async () => {})
    let now = new Date('2026-07-26T02:00:00Z')
    const s = createScheduler({ cron: '0 3 * * *', run, isRunning: () => false, now: () => now })
    expect(await s.tick()).toBe('not-due')
    expect(run).not.toHaveBeenCalled()
  })

  it('runs once the cron time passes', async () => {
    const run = vi.fn(async () => {})
    let now = new Date('2026-07-26T02:00:00Z')
    const s = createScheduler({ cron: '0 3 * * *', run, isRunning: () => false, now: () => now })
    await s.tick()
    now = new Date('2026-07-26T03:00:01Z')
    expect(await s.tick()).toBe('ran')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('suppresses a scheduled run while a scan is already running', async () => {
    const run = vi.fn(async () => {})
    let now = new Date('2026-07-26T02:00:00Z')
    const s = createScheduler({ cron: '0 3 * * *', run, isRunning: () => true, now: () => now })
    await s.tick()
    now = new Date('2026-07-26T03:00:01Z')
    expect(await s.tick()).toBe('skipped-overlap')
    expect(run).not.toHaveBeenCalled()
  })

  it('advances to the next occurrence after running so it does not re-fire', async () => {
    const run = vi.fn(async () => {})
    let now = new Date('2026-07-26T03:00:01Z')
    const s = createScheduler({ cron: '0 3 * * *', run, isRunning: () => false, now: () => now })
    await s.tick()
    expect(await s.tick()).toBe('not-due')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('routes a throwing run() to onError instead of leaving an unhandled rejection on the timer', async () => {
    // `void this.tick()` turned any throw from run() into an unhandled promise rejection on an
    // interval timer, which Node escalates to a process crash — the whole server dying over one
    // missed scheduled scan.
    const errors: unknown[] = []
    const s = createScheduler({
      cron: '* * * * *',
      run: async () => { throw new Error('start exploded') },
      isRunning: () => false,
      now: () => new Date('2026-07-26T03:00:01Z'),
      onError: (err) => errors.push(err),
    })
    s.start(1)
    await new Promise((r) => setTimeout(r, 60))
    s.stop()
    expect(errors.length).toBeGreaterThan(0)
    expect((errors[0] as Error).message).toBe('start exploded')
  })

  it('rejects an invalid cron expression at construction', () => {
    expect(() => createScheduler({ cron: 'not a cron', run: async () => {}, isRunning: () => false }))
      .toThrow(/cron/i)
  })
})
