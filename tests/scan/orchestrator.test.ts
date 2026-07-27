import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../src/index/db.js'
import { runScan, latestScan, pruneOldScans } from '../../src/scan/orchestrator.js'
import { createPathMap } from '../../src/fs/pathmap.js'
import { fileConfigSchema } from '../../src/config/schema.js'
import type { Phase } from '../../src/scan/phases/types.js'

let db: Db
const deps = () => ({
  config: fileConfigSchema.parse({}), pathMap: createPathMap([]),
  jellyfin: null, qbittorrent: null, radarr: null, sonarr: null, hasher: null,
})

const fakePhase = (name: string, impl: Phase['run']): Phase => ({ name: name as Phase['name'], run: impl })

beforeEach(() => { db = openDb(join(mkdtempSync(join(tmpdir(), 'jm-orch-')), 'db.sqlite')) })

describe('runScan', () => {
  it('runs phases in order and records a completed scan', async () => {
    const order: string[] = []
    const phases = ['jellyfin', 'filesystem', 'qbittorrent', 'arr'].map((n) =>
      fakePhase(n, async () => { order.push(n); return { status: 'completed', counts: {} } }))
    const summary = await runScan({ db, deps: deps() as never, signal: new AbortController().signal, phases })
    expect(order).toEqual(['jellyfin', 'filesystem', 'qbittorrent', 'arr'])
    expect(summary.status).toBe('completed')
    const row = latestScan(db)!
    expect(row.status).toBe('completed')
    expect(row.finished_at).toBeTruthy()
  })

  it('continues after a skipped phase and records the reason', async () => {
    const phases = [
      fakePhase('jellyfin', async () => ({ status: 'skipped', reason: 'unreachable: down', counts: {} })),
      fakePhase('filesystem', async () => ({ status: 'completed', counts: { entries: 3 } })),
    ]
    const summary = await runScan({ db, deps: deps() as never, signal: new AbortController().signal, phases })
    expect(summary.status).toBe('completed')
    expect(summary.phases.jellyfin!.status).toBe('skipped')
    expect(summary.phases.jellyfin!.reason).toContain('unreachable')
    expect(summary.phases.filesystem!.status).toBe('completed')
  })

  it('marks the scan failed when a phase throws, without losing prior phase results', async () => {
    const phases = [
      fakePhase('jellyfin', async () => ({ status: 'completed', counts: { items: 1 } })),
      fakePhase('filesystem', async () => { throw new Error('disk exploded') }),
    ]
    const summary = await runScan({ db, deps: deps() as never, signal: new AbortController().signal, phases })
    expect(summary.status).toBe('failed')
    expect(summary.phases.jellyfin!.status).toBe('completed')
    expect(latestScan(db)!.error).toContain('disk exploded')
  })

  it('stops at the next phase boundary when cancelled', async () => {
    const controller = new AbortController()
    const ran: string[] = []
    const phases = [
      fakePhase('jellyfin', async () => { ran.push('jellyfin'); controller.abort(); return { status: 'completed', counts: {} } }),
      fakePhase('filesystem', async () => { ran.push('filesystem'); return { status: 'completed', counts: {} } }),
    ]
    const summary = await runScan({ db, deps: deps() as never, signal: controller.signal, phases })
    expect(ran).toEqual(['jellyfin'])
    expect(summary.status).toBe('cancelled')
    expect(latestScan(db)!.status).toBe('cancelled')
  })

  it('persists the phase cursor so a resumed scan skips finished phases', async () => {
    const controller = new AbortController()
    const first = await runScan({
      db, deps: deps() as never, signal: controller.signal,
      phases: [
        fakePhase('jellyfin', async () => ({ status: 'completed', counts: {} })),
        fakePhase('filesystem', async () => { controller.abort(); return { status: 'cancelled', counts: {} } }),
      ],
    })
    expect(first.status).toBe('cancelled')

    const ran: string[] = []
    const second = await runScan({
      db, deps: deps() as never, signal: new AbortController().signal, scanId: first.scanId,
      phases: [
        fakePhase('jellyfin', async () => { ran.push('jellyfin'); return { status: 'completed', counts: {} } }),
        fakePhase('filesystem', async () => { ran.push('filesystem'); return { status: 'completed', counts: {} } }),
      ],
    })
    expect(ran).toEqual(['filesystem'])
    expect(second.status).toBe('completed')
  })

  it('reports progress with the phase name', async () => {
    const seen: Array<{ phase: string; done: number }> = []
    await runScan({
      db, deps: deps() as never, signal: new AbortController().signal,
      onProgress: (p) => seen.push({ phase: p.phase, done: p.done }),
      phases: [fakePhase('jellyfin', async (ctx) => { ctx.progress(5, 10); return { status: 'completed', counts: {} } })],
    })
    expect(seen).toContainEqual({ phase: 'jellyfin', done: 5 })
  })
})

describe('pruneOldScans', () => {
  it('keeps the two most recent scans and deletes the rest', async () => {
    for (let i = 0; i < 4; i += 1) {
      await runScan({ db, deps: deps() as never, signal: new AbortController().signal, phases: [] })
    }
    const removed = pruneOldScans(db, 2)
    expect(removed).toBe(2)
    expect((db.prepare('SELECT COUNT(*) c FROM scans').get() as { c: number }).c).toBe(2)
  })
})
