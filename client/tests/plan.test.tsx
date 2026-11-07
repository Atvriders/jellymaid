import { describe, it, expect, vi } from 'vitest'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PlanScreen } from '../src/screens/PlanScreen.js'
import type { RequestedAction } from '../src/api.js'
import { ApiError } from '../src/api.js'

// C12 PlanView. `error`, `progress` and `droppedOverrides` are on every plan the server returns.
const plan = (over = {}) => ({
  id: 'p1', status: 'draft', createdBy: 'bob', createdAt: 'T', approvedBy: null, error: null,
  dryRun: { deleteCount: 2, bytesFreed: 3_221_225_472, torrentsRemoved: 1, blockedCount: 0 },
  progress: { total: 1, finished: 0 }, droppedOverrides: [],
  actions: [{
    id: 'a1', seq: 0, type: 'delete-media', status: 'pending',
    payload: { targetPath: '/mnt/m/Heat.mkv' },
    guardVerdicts: [{ guard: 'guard.hardlink', outcome: 'warn', overridable: false, reason: '2 links point at these bytes', evidence: { otherLinks: ['/mnt/d/Heat.mkv'] } }],
    error: null, isAlternateVersion: false,
  }],
  ...over,
})

const action = (id: string, seq: number, status: string, over: Record<string, unknown> = {}) => ({
  id, seq, type: 'delete-media', status, payload: { targetPath: `/movies/${id}.mkv` }, guardVerdicts: [], error: null,
  isAlternateVersion: false, ...over,
})

/** A finished run as GET /api/plans/:id reports it: every action in a final status. */
const finished = (statuses: string[], status = 'completed') => plan({
  status, progress: { total: statuses.length, finished: statuses.length },
  actions: statuses.map((s, i) => action(`a${i + 1}`, i, s)),
})

// Since Plan 7, POST /execute answers 202 and the run continues in the background: the screen
// learns the outcome by GETting the plan (immediately, then every 2 s while it is running).
const api = (over = {}) => ({
  createPlan: vi.fn(async () => plan()),
  getPlan: vi.fn(async () => plan()),
  approvePlan: vi.fn(async () => plan({ status: 'approved' })),
  executePlan: vi.fn(async () => ({ planId: 'p1', status: 'running' })),
  ...over,
} as never)

const privateRatioBlock = { guard: 'guard.private-ratio', outcome: 'block', overridable: true, reason: 'ratio 0.20 is below 1 and 2 days is below 14', evidence: {} }

// Annotated (rather than left to plain inference) purely so this compiles under this project's
// strict tsconfig: an unannotated object literal widens `type` to `string`, which `RequestedAction`
// (a discriminated-by-literal union) then rejects. The VALUES are exactly what the brief specifies.
const queued: RequestedAction[] = [{ type: 'delete-media', targetPath: '/mnt/m/Heat.mkv' }]

