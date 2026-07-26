export interface Lockout {
  check(key: string): { locked: boolean; retryAfterMs: number }
  recordFailure(key: string): void
  reset(key: string): void
  /**
   * Single-flight queue: serialises check-authenticate-record for a given key so a
   * concurrent burst of requests cannot all pass `check()` before any of them calls
   * `recordFailure()`. Callers MUST call the returned release function exactly once,
   * in a `finally`, or every subsequent caller for that key wedges forever.
   */
  beginAttempt(key: string): Promise<() => void>
  /**
   * Number of keys currently held in memory. A pure observation — it does NOT sweep, so a test
   * can prove the opportunistic sweep actually happens rather than proving its own call did it.
   */
  size(): number
}

/**
 * Full sweeps run at most once every this many check/recordFailure calls. Keys are derived from
 * unauthenticated input (one dimension is the client IP), so entries must not accumulate for the
 * life of the process — but sweeping the whole map on every call would make each unauthenticated
 * request cost O(all keys). Sweeping every N calls bounds it to amortised O(1) per call.
 */
const SWEEP_EVERY = 64

export function createLockout(opts: {
  maxFailures: number; windowMs: number; lockMs: number; now?: () => number
}): Lockout {
  const now = opts.now ?? Date.now
  const failures = new Map<string, number[]>()
  const locks = new Map<string, number>()
  const queues = new Map<string, Promise<void>>()
  let callsSinceSweep = 0

  /** Drops expired locks and failure lists whose newest entry has fallen out of the window. */
  function sweep(): void {
    const t = now()
    const cutoff = t - opts.windowMs
    for (const [key, until] of locks) if (until <= t) locks.delete(key)
    for (const [key, times] of failures) {
      const newest = times[times.length - 1]
      if (newest === undefined || newest <= cutoff) failures.delete(key)
    }
  }

  function maybeSweep(): void {
    callsSinceSweep += 1
    if (callsSinceSweep < SWEEP_EVERY) return
    callsSinceSweep = 0
    sweep()
  }

  return {
    check(key) {
      maybeSweep()
      const until = locks.get(key)
      if (until === undefined) return { locked: false, retryAfterMs: 0 }
      const remaining = until - now()
      if (remaining <= 0) { locks.delete(key); return { locked: false, retryAfterMs: 0 } }
      return { locked: true, retryAfterMs: remaining }
    },
    recordFailure(key) {
      maybeSweep()
      const cutoff = now() - opts.windowMs
      const recent = (failures.get(key) ?? []).filter((t) => t > cutoff)
      recent.push(now())
      failures.set(key, recent)
      if (recent.length >= opts.maxFailures) {
        locks.set(key, now() + opts.lockMs)
        // The lock carries this key's state from here; keeping the spent list would only leak.
        failures.delete(key)
      }
    },
    reset(key) { failures.delete(key); locks.delete(key) },
    async beginAttempt(key) {
      // Wait for whoever is currently holding this key's turn.
      const prior = queues.get(key) ?? Promise.resolve()
      let release!: () => void
      const done = new Promise<void>((resolve) => { release = resolve })
      // The new queue tail resolves only once the prior holder AND we are both done,
      // so the next caller in line waits for us too.
      const tail = prior.then(() => done)
      queues.set(key, tail)
      await prior
      return () => {
        release()
        // Only the last-enqueued holder for this key clears the map entry, so it
        // doesn't grow without bound once nobody is waiting on this key anymore.
        if (queues.get(key) === tail) queues.delete(key)
      }
    },
    size: () => new Set([...failures.keys(), ...locks.keys()]).size,
  }
}
