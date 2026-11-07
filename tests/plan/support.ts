import type { Db } from '../../src/index/db.js'
import type { FileConfig } from '../../src/config/schema.js'
import { mappingsHash, type PathMap } from '../../src/fs/pathmap.js'
import { writeVerification } from '../../src/scan/verification.js'

/** The part of ConfigStore the plan pipeline reads, over values a test controls. */
export interface TestConfigStore {
  file(): FileConfig
  pathMap(): PathMap
  mappingsHash(): string
  instanceIds(): string[]
}

/** A config store whose mapping hash is computed from the path map exactly as the real store does. */
export function configStoreOf(config: () => FileConfig, pathMap: () => PathMap, instanceIds: string[] = ['box-a']): TestConfigStore {
  return {
    file: config,
    pathMap,
    mappingsHash: () => mappingsHash(pathMap().all()),
    instanceIds: () => [...instanceIds],
  }
}

/** Writes what a clean Verify of the store's CURRENT mapping set writes, so a plan build may proceed. */
export function verifyMappings(db: Db, store: Pick<TestConfigStore, 'mappingsHash' | 'instanceIds'>): void {
  writeVerification(db, {
    at: new Date().toISOString(),
    mappingsHash: store.mappingsHash(),
    jellyfin: { sampled: 1, resolved: 1, failures: [] },
    qbit: store.instanceIds().map((instanceId) => ({ instanceId, sampled: 0, resolved: 0, failures: [] })),
  })
}
