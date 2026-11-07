import { useEffect, useRef, useState } from 'react'
import type { Api, FindingClass, HealthView } from '../api.js'
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

/** Same escalating-weight tag vocabulary as everywhere else: 'ok' is a quiet pass, and anything
 * else (unreachable, auth, timeout, ...) reads as a block, because a connector that is not
 * reachable is not a matter of degree for an operator about to trust a scan against it. The one
 * exception is `not-configured`: an optional connector the operator chose not to set up is a
 * choice, not a fault — /healthz itself never counts it as degraded — so it reads as quiet. */
function connectorTagClass(status: string): string {
  if (status === 'ok') return 'tag tag-ok'
  if (status === 'not-configured') return 'tag tag-quiet'
  return 'tag tag-block'
}

/**
 * The connector rows /healthz describes. Since Plan 7 `connectors` also carries `qbitInstances`,
 * one entry per qBittorrent instance, beside the plain status strings; each instance gets its own
 * row, with its version or its error, and the single worst-of `qbittorrent` entry (kept by the
 * server for older callers) is left out when they are there — a dead box B must never hide behind
 * a summary row, nor be listed twice. A server that reports no instances still gets its one row.
 */
function connectorRows(connectors: HealthView['connectors']) {
  const instances = connectors.qbitInstances
  const plain = Object.entries(connectors).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string' && !(instances && entry[0] === 'qbittorrent'),
  )
  return { plain, instances: instances ? Object.entries(instances) : [] }
}

interface ScanRefusal {
  message: string
  forcible: boolean
}

/** Which finding class each rule-id prefix belongs to. Verified against `ALL_RULES` in
 * src/rules/registry.ts: every registered rule id (including `dupe.group`'s own internal matcher
 * ids reported via its `subRuns`, e.g. `dupe.identical-file`, `dupe.title-year` — see
 * src/rules/dupes/adapter.ts) is namespaced by exactly one of these four prefixes. */
const RULE_PREFIX_CLASS: Record<string, FindingClass> = {
  dupe: 'duplicate',
  fs: 'filesystem',
  meta: 'metadata',
  quality: 'quality',
}

/**
 * Which classes have at least one rule that did not run this pass — so a tile for that class can
 * be marked degraded instead of showing a count that might be missing whatever the unevaluated
 * rule would have found. `notEvaluated[].ruleId` mixes top-level rule ids with `dupe.group`'s
 * internal matcher ids (both land in the same `rule_runs` table, see src/api/findings.ts), which
 * is exactly why this goes by prefix rather than an exhaustive id list.
 */
function degradedClasses(notEvaluated: Array<{ ruleId: string }>): Set<FindingClass> {
  const out = new Set<FindingClass>()
  for (const item of notEvaluated) {
    const prefix = item.ruleId.split('.')[0] ?? ''
    const cls = RULE_PREFIX_CLASS[prefix]
    if (cls) out.add(cls)
  }
  return out
}

function forcibleFrom(body: unknown): boolean {
  return typeof body === 'object' && body !== null && Boolean((body as { forcible?: unknown }).forcible)
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
      // Set the instant the request succeeds, not only once a poll tick observes `running: true`:
      // a scan that finishes before the next 2s tick would otherwise never trip the "just
      // stopped" edge below, and the summary panel would go stale silently.
      wasRunning.current = true
      setRunning(true)
    } catch (err) {
      // A 412 here is the runner refusing to trust an unverified path map — never retried
      // automatically. The operator is told exactly why and offered the force path explicitly,
      // read from the server's own statement (`forcible` in the response body) rather than
      // inferred from the status code, so the affordance can never drift from what the server
      // actually said just because some other refusal also happens to use 412.
      if (err instanceof ApiError && err.status === 412) {
        setScanRefusal({ message: err.message, forcible: forcibleFrom(err.body) })
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
          (() => {
            const { plain, instances } = connectorRows(health.data.connectors)
            return (
              <ul className="connector-list">
                {plain.map(([name, connStatus]) => (
                  <li key={name} className="connector">
                    {/* Connector names come from this app's own config, but the status string is
                        reported by the connector itself — both render as text nodes only. */}
                    <span className="connector-name">{name}</span>
                    <span className={connectorTagClass(connStatus)}>{connStatus}</span>
                  </li>
                ))}
                {instances.map(([id, inst]) => (
                  <li key={`qbit-${id}`} className="connector">
                    <span className="connector-name">qBittorrent {id}</span>
                    <span className={connectorTagClass(inst.status)}>{inst.status}</span>
                    {/* Version and error text come from the instance itself — text nodes only. */}
                    {inst.version ? <span className="connector-detail">{inst.version}</span> : null}
                    {inst.error ? <span className="connector-detail">{inst.error}</span> : null}
                  </li>
                ))}
              </ul>
            )
          })()
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
              // Not `btn-danger`: that fill is reserved for an action that actually blocks or
              // destroys something (see styles.css). Forcing a scan only bypasses the path-map
              // verification gate — a read-only check — so it gets the ordinary primary treatment.
              <button type="button" className="btn btn-primary" onClick={() => void startScan(true)}>
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
          // Computed once per render, same reasoning as capturing `data` above: both are read
          // several times below (once per tile, plus the reclaimable line) and must all agree on
          // the same `notEvaluated` snapshot.
          const degraded = degradedClasses(data.notEvaluated)
          // Only `filesystem` and `duplicate` rules ever produce a non-null `reclaimableBytes`
          // (metadata and quality findings always report `null` — see src/rules/metadata/index.ts
          // and src/rules/quality/index.ts), so only degradation in one of those two classes can
          // make the aggregate total an undercount.
          const reclaimableDegraded = degraded.has('filesystem') || degraded.has('duplicate')

          return (
            <>
              {data.latestAttempt ? (
                <p className="alert alert-warn" role="status">
                  These results are from scan {data.basedOn?.scanId}; scan{' '}
                  {data.latestAttempt.scanId} {data.latestAttempt.status}.
                </p>
              ) : null}

              {/* Above the tiles, not below: the notice's own text ("their absence from the
                  results below") only makes sense read in that order, and an operator scanning
                  top-down must meet the caveat before a number it qualifies, never after. */}
              <NotEvaluatedNotice items={data.notEvaluated} />

              <div className="class-tiles">
                {FINDING_CLASSES.map((cls) => {
                  const isDegraded = degraded.has(cls)
                  return (
                    <div key={cls} className={isDegraded ? 'tile tile-degraded' : 'tile'}>
                      {isDegraded ? (
                        // "Degraded means not evaluated, never zero" (see NotEvaluatedNotice's own
                        // doc comment) — a bare number here would read as a confirmed count when at
                        // least one rule that feeds this class did not run. Same reasoning as
                        // `Bytes` rendering an em dash for a `null` value, applied to a class tile.
                        <span className="tile-count tile-count-degraded" title="Not evaluated in the last scan — this count may be incomplete">—</span>
                      ) : (
                        <span className="tile-count">{data.byClass[cls] ?? 0}</span>
                      )}
                      <span className="tile-label">{CLASS_LABEL[cls]}</span>
                    </div>
                  )
                })}
              </div>

              <p className="reclaimable">
                Reclaimable space <Bytes value={reclaimableDegraded ? null : data.reclaimableBytes} />
              </p>
            </>
          )
        })()}
      </section>
    </div>
  )
}
