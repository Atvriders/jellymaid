import { describe, it, expect } from 'vitest'
import { createLogger, parseLogLevel } from '../../src/core/logger.js'

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

  it('does NOT enable debug output for an unrecognised level', () => {
    // Failing open here would emit media paths and, later, delete-plan payloads because of a typo.
    const lines: string[] = []
    const log = createLogger({ level: 'verbose' as never, sink: (l) => lines.push(l) })
    log.debug('secret path /mnt/media/Movies/Heat.mkv')
    log.info('kept')
    log.error('loud')
    expect(lines.map((l) => JSON.parse(l).level)).toEqual(['info', 'error'])
  })

  it('parseLogLevel accepts the four real levels and falls back to info for anything else', () => {
    for (const level of ['debug', 'info', 'warn', 'error']) expect(parseLogLevel(level)).toBe(level)
    for (const bad of [undefined, '', 'verbose', 'DEBUG', 'trace', 'true']) expect(parseLogLevel(bad)).toBe('info')
  })

  it('child loggers merge their bindings into every line', () => {
    const lines: string[] = []
    const log = createLogger({ level: 'info', sink: (l) => lines.push(l) }).child({ module: 'scan' })
    log.info('tick')
    expect(JSON.parse(lines[0]!).module).toBe('scan')
  })
})
