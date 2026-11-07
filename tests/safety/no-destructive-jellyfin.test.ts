import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Jellyfin must never delete files (Review Focus 3). `DELETE /Items/{id}` removes an item's whole
 * containing folder from disk while its files still exist — every sibling version, every sidecar —
 * and `POST /Library/Refresh` rescans every library on the server. Jellymaid deletes through the
 * owning qBittorrent instance (or an identity-checked unlink) and then tells Jellyfin only which
 * paths are gone, through `POST /Library/Media/Updated`.
 *
 * A tripwire over the source text, not a type check: the endpoint is a string, and nothing in the
 * type system stops one from coming back. Deliberately strict — a comment counts too, so describe
 * these endpoints in prose ("the item-delete endpoint") rather than spelling the route out.
 */

const SRC = fileURLToPath(new URL('../../src', import.meta.url))

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? filesUnder(path) : [path]
  })
}

/** How far either side of an `/Items/` path a DELETE method literal is taken to belong to the same call. */
const WINDOW = 300

/**
 * Every destructive Jellyfin call in `text`, as `line: snippet`. Case-insensitive throughout, because
 * Jellyfin's routes are: `DELETE /items/{id}` deletes exactly as `DELETE /Items/{id}` does.
 */
function destructiveJellyfinCalls(text: string): string[] {
  const hits: string[] = []
  const lineOf = (index: number) => text.slice(0, index).split('\n').length
  for (const m of text.matchAll(/library\/refresh/gi)) {
    hits.push(`${lineOf(m.index!)}: ${m[0]}`)
  }
  for (const m of text.matchAll(/\/items\//gi)) {
    const around = text.slice(Math.max(0, m.index! - WINDOW), m.index! + WINDOW)
    // The method as a string literal ('DELETE', "delete", `DELETE`), or the route written out the
    // way docs and comments spell it ("DELETE /Items/{id}").
    if (/['"`]delete['"`]|\bdelete\s+\/items\//i.test(around)) hits.push(`${lineOf(m.index!)}: DELETE ${m[0]}`)
  }
  return hits
}

describe('safety', () => {
  it('no destructive Jellyfin endpoints in src', () => {
    const files = filesUnder(SRC)
    // A walk that found nothing would pass vacuously.
    expect(files.length).toBeGreaterThan(20)
    expect(files.map((f) => relative(SRC, f))).toContain(join('connectors', 'jellyfin.ts'))

    const offenders = files.flatMap((file) =>
      destructiveJellyfinCalls(readFileSync(file, 'utf8')).map((hit) => `${relative(SRC, file)}:${hit}`))
    expect(offenders).toEqual([])
  })

  it('the detector catches every spelling of the two endpoints, and leaves the safe calls alone', () => {
    const caught = [
      "await http.request(`/Items/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'none')",
      'await fetch(base + "/items/" + id, {\n  headers,\n  method: "delete",\n})',
      "await http.request('/Library/Refresh', { method: 'POST' }, 'none')",
      "const path = '/library/refresh'",
      '// calls DELETE /Items/{id} on the merged item',
    ]
    for (const text of caught) expect(destructiveJellyfinCalls(text), text).not.toEqual([])

    const allowed = [
      "await http.request(`/Videos/${encodeURIComponent(id)}/AlternateSources`, { method: 'DELETE' }, 'none')",
      "await http.request(`/Items?${qs.toString()}`)",
      "await http.request('/Library/Media/Updated', { method: 'POST', body: JSON.stringify({ Updates }) }, 'none')",
      "await http.request(`/Items/${id}/Images`)",
    ]
    for (const text of allowed) expect(destructiveJellyfinCalls(text), text).toEqual([])
  })
})
