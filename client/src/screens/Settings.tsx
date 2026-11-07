import { useEffect, useState } from 'react'
import type {
  Api, GuardSettings, KeeperPolicy, PathMapping, QbitInstanceView, SettingsPatch, SettingsView, VerificationView,
} from '../api.js'
import { Bytes, EmptyState } from '../components/index.js'

type SettingsApi = Pick<Api,
  'pathmapGet' | 'pathmapPut' | 'pathmapVerify' | 'pathmapDetect' | 'qbitInstances' | 'settings' | 'saveSettings'>

const ROLES: PathMapping['role'][] = ['library', 'download']

/** Select value for a row that has a qBittorrent path but no instance (see `instanceSelectValue`). */
const UNASSIGNED = '__unassigned__'

/** Select value for a row nobody has chosen an instance — or "none" — for yet (see `MappingRow`). */
const UNDECIDED = '__undecided__'

/**
 * A row as this screen holds it. `undecided` marks a row added here (or accepted from Auto-detect
 * without an instance) that the operator has not yet said anything about. It is NOT "none": "none"
 * tells every guard that no torrent can own a file under the root, so no instance is ever asked
 * about one and a box seeding there would have its files unlinked (final review I1). Saving is
 * refused until each such row has an explicit choice. Local only — `normalizeForSave` drops it.
 */
type MappingRow = PathMapping & { undecided?: boolean }

function emptyMapping(): MappingRow {
  return { role: 'library', jellyfin: '', container: '', qbit: null, qbitInstance: null, undecided: true }
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
    qbitInstance: m.qbitInstance?.trim() || null,
  }
}

/**
 * What the instance picker shows for a row. Four states, never collapsed into fewer:
 *   - an instance id: this root's torrents live on that box;
 *   - '' ("none"): BOTH fields empty — the root is explicitly not torrent-backed;
 *   - UNASSIGNED: a qBittorrent path with no instance (an old single-instance config). That is not
 *     "none": the server fills it in only when exactly one instance exists and otherwise fails it
 *     closed, so showing it as "none" would be a lie, and saving it as "none" would quietly turn a
 *     torrent-backed root into one the guards believe no torrent can own;
 *   - UNDECIDED: a new row nobody has chosen for yet (`MappingRow`). Not "none", for the same reason.
 */
function instanceSelectValue(m: MappingRow): string {
  if (m.undecided) return UNDECIDED
  if (m.qbitInstance) return m.qbitInstance
  return m.qbit && m.qbit.trim() !== '' ? UNASSIGNED : ''
}

type InstancesState =
  | { kind: 'loading' }
  | { kind: 'ok'; instances: QbitInstanceView[] }
  | { kind: 'error'; message: string }

function InstancePicker({ index, mapping, state, onChoose }: {
  index: number
  mapping: MappingRow
  state: InstancesState
  onChoose: (value: string) => void
}) {
  const value = instanceSelectValue(mapping)
  const known = state.kind === 'ok' ? state.instances : []
  const current = mapping.qbitInstance
  // A saved id this server does not configure (any more) stays visible as itself, so the select
  // never silently shows — and on the next save, sends — some other value. Only claimed to be
  // "not configured" when the instance list actually loaded and says so.
  const showCurrentSeparately = current !== null && current !== '' && !known.some((i) => i.id === current)
  return (
    <select aria-label={`qBittorrent instance for mapping ${index + 1}`} value={value} onChange={(e) => onChoose(e.target.value)}>
      {value === UNDECIDED ? <option value={UNDECIDED}>— choose an instance, or none —</option> : null}
      {value === UNASSIGNED ? <option value={UNASSIGNED}>— pick an instance —</option> : null}
      <option value="">none (not torrent-backed)</option>
      {known.map((i) => (
        <option key={i.id} value={i.id}>{i.id}{i.reachable ? '' : ' (unreachable)'}</option>
      ))}
      {showCurrentSeparately ? (
        <option value={current}>{current}{state.kind === 'ok' ? ' (not configured)' : ''}</option>
      ) : null}
    </select>
  )
}

/**
 * The stored verification, both halves (C7): Jellyfin → container paths, and for every qBittorrent
 * instance its completed torrents' content paths → container paths. Scans and plan builds are
 * refused until every part passes for the mappings saved right now, so each part says plainly
 * whether it passed, and a configured instance with no result at all is called out as unverified
 * rather than left out. Torrents an instance keeps outside every mapped folder are not checked and
 * do not fail it; their count is shown, with example paths folded behind it.
 */
