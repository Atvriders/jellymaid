import type { Db } from '../index/db.js'
import type { Phase, PhaseName, PhaseResult, ScanDeps } from './phases/types.js'
import { jellyfinPhase } from './phases/jellyfin.js'
import { filesystemPhase } from './phases/filesystem.js'
import { qbittorrentPhase } from './phases/qbittorrent.js'
import { arrPhase } from './phases/arr.js'

export const DEFAULT_PHASES: Phase[] = [jellyfinPhase, filesystemPhase, qbittorrentPhase, arrPhase]

export interface ScanRow {
  id: number
  started_at: string
  finished_at: string | null
  status: string
  phase: string | null
  cursor_json: string
  stats_json: string
  error: string | null
}

export interface ScanSummary {
  scanId: number
  status: 'completed' | 'cancelled' | 'failed'
  phases: Partial<Record<PhaseName, PhaseResult>>
  startedAt: string
  finishedAt: string
}

export interface ScanProgress { phase: PhaseName; done: number; total: number | null }

export function latestScan(db: Db): ScanRow | null {
  return (db.prepare('SELECT * FROM scans ORDER BY id DESC LIMIT 1').get() as ScanRow | undefined) ?? null
}

export function pruneOldScans(db: Db, keep = 2): number {
  const info = db.prepare(
    'DELETE FROM scans WHERE id NOT IN (SELECT id FROM scans ORDER BY id DESC LIMIT ?)',
  ).run(keep)
  return info.changes
}

export async function runScan(opts: {
  db: Db
  deps: ScanDeps
  signal: AbortSignal
  scanId?: number
  phases?: Phase[]
  onProgress?: (p: ScanProgress) => void
}): Promise<ScanSummary> {
  const { db } = opts
  const phases = opts.phases ?? DEFAULT_PHASES
  const startedAt = new Date().toISOString()

  let scanId: number
  let cursor: Record<string, Record<string, unknown>>
  let completed: string[]
  let results: Partial<Record<PhaseName, PhaseResult>> = {}

  if (opts.scanId) {
    const existing = db.prepare('SELECT * FROM scans WHERE id = ?').get(opts.scanId) as ScanRow | undefined
    if (!existing) throw new Error(`scan ${opts.scanId} does not exist`)
    scanId = existing.id
    const parsed = JSON.parse(existing.cursor_json) as {
      phases?: Record<string, Record<string, unknown>>
      completed?: string[]
      results?: Partial<Record<PhaseName, PhaseResult>>
    }
    cursor = parsed.phases ?? {}
    completed = parsed.completed ?? []
    results = parsed.results ?? {}
    // Also clear finished_at: the row is live again, and a stale finish time from the
    // interrupted attempt would make a resumed-but-still-running scan look already done to
    // anything reading the row (e.g. status polling) between here and its next finish.
    db.prepare("UPDATE scans SET status='running', finished_at=NULL, error=NULL WHERE id=?").run(scanId)
  } else {
    const info = db.prepare("INSERT INTO scans (started_at, status) VALUES (?, 'running')").run(startedAt)
    scanId = Number(info.lastInsertRowid)
    cursor = {}
    completed = []
  }

  const persistCursor = () => {
    db.prepare('UPDATE scans SET cursor_json = ? WHERE id = ?')
      .run(JSON.stringify({ phases: cursor, completed, results }), scanId)
  }

  let status: ScanSummary['status'] = 'completed'
  let error: string | null = null

  for (const phase of phases) {
    if (opts.signal.aborted) { status = 'cancelled'; break }
    if (completed.includes(phase.name)) continue

    db.prepare('UPDATE scans SET phase = ? WHERE id = ?').run(phase.name, scanId)
    try {
      const result = await phase.run({
        db,
        scanId,
        cursor: cursor[phase.name] ?? {},
        signal: opts.signal,
        deps: opts.deps,
        saveCursor: (c) => { cursor[phase.name] = c; persistCursor() },
        progress: (done, total) => opts.onProgress?.({ phase: phase.name, done, total }),
      })
      results[phase.name] = result
      if (result.status === 'cancelled') { status = 'cancelled'; persistCursor(); break }
      completed.push(phase.name)
      persistCursor()
    } catch (err) {
      error = `${phase.name}: ${(err as Error).message}`
      status = 'failed'
      break
    }
    if (opts.signal.aborted) { status = 'cancelled'; break }
  }

  const finishedAt = new Date().toISOString()
  db.prepare('UPDATE scans SET status=?, finished_at=?, error=?, stats_json=? WHERE id=?')
    .run(status, finishedAt, error, JSON.stringify(results), scanId)
  // Retention is the caller's call, not runScan's: pruning mid-sequence (e.g. a scheduler
  // running several scans back to back) would delete rows a caller might still want to
  // inspect between runs. `pruneOldScans` is exported precisely so the worker decides when.

  return { scanId, status, phases: results, startedAt, finishedAt }
}
