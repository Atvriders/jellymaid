import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { History } from '../src/screens/History.js'

const auditEntry = (over: Record<string, unknown> = {}) => ({
  ts: '2026-07-28T00:00:00.000Z', actor: 'bob', actionType: 'delete-media', subject: '/mnt/m/Heat.mkv',
  outcome: 'done', planId: 'p1', afterJson: JSON.stringify({ status: 'done', bytesFreed: 1_073_741_824 }),
  ...over,
})

const planSummary = (over: Record<string, unknown> = {}) => ({
  id: 'p1', createdAt: 'T', createdBy: 'bob', status: 'draft',
  dryRun: { deleteCount: 1, bytesFreed: 0, torrentsRemoved: 0, blockedCount: 0 },
  ...over,
})

const trashEntry = (over: Record<string, unknown> = {}) => ({
  id: 't1', originalPath: '/mnt/m/junk.nfo', sizeBytes: 512, deletedAt: 'T', purgeAfter: 'T2',
  restoredAt: null, planId: 'p1',
  ...over,
})

const api = (over: Record<string, unknown> = {}) => ({
  audit: vi.fn(async () => ({ entries: [auditEntry()] })),
  plans: vi.fn(async () => ({ plans: [planSummary()] })),
  trash: vi.fn(async () => ({ entries: [trashEntry()] })),
  restoreTrash: vi.fn(async () => ({ restored: true })),
  resumePlan: vi.fn(async () => ({ planId: 'p1', status: 'completed', done: 1, failed: 0, skipped: 0, blocked: 0, bytesFreed: 0 })),
  ...over,
} as never)

function section(container: HTMLElement, cls: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(cls)
  if (!el) throw new Error(`no element matched ${cls}`)
  return el
}

describe('History', () => {
  it('shows the audit trail: timestamp, actor, action, subject, outcome', async () => {
    const { container } = render(<History api={api()} onQueue={() => {}} />)
    await screen.findByText('2026-07-28T00:00:00.000Z')
    const auditSection = section(container, '.history-audit')
    expect(within(auditSection).getByText('bob')).toBeInTheDocument()
    expect(within(auditSection).getByText('delete-media')).toBeInTheDocument()
    expect(within(auditSection).getByText('/mnt/m/Heat.mkv')).toBeInTheDocument()
    expect(within(auditSection).getByText('done')).toBeInTheDocument()
  })

  // Server truth: a per-action failure/skip does not mean nothing happened — an action can report
  // a non-'done' outcome while its bytesFreed is genuinely nonzero (e.g. "the file was deleted, but
  // the Jellyfin item could not be removed" reports 'failed' with real bytes freed). History must
  // show that honestly rather than only ever printing bytes for a 'done' row.
  it('shows bytes freed even for an audit entry whose outcome is not "done"', async () => {
    const { container } = render(<History api={api({
      audit: vi.fn(async () => ({
        entries: [auditEntry({
          outcome: 'failed',
          afterJson: JSON.stringify({ status: 'failed', bytesFreed: 1_073_741_824, error: 'jellyfin item could not be removed' }),
        })],
      })),
    })} onQueue={() => {}} />)
    const auditSection = section(container, '.history-audit')
    expect(await within(auditSection).findByText('1.0 GB')).toBeInTheDocument()
  })

  it('lists plans with their status', async () => {
    const { container } = render(<History api={api()} onQueue={() => {}} />)
    const plansSection = section(container, '.history-plans')
    expect(await within(plansSection).findByText('p1')).toBeInTheDocument()
    expect(within(plansSection).getByText('draft')).toBeInTheDocument()
  })

  it('offers Resume only for a plan stuck running, and calls the resume route for that plan', async () => {
    const resumePlan = vi.fn(async () => ({ planId: 'p1', status: 'completed', done: 1, failed: 0, skipped: 0, blocked: 0, bytesFreed: 0 }))
    render(<History api={api({
      plans: vi.fn(async () => ({ plans: [planSummary({ status: 'running' })] })),
      resumePlan,
    })} onQueue={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /resume/i }))
    expect(resumePlan).toHaveBeenCalledWith('p1')
  })

  it('does not offer Resume for a plan that is not stuck running', async () => {
    render(<History api={api()} onQueue={() => {}} />)
    await screen.findByText('draft')
    expect(screen.queryByRole('button', { name: /resume/i })).not.toBeInTheDocument()
  })

  it('lists trash entries with a Restore button, and calls restoreTrash with the trash id', async () => {
    const restoreTrash = vi.fn(async () => ({ restored: true }))
    render(<History api={api({ restoreTrash })} onQueue={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /restore/i }))
    expect(restoreTrash).toHaveBeenCalledWith('t1')
  })

  it('does not offer Restore for a trash entry that was already restored', async () => {
    render(<History api={api({
      trash: vi.fn(async () => ({ entries: [trashEntry({ restoredAt: '2026-07-28T01:00:00.000Z' })] })),
    })} onQueue={() => {}} />)
    await screen.findByText('/mnt/m/junk.nfo')
    expect(screen.queryByRole('button', { name: /restore/i })).not.toBeInTheDocument()
  })

  it('offers Undo merge on a completed merge-versions entry, and queues split-versions for the primary item', async () => {
    const onQueue = vi.fn()
    render(<History api={api({
      audit: vi.fn(async () => ({
        entries: [auditEntry({
          actionType: 'merge-versions', subject: 'g1', outcome: 'done',
          afterJson: JSON.stringify({ mergedItemIds: ['item-a', 'item-b'] }),
        })],
      })),
    })} onQueue={onQueue} />)
    await userEvent.click(await screen.findByRole('button', { name: /undo merge/i }))
    expect(onQueue).toHaveBeenCalledWith([{ type: 'split-versions', itemIds: ['item-a'] }])
  })

  // The executor's OWN merge-versions action (as opposed to the Duplicates screen's direct
  // /api/duplicates/:id/merge shortcut) records the same fact under a different key
  // (`detail.merged`, not `mergedItemIds` — see src/plan/executor.ts's merge-versions case vs
  // src/api/plans.ts's merge route). History must recognise both shapes, not just the one the
  // Duplicates screen happens to produce today.
  it('recognises a merge recorded under the executor’s own "merged" key, not just "mergedItemIds"', async () => {
    const onQueue = vi.fn()
    render(<History api={api({
      audit: vi.fn(async () => ({
        entries: [auditEntry({
          actionType: 'merge-versions', subject: 'item-a', outcome: 'done',
          afterJson: JSON.stringify({ status: 'done', bytesFreed: 0, merged: ['item-a', 'item-b'] }),
        })],
      })),
    })} onQueue={onQueue} />)
    await userEvent.click(await screen.findByRole('button', { name: /undo merge/i }))
    expect(onQueue).toHaveBeenCalledWith([{ type: 'split-versions', itemIds: ['item-a'] }])
  })

  it('does not offer Undo merge on a merge that did not complete', async () => {
    render(<History api={api({
      audit: vi.fn(async () => ({
        entries: [auditEntry({ actionType: 'merge-versions', outcome: 'failed', afterJson: null })],
      })),
    })} onQueue={() => {}} />)
    await screen.findByText('merge-versions')
    expect(screen.queryByRole('button', { name: /undo merge/i })).not.toBeInTheDocument()
  })

  it('does not offer Undo merge on an unrelated action type', async () => {
    render(<History api={api()} onQueue={() => {}} />)
    await screen.findByText('delete-media')
    expect(screen.queryByRole('button', { name: /undo merge/i })).not.toBeInTheDocument()
  })
})
