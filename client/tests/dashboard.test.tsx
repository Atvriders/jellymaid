import { describe, it, expect, vi } from 'vitest'
import { render, screen, within, waitFor } from '@testing-library/react'
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

/**
 * The `.tile` element whose label text matches, so an assertion can be scoped to just that tile
 * instead of asking "does '3' appear anywhere on the page" — which would still pass if the tiles
 * were swapped and the wrong class showed the wrong count.
 */
function tileFor(container: HTMLElement, label: RegExp): HTMLElement {
  const tiles = Array.from(container.querySelectorAll<HTMLElement>('.tile'))
  const tile = tiles.find((t) => label.test(t.textContent ?? ''))
  if (!tile) throw new Error(`no tile matched ${label} among: ${tiles.map((t) => t.textContent).join(' | ')}`)
  return tile
}

describe('Dashboard', () => {
  it('shows per-class counts and total reclaimable space, bound to the correct tile', async () => {
    const { container } = render(<Dashboard api={api()} />)
    expect(await screen.findByText('3.0 GB')).toBeInTheDocument()

    const duplicateTile = tileFor(container, /duplicates/i)
    const filesystemTile = tileFor(container, /filesystem/i)
    // Scoped to each tile — this would fail if the counts were swapped between classes, unlike a
    // bare `screen.findByText('3')` which only proves the digit exists somewhere on the page.
    expect(within(duplicateTile).getByText('3')).toBeInTheDocument()
    expect(within(filesystemTile).getByText('7')).toBeInTheDocument()
  })

  it('shows a connector as unreachable when health says so', async () => {
    render(<Dashboard api={api({ health: async () => ({ status: 'degraded', schemaVersion: 1, connectors: { jellyfin: 'unreachable' } }) })} />)
    expect(await screen.findByText(/unreachable/i)).toBeInTheDocument()
  })

  it('surfaces rules that were not evaluated above the tiles, and degrades only the affected tile instead of printing a confident zero', async () => {
    const { container } = render(<Dashboard api={api({
      findingsSummary: async () => ({
        evaluated: true, basedOn: { scanId: 41, status: 'completed', finishedAt: 'T' }, latestAttempt: null,
        byClass: {}, reclaimableBytes: 0,
        notEvaluated: [{ ruleId: 'dupe.identical-file', reason: 'hashes disabled' }, { ruleId: 'dupe.title-year', reason: 'hashes disabled' }],
      }),
    })} />)
    await screen.findAllByText(/hashes disabled/)

    const notice = container.querySelector('.not-evaluated')
    const tiles = container.querySelector('.class-tiles')
    expect(notice).not.toBeNull()
    expect(tiles).not.toBeNull()
    // The notice's own sentence ("their absence from the results below") only makes sense if the
    // notice actually precedes the tiles in document order.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(notice!.compareDocumentPosition(tiles!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    // Both duplicate matchers failed — the duplicate tile must not read as a confirmed, clean zero.
    const duplicateTile = tileFor(container, /duplicates/i)
    expect(within(duplicateTile).queryByText('0')).not.toBeInTheDocument()
    expect(duplicateTile.querySelector('.tile-count')?.textContent).not.toBe('0')

    // An unaffected class (nothing fs.*/meta.*/quality.* in notEvaluated) still reads as a plain,
    // trustworthy zero.
    const filesystemTile = tileFor(container, /filesystem/i)
    expect(within(filesystemTile).getByText('0')).toBeInTheDocument()
  })

  it('does not show a confirmed reclaimable total when a filesystem rule was not evaluated', async () => {
    render(<Dashboard api={api({
      findingsSummary: async () => ({
        evaluated: true, basedOn: { scanId: 41, status: 'completed', finishedAt: 'T' }, latestAttempt: null,
        byClass: { filesystem: 2 }, reclaimableBytes: 12_345,
        notEvaluated: [{ ruleId: 'fs.junk', reason: 'filesystem phase failed' }],
      }),
    })} />)
    await screen.findByText(/filesystem phase failed/)
    expect(screen.queryByText(/12.1 KB|12,345|12345/)).not.toBeInTheDocument()
    // Reclaimable space renders the same "unknown" em dash Bytes uses for a null value.
    const reclaimableLine = await screen.findByText(/reclaimable space/i)
    expect(reclaimableLine.textContent).toMatch(/—/)
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

  it('says plainly that nothing has been evaluated yet, rather than showing a confident zero or any tiles', async () => {
    const { container } = render(<Dashboard api={api({
      findingsSummary: async () => ({ evaluated: false, basedOn: null, latestAttempt: null, byClass: {}, reclaimableBytes: 0, notEvaluated: [] }),
    })} />)
    expect(await screen.findByText(/no scan has completed|not been evaluated|nothing has been evaluated/i)).toBeInTheDocument()
    // Presence-only assertions would also pass if the component rendered this message ALONGSIDE
    // the zero tiles — so the zero tiles (and the reclaimable line) must be provably absent too.
    expect(container.querySelector('.class-tiles')).toBeNull()
    expect(screen.queryByText(/reclaimable space/i)).not.toBeInTheDocument()
  })

  it('offers a force option when scanStart is refused because the path map is unverified, reading forcible from the response body, and does not retry silently', async () => {
    const scanStart = vi.fn()
      .mockRejectedValueOnce(new ApiError(412, 'the path map has not been verified', { error: 'the path map has not been verified', forcible: true }))
      .mockResolvedValueOnce({ scanId: 2 })
    render(<Dashboard api={api({ scanStart })} />)
    await userEvent.click(await screen.findByRole('button', { name: /scan now/i }))
    expect(await screen.findByText(/path map has not been verified/i)).toBeInTheDocument()
    expect(scanStart).toHaveBeenCalledTimes(1)
    await userEvent.click(await screen.findByRole('button', { name: /force/i }))
    expect(scanStart).toHaveBeenLastCalledWith({ force: true })
  })

  it('does not offer a force option when the server body says forcible: false, even on a 412', async () => {
    const scanStart = vi.fn().mockRejectedValueOnce(new ApiError(412, 'refused for another reason', { error: 'refused for another reason', forcible: false }))
    render(<Dashboard api={api({ scanStart })} />)
    await userEvent.click(await screen.findByRole('button', { name: /scan now/i }))
    expect(await screen.findByText(/refused for another reason/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /force/i })).not.toBeInTheDocument()
  })

  it('reloads the findings summary once a started scan is confirmed done, even if it finished before the first poll tick ever observed it running', async () => {
    const findingsSummary = vi.fn()
      .mockResolvedValueOnce({ evaluated: true, basedOn: { scanId: 1, status: 'completed', finishedAt: 'T' }, latestAttempt: null, byClass: { duplicate: 1 }, reclaimableBytes: 0, notEvaluated: [] })
      .mockResolvedValueOnce({ evaluated: true, basedOn: { scanId: 2, status: 'completed', finishedAt: 'T' }, latestAttempt: null, byClass: { duplicate: 2 }, reclaimableBytes: 0, notEvaluated: [] })
    // Every poll — before AND after the scan is started — reports `running: false`: the scan
    // finished in the gap between the request resolving and the next 2s tick, so no poll ever
    // observes `running: true`. `wasRunning` must therefore be set at `scanStart` itself.
    const scanStatus = vi.fn(async () => ({ running: false, scanId: 2, phase: null, done: 1, total: 1, lastScan: null }))
    const scanStart = vi.fn(async () => ({ scanId: 2 }))
    render(<Dashboard api={api({ findingsSummary, scanStatus, scanStart })} />)
    await waitFor(() => expect(findingsSummary).toHaveBeenCalledTimes(1))
    await userEvent.click(await screen.findByRole('button', { name: /scan now/i }))
    await waitFor(() => expect(findingsSummary).toHaveBeenCalledTimes(2))
  })
})
