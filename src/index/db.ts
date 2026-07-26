import Database from 'better-sqlite3'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type Db = Database.Database

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations')

export function currentSchemaVersion(db: Db): number {
  return db.pragma('user_version', { simple: true }) as number
}

export function migrate(db: Db): void {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
  for (const file of files) {
    const version = Number.parseInt(file.slice(0, 3), 10)
    if (Number.isNaN(version)) throw new Error(`migration ${file} must start with a 3-digit version`)
    if (version <= currentSchemaVersion(db)) continue
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
    db.exec('BEGIN')
    try {
      db.exec(sql)
      db.pragma(`user_version = ${version}`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw new Error(`migration ${file} failed: ${(err as Error).message}`)
    }
  }
}

export function openDb(path: string): Db {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('synchronous = NORMAL')
  migrate(db)
  return db
}
