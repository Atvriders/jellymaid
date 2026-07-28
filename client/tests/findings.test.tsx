import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Findings, actionForFinding } from '../src/screens/Findings.js'

const finding = (over = {}) => ({
  id: 'f1', ruleId: 'fs.junk', class: 'filesystem', severity: 'warning', confidence: 'exact',
  subjects: [{ kind: 'path', path: '/mnt/m/sample.mkv', label: '/mnt/m/sample.mkv' }],
  evidence: { reason: 'sample file' }, reclaimableBytes: 1024, status: 'open',
  firstSeen: 'T', lastSeen: 'T', dismissedReason: null, ...over,
})

const api = (over = {}) => ({
  findings: vi.fn(async () => ({ findings: [finding()], total: 1 })),
  dismissFinding: vi.fn(async () => ({ ok: true as const })),
  ...over,
} as never)

// Mirrors src/rules/registry.ts's ALL_RULES ids as of this task. Not imported — the client is its
// own package that does not reach into ../../src (see api.ts's comment on the same constraint).
// `dupe.identical-file`, `dupe.title-year` etc. are NOT in this list: they are `dupe.group`'s
// internal matcher ids (see src/rules/dupes/adapter.ts), never registered as their own top-level
// rule, so they can never appear as a finding's `ruleId` either.
const ALL_RULE_IDS = [
  'dupe.group',
  'fs.empty-folder', 'fs.orphan-media', 'fs.missing-file', 'fs.junk', 'fs.stray-sidecar', 'fs.permission',
  'meta.unidentified', 'meta.missing-artwork', 'meta.missing-year', 'meta.episode-no-season', 'meta.mixed-content', 'meta.bad-naming',
  'quality.low-bitrate', 'quality.tiny-file', 'quality.transcode-risk', 'quality.missing-subs', 'quality.biggest',
] as const

const ACTIONABLE_RULE_IDS = new Set(['fs.empty-folder', 'fs.junk', 'fs.stray-sidecar', 'fs.orphan-media'])

