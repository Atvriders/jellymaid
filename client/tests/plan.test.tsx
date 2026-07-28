import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
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
    render(<PlanScreen api={api({ createPlan })} queued={queued} onClear={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /build plan/i }))
    expect(createPlan).toHaveBeenCalledWith(queued)
    expect(await screen.findByText('3.0 GB')).toBeInTheDocument()
    expect(await screen.findByText(/1 torrent/i)).toBeInTheDocument()
  })

  it('shows each action with its guard verdicts', async () => {
    render(<PlanScreen api={api()} queued={queued} onClear={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /build plan/i }))
    expect(await screen.findByText(/2 links point at these bytes/)).toBeInTheDocument()
  })

  it('will not offer execute before approval', async () => {
    render(<PlanScreen api={api()} queued={queued} onClear={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /build plan/i }))
    expect(screen.queryByRole('button', { name: /^execute/i })).not.toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /approve/i })).toBeInTheDocument()
  })

  it('offers execute once approved, and reports the outcome', async () => {
    render(<PlanScreen api={api()} queued={queued} onClear={() => {}} />)
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
    render(<PlanScreen api={api()} queued={queued} onClear={() => {}} />)
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
    })} queued={queued} onClear={() => {}} />)
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
    render(<PlanScreen api={api({ createPlan })} queued={queued} onClear={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /build plan/i }))
    await userEvent.click(await screen.findByRole('checkbox', { name: /override/i }))
    await userEvent.click(screen.getByRole('button', { name: /rebuild/i }))
    expect(createPlan).toHaveBeenLastCalledWith([
      { type: 'delete-media', targetPath: '/mnt/m/Heat.mkv', overrides: ['guard.private-ratio'] },
    ])
  })

  it('shows an empty state when nothing is queued', () => {
    render(<PlanScreen api={api()} queued={[]} onClear={() => {}} />)
    expect(screen.getByText(/nothing queued/i)).toBeInTheDocument()
  })

  // Definition-of-done check named explicitly in the task brief: a hostile filename must render as
  // literal text everywhere it appears, on this screen included, and never be interpreted as markup.
  it('renders a hostile file name as text only, on the queue list and on a built plan', async () => {
    const hostile = '/mnt/m/<img src=x onerror=alert(1)>.mkv'
    const { rerender } = render(
      <PlanScreen api={api()} queued={[{ type: 'delete-media', targetPath: hostile }]} onClear={() => {}} />,
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
        onClear={() => {}}
      />,
    )
    await userEvent.click(await screen.findByRole('button', { name: /build plan/i }))
    expect(await screen.findByText(hostile)).toBeInTheDocument()
    expect(document.querySelector('img')).toBeNull()
  })
})
