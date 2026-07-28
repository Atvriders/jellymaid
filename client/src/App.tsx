import { useCallback, useEffect, useState } from 'react'
import type { Api } from './api.js'
import { Login } from './screens/Login.js'

const NAV_ITEMS = ['Dashboard', 'Findings', 'Duplicates', 'Explorer', 'Plan', 'History', 'Settings'] as const
type NavItem = (typeof NAV_ITEMS)[number]

type AuthState =
  | { kind: 'checking' }
  | { kind: 'anonymous' }
  | { kind: 'authenticated'; username: string }

/**
 * The auth gate for the whole app. `/api/auth/me` only ever answers 200 (a live session) or 401
 * (no session) — see src/api/auth.ts — so any failure of that check is treated as "show the login
 * screen", and any success renders the shell. There is no third state to reconcile.
 */
export function App({ api }: { api: Api }) {
  const [auth, setAuth] = useState<AuthState>({ kind: 'checking' })
  const [screen, setScreen] = useState<NavItem>('Dashboard')

  const checkSession = useCallback(() => {
    setAuth({ kind: 'checking' })
    api.me()
      .then((res) => setAuth({ kind: 'authenticated', username: res.username }))
      .catch(() => setAuth({ kind: 'anonymous' }))
  }, [api])

  useEffect(() => { checkSession() }, [checkSession])

  async function handleLogout() {
    try {
      await api.logout()
    } finally {
      // The shell must not be trusted to stay up if the logout call itself fails (e.g. the
      // network drops mid-request) — the operator asked to leave, so leave locally regardless,
      // and let the next authenticated call 401 and re-surface the login screen if the server
      // session actually outlived the request.
      setAuth({ kind: 'anonymous' })
    }
  }

  if (auth.kind === 'checking') {
    return <div className="app-loading" role="status">Loading Jellymaid…</div>
  }

  if (auth.kind === 'anonymous') {
    return <Login api={api} onSuccess={(username) => setAuth({ kind: 'authenticated', username })} />
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <span className="wordmark">Jellymaid</span>
        <nav className="nav" aria-label="Sections">
          {NAV_ITEMS.map((item) => (
            <button
              key={item}
              type="button"
              className={item === screen ? 'nav-tab nav-tab-active' : 'nav-tab'}
              aria-current={item === screen ? 'page' : undefined}
              onClick={() => setScreen(item)}
            >
              {item}
            </button>
          ))}
        </nav>
        <div className="session">
          {/* The signed-in username comes from Jellyfin, an external system — a text node only. */}
          <span className="session-user">{auth.username}</span>
          <button type="button" className="btn btn-quiet" onClick={() => void handleLogout()}>
            Sign out
          </button>
        </div>
      </header>
      <main className="main">
        <ScreenPlaceholder name={screen} />
      </main>
    </div>
  )
}

/**
 * Dashboard, Findings, Duplicates, Explorer, Plan, History and Settings are built in later tasks
 * of this same plan (Tasks 3-6). This keeps the shell honest about what is wired up rather than
 * hiding the gap, instead of a screen that looks finished but does nothing.
 */
function ScreenPlaceholder({ name }: { name: NavItem }) {
  return (
    <div className="screen-placeholder">
      <h2>{name}</h2>
      <p className="empty">This screen is not wired up yet.</p>
    </div>
  )
}
