import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Settings } from '../src/screens/Settings.js'

const api = (over = {}) => ({
  pathmapGet: async () => ({ mappings: [{ role: 'library', jellyfin: '/media/Movies', container: '/mnt/m', qbit: null }] }),
  pathmapPut: vi.fn(async (m: unknown[]) => ({ mappings: m })),
  pathmapVerify: vi.fn(async () => ({ sampled: 20, resolved: 18, failures: [{ jellyfinPath: '/media/Movies/x.mkv', reason: 'not found on disk' }] })),
  pathmapDetect: vi.fn(async () => ({ proposed: [{ role: 'library', jellyfin: '/media/TV', container: '/mnt/tv', qbit: null }] })),
  ...over,
} as never)

describe('Settings', () => {
  it('lists the configured mappings', async () => {
    render(<Settings api={api()} />)
    expect(await screen.findByDisplayValue('/media/Movies')).toBeInTheDocument()
  })

  it('verifies mappings and shows the resolved ratio and each failure', async () => {
    render(<Settings api={api()} />)
    await userEvent.click(await screen.findByRole('button', { name: /verify/i }))
    expect(await screen.findByText(/18 of 20/i)).toBeInTheDocument()
    expect(await screen.findByText(/not found on disk/)).toBeInTheDocument()
  })

  it('proposes detected mappings without saving them automatically', async () => {
    const pathmapPut = vi.fn(async (m: unknown[]) => ({ mappings: m }))
    render(<Settings api={api({ pathmapPut })} />)
    await userEvent.type(await screen.findByLabelText(/mount roots/i), '/mnt')
    await userEvent.click(screen.getByRole('button', { name: /auto-detect/i }))
    expect(await screen.findByText('/media/TV')).toBeInTheDocument()
    expect(pathmapPut).not.toHaveBeenCalled()
  })

  it('saves mappings on demand', async () => {
    const pathmapPut = vi.fn(async (m: unknown[]) => ({ mappings: m }))
    render(<Settings api={api({ pathmapPut })} />)
    await userEvent.click(await screen.findByRole('button', { name: /save mappings/i }))
    expect(pathmapPut).toHaveBeenCalled()
  })

  // --- TEST HONESTY M8 ----------------------------------------------------------------------------
  // The screen's own doc comment (line 40) says auto-detect only ever PROPOSES a row, and accepting
  // one ("Add to mappings") is still local state — nothing reaches the server until "Save mappings"
  // is clicked separately. The previous test above only proves DETECTING doesn't save; it never
  // clicks the per-row "Add to mappings" button, so a mutant that made THAT button write straight
  // to the server would still pass every test that existed before this one.
  it('accepting a proposed mapping ("Add to mappings") only updates local state — it does not save until "Save mappings" is clicked separately', async () => {
    const pathmapPut = vi.fn(async (m: unknown[]) => ({ mappings: m }))
    render(<Settings api={api({ pathmapPut })} />)
    await userEvent.type(await screen.findByLabelText(/mount roots/i), '/mnt')
    await userEvent.click(screen.getByRole('button', { name: /auto-detect/i }))
    await screen.findByText('/media/TV')

    await userEvent.click(screen.getByRole('button', { name: /^add to mappings$/i }))
    expect(pathmapPut).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: /save mappings/i }))
    expect(pathmapPut).toHaveBeenCalled()
  })

  // Task 6 extension: the brief's own text calls for "read-only display of the current
  // thresholds", but GET /api/config/thresholds does not exist anywhere else in this app's
  // surface, so it was added alongside this screen (src/api/plans.ts). Every test above uses an
  // `api()` mock with NO `configThresholds` at all, which is the common case (a caller that has
  // not wired it) — Settings must not crash on that, which the four tests above already prove
  // (rendering the whole screen through the pathmap flows without ever invoking it). This test
  // covers the other half: when it IS provided, the numbers actually show up.
  it('shows the current guard and trash thresholds read-only when the endpoint is available', async () => {
    render(<Settings api={api({
      configThresholds: vi.fn(async () => ({
        minRatio: 1.5, minSeedTimeDays: 14, protectedCategories: ['keep'], protectedTags: ['favorite'],
        trashMaxBytes: 1_073_741_824, trashRetentionDays: 30,
      })),
    })} />)
    expect(await screen.findByText('1.5')).toBeInTheDocument()
    expect(await screen.findByText(/14 days/)).toBeInTheDocument()
    expect(await screen.findByText('keep')).toBeInTheDocument()
    expect(await screen.findByText('favorite')).toBeInTheDocument()
    expect(await screen.findByText('1.0 GB')).toBeInTheDocument()
  })

  it('does not offer a save affordance for thresholds — they are read-only', async () => {
    render(<Settings api={api({
      configThresholds: vi.fn(async () => ({
        minRatio: 1, minSeedTimeDays: 14, protectedCategories: [], protectedTags: [],
        trashMaxBytes: 1_073_741_824, trashRetentionDays: 30,
      })),
    })} />)
    await screen.findByText(/minimum seed ratio/i)
    expect(screen.queryByLabelText(/minimum seed ratio/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /save thresholds/i })).not.toBeInTheDocument()
  })
})
