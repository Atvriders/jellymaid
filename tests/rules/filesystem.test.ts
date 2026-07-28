import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../src/index/db.js'
import { FILESYSTEM_RULES } from '../../src/rules/filesystem/index.js'
import { fileConfigSchema } from '../../src/config/schema.js'

let db: Db
const config = fileConfigSchema.parse({})
const ctx = () => ({ db, config, scanId: 1, now: 'T' })
const rule = (id: string) => FILESYSTEM_RULES.find((r) => r.id === id)!

function entry(over: Record<string, unknown>) {
  const row = {
    container_path: '/mnt/m/x', scan_id: 1, parent_path: '/mnt/m', name: 'x', ext: null,
    is_dir: 0, size_bytes: 0, mtime: 0, dev: 1, inode: 1, nlink: 1, is_media: 0,
    library_root: '/mnt/m', root_role: 'library', quick_hash: null, ...over,
  }
  db.prepare(`INSERT OR REPLACE INTO fs_entries (container_path, scan_id, parent_path, name, ext,
    is_dir, size_bytes, mtime, dev, inode, nlink, is_media, library_root, root_role, quick_hash)
    VALUES (@container_path,@scan_id,@parent_path,@name,@ext,@is_dir,@size_bytes,@mtime,@dev,
            @inode,@nlink,@is_media,@library_root,@root_role,@quick_hash)`).run(row)
}

function jfItem(id: string, containerPath: string | null) {
  db.prepare(`INSERT INTO jellyfin_items (id, scan_id, type, name, container_path, has_primary_image)
    VALUES (?,1,'Movie','n',?,1)`).run(id, containerPath)
}

beforeEach(() => { db = openDb(join(mkdtempSync(join(tmpdir(), 'jm-fsrule-')), 'db.sqlite')) })

describe('fs.empty-folder', () => {
  it('reports a directory containing nothing', () => {
    entry({ container_path: '/mnt/m/Empty', name: 'Empty', is_dir: 1 })
    const f = rule('fs.empty-folder').run(ctx())
    expect(f).toHaveLength(1)
    expect(f[0]!.subjects[0]!.path).toBe('/mnt/m/Empty')
  })

  it('reports a directory holding only ignorable files', () => {
    entry({ container_path: '/mnt/m/Junky', name: 'Junky', is_dir: 1 })
    entry({ container_path: '/mnt/m/Junky/Thumbs.db', parent_path: '/mnt/m/Junky', name: 'Thumbs.db', ext: '.db' })
    expect(rule('fs.empty-folder').run(ctx())).toHaveLength(1)
  })

  it('does not report a directory containing media', () => {
    entry({ container_path: '/mnt/m/Full', name: 'Full', is_dir: 1 })
    entry({ container_path: '/mnt/m/Full/a.mkv', parent_path: '/mnt/m/Full', name: 'a.mkv', ext: '.mkv', is_media: 1 })
    expect(rule('fs.empty-folder').run(ctx())).toHaveLength(0)
  })

  it('reports only the topmost empty root, not every nested descendant', () => {
    entry({ container_path: '/mnt/m/A', name: 'A', is_dir: 1 })
    entry({ container_path: '/mnt/m/A/B', parent_path: '/mnt/m/A', name: 'B', is_dir: 1 })
    entry({ container_path: '/mnt/m/A/B/C', parent_path: '/mnt/m/A/B', name: 'C', is_dir: 1 })
    const f = rule('fs.empty-folder').run(ctx())
    expect(f).toHaveLength(1)
    expect(f[0]!.subjects[0]!.path).toBe('/mnt/m/A')
  })

  it('never reports a library root itself', () => {
    entry({ container_path: '/mnt/m', name: 'm', is_dir: 1, parent_path: '/mnt' })
    expect(rule('fs.empty-folder').run(ctx())).toHaveLength(0)
  })
})