function VerificationResult({ record, instanceIds }: { record: VerificationView; instanceIds: string[] | null }) {
  const jf = record.jellyfin
  const jellyfinOk = jf.sampled > 0 && jf.resolved >= jf.sampled && jf.failures.length === 0
  const reported = new Set(record.qbit.map((r) => r.instanceId))
  const unreported = (instanceIds ?? []).filter((id) => !reported.has(id))
  const verdict = (ok: boolean) => <span className={ok ? 'tag tag-ok' : 'tag tag-block'}>{ok ? 'passed' : 'failed'}</span>
  return (
    <div className="settings-verify-result" role="status" aria-label="Path mapping verification">
      <p className="settings-verify-at">Verified {record.at}.</p>
      {!record.current ? (
        <p className="alert alert-warn">
          The mappings changed since this verification. Scans and plan builds stay refused until you verify again.
        </p>
      ) : null}

      <section className="settings-verify-part" role="group" aria-label="Jellyfin">
        <h3>{verdict(jellyfinOk)} Jellyfin</h3>
        <p>{jf.resolved} of {jf.sampled} sampled items resolved to a file on disk.</p>
        {jf.failures.length > 0 ? (
          <ul className="settings-verify-failures">
            {jf.failures.map((f, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <li key={i}>
                {/* jellyfinPath and reason are server-reported strings — text nodes only. */}
                <span className="subject-path">{f.jellyfinPath}</span> — {f.reason}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {record.qbit.map((r) => {
        const ok = r.failures.length === 0 && r.resolved >= r.sampled
        const ignored = r.ignored !== undefined && r.ignored.count > 0 ? r.ignored : null
        return (
          <section key={r.instanceId} className="settings-verify-part" role="group" aria-label={`qBittorrent ${r.instanceId}`}>
            <h3>{verdict(ok)} qBittorrent {r.instanceId}</h3>
            <p>
              {r.sampled === 0 && r.failures.length === 0
                ? ignored !== null
                  ? 'No completed torrents in a mapped folder on this instance — nothing to check.'
                  : 'No completed torrents to sample on this instance — nothing to check.'
                : `${r.resolved} of ${r.sampled} sampled torrents resolved to their files on disk.`}
            </p>
            {ignored !== null ? (
              // Not a failure: these torrents are in folders no mapping of this instance names (music,
              // books, a downloads folder), so Jellymaid never deletes or guards anything through them.
              <details className="settings-verify-ignored">
                <summary>
                  {ignored.count === 1
                    ? '1 torrent outside every mapped folder was ignored'
                    : `${ignored.count} torrents outside every mapped folder were ignored`}
                </summary>
                {ignored.examples.length > 0 ? (
                  <ul>
                    {ignored.examples.map((path, i) => (
                      // eslint-disable-next-line react/no-array-index-key
                      <li key={i}><span className="subject-path">{path}</span></li>
                    ))}
                  </ul>
                ) : null}
              </details>
            ) : null}
            {r.failures.length > 0 ? (
              <ul className="settings-verify-failures">
                {r.failures.map((f, i) => (
                  // eslint-disable-next-line react/no-array-index-key
                  <li key={i}>
                    <span className="subject-path">{f.qbitPath}</span> — {f.reason}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        )
      })}

      {unreported.map((id) => (
        <section key={id} className="settings-verify-part" role="group" aria-label={`qBittorrent ${id}`}>
          <h3><span className="tag tag-block">not verified</span> qBittorrent {id}</h3>
          <p>Not verified: this instance has no result in this verification. Verify again.</p>
        </section>
      ))}
    </div>
  )
}

interface GuardForm {
  minRatio: string
  minSeedTimeDays: string
  protectedCategories: string
  protectedTags: string
  privateTrackerHosts: string
  policy: KeeperPolicy
}

const LIST_FIELDS = ['protectedCategories', 'protectedTags', 'privateTrackerHosts'] as const

function formFrom(view: SettingsView): GuardForm {
  return {
    minRatio: String(view.guards.minRatio),
    minSeedTimeDays: String(view.guards.minSeedTimeDays),
    protectedCategories: view.guards.protectedCategories.join(', '),
    protectedTags: view.guards.protectedTags.join(', '),
    privateTrackerHosts: view.guards.privateTrackerHosts.join(', '),
    policy: view.keeper.policy,
  }
}

const parseList = (raw: string) => raw.split(',').map((s) => s.trim()).filter((s) => s !== '')

function parseThreshold(label: string, raw: string): number | { error: string } {
  const n = Number(raw)
  if (raw.trim() === '' || !Number.isFinite(n) || n < 0) return { error: `${label} must be a number of 0 or more.` }
  return n
}

/**
 * Only what the operator changed goes into the PUT: the server merges `guards`/`keeper` one level
 * deep, so sending an unchanged field would only risk overwriting an edit made elsewhere in the
 * meantime. A threshold that is not a non-negative number is refused here, before any request.
 */
function buildPatch(view: SettingsView, form: GuardForm): { patch: SettingsPatch } | { error: string } {
  const minRatio = parseThreshold('Minimum seed ratio', form.minRatio)
  if (typeof minRatio !== 'number') return minRatio
  const minSeedTimeDays = parseThreshold('Minimum seed time', form.minSeedTimeDays)
  if (typeof minSeedTimeDays !== 'number') return minSeedTimeDays

  const guards: Partial<GuardSettings> = {}
  if (minRatio !== view.guards.minRatio) guards.minRatio = minRatio
  if (minSeedTimeDays !== view.guards.minSeedTimeDays) guards.minSeedTimeDays = minSeedTimeDays
  for (const key of LIST_FIELDS) {
    const list = parseList(form[key])
    if (JSON.stringify(list) !== JSON.stringify(view.guards[key])) guards[key] = list
  }
  const patch: SettingsPatch = {}
  if (Object.keys(guards).length > 0) patch.guards = guards
  if (form.policy !== view.keeper.policy) patch.keeper = { policy: form.policy }
  return { patch }
}

/**
 * The private-tracker rule (owner decision 2: BOTH thresholds must be met), the protections and
 * the keeper policy. Saved settings apply without a restart: guard values are read at the next
 * plan build and again when each action executes. The keeper policy is different — keepers are
 * picked when a scan groups duplicates — so a new policy shows up only after the next scan, and
 * the control says so (Ruling 4).
 */
function GuardSettingsPanel({ api }: { api: Pick<Api, 'settings' | 'saveSettings'> }) {
  const [view, setView] = useState<SettingsView | null>(null)
  const [form, setForm] = useState<GuardForm | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    api.settings()
      .then((v) => { if (!cancelled) { setView(v); setForm(formFrom(v)) } })
      .catch((err) => { if (!cancelled) setLoadError(err instanceof Error ? err.message : 'failed to load settings') })
    return () => { cancelled = true }
  }, [api])

  function update(patch: Partial<GuardForm>) {
    setForm((prev) => (prev ? { ...prev, ...patch } : prev))
    setMessage(null)
  }

  async function save() {
    if (!view || !form) return
    const built = buildPatch(view, form)
    if ('error' in built) {
      setMessage({ kind: 'error', text: built.error })
      return
    }
    if (!built.patch.guards && !built.patch.keeper) {
      setMessage({ kind: 'ok', text: 'Nothing to save — no setting changed.' })
      return
    }
    setSaving(true)
    setMessage(null)
    try {
      const saved = await api.saveSettings(built.patch)
      setView(saved)
      setForm(formFrom(saved))
      setMessage({ kind: 'ok', text: 'Settings saved. They apply now, without a restart.' })
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'failed to save settings' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="panel">
      <h2>Guards and keeper</h2>
      {loadError ? <p className="alert" role="alert"><span>{loadError}</span></p> : null}
      {!view || !form ? (
        loadError ? null : <EmptyState>Loading settings…</EmptyState>
      ) : (
        // noValidate: the browser's own bubble for `min="0"` would stop the submit before
        // `buildPatch` can say which field is wrong in this screen's own words.
        <form className="settings-form" noValidate onSubmit={(e) => { e.preventDefault(); void save() }}>
          <p className="settings-thresholds-note">
            A private torrent may be deleted only when it has BOTH the minimum seed ratio AND the minimum seed time.
          </p>
          <div className="settings-form-grid">
            <div className="field">
              <label htmlFor="settings-min-ratio">Minimum seed ratio</label>
              <input id="settings-min-ratio" type="number" min="0" step="0.01" value={form.minRatio}
                onChange={(e) => update({ minRatio: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="settings-min-seed-days">Minimum seed time (days)</label>
              <input id="settings-min-seed-days" type="number" min="0" step="1" value={form.minSeedTimeDays}
                onChange={(e) => update({ minSeedTimeDays: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="settings-protected-categories">Protected categories (comma-separated)</label>
              <input id="settings-protected-categories" value={form.protectedCategories}
                onChange={(e) => update({ protectedCategories: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="settings-protected-tags">Protected tags (comma-separated)</label>
              <input id="settings-protected-tags" value={form.protectedTags}
                onChange={(e) => update({ protectedTags: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="settings-private-hosts">Private tracker hosts (comma-separated)</label>
              <input id="settings-private-hosts" value={form.privateTrackerHosts}
                onChange={(e) => update({ privateTrackerHosts: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="settings-keeper-policy">Keeper policy</label>
              <select id="settings-keeper-policy" value={form.policy} aria-describedby="settings-keeper-note"
                onChange={(e) => update({ policy: e.target.value as KeeperPolicy })}>
                <option value="best-quality">Best quality (default)</option>
                <option value="smallest">Smallest file</option>
                <option value="none">None — I pick every keeper</option>
              </select>
              <span id="settings-keeper-note" className="settings-field-note">
                Applies after the next scan: until then the duplicate list keeps the keepers it already has.
              </span>
            </div>
          </div>

          <dl className="settings-thresholds">
            <div><dt>Trash size ceiling</dt><dd><Bytes value={view.trash.maxBytes} /></dd></div>
            <div><dt>Trash retention</dt><dd>{view.trash.retentionDays} day{view.trash.retentionDays === 1 ? '' : 's'}</dd></div>
          </dl>

          <div className="settings-mapping-actions">
            <button type="submit" className="btn btn-primary" disabled={saving} aria-busy={saving}>
              Save settings
            </button>
          </div>
          {message ? (
            message.kind === 'ok'
              ? <p className="alert alert-ok" role="status">{message.text}</p>
              : <p className="alert" role="alert"><span>{message.text}</span></p>
          ) : null}
        </form>
      )}
    </section>
  )
}

/**
 * Path mappings are the foundation every guard, sweep and delete confinement check trusts — a
 * wrong container root is how a delete escapes a library, and a wrong qBittorrent instance is how
 * a delete reaches the wrong box. So this screen never saves anything the operator has not
 * explicitly asked it to: editing a row only ever changes local state, "Verify" only ever reports
 * against whatever the SERVER currently has saved, and "Auto-detect" only ever proposes rows for
 * review — never writing them until "Save mappings" is clicked.
 */
export function Settings({ api }: { api: SettingsApi }) {
  const [mappings, setMappings] = useState<MappingRow[] | null>(null)
  const [problems, setProblems] = useState<string[]>([])
  const [verification, setVerification] = useState<VerificationView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [instancesState, setInstancesState] = useState<InstancesState>({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false
    api.pathmapGet()
      .then((res) => {
        if (cancelled) return
        setMappings(res.mappings)
        setProblems(res.problems ?? [])
        setVerification(res.lastVerification ?? null)
      })
      .catch((err) => { if (!cancelled) setLoadError(err instanceof Error ? err.message : 'failed to load path mappings') })
    api.qbitInstances()
      .then((res) => { if (!cancelled) setInstancesState({ kind: 'ok', instances: res.instances }) })
      .catch((err) => {
        if (!cancelled) setInstancesState({ kind: 'error', message: err instanceof Error ? err.message : 'failed to list the qBittorrent instances' })
      })
    return () => { cancelled = true }
  }, [api])

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const [verifying, setVerifying] = useState(false)
  const [verifyError, setVerifyError] = useState<string | null>(null)

  const [mountRoots, setMountRoots] = useState('')
  const [detecting, setDetecting] = useState(false)
  const [detectError, setDetectError] = useState<string | null>(null)
  const [proposed, setProposed] = useState<PathMapping[] | null>(null)

  function updateRow(index: number, patch: Partial<MappingRow>) {
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

  function chooseInstance(index: number, value: string) {
    if (value === UNASSIGNED || value === UNDECIDED) return
    // "none" means BOTH fields empty: a root that is explicitly not torrent-backed.
    if (value === '') updateRow(index, { qbitInstance: null, qbit: null, undecided: false })
    else updateRow(index, { qbitInstance: value, undecided: false })
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
    // must still press "Save mappings" for it to reach the server. A root Auto-detect could not
    // place (no instance's torrents found there, or two instances' both) is undecided, not "none".
    const undecided = mapping.qbit === null && mapping.qbitInstance === null
    setMappings((prev) => [...(prev ?? []), { ...mapping, ...(undecided ? { undecided: true } : {}) }])
    setSaved(false)
  }

  async function save() {
    if (!mappings) return
    // With no instance configured, "none" is the only thing a row can be. Otherwise every row needs
    // an explicit answer — including while the instance list is still loading or failed to load.
    const noInstances = instancesState.kind === 'ok' && instancesState.instances.length === 0
    const undecided = noInstances ? -1 : mappings.findIndex((m) => m.undecided)
    if (undecided !== -1) {
      setSaved(false)
      setSaveError(
        `Mapping ${undecided + 1}: choose the qBittorrent instance whose torrents save into this root, or `
        + '"none (not torrent-backed)" if no torrent ever does. Nothing was saved.',
      )
      return
    }
    setSaving(true)
    setSaveError(null)
    setSaved(false)
    try {
      const res = await api.pathmapPut(mappings.map(normalizeForSave))
      setMappings(res.mappings)
      setProblems(res.problems ?? [])
      // A saved change makes any earlier verification stale; show exactly what the server says now.
      setVerification(res.lastVerification ?? null)
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
      setVerification(await api.pathmapVerify())
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
      setProposed((await api.pathmapDetect(roots)).proposals)
    } catch (err) {
      setDetectError(err instanceof Error ? err.message : 'failed to auto-detect path mappings')
    } finally {
      setDetecting(false)
    }
  }

  const instanceIds = instancesState.kind === 'ok' ? instancesState.instances.map((i) => i.id) : null

  return (
    <div className="settings">
      <section className="panel">
        <h2>Path mappings</h2>

        {loadError ? <p className="alert" role="alert"><span>{loadError}</span></p> : null}
        {instancesState.kind === 'error' ? (
          <p className="alert alert-warn" role="status">
            Could not list the qBittorrent instances ({instancesState.message}). Each row still shows the instance it has saved.
          </p>
        ) : null}

        {!mappings ? (
          <EmptyState>Loading path mappings…</EmptyState>
        ) : (
          <>
            {problems.length > 0 ? (
              <div className="alert alert-warn settings-problems" role="status">
                <span>Mapping problems — each one fails closed until it is fixed:</span>
                <ul>
                  {/* Server-reported text that may quote a path — text nodes only. */}
                  {problems.map((p, i) => <li key={i}>{p}</li>)}
                </ul>
              </div>
            ) : null}

            <table className="table settings-mappings-table">
              <thead>
                <tr>
                  <th scope="col">Role</th>
                  <th scope="col">Jellyfin path</th>
                  <th scope="col">Container path</th>
                  <th scope="col">qBittorrent path</th>
                  <th scope="col">qBittorrent instance</th>
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
                      {/* The root exactly as the chosen instance spells it. Two boxes can both call
                          their library /movies, which is why the instance is picked separately. */}
                      <input
                        aria-label={`qBittorrent path for mapping ${i + 1}`}
                        value={m.qbit ?? ''}
                        onChange={(e) => updateRow(i, { qbit: e.target.value })}
                      />
                    </td>
                    <td>
                      <InstancePicker index={i} mapping={m} state={instancesState} onChoose={(v) => chooseInstance(i, v)} />
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
            {saved ? <p className="alert alert-ok" role="status">Mappings saved. Verify them before the next scan or plan.</p> : null}

            {verifyError ? <p className="alert" role="alert"><span>{verifyError}</span></p> : null}
            {verification ? <VerificationResult record={verification} instanceIds={instanceIds} /> : null}
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
            placeholder="/movies, /tv"
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
                  <th scope="col">qBittorrent instance</th>
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
                    <td>{p.qbitInstance ?? '—'}</td>
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

      <GuardSettingsPanel api={api} />
    </div>
  )
}
