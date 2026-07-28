import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { GuardVerdictList, Bytes, NotEvaluatedNotice, SeverityBadge, TierBadge, EmptyState } from '../src/components/index.js'
import type { GuardVerdict } from '../src/api.js'

const HOSTILE = '<img src=x onerror=alert(1)>'

describe('Bytes', () => {
  it.each([[0, '0 B'], [1024, '1.0 KB'], [1_572_864, '1.5 MB'], [3_221_225_472, '3.0 GB']])(
    'formats %i as %s', (input, expected) => {
      render(<Bytes value={input} />)
      expect(screen.getByText(expected)).toBeInTheDocument()
    })

  it('renders an em dash for null rather than "null"', () => {
    render(<Bytes value={null} />)
    expect(screen.getByText('—')).toBeInTheDocument()
  })
})

describe('GuardVerdictList', () => {
  const verdict = (over: Partial<GuardVerdict> = {}): GuardVerdict =>
    ({ guard: 'guard.protected', outcome: 'block', overridable: false, reason: 'state downloading', evidence: {}, ...over })

  it('renders the reason as text', () => {
    render(<GuardVerdictList verdicts={[verdict()]} overrides={[]} onToggleOverride={() => {}} />)
    expect(screen.getByText(/state downloading/)).toBeInTheDocument()
  })

  it('offers an override control only for overridable guards', () => {
    const { rerender } = render(<GuardVerdictList verdicts={[verdict()]} overrides={[]} onToggleOverride={() => {}} />)
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    rerender(<GuardVerdictList verdicts={[verdict({ guard: 'guard.private-ratio', overridable: true })]} overrides={[]} onToggleOverride={() => {}} />)
    expect(screen.getByRole('checkbox')).toBeInTheDocument()
  })

  it('escapes a malicious torrent name instead of interpreting it', () => {
    render(<GuardVerdictList verdicts={[verdict({ reason: '<img src=x onerror=alert(1)>' })]} overrides={[]} onToggleOverride={() => {}} />)
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument()
  })

  it('escapes a malicious guard name the same way', () => {
    const hostile = { guard: '<img src=x onerror=alert(1)>' } as unknown as Partial<GuardVerdict>
    render(<GuardVerdictList verdicts={[verdict(hostile)]} overrides={[]} onToggleOverride={() => {}} />)
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument()
  })

  it('calls onToggleOverride with the guard id when the checkbox is used', async () => {
    const onToggleOverride = vi.fn()
    render(<GuardVerdictList verdicts={[verdict({ guard: 'guard.private-ratio', overridable: true })]} overrides={[]} onToggleOverride={onToggleOverride} />)
    screen.getByRole('checkbox').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onToggleOverride).toHaveBeenCalledWith('guard.private-ratio')
  })
})

describe('NotEvaluatedNotice', () => {
  it('renders nothing when every rule ran', () => {
    const { container } = render(<NotEvaluatedNotice items={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('names each rule that could not run and why', () => {
    render(<NotEvaluatedNotice items={[{ ruleId: 'dupe.identical-file', reason: 'hashes disabled' }]} />)
    expect(screen.getByText(/dupe.identical-file/)).toBeInTheDocument()
    expect(screen.getByText(/hashes disabled/)).toBeInTheDocument()
  })

  it('states plainly that the absence of results is not a clean bill of health', () => {
    render(<NotEvaluatedNotice items={[{ ruleId: 'dupe.identical-file', reason: 'hashes disabled' }]} />)
    expect(screen.getByText(/not a clean bill of health/i)).toBeInTheDocument()
  })

  it('escapes a hostile reason instead of interpreting it', () => {
    render(<NotEvaluatedNotice items={[{ ruleId: 'dupe.identical-file', reason: HOSTILE }]} />)
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeInTheDocument()
  })
})

// Self-review sweep: every other shared component that accepts a caller-supplied string must
// render it as a text node only, same as GuardVerdictList and NotEvaluatedNotice above.
describe('hostile strings through the remaining shared components', () => {
  it('SeverityBadge renders an unexpected severity value as text, not markup', () => {
    render(<SeverityBadge severity={HOSTILE} />)
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getByText(HOSTILE)).toBeInTheDocument()
  })

  it('TierBadge renders an unexpected tier value as text, not markup', () => {
    render(<TierBadge tier={HOSTILE} />)
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getByText(HOSTILE)).toBeInTheDocument()
  })

  it('EmptyState renders its message as text, not markup', () => {
    render(<EmptyState>{HOSTILE}</EmptyState>)
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getByText(HOSTILE)).toBeInTheDocument()
  })
})
