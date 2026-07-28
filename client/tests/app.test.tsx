import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../src/App.js'
import { ApiError } from '../src/api.js'

const api = (over: Record<string, unknown> = {}) => ({
  me: vi.fn(async () => { throw new ApiError(401, 'not authenticated') }),
  logout: vi.fn(async () => ({ ok: true as const })),
  login: vi.fn(async () => ({ username: 'bob' })),
  ...over,
} as never)

describe('App', () => {
  it('shows the login screen when there is no session', async () => {
    render(<App api={api()} />)
    expect(await screen.findByLabelText(/username/i)).toBeInTheDocument()
  })

  it('shows the shell and nav once a session exists', async () => {
    render(<App api={api({ me: vi.fn(async () => ({ username: 'bob', userId: 'u1' })) })} />)
    expect(await screen.findByRole('button', { name: /sign out/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /dashboard/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /findings/i })).toBeInTheDocument()
    expect(screen.getByText('bob')).toBeInTheDocument()
  })

  it('moves from login to the shell after a successful sign-in', async () => {
    render(<App api={api()} />)
    await userEvent.type(await screen.findByLabelText(/username/i), 'bob')
    await userEvent.type(screen.getByLabelText(/password/i), 'pw')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    expect(await screen.findByRole('button', { name: /sign out/i })).toBeInTheDocument()
  })

  it('returns to the login screen after signing out', async () => {
    render(<App api={api({ me: vi.fn(async () => ({ username: 'bob', userId: 'u1' })) })} />)
    await userEvent.click(await screen.findByRole('button', { name: /sign out/i }))
    expect(await screen.findByLabelText(/username/i)).toBeInTheDocument()
  })

  it('renders a hostile jellyfin username as text only', async () => {
    render(<App api={api({ me: vi.fn(async () => ({ username: '<img src=x onerror=alert(1)>', userId: 'u1' })) })} />)
    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeInTheDocument()
    expect(document.querySelector('img')).toBeNull()
  })
})
