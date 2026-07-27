import type { Db } from '../../index/db.js'
import type { PathMap } from '../../fs/pathmap.js'
import type { FileConfig } from '../../config/schema.js'
import type { JellyfinClient } from '../../connectors/jellyfin.js'
import type { QbitClient } from '../../connectors/qbittorrent.js'
import type { ArrClient } from '../../connectors/arr.js'
import type { createHasher } from '../../fs/hasher.js'

export type PhaseName = 'jellyfin' | 'filesystem' | 'qbittorrent' | 'arr'

export interface ScanDeps {
  config: FileConfig
  pathMap: PathMap
  jellyfin: JellyfinClient | null
  qbittorrent: QbitClient | null
  radarr: ArrClient | null
  sonarr: ArrClient | null
  hasher: ReturnType<typeof createHasher> | null
}

export interface PhaseContext {
  db: Db
  scanId: number
  cursor: Record<string, unknown>
  signal: AbortSignal
  deps: ScanDeps
  saveCursor(cursor: Record<string, unknown>): void
  progress(done: number, total: number | null): void
}

export interface PhaseResult {
  status: 'completed' | 'skipped' | 'cancelled'
  reason?: string
  counts: Record<string, number>
}

export interface Phase {
  name: PhaseName
  run(ctx: PhaseContext): Promise<PhaseResult>
}

export function describeError(err: unknown): string {
  const kind = (err as { kind?: string }).kind
  return kind ? `${kind}: ${(err as Error).message}` : (err as Error).message
}
