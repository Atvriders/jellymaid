import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import { mkdtempSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../src/index/db.js'
import { registerExplorerRoutes } from '../../src/api/explorer.js'
import { signSession } from '../../src/auth/session.js'
import { createPathMap } from '../../src/fs/pathmap.js'
import type { PathMapping } from '../../src/core/types.js'

const SECRET = 'e'.repeat(32)
// isAdministrator is a REQUIRED field on SessionPayload (src/auth/session.ts) and requireSession
// re-asserts it on every request (src/api/auth.ts) — a session minted without it is treated as
// unauthenticated, same as no session at all. Every other route test in this codebase
// (tests/api/findings.test.ts, tests/api/pathmap.test.ts) sets it; this one must too.
const auth = () => ({ cookie: `jellymaid_session=${signSession({ username: 'bob', userId: 'u', issuedAt: Date.now(), isAdministrator: true }, SECRET)}` })

const DEFAULT_MAPPINGS: PathMapping[] = [{ role: 'library', jellyfin: '/media', container: '/mnt/m', qbit: null }]

let db: Db
function build(mappings: PathMapping[] = DEFAULT_MAPPINGS) {
  const app = Fastify()
  app.register(cookie)
  registerExplorerRoutes(app, { db, sessionSecret: SECRET, pathMap: createPathMap(mappings) })
  return app
}

function entry(path: string, over: Record<string, unknown> = {}) {
  db.prepare(`INSERT OR REPLACE INTO fs_entries (container_path, scan_id, parent_path, name, ext,
    is_dir, size_bytes, mtime, dev, inode, nlink, is_media, library_root, root_role)
    VALUES (@container_path,1,@parent_path,@name,@ext,@is_dir,@size_bytes,0,1,1,1,@is_media,'/mnt/m','library')`)
    .run({
      container_path: path, parent_path: path.slice(0, path.lastIndexOf('/')) || '/',
      name: path.slice(path.lastIndexOf('/') + 1), ext: null, is_dir: 0, size_bytes: 100, is_media: 0, ...over,
    })
}

beforeEach(() => { db = openDb(join(mkdtempSync(join(tmpdir(), 'jm-exp-')), 'db.sqlite')) })

describe('/api/explorer', () => {
  it('requires a session', async () => {
    expect((await build().inject({ method: 'GET', url: '/api/explorer' })).statusCode).toBe(401)
  })

  it('lists the configured roots when no path is given', async () => {
    const body = (await build().inject({ method: 'GET', url: '/api/explorer', headers: auth() })).json()
    expect(body.entries.map((e: { path: string }) => e.path)).toEqual(['/mnt/m'])
    expect(body.parent).toBeNull()
  })

  it('lists the children of a directory', async () => {
    entry('/mnt/m/Heat', { is_dir: 1 })
    entry('/mnt/m/Heat/Heat.mkv', { is_media: 1, size_bytes: 500 })
    const body = (await build().inject({ method: 'GET', url: '/api/explorer?path=/mnt/m/Heat', headers: auth() })).json()
    expect(body.entries).toHaveLength(1)
    expect(body.entries[0].name).toBe('Heat.mkv')
    expect(body.entries[0].sizeBytes).toBe(500)
  })

  it('rolls up directory size and file count from descendants', async () => {
    entry('/mnt/m/Heat', { is_dir: 1 })
    entry('/mnt/m/Heat/a.mkv', { is_media: 1, size_bytes: 300 })
    entry('/mnt/m/Heat/b.mkv', { is_media: 1, size_bytes: 200 })
    const body = (await build().inject({ method: 'GET', url: '/api/explorer?path=/mnt/m', headers: auth() })).json()
    const dir = body.entries.find((e: { name: string }) => e.name === 'Heat')
    expect(dir.sizeBytes).toBe(500)
    expect(dir.fileCount).toBe(2)
  })

  it('flags entries that have open findings', async () => {
    entry('/mnt/m/orphan.mkv', { is_media: 1 })
    db.prepare(`INSERT INTO findings (id, rule_id, class, severity, confidence, subjects_json,
      evidence_json, reclaimable_bytes, status, first_seen, last_seen)
      VALUES ('f1','fs.orphan-media','filesystem','warning','exact',
              '[{"kind":"path","path":"/mnt/m/orphan.mkv","label":"x"}]','{}',1,'open','T','T')`).run()
    const body = (await build().inject({ method: 'GET', url: '/api/explorer?path=/mnt/m', headers: auth() })).json()
    expect(body.entries.find((e: { name: string }) => e.name === 'orphan.mkv').flags).toContain('orphan')
  })

  it('does not flag an entry whose only findings are dismissed or resolved', async () => {
    entry('/mnt/m/junk.nfo', { is_media: 0 })
    db.prepare(`INSERT INTO findings (id, rule_id, class, severity, confidence, subjects_json,
      evidence_json, reclaimable_bytes, status, first_seen, last_seen)
      VALUES ('f1','fs.junk','filesystem','warning','exact',
              '[{"kind":"path","path":"/mnt/m/junk.nfo","label":"x"}]','{}',1,'dismissed','T','T')`).run()
    const body = (await build().inject({ method: 'GET', url: '/api/explorer?path=/mnt/m', headers: auth() })).json()
    expect(body.entries.find((e: { name: string }) => e.name === 'junk.nfo').flags).toEqual([])
  })

  it('does not let a directory name that contains a LIKE wildcard pull in an unrelated sibling\'s bytes', async () => {
    // `_` (and `%`) are SQL LIKE wildcards, not just characters — and scene-release naming makes
    // `_` routine in real directory names. Unescaped, `LIKE '.../Movie_Name/%'` would also match
    // the completely unrelated `/mnt/m/MovieXName` sibling (`_` matching any one character).
    entry('/mnt/m/Movie_Name', { is_dir: 1 })
    entry('/mnt/m/Movie_Name/a.mkv', { is_media: 1, size_bytes: 100 })
    entry('/mnt/m/MovieXName', { is_dir: 1 })
    entry('/mnt/m/MovieXName/b.mkv', { is_media: 1, size_bytes: 9000 })
    const body = (await build().inject({ method: 'GET', url: '/api/explorer?path=/mnt/m', headers: auth() })).json()
    const dir = body.entries.find((e: { name: string }) => e.name === 'Movie_Name')
    expect(dir.sizeBytes).toBe(100)
    expect(dir.fileCount).toBe(1)
  })

  it('refuses a path outside every configured root', async () => {
    expect((await build().inject({ method: 'GET', url: '/api/explorer?path=/etc', headers: auth() })).statusCode).toBe(400)
  })

  it('rejects a malformed query (repeated path params) rather than guessing which one was meant', async () => {
    const res = await build().inject({ method: 'GET', url: '/api/explorer?path=/mnt/m&path=/mnt/m/x', headers: auth() })
    expect(res.statusCode).toBe(400)
  })

  // --- Containment is a security boundary: every known escape vector gets its own explicit test,
  // reusing isWithinRoot (src/fs/pathmap.ts) rather than a second, route-local containment check. ---
  describe('containment — escape attempts', () => {
    it('refuses a symlink planted inside a library root that resolves outside it', async () => {
      const base = mkdtempSync(join(tmpdir(), 'jm-exp-symlink-'))
      const libRoot: PathMapping = { role: 'library', jellyfin: '/media', container: join(base, 'lib'), qbit: null }
      mkdirSync(libRoot.container, { recursive: true })
      mkdirSync(join(base, 'secret'), { recursive: true })
      const escapeLink = join(libRoot.container, 'escape-link')
      symlinkSync(join(base, 'secret'), escapeLink)

      const res = await build([libRoot]).inject({
        method: 'GET', url: `/api/explorer?path=${encodeURIComponent(escapeLink)}`, headers: auth(),
      })
      expect(res.statusCode).toBe(400)
    })

    it('refuses a .. traversal that lexically starts under the root but resolves outside it', async () => {
      const base = mkdtempSync(join(tmpdir(), 'jm-exp-dotdot-'))
      const libRoot: PathMapping = { role: 'library', jellyfin: '/media', container: join(base, 'lib'), qbit: null }
      mkdirSync(libRoot.container, { recursive: true })
      mkdirSync(join(base, 'secret'), { recursive: true })
      const traversal = `${libRoot.container}/../secret`

      const res = await build([libRoot]).inject({
        method: 'GET', url: `/api/explorer?path=${encodeURIComponent(traversal)}`, headers: auth(),
      })
      expect(res.statusCode).toBe(400)
    })

    it('refuses an absolute path outside every configured root, even one that genuinely exists on disk', async () => {
      // A real, guaranteed-to-exist directory (unlike /etc, which may not exist in every
      // environment this suite runs in) that is nowhere under the one configured library root.
      const outside = tmpdir()
      const res = await build().inject({
        method: 'GET', url: `/api/explorer?path=${encodeURIComponent(outside)}`, headers: auth(),
      })
      expect(res.statusCode).toBe(400)
    })
  })
})