describe('Findings', () => {
  it('lists findings with their rule, subject path, and the evidence reason the operator needs to authorise a delete', async () => {
    render(<Findings api={api()} onQueue={() => {}} />)
    expect(await screen.findByText('fs.junk')).toBeInTheDocument()
    expect(await screen.findByText('/mnt/m/sample.mkv')).toBeInTheDocument()
    expect(await screen.findByText('sample file')).toBeInTheDocument()
  })

  it('refetches with the class filter applied', async () => {
    const findings = vi.fn(async () => ({ findings: [], total: 0 }))
    render(<Findings api={api({ findings })} onQueue={() => {}} />)
    await userEvent.selectOptions(await screen.findByLabelText(/class/i), 'duplicate')
    await waitFor(() => expect(findings).toHaveBeenLastCalledWith(expect.objectContaining({ class: 'duplicate' })))
  })

  it('clears the selection when a filter changes, so a stale selection can never be queued against the new list', async () => {
    const onQueue = vi.fn()
    const findings = vi.fn()
      .mockResolvedValueOnce({ findings: [finding()], total: 1 })
      .mockResolvedValueOnce({ findings: [], total: 0 })
    render(<Findings api={api({ findings })} onQueue={onQueue} />)

    await userEvent.click(await screen.findByRole('checkbox', { name: /select/i }))
    expect(screen.getByRole('button', { name: /add to plan/i })).toBeEnabled()

    await userEvent.selectOptions(await screen.findByLabelText(/class/i), 'duplicate')
    await waitFor(() => expect(findings).toHaveBeenLastCalledWith(expect.objectContaining({ class: 'duplicate' })))

    // The old selection referred to a row from the PREVIOUS filter's list, which no longer exists
    // on screen — "Add to plan" must not still look armed.
    expect(screen.getByRole('button', { name: /add to plan/i })).toBeDisabled()
  })

  it('requires a reason before dismissing', async () => {
    const dismissFinding = vi.fn(async () => ({ ok: true as const }))
    render(<Findings api={api({ dismissFinding })} onQueue={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /dismiss/i }))
    expect(dismissFinding).not.toHaveBeenCalled()
    await userEvent.type(screen.getByLabelText(/reason/i), 'intentional')
    await userEvent.click(screen.getByRole('button', { name: /confirm dismiss/i }))
    expect(dismissFinding).toHaveBeenCalledWith('f1', 'intentional')
  })

  it('does not call the API when confirm is somehow reached with a blank reason', async () => {
    const dismissFinding = vi.fn(async () => ({ ok: true as const }))
    render(<Findings api={api({ dismissFinding })} onQueue={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /dismiss/i }))
    const confirm = screen.getByRole('button', { name: /confirm dismiss/i })
    expect(confirm).toBeDisabled()
    await userEvent.type(screen.getByLabelText(/reason/i), '   ')
    expect(screen.getByRole('button', { name: /confirm dismiss/i })).toBeDisabled()
    expect(dismissFinding).not.toHaveBeenCalled()
  })

  it('queues selected findings as delete actions', async () => {
    const onQueue = vi.fn()
    render(<Findings api={api()} onQueue={onQueue} />)
    await userEvent.click(await screen.findByRole('checkbox', { name: /select/i }))
    await userEvent.click(screen.getByRole('button', { name: /add to plan/i }))
    expect(onQueue).toHaveBeenCalledWith([{ type: 'delete-junk-file', targetPath: '/mnt/m/sample.mkv' }])
  })

  it('queues an empty-folder finding as remove-empty-folder, not a delete', async () => {
    const onQueue = vi.fn()
    render(<Findings api={api({ findings: async () => ({ findings: [finding({ ruleId: 'fs.empty-folder', subjects: [{ kind: 'path', path: '/mnt/m/Old', label: '/mnt/m/Old' }] })], total: 1 }) })} onQueue={onQueue} />)
    await userEvent.click(await screen.findByRole('checkbox', { name: /select/i }))
    await userEvent.click(screen.getByRole('button', { name: /add to plan/i }))
    expect(onQueue).toHaveBeenCalledWith([{ type: 'remove-empty-folder', targetPath: '/mnt/m/Old' }])
  })

  it('does not offer a queueing checkbox for an informational metadata finding', async () => {
    const onQueue = vi.fn()
    render(<Findings api={api({
      findings: async () => ({ findings: [finding({ ruleId: 'meta.missing-artwork', class: 'metadata' })], total: 1 }),
    })} onQueue={onQueue} />)
    await screen.findByText('meta.missing-artwork')
    expect(screen.queryByRole('checkbox', { name: /select/i })).not.toBeInTheDocument()
  })

  it('does not offer a queueing checkbox for a junk finding that is actually a directory, because delete-junk-file cannot execute on one', async () => {
    const onQueue = vi.fn()
    render(<Findings api={api({
      findings: async () => ({
        findings: [finding({
          subjects: [{ kind: 'path', path: '/mnt/m/Show/proof', label: '/mnt/m/Show/proof' }],
          evidence: { reason: 'junk directory' },
        })],
        total: 1,
      }),
    })} onQueue={onQueue} />)
    await screen.findByText('/mnt/m/Show/proof')
    expect(screen.queryByRole('checkbox', { name: /select/i })).not.toBeInTheDocument()
  })

  it('shows how many findings are on screen when the server truncated the list below the total', async () => {
    const findings = vi.fn(async () => ({
      findings: [finding({ id: 'f1' }), finding({ id: 'f2' })],
      total: 5,
    }))
    render(<Findings api={api({ findings })} onQueue={() => {}} />)
    expect(await screen.findByText('Showing 2 of 5')).toBeInTheDocument()
    expect(screen.queryByText(/5 matching finding/i)).not.toBeInTheDocument()
  })

  it('shows the plain matching-findings count when the server returned everything', async () => {
    render(<Findings api={api()} onQueue={() => {}} />)
    expect(await screen.findByText('1 matching finding')).toBeInTheDocument()
  })

  it('actionForFinding returns an action only for the four actionable filesystem rules, and null for every other real rule id', () => {
    for (const ruleId of ALL_RULE_IDS) {
      const result = actionForFinding({ ruleId, subjects: [{ path: '/mnt/m/x.mkv' }] })
      if (ACTIONABLE_RULE_IDS.has(ruleId)) {
        expect(result, `expected an action for ${ruleId}`).not.toBeNull()
      } else {
        expect(result, `expected null for ${ruleId}`).toBeNull()
      }
    }
  })

  it('actionForFinding returns null for fs.missing-file even though its subject carries a populated path — a missing file is not one this screen can queue a delete for', () => {
    expect(actionForFinding({ ruleId: 'fs.missing-file', subjects: [{ path: '/mnt/m/Show/episode.mkv' }] })).toBeNull()
  })

  it('actionForFinding returns null for fs.permission', () => {
    expect(actionForFinding({ ruleId: 'fs.permission', subjects: [{ path: '/mnt/m/locked' }] })).toBeNull()
  })

  it('actionForFinding returns null for an fs.junk finding whose evidence says it is a directory, not a file', () => {
    expect(actionForFinding({
      ruleId: 'fs.junk', subjects: [{ path: '/mnt/m/Show/sample' }], evidence: { reason: 'junk directory' },
    })).toBeNull()
  })

  it('actionForFinding still queues delete-junk-file for an fs.junk FILE finding', () => {
    expect(actionForFinding({
      ruleId: 'fs.junk', subjects: [{ path: '/mnt/m/Show/sample.mkv' }], evidence: { reason: 'sample file' },
    })).toEqual({ type: 'delete-junk-file', targetPath: '/mnt/m/Show/sample.mkv' })
  })

  it('renders a malicious file name as text', async () => {
    render(<Findings api={api({
      findings: async () => ({ findings: [finding({ subjects: [{ kind: 'path', path: '<img src=x onerror=alert(1)>', label: '<img src=x onerror=alert(1)>' }] })], total: 1 }),
    })} onQueue={() => {}} />)
    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeInTheDocument()
    expect(document.querySelector('img')).toBeNull()
  })

  it('renders a malicious evidence reason as text, never as markup', async () => {
    render(<Findings api={api({
      findings: async () => ({ findings: [finding({ evidence: { reason: '<img src=x onerror=alert(1)>' } })], total: 1 }),
    })} onQueue={() => {}} />)
    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeInTheDocument()
    expect(document.querySelector('img')).toBeNull()
  })
})
