import { useState, type FormEvent } from 'react'
import type { Api } from '../api.js'
import { ApiError } from '../api.js'

/**
 * The server distinguishes four failure shapes for a login attempt (see auth.ts / lockout.ts):
 * a bad credential (401), a non-admin account (403), a lockout (429), and an unreachable Jellyfin
 * (503, which — unlike the other three — costs the operator no lockout attempt). Each has a
 * different remedy, so each gets its own label here rather than one generic "sign-in failed".
 */
function kindLabel(status: number): string {
  if (status === 401) return 'Invalid'
  if (status === 403) return 'Not permitted'
  if (status === 429) return 'Locked out'
  // Deliberately not the word "unreachable" itself: the server's own message already says that,
  // and a category label repeating the message verbatim would just be noise next to it.
  if (status === 503) return 'Connection'
  return 'Error'
}

export function Login({ api, onSuccess }: { api: Pick<Api, 'login'>; onSuccess: (username: string) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<{ status: number; message: string } | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await api.login(username, password)
      // The typed password never needs to be held onto past this point — clear it whether the
      // component keeps rendering (it won't, once onSuccess swaps in the shell) or not.
      setPassword('')
      onSuccess(res.username)
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0
      const message = err instanceof Error ? err.message : 'sign-in failed'
      setError({ status, message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-page">
      <form className="login" onSubmit={submit}>
        <h1>Jellymaid</h1>

        {error ? (
          <p className="alert" role="alert">
            <span className="alert-kind">{kindLabel(error.status)}</span>
            {/* err.message is server text (or a fetch failure message) — a text node only. */}
            <span>{error.message}</span>
          </p>
        ) : null}

        <div className="field">
          <label htmlFor="username">Username</label>
          <input
            id="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
          />
        </div>

        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </div>

        <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy}>
          Sign in
        </button>

        <p className="hint">Sign in with a Jellyfin administrator account.</p>
      </form>
    </div>
  )
}
