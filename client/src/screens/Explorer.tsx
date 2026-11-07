import { useState } from 'react'
import type { Api, ExplorerEntry, RequestedAction } from '../api.js'
import { useAsync } from '../hooks.js'
import { Bytes, EmptyState, Pager } from '../components/index.js'

type ExplorerApi = Pick<Api, 'explorer'>

/** Entries per page. The server answers at most 1,000 (C12); 500 is also its own default. */
const EXPLORER_PAGE_SIZE = 500

/**
 * The read-only ground-truth screen: it browses the INDEX (fast at 100k+ entries — see
 * src/api/explorer.ts), never the live filesystem, and never deletes anything itself. Selecting a
 * flagged row only ever queues an action for the Plan screen to build, approve and execute later —
 * exactly the same two-step "queue, then plan" discipline Findings uses, never a direct delete.
 *
 * Deliberately NOT one-flag-per-action-type via a table: a real entry could in principle carry
 * more than one open flag (e.g. junk AND orphan), and only one action can be queued per row, so
 * this picks the single most consequential one — the ordering below is deliberate, most
 * destructive first, and mirrors the priority a human inspecting the row would reach for.
 */
export function actionForEntry(e: { path: string; flags: string[] }): RequestedAction | null {
  if (e.flags.includes('orphan')) return { type: 'delete-media', targetPath: e.path }
  if (e.flags.includes('junk')) return { type: 'delete-junk-file', targetPath: e.path }
  if (e.flags.includes('empty')) return { type: 'remove-empty-folder', targetPath: e.path }
  // 'missing' means a Jellyfin item's file is not there — there is nothing on disk at this path
  // to act on, so it stays purely informational, same as an unflagged entry.
  return null
}

/**
 * Same escalating-weight tag vocabulary SeverityBadge uses elsewhere in this app (critical->block,
 * warning->warn, info->quiet) — reused rather than invented fresh, per src/rules/filesystem/index.ts's
 * own severities for the rules each flag is derived from (fs.missing-file is 'critical',
 * fs.orphan-media/fs.junk are 'warning', fs.empty-folder is 'info').
 */
function flagTagClass(flag: string): string {
  if (flag === 'missing') return 'tag tag-block'
  if (flag === 'orphan' || flag === 'junk') return 'tag tag-warn'
  return 'tag tag-quiet' // 'empty', and anything not yet in the vocabulary
}

/** Every non-empty `/`-separated segment of `path`, paired with the cumulative path clicking it
 * would navigate to. Empty for the root listing (`path === ''`), which has nothing to break down. */
function breadcrumbSegments(path: string): Array<{ label: string; path: string }> {
  if (!path) return []
  let acc = ''
  return path.split('/').filter(Boolean).map((label) => {
    acc += `/${label}`
    return { label, path: acc }
  })
}

