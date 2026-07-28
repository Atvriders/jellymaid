import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../src/App.js'
import { ApiError } from '../src/api.js'
import type { Finding, PlanView } from '../src/api.js'

// Dashboard is the default landing screen, so every test below that reaches the shell needs at
// least enough of the api for IT to render without throwing (health/findingsSummary/scanStatus are
// all called unconditionally on mount — see src/screens/Dashboard.tsx). `findingsSummary` reports
// `evaluated: false` so Dashboard's own render stays a one-line empty state instead of pulling in
// the class-tile logic these tests have no reason to exercise.
const api = (over: Record<string, unknown> = {}) => ({
  me: vi.fn(async () => { throw new ApiError(401, 'not authenticated') }),
  logout: vi.fn(async () => ({ ok: true as const })),
  login: vi.fn(async () => ({ username: 'bob' })),
  health: vi.fn(async () => ({ status: 'ok' as const, schemaVersion: 1, connectors: {} })),
  findingsSummary: vi.fn(async () => ({
    evaluated: false, basedOn: null, latestAttempt: null, byClass: {}, reclaimableBytes: 0, notEvaluated: [],
  })),
  scanStatus: vi.fn(async () => ({ running: false, scanId: null, phase: null, done: 0, total: null, lastScan: null })),
  ...over,
} as never)

