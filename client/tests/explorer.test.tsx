import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Explorer, actionForEntry } from '../src/screens/Explorer.js'

const rootEntry = (over = {}) => ({
  name: '/mnt/m', path: '/mnt/m', isDir: true, sizeBytes: 500, fileCount: 2, isMedia: false, flags: [], ...over,
})

const fileEntry = (over = {}) => ({
  name: 'Heat.mkv', path: '/mnt/m/Heat.mkv', isDir: false, sizeBytes: 500, fileCount: 0, isMedia: true, flags: [], ...over,
})

const api = (over: Record<string, unknown> = {}) => ({
  explorer: vi.fn(async (path?: string) => {
    if (!path) return { path: '', parent: null, entries: [rootEntry()] }
    if (path === '/mnt/m') return { path: '/mnt/m', parent: null, entries: [fileEntry()] }
    return { path, parent: '/mnt/m', entries: [] }
  }),
  ...over,
} as never)

describe('Explorer', () => {
  it('renders entries returned for the current path', async () => {
    render(<Explorer api={api()} onQueue={() => {}} />)
    expect(await screen.findByText('/mnt/m')).toBeInTheDocument()
  })

  it('descends into a directory on click, fetching its children', async () => {
    const explorer = vi.fn(async (path?: string) => {
      if (!path) return { path: '', parent: null, entries: [rootEntry()] }
      return { path: '/mnt/m', parent: null, entries: [fileEntry()] }
    })
    render(<Explorer api={api({ explorer })} onQueue={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /mnt\/m/ }))
    expect(explorer).toHaveBeenCalledWith('/mnt/m', { offset: 0, limit: 500 })
    expect(await screen.findByText('Heat.mkv')).toBeInTheDocument()
  })

  it('shows an up row only when the server reports a non-null parent', async () => {
    // At the root listing (parent: null) there is nothing to go up to.
    render(<Explorer api={api()} onQueue={() => {}} />)
    await screen.findByText('/mnt/m')
    expect(screen.queryByRole('button', { name: /up/i })).not.toBeInTheDocument()
  })

  it('shows an up row that navigates to the parent once inside a directory', async () => {
    const explorer = vi.fn(async (path?: string) => {
      if (!path) return { path: '', parent: null, entries: [rootEntry()] }
      if (path === '/mnt/m') return { path: '/mnt/m', parent: null, entries: [{ ...rootEntry({ name: 'Heat', path: '/mnt/m/Heat', fileCount: 1 }) }] }
      if (path === '/mnt/m/Heat') return { path: '/mnt/m/Heat', parent: '/mnt/m', entries: [fileEntry()] }
      throw new Error(`unexpected path ${path}`)
    })
    render(<Explorer api={api({ explorer })} onQueue={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /mnt\/m/ }))
    await userEvent.click(await screen.findByRole('button', { name: 'Heat' }))
    const upButton = await screen.findByRole('button', { name: /up/i })
    await userEvent.click(upButton)
    expect(explorer).toHaveBeenLastCalledWith('/mnt/m', { offset: 0, limit: 500 })
  })

  it('renders a flag chip for a flagged entry', async () => {
    render(<Explorer api={api({
      explorer: async () => ({ path: '/mnt/m', parent: null, entries: [fileEntry({ flags: ['orphan'] })] }),
    })} onQueue={() => {}} />)
    expect(await screen.findByText('orphan')).toBeInTheDocument()
  })

  it('renders a hostile filename as text only, never as markup', async () => {
    const HOSTILE = '<img src=x onerror=alert(1)>.mkv'
    render(<Explorer api={api({
      explorer: async () => ({ path: '/mnt/m', parent: null, entries: [fileEntry({ name: HOSTILE, path: `/mnt/m/${HOSTILE}` })] }),
    })} onQueue={() => {}} />)
    expect(await screen.findByText(HOSTILE)).toBeInTheDocument()
    expect(document.querySelector('img')).toBeNull()
  })

  it('queues a delete-media action for a selected orphaned file, mirroring how Findings queues actions', async () => {
    const onQueue = vi.fn()
    render(<Explorer api={api({
      explorer: async () => ({ path: '/mnt/m', parent: null, entries: [fileEntry({ flags: ['orphan'] })] }),
    })} onQueue={onQueue} />)
    await userEvent.click(await screen.findByRole('checkbox', { name: /select heat\.mkv/i }))
    await userEvent.click(screen.getByRole('button', { name: /add to plan/i }))
    expect(onQueue).toHaveBeenCalledWith([{ type: 'delete-media', targetPath: '/mnt/m/Heat.mkv' }])
  })

  it('offers no checkbox for an entry with nothing actionable', async () => {
    render(<Explorer api={api({
      explorer: async () => ({ path: '/mnt/m', parent: null, entries: [fileEntry({ flags: [] })] }),
    })} onQueue={() => {}} />)
    await screen.findByText('Heat.mkv')
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })
})

