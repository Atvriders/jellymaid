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

  it('lets the operator choose a different keeper, then queue the newly-non-keeper copy', async () => {
    const onQueue = vi.fn()
    render(<Duplicates api={api()} onQueue={onQueue} />)
    await userEvent.click(await screen.findByRole('radio', { name: /keep .*Heat-1080/i }))
    await userEvent.click(await screen.findByRole('checkbox', { name: /delete .*Heat-2160/i }))
    await userEvent.click(screen.getByRole('button', { name: /delete non-keepers/i }))
    expect(onQueue).toHaveBeenCalledWith([{ type: 'delete-media', targetPath: '/mnt/m/Heat-2160.mkv' }])
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

  it('keeps the last-good groups visible, with the error shown above them, when a reload fails', async () => {
    let call = 0
    const duplicates = vi.fn(async () => {
      call += 1
      if (call === 1) return { groups: [group()] }
      throw new Error('lost connection to the server')
    })
    const mergeGroup = vi.fn(async () => ({ merged: ['a', 'b'] }))
    render(<Duplicates api={api({ duplicates, mergeGroup })} onQueue={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /merge versions/i }))
    expect(await screen.findByText(/lost connection to the server/i)).toBeInTheDocument()
    expect(screen.getByText('/mnt/m/Heat-1080.mkv')).toBeInTheDocument()
  })

  it('falls back to a real member as keeper if the server-recommended keeper id is not among the members', async () => {
    const onQueue = vi.fn()
    render(<Duplicates api={api({
      duplicates: async () => ({ groups: [group({ keeperItemId: 'does-not-exist' })] }),
    })} onQueue={onQueue} />)
    // The fallback keeper is the first member (a, Heat-1080), so b (Heat-2160) is the non-keeper.
    await userEvent.click(await screen.findByRole('checkbox', { name: /delete .*Heat-2160/i }))
    await userEvent.click(screen.getByRole('button', { name: /delete non-keepers/i }))
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

  // --- Finding 1: tier weight must escalate, never de-escalate, with non-exact tiers ------------

  it('renders a possible-tier group with warning weight, never the quiet tag exact gets', async () => {
    render(<Duplicates api={api({ duplicates: async () => ({ groups: [group({ tier: 'possible' })] }) })} onQueue={() => {}} />)
    const tierTag = await screen.findByText('possible')
    expect(tierTag.className).toContain('tag-warn')
    expect(tierTag.className).not.toContain('tag-quiet')
  })

  it('explains a possible-tier match as a title-similarity hypothesis, not a confirmed duplicate', async () => {
    render(<Duplicates api={api({ duplicates: async () => ({ groups: [group({ tier: 'possible' })] }) })} onQueue={() => {}} />)
    expect(await screen.findByText(/title similarity/i)).toBeInTheDocument()
    expect(await screen.findByText(/hypothesis/i)).toBeInTheDocument()
  })

  it('gates Delete non-keepers behind an explicit acknowledgement for any tier other than exact', async () => {
    const onQueue = vi.fn()
    render(<Duplicates api={api({ duplicates: async () => ({ groups: [group({ tier: 'possible' })] }) })} onQueue={onQueue} />)
    await userEvent.click(await screen.findByRole('checkbox', { name: /delete .*Heat-1080/i }))
    const deleteBtn = screen.getByRole('button', { name: /delete non-keepers/i })
    expect(deleteBtn).toBeDisabled()
    expect(onQueue).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('checkbox', { name: /verified this is a real duplicate/i }))
    expect(deleteBtn).toBeEnabled()
    await userEvent.click(deleteBtn)
    expect(onQueue).toHaveBeenCalledWith([{ type: 'delete-media', targetPath: '/mnt/m/Heat-1080.mkv' }])
  })

  it('does not require an acknowledgement for an exact-tier group', async () => {
    render(<Duplicates api={api()} onQueue={() => {}} />)
    expect(screen.queryByRole('checkbox', { name: /verified this is a real duplicate/i })).not.toBeInTheDocument()
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
    expect(onQueue).toHaveBeenCalledWith([{ type: 'delete-media', targetPath: '/mnt/m/Heat-1080.mkv' }])
  })

  it('lets the operator delete one non-keeper while explicitly keeping another, in a cross-library split', async () => {
    const onQueue = vi.fn()
    render(<Duplicates api={api({
      duplicates: async () => ({ groups: [group({
        tier: 'exact', keeperItemId: 'b',
        members: [
          { id: 'a', name: 'Heat', container_path: '/mnt/m/Heat-1080.mkv', size_bytes: 1, height: 1080, library_name: 'Movies' },
          { id: 'b', name: 'Heat', container_path: '/mnt/n/Heat-2160.mkv', size_bytes: 1, height: 2160, library_name: 'Movies 4K' },
          { id: 'c', name: 'Heat', container_path: '/mnt/m/Heat-old.mkv', size_bytes: 1, height: 480, library_name: 'Movies' },
        ],
      })] }),
    })} onQueue={onQueue} />)
    expect(await screen.findByText(/across libraries/i)).toBeInTheDocument()
    // Deliberately leave the intentional 4K copy (in the other library) unchecked.
    await userEvent.click(await screen.findByRole('checkbox', { name: /delete .*Heat-old/i }))
    await userEvent.click(screen.getByRole('button', { name: /delete non-keepers/i }))
    expect(onQueue).toHaveBeenCalledWith([{ type: 'delete-media', targetPath: '/mnt/m/Heat-old.mkv' }])
  })

  it('starts with no delete checkbox checked', async () => {
    render(<Duplicates api={api()} onQueue={() => {}} />)
    const checkbox = await screen.findByRole('checkbox', { name: /delete .*Heat-1080/i })
    expect(checkbox).not.toBeChecked()
  })

  it('clears delete checkboxes after a data refresh, not just at initial render', async () => {
    const secondGroup = {
      id: 'g2', tier: 'exact', keeperItemId: 'd',
      scores: { c: { total: 900, breakdown: { resolution: 500 } }, d: { total: 1800, breakdown: { resolution: 1000 } } },
      members: [
        { id: 'c', name: 'Other', container_path: '/mnt/m/Other-1080.mkv', size_bytes: 1, height: 1080, library_name: 'Movies' },
        { id: 'd', name: 'Other', container_path: '/mnt/m/Other-2160.mkv', size_bytes: 1, height: 2160, library_name: 'Movies' },
      ],
    }
    let call = 0
    const duplicates = vi.fn(async () => {
      call += 1
      return call === 1 ? { groups: [group(), secondGroup] } : { groups: [secondGroup] }
    })
    const mergeGroup = vi.fn(async () => ({ merged: ['a', 'b'] }))
    render(<Duplicates api={api({ duplicates, mergeGroup })} onQueue={() => {}} />)
    const otherCheckbox = await screen.findByRole('checkbox', { name: /delete .*Other-1080/i })
    await userEvent.click(otherCheckbox)
    expect(otherCheckbox).toBeChecked()
    const mergeButtons = await screen.findAllByRole('button', { name: /merge versions/i })
    await userEvent.click(mergeButtons[0]!)
    await waitFor(() => expect(duplicates).toHaveBeenCalledTimes(2))
    const otherCheckboxAfter = await screen.findByRole('checkbox', { name: /delete .*Other-1080/i })
    expect(otherCheckboxAfter).not.toBeChecked()
  })

  it('never queues a member with no known container path, and marks it explicitly instead of dropping it silently', async () => {
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
      duplicates: async () => ({ groups: [group({
        keeperItemId: 'c',
        members: [
          { id: 'a', name: 'Heat', container_path: null, size_bytes: 1, height: 1080, library_name: 'Movies' },
          { id: 'b', name: 'Heat', container_path: '/mnt/m/Heat-1080.mkv', size_bytes: 1, height: 1080, library_name: 'Movies' },
          { id: 'c', name: 'Heat', container_path: '/mnt/m/Heat-2160.mkv', size_bytes: 1, height: 2160, library_name: 'Movies' },
        ],
      })] }),
    })} onQueue={onQueue} />)
    await userEvent.click(await screen.findByRole('checkbox', { name: /delete .*Heat-1080/i }))
    await userEvent.click(screen.getByRole('button', { name: /delete non-keepers/i }))
    expect(onQueue).toHaveBeenCalledWith([{ type: 'delete-media', targetPath: '/mnt/m/Heat-1080.mkv' }])
    expect(await screen.findByText(/skipped 1/i)).toBeInTheDocument()
  })

  // --- Finding 3 is covered above by the aria-describedby test -----------------------------------

  // --- Finding 4: Dismiss is honestly session-scoped, and reversible -----------------------------

  it('hides a group from view for this session only, without calling any api', async () => {
    const dismissFinding = vi.fn(async () => ({ ok: true as const }))
    render(<Duplicates api={api({ dismissFinding })} onQueue={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /hide.*session/i }))
    expect(await screen.findByText(/hidden for this session/i)).toBeInTheDocument()
    expect(screen.queryByText(/^no duplicate groups found\.?$/i)).not.toBeInTheDocument()
    expect(dismissFinding).not.toHaveBeenCalled()
  })

  it('lets the operator un-hide groups they hid earlier this session', async () => {
    render(<Duplicates api={api()} onQueue={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /hide.*session/i }))
    expect(await screen.findByText(/hidden for this session/i)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /show hidden/i }))
    expect(await screen.findByText('exact')).toBeInTheDocument()
    expect(screen.queryByText(/all \d+ duplicate group/i)).not.toBeInTheDocument()
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

  it('re-enables Delete non-keepers once the checked selection changes after queueing', async () => {
    const onQueue = vi.fn()
    render(<Duplicates api={api({
      duplicates: async () => ({ groups: [group({
        keeperItemId: 'b',
        members: [
          { id: 'a', name: 'Heat', container_path: '/mnt/m/Heat-1080.mkv', size_bytes: 1, height: 1080, library_name: 'Movies' },
          { id: 'b', name: 'Heat', container_path: '/mnt/m/Heat-2160.mkv', size_bytes: 1, height: 2160, library_name: 'Movies' },
          { id: 'c', name: 'Heat', container_path: '/mnt/m/Heat-720.mkv', size_bytes: 1, height: 720, library_name: 'Movies' },
        ],
      })] }),
    })} onQueue={onQueue} />)
    await userEvent.click(await screen.findByRole('checkbox', { name: /delete .*Heat-1080/i }))
    const deleteBtn = screen.getByRole('button', { name: /delete non-keepers/i })
    await userEvent.click(deleteBtn)
    expect(onQueue).toHaveBeenCalledTimes(1)
    expect(deleteBtn).toBeDisabled()
    await userEvent.click(await screen.findByRole('checkbox', { name: /delete .*Heat-720/i }))
    expect(deleteBtn).toBeEnabled()
    await userEvent.click(deleteBtn)
    expect(onQueue).toHaveBeenCalledTimes(2)
    expect(onQueue).toHaveBeenLastCalledWith([
      { type: 'delete-media', targetPath: '/mnt/m/Heat-1080.mkv' },
      { type: 'delete-media', targetPath: '/mnt/m/Heat-720.mkv' },
    ])
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
      duplicates: async () => ({ groups: [group({
        keeperItemId: 'b',
        members: [
          { id: 'b', name: 'Heat', container_path: '/mnt/m/Heat-2160.mkv', size_bytes: 1, height: 2160, library_name: 'Movies' },
          { id: 'a', name: 'Heat Extended Cut', container_path: null, size_bytes: 1, height: 1080, library_name: 'Movies' },
        ],
      })] }),
    })} onQueue={() => {}} />)
    expect(await screen.findAllByText('Heat Extended Cut')).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: /why/i }))
    expect(await screen.findAllByText('Heat Extended Cut')).toHaveLength(2)
  })

  it('shows the audio channel count as a plain fact on the member row', async () => {
    render(<Duplicates api={api({
      duplicates: async () => ({ groups: [group({ members: [
        { id: 'a', name: 'Heat', container_path: '/mnt/m/Heat-1080.mkv', size_bytes: 1, height: 1080, audio_channels: 2, library_name: 'Movies' },
        { id: 'b', name: 'Heat', container_path: '/mnt/m/Heat-2160.mkv', size_bytes: 1, height: 2160, audio_channels: 8, library_name: 'Movies' },
      ] })] }),
    })} onQueue={() => {}} />)
    expect(await screen.findByText('8')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
  })
})
