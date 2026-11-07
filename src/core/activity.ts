export type ActivityKind = 'scan' | 'plan'

/**
 * One process-wide mutex between scans and plan runs.
 *
 * A scan rewrites the index a plan resolves against — the torrent rows, the file rows, the item
 * rows — and sweeps whatever it no longer observes. A plan that resolves a target mid-scan reads a
 * half-rewritten index, and a scan that sweeps mid-plan forgets torrents the plan is about to act
 * on. Neither waits for the other: whichever arrives second is refused and told who holds the lock.
 *
 * Deliberately not re-entrant, and released only by the exact (kind, id) that holds it, so a stray
 * release from a finished or unrelated run can never open the lock under a live one.
 */
export interface ActivityLock {
  tryAcquire(kind: ActivityKind, id: string): { ok: true } | { ok: false; heldBy: { kind: ActivityKind; id: string } }
  /** No-op unless currently held by exactly (kind, id). */
  release(kind: ActivityKind, id: string): void
  current(): { kind: ActivityKind; id: string } | null
}

export function createActivityLock(): ActivityLock {
  let held: { kind: ActivityKind; id: string } | null = null
  return {
    tryAcquire(kind, id) {
      if (held) return { ok: false, heldBy: { ...held } }
      held = { kind, id }
      return { ok: true }
    },
    release(kind, id) {
      if (held && held.kind === kind && held.id === id) held = null
    },
    current: () => (held ? { ...held } : null),
  }
}
