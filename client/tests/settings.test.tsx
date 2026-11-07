import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Settings } from '../src/screens/Settings.js'

const mapping = (over: Record<string, unknown> = {}) => ({
  role: 'library', jellyfin: '/media/Movies', container: '/movies', qbit: null, qbitInstance: null, ...over,
})

const settingsView = (over: Record<string, unknown> = {}) => ({
  guards: { minRatio: 1, minSeedTimeDays: 14, protectedCategories: ['keep'], protectedTags: ['favorite'], privateTrackerHosts: ['tracker.example'] },
  keeper: { policy: 'best-quality' },
  trash: { maxBytes: 1_073_741_824, retentionDays: 30 },
  ...over,
})

const instances = [
  { id: 'box-a', url: 'http://198.51.100.10:8080/', reachable: true, version: 'v5.2.2', error: null, torrentCount: 12 },
  { id: 'box-b', url: 'http://198.51.100.11:8080/', reachable: false, version: null, error: 'connect ECONNREFUSED', torrentCount: null },
]

const api = (over: Record<string, unknown> = {}) => ({
  pathmapGet: async () => ({ mappings: [mapping()], problems: [], lastVerification: null }),
  pathmapPut: vi.fn(async (m: unknown[]) => ({ mappings: m, problems: [], lastVerification: null })),
  pathmapVerify: vi.fn(async () => ({
    at: '2026-10-31T12:00:00Z', mappingsHash: 'abcd', current: true,
    jellyfin: { sampled: 20, resolved: 18, failures: [{ jellyfinPath: '/media/Movies/x.mkv', reason: 'not found on disk' }] },
    qbit: [
      { instanceId: 'box-a', sampled: 20, resolved: 20, failures: [] },
      { instanceId: 'box-b', sampled: 5, resolved: 4, failures: [{ qbitPath: '/movies/Nosferatu (1922)', reason: 'size differs' }] },
    ],
  })),
  pathmapDetect: vi.fn(async () => ({ proposals: [mapping({ jellyfin: '/media/TV', container: '/tv', qbit: '/tv', qbitInstance: 'box-b' })] })),
  qbitInstances: vi.fn(async () => ({ instances })),
  settings: vi.fn(async () => settingsView()),
  saveSettings: vi.fn(async () => settingsView()),
  ...over,
} as never)

