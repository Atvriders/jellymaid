import { useState } from 'react'
import type { Api, Confidence, Finding, FindingClass, FindingStatus, RequestedAction, Severity } from '../api.js'
import { CONFIDENCES, FINDING_CLASSES, SEVERITIES } from '../api.js'
import { useAsync } from '../hooks.js'
import { Bytes, EmptyState, SeverityBadge, TierBadge } from '../components/index.js'

type FindingsApi = Pick<Api, 'findings' | 'dismissFinding'>

// Not exported alongside a `FINDING_STATUSES` const from api.ts the way class/severity/confidence
// are — this screen is the only caller of the status filter, so the list lives here.
const FINDING_STATUSES: readonly FindingStatus[] = ['open', 'dismissed', 'resolved']

interface Filters {
  class: FindingClass | ''
  severity: Severity | ''
  confidence: Confidence | ''
  status: FindingStatus | ''
}

function orUndefined<T extends string>(v: T | ''): T | undefined {
  return v === '' ? undefined : v
}

/**
 * The one place a finding's rule id becomes a destructive action. This is deliberately a pure,
 * exported function rather than logic inlined in a click handler: an empty-folder finding must
 * always queue `remove-empty-folder` (not a delete), junk and stray sidecars queue
 * `delete-junk-file`, orphan media queues `delete-media` — and everything else (metadata and
 * quality rule ids) is informational and MUST queue nothing. Returning `null` is that contract,
 * not a missing case.
 */
export function actionForFinding(f: { ruleId: string; subjects: Array<{ path?: string }> }): RequestedAction | null {
  const path = f.subjects[0]?.path
  if (!path) return null
  if (f.ruleId === 'fs.empty-folder') return { type: 'remove-empty-folder', targetPath: path }
  if (f.ruleId === 'fs.junk' || f.ruleId === 'fs.stray-sidecar') return { type: 'delete-junk-file', targetPath: path }
  if (f.ruleId === 'fs.orphan-media') return { type: 'delete-media', targetPath: path }
  return null // metadata and quality findings are informational; they queue nothing
}

/**
 * Where the operator decides what to act on. Every row is inspected before it is trusted: an
 * informational finding never even offers a checkbox (there is nothing `actionForFinding` would
 * do with it), and dismissing something requires a reason to exist before the API is ever called —
 * not just a form field that happens to be visible.
 */