export function Explorer({ api, onQueue }: { api: ExplorerApi; onQueue: (actions: RequestedAction[]) => void }) {
  const [path, setPath] = useState<string | undefined>(undefined)
  // A directory can hold thousands of entries (a flat downloads folder), so it is read a page at a
  // time; opening any directory starts again at its first page.
  const [offset, setOffset] = useState(0)
  const list = useAsync(() => api.explorer(path, { offset, limit: EXPLORER_PAGE_SIZE }), [path, offset])

  function open(next: string | undefined) {
    setPath(next)
    setOffset(0)
  }

  // Keyed by path and populated at SELECTION time (not looked up again at queue time): navigating
  // to a different directory replaces `list.data.entries` entirely, so a plain set of selected ids
  // could not be turned back into actions once its directory was no longer the one on screen. This
  // also means a selection made in one folder survives navigating into another — an operator can
  // walk several directories, marking flagged files as they go, then queue everything at once.
  const [selected, setSelected] = useState<Map<string, RequestedAction>>(new Map())

  function toggleSelected(entry: ExplorerEntry) {
    const action = actionForEntry(entry)
    if (!action) return
    setSelected((prev) => {
      const next = new Map(prev)
      if (next.has(entry.path)) next.delete(entry.path)
      else next.set(entry.path, action)
      return next
    })
  }

  function handleAddToPlan() {
    onQueue([...selected.values()])
    setSelected(new Map())
  }

  const parent = list.data?.parent ?? null

  return (
    <div className="explorer">
      <nav className="explorer-breadcrumb" aria-label="Path">
        <button type="button" className="btn btn-quiet" onClick={() => open(undefined)}>
          Roots
        </button>
        {list.data
          ? breadcrumbSegments(list.data.path).map((seg, i, all) => (
              <span key={seg.path} className="explorer-crumb">
                <span className="explorer-crumb-sep" aria-hidden="true">/</span>
                {i === all.length - 1 ? (
                  // The label is a real path segment straight from the walked filesystem — a
                  // torrent-named directory in practice — rendered as a text node only.
                  <span className="explorer-crumb-current">{seg.label}</span>
                ) : (
                  <button type="button" className="btn btn-quiet" onClick={() => open(seg.path)}>
                    {seg.label}
                  </button>
                )}
              </span>
            ))
          : null}
      </nav>

      {/* `total` comes with every listing below a root; the roots listing is complete as sent. */}
      {list.data && !list.error && list.data.total !== undefined ? (
        <Pager
          offset={list.data.offset ?? offset}
          limit={list.data.limit ?? EXPLORER_PAGE_SIZE}
          total={list.data.total}
          noun={['entry', 'entries']}
          onOffset={setOffset}
        />
      ) : null}

      {list.error ? (
        <p className="alert" role="alert"><span>{list.error}</span></p>
      ) : !list.data ? (
        <EmptyState>Loading…</EmptyState>
      ) : list.data.entries.length === 0 && parent === null && !list.data.total ? (
        <EmptyState>Nothing here.</EmptyState>
      ) : (
        <table className="table explorer-table">
          <thead>
            <tr>
              <th scope="col">Queue</th>
              <th scope="col">Name</th>
              <th scope="col">Size</th>
              <th scope="col">Files</th>
              <th scope="col">Flags</th>
            </tr>
          </thead>
          <tbody>
            {parent !== null ? (
              <tr className="explorer-up-row">
                <td />
                <td>
                  <button type="button" className="btn btn-quiet" onClick={() => open(parent)}>
                    Up one level
                  </button>
                </td>
                <td />
                <td />
                <td />
              </tr>
            ) : null}
            {list.data.entries.map((entry) => {
              const action = actionForEntry(entry)
              return (
                <tr key={entry.path}>
                  <td>
                    {action ? (
                      <input
                        type="checkbox"
                        aria-label={`Select ${entry.name}`}
                        checked={selected.has(entry.path)}
                        onChange={() => toggleSelected(entry)}
                      />
                    ) : (
                      <span className="not-queueable" title="Nothing to queue for this entry">—</span>
                    )}
                  </td>
                  <td>
                    {entry.isDir ? (
                      // A directory or file name comes straight off the scanned filesystem — a
                      // torrent-named directory is attacker-influenced text in practice — rendered
                      // as a text node only, here as a plain button label, never as markup.
                      <button type="button" className="btn btn-quiet explorer-dir" onClick={() => open(entry.path)}>
                        {entry.name}
                      </button>
                    ) : (
                      <span className="subject-path">{entry.name}</span>
                    )}
                  </td>
                  <td><Bytes value={entry.sizeBytes} /></td>
                  <td>{entry.isDir ? entry.fileCount : '—'}</td>
                  <td className="explorer-flags">
                    {entry.flags.map((f) => <span key={f} className={flagTagClass(f)}>{f}</span>)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      <div className="explorer-actions">
        <button type="button" className="btn btn-primary" disabled={selected.size === 0} onClick={handleAddToPlan}>
          Add to plan
        </button>
      </div>
    </div>
  )
}
