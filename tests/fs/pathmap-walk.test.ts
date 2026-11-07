import { afterAll, describe, it, expect } from 'vitest'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { autoDetectMappings, walkDirs } from '../../src/fs/pathmap.js'

// Every directory a test makes is removed afterwards: these run on shared machines whose disks fill up.
const made: string[] = []
afterAll(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }) })
const tmp = (label: string) => {
  const dir = mkdtempSync(join(tmpdir(), `jm-pmwalk-${label}-`))
  made.push(dir)
  return dir
}

describe('walkDirs — the directory walk Auto-detect enumerates a mount with', () => {
  it('lists the root and every directory under it, parents before their children, files never', async () => {
    const root = tmp('basic')
    mkdirSync(join(root, 'a', 'x'), { recursive: true })
    mkdirSync(join(root, 'b'))
    writeFileSync(join(root, 'a', 'file.mkv'), 'x')
    const dirs = await walkDirs(root, 4)
    expect(dirs[0]).toBe(root)
    expect([...dirs].sort()).toEqual([root, join(root, 'a'), join(root, 'a', 'x'), join(root, 'b')].sort())
    expect(dirs.indexOf(join(root, 'a'))).toBeLessThan(dirs.indexOf(join(root, 'a', 'x')))
  })

  it('stops at maxDepth: a directory at the limit is listed, its children are not', async () => {
    const root = tmp('depth')
    mkdirSync(join(root, 'a', 'b', 'c'), { recursive: true })
    expect([...(await walkDirs(root, 2))].sort()).toEqual([root, join(root, 'a'), join(root, 'a', 'b')].sort())
    expect(await walkDirs(root, 0)).toEqual([root])
  })

  it('skips hidden directories', async () => {
    const root = tmp('hidden')
    mkdirSync(join(root, '.cache', 'deep'), { recursive: true })
    mkdirSync(join(root, 'Movies'))
    expect([...(await walkDirs(root, 4))].sort()).toEqual([root, join(root, 'Movies')].sort())
  })

  it('answers nothing for a root that does not exist', async () => {
    expect(await walkDirs(join(tmp('missing'), 'nope'), 4)).toEqual([])
  })

  it('follows a symlink to a directory, as the synchronous walk it replaces did, and ignores a dangling one', async () => {
    const root = tmp('links')
    const elsewhere = tmp('links-target')
    mkdirSync(join(elsewhere, 'inner'))
    symlinkSync(elsewhere, join(root, 'linked'))
    symlinkSync(join(root, 'does-not-exist'), join(root, 'dangling'))
    const dirs = await walkDirs(root, 4)
    expect(dirs).toContain(join(root, 'linked'))
    expect(dirs).toContain(join(root, 'linked', 'inner'))
    expect(dirs).not.toContain(join(root, 'dangling'))
  })

  it('terminates on a symlink loop', async () => {
    const root = tmp('loop')
    mkdirSync(join(root, 'a'))
    symlinkSync(root, join(root, 'a', 'back'))
    const dirs = await walkDirs(root, 4)
    expect(dirs.length).toBeLessThan(20)
    expect(dirs[0]).toBe(root)
  })

  it('lets a timer scheduled before it fire while it is still walking', async () => {
    const root = tmp('yield')
    for (let i = 0; i < 300; i += 1) mkdirSync(join(root, `d${String(i).padStart(4, '0')}`))
    const events: string[] = []
    setTimeout(() => events.push('timer'), 0)
    const dirs = await walkDirs(root, 4)
    events.push('walk finished')
    // The walk it replaces enumerated all of this inside one turn of the event loop.
    expect(events).toEqual(['timer', 'walk finished'])
    expect(dirs).toHaveLength(301)
  })

  // A directory the process may not read is still a directory: it is listed, just not descended into.
  it.skipIf(process.getuid?.() === 0)('lists a directory it cannot read without failing the walk', async () => {
    const root = tmp('unreadable')
    mkdirSync(join(root, 'locked', 'inside'), { recursive: true })
    mkdirSync(join(root, 'open'))
    chmodSync(join(root, 'locked'), 0o000)
    try {
      const dirs = await walkDirs(root, 4)
      expect(dirs).toContain(join(root, 'locked'))
      expect(dirs).not.toContain(join(root, 'locked', 'inside'))
      expect(dirs).toContain(join(root, 'open'))
    } finally {
      chmodSync(join(root, 'locked'), 0o755)
    }
  })
})