export function Findings({ api, onQueue }: { api: FindingsApi; onQueue: (actions: RequestedAction[]) => void }) {
  const [filters, setFilters] = useState<Filters>({ class: '', severity: '', confidence: '', status: 'open' })
  const list = useAsync(
    () => api.findings({
      class: orUndefined(filters.class),
      severity: orUndefined(filters.severity),
      confidence: orUndefined(filters.confidence),
      status: orUndefined(filters.status),
    }),
    [filters.class, filters.severity, filters.confidence, filters.status],
  )

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [dismissingId, setDismissingId] = useState<string | null>(null)
  const [reasonText, setReasonText] = useState('')

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function startDismiss(id: string) {
    setDismissingId(id)
    setReasonText('')
  }

  function cancelDismiss() {
    setDismissingId(null)
    setReasonText('')
  }

  async function confirmDismiss(id: string) {
    const reason = reasonText.trim()
    // Belt and braces: the Confirm button is already disabled on a blank reason, but the API call
    // itself must never fire on an empty reason regardless of how this function gets invoked.
    if (!reason) return
    await api.dismissFinding(id, reason)
    cancelDismiss()
    setSelected((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
    list.reload()
  }

  function handleAddToPlan() {
    if (!list.data) return
    const actions: RequestedAction[] = []
    for (const f of list.data.findings) {
      if (!selected.has(f.id)) continue
      const action = actionForFinding(f)
      // Selection is already restricted to actionable rows (see the checkbox column below), but
      // this stays defensive rather than assuming that restriction can never be bypassed.
      if (action) actions.push(action)
    }
    onQueue(actions)
    setSelected(new Set())
  }

  return (
    <div className="findings">
      <form className="filters" onSubmit={(e) => e.preventDefault()}>
        <div className="field">
          <label htmlFor="findings-filter-class">Class</label>
          <select
            id="findings-filter-class"
            value={filters.class}
            onChange={(e) => setFilters((f) => ({ ...f, class: e.target.value as Filters['class'] }))}
          >
            <option value="">All</option>
            {FINDING_CLASSES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="findings-filter-severity">Severity</label>
          <select
            id="findings-filter-severity"
            value={filters.severity}
            onChange={(e) => setFilters((f) => ({ ...f, severity: e.target.value as Filters['severity'] }))}
          >
            <option value="">All</option>
            {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="findings-filter-confidence">Confidence</label>
          <select
            id="findings-filter-confidence"
            value={filters.confidence}
            onChange={(e) => setFilters((f) => ({ ...f, confidence: e.target.value as Filters['confidence'] }))}
          >
            <option value="">All</option>
            {CONFIDENCES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="findings-filter-status">Status</label>
          <select
            id="findings-filter-status"
            value={filters.status}
            onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value as Filters['status'] }))}
          >
            <option value="">All</option>
            {FINDING_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </form>

      {list.error ? (
        <p className="alert" role="alert"><span>{list.error}</span></p>
      ) : !list.data ? (
        <EmptyState>Loading findings…</EmptyState>
      ) : list.data.findings.length === 0 ? (
        <EmptyState>No findings match these filters.</EmptyState>
      ) : (
        <>
          <p className="findings-count">
            {list.data.total} matching finding{list.data.total === 1 ? '' : 's'}
          </p>
          <table className="table findings-table">
            <thead>
              <tr>
                <th scope="col">Queue</th>
                <th scope="col">Rule</th>
                <th scope="col">Class</th>
                <th scope="col">Severity</th>
                <th scope="col">Confidence</th>
                <th scope="col">Subject</th>
                <th scope="col">Reclaimable</th>
                <th scope="col">Status</th>
                <th scope="col">Dismiss</th>
              </tr>
            </thead>
            <tbody>
              {list.data.findings.map((f: Finding) => {
                const action = actionForFinding(f)
                return (
                  <tr key={f.id}>
                    <td>
                      {action ? (
                        <input
                          type="checkbox"
                          aria-label={`Select finding ${f.id}`}
                          checked={selected.has(f.id)}
                          onChange={() => toggleSelected(f.id)}
                        />
                      ) : (
                        <span className="not-queueable" title="Informational finding — nothing to queue">—</span>
                      )}
                    </td>
                    <td><code>{f.ruleId}</code></td>
                    <td>{f.class}</td>
                    <td><SeverityBadge severity={f.severity} /></td>
                    <td><TierBadge tier={f.confidence} /></td>
                    <td>
                      {/* A subject label may be an arbitrary file or folder name from the
                          filesystem — every one renders as a text node only. */}
                      {f.subjects.map((s, i) => (
                        <div key={`${f.id}-subject-${i}`} className="subject-path">{s.label}</div>
                      ))}
                    </td>
                    <td><Bytes value={f.reclaimableBytes} /></td>
                    <td>{f.status}</td>
                    <td>
                      {dismissingId === f.id ? (
                        <div className="dismiss-form">
                          <label htmlFor={`dismiss-reason-${f.id}`}>Reason</label>
                          <input
                            id={`dismiss-reason-${f.id}`}
                            value={reasonText}
                            onChange={(e) => setReasonText(e.target.value)}
                          />
                          <button
                            type="button"
                            className="btn btn-primary"
                            disabled={reasonText.trim() === ''}
                            onClick={() => void confirmDismiss(f.id)}
                          >
                            Confirm dismiss
                          </button>
                          <button type="button" className="btn btn-quiet" onClick={cancelDismiss}>
                            Cancel
                          </button>
                        </div>
                      ) : f.status === 'open' ? (
                        <button type="button" className="btn btn-quiet" onClick={() => startDismiss(f.id)}>
                          Dismiss
                        </button>
                      ) : null}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </>
      )}

      <div className="findings-actions">
        <button type="button" className="btn btn-primary" disabled={selected.size === 0} onClick={handleAddToPlan}>
          Add to plan
        </button>
      </div>
    </div>
  )
}
