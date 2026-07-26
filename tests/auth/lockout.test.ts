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

  it('reset clears both failures and an active lock', () => {
    let t = 0
    const l = createLockout({ maxFailures: 1, windowMs: 1000, lockMs: 1000, now: () => t })
    l.recordFailure('bob')
    l.reset('bob')
    expect(l.check('bob').locked).toBe(false)
  })
})
