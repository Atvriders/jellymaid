import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Duplicates } from '../src/screens/Duplicates.js'

const group = (over = {}) => ({
  id: 'g1', tier: 'exact', keeperItemId: 'b',
  scores: { a: { total: 900, breakdown: { resolution: 500 } }, b: { total: 1800, breakdown: { resolution: 1000 } } },
  members: [
    { id: 'a', name: 'Heat', container_path: '/mnt/m/Heat-1080.mkv', size_bytes: 8_000_000_000, height: 1080, bitrate: 8_000_000, video_codec: 'h264', library_name: 'Movies' },
    { id: 'b', name: 'Heat', container_path: '/mnt/m/Heat-2160.mkv', size_bytes: 40_000_000_000, height: 2160, bitrate: 40_000_000, video_codec: 'hevc', library_name: 'Movies' },
  ],
  ...over,
})

const api = (over = {}) => ({
  duplicates: async () => ({ groups: [group()] }),
  mergeGroup: vi.fn(async () => ({ merged: ['a', 'b'] })),
  dismissFinding: vi.fn(async () => ({ ok: true as const })),
  ...over,
} as never)

describe('Duplicates', () => {
  it('shows the tier and every member side by side', async () => {
    render(<Duplicates api={api()} onQueue={() => {}} />)
    expect(await screen.findByText('exact')).toBeInTheDocument()
    expect(await screen.findByText('/mnt/m/Heat-1080.mkv')).toBeInTheDocument()
    expect(await screen.findByText('/mnt/m/Heat-2160.mkv')).toBeInTheDocument()
  })

  it('marks the pre-selected keeper', async () => {
    render(<Duplicates api={api()} onQueue={() => {}} />)
    const keeperRow = (await screen.findByText('/mnt/m/Heat-2160.mkv')).closest('tr')!
    expect(keeperRow).toHaveAttribute('data-keeper', 'true')
  })

  it('lets the operator choose a different keeper', async () => {
    const onQueue = vi.fn()
    render(<Duplicates api={api()} onQueue={onQueue} />)
    await userEvent.click(await screen.findByRole('radio', { name: /keep .*Heat-1080/i }))
    await userEvent.click(screen.getByRole('button', { name: /delete non-keepers/i }))
    expect(onQueue).toHaveBeenCalledWith([{ type: 'delete-media', targetPath: '/mnt/m/Heat-2160.mkv' }])
  })

  it('queues every non-keeper by default', async () => {
    const onQueue = vi.fn()
    render(<Duplicates api={api()} onQueue={onQueue} />)
    await userEvent.click(await screen.findByRole('button', { name: /delete non-keepers/i }))
    expect(onQueue).toHaveBeenCalledWith([{ type: 'delete-media', targetPath: '/mnt/m/Heat-1080.mkv' }])
  })

  it('merges versions through the api', async () => {
    const mergeGroup = vi.fn(async () => ({ merged: ['a', 'b'] }))
    render(<Duplicates api={api({ mergeGroup })} onQueue={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /merge versions/i }))
    expect(mergeGroup).toHaveBeenCalledWith('g1')
  })

  it('shows the score breakdown so the keeper choice is auditable', async () => {
    render(<Duplicates api={api()} onQueue={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /why/i }))
    expect(await screen.findByText(/resolution/i)).toBeInTheDocument()
  })

  it('flags a cross-library group', async () => {
    render(<Duplicates api={api({
      duplicates: async () => ({ groups: [group({ members: [
        { id: 'a', name: 'Heat', container_path: '/mnt/m/a.mkv', size_bytes: 1, height: 1080, library_name: 'Movies' },
        { id: 'b', name: 'Heat', container_path: '/mnt/n/b.mkv', size_bytes: 1, height: 1080, library_name: 'Movies 4K' },
      ] })] }),
    })} onQueue={() => {}} />)
    expect(await screen.findByText(/across libraries/i)).toBeInTheDocument()
  })

  it('shows an empty state when there are no duplicates', async () => {
    render(<Duplicates api={api({ duplicates: async () => ({ groups: [] }) })} onQueue={() => {}} />)
    expect(await screen.findByText(/no duplicate groups/i)).toBeInTheDocument()
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

  it('dismisses a group from view locally without calling the findings api', async () => {
    const dismissFinding = vi.fn(async () => ({ ok: true as const }))
    render(<Duplicates api={api({ dismissFinding })} onQueue={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /^dismiss$/i }))
    expect(await screen.findByText(/no duplicate groups/i)).toBeInTheDocument()
    expect(dismissFinding).not.toHaveBeenCalled()
  })

  it('reloads the list after a successful merge, so a merged group drops out of view', async () => {
    let call = 0
    const duplicates = vi.fn(async () => {
      call += 1
      return call === 1 ? { groups: [group()] } : { groups: [] }
    })
    const mergeGroup = vi.fn(async () => ({ merged: ['a', 'b'] }))
    render(<Duplicates api={api({ duplicates, mergeGroup })} onQueue={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /merge versions/i }))
    expect(await screen.findByText(/no duplicate groups/i)).toBeInTheDocument()
    expect(duplicates).toHaveBeenCalledTimes(2)
  })

  it('shows an error and keeps the group visible when a merge fails, rather than pretending it worked', async () => {
    const mergeGroup = vi.fn(async () => { throw new Error('duplicate group g1 was already merged') })
    render(<Duplicates api={api({ mergeGroup })} onQueue={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /merge versions/i }))
    expect(await screen.findByText(/already merged/i)).toBeInTheDocument()
    expect(screen.getByText('/mnt/m/Heat-1080.mkv')).toBeInTheDocument()
  })

  it('never queues a member with no known container path', async () => {
    const onQueue = vi.fn()
    render(<Duplicates api={api({
      duplicates: async () => ({ groups: [group({
        keeperItemId: 'b',
        members: [
          { id: 'a', name: 'Heat', container_path: null, size_bytes: 1, height: 1080, library_name: 'Movies' },
          { id: 'b', name: 'Heat', container_path: '/mnt/m/Heat-2160.mkv', size_bytes: 1, height: 2160, library_name: 'Movies' },
        ],
      })] }),
    })} onQueue={onQueue} />)
    await userEvent.click(await screen.findByRole('button', { name: /delete non-keepers/i }))
    expect(onQueue).toHaveBeenCalledWith([])
  })

  it('falls back to a real member as keeper if the server-recommended keeper id is not among the members', async () => {
    const onQueue = vi.fn()
    render(<Duplicates api={api({
      duplicates: async () => ({ groups: [group({ keeperItemId: 'does-not-exist' })] }),
    })} onQueue={onQueue} />)
    await userEvent.click(await screen.findByRole('button', { name: /delete non-keepers/i }))
    // Falls back to the first member as keeper rather than treating every member as a non-keeper
    // (which would queue deletion of the entire group, including the only good copy).
    expect(onQueue).toHaveBeenCalledWith([{ type: 'delete-media', targetPath: '/mnt/m/Heat-2160.mkv' }])
  })

  it('renders a hostile container path as literal text, never as markup', async () => {
    const HOSTILE = '/mnt/m/<img src=x onerror=alert(1)>.mkv'
    render(<Duplicates api={api({
      duplicates: async () => ({ groups: [group({ members: [
        { id: 'a', name: 'Heat', container_path: HOSTILE, size_bytes: 1, height: 1080, video_codec: 'h264', library_name: 'Movies' },
        { id: 'b', name: 'Heat', container_path: '/mnt/m/Heat-2160.mkv', size_bytes: 1, height: 2160, video_codec: 'hevc', library_name: 'Movies' },
      ] })] }),
    })} onQueue={() => {}} />)
    expect(await screen.findByText(HOSTILE)).toBeInTheDocument()
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
})