describe('autoDetectMappings — does not hold the server hostage while it searches a library', () => {
  /**
   * A mount with many sibling directories and one real library root at the END, so every sampled
   * item has to be probed against hundreds of candidates before it matches.
   */
  function bigMount(siblings: number, films: number) {
    const mount = tmp('big')
    for (let i = 0; i < siblings; i += 1) mkdirSync(join(mount, `d${String(i).padStart(4, '0')}`))
    for (let i = 0; i < films; i += 1) {
      mkdirSync(join(mount, 'zz-library', `Film ${i} (2000)`), { recursive: true })
      writeFileSync(join(mount, 'zz-library', `Film ${i} (2000)`, `Film${i}.mkv`), 'x')
    }
    const items = Array.from({ length: films }, (_, i) => ({ id: `m${i}`, jfPath: `/media/Movies/Film ${i} (2000)/Film${i}.mkv` }))
    return { mount, items }
  }

  it('lets a timer scheduled before it fire while it is still probing candidates', async () => {
    const { mount, items } = bigMount(300, 8)
    // The directory list is handed over synchronously, so the only thing that can give the event
    // loop a turn is the probing itself: 8 items against ~300 candidate directories each.
    const dirs = [mount, ...Array.from({ length: 300 }, (_, i) => join(mount, `d${String(i).padStart(4, '0')}`)), join(mount, 'zz-library')]
    const events: string[] = []
    setTimeout(() => events.push('timer'), 0)
    const proposed = await autoDetectMappings({ mountRoots: [mount], sampleItems: async () => items, walk: () => dirs })
    events.push('detect finished')
    // Probing with synchronous stats would run the whole search inside one turn of the event loop,
    // so the timer — due since the first millisecond — could only fire after the answer was back.
    expect(events).toEqual(['timer', 'detect finished'])
    expect(proposed).toEqual([
      { role: 'library', jellyfin: '/media/Movies', container: join(mount, 'zz-library'), qbit: null, qbitInstance: null },
    ])
  })

  it('accepts a walk that answers asynchronously and still enumerates each mount once', async () => {
    const { mount, items } = bigMount(5, 3)
    const walked: string[] = []
    const proposed = await autoDetectMappings({
      mountRoots: [mount],
      sampleItems: async () => items,
      walk: async (root, maxDepth) => { walked.push(root); return walkDirs(root, maxDepth) },
    })
    expect(walked).toEqual([mount])
    expect(proposed).toHaveLength(1)
  })

  it('keeps choosing the first match in mount and directory order, however many probes run side by side', async () => {
    // Two directories both corroborate the same suffix. The one listed first must win, which a
    // parallel probe that kept whichever answered first would not guarantee.
    const mount = tmp('order')
    for (let i = 0; i < 70; i += 1) mkdirSync(join(mount, `a${String(i).padStart(3, '0')}`))
    for (const lib of ['m010', 'm060']) {
      mkdirSync(join(mount, lib, 'Heat (1995)'), { recursive: true })
      writeFileSync(join(mount, lib, 'Heat (1995)', 'Heat.mkv'), 'x')
    }
    const dirs = [mount, ...Array.from({ length: 70 }, (_, i) => join(mount, `a${String(i).padStart(3, '0')}`)),
      join(mount, 'm060'), join(mount, 'm010')]
    const proposed = await autoDetectMappings({
      mountRoots: [mount],
      sampleItems: async () => [{ id: 'i1', jfPath: '/media/Movies/Heat (1995)/Heat.mkv' }],
      walk: () => dirs,
    })
    expect(proposed).toEqual([
      { role: 'library', jellyfin: '/media/Movies', container: join(mount, 'm060'), qbit: null, qbitInstance: null },
    ])
  })
})
