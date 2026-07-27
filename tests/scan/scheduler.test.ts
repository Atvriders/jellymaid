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

  it('rejects an invalid cron expression at construction', () => {
    expect(() => createScheduler({ cron: 'not a cron', run: async () => {}, isRunning: () => false }))
      .toThrow(/cron/i)
  })
})
