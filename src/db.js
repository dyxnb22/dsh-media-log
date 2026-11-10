// Library storage (the plugin's own SQLite file). One DatabaseSync connection
// opened lazily on first use: reads and writes are synchronous, so within this
// Host process writes are naturally serialized — no queue, no subprocess, no
// machine contract. SQLite's own transaction IS the receipt: a committed row
// is a fact, and a rolled-back one never happened, so there is no
// "outcome unknown" state to report to the user.
//
// node:sqlite is a Node builtin, but importing it at module load prints an
// ExperimentalWarning on the Host's startup path. Following
// @deepseek-ai/dsh-session-query-sqlite, the import happens inside the async
// open() instead — a plugin that never touches the library stays silent.

import { mkdirSync, openSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** Bump when the schema changes incompatibly; checked before we touch a file. */
const USER_VERSION = 1

const SCHEMA = `
CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'tv', 'anime', 'game')),
  year INTEGER CHECK (year IS NULL OR year BETWEEN 1850 AND 2100),
  status TEXT NOT NULL CHECK (status IN ('planned', 'in_progress', 'completed', 'paused', 'dropped')),
  rating REAL CHECK (rating IS NULL OR (rating >= 0 AND rating <= 10)),
  progress_current REAL CHECK (progress_current IS NULL OR progress_current >= 0),
  progress_total REAL CHECK (progress_total IS NULL OR progress_total > 0),
  progress_unit TEXT,
  notes TEXT,
  lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'archived')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  started_at TEXT,
  completed_at TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- a unit label without any numeric value is meaningless
  CHECK (progress_unit IS NULL OR progress_current IS NOT NULL OR progress_total IS NOT NULL),
  CHECK (progress_current IS NULL OR progress_total IS NULL OR progress_current <= progress_total)
);
CREATE INDEX IF NOT EXISTS media_title_idx ON media(title);
`

/**
 * The conventional library location: ~/.dsh/media-log/media.db. The Host
 * provides `dshHomePath` on every plugin context (dsh-app-boot), so no
 * dependency is needed — but a bare path keeps this module testable.
 * @param {string} [configured] databasePath from the plugin config ('' = default)
 * @returns {string} absolute path to the library file
 */
export function resolveDatabasePath(configured = '') {
  if (configured !== '') return configured
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'media-log', 'media.db')
}

/**
 * Opens (creating if needed) the library and applies the schema.
 * The file and its directory are created owner-only: this is the user's
 * private record of what they watch.
 * @param {string} databasePath absolute path, '' for the conventional one
 * @returns {Promise<import('node:sqlite').DatabaseSync>}
 */
export async function openLibrary(databasePath = '') {
  const path = resolveDatabasePath(databasePath)
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  let existed = true
  try {
    statSync(path)
  } catch {
    existed = false
  }
  if (!existed) {
    // "wx" = create exclusively, so a racing second Host cannot clobber a
    // library another process just made.
    const fd = openSync(path, 'wx', 0o600)
    // Close immediately; DatabaseSync opens its own handle.
    const { closeSync } = await import('node:fs')
    closeSync(fd)
  }

  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path)
  const version = db.prepare('PRAGMA user_version').get().user_version
  if (version > USER_VERSION) {
    throw new Error(
      `资料库版本 ${version} 比本插件认识的版本 ${USER_VERSION} 更新。请升级插件后再打开这个库。`,
    )
  }
  db.exec(SCHEMA)
  if (version < USER_VERSION) db.exec(`PRAGMA user_version = ${USER_VERSION}`)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 2000')
  db.exec('PRAGMA foreign_keys = ON')
  return db
}

/**
 * Runs `fn` inside one transaction. Reads and writes are synchronous, so this
 * is only about atomicity across several statements — notably the
 * read-compare-write of a mark, where a concurrent writer must not slip in.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {() => unknown} fn
 */
export function inTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const value = fn()
    db.exec('COMMIT')
    return value
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
