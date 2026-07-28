import { useEffect, useState } from 'react'
import type { Api, PathMapping, Thresholds, VerifyReport } from '../api.js'
import { Bytes, EmptyState } from '../components/index.js'

type SettingsApi = Pick<Api, 'pathmapGet' | 'pathmapPut' | 'pathmapVerify' | 'pathmapDetect'> & {
  // Optional: GET /api/config/thresholds is a read-only convenience this screen degrades
  // gracefully without (see the effect below) rather than requiring every caller to stub it.
  configThresholds?: Api['configThresholds']
}

const ROLES: PathMapping['role'][] = ['library', 'download']

function emptyMapping(): PathMapping {
  return { role: 'library', jellyfin: '', container: '', qbit: null }
}

/**
 * `pathMappingSchema` (src/config/schema.ts) requires `jellyfin: null` for a download mapping and
 * a non-null `jellyfin` for a library mapping, and treats an empty string as a value ("" is not an
 * absolute path, so PUT would 400 on it) rather than as "unset". This is the one seam between the
 * form's text inputs (which know only the empty string) and that schema, applied right before
 * anything is sent — never stored back into local state, which keeps the inputs exactly what an
 * operator typed while they are still typing.
 */
function normalizeForSave(m: PathMapping): PathMapping {
  return {
    role: m.role,
    jellyfin: m.role === 'download' ? null : (m.jellyfin?.trim() || null),
    container: m.container.trim(),
    qbit: m.qbit?.trim() || null,
  }
}

/**
 * Path mappings are the foundation every guard, sweep and delete confinement check trusts — a
 * wrong container root is how a delete escapes a library, and an unverified map is why scans
 * refuse to start at all (see the 412 Dashboard surfaces). So this screen never saves anything the
 * operator has not explicitly asked it to: editing a row only ever changes local state, "Verify"
 * only ever reports against whatever the SERVER currently has saved, and "Auto-detect" only ever
 * proposes rows for review — never writing them until "Save mappings" is clicked.
 */
