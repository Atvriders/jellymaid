import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Login } from '../src/screens/Login.js'
import { ApiError } from '../src/api.js'

const api = (login: (u: string, p: string) => Promise<{ username: string }>) => ({ login } as never)

describe('Login', () => {
  it('submits the username and password', async () => {
    const login = vi.fn(async () => ({ username: 'bob' }))
    render(<Login api={api(login)} onSuccess={() => {}} />)
    await userEvent.type(screen.getByLabelText(/username/i), 'bob')
    await userEvent.type(screen.getByLabelText(/password/i), 'pw')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    expect(login).toHaveBeenCalledWith('bob', 'pw')
  })

  it('calls onSuccess with the username', async () => {
    const onSuccess = vi.fn()
    render(<Login api={api(async () => ({ username: 'bob' }))} onSuccess={onSuccess} />)
    await userEvent.type(screen.getByLabelText(/username/i), 'bob')
    await userEvent.type(screen.getByLabelText(/password/i), 'pw')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    expect(onSuccess).toHaveBeenCalledWith('bob')
  })

  it('shows the admin-required message on 403 rather than a generic failure', async () => {
    render(<Login api={api(async () => { throw new ApiError(403, 'a Jellyfin administrator account is required') })} onSuccess={() => {}} />)
    await userEvent.type(screen.getByLabelText(/username/i), 'eve')
    await userEvent.type(screen.getByLabelText(/password/i), 'pw')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    expect(await screen.findByText(/administrator account is required/i)).toBeInTheDocument()
  })

  it('distinguishes a lockout from bad credentials', async () => {
    render(<Login api={api(async () => { throw new ApiError(429, 'too many failed attempts') })} onSuccess={() => {}} />)
    await userEvent.type(screen.getByLabelText(/username/i), 'bob')
    await userEvent.type(screen.getByLabelText(/password/i), 'x')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    expect(await screen.findByText(/too many failed attempts/i)).toBeInTheDocument()
  })

  it('says Jellyfin is unreachable on 503', async () => {
    render(<Login api={api(async () => { throw new ApiError(503, 'Jellyfin is unreachable') })} onSuccess={() => {}} />)
    await userEvent.type(screen.getByLabelText(/username/i), 'bob')
    await userEvent.type(screen.getByLabelText(/password/i), 'x')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    expect(await screen.findByText(/unreachable/i)).toBeInTheDocument()
  })

  it('never renders the typed password anywhere but the password input', async () => {
    render(<Login api={api(async () => { throw new ApiError(401, 'invalid credentials') })} onSuccess={() => {}} />)
    await userEvent.type(screen.getByLabelText(/password/i), 'hunter2')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    const input = screen.getByLabelText(/password/i) as HTMLInputElement
    expect(input.type).toBe('password')
    expect(document.body.textContent).not.toContain('hunter2')
  })

  it('renders a hostile username back only as text, never as markup', async () => {
    render(<Login api={api(async () => { throw new ApiError(401, 'invalid credentials') })} onSuccess={() => {}} />)
    await userEvent.type(screen.getByLabelText(/username/i), '<img src=x onerror=alert(1)>')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    await screen.findByText(/invalid credentials/i)
    expect(document.querySelector('img')).toBeNull()
  })

  it('renders a hostile server error message as text, never as markup', async () => {
    render(<Login api={api(async () => { throw new ApiError(500, '<img src=x onerror=alert(1)>') })} onSuccess={() => {}} />)
    await userEvent.type(screen.getByLabelText(/username/i), 'bob')
    await userEvent.type(screen.getByLabelText(/password/i), 'pw')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeInTheDocument()
    expect(document.querySelector('img')).toBeNull()
  })
})