describe('PlanScreen', () => {
  it('builds a plan from the queue and shows the dry-run totals', async () => {
    const createPlan = vi.fn(async () => plan())
    render(<PlanScreen api={api({ createPlan })} queued={queued} onClear={() => {}} planId={null} onPlanIdChange={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /build plan/i }))
    expect(createPlan).toHaveBeenCalledWith(queued)
    expect(await screen.findByText('3.0 GB')).toBeInTheDocument()
    expect(await screen.findByText(/1 torrent/i)).toBeInTheDocument()
  })

  it('shows each action with its guard verdicts', async () => {
    render(<PlanScreen api={api()} queued={queued} onClear={() => {}} planId={null} onPlanIdChange={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /build plan/i }))
    expect(await screen.findByText(/2 links point at these bytes/)).toBeInTheDocument()
  })

  it('will not offer execute before approval', async () => {
    render(<PlanScreen api={api()} queued={queued} onClear={() => {}} planId={null} onPlanIdChange={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /build plan/i }))
    expect(screen.queryByRole('button', { name: /^execute/i })).not.toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /approve/i })).toBeInTheDocument()
  })

  it('offers execute once approved, and reports the outcome', async () => {
    render(<PlanScreen api={api({ getPlan: vi.fn(async () => finished(['done', 'done'])) })} queued={queued} onClear={() => {}} planId={null} onPlanIdChange={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /build plan/i }))
    await userEvent.click(await screen.findByRole('button', { name: /approve/i }))
    await userEvent.click(await screen.findByRole('button', { name: /^execute/i }))
    expect(await screen.findByText(/2 done/i)).toBeInTheDocument()
  })

  // Server truth (verified against src/plan/planner.ts): `approvePlan` is a synchronous status
  // flip with no I/O — it never re-runs guards against live state. The ONLY re-check happens once,
  // immediately before each action executes. A caution claiming approval itself refreshes anything
  // would overstate the safety this screen actually has, so this locks in the honest wording.
  it('never claims that approving a plan re-checks guards against live state', async () => {
    render(<PlanScreen api={api()} queued={queued} onClear={() => {}} planId={null} onPlanIdChange={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /build plan/i }))
    expect(await screen.findByText(/approving does not refresh/i)).toBeInTheDocument()
    expect(screen.queryByText(/re-checked.*at approval/i)).not.toBeInTheDocument()
  })

  it('marks blocked actions and explains why', async () => {
    render(<PlanScreen api={api({
      createPlan: async () => plan({
        dryRun: { deleteCount: 1, bytesFreed: 0, torrentsRemoved: 0, blockedCount: 1 },
        actions: [{
          id: 'a1', seq: 0, type: 'delete-media', status: 'blocked',
          payload: { targetPath: '/mnt/m/Heat.mkv' },
          guardVerdicts: [{ guard: 'guard.protected', outcome: 'block', overridable: false, reason: 'state downloading', evidence: {} }],
          error: null,
        }],
      }),
    })} queued={queued} onClear={() => {}} planId={null} onPlanIdChange={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /build plan/i }))
    expect(await screen.findByText(/blocked/i)).toBeInTheDocument()
    expect(await screen.findByText(/state downloading/)).toBeInTheDocument()
  })

  it('rebuilds the plan when an overridable guard is overridden', async () => {
    const createPlan = vi.fn(async () => plan({
      actions: [{
        id: 'a1', seq: 0, type: 'delete-media', status: 'blocked',
        payload: { targetPath: '/mnt/m/Heat.mkv' },
        guardVerdicts: [{ guard: 'guard.private-ratio', outcome: 'block', overridable: true, reason: 'ratio below 1', evidence: {} }],
        error: null,
      }],
    }))
    render(<PlanScreen api={api({ createPlan })} queued={queued} onClear={() => {}} planId={null} onPlanIdChange={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /build plan/i }))
    await userEvent.click(await screen.findByRole('checkbox', { name: /override/i }))
    await userEvent.click(screen.getByRole('button', { name: /rebuild/i }))
    expect(createPlan).toHaveBeenLastCalledWith([
      { type: 'delete-media', targetPath: '/mnt/m/Heat.mkv', overrides: ['guard.private-ratio'] },
    ])
  })

  it('shows an empty state when nothing is queued', () => {
    render(<PlanScreen api={api()} queued={[]} onClear={() => {}} planId={null} onPlanIdChange={() => {}} />)
    expect(screen.getByText(/nothing queued/i)).toBeInTheDocument()
  })

  // Definition-of-done check named explicitly in the task brief: a hostile filename must render as
  // literal text everywhere it appears, on this screen included, and never be interpreted as markup.
  it('renders a hostile file name as text only, on the queue list and on a built plan', async () => {
    const hostile = '/mnt/m/<img src=x onerror=alert(1)>.mkv'
    const { rerender } = render(
      <PlanScreen api={api()} queued={[{ type: 'delete-media', targetPath: hostile }]} onClear={() => {}} planId={null} onPlanIdChange={() => {}} />,
    )
    expect(screen.getByText(hostile, { exact: false })).toBeInTheDocument()
    expect(document.querySelector('img')).toBeNull()

    const hostilePlan = plan({
      actions: [{
        id: 'a1', seq: 0, type: 'delete-media', status: 'pending',
        payload: { targetPath: hostile }, guardVerdicts: [], error: null,
      }],
    })
    rerender(
      <PlanScreen
        api={api({ createPlan: async () => hostilePlan })}
        queued={[{ type: 'delete-media', targetPath: hostile }]}
        onClear={() => {}} planId={null} onPlanIdChange={() => {}}
      />,
    )
    await userEvent.click(await screen.findByRole('button', { name: /build plan/i }))
    expect(await screen.findByText(hostile)).toBeInTheDocument()
    expect(document.querySelector('img')).toBeNull()
  })

  // --- CRITICAL 1: an executed (or approved) plan must survive a screen-boundary round trip -----
  // `plan`/`summary` used to live ONLY in this component's own state, so switching nav tabs (which
  // unmounts this screen — see App.tsx) threw both away. `planId` is now lifted to App beside
  // `queued`, and this screen must load whatever plan that id names on mount rather than starting
  // from the empty "nothing queued" state and inviting a second, redundant createPlan.
  it('loads a plan by id on mount, so navigating back to Plan does not re-arm it as unplanned work', async () => {
    const getPlan = vi.fn(async () => plan({ status: 'approved' }))
    const createPlan = vi.fn()
    render(<PlanScreen api={api({ getPlan, createPlan })} queued={[]} onClear={() => {}} planId="p1" onPlanIdChange={() => {}} />)
    expect(await screen.findByRole('button', { name: /^execute/i })).toBeInTheDocument()
    expect(getPlan).toHaveBeenCalledWith('p1')
    expect(screen.queryByText(/not yet planned/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /build plan/i })).not.toBeInTheDocument()
    expect(createPlan).not.toHaveBeenCalled()
  })

  it('lifts the freshly built plan id to the parent and clears the queue once createPlan resolves', async () => {
    const onPlanIdChange = vi.fn()
    const onClear = vi.fn()
    render(<PlanScreen api={api()} queued={queued} onClear={onClear} planId={null} onPlanIdChange={onPlanIdChange} />)
    await userEvent.click(await screen.findByRole('button', { name: /build plan/i }))
    await screen.findByText('3.0 GB')
    expect(onPlanIdChange).toHaveBeenCalledWith('p1')
    expect(onClear).toHaveBeenCalled()
  })

  // --- MINOR 5: a plan's own status vocabulary must not be read through the action-status mapper -
  it('renders an approved PLAN status with the warn tag, not the quiet tag the action-status mapper would give it', async () => {
    render(<PlanScreen api={api({ approvePlan: async () => plan({ status: 'approved' }) })} queued={queued} onClear={() => {}} planId={null} onPlanIdChange={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /build plan/i }))
    await userEvent.click(await screen.findByRole('button', { name: /approve/i }))
    const statusTag = await screen.findByText('approved')
    expect(statusTag.className).toContain('tag-warn')
    expect(statusTag.className).not.toContain('tag-quiet')
  })

  // --- MINOR 6: "Execution completed" must not headline a run that did nothing --------------------
  it('does not headline an all-blocked execution as an ordinary "completed" pass', async () => {
    const getPlan = vi.fn(async () => finished(['blocked', 'blocked', 'blocked']))
    render(<PlanScreen api={api({ getPlan })} queued={queued} onClear={() => {}} planId={null} onPlanIdChange={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /build plan/i }))
    await userEvent.click(await screen.findByRole('button', { name: /approve/i }))
    await userEvent.click(await screen.findByRole('button', { name: /^execute/i }))
    const summaryLine = await screen.findByText(/0 done/i)
    expect(summaryLine.closest('.alert-warn')).not.toBeNull()
  })

  it('still uses the plain, quiet treatment for a summary where real work actually happened', async () => {
    render(<PlanScreen api={api({ getPlan: vi.fn(async () => finished(['done', 'done'])) })} queued={queued} onClear={() => {}} planId={null} onPlanIdChange={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /build plan/i }))
    await userEvent.click(await screen.findByRole('button', { name: /approve/i }))
    await userEvent.click(await screen.findByRole('button', { name: /^execute/i }))
    const summaryLine = await screen.findByText(/2 done/i)
    expect(summaryLine.closest('.alert-warn')).toBeNull()
  })

  // --- MAJOR 4: the approval screen must disclose the executor's full order of operations ---------
  // Plan 7's executor (C11): live guard re-check -> *arr unmonitor -> qBittorrent delete-with-data
  // on the owning instance -> wait for the file to go, then remove what is left (trashed or
  // unlinked) -> sweep of now-empty parent directories -> ONE Jellyfin notification of the deleted
  // paths after the last action. Jellyfin is never asked to delete anything.
  it('discloses every step the executor actually performs, not just *arr-unmonitor and torrent removal', async () => {
    const { container } = render(<PlanScreen api={api()} queued={queued} onClear={() => {}} planId={null} onPlanIdChange={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /build plan/i }))
    const note = container.querySelector<HTMLElement>('.plan-note')
    if (!note) throw new Error('no .plan-note rendered')
    expect(within(note).getByText(/unmonitor/i)).toBeInTheDocument()
    expect(within(note).getByText(/with its data/i)).toBeInTheDocument()
    expect(within(note).getByText(/sweep/i)).toBeInTheDocument()
    expect(within(note).getByText(/hardlink/i)).toBeInTheDocument()
    expect(within(note).getByText(/jellyfin/i)).toBeInTheDocument()
    expect(within(note).getByText(/trash/i)).toBeInTheDocument()
  })

  // --- TEST HONESTY M6 --------------------------------------------------------------------------
  // The requirement (spec + executor.ts's own doc comment) is that an *arr-managed title is only
  // ever UNMONITORED by a delete, never deleted from Radarr/Sonarr itself. A mutant that inverts
  // this sentence to "also deletes it from Radarr/Sonarr" must fail this test, not just any test
  // that greps for the word "Radarr" — pin the MEANING.
  it('states plainly that a delete only ever unmonitors *arr, never deletes the record — pinning the meaning', async () => {
    render(<PlanScreen api={api()} queued={queued} onClear={() => {}} planId={null} onPlanIdChange={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /build plan/i }))
    expect(await screen.findByText(/never deleted, only unmonitored/i)).toBeInTheDocument()
    expect(screen.queryByText(/also deletes it from radarr\/sonarr/i)).not.toBeInTheDocument()
  })

  // --- TEST HONESTY M7 --------------------------------------------------------------------------
  // `directoriesSwept` is `undefined`, not absent-as-zero, for a plan persisted before the field
  // existed (see PlanDryRun's own doc comment in api.ts). The guard at the render site must never
  // be allowed to degrade into rendering the literal string "undefined".
  it('never renders a literal "undefined" directories-swept figure for a plan that never computed one', async () => {
    const createPlan = vi.fn(async () => plan({
      dryRun: { deleteCount: 1, bytesFreed: 0, torrentsRemoved: 0, blockedCount: 0 },
    }))
    const { container } = render(<PlanScreen api={api({ createPlan })} queued={queued} onClear={() => {}} planId={null} onPlanIdChange={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /build plan/i }))
    await screen.findByText('2 links point at these bytes')
    // Scoped to the dry-run figures, not the whole page: the disclosure text above legitimately
    // names "Directories swept" in prose regardless of whether a figure for it exists.
    const dryRun = container.querySelector<HTMLElement>('.plan-dry-run')
    if (!dryRun) throw new Error('no .plan-dry-run rendered')
    expect(within(dryRun).queryByText(/directories swept/i)).not.toBeInTheDocument()
    expect(within(dryRun).queryByText(/undefined/i)).not.toBeInTheDocument()
  })

  // --- MAJOR (regression): a terminal plan must not be a dead end once something new is queued ---
  // Journey: execute plan p1 (terminal, `completed`) -> navigate to another screen and queue a
  // DIFFERENT action -> navigate back to Plan. `planId` (lifted to App) still names p1, so this
  // mount loads it via getPlan on mount exactly like the CRITICAL-1 test above, but `queued` is no
  // longer empty. The old `{!plan ? <queue panel> : null}` rendering made the freshly queued action
  // invisible and unbuildable the moment ANY plan — including a finished one with nothing left to
  // do — was in view, with no control anywhere on the screen to get out of it short of a full page
  // reload. A terminal plan must not block the queue panel from rendering.
  it('shows the queue panel and a Build plan button for a newly queued action even though a completed plan is already in view', async () => {
    const getPlan = vi.fn(async () => plan({ status: 'completed' }))
    const createPlan = vi.fn(async () => plan({ id: 'p2', status: 'draft' }))
    const freshlyQueued: RequestedAction[] = [{ type: 'delete-junk-file', targetPath: '/mnt/m/Other.nfo' }]
    render(
      <PlanScreen
        api={api({ getPlan, createPlan })}
        queued={freshlyQueued}
        onClear={() => {}}
        planId="p1"
        onPlanIdChange={() => {}}
      />,
    )
    // The completed plan from before is still shown, not silently dropped.
    expect(await screen.findByText('p1')).toBeInTheDocument()
    expect(screen.getByText('completed')).toBeInTheDocument()
    // The newly queued action — for a DIFFERENT file — must actually be visible...
    expect(await screen.findByText('/mnt/m/Other.nfo')).toBeInTheDocument()
    // ...and buildable, not stranded with no controls anywhere on the screen.
    await userEvent.click(await screen.findByRole('button', { name: /build plan/i }))
    expect(createPlan).toHaveBeenCalledWith(freshlyQueued)
  })

  it('renders the directories-swept figure when the plan actually computed one', async () => {
    const createPlan = vi.fn(async () => plan({
      dryRun: { deleteCount: 1, bytesFreed: 0, torrentsRemoved: 0, blockedCount: 0, directoriesSwept: 2 },
    }))
    const { container } = render(<PlanScreen api={api({ createPlan })} queued={queued} onClear={() => {}} planId={null} onPlanIdChange={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /build plan/i }))
    await screen.findByText('2 links point at these bytes')
    const dryRun = container.querySelector<HTMLElement>('.plan-dry-run')
    if (!dryRun) throw new Error('no .plan-dry-run rendered')
    expect(within(dryRun).getByText(/directories swept/i)).toBeInTheDocument()
    expect(within(dryRun).getByText('2')).toBeInTheDocument()
  })
})

