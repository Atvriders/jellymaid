import { describe, it, expect } from 'vitest'
import { createActivityLock } from '../../src/core/activity.js'

describe('createActivityLock', () => {
  it('starts free and grants the first acquire', () => {
    const lock = createActivityLock()
    expect(lock.current()).toBeNull()
    expect(lock.tryAcquire('scan', '7')).toEqual({ ok: true })
    expect(lock.current()).toEqual({ kind: 'scan', id: '7' })
  })

  it('refuses a second acquire and says who holds the lock', () => {
    const lock = createActivityLock()
    lock.tryAcquire('scan', '7')
    expect(lock.tryAcquire('plan', 'p1')).toEqual({ ok: false, heldBy: { kind: 'scan', id: '7' } })
    expect(lock.tryAcquire('scan', '8')).toEqual({ ok: false, heldBy: { kind: 'scan', id: '7' } })
  })

  it('is not re-entrant: the holder itself is refused a second acquire', () => {
    const lock = createActivityLock()
    lock.tryAcquire('plan', 'p1')
    expect(lock.tryAcquire('plan', 'p1')).toEqual({ ok: false, heldBy: { kind: 'plan', id: 'p1' } })
  })

  it('ignores a release from anything but the exact holder', () => {
    const lock = createActivityLock()
    lock.tryAcquire('scan', '7')
    lock.release('plan', '7')
    lock.release('scan', '8')
    expect(lock.current()).toEqual({ kind: 'scan', id: '7' })
    expect(lock.tryAcquire('plan', 'p1').ok).toBe(false)
  })

  it('frees the lock when the holder releases it', () => {
    const lock = createActivityLock()
    lock.tryAcquire('scan', '7')
    lock.release('scan', '7')
    expect(lock.current()).toBeNull()
    expect(lock.tryAcquire('plan', 'p1')).toEqual({ ok: true })
  })

  it('hands out copies, so a caller cannot rewrite who holds the lock', () => {
    const lock = createActivityLock()
    lock.tryAcquire('scan', '7')
    const seen = lock.current()!
    seen.id = 'forged'
    const refused = lock.tryAcquire('plan', 'p1')
    if (refused.ok) throw new Error('expected a refusal')
    refused.heldBy.id = 'forged'
    expect(lock.current()).toEqual({ kind: 'scan', id: '7' })
  })
})
