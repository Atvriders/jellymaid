// tests/auth/lockout.test.ts
import { describe, it, expect } from 'vitest'
import { createLockout } from '../../src/auth/lockout.js'

describe('lockout', () => {
  it('locks after the configured failures inside the window', () => {
    let t = 0
    const l = createLockout({ maxFailures: 3, windowMs: 5 * 60_000, lockMs: 60 * 60_000, now: () => t })
    l.recordFailure('bob'); l.recordFailure('bob')
    expect(l.check('bob').locked).toBe(false)
    l.recordFailure('bob')
    expect(l.check('bob').locked).toBe(true)
  })

  it('forgets failures that fall outside the window', () => {
    let t = 0
    const l = createLockout({ maxFailures: 3, windowMs: 5 * 60_000, lockMs: 60 * 60_000, now: () => t })
    l.recordFailure('bob'); l.recordFailure('bob')
    t = 6 * 60_000
    l.recordFailure('bob')
    expect(l.check('bob').locked).toBe(false)
  })

  it('expires the lock after lockMs and reports the remaining time', () => {
    let t = 0
    const l = createLockout({ maxFailures: 1, windowMs: 1000, lockMs: 10_000, now: () => t })
    l.recordFailure('bob')
    expect(l.check('bob').retryAfterMs).toBe(10_000)
    t = 10_001
    expect(l.check('bob').locked).toBe(false)
  })

  it('tracks keys independently so one user cannot lock out another', () => {
    let t = 0
    const l = createLockout({ maxFailures: 1, windowMs: 1000, lockMs: 1000, now: () => t })
    l.recordFailure('bob')
    expect(l.check('alice').locked).toBe(false)
  })

  it('leaves no entry behind for a key that failed once and fell out of the window', () => {
    let t = 0
    const l = createLockout({ maxFailures: 3, windowMs: 5 * 60_000, lockMs: 60 * 60_000, now: () => t })
    l.recordFailure('ip:203.0.113.7')
    expect(l.size()).toBe(1)
    t = 6 * 60_000
    // Ordinary later traffic — not a test-only helper — must be what drives the sweep. Keys are
    // attacker-influenced, so entries accumulating for the process lifetime is a memory leak
    // driven by unauthenticated input.
    for (let i = 0; i < 128; i += 1) l.check(`ip:198.51.100.${i}`)
    expect(l.size()).toBe(0)
  })

  it('sweeps expired locks too, not just failure lists', () => {
    let t = 0
    const l = createLockout({ maxFailures: 1, windowMs: 1000, lockMs: 10_000, now: () => t })
    l.recordFailure('ip:203.0.113.9')
    expect(l.size()).toBe(1)
    t = 20_000
    for (let i = 0; i < 128; i += 1) l.check(`ip:198.51.100.${i}`)
    expect(l.size()).toBe(0)
  })

  it('does not sweep away a key that is still inside its window or lock', () => {
    let t = 0
    const l = createLockout({ maxFailures: 3, windowMs: 5 * 60_000, lockMs: 60 * 60_000, now: () => t })
    l.recordFailure('user:bob')
    t = 60_000
    for (let i = 0; i < 128; i += 1) l.check(`ip:198.51.100.${i}`)
    expect(l.size()).toBe(1)
    l.recordFailure('user:bob'); l.recordFailure('user:bob')
    expect(l.check('user:bob').locked).toBe(true)
  })

  it('reset clears both failures and an active lock', () => {
    let t = 0
    const l = createLockout({ maxFailures: 1, windowMs: 1000, lockMs: 1000, now: () => t })
    l.recordFailure('bob')
    l.reset('bob')
    expect(l.check('bob').locked).toBe(false)
  })
})
