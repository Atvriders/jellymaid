export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

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
  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[level] < ORDER[opts.level]) return
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