describe('fs.orphan-media', () => {
  it('reports media under a library root that Jellyfin does not know', () => {
    entry({ container_path: '/mnt/m/Orphan.mkv', name: 'Orphan.mkv', ext: '.mkv', is_media: 1, size_bytes: 500 })
    const f = rule('fs.orphan-media').run(ctx())
    expect(f).toHaveLength(1)
    expect(f[0]!.reclaimableBytes).toBe(500)
  })

  it('does not report media Jellyfin references', () => {
    entry({ container_path: '/mnt/m/Known.mkv', name: 'Known.mkv', ext: '.mkv', is_media: 1 })
    jfItem('i1', '/mnt/m/Known.mkv')
    expect(rule('fs.orphan-media').run(ctx())).toHaveLength(0)
  })

  it('ignores download roots entirely — nothing there is expected in Jellyfin', () => {
    entry({ container_path: '/mnt/d/x.mkv', name: 'x.mkv', ext: '.mkv', is_media: 1, library_root: '/mnt/d', root_role: 'download' })
    expect(rule('fs.orphan-media').run(ctx())).toHaveLength(0)
  })
})

describe('fs.missing-file', () => {
  it('reports a Jellyfin item whose path is absent from the index', () => {
    jfItem('i1', '/mnt/m/Gone.mkv')
    const f = rule('fs.missing-file').run(ctx())
    expect(f).toHaveLength(1)
    expect(f[0]!.severity).toBe('critical')
  })

  it('does not report an item whose file exists', () => {
    entry({ container_path: '/mnt/m/Here.mkv', name: 'Here.mkv', ext: '.mkv', is_media: 1 })
    jfItem('i1', '/mnt/m/Here.mkv')
    expect(rule('fs.missing-file').run(ctx())).toHaveLength(0)
  })

  it('does not report items with no path at all — those are Series and Season rows', () => {
    jfItem('i1', null)
    expect(rule('fs.missing-file').run(ctx())).toHaveLength(0)
  })
})

describe('fs.junk', () => {
  it.each([
    ['sample.mkv', '.mkv'],
    ['movie.mkv.part', '.part'],
    ['movie.mkv.!qB', '.!qb'],
    ['film-sample.mp4', '.mp4'],
  ])('flags %s', (name, ext) => {
    entry({ container_path: `/mnt/m/${name}`, name, ext })
    expect(rule('fs.junk').run(ctx())).toHaveLength(1)
  })

  it('flags a zero-byte media file', () => {
    entry({ container_path: '/mnt/m/broken.mkv', name: 'broken.mkv', ext: '.mkv', is_media: 1, size_bytes: 0 })
    expect(rule('fs.junk').run(ctx())).toHaveLength(1)
  })

  it('does not flag an ordinary media file', () => {
    entry({ container_path: '/mnt/m/Heat.mkv', name: 'Heat.mkv', ext: '.mkv', is_media: 1, size_bytes: 5_000_000_000 })
    expect(rule('fs.junk').run(ctx())).toHaveLength(0)
  })
})

describe('fs.stray-sidecar', () => {
  it('reports a subtitle with no media beside it', () => {
    entry({ container_path: '/mnt/m/Heat.srt', name: 'Heat.srt', ext: '.srt' })
    expect(rule('fs.stray-sidecar').run(ctx())).toHaveLength(1)
  })

  it('does not report a subtitle sitting next to its media', () => {
    entry({ container_path: '/mnt/m/Heat.srt', name: 'Heat.srt', ext: '.srt' })
    entry({ container_path: '/mnt/m/Heat.mkv', name: 'Heat.mkv', ext: '.mkv', is_media: 1 })
    expect(rule('fs.stray-sidecar').run(ctx())).toHaveLength(0)
  })
})

describe('fs.permission', () => {
  it('reports a path recorded as unreadable during the walk', () => {
    db.prepare("INSERT INTO kv (key, value_json) VALUES ('scan.fsErrors', ?)")
      .run(JSON.stringify([{ path: '/mnt/m/locked', reason: 'EACCES' }]))
    const f = rule('fs.permission').run(ctx())
    expect(f).toHaveLength(1)
    expect(f[0]!.evidence.reason).toBe('EACCES')
  })

  it('reports nothing when the walk recorded no errors', () => {
    expect(rule('fs.permission').run(ctx())).toHaveLength(0)
  })
})
