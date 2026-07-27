import parser from 'cron-parser'

export interface Scheduler {
  nextRun(): Date
  tick(): Promise<'ran' | 'skipped-overlap' | 'not-due'>
  start(intervalMs?: number): void
  stop(): void
}

export function createScheduler(opts: {
  cron: string
  run: () => Promise<void>
  isRunning: () => boolean
  now?: () => Date
}): Scheduler {
  const now = opts.now ?? (() => new Date())

  // Pinned to UTC, not the host's local zone: cron-parser otherwise resolves the cron fields
  // against whatever timezone the process happens to be running in, so the same cron string and
  // the same `now()` would compute a different schedule on a UTC host than on one in, say,
  // America/Chicago. Every other timestamp in this codebase (scans.started_at, session
  // issuedAt, …) is UTC already; the schedule must not be the one place that silently drifts
  // with the deployment's TZ.
  const parseFrom = (currentDate: Date) => {
    try {
      return parser.parseExpression(opts.cron, { currentDate, tz: 'UTC' })
    } catch (err) {
      throw new Error(`invalid cron expression "${opts.cron}": ${(err as Error).message}`)
    }
  }

  const floorToMinute = (date: Date): Date => {
    const d = new Date(date)
    d.setUTCSeconds(0, 0)
    return d
  }

  /**
   * True when `date`'s own minute is itself a scheduled slot that has not yet been superseded by
   * a later one. This is what lets a scheduler constructed a few seconds *after* its slot — e.g.
   * the process just (re)started right around the due time — still catch that slot on its very
   * first tick, instead of only ever firing on the *following* occurrence a whole period later.
   * cron-parser's own `.next()` is strictly-after even on an exact match (verified empirically:
   * `currentDate` equal to a matching minute still advances to the NEXT one), so it cannot answer
   * "is this exact minute due" on its own.
   */
  const isDueAt = (date: Date): boolean => {
    const flo = floorToMinute(date)
    const justAfterFlo = new Date(flo.getTime() + 60_000)
    return parseFrom(justAfterFlo).prev().toDate().getTime() === flo.getTime()
  }

  const nextAfter = (currentDate: Date): Date => parseFrom(currentDate).next().toDate()

  let next: Date = isDueAt(now()) ? floorToMinute(now()) : nextAfter(now())
  let timer: NodeJS.Timeout | null = null

  return {
    nextRun: () => next,
    async tick() {
      if (now() < next) return 'not-due'
      if (opts.isRunning()) { next = nextAfter(now()); return 'skipped-overlap' }
      next = nextAfter(now())
      await opts.run()
      return 'ran'
    },
    start(intervalMs = 30_000) {
      if (timer) return
      timer = setInterval(() => { void this.tick() }, intervalMs)
      timer.unref?.()
    },
    stop() { if (timer) { clearInterval(timer); timer = null } },
  }
}
