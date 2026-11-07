import { ACTION_TYPES, GUARD_IDS } from './api.js'
import type { ActionType, GuardId, RequestedAction } from './api.js'

/**
 * Browser storage is a convenience here, never a dependency. A private window, blocked site data
 * or a full quota makes `localStorage` throw — sometimes on the mere `window.localStorage` access,
 * not just on `getItem`/`setItem` — and the app must then carry on in memory exactly as if nothing
 * had been stored. So every access in the app goes through these two helpers, and both swallow
 * whatever storage throws.
 */
export function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Unavailable or full: the in-memory copy is still authoritative for this session.
  }
}

export const QUEUE_STORAGE_KEY = 'jellymaid.queue.v1'

const ACTION_TYPE_SET = new Set<string>(ACTION_TYPES)
const GUARD_ID_SET = new Set<string>(GUARD_IDS)

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v !== ''

/**
 * Turns whatever is stored back into queued actions, keeping only entries this client could have
 * queued itself. The queue is what a plan is built from, so a stored value that is not valid JSON,
 * an older build's shape, or a hand-edited entry must be dropped rather than sent to the planner —
 * and an entry naming neither a target path nor item ids names nothing to act on. Only the known
 * keys are copied, so nothing else stored alongside them can ride into a plan request.
 */
export function parseStoredQueue(raw: string | null): RequestedAction[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const out: RequestedAction[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue
    const { type, targetPath, itemIds, overrides } = entry as Record<string, unknown>
    if (typeof type !== 'string' || !ACTION_TYPE_SET.has(type)) continue
    if (targetPath !== undefined && !isNonEmptyString(targetPath)) continue
    if (itemIds !== undefined && !(Array.isArray(itemIds) && itemIds.every(isNonEmptyString))) continue
    if (overrides !== undefined && !(Array.isArray(overrides) && overrides.every((g) => typeof g === 'string' && GUARD_ID_SET.has(g)))) continue
    if (targetPath === undefined && itemIds === undefined) continue

    const action: RequestedAction = { type: type as ActionType }
    if (targetPath !== undefined) action.targetPath = targetPath
    if (itemIds !== undefined) action.itemIds = [...(itemIds as string[])]
    if (overrides !== undefined) action.overrides = [...(overrides as GuardId[])]
    out.push(action)
  }
  return out
}
