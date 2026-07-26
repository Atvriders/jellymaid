export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const DEFAULT_LEVEL: LogLevel = 'info'

/**
 * Anything that is not one of the four levels becomes `info`. Failing open here would emit
 * `debug` for a service that logs media paths and, in later plans, delete-plan payloads — so a
 * typo in LOG_LEVEL must quieten nothing and reveal nothing.
 */
export function parseLogLevel(raw: string | undefined): LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(raw ?? '') ? (raw as LogLevel) : DEFAULT_LEVEL
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
  child(bindings: Record<string, unknown>): Logger
}

export interface LoggerOptions {
  level: LogLevel
  sink?: (line: string) => void
  bindings?: Record<string, unknown>
}

export function createLogger(opts: LoggerOptions): Logger {
  const sink = opts.sink ?? ((line: string) => process.stdout.write(line + '\n'))
  const bindings = opts.bindings ?? {}
  // An unrecognised level would make every ORDER[opts.level] comparison false and emit
  // everything, debug included. Treat it as `info` rather than as "log it all".
  const threshold = ORDER[opts.level] ?? ORDER[DEFAULT_LEVEL]
  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[level] < threshold) return
    sink(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...bindings, ...fields }))
  }
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (extra) => createLogger({ ...opts, sink, bindings: { ...bindings, ...extra } }),
  }
}
