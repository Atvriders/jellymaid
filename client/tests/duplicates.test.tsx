import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Duplicates } from '../src/screens/Duplicates.js'
import type { RequestedAction } from '../src/api.js'

// Fixtures follow C12's DupeGroupView / DupeMemberView / TorrentFactsView exactly.

const torrent = (over: Record<string, unknown> = {}) => ({
  instanceId: 'box-a', hash: 'aaaa', name: 'Heat.1995.1080p.BluRay.x264-GRP', state: 'stalledUP', ratio: 1.5,
  seedingDays: 30, isPrivate: false, trackerHost: null, sizeBytes: 1, fileCount: 3, mediaFileCount: 1, hnrMet: true,
  ...over,
})

const member = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: 'Heat', containerPath: `/movies/Heat (1995)/${id}.mkv`, sizeBytes: 1, width: null, height: 1080,
  bitrate: null, videoCodec: null, audioChannels: null, container: 'mkv', libraryName: 'Movies',
  videoRange: null, hasSubtitles: false, edition: null, instanceId: 'box-a', torrent: null, torrentCount: 0,
  ...over,
})

// Default `matchedBy` is a genuine hash match (`dupe.identical-file`) — the one matcher that ever
// compares file content at all — so every test below that doesn't care about match evidence still
// gets the "no acknowledgement needed" baseline. Tests that DO care override `matchedBy` explicitly.
const group = (over: Record<string, unknown> = {}) => ({
  id: 'g1', tier: 'exact', matchedBy: ['dupe.identical-file'], keeperItemId: 'b', keeperPolicy: 'best-quality',
  title: 'Heat', year: 1995, kind: 'movie', seriesName: null, seasonNo: null, episodeNo: null,
  editionsDiffer: false, multiEpisode: false, crossInstance: false, reclaimableBytes: 8_000_000_000,
  scores: { a: { total: 900, breakdown: { resolution: 500 } }, b: { total: 1800, breakdown: { resolution: 1000 } } },
  members: [
    member('a', { containerPath: '/movies/Heat-1080.mkv', sizeBytes: 8_000_000_000, height: 1080, bitrate: 8_000_000, videoCodec: 'h264' }),
    member('b', { containerPath: '/movies/Heat-2160.mkv', sizeBytes: 40_000_000_000, height: 2160, bitrate: 40_000_000, videoCodec: 'hevc' }),
  ],
  ...over,
})

const response = (groups: unknown[], over: Record<string, unknown> = {}) => ({
  evaluated: true, reason: null, scanId: 7, scanFinishedAt: '2026-10-30T12:00:00Z', groups, ...over,
})

const api = (over: Record<string, unknown> = {}) => ({
  duplicates: async () => response([group()]),
  mergeGroup: vi.fn(async () => ({ merged: ['a', 'b'] })),
  dismissDuplicate: vi.fn(async () => undefined),
  reopenDuplicate: vi.fn(async () => undefined),
  ...over,
} as never)

/** The rendered group headings, in page order. */
function headings(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.dupe-group h3')).map((h) => h.textContent ?? '')
}

/** The `.dupe-group` section whose heading is exactly `heading`. */
function sectionFor(heading: string): HTMLElement {
  const h = screen.getByRole('heading', { name: heading })
  const section = h.closest<HTMLElement>('.dupe-group')
  if (!section) throw new Error(`no group section around ${heading}`)
  return section
}

async function mergeThroughConfirmation(index = 0) {
  await userEvent.click((await screen.findAllByRole('button', { name: /^merge versions$/i }))[index]!)
  await userEvent.click(await screen.findByRole('button', { name: /^confirm merge$/i }))
}

