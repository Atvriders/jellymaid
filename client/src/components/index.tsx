import type { ReactNode } from 'react'
import type { GuardVerdict } from '../api.js'

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const

/**
 * Byte counts are the single most repeated fact in this app, and every one of them stands in for
 * disk space an operator is about to reclaim or destroy — so they are formatted once, here, and
 * every screen borrows this rather than rolling its own `toFixed`.
 *
 * `null` means "unknown", not "zero" (see e.g. `PlanDryRun.directoriesSwept`), so it renders an
 * em dash rather than a size — collapsing the two would make an absent measurement look like a
 * confirmed empty one.
 */
export function Bytes({ value }: { value: number | null }) {
  if (value === null) return <span>—</span>
  if (value === 0) return <span>0 B</span>

  let exp = Math.min(Math.floor(Math.log(value) / Math.log(1024)), UNITS.length - 1)
  let scaled = value / 1024 ** exp
  // Guard the rounding-across-a-boundary case (e.g. 1023.96 KB) so this never prints "1024.0 KB"
  // instead of bumping to the next unit.
  if (exp > 0 && exp < UNITS.length - 1 && Number(scaled.toFixed(1)) >= 1024) {
    exp += 1
    scaled = value / 1024 ** exp
  }

  const unit = UNITS[exp]
  return <span>{exp === 0 ? `${value} B` : `${scaled.toFixed(1)} ${unit}`}</span>
}

/**
 * The "inspection tag": the one recurring signature across this app (see styles.css). Weight
 * escalates with consequence — a quiet tint for most outcomes, a solid fill reserved for the one
 * that actually blocks or destroys something — so the loudest thing on any screen is always the
 * thing that matters most, never mere decoration.
 */
function outcomeTagClass(outcome: 'pass' | 'warn' | 'block'): string {
  if (outcome === 'block') return 'tag tag-block'
  if (outcome === 'warn') return 'tag tag-warn'
  return 'tag tag-ok'
}

export function SeverityBadge({ severity }: { severity: 'critical' | 'warning' | 'info' | string }) {
  const cls = severity === 'critical' ? 'tag tag-block' : severity === 'warning' ? 'tag tag-warn' : 'tag tag-quiet'
  return <span className={cls}>{severity}</span>
}

export function TierBadge({ tier }: { tier: string }) {
  const cls = tier === 'exact' ? 'tag tag-ok' : tier === 'strong' ? 'tag tag-warn' : 'tag tag-quiet'
  return <span className={cls}>{tier}</span>
}

export function GuardVerdictList({ verdicts, overrides, onToggleOverride, readOnly = false }: {
  verdicts: GuardVerdict[]
  overrides: string[]
  onToggleOverride: (guard: string) => void
  /** Once a plan is past draft its overrides are fixed: show them as fact, offer no control. The
   * caller must then pass the overrides the plan STORES, not any local selection. */
  readOnly?: boolean
}) {
  return (
    <ul className="guards">
      {verdicts.map((v) => (
        <li key={v.guard} className="guard">
          <span className={outcomeTagClass(v.outcome)}>{v.outcome}</span>
          {/* Guard id is a fixed identifier, not user data, but it and the reason both render as
              plain text nodes — the reason in particular may embed a torrent or file name and
              must never be interpreted as markup. */}
          <span className="guard-name">{v.guard}</span>
          <span className="guard-reason">{v.reason}</span>
          {v.overridable && readOnly ? (
            overrides.includes(v.guard) ? <span className="guard-override">overridden</span> : null
          ) : v.overridable ? (
            <label className="guard-override">
              <input
                type="checkbox"
                checked={overrides.includes(v.guard)}
                onChange={() => onToggleOverride(v.guard)}
              />
              override
            </label>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

/**
 * "Degraded means not evaluated, never zero." A rule that could not run must never look like a
 * rule that ran clean, so this renders nothing when everything ran (an empty screen stays quiet)
 * but takes on the not-evaluated visual identity — distinct from both a plain empty state and the
 * destructive "block" tag — the moment there is anything to report. See styles.css's
 * `.not-evaluated` for why that identity is a hazard-striped amber rather than a gray note.
 */
export function NotEvaluatedNotice({ items }: { items: Array<{ ruleId: string; reason: string }> }) {
  if (!items.length) return null
  return (
    <aside className="not-evaluated" role="status">
      <strong>Not evaluated in the last scan</strong>
      <ul>
        {items.map((i) => (
          <li key={i.ruleId}>
            <code>{i.ruleId}</code> — {i.reason}
          </li>
        ))}
      </ul>
      <p>These checks did not run. Their absence from the results below is not a clean bill of health.</p>
    </aside>
  )
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>
}

/** Counts read at a glance at the owner's scale ("1,200", never "1200"). */
function formatCount(n: number): string {
  return n.toLocaleString('en-US')
}

/**
 * An inline confirmation, rendered right where the question arose rather than in a modal: the
 * operator reads the consequences next to the rows they describe. Focus lands on Cancel, so a
 * reflexive Enter backs out instead of agreeing to something nobody read.
 */
export function ConfirmBox({ title, children, confirmLabel, confirmClassName = 'btn btn-primary', busy = false, disabled = false, onConfirm, onCancel }: {
  title: string
  children?: ReactNode
  confirmLabel: string
  confirmClassName?: string
  busy?: boolean
  disabled?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="confirm" role="alertdialog" aria-label={title}>
      <p className="confirm-title">{title}</p>
      {children}
      <div className="confirm-actions">
        <button type="button" className={confirmClassName} disabled={busy || disabled} aria-busy={busy} onClick={onConfirm}>
          {confirmLabel}
        </button>
        {/* eslint-disable-next-line jsx-a11y/no-autofocus -- deliberate: the safe answer gets focus */}
        <button type="button" className="btn btn-quiet" autoFocus onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

/**
 * "1–50 of 900 groups" plus Previous/Next for any list that pages by offset. The buttons appear
 * only when there is more than one page; the count line always says how much there is.
 */
export function Pager({ offset, limit, total, noun, onOffset }: {
  offset: number
  limit: number
  total: number
  /** Singular and plural noun for the count line, e.g. ['group', 'groups']. */
  noun: readonly [string, string]
  onOffset: (offset: number) => void
}) {
  const last = Math.min(offset + limit, total)
  const word = total === 1 ? noun[0] : noun[1]
  return (
    <div className="pager">
      <span className="pager-status">
        {total > limit ? `${formatCount(offset + 1)}–${formatCount(last)} of ${formatCount(total)} ${word}` : `${formatCount(total)} ${word}`}
      </span>
      {total > limit ? (
        <span className="pager-buttons">
          <button type="button" className="btn btn-quiet" disabled={offset <= 0} onClick={() => onOffset(Math.max(0, offset - limit))}>
            Previous
          </button>
          <button type="button" className="btn btn-quiet" disabled={last >= total} onClick={() => onOffset(offset + limit)}>
            Next
          </button>
        </span>
      ) : null}
    </div>
  )
}