// --- Plan 7: background execution, bulk overrides, what each delete takes with it ---------------
describe('PlanScreen (real stack)', () => {
  it('shows the Jellyfin one-minute note', async () => {
    render(<PlanScreen api={api()} queued={queued} onClear={() => {}} planId={null} onPlanIdChange={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /build plan/i }))
    expect(await screen.findByText(/Jellyfin drops deleted items within about a minute\./)).toBeInTheDocument()
  })

  it('never claims Jellyfin is asked to delete or refresh anything', async () => {
    const { container } = render(<PlanScreen api={api()} queued={queued} onClear={() => {}} planId={null} onPlanIdChange={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /build plan/i }))
    await screen.findByText(/Jellyfin drops deleted items/)
    const note = container.querySelector<HTMLElement>('.plan-note')!
    expect(note).toHaveTextContent(/never asks Jellyfin to delete/i)
    expect(note).not.toHaveTextContent(/library refresh/i)
    expect(note).not.toHaveTextContent(/remove the item from Jellyfin/i)
  })

  it('execute polls until completed and shows progress', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      const running = (done: number) => plan({
        status: 'running', progress: { total: 3, finished: done },
        actions: [0, 1, 2].map((i) => action(`a${i + 1}`, i, i < done ? 'done' : 'pending')),
      })
      const getPlan = vi.fn()
        .mockResolvedValueOnce(running(0)) // straight after the 202
        .mockResolvedValueOnce(running(2)) // the first 2 s poll
        .mockResolvedValue(finished(['done', 'done', 'done'])) // the next poll, and anything after
      const executePlan = vi.fn(async () => ({ planId: 'p1', status: 'running' as const }))
      render(<PlanScreen api={api({ getPlan, executePlan })} queued={queued} onClear={() => {}} planId={null} onPlanIdChange={() => {}} />)
      await user.click(await screen.findByRole('button', { name: /build plan/i }))
      await user.click(await screen.findByRole('button', { name: /approve/i }))
      await user.click(await screen.findByRole('button', { name: /^execute/i }))

      expect(executePlan).toHaveBeenCalledWith('p1')
      const bar = await screen.findByRole('progressbar', { name: /execution progress/i })
      expect(bar).toHaveAttribute('max', '3')
      expect(bar).toHaveAttribute('value', '0')
      expect(screen.getByText(/0 of 3 actions finished/i)).toBeInTheDocument()
      expect(getPlan).toHaveBeenCalledTimes(1)

      // Nothing more until two seconds have passed…
      await act(async () => { await vi.advanceTimersByTimeAsync(1_500) })
      expect(getPlan).toHaveBeenCalledTimes(1)
      // …then one poll, which moves the bar.
      await act(async () => { await vi.advanceTimersByTimeAsync(500) })
      expect(getPlan).toHaveBeenCalledTimes(2)
      expect(await screen.findByText(/2 of 3 actions finished/i)).toBeInTheDocument()
      expect(screen.getByRole('progressbar', { name: /execution progress/i })).toHaveAttribute('value', '2')

      await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
      expect(getPlan).toHaveBeenCalledTimes(3)
      expect(await screen.findByText(/3 done/i)).toBeInTheDocument()
      expect(screen.getByText('completed')).toBeInTheDocument()

      // A finished plan is never polled again.
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
      expect(getPlan).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps polling through a failed poll instead of freezing on stale progress', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const getPlan = vi.fn()
        .mockResolvedValueOnce(plan({ status: 'running', progress: { total: 2, finished: 1 }, actions: [action('a1', 0, 'done'), action('a2', 1, 'pending')] }))
        .mockRejectedValueOnce(new Error('network blip'))
        .mockResolvedValue(finished(['done', 'done']))
      render(<PlanScreen api={api({ getPlan })} queued={[]} onClear={() => {}} planId="p1" onPlanIdChange={() => {}} />)
      expect(await screen.findByText(/1 of 2 actions finished/i)).toBeInTheDocument()
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
      expect(await screen.findByText(/network blip/)).toBeInTheDocument()
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
      expect(await screen.findByText(/2 done/i)).toBeInTheDocument()
      expect(screen.queryByText(/network blip/)).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows why a background run failed', async () => {
    render(<PlanScreen
      api={api({ getPlan: vi.fn(async () => ({ ...finished(['done', 'failed'], 'failed'), error: 'qBittorrent box-b refused the delete' })) })}
      queued={[]} onClear={() => {}} planId="p1" onPlanIdChange={() => {}}
    />)
    expect(await screen.findByText(/qBittorrent box-b refused the delete/)).toBeInTheDocument()
    expect(screen.getByText(/1 failed/i)).toBeInTheDocument()
  })

  it('plan screen override-all for a guard sets every blocked row and rebuild keeps them', async () => {
    const blocked = (id: string, seq: number, overrides?: string[]) => action(id, seq, overrides ? 'pending' : 'blocked', {
      payload: { targetPath: `/movies/${id.slice(1)}.mkv`, ...(overrides ? { overrides } : {}) },
      guardVerdicts: [privateRatioBlock],
    })
    const createPlan = vi.fn()
      .mockResolvedValueOnce(plan({ actions: [blocked('a1', 0), blocked('a2', 1), action('a3', 2, 'pending', { payload: { targetPath: '/movies/3.mkv' } })] }))
      // What the planner returns for the rebuild: new action ids, the overrides carried in each payload.
      .mockResolvedValue(plan({ id: 'p2', actions: [
        blocked('b1', 0, ['guard.private-ratio']), blocked('b2', 1, ['guard.private-ratio']),
        action('b3', 2, 'pending', { payload: { targetPath: '/movies/3.mkv' } }),
      ] }))
    render(<PlanScreen api={api({ createPlan })} queued={queued} onClear={() => {}} planId={null} onPlanIdChange={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /build plan/i }))

    await userEvent.click(await screen.findByRole('button', { name: /override guard\.private-ratio for all 2 blocked rows/i }))
    const dialog = await screen.findByRole('alertdialog', { name: /override guard\.private-ratio/i })
    // Nothing is ticked until the operator confirms.
    for (const box of screen.getAllByRole('checkbox', { name: /override/i })) expect(box).not.toBeChecked()
    await userEvent.click(within(dialog).getByRole('button', { name: /^override all$/i }))
    const boxes = screen.getAllByRole('checkbox', { name: /override/i })
    expect(boxes).toHaveLength(2)
    for (const box of boxes) expect(box).toBeChecked()

    await userEvent.click(screen.getByRole('button', { name: /rebuild/i }))
    expect(createPlan).toHaveBeenLastCalledWith([
      { type: 'delete-media', targetPath: '/movies/1.mkv', overrides: ['guard.private-ratio'] },
      { type: 'delete-media', targetPath: '/movies/2.mkv', overrides: ['guard.private-ratio'] },
      { type: 'delete-media', targetPath: '/movies/3.mkv' },
    ])
    await screen.findByText('p2')
    // The rebuilt plan still carries them: still ticked, and a second rebuild sends them again.
    for (const box of screen.getAllByRole('checkbox', { name: /override/i })) expect(box).toBeChecked()
    await userEvent.click(screen.getByRole('button', { name: /rebuild/i }))
    expect(createPlan).toHaveBeenCalledTimes(3)
    expect(createPlan).toHaveBeenLastCalledWith([
      { type: 'delete-media', targetPath: '/movies/1.mkv', overrides: ['guard.private-ratio'] },
      { type: 'delete-media', targetPath: '/movies/2.mkv', overrides: ['guard.private-ratio'] },
      { type: 'delete-media', targetPath: '/movies/3.mkv' },
    ])
  })

  // Final review m5: the two guards whose override deletes more than the row seems to say get words of
  // their own in the bulk confirmation; the rest keep the generic text.
  describe('the override-all confirmation says what the override deletes', () => {
    const untrackedBlock = {
      guard: 'guard.untracked', outcome: 'block', overridable: true,
      reason: 'no torrent on box-a owns it, so only a raw unlink would remove it', evidence: {},
    }
    const scopeBlock = {
      guard: 'guard.torrent-scope', outcome: 'block', overridable: true,
      reason: 'removing Show.S01 would also delete 9 media file(s) this plan does not name', evidence: {},
    }
    async function confirmFor(guardVerdicts: unknown[], count: number, guard: string) {
      render(<PlanScreen api={api({
        createPlan: vi.fn(async () => plan({
          actions: Array.from({ length: count }, (_, i) => action(`a${i + 1}`, i, 'blocked', { guardVerdicts })),
        })),
      })} queued={queued} onClear={() => {}} planId={null} onPlanIdChange={() => {}} />)
      await userEvent.click(await screen.findByRole('button', { name: /build plan/i }))
      const name = new RegExp(`override ${guard.replace('.', '\\.')} for all ${count} blocked rows?`, 'i')
      await userEvent.click(await screen.findByRole('button', { name }))
      return screen.findByRole('alertdialog')
    }

    it('guard.untracked: that many files no torrent owns will be deleted from disk, only for leftovers not seeding', async () => {
      const dialog = await confirmFor([untrackedBlock], 3, 'guard.untracked')
      expect(dialog).toHaveTextContent('3 files that no torrent owns will be deleted from disk.')
      expect(dialog).toHaveTextContent('Only do this for leftovers you are sure are not seeding.')
      expect(dialog).not.toHaveTextContent(/allowed past guard\.untracked/)
    })

    it('guard.untracked with one row speaks of one file', async () => {
      const dialog = await confirmFor([untrackedBlock], 1, 'guard.untracked')
      expect(dialog).toHaveTextContent('1 file that no torrent owns will be deleted from disk.')
    })

    it('guard.torrent-scope: the other files in those torrents will be deleted too', async () => {
      const dialog = await confirmFor([scopeBlock], 2, 'guard.torrent-scope')
      expect(dialog).toHaveTextContent(/the other files in those torrents will be deleted too/i)
      expect(dialog).toHaveTextContent(/files this plan does not name/i)
      expect(dialog).not.toHaveTextContent(/allowed past guard\.torrent-scope/)
    })

    it('any other guard keeps the generic text', async () => {
      const dialog = await confirmFor([privateRatioBlock], 2, 'guard.private-ratio')
      expect(dialog).toHaveTextContent(/each of these 2 actions will be allowed past guard\.private-ratio/i)
      expect(dialog).not.toHaveTextContent(/deleted from disk/)
    })
  })

  it('cancelling an override-all ticks nothing', async () => {
    render(<PlanScreen api={api({
      createPlan: vi.fn(async () => plan({ actions: [action('a1', 0, 'blocked', { guardVerdicts: [privateRatioBlock] })] })),
    })} queued={queued} onClear={() => {}} planId={null} onPlanIdChange={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /build plan/i }))
    await userEvent.click(await screen.findByRole('button', { name: /override guard\.private-ratio for all 1 blocked row/i }))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /^cancel$/i }))
    expect(screen.getByRole('checkbox', { name: /override/i })).not.toBeChecked()
  })

  it('offers no override-all for a guard that cannot be overridden', async () => {
    render(<PlanScreen api={api({
      createPlan: vi.fn(async () => plan({ actions: [action('a1', 0, 'blocked', {
        guardVerdicts: [{ guard: 'guard.protected', outcome: 'block', overridable: false, reason: 'state downloading', evidence: {} }],
      })] })),
    })} queued={queued} onClear={() => {}} planId={null} onPlanIdChange={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /build plan/i }))
    await screen.findByText(/state downloading/)
    expect(screen.queryByRole('button', { name: /override guard\.protected/i })).not.toBeInTheDocument()
  })

  it('offers override checkboxes only while the plan is a draft, and shows a carried override as fact afterwards', async () => {
    const overridden = action('a1', 0, 'pending', {
      payload: { targetPath: '/movies/1.mkv', overrides: ['guard.private-ratio'] },
      guardVerdicts: [privateRatioBlock],
    })
    render(<PlanScreen
      api={api({ getPlan: vi.fn(async () => plan({ status: 'approved', actions: [overridden] })) })}
      queued={[]} onClear={() => {}} planId="p1" onPlanIdChange={() => {}}
    />)
    await screen.findByRole('button', { name: /^execute/i })
    // Nothing on an approved plan can change its overrides any more, so no control pretends to.
    expect(screen.queryByRole('checkbox', { name: /override/i })).not.toBeInTheDocument()
    expect(screen.getByText('overridden')).toBeInTheDocument()
  })

  // Overrides only reach the server on a rebuild. So Approve must not approve a plan that differs
  // from what the screen shows ticked, and once approved the rows must show the overrides the
  // plan STORES (what the executor honours), never this screen's leftover ticks.
  it('A: an override ticked but not rebuilt blocks Approve, and an approved plan never shows it as overridden', async () => {
    const built = plan({ actions: [
      action('a1', 0, 'blocked', { guardVerdicts: [privateRatioBlock] }),
      action('a2', 1, 'pending'),
    ] })
    // The server approved what was BUILT: no stored override, the row still blocked.
    const approved = plan({ status: 'approved', actions: [
      action('a1', 0, 'blocked', { guardVerdicts: [privateRatioBlock] }),
      action('a2', 1, 'pending'),
    ] })
    let resolveApprove: (p: unknown) => void = () => {}
    const approvePlan = vi.fn(() => new Promise((r) => { resolveApprove = r }))
    render(<PlanScreen api={api({ createPlan: vi.fn(async () => built), getPlan: vi.fn(async () => approved), approvePlan })}
      queued={queued} onClear={() => {}} planId={null} onPlanIdChange={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /build plan/i }))

    await userEvent.click(await screen.findByRole('button', { name: /override guard\.private-ratio for all 1 blocked row/i }))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /^override all$/i }))
    expect(screen.getByRole('checkbox', { name: /override/i })).toBeChecked()
    // Ticked, not rebuilt: approving now would approve a plan without the override the screen shows.
    expect(screen.getByRole('button', { name: /^approve$/i })).toBeDisabled()
    expect(screen.getByText(/rebuild to apply/i)).toBeInTheDocument()

    // Back in step with the built plan: Approve is offered again and the note goes.
    await userEvent.click(screen.getByRole('checkbox', { name: /override/i }))
    expect(screen.getByRole('button', { name: /^approve$/i })).toBeEnabled()
    expect(screen.queryByText(/rebuild to apply/i)).not.toBeInTheDocument()

    // Ticked again while the approval is in flight: the approved plan carries no override.
    await userEvent.click(screen.getByRole('button', { name: /^approve$/i }))
    await userEvent.click(screen.getByRole('checkbox', { name: /override/i }))
    await act(async () => { resolveApprove(approved) })
    await screen.findByRole('button', { name: /^execute/i })
    expect(approvePlan).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('overridden')).not.toBeInTheDocument()
    expect(screen.getAllByText('blocked').length).toBeGreaterThan(0)
  })

  it('B: an override the built plan carries is shown as overridden once approved, even if unticked on screen', async () => {
    const carried = (status: string) => action('a1', 0, status, {
      payload: { targetPath: '/movies/1.mkv', overrides: ['guard.private-ratio'] },
      guardVerdicts: [privateRatioBlock],
    })
    const built = plan({ actions: [carried('pending')] })
    const approved = plan({ status: 'approved', actions: [carried('pending')] })
    let resolveApprove: (p: unknown) => void = () => {}
    const approvePlan = vi.fn(() => new Promise((r) => { resolveApprove = r }))
    render(<PlanScreen api={api({ createPlan: vi.fn(async () => built), getPlan: vi.fn(async () => approved), approvePlan })}
      queued={queued} onClear={() => {}} planId={null} onPlanIdChange={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /build plan/i }))

    const box = await screen.findByRole('checkbox', { name: /override/i })
    expect(box).toBeChecked()
    // Unticked, not rebuilt: the built plan still carries the override, so approving it now would
    // approve an override the screen says is off.
    await userEvent.click(box)
    expect(screen.getByRole('button', { name: /^approve$/i })).toBeDisabled()
    expect(screen.getByText(/rebuild to apply/i)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('checkbox', { name: /override/i }))
    expect(screen.getByRole('button', { name: /^approve$/i })).toBeEnabled()

    // Unticked while the approval is in flight: the approved plan still carries the override, and
    // the executor will honour it — the approval screen must say so.
    await userEvent.click(screen.getByRole('button', { name: /^approve$/i }))
    await userEvent.click(screen.getByRole('checkbox', { name: /override/i }))
    await act(async () => { resolveApprove(approved) })
    await screen.findByRole('button', { name: /^execute/i })
    expect(approvePlan).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('checkbox', { name: /override/i })).not.toBeInTheDocument()
    expect(screen.getByText('overridden')).toBeInTheDocument()
  })

  it('shows droppedOverrides', async () => {
    render(<PlanScreen api={api({
      createPlan: vi.fn(async () => plan({
        actions: [action('a1', 0, 'pending', { payload: { targetPath: '/movies/Heat.mkv' } })],
        droppedOverrides: [{ seq: 0, guard: 'guard.private-ratio' }],
      })),
    })} queued={queued} onClear={() => {}} planId={null} onPlanIdChange={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /build plan/i }))
    const notice = (await screen.findByText(/no longer blocks/i)).closest<HTMLElement>('.alert')!
    expect(notice).toHaveTextContent('guard.private-ratio')
    expect(notice).toHaveTextContent('/movies/Heat.mkv')
  })

  it("shows each action's torrents with box, name, ratio, seed days and companion count", async () => {
    const match = (over: Record<string, unknown>) => ({
      instanceId: 'box-b', hash: 'h', name: 'Nosferatu.1922.1080p', category: null, tags: [], state: 'stalledUP',
      ratio: 0.5, seedingTimeSeconds: 3 * 86_400, isPrivate: true, trackerHost: 'tracker.example', sizeBytes: 1,
      matchedBy: 'file', files: null, companionCount: 3, ...over,
    })
    render(<PlanScreen api={api({
      createPlan: vi.fn(async () => plan({ actions: [action('a1', 0, 'pending', { payload: {
        targetPath: '/movies/Nosferatu (1922)/Nosferatu.mkv',
        resolution: { torrents: [match({}), match({ instanceId: 'box-a', name: 'Nosferatu.cross-seed', ratio: 2.345, seedingTimeSeconds: 40 * 86_400, companionCount: null })] },
      } })] })),
    })} queued={queued} onClear={() => {}} planId={null} onPlanIdChange={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /build plan/i }))
    const first = (await screen.findByText('Nosferatu.1922.1080p')).closest('li')!
    expect(within(first).getByText('box-b')).toBeInTheDocument()
    expect(within(first).getByText('ratio 0.50')).toBeInTheDocument()
    expect(within(first).getByText(/3\.0 days/)).toBeInTheDocument()
    expect(within(first).getByText(/3 companion files/)).toBeInTheDocument()
    const second = screen.getByText('Nosferatu.cross-seed').closest('li')!
    expect(within(second).getByText('box-a')).toBeInTheDocument()
    expect(within(second).getByText('ratio 2.35')).toBeInTheDocument()
    expect(within(second).getByText(/40\.0 days/)).toBeInTheDocument()
    // Unknown is unknown — never rendered as "0 companion files".
    expect(within(second).getByText(/companion files unknown/i)).toBeInTheDocument()
  })

  it('shows companion files and what each box gives up in the dry run', async () => {
    const { container } = render(<PlanScreen api={api({
      createPlan: vi.fn(async () => plan({ dryRun: {
        deleteCount: 2, bytesFreed: 2, torrentsRemoved: 2, blockedCount: 0, companionFiles: 5,
        byInstance: { 'box-a': { torrents: 1, bytes: 1_073_741_824 }, 'box-b': { torrents: 1, bytes: 2_147_483_648 } },
      } })),
    })} queued={queued} onClear={() => {}} planId={null} onPlanIdChange={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /build plan/i }))
    const dryRun = await waitForElement(container, '.plan-dry-run')
    expect(within(dryRun).getByText(/companion files/i).closest('div')).toHaveTextContent('5')
    expect(within(dryRun).getByText('box-a').closest('div')).toHaveTextContent(/1 torrent.*1\.0 GB/)
    expect(within(dryRun).getByText('box-b').closest('div')).toHaveTextContent(/1 torrent.*2\.0 GB/)
  })

  it('explains a 412 verification refusal and points to Settings', async () => {
    const createPlan = vi.fn(async () => { throw new ApiError(412, 'the path mappings changed since they were last verified', { error: 'verification', reason: 'the path mappings changed since they were last verified' }) })
    render(<PlanScreen api={api({ createPlan })} queued={queued} onClear={() => {}} planId={null} onPlanIdChange={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /build plan/i }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/changed since they were last verified/)
    expect(alert).toHaveTextContent(/verify.*settings/i)
  })
})

async function waitForElement(container: HTMLElement, selector: string): Promise<HTMLElement> {
  await screen.findByText(/deletes planned/i)
  const el = container.querySelector<HTMLElement>(selector)
  if (!el) throw new Error(`no ${selector} rendered`)
  return el
}
