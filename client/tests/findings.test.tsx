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

describe('Findings', () => {
  it('lists findings with their rule and subject path', async () => {
    render(<Findings api={api()} onQueue={() => {}} />)
    expect(await screen.findByText('fs.junk')).toBeInTheDocument()
    expect(await screen.findByText('/mnt/m/sample.mkv')).toBeInTheDocument()
  })

  it('refetches with the class filter applied', async () => {
    const findings = vi.fn(async () => ({ findings: [], total: 0 }))
    render(<Findings api={api({ findings })} onQueue={() => {}} />)
    await userEvent.selectOptions(await screen.findByLabelText(/class/i), 'duplicate')
    await waitFor(() => expect(findings).toHaveBeenLastCalledWith(expect.objectContaining({ class: 'duplicate' })))
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
      findings: async () => ({ findings: [finding({ ruleId: 'meta.missing-poster', class: 'metadata' })], total: 1 }),
    })} onQueue={onQueue} />)
    await screen.findByText('meta.missing-poster')
    expect(screen.queryByRole('checkbox', { name: /select/i })).not.toBeInTheDocument()
  })

  it('actionForFinding returns null for metadata and quality rule ids, queueing nothing', () => {
    expect(actionForFinding({ ruleId: 'meta.missing-poster', subjects: [{ path: '/mnt/m/x.mkv' }] })).toBeNull()
    expect(actionForFinding({ ruleId: 'quality.low-bitrate', subjects: [{ path: '/mnt/m/x.mkv' }] })).toBeNull()
  })

  it('renders a malicious file name as text', async () => {
    render(<Findings api={api({
      findings: async () => ({ findings: [finding({ subjects: [{ kind: 'path', path: '<img src=x onerror=alert(1)>', label: '<img src=x onerror=alert(1)>' }] })], total: 1 }),
    })} onQueue={() => {}} />)
    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeInTheDocument()
    expect(document.querySelector('img')).toBeNull()
  })
})
