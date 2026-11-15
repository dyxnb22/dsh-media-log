// Library storage (the plugin's own SQLite file). One DatabaseSync connection
// opened lazily on first use: reads and writes are synchronous, so within this
// Host process writes are naturally serialized — no queue, no subprocess, no
// machine contract. The tool returns its receipt after COMMIT succeeds. A Host
// crash after COMMIT but before delivery can still leave the caller without a
// receipt; inspect the record before retrying after such a crash.
//
// node:sqlite is a Node builtin, but importing it at module load prints an
// ExperimentalWarning on the Host's startup path. Following
// @deepseek-ai/dsh-session-query-sqlite, the import happens inside the async
// open() instead — a plugin that never touches the library stays silent.

import { mkdirSync, openSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

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

-- P2. A brand-new table, so CREATE TABLE IF NOT EXISTS IS the whole migration:
-- an existing v1 library gains it on its next open, and the user_version bump
-- below then records that it happened. Adding a COLUMN to media would need
-- real incremental SQL instead, because IF NOT EXISTS silently no-ops on a
-- table that already exists.
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  provider TEXT CHECK (provider IS NULL OR length(trim(provider)) > 0),
  -- integer minor units (分 / cents); NULL means "unknown", which is NOT the
  -- same as 0 — a free tier is a real price, an unrecorded one is not.
  amount_minor INTEGER CHECK (amount_minor IS NULL OR amount_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'CNY' CHECK (currency IN ('CNY', 'USD')),
  cycle TEXT NOT NULL CHECK (cycle IN ('monthly', 'yearly', 'usage')),
  next_renew_at TEXT,
  expires_at TEXT,
  auto_renew INTEGER NOT NULL DEFAULT 1 CHECK (auto_renew IN (0, 1)),
  notes TEXT,
  lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'archived')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS subscriptions_name_idx ON subscriptions(name);

-- P3. A software inventory whose point is the user's own "why did I install
-- this" — not a discovery system. Nothing here scans, installs or uninstalls
-- anything; every row is one the user typed.
CREATE TABLE IF NOT EXISTS software (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  category TEXT CHECK (category IS NULL OR length(trim(category)) > 0),
  purpose TEXT,
  source_url TEXT,
  version TEXT,
  platform TEXT,
  notes TEXT,
  -- in_use | retired. Retiring keeps the purpose and the notes; it is not a
  -- claim about what is installed on any machine.
  status TEXT NOT NULL DEFAULT 'in_use' CHECK (status IN ('in_use', 'retired')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS software_name_idx ON software(name);

-- A small journal of what the tools actually wrote, so "我上次改了什么" has an
-- answer even when the DSH session is gone. Derived data, deliberately NOT an
-- event log: it starts when this table landed (nothing before is backfilled),
-- it is capped at the most recent CHANGE_CAP rows, and there is no replay,
-- undo, or per-field history beyond the one-line summary.
CREATE TABLE IF NOT EXISTS changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  module TEXT NOT NULL CHECK (module IN ('media', 'subscription', 'software')),
  asset_id TEXT NOT NULL,
  name TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'update')),
  summary TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS changes_at_idx ON changes(at);
`

/** Bump when the schema changes incompatibly; checked before we touch a file. */
const USER_VERSION = 7

/** How many journal rows survive. Oldest fall off as new ones land. */
export const CHANGE_CAP = 500

/**
 * The two journal statements every writing module shares. The SQL is
 * identical across modules, so — unlike the module-specific statement sets —
 * these are defined once here and spread into each module's statement object.
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function journalStatements(db) {
  return {
    journal: db.prepare(
      `INSERT INTO changes (at, module, asset_id, name, action, summary)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    journalTrim: db.prepare(
      `DELETE FROM changes WHERE id <= (SELECT max(id) FROM changes) - ${CHANGE_CAP}`,
    ),
  }
}

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

/** ISO-8601 with offset, so imported and new timestamps sort alike. */
export function nowIso() {
  return new Date().toISOString()
}

/** Escapes LIKE wildcards so a query containing % or _ matches literally. */
export function likePattern(text) {
  return `%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`
}

/**
 * Opens the library once per Host and reuses the connection. The config is
 * re-resolved per call, so a settings write takes effect live — but a changed
 * databasePath must reopen, which is why the path is the cache key. Shared by
 * every module, so all of them talk to one library through one holder.
 * @param {string} [databasePath] '' for the conventional location
 * @returns {Promise<import('node:sqlite').DatabaseSync>}
 */
export function createLibraryHolder() {
  /** @type {{path: string, db: import('node:sqlite').DatabaseSync} | null} */
  let current = null
  /** @type {Promise<import('node:sqlite').DatabaseSync> | null} */
  let opening = null
  return async function getLibrary(databasePath = '') {
    const path = resolveDatabasePath(databasePath)
    if (current !== null && current.path === path && current.db.isOpen) return current.db
    if (opening !== null) {
      await opening
      // The pending open may belong to another path. Recheck the cache before
      // deciding which connection this call should use.
      return getLibrary(databasePath)
    }
    opening = openLibrary(databasePath).then((db) => {
      current = { path, db }
      return db
    })
    try {
      return await opening
    } finally {
      opening = null
    }
  }
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
  // The retained tables need no column changes. Mark the version only after
  // all missing tables have been created successfully.
  if (version < USER_VERSION) {
    db.exec(`PRAGMA user_version = ${USER_VERSION}`)
  }
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
    // FULL/IOERR can make SQLite roll back automatically. Cleanup must not
    // replace the original failure with "no transaction is active".
    if (db.isTransaction) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // If rollback itself fails, do not leave this connection usable with
        // an uncertain transaction state. Preserve the triggering error.
        try { db.close() } catch {}
      }
    }
    throw error
  }
}

/**
 * A per-module statement cache. Prepared statements are built once per open
 * library and keyed to the handle by a WeakMap, so a reopened library gets a
 * fresh set and a closed one is collected.
 *
 * The cache is created PER MODULE rather than shared: several modules open the
 * same library through the same holder, and a cache keyed only on the db handle
 * would hand one module the other's statements. Each module calls this once at
 * load and uses the getter it gets back.
 * @returns {(db: import('node:sqlite').DatabaseSync, build: (db: import('node:sqlite').DatabaseSync) => T) => T}
 * @template T
 */
export function statementCache() {
  /** @type {WeakMap<object, unknown>} */
  const cache = new WeakMap()
  /**
   * @param {import('node:sqlite').DatabaseSync} db
   * @param {(db: import('node:sqlite').DatabaseSync) => T} build
   * @returns {T}
   */
  return function statements(db, build) {
    let st = cache.get(db)
    if (st === undefined) {
      st = build(db)
      cache.set(db, st)
    }
    return /** @type {T} */ (st)
  }
}