describe('Settings', () => {
  it('lists the configured mappings', async () => {
    render(<Settings api={api()} />)
    expect(await screen.findByDisplayValue('/media/Movies')).toBeInTheDocument()
  })

  it('proposes detected mappings without saving them automatically', async () => {
    const pathmapPut = vi.fn(async (m: unknown[]) => ({ mappings: m, problems: [], lastVerification: null }))
    render(<Settings api={api({ pathmapPut })} />)
    await userEvent.type(await screen.findByLabelText(/mount roots/i), '/media')
    await userEvent.click(screen.getByRole('button', { name: /auto-detect/i }))
    expect(await screen.findByText('/media/TV')).toBeInTheDocument()
    expect(pathmapPut).not.toHaveBeenCalled()
  })

  it('saves mappings on demand', async () => {
    const pathmapPut = vi.fn(async (m: unknown[]) => ({ mappings: m, problems: [], lastVerification: null }))
    render(<Settings api={api({ pathmapPut })} />)
    await userEvent.click(await screen.findByRole('button', { name: /save mappings/i }))
    expect(pathmapPut).toHaveBeenCalled()
  })

  // --- TEST HONESTY M8 ----------------------------------------------------------------------------
  // Auto-detect only ever PROPOSES a row, and accepting one ("Add to mappings") is still local
  // state — nothing reaches the server until "Save mappings" is clicked separately.
  it('accepting a proposed mapping ("Add to mappings") only updates local state — it does not save until "Save mappings" is clicked separately', async () => {
    const pathmapPut = vi.fn(async (m: unknown[]) => ({ mappings: m, problems: [], lastVerification: null }))
    render(<Settings api={api({ pathmapPut })} />)
    await userEvent.type(await screen.findByLabelText(/mount roots/i), '/media')
    await userEvent.click(screen.getByRole('button', { name: /auto-detect/i }))
    await screen.findByText('/media/TV')

    await userEvent.click(screen.getByRole('button', { name: /^add to mappings$/i }))
    expect(pathmapPut).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: /save mappings/i }))
    expect(pathmapPut).toHaveBeenCalledWith([
      mapping(),
      mapping({ jellyfin: '/media/TV', container: '/tv', qbit: '/tv', qbitInstance: 'box-b' }),
    ])
  })

  // --- Plan 7: one qBittorrent instance per mapping, chosen, never typed -----------------------

  it('settings mapping row offers the instance picker from /api/qbit/instances', async () => {
    const pathmapPut = vi.fn(async (m: unknown[]) => ({ mappings: m, problems: [], lastVerification: null }))
    const qbitInstances = vi.fn(async () => ({ instances }))
    render(<Settings api={api({ pathmapPut, qbitInstances })} />)
    const picker = await screen.findByRole('combobox', { name: /qbittorrent instance for mapping 1/i })
    await within(picker).findByRole('option', { name: /box-a/ })
    expect(qbitInstances).toHaveBeenCalled()
    const options = within(picker).getAllByRole('option')
    expect(options.map((o) => (o as HTMLOptionElement).value)).toEqual(['', 'box-a', 'box-b'])
    expect(options[0]).toHaveTextContent('none (not torrent-backed)')
    expect(options[2]).toHaveTextContent(/unreachable/i)
    expect(picker).toHaveValue('')

    await userEvent.selectOptions(picker, 'box-b')
    await userEvent.type(screen.getByLabelText(/qbittorrent path for mapping 1/i), '/movies')
    await userEvent.click(screen.getByRole('button', { name: /save mappings/i }))
    expect(pathmapPut).toHaveBeenLastCalledWith([mapping({ qbit: '/movies', qbitInstance: 'box-b' })])
  })

  it('saves "none" as an explicitly not torrent-backed root: no instance and no qBittorrent path', async () => {
    const pathmapPut = vi.fn(async (m: unknown[]) => ({ mappings: m, problems: [], lastVerification: null }))
    render(<Settings api={api({
      pathmapPut,
      pathmapGet: async () => ({ mappings: [mapping({ qbit: '/movies', qbitInstance: 'box-a' })], problems: [], lastVerification: null }),
    })} />)
    const picker = await screen.findByRole('combobox', { name: /qbittorrent instance for mapping 1/i })
    await within(picker).findByRole('option', { name: /box-b/ })
    expect(picker).toHaveValue('box-a')
    await userEvent.selectOptions(picker, '')
    await userEvent.click(screen.getByRole('button', { name: /save mappings/i }))
    expect(pathmapPut).toHaveBeenLastCalledWith([mapping({ qbit: null, qbitInstance: null })])
  })

  it('shows a qBittorrent path with no instance as unassigned, never as "none", and saves it untouched', async () => {
    // A legacy single-instance mapping. Showing it as "none (not torrent-backed)" would be a lie,
    // and saving it that way would turn a torrent-backed root into one the guards treat as having
    // no torrents at all.
    const pathmapPut = vi.fn(async (m: unknown[]) => ({ mappings: m, problems: [], lastVerification: null }))
    render(<Settings api={api({
      pathmapPut,
      pathmapGet: async () => ({ mappings: [mapping({ qbit: '/movies', qbitInstance: null })], problems: [], lastVerification: null }),
    })} />)
    const picker = await screen.findByRole('combobox', { name: /qbittorrent instance for mapping 1/i })
    await within(picker).findByRole('option', { name: /box-a/ })
    expect(within(picker).getByRole('option', { selected: true })).toHaveTextContent(/pick an instance/i)
    await userEvent.click(screen.getByRole('button', { name: /save mappings/i }))
    expect(pathmapPut).toHaveBeenLastCalledWith([mapping({ qbit: '/movies', qbitInstance: null })])
  })

  // Final review I1: a root saved as "none" is one no guard asks any instance about, so a box seeding
  // into it can have its files unlinked. A new row must not become that by default.
  it('starts a new row undecided, never as "none", and will not save it until an instance or "none" is chosen', async () => {
    const pathmapPut = vi.fn(async (m: unknown[]) => ({ mappings: m, problems: [], lastVerification: null }))
    render(<Settings api={api({ pathmapPut })} />)
    await screen.findByDisplayValue('/media/Movies')
    await userEvent.click(screen.getByRole('button', { name: /add mapping/i }))
    const picker = screen.getByRole('combobox', { name: /qbittorrent instance for mapping 2/i })
    await within(picker).findByRole('option', { name: /box-a/ })
    expect(within(picker).getByRole('option', { selected: true })).toHaveTextContent(/choose/i)
    expect(within(picker).getByRole('option', { selected: true })).not.toHaveTextContent(/not torrent-backed/i)
    expect(picker).not.toHaveValue('')
    await userEvent.type(screen.getByLabelText(/jellyfin path for mapping 2/i), '/media/TV')
    await userEvent.type(screen.getByLabelText(/container path for mapping 2/i), '/tv')

    await userEvent.click(screen.getByRole('button', { name: /save mappings/i }))
    expect(pathmapPut).not.toHaveBeenCalled()
    expect(await screen.findByRole('alert')).toHaveTextContent(/mapping 2/i)

    await userEvent.selectOptions(picker, '')
    await userEvent.click(screen.getByRole('button', { name: /save mappings/i }))
    expect(pathmapPut).toHaveBeenLastCalledWith([mapping(), mapping({ jellyfin: '/media/TV', container: '/tv' })])
  })

  it('leaves a proposed row with no detected instance undecided too', async () => {
    const pathmapPut = vi.fn(async (m: unknown[]) => ({ mappings: m, problems: [], lastVerification: null }))
    render(<Settings api={api({
      pathmapPut,
      pathmapDetect: vi.fn(async () => ({ proposals: [mapping({ jellyfin: '/media/TV', container: '/tv' })] })),
    })} />)
    await userEvent.type(await screen.findByLabelText(/mount roots/i), '/media')
    await userEvent.click(screen.getByRole('button', { name: /auto-detect/i }))
    await userEvent.click(await screen.findByRole('button', { name: /^add to mappings$/i }))
    const picker = screen.getByRole('combobox', { name: /qbittorrent instance for mapping 2/i })
    await within(picker).findByRole('option', { name: /box-a/ })
    expect(within(picker).getByRole('option', { selected: true })).toHaveTextContent(/choose/i)
    await userEvent.click(screen.getByRole('button', { name: /save mappings/i }))
    expect(pathmapPut).not.toHaveBeenCalled()

    await userEvent.selectOptions(picker, 'box-b')
    await userEvent.type(screen.getByLabelText(/qbittorrent path for mapping 2/i), '/tv')
    await userEvent.click(screen.getByRole('button', { name: /save mappings/i }))
    expect(pathmapPut).toHaveBeenLastCalledWith([mapping(), mapping({ jellyfin: '/media/TV', container: '/tv', qbit: '/tv', qbitInstance: 'box-b' })])
  })

  it('saves a new row as "none" without asking when no qBittorrent instance is configured: there is nothing else it could be', async () => {
    const pathmapPut = vi.fn(async (m: unknown[]) => ({ mappings: m, problems: [], lastVerification: null }))
    render(<Settings api={api({ pathmapPut, qbitInstances: vi.fn(async () => ({ instances: [] })) })} />)
    await screen.findByDisplayValue('/media/Movies')
    await userEvent.click(screen.getByRole('button', { name: /add mapping/i }))
    await userEvent.type(screen.getByLabelText(/jellyfin path for mapping 2/i), '/media/TV')
    await userEvent.type(screen.getByLabelText(/container path for mapping 2/i), '/tv')
    await userEvent.click(screen.getByRole('button', { name: /save mappings/i }))
    expect(pathmapPut).toHaveBeenLastCalledWith([mapping(), mapping({ jellyfin: '/media/TV', container: '/tv' })])
  })

  it('keeps an instance id that is no longer configured visible instead of silently showing another', async () => {
    render(<Settings api={api({
      pathmapGet: async () => ({ mappings: [mapping({ qbit: '/movies', qbitInstance: 'old-box' })], problems: [], lastVerification: null }),
    })} />)
    const picker = await screen.findByRole('combobox', { name: /qbittorrent instance for mapping 1/i })
    await within(picker).findByRole('option', { name: /box-a/ })
    expect(picker).toHaveValue('old-box')
    expect(within(picker).getByRole('option', { name: /old-box/ })).toHaveTextContent(/not configured/i)
  })

  it('says so when the instance list cannot be loaded, and still shows the saved instance', async () => {
    render(<Settings api={api({
      qbitInstances: vi.fn(async () => { throw new Error('qBittorrent list failed') }),
      pathmapGet: async () => ({ mappings: [mapping({ qbit: '/movies', qbitInstance: 'box-a' })], problems: [], lastVerification: null }),
    })} />)
    expect(await screen.findByText(/qBittorrent list failed/)).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: /qbittorrent instance for mapping 1/i })).toHaveValue('box-a')
  })

  it('lists the mapping problems the server reports', async () => {
    render(<Settings api={api({
      pathmapGet: async () => ({
        mappings: [mapping({ qbit: '/movies', qbitInstance: null })],
        problems: ['/movies: a qBittorrent path needs an instance when more than one instance is configured'],
        lastVerification: null,
      }),
    })} />)
    expect(await screen.findByText(/needs an instance when more than one instance is configured/)).toBeInTheDocument()
  })

  // Final re-review N1: the problem comes back from the save itself, and is shown at once.
  it('shows the problem a save reports when one instance maps the same qBittorrent path to two folders', async () => {
    const problem = 'box-a maps /movies to two folders (/path/to/a/movies, /path/to/b/movies); one of them probably belongs to another box'
    const pathmapPut = vi.fn(async (m: unknown[]) => ({ mappings: m, problems: [problem], lastVerification: null }))
    render(<Settings api={api({
      pathmapGet: async () => ({
        mappings: [
          mapping({ container: '/path/to/a/movies', qbit: '/movies', qbitInstance: 'box-a' }),
          mapping({ jellyfin: '/media/Movies B', container: '/path/to/b/movies', qbit: '/movies', qbitInstance: 'box-a' }),
        ],
        problems: [],
        lastVerification: null,
      }),
      pathmapPut,
    })} />)
    await userEvent.click(await screen.findByRole('button', { name: /save mappings/i }))
    expect(pathmapPut).toHaveBeenCalled()
    const listed = await screen.findByText(problem)
    expect(listed.closest('.settings-problems')).toHaveTextContent(/fails closed until it is fixed/)
  })

  // --- Verify: both halves --------------------------------------------------------------------

  it('verify shows Jellyfin and per-instance results', async () => {
    const { container } = render(<Settings api={api()} />)
    await userEvent.click(await screen.findByRole('button', { name: /^verify$/i }))
    const result = await screen.findByRole('status', { name: /verification/i })
    const jellyfin = within(result).getByRole('group', { name: /jellyfin/i })
    expect(jellyfin).toHaveTextContent(/18 of 20/)
    expect(jellyfin).toHaveTextContent(/not found on disk/)
    const boxA = within(result).getByRole('group', { name: /box-a/i })
    expect(boxA).toHaveTextContent(/20 of 20/)
    const boxB = within(result).getByRole('group', { name: /box-b/i })
    expect(boxB).toHaveTextContent(/4 of 5/)
    expect(boxB).toHaveTextContent('/movies/Nosferatu (1922)')
    expect(boxB).toHaveTextContent(/size differs/)
    expect(container.querySelector('img')).toBeNull()
  })

  it('reports an instance with no completed torrents as nothing to check, and a configured instance with no report as unverified', async () => {
    render(<Settings api={api({
      pathmapVerify: vi.fn(async () => ({
        at: 'T', mappingsHash: 'h', current: true,
        jellyfin: { sampled: 20, resolved: 20, failures: [] },
        qbit: [{ instanceId: 'box-a', sampled: 0, resolved: 0, failures: [] }],
      })),
    })} />)
    await userEvent.click(await screen.findByRole('button', { name: /^verify$/i }))
    const result = await screen.findByRole('status', { name: /verification/i })
    expect(within(result).getByRole('group', { name: /box-a/i })).toHaveTextContent(/no completed torrents/i)
    expect(within(result).getByRole('group', { name: /box-b/i })).toHaveTextContent(/not verified/i)
  })

  it('says how many torrents outside every mapped folder were ignored, with examples on expand (final fix wave part 2)', async () => {
    render(<Settings api={api({
      pathmapVerify: vi.fn(async () => ({
        at: 'T', mappingsHash: 'h', current: true,
        jellyfin: { sampled: 20, resolved: 20, failures: [] },
        qbit: [
          { instanceId: 'box-a', sampled: 20, resolved: 20, failures: [], ignored: { count: 819, examples: ['/music/Album', '/books/Novel.epub'] } },
          { instanceId: 'box-b', sampled: 0, resolved: 0, failures: [], ignored: { count: 1, examples: ['/downloads/Stray'] } },
        ],
      })),
    })} />)
    await userEvent.click(await screen.findByRole('button', { name: /^verify$/i }))
    const result = await screen.findByRole('status', { name: /verification/i })
    const boxA = within(result).getByRole('group', { name: /box-a/i })
    expect(boxA).toHaveTextContent(/passed/)
    expect(boxA).toHaveTextContent(/20 of 20/)
    const summary = within(boxA).getByText('819 torrents outside every mapped folder were ignored')
    // The examples sit behind the count, folded until asked for.
    const fold = summary.closest('details')
    expect(fold).not.toBeNull()
    expect(fold).not.toHaveAttribute('open')
    expect(within(fold!).getByText('/music/Album')).toBeInTheDocument()
    expect(within(fold!).getByText('/books/Novel.epub')).toBeInTheDocument()
    const boxB = within(result).getByRole('group', { name: /box-b/i })
    expect(boxB).toHaveTextContent(/passed/)
    expect(boxB).toHaveTextContent(/no completed torrents in a mapped folder/i)
    expect(within(boxB).getByText('1 torrent outside every mapped folder was ignored')).toBeInTheDocument()
  })

  it('says nothing about ignored torrents when a report has none', async () => {
    render(<Settings api={api()} />)
    await userEvent.click(await screen.findByRole('button', { name: /^verify$/i }))
    const result = await screen.findByRole('status', { name: /verification/i })
    expect(result).not.toHaveTextContent(/ignored/i)
  })

  it('shows the last verification on load, and says when the mappings changed since', async () => {
    render(<Settings api={api({
      pathmapGet: async () => ({
        mappings: [mapping()], problems: [],
        lastVerification: {
          at: '2026-10-30T09:00:00Z', mappingsHash: 'old', current: false,
          jellyfin: { sampled: 20, resolved: 20, failures: [] }, qbit: [],
        },
      }),
    })} />)
    const result = await screen.findByRole('status', { name: /verification/i })
    expect(result).toHaveTextContent('2026-10-30T09:00:00Z')
    expect(result).toHaveTextContent(/mappings changed since/i)
  })

  // --- Guard thresholds and keeper policy: editable, live -------------------------------------

  it('thresholds and keeper policy save via PUT /api/config/settings', async () => {
    const saveSettings = vi.fn(async () => settingsView({
      guards: { minRatio: 1.5, minSeedTimeDays: 14, protectedCategories: ['keep'], protectedTags: ['favorite'], privateTrackerHosts: ['tracker.example'] },
      keeper: { policy: 'smallest' },
    }))
    render(<Settings api={api({ saveSettings })} />)
    const ratio = await screen.findByLabelText(/minimum seed ratio/i)
    expect(ratio).toHaveValue(1)
    expect(screen.getByLabelText(/minimum seed time/i)).toHaveValue(14)
    expect(screen.getByLabelText(/protected categories/i)).toHaveValue('keep')
    expect(screen.getByLabelText(/keeper policy/i)).toHaveValue('best-quality')
    // Ruling 4: a new policy picks keepers at the next scan, not retroactively.
    expect(screen.getByText(/applies after the next scan/i)).toBeInTheDocument()

    await userEvent.clear(ratio)
    await userEvent.type(ratio, '1.5')
    await userEvent.selectOptions(screen.getByLabelText(/keeper policy/i), 'smallest')
    await userEvent.click(screen.getByRole('button', { name: /save settings/i }))
    expect(saveSettings).toHaveBeenCalledTimes(1)
    expect(saveSettings).toHaveBeenCalledWith({ guards: { minRatio: 1.5 }, keeper: { policy: 'smallest' } })
    expect(await screen.findByText(/settings saved/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/minimum seed ratio/i)).toHaveValue(1.5)
  })

  it('saves comma-separated lists as arrays, and only what changed', async () => {
    const saveSettings = vi.fn(async () => settingsView())
    render(<Settings api={api({ saveSettings })} />)
    const hosts = await screen.findByLabelText(/private tracker hosts/i)
    await userEvent.clear(hosts)
    await userEvent.type(hosts, 'tracker.example, other.example ,')
    await userEvent.click(screen.getByRole('button', { name: /save settings/i }))
    expect(saveSettings).toHaveBeenCalledWith({ guards: { privateTrackerHosts: ['tracker.example', 'other.example'] } })
  })

  it('refuses a negative or non-numeric threshold without calling the API', async () => {
    const saveSettings = vi.fn(async () => settingsView())
    render(<Settings api={api({ saveSettings })} />)
    const days = await screen.findByLabelText(/minimum seed time/i)
    await userEvent.clear(days)
    await userEvent.type(days, '-3')
    await userEvent.click(screen.getByRole('button', { name: /save settings/i }))
    expect(await screen.findByText(/minimum seed time must be a number of 0 or more/i)).toBeInTheDocument()
    expect(saveSettings).not.toHaveBeenCalled()
  })

  it('shows the trash limits read-only', async () => {
    render(<Settings api={api()} />)
    expect(await screen.findByText('1.0 GB')).toBeInTheDocument()
    expect(screen.getByText(/30 days/)).toBeInTheDocument()
    expect(screen.queryByLabelText(/trash/i)).not.toBeInTheDocument()
  })

  it('shows the server refusal when saving settings fails', async () => {
    const saveSettings = vi.fn(async () => { throw new Error('minRatio must be at least 0') })
    render(<Settings api={api({ saveSettings })} />)
    await userEvent.selectOptions(await screen.findByLabelText(/keeper policy/i), 'none')
    await userEvent.click(screen.getByRole('button', { name: /save settings/i }))
    expect(await screen.findByText(/minRatio must be at least 0/)).toBeInTheDocument()
  })
})
