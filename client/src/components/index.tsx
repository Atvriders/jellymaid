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

export function GuardVerdictList({ verdicts, overrides, onToggleOverride }: {
  verdicts: GuardVerdict[]
  overrides: string[]
  onToggleOverride: (guard: string) => void
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
          {v.overridable ? (
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