describe('Duplicates', () => {
  it('shows the tier and every member side by side', async () => {
    render(<Duplicates api={api()} onQueue={() => {}} />)
    expect(await screen.findByText('exact')).toBeInTheDocument()
    expect(await screen.findByText('/movies/Heat-1080.mkv')).toBeInTheDocument()
    expect(await screen.findByText('/movies/Heat-2160.mkv')).toBeInTheDocument()
  })

  it('marks the pre-selected keeper', async () => {
    render(<Duplicates api={api()} onQueue={() => {}} />)
    const keeperRow = (await screen.findByText('/movies/Heat-2160.mkv')).closest('tr')!
    expect(keeperRow).toHaveAttribute('data-keeper', 'true')
  })

  it('lets the operator choose a different keeper, then queue the newly-non-keeper copy', async () => {
    const onQueue = vi.fn()
    render(<Duplicates api={api()} onQueue={onQueue} />)
    await userEvent.click(await screen.findByRole('radio', { name: /keep .*Heat-1080/i }))
    await userEvent.click(await screen.findByRole('checkbox', { name: /delete .*Heat-2160/i }))
    await userEvent.click(screen.getByRole('button', { name: /delete non-keepers/i }))
    expect(onQueue).toHaveBeenCalledWith([{ type: 'delete-media', targetPath: '/movies/Heat-2160.mkv' }])
  })

  it('merges versions through the api', async () => {
    const mergeGroup = vi.fn(async () => ({ merged: ['a', 'b'] }))
    render(<Duplicates api={api({ mergeGroup })} onQueue={() => {}} />)
    await mergeThroughConfirmation()
    expect(mergeGroup).toHaveBeenCalledWith('g1')
  })

  it('merge asks for confirmation', async () => {
    const mergeGroup = vi.fn(async () => ({ merged: ['a', 'b'] }))
    render(<Duplicates api={api({ mergeGroup })} onQueue={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /^merge versions$/i }))
    const dialog = await screen.findByRole('alertdialog', { name: /merge/i })
    expect(dialog).toHaveTextContent(/2 copies/i)
    expect(mergeGroup).not.toHaveBeenCalled()

    await userEvent.click(within(dialog).getByRole('button', { name: /^cancel$/i }))
    expect(screen.queryByRole('alertdialog', { name: /merge/i })).not.toBeInTheDocument()
    expect(mergeGroup).not.toHaveBeenCalled()

    await mergeThroughConfirmation()
    expect(mergeGroup).toHaveBeenCalledTimes(1)
    expect(mergeGroup).toHaveBeenCalledWith('g1')
  })

  it('shows the score breakdown so the keeper choice is auditable', async () => {
    render(<Duplicates api={api()} onQueue={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /why/i }))
    expect(await screen.findByText(/resolution score/i)).toBeInTheDocument()
  })

  it('flags a cross-library group', async () => {
    render(<Duplicates api={api({
      duplicates: async () => response([group({ members: [
        member('a', { containerPath: '/movies/a.mkv', libraryName: 'Movies' }),
        member('b', { containerPath: '/movies-4k/b.mkv', libraryName: 'Movies 4K' }),
      ] })]),
    })} onQueue={() => {}} />)
    expect(await screen.findByText(/across libraries/i)).toBeInTheDocument()
  })

  it('shows an empty state when there are no duplicates', async () => {
    render(<Duplicates api={api({ duplicates: async () => response([]) })} onQueue={() => {}} />)
    expect(await screen.findByText(/no duplicate groups/i)).toBeInTheDocument()
  })

  // --- Plan 7: the read model and the owner's scale ---------------------------------------------

  it('group header reads "Title (year)" for a film and "Series SxxEyy" for an episode', async () => {
    const { container } = render(<Duplicates api={api({
      duplicates: async () => response([
        group({ id: 'm', reclaimableBytes: 2 }),
        group({
          id: 'e', kind: 'episode', title: 'Pilot', year: 1962, seriesName: 'The Beverly Hillbillies', seasonNo: 1, episodeNo: 2,
          reclaimableBytes: 1, keeperItemId: 'e2', members: [
            member('e1', { containerPath: '/tv/The Beverly Hillbillies/Season 01/pack-S01E02.mkv' }),
            member('e2', { containerPath: '/tv/The Beverly Hillbillies/Season 01/single-S01E02.mkv' }),
          ],
        }),
      ]),
    })} onQueue={() => {}} />)
    await screen.findByText('/movies/Heat-1080.mkv')
    expect(headings(container)).toEqual(['Heat (1995)', 'The Beverly Hillbillies S01E02'])
  })

  it('duplicates paginates 50 groups and sorts by reclaimable bytes by default', async () => {
    // 900 groups — the owner's scale — handed over in an order that is NOT the reclaimable order.
    // (i * 7919) % 900 is a permutation of 0..899 because 7919 shares no factor with 900.
    const many = Array.from({ length: 900 }, (_, i) => {
      const megabytes = ((i * 7919) % 900) + 1
      return group({
        id: `g${i}`, title: `Film ${megabytes}`, reclaimableBytes: megabytes * 1_000_000, keeperItemId: `b${i}`, scores: {},
        members: [member(`a${i}`, { containerPath: `/movies/f${i}/a.mkv` }), member(`b${i}`, { containerPath: `/movies/f${i}/b.mkv` })],
      })
    })
    const { container } = render(<Duplicates api={api({ duplicates: async () => response(many) })} onQueue={() => {}} />)
    expect(await screen.findAllByText(/1–50 of 900 groups/)).not.toHaveLength(0)
    expect(screen.getByLabelText(/sort by/i)).toHaveValue('reclaimable')

    let shown = headings(container)
    expect(shown).toHaveLength(50)
    expect(shown[0]).toBe('Film 900 (1995)')
    expect(shown[49]).toBe('Film 851 (1995)')

    await userEvent.click(screen.getAllByRole('button', { name: /^next$/i })[0]!)
    expect(await screen.findAllByText(/51–100 of 900 groups/)).not.toHaveLength(0)
    shown = headings(container)
    expect(shown).toHaveLength(50)
    expect(shown[0]).toBe('Film 850 (1995)')

    await userEvent.click(screen.getAllByRole('button', { name: /^previous$/i })[0]!)
    expect(headings(container)[0]).toBe('Film 900 (1995)')
    // Renders three full 50-group pages in jsdom on purpose (~2.5 s locally): a timeout well above
    // vitest's 5 s default keeps a slower CI runner from turning that into a flake.
  }, 15_000)

  it('sorts by title or tier when asked, and returns to the first page', async () => {
    const { container } = render(<Duplicates api={api({
      duplicates: async () => response([
        group({ id: 'x', title: 'Zulu', tier: 'exact', reclaimableBytes: 3 }),
        group({ id: 'y', title: 'Alpha', tier: 'possible', reclaimableBytes: 2 }),
        group({ id: 'z', title: 'Mike', tier: 'strong', reclaimableBytes: 1 }),
      ]),
    })} onQueue={() => {}} />)
    await screen.findByRole('heading', { name: 'Zulu (1995)' })
    expect(headings(container)).toEqual(['Zulu (1995)', 'Alpha (1995)', 'Mike (1995)'])
    await userEvent.selectOptions(screen.getByLabelText(/sort by/i), 'title')
    expect(headings(container)).toEqual(['Alpha (1995)', 'Mike (1995)', 'Zulu (1995)'])
    await userEvent.selectOptions(screen.getByLabelText(/sort by/i), 'tier')
    expect(headings(container)).toEqual(['Zulu (1995)', 'Mike (1995)', 'Alpha (1995)'])
  })

  it('filters by box, tier, cross-box and H&R-blocked', async () => {
    const blocked = torrent({ isPrivate: true, ratio: 0.2, seedingDays: 2, hnrMet: false })
    const fine = torrent({ hnrMet: true })
    const { container } = render(<Duplicates api={api({
      duplicates: async () => response([
        // Alpha's KEEPER is H&R-blocked, but the keeper is never deleted — so Alpha is not an
        // "H&R-blocked" group: nothing the operator would delete here is held back by H&R.
        group({ id: 'gA', title: 'Alpha', tier: 'exact', keeperItemId: 'b1', reclaimableBytes: 4, members: [
          member('a1', { instanceId: 'box-a', torrent: fine }), member('b1', { instanceId: 'box-a', torrent: blocked }),
        ] }),
        group({ id: 'gB', title: 'Bravo', tier: 'strong', keeperItemId: 'b2', reclaimableBytes: 3, members: [
          member('a2', { instanceId: 'box-b', torrent: blocked }), member('b2', { instanceId: 'box-b', torrent: fine }),
        ] }),
        group({ id: 'gX', title: 'Xray', tier: 'exact', keeperItemId: 'b3', crossInstance: true, reclaimableBytes: 2, members: [
          member('a3', { instanceId: 'box-a', torrent: fine }), member('b3', { instanceId: 'box-b', torrent: fine }),
        ] }),
        group({ id: 'gP', title: 'Papa', tier: 'possible', keeperItemId: 'b4', reclaimableBytes: 1, members: [
          member('a4', { instanceId: 'box-a' }), member('b4', { instanceId: 'box-a' }),
        ] }),
      ]),
    })} onQueue={() => {}} />)
    await screen.findByRole('heading', { name: 'Alpha (1995)' })
    expect(headings(container)).toEqual(['Alpha (1995)', 'Bravo (1995)', 'Xray (1995)', 'Papa (1995)'])

    await userEvent.selectOptions(screen.getByLabelText(/^tier$/i), 'strong')
    expect(headings(container)).toEqual(['Bravo (1995)'])
    await userEvent.selectOptions(screen.getByLabelText(/^tier$/i), '')

    await userEvent.selectOptions(screen.getByLabelText(/^box$/i), 'box-b')
    expect(headings(container)).toEqual(['Bravo (1995)', 'Xray (1995)'])
    await userEvent.selectOptions(screen.getByLabelText(/^box$/i), '')

    await userEvent.click(screen.getByRole('checkbox', { name: /cross-box only/i }))
    expect(headings(container)).toEqual(['Xray (1995)'])
    await userEvent.click(screen.getByRole('checkbox', { name: /cross-box only/i }))

    await userEvent.selectOptions(screen.getByLabelText(/^h&r$/i), 'blocked')
    expect(headings(container)).toEqual(['Bravo (1995)'])
    await userEvent.selectOptions(screen.getByLabelText(/^h&r$/i), 'clear')
    expect(headings(container)).toEqual(['Alpha (1995)', 'Xray (1995)', 'Papa (1995)'])
  })

  it('searches titles, paths and torrent names', async () => {
    const { container } = render(<Duplicates api={api({
      duplicates: async () => response([
        group({ id: 'g1', title: 'Heat', reclaimableBytes: 2 }),
        group({ id: 'g2', title: 'Nosferatu', year: 1922, reclaimableBytes: 1, members: [
          member('c', { containerPath: '/movies/Nosferatu (1922)/c.mkv', torrent: torrent({ name: 'Nosferatu.1922.RESTORED.1080p' }) }),
          member('d', { containerPath: '/movies/Nosferatu (1922)/d.mkv' }),
        ], keeperItemId: 'd' }),
      ]),
    })} onQueue={() => {}} />)
    await screen.findByRole('heading', { name: 'Heat (1995)' })
    await userEvent.type(screen.getByLabelText(/search/i), 'restored')
    expect(headings(container)).toEqual(['Nosferatu (1922)'])
    await userEvent.clear(screen.getByLabelText(/search/i))
    await userEvent.type(screen.getByLabelText(/search/i), 'heat-2160')
    expect(headings(container)).toEqual(['Heat (1995)'])
  })

  it('member row shows box, torrent name, ratio, seed days, private and an H&R badge', async () => {
    render(<Duplicates api={api({
      duplicates: async () => response([group({ members: [
        member('a', {
          containerPath: '/movies/Heat-1080.mkv', instanceId: 'box-a', torrentCount: 1,
          torrent: torrent({ name: 'Heat.1995.1080p.BluRay.x264-GRP', ratio: 0.5234, seedingDays: 3.4, isPrivate: true, hnrMet: false, state: 'stalledUP' }),
        }),
        member('b', {
          containerPath: '/movies/Heat-2160.mkv', instanceId: 'box-b', torrentCount: 1,
          torrent: torrent({ instanceId: 'box-b', name: 'Heat.1995.2160p.WEB-DL', ratio: 2, seedingDays: 45, isPrivate: false, hnrMet: true, state: 'uploading' }),
        }),
      ] })]),
    })} onQueue={() => {}} />)
    const rowA = (await screen.findByText('/movies/Heat-1080.mkv')).closest('tr')!
    expect(within(rowA).getByText('box-a')).toBeInTheDocument()
    expect(within(rowA).getByText('Heat.1995.1080p.BluRay.x264-GRP')).toBeInTheDocument()
    expect(within(rowA).getByText('ratio 0.52')).toBeInTheDocument()
    expect(within(rowA).getByText(/3\.4 days/)).toBeInTheDocument()
    expect(within(rowA).getByText('private')).toBeInTheDocument()
    expect(within(rowA).getByText('H&R: blocked')).toBeInTheDocument()
    expect(within(rowA).getByText('stalledUP')).toBeInTheDocument()

    const rowB = screen.getByText('/movies/Heat-2160.mkv').closest('tr')!
    expect(within(rowB).getByText('box-b')).toBeInTheDocument()
    expect(within(rowB).getByText('ratio 2.00')).toBeInTheDocument()
    expect(within(rowB).getByText(/45\.0 days/)).toBeInTheDocument()
    expect(within(rowB).getByText('public')).toBeInTheDocument()
    expect(within(rowB).queryByText('H&R: blocked')).not.toBeInTheDocument()
    expect(within(rowB).getByText('uploading')).toBeInTheDocument()
  })

  it('says a cross-seeded copy is held by more than one torrent, and when a copy has no torrent at all', async () => {
    render(<Duplicates api={api({
      duplicates: async () => response([group({ members: [
        member('a', { containerPath: '/movies/Heat-1080.mkv', torrent: torrent(), torrentCount: 2 }),
        member('b', { containerPath: '/movies/Heat-2160.mkv', torrent: null, torrentCount: 0, instanceId: null }),
      ] })]),
    })} onQueue={() => {}} />)
    const rowA = (await screen.findByText('/movies/Heat-1080.mkv')).closest('tr')!
    expect(within(rowA).getByText(/2 torrents/i)).toBeInTheDocument()
    const rowB = screen.getByText('/movies/Heat-2160.mkv').closest('tr')!
    expect(within(rowB).getByText(/no torrent/i)).toBeInTheDocument()
  })

  it('says plainly when duplicate matching was not evaluated in the latest scan, never "no duplicates"', async () => {
    render(<Duplicates api={api({
      duplicates: async () => response([], { evaluated: false, reason: 'the scan failed before the rules phase' }),
    })} onQueue={() => {}} />)
    expect(await screen.findByText(/the scan failed before the rules phase/)).toBeInTheDocument()
    expect(screen.getByText(/not a clean bill of health/i)).toBeInTheDocument()
    expect(screen.queryByText(/no duplicate groups found/i)).not.toBeInTheDocument()
  })

  // --- Bulk queueing --------------------------------------------------------------------------

  const bulkGroups = () => [
    group({ id: 'g1', title: 'One', tier: 'exact', keeperItemId: 'b1', reclaimableBytes: 1, members: [
      member('a1', { containerPath: '/movies/One/a1.mkv', sizeBytes: 1_073_741_824 }), member('b1', { containerPath: '/movies/One/b1.mkv' }),
    ] }),
    group({ id: 'g2', title: 'Two', tier: 'possible', keeperItemId: 'b2', reclaimableBytes: 2, members: [
      member('a2', { containerPath: '/movies/Two/a2.mkv', sizeBytes: 2_147_483_648 }), member('b2', { containerPath: '/movies/Two/b2.mkv' }),
    ] }),
    group({ id: 'g3', title: 'Three', tier: 'exact', editionsDiffer: true, keeperItemId: 'b3', reclaimableBytes: 3, members: [
      member('a3', { containerPath: '/movies/Three/a3.mkv', sizeBytes: 4_294_967_296, edition: 'Extended' }),
      member('b3', { containerPath: '/movies/Three/b3.mkv', edition: 'Theatrical' }),
    ] }),
  ]

  it('bulk queue skips possible and editionsDiffer groups unless included', async () => {
    const onQueue = vi.fn()
    const first = render(<Duplicates api={api({ duplicates: async () => response(bulkGroups()) })} onQueue={onQueue} />)
    await userEvent.click(await screen.findByRole('button', { name: /queue non-keepers for 3 visible groups/i }))
    const dialog = await screen.findByRole('alertdialog', { name: /queue non-keepers/i })
    expect(dialog).toHaveTextContent(/1 file from 1 group/i)
    expect(dialog).toHaveTextContent('1.0 GB')
    expect(dialog).toHaveTextContent(/1 possible-tier group/i)
    expect(dialog).toHaveTextContent(/1 group whose editions differ/i)
    expect(onQueue).not.toHaveBeenCalled()
    await userEvent.click(within(dialog).getByRole('button', { name: /^queue 1 file$/i }))
    expect(onQueue).toHaveBeenCalledTimes(1)
    expect(onQueue).toHaveBeenCalledWith([{ type: 'delete-media', targetPath: '/movies/One/a1.mkv' }])
    first.unmount()

    onQueue.mockClear()
    render(<Duplicates api={api({ duplicates: async () => response(bulkGroups()) })} onQueue={onQueue} />)
    await userEvent.click(await screen.findByRole('checkbox', { name: /include possible-tier groups/i }))
    await userEvent.click(screen.getByRole('checkbox', { name: /include groups whose editions differ/i }))
    await userEvent.click(screen.getByRole('button', { name: /queue non-keepers for 3 visible groups/i }))
    const dialogAll = await screen.findByRole('alertdialog', { name: /queue non-keepers/i })
    expect(dialogAll).toHaveTextContent(/3 files from 3 groups/i)
    expect(dialogAll).toHaveTextContent('7.0 GB')
    await userEvent.click(within(dialogAll).getByRole('button', { name: /^queue 3 files$/i }))
    const sent = (onQueue.mock.calls[0]![0] as RequestedAction[]).map((a) => a.targetPath)
    expect(sent).toHaveLength(3)
    expect(new Set(sent)).toEqual(new Set(['/movies/One/a1.mkv', '/movies/Two/a2.mkv', '/movies/Three/a3.mkv']))
  })

  // Task 6 minor 4: deleting S01E01E02 as a "copy" of S01E01 loses E02 too.
  it('bulk queue skips a group holding a multi-episode file unless included', async () => {
    const withDouble = () => [
      bulkGroups()[0]!,
      group({ id: 'g4', title: 'Pilot', kind: 'episode', seriesName: 'Show', seasonNo: 1, episodeNo: 1, tier: 'strong',
        multiEpisode: true, keeperItemId: 'b4', reclaimableBytes: 4, members: [
          member('a4', { containerPath: '/tv/Show/Show.S01E01E02.mkv', sizeBytes: 1_073_741_824 }),
          member('b4', { containerPath: '/tv/Show/Show.S01E01.mkv' }),
        ] }),
    ]
    const onQueue = vi.fn()
    const first = render(<Duplicates api={api({ duplicates: async () => response(withDouble()) })} onQueue={onQueue} />)
    await userEvent.click(await screen.findByRole('button', { name: /queue non-keepers for 2 visible groups/i }))
    const dialog = await screen.findByRole('alertdialog', { name: /queue non-keepers/i })
    expect(dialog).toHaveTextContent(/1 file from 1 group/i)
    expect(dialog).toHaveTextContent(/1 group holding a multi-episode file/i)
    await userEvent.click(within(dialog).getByRole('button', { name: /^queue 1 file$/i }))
    expect(onQueue).toHaveBeenCalledWith([{ type: 'delete-media', targetPath: '/movies/One/a1.mkv' }])
    first.unmount()

    onQueue.mockClear()
    render(<Duplicates api={api({ duplicates: async () => response(withDouble()) })} onQueue={onQueue} />)
    await userEvent.click(await screen.findByRole('checkbox', { name: /include groups holding a multi-episode file/i }))
    await userEvent.click(screen.getByRole('button', { name: /queue non-keepers for 2 visible groups/i }))
    const dialogAll = await screen.findByRole('alertdialog', { name: /queue non-keepers/i })
    await userEvent.click(within(dialogAll).getByRole('button', { name: /^queue 2 files$/i }))
    expect(new Set((onQueue.mock.calls[0]![0] as RequestedAction[]).map((a) => a.targetPath)))
      .toEqual(new Set(['/movies/One/a1.mkv', '/tv/Show/Show.S01E01E02.mkv']))
  })

  it('says when a group holds a multi-episode file', async () => {
    render(<Duplicates api={api({
      duplicates: async () => response([group({ multiEpisode: true, kind: 'episode', seriesName: 'Show', seasonNo: 1, episodeNo: 1 })]),
    })} onQueue={() => {}} />)
    expect(await screen.findByText(/holds more than one episode/i)).toBeInTheDocument()
  })

  it('bulk queue covers only the groups the filters leave visible', async () => {
    const onQueue = vi.fn()
    render(<Duplicates api={api({ duplicates: async () => response(bulkGroups()) })} onQueue={onQueue} />)
    await userEvent.type(await screen.findByLabelText(/search/i), 'one')
    await userEvent.click(screen.getByRole('button', { name: /queue non-keepers for 1 visible group$/i }))
    await userEvent.click(within(await screen.findByRole('alertdialog', { name: /queue non-keepers/i })).getByRole('button', { name: /^queue 1 file$/i }))
    expect(onQueue).toHaveBeenCalledWith([{ type: 'delete-media', targetPath: '/movies/One/a1.mkv' }])
  })

  it('cancelling the bulk confirmation queues nothing', async () => {
    const onQueue = vi.fn()
    render(<Duplicates api={api({ duplicates: async () => response(bulkGroups()) })} onQueue={onQueue} />)
    await userEvent.click(await screen.findByRole('button', { name: /queue non-keepers for 3 visible groups/i }))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /^cancel$/i }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(onQueue).not.toHaveBeenCalled()
  })

  it('bulk queue never queues a group with no keeper, and never every copy of a group', async () => {
    const onQueue = vi.fn()
    render(<Duplicates api={api({
      duplicates: async () => response([
        group({ id: 'g1', title: 'One', keeperItemId: null, keeperPolicy: 'none', reclaimableBytes: 0, members: [
          member('a1', { containerPath: '/movies/One/a1.mkv' }), member('b1', { containerPath: '/movies/One/b1.mkv' }),
        ] }),
        // A keeper id that is no longer a member (its copy was deleted) is no keeper at all.
        group({ id: 'g2', title: 'Two', keeperItemId: 'gone', reclaimableBytes: 1, members: [
          member('a2', { containerPath: '/movies/Two/a2.mkv' }), member('b2', { containerPath: '/movies/Two/b2.mkv' }),
        ] }),
      ]),
    })} onQueue={onQueue} />)
    await userEvent.click(await screen.findByRole('button', { name: /queue non-keepers for 2 visible groups/i }))
    const dialog = await screen.findByRole('alertdialog', { name: /queue non-keepers/i })
    expect(dialog).toHaveTextContent(/2 groups with no keeper/i)
    expect(within(dialog).getByRole('button', { name: /^queue 0 files$/i })).toBeDisabled()
    expect(onQueue).not.toHaveBeenCalled()
  })

  it('bulk queue leaves out paths already in the queue', async () => {
    const onQueue = vi.fn()
    render(<Duplicates
      api={api({ duplicates: async () => response(bulkGroups()) })}
      onQueue={onQueue}
      queued={[{ type: 'delete-media', targetPath: '/movies/One/a1.mkv' }]}
    />)
    await userEvent.click(await screen.findByRole('checkbox', { name: /include possible-tier groups/i }))
    await userEvent.click(screen.getByRole('button', { name: /queue non-keepers for 3 visible groups/i }))
    const dialog = await screen.findByRole('alertdialog', { name: /queue non-keepers/i })
    expect(dialog).toHaveTextContent(/1 file from 1 group/i)
    expect(dialog).toHaveTextContent(/1 already queued/i)
    await userEvent.click(within(dialog).getByRole('button', { name: /^queue 1 file$/i }))
    expect(onQueue).toHaveBeenCalledWith([{ type: 'delete-media', targetPath: '/movies/Two/a2.mkv' }])
  })

  it('marks a copy that is already in the queue', async () => {
    render(<Duplicates api={api()} onQueue={() => {}} queued={[{ type: 'delete-media', targetPath: '/movies/Heat-1080.mkv' }]} />)
    const row = (await screen.findByText('/movies/Heat-1080.mkv')).closest('tr')!
    expect(within(row).getByText('queued')).toBeInTheDocument()
  })

  // --- Dismiss (persisted on the server since Plan 7) -------------------------------------------

  it('dismiss calls the API and removes the group', async () => {
    const dismissDuplicate = vi.fn(async () => undefined)
    const { container } = render(<Duplicates api={api({
      dismissDuplicate,
      duplicates: async () => response([group({ id: 'g1', reclaimableBytes: 2 }), group({ id: 'g2', title: 'Nosferatu', year: 1922, reclaimableBytes: 1 })]),
    })} onQueue={() => {}} />)
    await screen.findByRole('heading', { name: 'Heat (1995)' })
    await userEvent.click(within(sectionFor('Heat (1995)')).getByRole('button', { name: /^dismiss$/i }))
    expect(dismissDuplicate).toHaveBeenCalledWith('g1')
    await waitFor(() => expect(headings(container)).toEqual(['Nosferatu (1922)']))
  })

  it('undoes a dismissal by reopening the group through the API', async () => {
    const reopenDuplicate = vi.fn(async () => undefined)
    const { container } = render(<Duplicates api={api({ reopenDuplicate })} onQueue={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /^dismiss$/i }))
    await waitFor(() => expect(headings(container)).toEqual([]))
    await userEvent.click(await screen.findByRole('button', { name: /^undo$/i }))
    expect(reopenDuplicate).toHaveBeenCalledWith('g1')
    await waitFor(() => expect(headings(container)).toEqual(['Heat (1995)']))
  })

  it('keeps the group and says why when a dismissal fails', async () => {
    const dismissDuplicate = vi.fn(async () => { throw new Error('no such duplicate group') })
    const { container } = render(<Duplicates api={api({ dismissDuplicate })} onQueue={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /^dismiss$/i }))
    expect(await screen.findByText(/no such duplicate group/)).toBeInTheDocument()
    expect(headings(container)).toEqual(['Heat (1995)'])
  })

  // --- Coverage beyond the brief's given cases -------------------------------------------------

  it('never shows merge and delete with the same visual weight', async () => {
    render(<Duplicates api={api()} onQueue={() => {}} />)
    const mergeBtn = await screen.findByRole('button', { name: /merge versions/i })
    const deleteBtn = await screen.findByRole('button', { name: /delete non-keepers/i })
    expect(mergeBtn.className).not.toContain('btn-danger')
    expect(deleteBtn.className).toContain('btn-danger')
  })

  it('labels merge as reversible and delete as permanent at the point of decision', async () => {
    render(<Duplicates api={api()} onQueue={() => {}} />)
    expect(await screen.findByText(/reversible/i)).toBeInTheDocument()
    expect(await screen.findByText(/permanent/i)).toBeInTheDocument()
  })

  it('ties each action button to its own reversibility note via aria-describedby, not just DOM proximity', async () => {
    render(<Duplicates api={api()} onQueue={() => {}} />)
    const mergeBtn = await screen.findByRole('button', { name: /merge versions/i })
    const deleteBtn = screen.getByRole('button', { name: /delete non-keepers/i })
    const mergeNoteId = mergeBtn.getAttribute('aria-describedby')
    const deleteNoteId = deleteBtn.getAttribute('aria-describedby')
    expect(mergeNoteId).toBeTruthy()
    expect(deleteNoteId).toBeTruthy()
    expect(document.getElementById(mergeNoteId!)).toHaveTextContent(/reversible/i)
    expect(document.getElementById(deleteNoteId!)).toHaveTextContent(/permanent/i)
  })

  it('reloads the list after a successful merge, so a merged group drops out of view', async () => {
    let call = 0
    const duplicates = vi.fn(async () => {
      call += 1
      return call === 1 ? response([group()]) : response([])
    })
    const mergeGroup = vi.fn(async () => ({ merged: ['a', 'b'] }))
    render(<Duplicates api={api({ duplicates, mergeGroup })} onQueue={() => {}} />)
    await mergeThroughConfirmation()
    expect(await screen.findByText(/no duplicate groups/i)).toBeInTheDocument()
    expect(duplicates).toHaveBeenCalledTimes(2)
  })

  it('shows an error and keeps the group visible when a merge fails, rather than pretending it worked', async () => {
    const mergeGroup = vi.fn(async () => { throw new Error('duplicate group g1 was already merged') })
    render(<Duplicates api={api({ mergeGroup })} onQueue={() => {}} />)
    await mergeThroughConfirmation()
    expect(await screen.findByText(/already merged/i)).toBeInTheDocument()
    expect(screen.getByText('/movies/Heat-1080.mkv')).toBeInTheDocument()
  })

  it('keeps the last-good groups visible, with the error shown above them, when a reload fails', async () => {
    let call = 0
    const duplicates = vi.fn(async () => {
      call += 1
      if (call === 1) return response([group()])
      throw new Error('lost connection to the server')
    })
    const mergeGroup = vi.fn(async () => ({ merged: ['a', 'b'] }))
    render(<Duplicates api={api({ duplicates, mergeGroup })} onQueue={() => {}} />)
    await mergeThroughConfirmation()
    expect(await screen.findByText(/lost connection to the server/i)).toBeInTheDocument()
    expect(screen.getByText('/movies/Heat-1080.mkv')).toBeInTheDocument()
  })

  // The planner's keeper policy `none` (spec §6) leaves `keeperItemId` null: the operator picks.
  // A keeper id that names no member any more (its copy was deleted and so left the group) is the
  // same situation. Neither may silently promote some arbitrary member to keeper — and with no
  // keeper, nothing can be a "non-keeper", so nothing can be queued until a keeper is chosen.
  it('with no keeper, nothing is pre-selected and delete stays disabled until the operator picks one', async () => {
    const onQueue = vi.fn()
    render(<Duplicates api={api({
      duplicates: async () => response([group({ keeperItemId: null, keeperPolicy: 'none', reclaimableBytes: 0 })]),
    })} onQueue={onQueue} />)
    expect(await screen.findByText(/choose which copy to keep/i)).toBeInTheDocument()
    for (const radio of screen.getAllByRole('radio')) expect(radio).not.toBeChecked()
    expect(screen.queryByRole('checkbox', { name: /^delete /i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /delete non-keepers/i })).toBeDisabled()

    await userEvent.click(screen.getByRole('radio', { name: /keep .*Heat-2160/i }))
    await userEvent.click(await screen.findByRole('checkbox', { name: /delete .*Heat-1080/i }))
    await userEvent.click(screen.getByRole('button', { name: /delete non-keepers/i }))
    expect(onQueue).toHaveBeenCalledWith([{ type: 'delete-media', targetPath: '/movies/Heat-1080.mkv' }])
  })

  it('treats a recommended keeper that is no longer a member as no keeper at all', async () => {
    render(<Duplicates api={api({
      duplicates: async () => response([group({ keeperItemId: 'does-not-exist' })]),
    })} onQueue={() => {}} />)
    expect(await screen.findByText(/choose which copy to keep/i)).toBeInTheDocument()
    for (const radio of screen.getAllByRole('radio')) expect(radio).not.toBeChecked()
    expect(screen.getByRole('button', { name: /delete non-keepers/i })).toBeDisabled()
  })

  it('renders a hostile container path and torrent name as literal text, never as markup', async () => {
    const HOSTILE = '/movies/<img src=x onerror=alert(1)>.mkv'
    const HOSTILE_TORRENT = '<img src=y onerror=alert(2)>'
    render(<Duplicates api={api({
      duplicates: async () => response([group({ members: [
        member('a', { containerPath: HOSTILE, torrent: torrent({ name: HOSTILE_TORRENT }) }),
        member('b', { containerPath: '/movies/Heat-2160.mkv' }),
      ] })]),
    })} onQueue={() => {}} />)
    expect(await screen.findByText(HOSTILE)).toBeInTheDocument()
    expect(screen.getByText(HOSTILE_TORRENT)).toBeInTheDocument()
    expect(document.querySelector('img')).toBeNull()
  })

  it('toggles the why panel closed again on a second click', async () => {
    render(<Duplicates api={api()} onQueue={() => {}} />)
    const whyBtn = await screen.findByRole('button', { name: /why/i })
    await userEvent.click(whyBtn)
    expect(await screen.findByText(/resolution score/i)).toBeInTheDocument()
    await userEvent.click(whyBtn)
    await waitFor(() => expect(screen.queryByText(/resolution score/i)).not.toBeInTheDocument())
  })

  // --- Finding 1: tier weight must escalate, never de-escalate, with non-exact tiers ------------

  it('renders a possible-tier group with warning weight, never the quiet tag exact gets', async () => {
    render(<Duplicates api={api({ duplicates: async () => response([group({ tier: 'possible' })]) })} onQueue={() => {}} />)
    const tierTag = await screen.findByText('possible')
    expect(tierTag.className).toContain('tag-warn')
    expect(tierTag.className).not.toContain('tag-quiet')
  })

  it('explains a possible-tier match as a title-similarity hypothesis, not a confirmed duplicate', async () => {
    render(<Duplicates api={api({ duplicates: async () => response([group({ tier: 'possible' })]) })} onQueue={() => {}} />)
    expect(await screen.findByText(/title similarity/i)).toBeInTheDocument()
    expect(await screen.findByText(/hypothesis/i)).toBeInTheDocument()
  })

  it('gates Delete non-keepers behind an explicit acknowledgement for any tier other than exact', async () => {
    const onQueue = vi.fn()
    render(<Duplicates api={api({ duplicates: async () => response([group({ tier: 'possible' })]) })} onQueue={onQueue} />)
    await userEvent.click(await screen.findByRole('checkbox', { name: /delete .*Heat-1080/i }))
    const deleteBtn = screen.getByRole('button', { name: /delete non-keepers/i })
    expect(deleteBtn).toBeDisabled()
    expect(onQueue).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('checkbox', { name: /verified this is a real duplicate/i }))
    expect(deleteBtn).toBeEnabled()
    await userEvent.click(deleteBtn)
    expect(onQueue).toHaveBeenCalledWith([{ type: 'delete-media', targetPath: '/movies/Heat-1080.mkv' }])
  })

  it('does not require an acknowledgement for a hash-verified exact-tier group', async () => {
    render(<Duplicates api={api({
      duplicates: async () => response([group({ matchedBy: ['dupe.identical-file'] })]),
    })} onQueue={() => {}} />)
    expect(await screen.findByText('exact')).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: /verified this is a real duplicate/i })).not.toBeInTheDocument()
  })

  // MAJOR 1: `tier === 'exact'` alone does NOT mean byte-verified — `dupe.provider-id` and
  // `dupe.series-episode` both emit 'exact' from pure metadata (a shared TMDB/IMDB id, or a shared
  // series/season/episode key), never comparing file content. Only `dupe.identical-file` ever
  // compares files at all (and only via a sampled head/tail hash). So the acknowledgement gate must
  // key off `matchedBy` (the evidence), not off the tier label.

  it('requires an acknowledgement for an exact-tier group matched by provider ID alone, a metadata-only match', async () => {
    const onQueue = vi.fn()
    render(<Duplicates api={api({
      duplicates: async () => response([group({ matchedBy: ['dupe.provider-id'] })]),
    })} onQueue={onQueue} />)
    expect(await screen.findByText('exact')).toBeInTheDocument()
    await userEvent.click(await screen.findByRole('checkbox', { name: /delete .*Heat-1080/i }))
    const deleteBtn = screen.getByRole('button', { name: /delete non-keepers/i })
    expect(deleteBtn).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: /verified this is a real duplicate/i })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('checkbox', { name: /verified this is a real duplicate/i }))
    expect(deleteBtn).toBeEnabled()
    await userEvent.click(deleteBtn)
    expect(onQueue).toHaveBeenCalledWith([{ type: 'delete-media', targetPath: '/movies/Heat-1080.mkv' }])
  })

  it('requires an acknowledgement for an exact-tier group matched by series/episode alone, a metadata-only match', async () => {
    render(<Duplicates api={api({
      duplicates: async () => response([group({ matchedBy: ['dupe.series-episode'] })]),
    })} onQueue={() => {}} />)
    expect(await screen.findByRole('checkbox', { name: /verified this is a real duplicate/i })).toBeInTheDocument()
  })

  it('still requires an acknowledgement when a hash match is diluted by a weaker link in the same group', async () => {
    // `buildDupeGroups` sets a group's tier to the MAXIMUM confidence over every link, so one weak
    // link can ride along with a real hash match and the whole group still reads 'exact'. Only a
    // group whose EVERY contributing matcher is `dupe.identical-file` may skip the acknowledgement.
    render(<Duplicates api={api({
      duplicates: async () => response([group({ matchedBy: ['dupe.identical-file', 'dupe.fuzzy-title'] })]),
    })} onQueue={() => {}} />)
    expect(await screen.findByRole('checkbox', { name: /verified this is a real duplicate/i })).toBeInTheDocument()
  })

  it('surfaces which matcher(s) actually produced a group, so an operator can see a weak link riding along a strong one', async () => {
    render(<Duplicates api={api({
      duplicates: async () => response([group({ matchedBy: ['dupe.provider-id', 'dupe.fuzzy-title'] })]),
    })} onQueue={() => {}} />)
    // The plain-fact "Matched by: ..." line — distinct from the warning-style caveat paragraph,
    // which also mentions the matcher names but is worded as a warning, not a neutral fact.
    const matchedByLine = await screen.findByText(/^matched by: /i)
    expect(matchedByLine).toHaveTextContent(/provider id/i)
    expect(matchedByLine).toHaveTextContent(/fuzzy title/i)
  })

  it('states plainly that a file-hash match is a sampled comparison, not proof of a full byte-for-byte match', async () => {
    render(<Duplicates api={api({
      duplicates: async () => response([group({ matchedBy: ['dupe.identical-file'] })]),
    })} onQueue={() => {}} />)
    expect(await screen.findByText(/sampled/i)).toBeInTheDocument()
    expect(screen.getByText(/byte-for-byte/i)).toBeInTheDocument()
    // The whole point: this is the one case that must NOT require the acknowledgement.
    expect(screen.queryByRole('checkbox', { name: /verified this is a real duplicate/i })).not.toBeInTheDocument()
  })

  it('says when the members of a group are different editions, and tags each copy with its edition', async () => {
    render(<Duplicates api={api({
      duplicates: async () => response([group({ editionsDiffer: true, members: [
        member('a', { containerPath: '/movies/Heat-1080.mkv', edition: 'Extended' }),
        member('b', { containerPath: '/movies/Heat-2160.mkv', edition: 'Theatrical' }),
      ] })]),
    })} onQueue={() => {}} />)
    expect(await screen.findByText(/different editions/i)).toBeInTheDocument()
    const row = screen.getByText('/movies/Heat-1080.mkv').closest('tr')!
    expect(within(row).getByText('Extended')).toBeInTheDocument()
  })

  // --- Finding 2: deletion is per-row opt-in; nothing is doomed by default -----------------------

  it('queues only the non-keepers the operator explicitly checks, and none by default', async () => {
    const onQueue = vi.fn()
    render(<Duplicates api={api()} onQueue={onQueue} />)
    const deleteBtn = await screen.findByRole('button', { name: /delete non-keepers/i })
    expect(deleteBtn).toBeDisabled()
    await userEvent.click(deleteBtn)
    expect(onQueue).not.toHaveBeenCalled()
    await userEvent.click(await screen.findByRole('checkbox', { name: /delete .*Heat-1080/i }))
    expect(deleteBtn).toBeEnabled()
    await userEvent.click(deleteBtn)
    expect(onQueue).toHaveBeenCalledTimes(1)
    expect(onQueue).toHaveBeenCalledWith([{ type: 'delete-media', targetPath: '/movies/Heat-1080.mkv' }])
  })

  it('lets the operator delete one non-keeper while explicitly keeping another, in a cross-library split', async () => {
    const onQueue = vi.fn()
    render(<Duplicates api={api({
      duplicates: async () => response([group({
        tier: 'exact', keeperItemId: 'b',
        members: [
          member('a', { containerPath: '/movies/Heat-1080.mkv', height: 1080, libraryName: 'Movies' }),
          member('b', { containerPath: '/movies-4k/Heat-2160.mkv', height: 2160, libraryName: 'Movies 4K' }),
          member('c', { containerPath: '/movies/Heat-old.mkv', height: 480, libraryName: 'Movies' }),
        ],
      })]),
    })} onQueue={onQueue} />)
    expect(await screen.findByText(/across libraries/i)).toBeInTheDocument()
    // Deliberately leave the intentional 4K copy (in the other library) unchecked.
    await userEvent.click(await screen.findByRole('checkbox', { name: /delete .*Heat-old/i }))
    await userEvent.click(screen.getByRole('button', { name: /delete non-keepers/i }))
    expect(onQueue).toHaveBeenCalledWith([{ type: 'delete-media', targetPath: '/movies/Heat-old.mkv' }])
  })

  it('starts with no delete checkbox checked', async () => {
    render(<Duplicates api={api()} onQueue={() => {}} />)
    const checkbox = await screen.findByRole('checkbox', { name: /delete .*Heat-1080/i })
    expect(checkbox).not.toBeChecked()
  })

  it('clears delete checkboxes after a data refresh, not just at initial render', async () => {
    const secondGroup = group({
      id: 'g2', title: 'Other', keeperItemId: 'd', reclaimableBytes: 1,
      scores: { c: { total: 900, breakdown: { resolution: 500 } }, d: { total: 1800, breakdown: { resolution: 1000 } } },
      members: [
        member('c', { name: 'Other', containerPath: '/movies/Other-1080.mkv' }),
        member('d', { name: 'Other', containerPath: '/movies/Other-2160.mkv', height: 2160 }),
      ],
    })
    let call = 0
    const duplicates = vi.fn(async () => {
      call += 1
      return call === 1 ? response([group(), secondGroup]) : response([secondGroup])
    })
    const mergeGroup = vi.fn(async () => ({ merged: ['a', 'b'] }))
    render(<Duplicates api={api({ duplicates, mergeGroup })} onQueue={() => {}} />)
    const otherCheckbox = await screen.findByRole('checkbox', { name: /delete .*Other-1080/i })
    await userEvent.click(otherCheckbox)
    expect(otherCheckbox).toBeChecked()
    await mergeThroughConfirmation(0)
    await waitFor(() => expect(duplicates).toHaveBeenCalledTimes(2))
    const otherCheckboxAfter = await screen.findByRole('checkbox', { name: /delete .*Other-1080/i })
    expect(otherCheckboxAfter).not.toBeChecked()
  })

  it('never queues a member with no known container path, and marks it explicitly instead of dropping it silently', async () => {
    const onQueue = vi.fn()
    render(<Duplicates api={api({
      duplicates: async () => response([group({
        keeperItemId: 'b',
        members: [
          member('a', { containerPath: null }),
          member('b', { containerPath: '/movies/Heat-2160.mkv', height: 2160 }),
        ],
      })]),
    })} onQueue={onQueue} />)
    expect(await screen.findByText(/cannot be queued/i)).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: /delete .*Heat/i })).not.toBeInTheDocument()
    const deleteBtn = screen.getByRole('button', { name: /delete non-keepers/i })
    expect(deleteBtn).toBeDisabled()
    await userEvent.click(deleteBtn)
    expect(onQueue).not.toHaveBeenCalled()
  })

  it('reports a skipped no-path non-keeper in the delete confirmation, alongside whatever was actually queued', async () => {
    const onQueue = vi.fn()
    render(<Duplicates api={api({
      duplicates: async () => response([group({
        keeperItemId: 'c',
        members: [
          member('a', { containerPath: null }),
          member('b', { containerPath: '/movies/Heat-1080.mkv' }),
          member('c', { containerPath: '/movies/Heat-2160.mkv', height: 2160 }),
        ],
      })]),
    })} onQueue={onQueue} />)
    await userEvent.click(await screen.findByRole('checkbox', { name: /delete .*Heat-1080/i }))
    await userEvent.click(screen.getByRole('button', { name: /delete non-keepers/i }))
    expect(onQueue).toHaveBeenCalledWith([{ type: 'delete-media', targetPath: '/movies/Heat-1080.mkv' }])
    expect(await screen.findByText(/skipped 1/i)).toBeInTheDocument()
  })

  // --- Finding 5: the destructive control must produce a visible, non-repeatable effect ----------

  it('shows an inline confirmation naming the queued paths and count after Delete non-keepers', async () => {
    render(<Duplicates api={api()} onQueue={() => {}} />)
    await userEvent.click(await screen.findByRole('checkbox', { name: /delete .*Heat-1080/i }))
    await userEvent.click(screen.getByRole('button', { name: /delete non-keepers/i }))
    const confirmation = await screen.findByText(/queued 1/i)
    expect(confirmation).toHaveTextContent(/Heat-1080\.mkv/)
  })

  it('disables Delete non-keepers after queueing so a second click cannot double-queue the same selection', async () => {
    const onQueue = vi.fn()
    render(<Duplicates api={api()} onQueue={onQueue} />)
    await userEvent.click(await screen.findByRole('checkbox', { name: /delete .*Heat-1080/i }))
    const deleteBtn = screen.getByRole('button', { name: /delete non-keepers/i })
    await userEvent.click(deleteBtn)
    expect(onQueue).toHaveBeenCalledTimes(1)
    expect(deleteBtn).toBeDisabled()
    await userEvent.click(deleteBtn)
    expect(onQueue).toHaveBeenCalledTimes(1)
  })

  it('re-enables Delete non-keepers once the checked selection changes after queueing, and sends only the newly-checked path, never a repeat of what is already queued', async () => {
    // MINOR 2 regression: a superset re-queue used to re-send every already-queued path too, so
    // checking A, queueing, then also checking C and queueing again sent [A, C] the second time —
    // duplicating A. The fix tracks queued PATHS per group and sends only the not-yet-queued
    // difference.
    const onQueue = vi.fn()
    render(<Duplicates api={api({
      duplicates: async () => response([group({
        keeperItemId: 'b',
        members: [
          member('a', { containerPath: '/movies/Heat-1080.mkv' }),
          member('b', { containerPath: '/movies/Heat-2160.mkv', height: 2160 }),
          member('c', { containerPath: '/movies/Heat-720.mkv', height: 720 }),
        ],
      })]),
    })} onQueue={onQueue} />)
    await userEvent.click(await screen.findByRole('checkbox', { name: /delete .*Heat-1080/i }))
    const deleteBtn = screen.getByRole('button', { name: /delete non-keepers/i })
    await userEvent.click(deleteBtn)
    expect(onQueue).toHaveBeenCalledTimes(1)
    expect(onQueue).toHaveBeenLastCalledWith([{ type: 'delete-media', targetPath: '/movies/Heat-1080.mkv' }])
    expect(deleteBtn).toBeDisabled()
    await userEvent.click(await screen.findByRole('checkbox', { name: /delete .*Heat-720/i }))
    expect(deleteBtn).toBeEnabled()
    await userEvent.click(deleteBtn)
    expect(onQueue).toHaveBeenCalledTimes(2)
    // Only the newly-checked path, never Heat-1080 again.
    expect(onQueue).toHaveBeenLastCalledWith([{ type: 'delete-media', targetPath: '/movies/Heat-720.mkv' }])
    const allPaths = (onQueue.mock.calls.flat(2) as Array<{ targetPath: string }>).map((a) => a.targetPath)
    expect(new Set(allPaths).size).toBe(allPaths.length)
  })

  it('clears a stale delete confirmation when the keeper choice changes afterward', async () => {
    const onQueue = vi.fn()
    render(<Duplicates api={api()} onQueue={onQueue} />)
    await userEvent.click(await screen.findByRole('checkbox', { name: /delete .*Heat-1080/i }))
    await userEvent.click(screen.getByRole('button', { name: /delete non-keepers/i }))
    expect(await screen.findByText(/queued 1/i)).toBeInTheDocument()
    await userEvent.click(await screen.findByRole('radio', { name: /keep .*Heat-1080/i }))
    expect(screen.queryByText(/queued 1/i)).not.toBeInTheDocument()
  })

  // --- Finding 7: the two tables must never name the same copy differently -----------------------

  it('names a no-path member the same way in the member table and the Why table', async () => {
    render(<Duplicates api={api({
      duplicates: async () => response([group({
        keeperItemId: 'b',
        members: [
          member('b', { containerPath: '/movies/Heat-2160.mkv', height: 2160 }),
          member('a', { name: 'Heat Extended Cut', containerPath: null }),
        ],
      })]),
    })} onQueue={() => {}} />)
    expect(await screen.findAllByText('Heat Extended Cut')).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: /why/i }))
    expect(await screen.findAllByText('Heat Extended Cut')).toHaveLength(2)
  })

  it('shows the audio channel count as a plain fact on the member row', async () => {
    render(<Duplicates api={api({
      duplicates: async () => response([group({ members: [
        member('a', { containerPath: '/movies/Heat-1080.mkv', audioChannels: 2 }),
        member('b', { containerPath: '/movies/Heat-2160.mkv', height: 2160, audioChannels: 8 }),
      ] })]),
    })} onQueue={() => {}} />)
    const rowA = (await screen.findByText('/movies/Heat-1080.mkv')).closest('tr')!
    const rowB = screen.getByText('/movies/Heat-2160.mkv').closest('tr')!
    expect(within(rowB).getByText('8')).toBeInTheDocument()
    expect(within(rowA).getByText('2')).toBeInTheDocument()
  })
})