describe('Explorer paging', () => {
  // A flat downloads directory can hold thousands of entries; the server pages it (C12: offset,
  // limit, total) and the screen must say how much there is and let the operator walk it.
  const paged = vi.fn(async (path?: string, page: { offset?: number; limit?: number } = {}) => {
    if (!path) return { path: '', parent: null, entries: [rootEntry({ name: '/downloads', path: '/downloads' })] }
    const offset = page.offset ?? 0
    const limit = page.limit ?? 500
    return {
      path: '/downloads', parent: null, total: 1_200, offset, limit,
      entries: [offset, offset + 1].map((n) => fileEntry({ name: `f${n}.mkv`, path: `/downloads/f${n}.mkv` })),
    }
  })

  it('explorer pages with offset/limit and shows the total', async () => {
    render(<Explorer api={api({ explorer: paged })} onQueue={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: '/downloads' }))
    expect(paged).toHaveBeenLastCalledWith('/downloads', { offset: 0, limit: 500 })
    expect(await screen.findByText(/1–500 of 1,200 entries/)).toBeInTheDocument()
    expect(screen.getByText('f0.mkv')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /^next$/i }))
    expect(paged).toHaveBeenLastCalledWith('/downloads', { offset: 500, limit: 500 })
    expect(await screen.findByText(/501–1,000 of 1,200 entries/)).toBeInTheDocument()
    expect(screen.getByText('f500.mkv')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /^next$/i }))
    expect(await screen.findByText(/1,001–1,200 of 1,200 entries/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^next$/i })).toBeDisabled()
  })

  it('starts a newly opened directory from its first page', async () => {
    render(<Explorer api={api({ explorer: paged })} onQueue={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: '/downloads' }))
    await userEvent.click(await screen.findByRole('button', { name: /^next$/i }))
    await screen.findByText(/501–1,000 of 1,200 entries/)
    await userEvent.click(screen.getByRole('button', { name: /^roots$/i }))
    await userEvent.click(await screen.findByRole('button', { name: '/downloads' }))
    expect(paged).toHaveBeenLastCalledWith('/downloads', { offset: 0, limit: 500 })
    expect(await screen.findByText(/1–500 of 1,200 entries/)).toBeInTheDocument()
  })

  it('keeps a selection made on one page when the operator pages on', async () => {
    const onQueue = vi.fn()
    const flagged = vi.fn(async (_path?: string, page: { offset?: number; limit?: number } = {}) => {
      const offset = page.offset ?? 0
      return {
        path: '/downloads', parent: null, total: 1_000, offset, limit: page.limit ?? 500,
        entries: [fileEntry({ name: `junk${offset}.nfo`, path: `/downloads/junk${offset}.nfo`, flags: ['junk'] })],
      }
    })
    render(<Explorer api={api({ explorer: flagged })} onQueue={onQueue} />)
    await userEvent.click(await screen.findByRole('checkbox', { name: /select junk0\.nfo/i }))
    await userEvent.click(screen.getByRole('button', { name: /^next$/i }))
    await userEvent.click(await screen.findByRole('checkbox', { name: /select junk500\.nfo/i }))
    await userEvent.click(screen.getByRole('button', { name: /add to plan/i }))
    expect(onQueue).toHaveBeenCalledWith([
      { type: 'delete-junk-file', targetPath: '/downloads/junk0.nfo' },
      { type: 'delete-junk-file', targetPath: '/downloads/junk500.nfo' },
    ])
  })
})

describe('actionForEntry', () => {
  it('maps an orphan flag to delete-media', () => {
    expect(actionForEntry({ path: '/mnt/m/x.mkv', flags: ['orphan'] }))
      .toEqual({ type: 'delete-media', targetPath: '/mnt/m/x.mkv' })
  })

  it('maps a junk flag to delete-junk-file', () => {
    expect(actionForEntry({ path: '/mnt/m/x.nfo', flags: ['junk'] }))
      .toEqual({ type: 'delete-junk-file', targetPath: '/mnt/m/x.nfo' })
  })

  it('maps an empty flag to remove-empty-folder', () => {
    expect(actionForEntry({ path: '/mnt/m/EmptyDir', flags: ['empty'] }))
      .toEqual({ type: 'remove-empty-folder', targetPath: '/mnt/m/EmptyDir' })
  })

  it('queues nothing for a missing-file flag — there is no file there to act on', () => {
    expect(actionForEntry({ path: '/mnt/m/gone.mkv', flags: ['missing'] })).toBeNull()
  })

  it('queues nothing for an entry with no flags at all', () => {
    expect(actionForEntry({ path: '/mnt/m/plain.mkv', flags: [] })).toBeNull()
  })
})