describe('App', () => {
  it('shows the login screen when there is no session', async () => {
    render(<App api={api()} />)
    expect(await screen.findByLabelText(/username/i)).toBeInTheDocument()
  })

  it('shows the shell and nav once a session exists', async () => {
    render(<App api={api({ me: vi.fn(async () => ({ username: 'bob', userId: 'u1' })) })} />)
    expect(await screen.findByRole('button', { name: /sign out/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /dashboard/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /findings/i })).toBeInTheDocument()
    expect(screen.getByText('bob')).toBeInTheDocument()
  })

  it('moves from login to the shell after a successful sign-in', async () => {
    render(<App api={api()} />)
    await userEvent.type(await screen.findByLabelText(/username/i), 'bob')
    await userEvent.type(screen.getByLabelText(/password/i), 'pw')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    expect(await screen.findByRole('button', { name: /sign out/i })).toBeInTheDocument()
  })

  it('returns to the login screen after signing out', async () => {
    render(<App api={api({ me: vi.fn(async () => ({ username: 'bob', userId: 'u1' })) })} />)
    await userEvent.click(await screen.findByRole('button', { name: /sign out/i }))
    expect(await screen.findByLabelText(/username/i)).toBeInTheDocument()
  })

  it('renders a hostile jellyfin username as text only', async () => {
    render(<App api={api({ me: vi.fn(async () => ({ username: '<img src=x onerror=alert(1)>', userId: 'u1' })) })} />)
    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeInTheDocument()
    expect(document.querySelector('img')).toBeNull()
  })

  // --- Task 6 shell wiring -------------------------------------------------------------------
  // Dashboard, Findings, Duplicates and Explorer were built (and fully tested in isolation) in
  // Tasks 3-5, but nothing before this task ever imported them into App — every nav tab rendered
  // the same "not wired up yet" placeholder no matter which one was clicked. The tests below prove
  // the wiring, not just the screens: clicking a tab must reach the REAL component, and the queue
  // those screens feed must survive being lifted up into App and handed back down to Plan.

  const planStub = (over: Partial<PlanView> = {}): PlanView => ({
    id: 'p1', status: 'draft', createdBy: 'bob', createdAt: 'T', approvedBy: null,
    dryRun: { deleteCount: 1, bytesFreed: 0, torrentsRemoved: 0, blockedCount: 0 },
    actions: [{
      id: 'a1', seq: 0, type: 'delete-media', status: 'pending',
      payload: { type: 'delete-media', targetPath: '/mnt/m/Orphan.mkv' }, guardVerdicts: [], error: null, isAlternateVersion: null,
    }],
    ...over,
  })

  /** Every method any of the seven screens could call, once, so a test that walks the whole nav
   * bar never hits an undefined function. Individual tests override only what they need.
   * `approvePlan`/`executePlan` transition status the same way the real routes do (draft ->
   * approved -> completed), rather than echoing back a fixed 'draft' plan forever — a test that
   * clicks Approve then Execute needs the mock to actually move for the Execute button to ever
   * appear, the same as it would need the real server to. */
  const fullApi = (over: Record<string, unknown> = {}) => api({
    findings: vi.fn(async () => ({ findings: [], total: 0 })),
    dismissFinding: vi.fn(async () => ({ ok: true as const })),
    duplicates: vi.fn(async () => ({ groups: [] })),
    mergeGroup: vi.fn(async () => ({ merged: [] })),
    explorer: vi.fn(async () => ({ path: '', parent: null, entries: [] })),
    createPlan: vi.fn(async () => planStub()),
    getPlan: vi.fn(async () => planStub({ status: 'approved' })),
    approvePlan: vi.fn(async () => planStub({ status: 'approved' })),
    executePlan: vi.fn(async () => ({ planId: 'p1', status: 'completed' as const, done: 1, failed: 0, skipped: 0, blocked: 0, bytesFreed: 1_048_576 })),
    resumePlan: vi.fn(async () => ({ planId: 'p1', status: 'completed' as const, done: 1, failed: 0, skipped: 0, blocked: 0, bytesFreed: 0 })),
    plans: vi.fn(async () => ({ plans: [] })),
    audit: vi.fn(async () => ({ entries: [] })),
    restoreTrash: vi.fn(async () => ({ restored: true })),
    trash: vi.fn(async () => ({ entries: [] })),
    pathmapGet: vi.fn(async () => ({ mappings: [] })),
    pathmapPut: vi.fn(async (mappings: unknown[]) => ({ mappings })),
    pathmapVerify: vi.fn(async () => ({ sampled: 0, resolved: 0, failures: [] })),
    pathmapDetect: vi.fn(async () => ({ proposed: [] })),
    me: vi.fn(async () => ({ username: 'bob', userId: 'u1' })),
    ...over,
  })

  it('renders the real screen for every nav item, never the placeholder', async () => {
    render(<App api={fullApi()} />)
    await screen.findByRole('button', { name: /sign out/i })

    // Dashboard is already active — its own panel heading, not a placeholder.
    expect(await screen.findByText('Connectors')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /^findings$/i }))
    expect(await screen.findByLabelText(/class/i)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /^duplicates$/i }))
    expect(await screen.findByText(/no duplicate groups found/i)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /^explorer$/i }))
    expect(await screen.findByText(/nothing here/i)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /^plan$/i }))
    expect(await screen.findByText(/nothing queued/i)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /^history$/i }))
    expect(await screen.findByText('Audit trail')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /^settings$/i }))
    expect(await screen.findByText('Path mappings')).toBeInTheDocument()

    // Never once, across any tab, the Task-1-era stand-in this task was asked to delete.
    expect(document.querySelector('.screen-placeholder')).toBeNull()
    expect(screen.queryByText(/not wired up yet/i)).not.toBeInTheDocument()
  })

  it('keeps a queue built on Findings intact after navigating away and back to Plan', async () => {
    const orphan: Finding = {
      id: 'f1', ruleId: 'fs.orphan-media', class: 'filesystem', severity: 'warning', confidence: 'strong',
      subjects: [{ kind: 'path', path: '/mnt/m/Orphan.mkv', label: 'Orphan.mkv' }],
      evidence: {}, reclaimableBytes: 1_000, status: 'open', firstSeen: 'T', lastSeen: 'T',
      dismissedReason: null, dismissedBy: null,
    }
    const createPlan = vi.fn(async () => planStub())
    render(<App api={fullApi({
      findings: vi.fn(async () => ({ findings: [orphan], total: 1 })),
      createPlan,
      // What a real audit log would hold once this exact plan executed — the last leg of the DoD
      // flow ("… approve → execute → see it in history") that this test walks end to end.
      audit: vi.fn(async () => ({
        entries: [{
          ts: 'T', actor: 'bob', actionType: 'delete-media', subject: '/mnt/m/Orphan.mkv',
          outcome: 'done', planId: 'p1', afterJson: JSON.stringify({ bytesFreed: 1_048_576 }),
        }],
      })),
    })} />)
    await screen.findByRole('button', { name: /sign out/i })

    await userEvent.click(screen.getByRole('button', { name: /^findings$/i }))
    await userEvent.click(await screen.findByRole('checkbox', { name: /select finding/i }))
    await userEvent.click(screen.getByRole('button', { name: /add to plan/i }))

    // Visit two OTHER screens — each mount/unmount is exactly the moment a queue held inside a
    // screen component instead of the App shell would have been lost — before ever opening Plan.
    await userEvent.click(screen.getByRole('button', { name: /^dashboard$/i }))
    await screen.findByText('Connectors')
    await userEvent.click(screen.getByRole('button', { name: /^duplicates$/i }))
    await screen.findByText(/no duplicate groups found/i)

    await userEvent.click(screen.getByRole('button', { name: /^plan$/i }))
    expect(screen.queryByText(/nothing queued/i)).not.toBeInTheDocument()
    expect(await screen.findByText(/1 action queued/i)).toBeInTheDocument()

    await userEvent.click(await screen.findByRole('button', { name: /build plan/i }))
    expect(createPlan).toHaveBeenCalledWith([{ type: 'delete-media', targetPath: '/mnt/m/Orphan.mkv' }])

    // The rest of the funnel this task exists to gate: approval is still a separate, deliberate
    // click from building the plan, and execute is a separate click again from approving it — at
    // no point does building or approving a plan silently run it.
    expect(screen.queryByRole('button', { name: /^execute/i })).not.toBeInTheDocument()
    await userEvent.click(await screen.findByRole('button', { name: /^approve/i }))
    await userEvent.click(await screen.findByRole('button', { name: /^execute/i }))
    expect(await screen.findByText(/1 done/i)).toBeInTheDocument()

    // "… see it in history": the final leg of the DoD flow. The audit row is server state (this
    // test's mock stands in for it), not something the click above pushes into History directly —
    // this proves History reads from the same `api.audit()` contract, not a screen-local copy.
    await userEvent.click(screen.getByRole('button', { name: /^history$/i }))
    expect(await screen.findByText('/mnt/m/Orphan.mkv')).toBeInTheDocument()
    expect(screen.getByText('done')).toBeInTheDocument()
  })

  // --- CRITICAL 1: the full journey, walking a screen boundary AFTER a destructive action --------
  // login -> dashboard -> scan -> findings -> queue a delete -> navigate away and back -> plan ->
  // approve -> execute -> history -> back to plan. Nothing before this task ever crossed a screen
  // boundary again AFTER execute, which is exactly the gap that let an executed plan re-arm itself.
  it('walks the full journey — scan, queue, build, approve, execute, history, and back to plan — without losing or re-arming anything at a screen boundary', async () => {
    const orphan: Finding = {
      id: 'f1', ruleId: 'fs.orphan-media', class: 'filesystem', severity: 'warning', confidence: 'strong',
      subjects: [{ kind: 'path', path: '/mnt/m/Orphan.mkv', label: 'Orphan.mkv' }],
      evidence: {}, reclaimableBytes: 1_000, status: 'open', firstSeen: 'T', lastSeen: 'T',
      dismissedReason: null, dismissedBy: null,
    }
    const createPlan = vi.fn(async () => planStub())
    const scanStart = vi.fn(async () => ({ scanId: 7 }))
    render(<App api={fullApi({
      findings: vi.fn(async () => ({ findings: [orphan], total: 1 })),
      createPlan,
      scanStart,
      scanStatus: vi.fn(async () => ({ running: false, scanId: 7, phase: null, done: 1, total: 1, lastScan: null })),
      audit: vi.fn(async () => ({
        entries: [{
          ts: 'T', actor: 'bob', actionType: 'delete-media', subject: '/mnt/m/Orphan.mkv',
          outcome: 'done', planId: 'p1', afterJson: JSON.stringify({ bytesFreed: 1_048_576 }),
        }],
      })),
    })} />)
    await screen.findByRole('button', { name: /sign out/i })

    // dashboard -> scan
    await screen.findByText('Connectors')
    await userEvent.click(await screen.findByRole('button', { name: /scan now/i }))
    expect(scanStart).toHaveBeenCalled()

    // findings -> queue a delete
    await userEvent.click(screen.getByRole('button', { name: /^findings$/i }))
    await userEvent.click(await screen.findByRole('checkbox', { name: /select finding/i }))
    await userEvent.click(screen.getByRole('button', { name: /add to plan/i }))

    // navigate away and back before ever opening Plan
    await userEvent.click(screen.getByRole('button', { name: /^duplicates$/i }))
    await screen.findByText(/no duplicate groups found/i)

    // plan -> build -> approve -> execute
    await userEvent.click(screen.getByRole('button', { name: /^plan$/i }))
    expect(await screen.findByText(/1 action queued/i)).toBeInTheDocument()
    await userEvent.click(await screen.findByRole('button', { name: /build plan/i }))
    expect(createPlan).toHaveBeenCalledTimes(1)
    await userEvent.click(await screen.findByRole('button', { name: /^approve/i }))
    await userEvent.click(await screen.findByRole('button', { name: /^execute/i }))
    expect(await screen.findByText(/1 done/i)).toBeInTheDocument()

    // history -> confirm the record
    await userEvent.click(screen.getByRole('button', { name: /^history$/i }))
    expect(await screen.findByText('/mnt/m/Orphan.mkv')).toBeInTheDocument()

    // Back to plan — the exact repro from the review. Must show the plan that was just executed,
    // never reset to "queued, not yet planned", and must never call createPlan a second time with
    // targets that no longer exist on disk.
    await userEvent.click(screen.getByRole('button', { name: /^plan$/i }))
    expect(screen.queryByText(/not yet planned/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /build plan/i })).not.toBeInTheDocument()
    expect(createPlan).toHaveBeenCalledTimes(1)
  })

  // --- CRITICAL 1 (second half): an approved-but-unexecuted plan must remain reachable ------------
  // Resume (src/api/plans.ts) only ever works on a `running` plan — offering it for `approved`
  // would just get a 400. History's "Open" is the actual route back into an armed plan.
  it('lets the operator reach an approved-but-unexecuted plan again through History, via Open rather than the running-only Resume', async () => {
    const orphan: Finding = {
      id: 'f1', ruleId: 'fs.orphan-media', class: 'filesystem', severity: 'warning', confidence: 'strong',
      subjects: [{ kind: 'path', path: '/mnt/m/Orphan.mkv', label: 'Orphan.mkv' }],
      evidence: {}, reclaimableBytes: 1_000, status: 'open', firstSeen: 'T', lastSeen: 'T',
      dismissedReason: null, dismissedBy: null,
    }
    render(<App api={fullApi({
      findings: vi.fn(async () => ({ findings: [orphan], total: 1 })),
      createPlan: vi.fn(async () => planStub()),
      getPlan: vi.fn(async () => planStub({ status: 'approved' })),
      plans: vi.fn(async () => ({
        plans: [{ id: 'p1', createdAt: 'T', createdBy: 'bob', status: 'approved', dryRun: { deleteCount: 1, bytesFreed: 0, torrentsRemoved: 0, blockedCount: 0 } }],
      })),
    })} />)
    await screen.findByRole('button', { name: /sign out/i })

    await userEvent.click(screen.getByRole('button', { name: /^findings$/i }))
    await userEvent.click(await screen.findByRole('checkbox', { name: /select finding/i }))
    await userEvent.click(screen.getByRole('button', { name: /add to plan/i }))
    await userEvent.click(screen.getByRole('button', { name: /^plan$/i }))
    await userEvent.click(await screen.findByRole('button', { name: /build plan/i }))
    await userEvent.click(await screen.findByRole('button', { name: /^approve/i }))

    // Leave WITHOUT executing, then reach the same plan a different way.
    await userEvent.click(screen.getByRole('button', { name: /^dashboard$/i }))
    await screen.findByText('Connectors')
    await userEvent.click(screen.getByRole('button', { name: /^history$/i }))
    expect(screen.queryByRole('button', { name: /resume/i })).not.toBeInTheDocument()
    await userEvent.click(await screen.findByRole('button', { name: /^open$/i }))

    expect(await screen.findByRole('button', { name: /^execute/i })).toBeInTheDocument()
  })

  // --- MAJOR 2 / TEST HONESTY M3: addToQueue must ACCUMULATE across two different screens, and
  // de-duplicate a target queued twice for the same action rather than either replacing or
  // doubling it. Each screen's own "already queued" receipt is component-local (History's
  // `queuedUndos`, Duplicates' `queuedFor`, Findings' selection) and is lost on remount — the
  // shared queue in App is what must be authoritative.
  it('accumulates queued actions from two different screens into one plan, rather than the newer replacing the older', async () => {
    const orphan: Finding = {
      id: 'f1', ruleId: 'fs.orphan-media', class: 'filesystem', severity: 'warning', confidence: 'strong',
      subjects: [{ kind: 'path', path: '/mnt/m/Orphan.mkv', label: 'Orphan.mkv' }],
      evidence: {}, reclaimableBytes: 1_000, status: 'open', firstSeen: 'T', lastSeen: 'T',
      dismissedReason: null, dismissedBy: null,
    }
    const createPlan = vi.fn(async () => planStub())
    render(<App api={fullApi({
      findings: vi.fn(async () => ({ findings: [orphan], total: 1 })),
      explorer: vi.fn(async () => ({
        path: '', parent: null,
        entries: [{ name: 'sample.mkv', path: '/mnt/m/sample.mkv', isDir: false, sizeBytes: 10, fileCount: 0, isMedia: false, flags: ['junk'] }],
      })),
      createPlan,
    })} />)
    await screen.findByRole('button', { name: /sign out/i })

    await userEvent.click(screen.getByRole('button', { name: /^findings$/i }))
    await userEvent.click(await screen.findByRole('checkbox', { name: /select finding/i }))
    await userEvent.click(screen.getByRole('button', { name: /add to plan/i }))

    await userEvent.click(screen.getByRole('button', { name: /^explorer$/i }))
    await userEvent.click(await screen.findByRole('checkbox', { name: /select sample\.mkv/i }))
    await userEvent.click(screen.getByRole('button', { name: /add to plan/i }))

    await userEvent.click(screen.getByRole('button', { name: /^plan$/i }))
    expect(await screen.findByText(/2 actions queued/i)).toBeInTheDocument()

    await userEvent.click(await screen.findByRole('button', { name: /build plan/i }))
    expect(createPlan).toHaveBeenCalledWith([
      { type: 'delete-media', targetPath: '/mnt/m/Orphan.mkv' },
      { type: 'delete-junk-file', targetPath: '/mnt/m/sample.mkv' },
    ])
  })

  it('de-duplicates the same queued action even when it is added again after a screen remount reset the local "already queued" receipt', async () => {
    const createPlan = vi.fn(async () => planStub())
    render(<App api={fullApi({
      audit: vi.fn(async () => ({
        entries: [{
          ts: 'T', actor: 'bob', actionType: 'merge-versions', subject: 'g1',
          outcome: 'done', planId: null, afterJson: JSON.stringify({ mergedItemIds: ['item-a', 'item-b'] }),
        }],
      })),
      createPlan,
    })} />)
    await screen.findByRole('button', { name: /sign out/i })

    await userEvent.click(screen.getByRole('button', { name: /^history$/i }))
    await userEvent.click(await screen.findByRole('button', { name: /undo merge/i }))

    // Leaving and returning to History remounts it, resetting its own `queuedUndos` — the button
    // reads "Undo merge" again, exactly as the review found. The SAME split-versions action must
    // not be queued a second time underneath it.
    await userEvent.click(screen.getByRole('button', { name: /^dashboard$/i }))
    await screen.findByText('Connectors')
    await userEvent.click(screen.getByRole('button', { name: /^history$/i }))
    await userEvent.click(await screen.findByRole('button', { name: /undo merge/i }))

    await userEvent.click(screen.getByRole('button', { name: /^plan$/i }))
    expect(await screen.findByText(/1 action queued/i)).toBeInTheDocument()

    await userEvent.click(await screen.findByRole('button', { name: /build plan/i }))
    expect(createPlan).toHaveBeenCalledWith([{ type: 'split-versions', itemIds: ['item-a'] }])
  })
})
