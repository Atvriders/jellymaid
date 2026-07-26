import { describe, it, expect, vi } from 'vitest'
import { createLogger } from '../../src/core/logger.js'

describe('logger', () => {
  it('emits one JSON line per call with level, msg and fields', () => {
    const lines: string[] = []
    const log = createLogger({ level: 'info', sink: (l) => lines.push(l) })
    log.info('scan started', { scanId: 7 })
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0]!)
    expect(parsed.level).toBe('info')
    expect(parsed.msg).toBe('scan started')
    expect(parsed.scanId).toBe(7)
    expect(typeof parsed.ts).toBe('string')
  })

  it('suppresses messages below the configured level', () => {
    const lines: string[] = []
    const log = createLogger({ level: 'warn', sink: (l) => lines.push(l) })
    log.info('quiet')
    log.error('loud')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!).msg).toBe('loud')
  })

  it('child loggers merge their bindings into every line', () => {
    const lines: string[] = []
    const log = createLogger({ level: 'info', sink: (l) => lines.push(l) }).child({ module: 'scan' })
    log.info('tick')
    expect(JSON.parse(lines[0]!).module).toBe('scan')
  })
})