export function Settings({ api }: { api: SettingsApi }) {
  const [mappings, setMappings] = useState<PathMapping[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api.pathmapGet()
      .then((res) => { if (!cancelled) setMappings(res.mappings) })
      .catch((err) => { if (!cancelled) setLoadError(err instanceof Error ? err.message : 'failed to load path mappings') })
    return () => { cancelled = true }
  }, [api])

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const [verifying, setVerifying] = useState(false)
  const [verifyError, setVerifyError] = useState<string | null>(null)
  const [verifyResult, setVerifyResult] = useState<VerifyReport | null>(null)

  const [mountRoots, setMountRoots] = useState('')
  const [detecting, setDetecting] = useState(false)
  const [detectError, setDetectError] = useState<string | null>(null)
  const [proposed, setProposed] = useState<PathMapping[] | null>(null)

  const [thresholds, setThresholds] = useState<Thresholds | null>(null)
  useEffect(() => {
    if (!api.configThresholds) return
    let cancelled = false
    api.configThresholds().then((t) => { if (!cancelled) setThresholds(t) }).catch(() => {
      // Thresholds are a read-only convenience; a failure to load them costs a display, not a
      // capability, so it is not worth its own alert alongside the path-mapping form.
    })
    return () => { cancelled = true }
  }, [api])

  function updateRow(index: number, patch: Partial<PathMapping>) {
    setMappings((prev) => {
      if (!prev) return prev
      const next = [...prev]
      const row = { ...next[index]!, ...patch }
      // A row switched to 'download' carries no jellyfin path (the schema forbids one); switching
      // it back to 'library' hands the operator an empty field to fill in, never a stale null that
      // would fail validation silently until save.
      if (patch.role === 'download') row.jellyfin = null
      else if (patch.role === 'library' && row.jellyfin === null) row.jellyfin = ''
      next[index] = row
      return next
    })
    setSaved(false)
  }

  function addRow() {
    setMappings((prev) => [...(prev ?? []), emptyMapping()])
    setSaved(false)
  }

  function removeRow(index: number) {
    setMappings((prev) => (prev ? prev.filter((_, i) => i !== index) : prev))
    setSaved(false)
  }

  function addProposedRow(mapping: PathMapping) {
    // Still only local state — accepting a proposal is not the same as saving it. The operator
    // must still press "Save mappings" for it to reach the server.
    setMappings((prev) => [...(prev ?? []), { ...mapping }])
    setSaved(false)
  }

  async function save() {
    if (!mappings) return
    setSaving(true)
    setSaveError(null)
    setSaved(false)
    try {
      const res = await api.pathmapPut(mappings.map(normalizeForSave))
      setMappings(res.mappings)
      setSaved(true)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'failed to save path mappings')
    } finally {
      setSaving(false)
    }
  }

  async function verify() {
    setVerifying(true)
    setVerifyError(null)
    try {
      setVerifyResult(await api.pathmapVerify())
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : 'failed to verify path mappings')
    } finally {
      setVerifying(false)
    }
  }

  async function detect() {
    const roots = mountRoots.split(',').map((r) => r.trim()).filter(Boolean)
    if (roots.length === 0) return
    setDetecting(true)
    setDetectError(null)
    try {
      setProposed((await api.pathmapDetect(roots)).proposed)
    } catch (err) {
      setDetectError(err instanceof Error ? err.message : 'failed to auto-detect path mappings')
    } finally {
      setDetecting(false)
    }
  }

  return (
    <div className="settings">
      <section className="panel">
        <h2>Path mappings</h2>

        {loadError ? <p className="alert" role="alert"><span>{loadError}</span></p> : null}

        {!mappings ? (
          <EmptyState>Loading path mappings…</EmptyState>
        ) : (
          <>
            <table className="table settings-mappings-table">
              <thead>
                <tr>
                  <th scope="col">Role</th>
                  <th scope="col">Jellyfin path</th>
                  <th scope="col">Container path</th>
                  <th scope="col">qBittorrent path</th>
                  <th scope="col">Remove</th>
                </tr>
              </thead>
              <tbody>
                {mappings.map((m, i) => (
                  // eslint-disable-next-line react/no-array-index-key -- rows have no server id
                  // until saved, and are reordered only by add/remove, never shuffled in place.
                  <tr key={i}>
                    <td>
                      <select
                        aria-label={`Role for mapping ${i + 1}`}
                        value={m.role}
                        onChange={(e) => updateRow(i, { role: e.target.value as PathMapping['role'] })}
                      >
                        {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                    </td>
                    <td>
                      <input
                        aria-label={`Jellyfin path for mapping ${i + 1}`}
                        value={m.jellyfin ?? ''}
                        disabled={m.role === 'download'}
                        onChange={(e) => updateRow(i, { jellyfin: e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`Container path for mapping ${i + 1}`}
                        value={m.container}
                        onChange={(e) => updateRow(i, { container: e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`qBittorrent path for mapping ${i + 1}`}
                        value={m.qbit ?? ''}
                        onChange={(e) => updateRow(i, { qbit: e.target.value })}
                      />
                    </td>
                    <td>
                      <button type="button" className="btn btn-quiet" onClick={() => removeRow(i)}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="settings-mapping-actions">
              <button type="button" className="btn btn-quiet" onClick={addRow}>
                Add mapping
              </button>
              <button type="button" className="btn btn-quiet" disabled={verifying} aria-busy={verifying} onClick={() => void verify()}>
                Verify
              </button>
              <button type="button" className="btn btn-primary" disabled={saving} aria-busy={saving} onClick={() => void save()}>
                Save mappings
              </button>
            </div>

            {saveError ? <p className="alert" role="alert"><span>{saveError}</span></p> : null}
            {saved ? <p className="alert alert-ok" role="status">Mappings saved.</p> : null}

            {verifyError ? <p className="alert" role="alert"><span>{verifyError}</span></p> : null}
            {verifyResult ? (
              <div className="settings-verify-result" role="status">
                <p>{verifyResult.resolved} of {verifyResult.sampled} sampled items resolved to a file on disk.</p>
                {verifyResult.failures.length > 0 ? (
                  <ul className="settings-verify-failures">
                    {verifyResult.failures.map((f, i) => (
                      // eslint-disable-next-line react/no-array-index-key
                      <li key={i}>
                        {/* jellyfinPath and reason are server-reported strings — text nodes only. */}
                        <span className="subject-path">{f.jellyfinPath}</span> — {f.reason}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </section>

      <section className="panel">
        <h2>Auto-detect mappings</h2>
        <div className="field">
          <label htmlFor="settings-mount-roots">Mount roots</label>
          <input
            id="settings-mount-roots"
            value={mountRoots}
            onChange={(e) => setMountRoots(e.target.value)}
            placeholder="/mnt, /downloads"
          />
        </div>
        <button type="button" className="btn btn-quiet" disabled={detecting || mountRoots.trim() === ''} aria-busy={detecting} onClick={() => void detect()}>
          Auto-detect
        </button>

        {detectError ? <p className="alert" role="alert"><span>{detectError}</span></p> : null}

        {proposed ? (
          proposed.length === 0 ? (
            <EmptyState>No mappings were detected under those mount roots.</EmptyState>
          ) : (
            <table className="table settings-proposed-table">
              <caption>Proposed — not saved until added and then explicitly saved above.</caption>
              <thead>
                <tr>
                  <th scope="col">Role</th>
                  <th scope="col">Jellyfin path</th>
                  <th scope="col">Container path</th>
                  <th scope="col">qBittorrent path</th>
                  <th scope="col">Add</th>
                </tr>
              </thead>
              <tbody>
                {proposed.map((p, i) => (
                  // eslint-disable-next-line react/no-array-index-key
                  <tr key={i}>
                    <td>{p.role}</td>
                    <td className="subject-path">{p.jellyfin ?? '—'}</td>
                    <td className="subject-path">{p.container}</td>
                    <td className="subject-path">{p.qbit ?? '—'}</td>
                    <td>
                      <button type="button" className="btn btn-quiet" onClick={() => addProposedRow(p)}>
                        Add to mappings
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : null}
      </section>

      {thresholds ? (
        <section className="panel">
          <h2>Thresholds</h2>
          <p className="settings-thresholds-note">
            Read-only — these come from the config file, not from this screen. They are the
            numbers the safety guards and the trash step actually enforce right now.
          </p>
          <dl className="settings-thresholds">
            <div><dt>Minimum seed ratio</dt><dd>{thresholds.minRatio}</dd></div>
            <div><dt>Minimum seed time</dt><dd>{thresholds.minSeedTimeDays} day{thresholds.minSeedTimeDays === 1 ? '' : 's'}</dd></div>
            <div>
              <dt>Protected categories</dt>
              <dd>{thresholds.protectedCategories.length > 0 ? thresholds.protectedCategories.join(', ') : '—'}</dd>
            </div>
            <div>
              <dt>Protected tags</dt>
              <dd>{thresholds.protectedTags.length > 0 ? thresholds.protectedTags.join(', ') : '—'}</dd>
            </div>
            <div><dt>Trash size ceiling</dt><dd><Bytes value={thresholds.trashMaxBytes} /></dd></div>
            <div><dt>Trash retention</dt><dd>{thresholds.trashRetentionDays} day{thresholds.trashRetentionDays === 1 ? '' : 's'}</dd></div>
          </dl>
        </section>
      ) : null}
    </div>
  )
}
