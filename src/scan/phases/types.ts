import type { Db } from '../../index/db.js'
import type { PathMap } from '../../fs/pathmap.js'
import type { FileConfig } from '../../config/schema.js'
import type { JellyfinClient } from '../../connectors/jellyfin.js'
import type { QbitClients } from '../../connectors/qbittorrent.js'
import type { ArrClient } from '../../connectors/arr.js'
import type { createHasher } from '../../fs/hasher.js'

export type PhaseName = 'jellyfin' | 'filesystem' | 'qbittorrent' | 'arr' | 'rules'

export interface ScanDeps {
  config: FileConfig
  pathMap: PathMap
  jellyfin: JellyfinClient | null
  qbittorrents: QbitClients          // REPLACES qbittorrent
  radarr: ArrClient | null
  sonarr: ArrClient | null
  hasher: ReturnType<typeof createHasher> | null
  /**
   * Instances whose long-lived main-thread client is holding off logging in (QbitClient.loginBlocked,
   * read by the runner as the scan starts — Ruling 18). The qbittorrent phase treats them as failed
   * without asking them anything: the clients above are built fresh for this scan and remember no
   * refusal, so asking would spend another failed login towards qBittorrent's one-hour ban on every
   * scan. They stay in `qbittorrents` all the same — still configured, so their rows are kept as
   * unobserved rather than dropped. Absent = none.
   */
  qbitLoginBlocked?: ReadonlySet<string>
}

export interface PhaseContext {
  db: Db
  scanId: number
  cursor: Record<string, unknown>
  signal: AbortSignal
  deps: ScanDeps
  /**
   * What every phase before this one in THIS scan actually reported — including the ones that
   * skipped. A phase that skipped is still pushed onto the orchestrator's `completed` list and
   * later phases still run, so without this a downstream phase cannot tell "the jellyfin phase
   * observed the library and it looks like this" from "the jellyfin phase never got an answer and
   * what you are reading is the previous scan's snapshot". The rules phase turns exactly that
   * distinction into per-rule `evaluated` vs `not-evaluated`, which is what keeps a stale snapshot
   * from manufacturing orphan findings that a later plan would queue for deletion.
   *
   * Only phases that have already run this scan appear. A resumed scan restores it from the
   * cursor, so results observed before the interruption are not lost.
   */
  priorResults: Partial<Record<PhaseName, PhaseResult>>
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
