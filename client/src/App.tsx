import { useCallback, useEffect, useState } from 'react'
import type { Api, RequestedAction } from './api.js'
import { Login } from './screens/Login.js'
import { Dashboard } from './screens/Dashboard.js'
import { Findings } from './screens/Findings.js'
import { Duplicates } from './screens/Duplicates.js'
import { Explorer } from './screens/Explorer.js'
import { PlanScreen } from './screens/PlanScreen.js'
import { History } from './screens/History.js'
import { Settings } from './screens/Settings.js'

const NAV_ITEMS = ['Dashboard', 'Findings', 'Duplicates', 'Explorer', 'Plan', 'History', 'Settings'] as const
type NavItem = (typeof NAV_ITEMS)[number]

type AuthState =
  | { kind: 'checking' }
  | { kind: 'anonymous' }
  | { kind: 'authenticated'; username: string }

/** Identity for de-duplicating a queued action: same type, same target path, same item ids. A
 * NUL byte separates the fields (not a plain comma or space) so a `targetPath` that happens to
 * contain one cannot collide with a different `itemIds` split — the same join-collision
 * reasoning `findingId` (src/core/types.ts) uses elsewhere in this codebase. */
function queuedActionKey(a: RequestedAction): string {
  return [a.type, a.targetPath ?? '', (a.itemIds ?? []).join(',')].join('\0')
}

/**
 * The auth gate for the whole app. `/api/auth/me` only ever answers 200 (a live session) or 401
 * (no session) — see src/api/auth.ts — so any failure of that check is treated as "show the login
 * screen", and any success renders the shell. There is no third state to reconcile.
 */
export function App({ api }: { api: Api }) {
  const [auth, setAuth] = useState<AuthState>({ kind: 'checking' })
  const [screen, setScreen] = useState<NavItem>('Dashboard')

  /**
   * The queue Findings, Duplicates and Explorer all feed and the Plan screen builds from — lifted
   * here, one level above every screen that touches it, for exactly one reason: switching nav tabs
   * mounts and unmounts the screen components (see the single-branch render below), and a queue
   * held in any one of THEM would silently evaporate the moment the operator looked at another
   * screen before visiting Plan. A queue that empties itself on navigation would make the whole
   * queue-then-plan discipline this app is built on untrustworthy, so the one piece of state that
   * must outlive every screen switch lives in the component that itself never unmounts.
   *
   * `addToQueue` APPENDS rather than replaces: an operator building one plan out of a duplicate
   * queued on the Duplicates screen and a stray file queued on Explorer needs both to still be
   * there when they reach Plan, not just whichever screen queued something most recently.
   *
   * It also DE-DUPLICATES on `(type, targetPath, itemIds)`, and does so HERE rather than trusting
   * any one screen to catch it: every screen's own "already queued" receipt (History's
   * `queuedUndos`, Duplicates' `queuedFor`, Findings' selection, Explorer's `selected` map) is
   * component-local state, so it resets the moment that screen unmounts. An operator who queues the
   * same undo, the same duplicate or the same stray file twice from two visits to the same screen —
   * or once each from two different screens naming the same target — must still see it once in the
   * plan, not twice paying for the same bytes or double-submitting the same Jellyfin call.
   */
  const [queued, setQueued] = useState<RequestedAction[]>([])
  const addToQueue = useCallback((actions: RequestedAction[]) => {
    setQueued((prev) => {
      const seen = new Set(prev.map(queuedActionKey))
      const next = [...prev]
      for (const action of actions) {
        const key = queuedActionKey(action)
        if (seen.has(key)) continue
        seen.add(key)
        next.push(action)
      }
      return next
    })
  }, [])
  const clearQueue = useCallback(() => setQueued([]), [])

  /**
   * The plan a build produced (or an operator reopened from History) — lifted beside `queued` for
   * the identical reason: PlanScreen's own `plan`/`summary` state does not survive a tab switch,
   * so without this, navigating away and back after a build (or after Approve, or after Execute)
   * showed the pre-build "nothing queued" screen again, inviting a second `createPlan` against
   * files a first, already-executed plan had just removed. PlanScreen refetches whatever this
   * names via `api.getPlan` on its own mount; it never re-derives it from `queued`.
   */
  const [planId, setPlanId] = useState<string | null>(null)
  const openPlan = useCallback((id: string) => {
    setPlanId(id)
    setScreen('Plan')
  }, [])

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
        {/* Exactly one branch renders at a time — switching tabs unmounts the previous screen
            rather than merely hiding it, which is why `queued` above cannot live inside any of
            these components. */}
        {screen === 'Dashboard' ? <Dashboard api={api} /> : null}
        {screen === 'Findings' ? <Findings api={api} onQueue={addToQueue} /> : null}
        {screen === 'Duplicates' ? <Duplicates api={api} onQueue={addToQueue} /> : null}
        {screen === 'Explorer' ? <Explorer api={api} onQueue={addToQueue} /> : null}
        {screen === 'Plan' ? (
          <PlanScreen api={api} queued={queued} onClear={clearQueue} planId={planId} onPlanIdChange={setPlanId} />
        ) : null}
        {screen === 'History' ? <History api={api} onQueue={addToQueue} onOpenPlan={openPlan} /> : null}
        {screen === 'Settings' ? <Settings api={api} /> : null}
      </main>
    </div>
  )
}
