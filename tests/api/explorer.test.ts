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

const DEFAULT_MAPPINGS: PathMapping[] = [{ role: 'library', jellyfin: '/media', container: '/mnt/m', qbit: null, qbitInstance: null }]

let db: Db
function build(mappings: PathMapping[] = DEFAULT_MAPPINGS) {
  const app = Fastify()
  app.register(cookie)
  const pathMap = createPathMap(mappings)
  registerExplorerRoutes(app, { db, sessionSecret: SECRET, configStore: { pathMap: () => pathMap } })
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

  // The paging fields are part of every response, so a client's pager never has to special-case
  // the top level — and they have to be true there too, not placeholders.
  it('reports total, offset and limit for the list of roots as well', async () => {
    const two: PathMapping[] = [
      ...DEFAULT_MAPPINGS,
      { role: 'download', jellyfin: null, container: '/mnt/d', qbit: null, qbitInstance: null },
    ]
    const all = (await build(two).inject({ method: 'GET', url: '/api/explorer', headers: auth() })).json()
    expect(all).toMatchObject({ total: 2, offset: 0, limit: 500 })
    expect(all.entries).toHaveLength(2)

    const second = (await build(two).inject({ method: 'GET', url: '/api/explorer?limit=1&offset=1', headers: auth() })).json()
    expect(second).toMatchObject({ total: 2, offset: 1, limit: 1 })
    expect(second.entries.map((e: { path: string }) => e.path)).toEqual(['/mnt/d'])
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

  it('rolls up correctly for a directory name containing %, _ and a literal backslash, without pulling in an unrelated sibling\'s bytes', async () => {
    // `%`, `_` and `\` are SQL LIKE metacharacters, not just directory-name characters — and
    // scene-release naming makes `_` routine in real directory names. The rollup query no longer
    // uses LIKE at all (see the range-scan rewrite in src/api/explorer.ts, finding 1), so none of
    // this needs escaping any more — but the regression this test used to guard (an unescaped `_`
    // silently pulling in `/mnt/m/MovieXName`'s bytes) must still be impossible under the new
    // query, and a directory name carrying all three characters at once must still roll up to
    // exactly its own bytes.
    entry('/mnt/m/Movie_Name%Extra\\End', { is_dir: 1 })
    entry('/mnt/m/Movie_Name%Extra\\End/a.mkv', { is_media: 1, size_bytes: 100 })
    entry('/mnt/m/MovieXNameXExtraXEnd', { is_dir: 1 })
    entry('/mnt/m/MovieXNameXExtraXEnd/b.mkv', { is_media: 1, size_bytes: 9000 })
    const body = (await build().inject({ method: 'GET', url: '/api/explorer?path=/mnt/m', headers: auth() })).json()
    const dir = body.entries.find((e: { name: string }) => e.name === 'Movie_Name%Extra\\End')
    expect(dir.sizeBytes).toBe(100)
    expect(dir.fileCount).toBe(1)
  })

  // Finding 2: a trailing slash used to miss the root-equality check (`requested === root.container`)
  // and the child query's exact `parent_path = ?` bind, so a populated root reported a phantom
  // self-referential parent AND zero entries.
  describe('trailing slash normalization', () => {
    it('treats a trailing slash on the root the same as the bare root', async () => {
      entry('/mnt/m/Heat', { is_dir: 1 })
      entry('/mnt/m/Heat/a.mkv', { is_media: 1, size_bytes: 100 })
      const body = (await build().inject({ method: 'GET', url: '/api/explorer?path=/mnt/m/', headers: auth() })).json()
      expect(body.parent).toBeNull()
      expect(body.path).toBe('/mnt/m')
      expect(body.entries.map((e: { name: string }) => e.name)).toEqual(['Heat'])
    })

    it('treats a trailing slash on a non-root directory the same as its slash-less form', async () => {
      entry('/mnt/m/Heat', { is_dir: 1 })
      entry('/mnt/m/Heat/Extras', { is_dir: 1 })
      entry('/mnt/m/Heat/Extras/a.mkv', { is_media: 1, size_bytes: 50 })
      const body = (await build().inject({ method: 'GET', url: '/api/explorer?path=/mnt/m/Heat/', headers: auth() })).json()
      expect(body.parent).toBe('/mnt/m')
      expect(body.entries.map((e: { name: string }) => e.name)).toEqual(['Extras'])
    })

    it('does not strip a lone "/" into an empty path', async () => {
      // A lone "/" is not a trailing slash on some longer path — stripping it would produce "",
      // which this route already treats as "no path given" (the configured-roots listing), a
      // completely different response shape than a (rejected, since no root is literally "/")
      // directory listing would be.
      const res = await build().inject({ method: 'GET', url: '/api/explorer?path=/', headers: auth() })
      expect(res.statusCode).toBe(400)
    })
  })

  // Finding 3: flagMap used to load and JSON.parse every open filesystem finding in the database,
  // unbounded by the directory being listed. This proves it stays scoped: a finding belonging to a
  // path outside the current listing must never leak into it, however many other open findings exist.
  it('scopes finding flags to the requested directory, not the whole findings table', async () => {
    entry('/mnt/m/here.mkv', { is_media: 1 })
    db.prepare(`INSERT INTO findings (id, rule_id, class, severity, confidence, subjects_json,
      evidence_json, reclaimable_bytes, status, first_seen, last_seen)
      VALUES ('here-finding','fs.orphan-media','filesystem','warning','exact',
              '[{"kind":"path","path":"/mnt/m/here.mkv","label":"x"}]','{}',1,'open','T','T')`).run()
    // A large number of open filesystem findings for paths that are NOT in this listing — under
    // the old unscoped query these were all loaded and parsed on every request to this directory.
    const insertElsewhere = db.prepare(`INSERT INTO findings (id, rule_id, class, severity, confidence,
      subjects_json, evidence_json, reclaimable_bytes, status, first_seen, last_seen)
      VALUES (@id,'fs.junk','filesystem','warning','exact',@subjects,'{}',1,'open','T','T')`)
    const tx = db.transaction(() => {
      for (let i = 0; i < 500; i += 1) {
        insertElsewhere.run({ id: `elsewhere-${i}`, subjects: JSON.stringify([{ kind: 'path', path: `/mnt/other/${i}.nfo`, label: 'x' }]) })
      }
    })
    tx()
    const body = (await build().inject({ method: 'GET', url: '/api/explorer?path=/mnt/m', headers: auth() })).json()
    const here = body.entries.find((e: { name: string }) => e.name === 'here.mkv')
    expect(here.flags).toEqual(['orphan'])
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
      const libRoot: PathMapping = { role: 'library', jellyfin: '/media', container: join(base, 'lib'), qbit: null, qbitInstance: null }
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
      const libRoot: PathMapping = { role: 'library', jellyfin: '/media', container: join(base, 'lib'), qbit: null, qbitInstance: null }
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

  // Fixwave-2 finding MAJOR 1: commit f6ff6b1 rewrote flagMap to bind one `?` per listed path.
  // SQLite's bind-variable ceiling is 32,766 in this project's better-sqlite3 build — 32,767 trips
  // `SQLITE_ERROR: too many SQL variables` — so a flat directory at or above that many children (a
  // downloads dir, a large music library) 500'd on every listing. The child query also had no
  // LIMIT at all, so even a directory just under that ceiling shipped every row as one JSON body.
  describe('finding MAJOR 1 — large directories (bind-variable ceiling + pagination)', () => {
    const seedFlatChildren = (count: number) => {
      const insert = db.prepare(`INSERT OR REPLACE INTO fs_entries (container_path, scan_id, parent_path, name, ext,
        is_dir, size_bytes, mtime, dev, inode, nlink, is_media, library_root, root_role)
        VALUES (@container_path,1,'/mnt/m',@name,'.mkv',0,100,0,1,@inode,1,1,'/mnt/m','library')`)
      const tx = db.transaction(() => {
        for (let i = 0; i < count; i += 1) {
          const name = `file${i}.mkv`
          insert.run({ container_path: `/mnt/m/${name}`, name, inode: i + 1 })
        }
      })
      tx()
    }

    // 33,000 clears SQLite's 32,766 bind-variable ceiling with room to spare. A page is capped at
    // 1,000 entries now (C12), so no single request can reach that ceiling any more; what this still
    // pins is that a directory far past it lists, counts and pages without an SQLITE_ERROR, and that
    // the largest page (two flag-lookup batches) works.
    it('does not 500 with SQLITE_ERROR when a directory has more children than the SQL bind-variable ceiling', async () => {
      seedFlatChildren(33_000)
      const res = await build().inject({ method: 'GET', url: '/api/explorer?path=/mnt/m&limit=1000', headers: auth() })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.entries).toHaveLength(1_000)
      expect(body.total).toBe(33_000)
    })

    it('explorer pages a 3,000-entry directory and reports total', async () => {
      seedFlatChildren(3_000)
      const get = async (query: string) => {
        const res = await build().inject({ method: 'GET', url: `/api/explorer?path=/mnt/m${query}`, headers: auth() })
        expect(res.statusCode).toBe(200)
        return res.json()
      }

      // No parameters: the default page, and the response says which page that was.
      const first = await get('')
      expect(first.entries).toHaveLength(500)
      expect(first).toMatchObject({ total: 3_000, offset: 0, limit: 500 })

      // Walk the directory at the largest page size: every entry exactly once, no gaps, no repeats.
      const seen: string[] = []
      for (const offset of [0, 1_000, 2_000]) {
        const page = await get(`&limit=1000&offset=${offset}`)
        expect(page).toMatchObject({ total: 3_000, offset, limit: 1_000 })
        expect(page.entries).toHaveLength(1_000)
        seen.push(...page.entries.map((e: { name: string }) => e.name))
      }
      expect(new Set(seen).size).toBe(3_000)

      // A page that straddles the end is short, and one past the end is empty — with the same total.
      const tail = await get('&limit=1000&offset=2500')
      expect(tail.entries).toHaveLength(500)
      expect(tail.total).toBe(3_000)
      const past = await get('&limit=1000&offset=3000')
      expect(past.entries).toEqual([])
      expect(past.total).toBe(3_000)
    })

    it('caps a page at 1,000 entries, refusing a larger limit rather than quietly serving fewer', async () => {
      seedFlatChildren(1_200)
      const atCap = await build().inject({ method: 'GET', url: '/api/explorer?path=/mnt/m&limit=1000', headers: auth() })
      expect(atCap.statusCode).toBe(200)
      expect(atCap.json().entries).toHaveLength(1_000)
      const over = await build().inject({ method: 'GET', url: '/api/explorer?path=/mnt/m&limit=1001', headers: auth() })
      expect(over.statusCode).toBe(400)
    })

    it('paginates by default so a large directory does not ship every row as one response', async () => {
      seedFlatChildren(33_000)
      const res = await build().inject({ method: 'GET', url: '/api/explorer?path=/mnt/m', headers: auth() })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.entries.length).toBeLessThan(33_000)
      expect(body.entries.length).toBeGreaterThan(0)
      expect(body.total).toBe(33_000)
    })

    it('returns a later page via limit/offset', async () => {
      entry('/mnt/m/a.mkv')
      entry('/mnt/m/b.mkv')
      entry('/mnt/m/c.mkv')
      const res = await build().inject({ method: 'GET', url: '/api/explorer?path=/mnt/m&limit=1&offset=1', headers: auth() })
      const body = res.json()
      expect(body.entries).toHaveLength(1)
      expect(body.entries[0].name).toBe('b.mkv')
      expect(body.total).toBe(3)
    })

    it('rejects an invalid limit/offset rather than guessing what the caller meant', async () => {
      expect((await build().inject({ method: 'GET', url: '/api/explorer?path=/mnt/m&limit=0', headers: auth() })).statusCode).toBe(400)
      expect((await build().inject({ method: 'GET', url: '/api/explorer?path=/mnt/m&limit=-1', headers: auth() })).statusCode).toBe(400)
      expect((await build().inject({ method: 'GET', url: '/api/explorer?path=/mnt/m&offset=-1', headers: auth() })).statusCode).toBe(400)
      expect((await build().inject({ method: 'GET', url: '/api/explorer?path=/mnt/m&limit=abc', headers: auth() })).statusCode).toBe(400)
    })
  })

  // Fixwave-2 finding MINOR 6: descendantBounds('/') used to yield ['//', '/0'], which matches only
  // paths beginning with a literal double slash — never a real child of the root ('/a.mkv' sorts
  // above '/0' and so falls outside that range). A container mapped to '/' therefore rolled up to a
  // silent zero regardless of what it actually contained, on the one screen this project treats as
  // ground truth ("degraded means not evaluated, never zero").
  describe('finding MINOR 6 — rollup at a mapping container of "/"', () => {
    it('rolls up real descendant bytes and count instead of silently reporting zero', async () => {
      const rootMappings: PathMapping[] = [{ role: 'library', jellyfin: '/media', container: '/', qbit: null, qbitInstance: null }]
      entry('/a.mkv', { is_media: 1, size_bytes: 123 })
      entry('/sub', { is_dir: 1 })
      entry('/sub/b.mkv', { is_media: 1, size_bytes: 456 })
      const body = (await build(rootMappings).inject({ method: 'GET', url: '/api/explorer', headers: auth() })).json()
      const root = body.entries.find((e: { path: string }) => e.path === '/')
      expect(root.sizeBytes).toBe(579)
      expect(root.fileCount).toBe(2)
    })
  })

  // Finding 1: rollupSize/rollupCount ran an unindexable full table scan (a `LIKE ? || '/%' ESCAPE
  // '\'`, which SQLite's LIKE-to-range optimization refuses to fire on) for EVERY directory row in
  // a listing. At this exact shape — 200 sibling directories, 20,200 total fs_entries rows — the
  // old query measured ~818ms for one listing; the fixed range-scan query measures ~35ms. 200ms is
  // a threshold the fix clears with room to spare and the old query missed by 4x, so this fails
  // loudly against a regression without being flaky on a slower CI box.
  describe('performance regression — finding 1 (rollup must be an index seek, not a table scan)', () => {
    it('lists a directory with 200 sibling subdirectories and 20,000 files well under a second', async () => {
      const insert = db.prepare(`INSERT INTO fs_entries (container_path, scan_id, parent_path, name, ext,
        is_dir, size_bytes, mtime, dev, inode, nlink, is_media, library_root, root_role)
        VALUES (@container_path,1,@parent_path,@name,@ext,@is_dir,@size_bytes,0,1,@inode,1,@is_media,'/mnt/m','library')`)
      const numDirs = 200
      const filesPerDir = 100
      let inode = 0
      const seed = db.transaction(() => {
        for (let d = 0; d < numDirs; d += 1) {
          const dirPath = `/mnt/m/Dir${d}`
          inode += 1
          insert.run({
            container_path: dirPath, parent_path: '/mnt/m', name: `Dir${d}`, ext: null,
            is_dir: 1, size_bytes: 0, inode, is_media: 0,
          })
          for (let f = 0; f < filesPerDir; f += 1) {
            inode += 1
            insert.run({
              container_path: `${dirPath}/file${f}.mkv`, parent_path: dirPath, name: `file${f}.mkv`,
              ext: '.mkv', is_dir: 0, size_bytes: 100, inode, is_media: 1,
            })
          }
        }
      })
      seed()

      const started = performance.now()
      const res = await build().inject({ method: 'GET', url: '/api/explorer?path=/mnt/m', headers: auth() })
      const elapsedMs = performance.now() - started

      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.entries).toHaveLength(numDirs)
      expect(body.entries[0].fileCount).toBe(filesPerDir)
      expect(body.entries[0].sizeBytes).toBe(filesPerDir * 100)
      expect(elapsedMs).toBeLessThan(200)
    })
  })
})
