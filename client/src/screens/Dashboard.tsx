import { useEffect, useRef, useState } from 'react'
import type { Api, FindingClass } from '../api.js'
import { ApiError, FINDING_CLASSES } from '../api.js'
import { useAsync, usePolling } from '../hooks.js'
import { Bytes, NotEvaluatedNotice, EmptyState } from '../components/index.js'

type DashboardApi = Pick<Api, 'health' | 'findingsSummary' | 'scanStart' | 'scanCancel' | 'scanStatus'>

const CLASS_LABEL: Record<FindingClass, string> = {
  duplicate: 'Duplicates',
  filesystem: 'Filesystem',
  metadata: 'Metadata',
  quality: 'Quality',
}

/** Same escalating-weight tag vocabulary as everywhere else: 'ok' is a quiet pass, anything else
 * (unreachable, degraded, ...) reads as a block, because a connector that is not reachable is not
 * a matter of degree for an operator about to trust a scan against it. */
function connectorTagClass(status: string): string {
  return status === 'ok' ? 'tag tag-ok' : 'tag tag-block'
}

interface ScanRefusal {
  message: string
  forcible: boolean
}

/**
 * The instrument-panel front page: is the picture on the other screens trustworthy right now?
 * That is three separate questions — are the connectors this app depends on reachable, is a scan
 * running, and do the current findings numbers come from a scan that actually finished the rules
 * phase — so each gets its own honest answer instead of being folded into one green light.
 */
export function Dashboard({ api }: { api: DashboardApi }) {
  const health = useAsync(api.health)
  const summary = useAsync(api.findingsSummary)

  const [running, setRunning] = useState(false)
  const status = usePolling(api.scanStatus, 2000, running)
  const wasRunning = useRef(false)

  useEffect(() => {
    if (!status) return
    // The findings picture can only have changed once a scan that was running stops — reload it
    // then, rather than on every poll tick, so the summary panel does not go stale the moment a
    // scan completes while the operator is looking at this screen.
    if (wasRunning.current && !status.running) summary.reload()
    wasRunning.current = status.running
    setRunning(status.running)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status])

  const [starting, setStarting] = useState(false)
  const [scanRefusal, setScanRefusal] = useState<ScanRefusal | null>(null)

  async function startScan(force: boolean) {
    setStarting(true)
    setScanRefusal(null)
    try {
      await api.scanStart(force ? { force: true } : {})
      setRunning(true)
    } catch (err) {
      // A 412 here is the runner refusing to trust an unverified path map — never retried
      // automatically. The operator is told exactly why and offered the force path explicitly;
      // anything else is a plain failure message.
      if (err instanceof ApiError && err.status === 412) {
        setScanRefusal({ message: err.message, forcible: true })
      } else {
        setScanRefusal({ message: err instanceof Error ? err.message : 'failed to start scan', forcible: false })
      }
    } finally {
      setStarting(false)
    }
  }

  async function cancelScan() {
    try {
      await api.scanCancel()
    } catch {
      // The next poll tick reconciles actual state either way; a refused cancel (e.g. nothing was
      // running any more) is not worth its own alert on top of the scan panel already in flight.
    }
  }

  return (
    <div className="dashboard">
      <section className="panel">
        <h2>Connectors</h2>
        {health.error ? (
          <p className="alert" role="alert"><span>{health.error}</span></p>
        ) : health.data ? (
          <ul className="connector-list">
            {Object.entries(health.data.connectors).map(([name, connStatus]) => (
              <li key={name} className="connector">
                {/* Connector names come from this app's own config, but the status string is
                    reported by the connector itself — both render as text nodes only. */}
                <span className="connector-name">{name}</span>
                <span className={connectorTagClass(connStatus)}>{connStatus}</span>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState>Checking connectors…</EmptyState>
        )}
      </section>

      <section className="panel">
        <h2>Scan</h2>
        {status?.running ? (
          <div className="scan-progress">
            <p>
              Phase <code>{status.phase ?? '—'}</code> — {status.done}
              {status.total !== null ? ` of ${status.total}` : ''}
            </p>
            <button type="button" className="btn btn-quiet" onClick={() => void cancelScan()}>
              Cancel
            </button>
          </div>
        ) : (
          <button type="button" className="btn btn-primary" disabled={starting} aria-busy={starting} onClick={() => void startScan(false)}>
            Scan now
          </button>
        )}

        {scanRefusal ? (
          <div className="alert" role="alert">
            {/* The refusal reason is server text — a text node only, never markup. */}
            <span>{scanRefusal.message}</span>
            {scanRefusal.forcible ? (
              <button type="button" className="btn btn-danger" onClick={() => void startScan(true)}>
                Force scan anyway
              </button>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="panel">
        <h2>Findings</h2>
        {(() => {
          // Captured once so TypeScript's narrowing (and, more importantly, the actual value)
          // survives into the closures below — `summary.data` itself is a hook field, and neither
          // the compiler nor a `.map()` callback can assume it stays non-null across a re-render.
          const data = summary.data
          if (summary.error) return <p className="alert" role="alert"><span>{summary.error}</span></p>
          if (!data) return <EmptyState>Loading findings summary…</EmptyState>
          if (!data.evaluated) {
            // `evaluated: false` means no scan has ever reached the rules phase — this is not the
            // same thing as a clean scan with nothing to report, and must never look like one.
            return <EmptyState>No scan has completed the rules phase yet — nothing has been evaluated.</EmptyState>
          }
          return (
            <>
              {data.latestAttempt ? (
                <p className="alert alert-warn" role="status">
                  These results are from scan {data.basedOn?.scanId}; scan{' '}
                  {data.latestAttempt.scanId} {data.latestAttempt.status}.
                </p>
              ) : null}

              <div className="class-tiles">
                {FINDING_CLASSES.map((cls) => (
                  <div key={cls} className="tile">
                    <span className="tile-count">{data.byClass[cls] ?? 0}</span>
                    <span className="tile-label">{CLASS_LABEL[cls]}</span>
                  </div>
                ))}
              </div>

              <p className="reclaimable">
                Reclaimable space <Bytes value={data.reclaimableBytes} />
              </p>

              <NotEvaluatedNotice items={data.notEvaluated} />
            </>
          )
        })()}
      </section>
    </div>
  )
}
