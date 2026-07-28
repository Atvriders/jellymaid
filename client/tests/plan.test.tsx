import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PlanScreen } from '../src/screens/PlanScreen.js'
import type { RequestedAction } from '../src/api.js'

const plan = (over = {}) => ({
  id: 'p1', status: 'draft', createdBy: 'bob', createdAt: 'T', approvedBy: null,
  dryRun: { deleteCount: 2, bytesFreed: 3_221_225_472, torrentsRemoved: 1, blockedCount: 0 },
  actions: [{
    id: 'a1', seq: 0, type: 'delete-media', status: 'pending',
    payload: { targetPath: '/mnt/m/Heat.mkv' },
    guardVerdicts: [{ guard: 'guard.hardlink', outcome: 'warn', overridable: false, reason: '2 links point at these bytes', evidence: { otherLinks: ['/mnt/d/Heat.mkv'] } }],
    error: null,
  }],
  ...over,
})

const api = (over = {}) => ({
  createPlan: vi.fn(async () => plan()),
  getPlan: vi.fn(async () => plan()),
  approvePlan: vi.fn(async () => plan({ status: 'approved' })),
  executePlan: vi.fn(async () => ({ planId: 'p1', status: 'completed', done: 2, failed: 0, skipped: 0, blocked: 0, bytesFreed: 3_221_225_472 })),
  ...over,
} as never)

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
    render(<PlanScreen api={api()} queued={queued} onClear={() => {}} planId={null} onPlanIdChange={() => {}} />)
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
    const executePlan = vi.fn(async () => ({ planId: 'p1', status: 'completed' as const, done: 0, failed: 0, skipped: 0, blocked: 3, bytesFreed: 0 }))
    render(<PlanScreen api={api({ executePlan })} queued={queued} onClear={() => {}} planId={null} onPlanIdChange={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /build plan/i }))
    await userEvent.click(await screen.findByRole('button', { name: /approve/i }))
    await userEvent.click(await screen.findByRole('button', { name: /^execute/i }))
    const summaryLine = await screen.findByText(/0 done/i)
    expect(summaryLine.closest('.alert-warn')).not.toBeNull()
  })

  it('still uses the plain, quiet treatment for a summary where real work actually happened', async () => {
    render(<PlanScreen api={api()} queued={queued} onClear={() => {}} planId={null} onPlanIdChange={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /build plan/i }))
    await userEvent.click(await screen.findByRole('button', { name: /approve/i }))
    await userEvent.click(await screen.findByRole('button', { name: /^execute/i }))
    const summaryLine = await screen.findByText(/2 done/i)
    expect(summaryLine.closest('.alert-warn')).toBeNull()
  })

  // --- MAJOR 4: the approval screen must disclose the executor's full 5-step order -----------------
  // Verified against the ACTUAL executor (src/plan/executor.ts:69-77): *arr unmonitor -> qBittorrent
  // delete-with-data -> whatever's left of this path's own hardlink (trashed or unlinked) -> sweep
  // of now-empty parent directories -> Jellyfin item removal/refresh + one batched refresh. The old
  // text disclosed only the first two.
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
