import { statSync } from 'node:fs'
import { configPath, readFileConfig, saveConfig } from './load.js'
import type { EnvConfig, FileConfig } from './schema.js'
import { createPathMap, mappingsHash, normalizeMappings, type PathMap } from '../fs/pathmap.js'
import type { PathMapping } from '../core/types.js'

/**
 * The live view of config.json. Settings, path mappings, guard thresholds and the keeper policy
 * all change at runtime now, so nothing that acts on them may hold a copy taken at boot: every
 * reader asks the store, and the store re-reads the file when it changes. A caller that needs one
 * consistent view for a whole operation (a plan run) takes `file()`/`pathMap()` once at its start
 * and uses that snapshot throughout.
 */
export interface ConfigStore {
  readonly env: EnvConfig
  /** Cached; re-read when config.json's mtimeMs or size changes. Throws ConfigError if invalid. */
  file(): FileConfig
  /** createPathMap(normalizeMappings(file().pathMappings, instanceIds()).mappings), memoized on the mappings' JSON. */
  pathMap(): PathMap
  mappingProblems(): string[]
  /** mappingsHash() of the NORMALIZED mappings. */
  mappingsHash(): string
  instanceIds(): string[]
  /** saveConfig + cache invalidation. */
  save(patch: Partial<FileConfig>): FileConfig
}

export function createConfigStore(env: EnvConfig): ConfigStore {
  const path = configPath(env.dataDir)
  const instanceIds = env.qbittorrents.map((i) => i.id)

  let cached: { key: string; config: FileConfig } | null = null
  let normalized: { config: FileConfig; mappings: PathMapping[]; problems: string[] } | null = null
  let built: { json: string; map: PathMap } | null = null

  /**
   * What identifies one version of the file. mtime and size catch an edit in place; the inode
   * catches `saveConfig`'s write-then-rename even in the unlikely case both of those come out equal.
   */
  function fileKey(): string {
    try {
      const st = statSync(path)
      return `${st.mtimeMs}:${st.size}:${st.ino}`
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'
      throw err
    }
  }

  function file(): FileConfig {
    const key = fileKey()
    if (cached && cached.key === key) return cached.config
    // A read that throws is not cached: every call re-reads (and re-throws) until the file is
    // fixed, so a broken edit can never be papered over by the last good copy.
    const config = readFileConfig(env.dataDir)
    cached = { key, config }
    return config
  }

  function normalize(): { mappings: PathMapping[]; problems: string[] } {
    const config = file()
    if (!normalized || normalized.config !== config) {
      normalized = { config, ...normalizeMappings(config.pathMappings, instanceIds) }
    }
    return normalized
  }

  return {
    env,
    file,
    pathMap() {
      const { mappings } = normalize()
      // Memoized on the mappings themselves, not on the file: an edit to a threshold must not throw
      // away the root-resolution cache every isWithinRoot call relies on.
      const json = JSON.stringify(mappings)
      if (!built || built.json !== json) built = { json, map: createPathMap(mappings) }
      return built.map
    },
    mappingProblems: () => [...normalize().problems],
    mappingsHash: () => mappingsHash(normalize().mappings),
    instanceIds: () => [...instanceIds],
    save(patch) {
      const saved = saveConfig(env.dataDir, patch)
      cached = null
      return saved
    },
  }
}
