import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, linkSync, symlinkSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { walkRoot, TRASH_DIR_NAME, type FsEntry } from '../../src/fs/walker.js'
import type { PathMapping } from '../../src/core/types.js'

let dir: string
const libraryRoot = (container: string): PathMapping =>
  ({ role: 'library', jellyfin: '/media/Movies', container, qbit: null, qbitInstance: null })

async function collect(root: PathMapping, over: Partial<Parameters<typeof walkRoot>[0]> = {}) {
  const out: FsEntry[] = []
  for await (const batch of walkRoot({
    root,
    mediaExtensions: ['.mkv', '.mp4'],
    batchSize: 3,
    ...over,
  })) out.push(...batch)
  return out
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jm-walk-'))
  mkdirSync(join(dir, 'Heat (1995)'), { recursive: true })
  writeFileSync(join(dir, 'Heat (1995)', 'Heat.mkv'), 'a'.repeat(100))
  writeFileSync(join(dir, 'Heat (1995)', 'Heat.nfo'), 'meta')
  mkdirSync(join(dir, 'Empty'), { recursive: true })
})

describe('walkRoot', () => {
  it('emits both files and directories with parent linkage', async () => {
    const entries = await collect(libraryRoot(dir))
    const byPath = new Map(entries.map((e) => [e.containerPath, e]))
    const file = byPath.get(join(dir, 'Heat (1995)', 'Heat.mkv'))!
    expect(file.isDir).toBe(false)
    expect(file.parentPath).toBe(join(dir, 'Heat (1995)'))
    expect(byPath.get(join(dir, 'Empty'))!.isDir).toBe(true)
  })

  it('captures dev, inode and nlink', async () => {
    const entries = await collect(libraryRoot(dir))
    const file = entries.find((e) => e.name === 'Heat.mkv')!
    expect(file.inode).toBeGreaterThan(0)
    expect(file.dev).toBeGreaterThan(0)
    expect(file.nlink).toBe(1)
  })

  it('reports nlink 2 for a hardlinked file and the same inode for both links', async () => {
    linkSync(join(dir, 'Heat (1995)', 'Heat.mkv'), join(dir, 'Heat-link.mkv'))
    const entries = await collect(libraryRoot(dir))
    const a = entries.find((e) => e.name === 'Heat.mkv')!
    const b = entries.find((e) => e.name === 'Heat-link.mkv')!
    expect(a.nlink).toBe(2)
    expect(b.nlink).toBe(2)
    expect(a.inode).toBe(b.inode)
    expect(a.dev).toBe(b.dev)
  })

  it('flags media by extension, case-insensitively', async () => {
    writeFileSync(join(dir, 'Loud.MKV'), 'x')
    const entries = await collect(libraryRoot(dir))
    expect(entries.find((e) => e.name === 'Heat.mkv')!.isMedia).toBe(true)
    expect(entries.find((e) => e.name === 'Loud.MKV')!.isMedia).toBe(true)
    expect(entries.find((e) => e.name === 'Heat.nfo')!.isMedia).toBe(false)
  })

  it('never descends into .jellymaid-trash', async () => {
    mkdirSync(join(dir, TRASH_DIR_NAME, 'plan-1'), { recursive: true })
    writeFileSync(join(dir, TRASH_DIR_NAME, 'plan-1', 'Old.mkv'), 'x')
    const entries = await collect(libraryRoot(dir))
    expect(entries.some((e) => e.containerPath.includes(TRASH_DIR_NAME))).toBe(false)
  })

  it('yields in batches no larger than batchSize', async () => {
    const sizes: number[] = []
    for await (const batch of walkRoot({ root: libraryRoot(dir), mediaExtensions: ['.mkv'], batchSize: 2 })) {
      sizes.push(batch.length)
    }
    expect(Math.max(...sizes)).toBeLessThanOrEqual(2)
  })

  it('does not follow symlinks out of the root', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'jm-outside-'))
    writeFileSync(join(outside, 'Escaped.mkv'), 'x')
    symlinkSync(outside, join(dir, 'link'))
    const entries = await collect(libraryRoot(dir))
    expect(entries.some((e) => e.name === 'Escaped.mkv')).toBe(false)
  })

  it('emits a row with NULL stat fields for an entry it cannot stat, rather than omitting it', async () => {
    // A missing row reads as "the file is gone" to the filesystem rules. Unknown must be
    // representable, and it must be NULL — 0 would collide on the (dev, inode) index.
    const entries = await collect(libraryRoot(dir), {
      onError: () => {},
      lstatImpl: async (p: string) => {
        if (String(p).endsWith('Heat.mkv')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
        return (await import('node:fs/promises')).lstat(String(p))
      },
    })
    const row = entries.find((e) => e.name === 'Heat.mkv')!
    expect(row).toBeDefined()
    expect(row.dev).toBeNull()
    expect(row.inode).toBeNull()
    expect(row.nlink).toBeNull()
  })

  it('flags an unstattable entry as media when its extension matches, despite the failed lstat', async () => {
    // The row exists precisely so the file does not read as "gone" — it must not also drop out
    // of every media-scoped rule just because the extension check happens on the error path.
    const entries = await collect(libraryRoot(dir), {
      onError: () => {},
      lstatImpl: async (p: string) => {
        if (String(p).endsWith('Heat.mkv')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
        return (await import('node:fs/promises')).lstat(String(p))
      },
    })
    const row = entries.find((e) => e.name === 'Heat.mkv')!
    expect(row).toBeDefined()
    expect(row.isMedia).toBe(true)
    expect(row.dev).toBeNull()
    expect(row.inode).toBeNull()
    expect(row.nlink).toBeNull()
  })

  it('records an unreadable directory instead of aborting the walk', async () => {
    const locked = join(dir, 'locked')
    mkdirSync(locked)
    writeFileSync(join(locked, 'x.mkv'), 'x')
    chmodSync(locked, 0o000)
    const errors: Array<{ path: string; reason: string }> = []
    const entries = await collect(libraryRoot(dir), { onError: (e) => errors.push(e) })
    chmodSync(locked, 0o755)
    expect(entries.some((e) => e.name === 'Heat.mkv')).toBe(true)
    expect(errors.some((e) => e.path === locked)).toBe(true)
  })

  it('tags every entry with its root and role', async () => {
    const entries = await collect({ role: 'download', jellyfin: null, container: dir, qbit: '/downloads', qbitInstance: 'box-a' })
    expect(entries.every((e) => e.libraryRoot === dir && e.rootRole === 'download')).toBe(true)
  })

  it('stops promptly when the caller signals cancellation', async () => {
    const controller = new AbortController()
    let seen = 0
    for await (const batch of walkRoot({ root: libraryRoot(dir), mediaExtensions: ['.mkv'], batchSize: 1, signal: controller.signal })) {
      seen += batch.length
      controller.abort()
    }
    expect(seen).toBe(1)
  })
})
