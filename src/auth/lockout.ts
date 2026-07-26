export interface Lockout {
  check(key: string): { locked: boolean; retryAfterMs: number }
  recordFailure(key: string): void
  reset(key: string): void
}

export function createLockout(opts: {
  maxFailures: number; windowMs: number; lockMs: number; now?: () => number
}): Lockout {
  const now = opts.now ?? Date.now
  const failures = new Map<string, number[]>()
  const locks = new Map<string, number>()

  return {
    check(key) {
      const until = locks.get(key)
      if (until === undefined) return { locked: false, retryAfterMs: 0 }
      const remaining = until - now()
      if (remaining <= 0) { locks.delete(key); return { locked: false, retryAfterMs: 0 } }
      return { locked: true, retryAfterMs: remaining }
    },
    recordFailure(key) {
      const cutoff = now() - opts.windowMs
      const recent = (failures.get(key) ?? []).filter((t) => t > cutoff)
      recent.push(now())
      failures.set(key, recent)
      if (recent.length >= opts.maxFailures) {
        locks.set(key, now() + opts.lockMs)
        failures.set(key, [])
      }
    },
    reset(key) { failures.delete(key); locks.delete(key) },
  }
}
