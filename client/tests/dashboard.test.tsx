import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Dashboard } from '../src/screens/Dashboard.js'
import { ApiError } from '../src/api.js'

const api = (over = {}) => ({
  health: async () => ({ status: 'ok', schemaVersion: 1, connectors: { jellyfin: 'ok' } }),
  scanStatus: async () => ({ running: false, scanId: null, phase: null, done: 0, total: null, lastScan: null }),
  findingsSummary: async () => ({ evaluated: true, basedOn: { scanId: 41, status: 'completed', finishedAt: 'T' }, latestAttempt: null, byClass: { duplicate: 3, filesystem: 7 }, reclaimableBytes: 3_221_225_472, notEvaluated: [] }),
  scanStart: vi.fn(async () => ({ scanId: 1 })),
  scanCancel: vi.fn(async () => ({ cancelled: true })),
  ...over,
} as never)

describe('Dashboard', () => {
  it('shows per-class counts and total reclaimable space', async () => {
    render(<Dashboard api={api()} />)
    expect(await screen.findByText('3')).toBeInTheDocument()
    expect(await screen.findByText('7')).toBeInTheDocument()
    expect(await screen.findByText('3.0 GB')).toBeInTheDocument()
  })

  it('shows a connector as unreachable when health says so', async () => {
    render(<Dashboard api={api({ health: async () => ({ status: 'degraded', schemaVersion: 1, connectors: { jellyfin: 'unreachable' } }) })} />)
    expect(await screen.findByText(/unreachable/i)).toBeInTheDocument()
  })

  it('surfaces rules that were not evaluated', async () => {
    render(<Dashboard api={api({
      findingsSummary: async () => ({ evaluated: true, basedOn: { scanId: 41, status: 'completed', finishedAt: 'T' }, latestAttempt: null, byClass: {}, reclaimableBytes: 0, notEvaluated: [{ ruleId: 'dupe.identical-file', reason: 'hashes disabled' }] }),
    })} />)
    expect(await screen.findByText(/hashes disabled/)).toBeInTheDocument()
  })

  it('starts a scan on click', async () => {
    const scanStart = vi.fn(async () => ({ scanId: 1 }))
    render(<Dashboard api={api({ scanStart })} />)
    await userEvent.click(await screen.findByRole('button', { name: /scan now/i }))
    expect(scanStart).toHaveBeenCalled()
  })

  it('shows progress and a cancel button while a scan runs', async () => {
    render(<Dashboard api={api({
      scanStatus: async () => ({ running: true, scanId: 4, phase: 'filesystem', done: 120, total: 500, lastScan: null }),
    })} />)
    expect(await screen.findByText(/filesystem/)).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /cancel/i })).toBeInTheDocument()
  })

  it('says results are stale when a newer scan has failed', async () => {
    render(<Dashboard api={api({
      findingsSummary: async () => ({
        evaluated: true,
        basedOn: { scanId: 41, status: 'completed', finishedAt: 'T' },
        latestAttempt: { scanId: 42, status: 'failed' },
        byClass: { duplicate: 3 }, reclaimableBytes: 0, notEvaluated: [],
      }),
    })} />)
    expect(await screen.findByText(/scan 41/)).toBeInTheDocument()
    expect(await screen.findByText(/scan 42/)).toBeInTheDocument()
  })

  it('says plainly that nothing has been evaluated yet, rather than showing a confident zero', async () => {
    render(<Dashboard api={api({
      findingsSummary: async () => ({ evaluated: false, basedOn: null, latestAttempt: null, byClass: {}, reclaimableBytes: 0, notEvaluated: [] }),
    })} />)
    expect(await screen.findByText(/no scan has completed|not been evaluated|nothing has been evaluated/i)).toBeInTheDocument()
  })

  it('offers a force option when scanStart is refused because the path map is unverified, and does not retry silently', async () => {
    const scanStart = vi.fn()
      .mockRejectedValueOnce(new ApiError(412, 'the path map has not been verified'))
      .mockResolvedValueOnce({ scanId: 2 })
    render(<Dashboard api={api({ scanStart })} />)
    await userEvent.click(await screen.findByRole('button', { name: /scan now/i }))
    expect(await screen.findByText(/path map has not been verified/i)).toBeInTheDocument()
    expect(scanStart).toHaveBeenCalledTimes(1)
    await userEvent.click(await screen.findByRole('button', { name: /force/i }))
    expect(scanStart).toHaveBeenLastCalledWith({ force: true })
  })
})
