// Tool canonical results are {ok:true, data} or {ok:false, error:{code,
// message, ...}}: a failed domain outcome is a VALUE, not a throw — only
// plugin bugs throw (the registry turns throws into isError).
//
// With the library in-process there is no machine envelope to parse, no exit
// code to interpret and no subprocess that can die mid-write, so the whole
// CLI-failure vocabulary (CLI_NOT_FOUND, CLI_INCOMPATIBLE, PROTOCOL_ERROR,
// CLI_FAILURE, TIMEOUT, QUEUE_BUSY, WRITE_OUTCOME_UNKNOWN) is gone. SQLite
// contention and file errors still use DB_BUSY and LIBRARY_UNAVAILABLE.
// CHECK constraints and the revision guard enforce domain rejections.

/** Success envelope. @param {unknown} data */
export function ok(data) {
  return { ok: true, data }
}

/**
 * Runs one storage operation, mapping a domain rejection onto a tool value.
 * Shared by every module's tools, so a constraint violation reads the same
 * way whichever tool tripped it.
 * @template T
 * @param {() => T} fn
 * @returns {T | ReturnType<typeof fail>}
 */
export function attemptSqlite(fn) {
  try {
    return fn()
  } catch (error) {
    return sqliteErrorToValue(error)
  }
}

/** @returns {boolean} true when a value is a tool failure envelope */
export function isFail(value) {
  return typeof value === 'object' && value !== null && /** @type {any} */ (value).ok === false
}

/**
 * Failure envelope.
 * @param {string} code stable tool code
 * @param {string} message agent-readable, phone-renderable text
 * @param {{assetId?: string, candidates?: unknown[], currentRevision?: number, hint?: string}} [extra]
 *  `hint` is the next step the caller should take. It exists because the right
 *  next step differs per path: after a by-id conflict you must re-read the
 *  revision, after a by-title conflict you can simply retry with the right
 *  title.
 */
export function fail(code, message, extra = {}) {
  const error = { code, message }
  if (extra.assetId !== undefined) error.assetId = extra.assetId
  if (extra.candidates !== undefined) error.candidates = extra.candidates
  if (extra.currentRevision !== undefined) error.currentRevision = extra.currentRevision
  if (extra.hint !== undefined) error.hint = extra.hint
  return { ok: false, error }
}

/**
 * SQLite extended result codes in the constraint family. node:sqlite reports
 * `code: 'ERR_SQLITE_ERROR'` and puts the real result code in `errcode`, so
 * matching on `code` alone never fires.
 */const SQLITE_CONSTRAINT = 19
const SQLITE_CONSTRAINT_UNIQUE = 2067
const SQLITE_CONSTRAINT_NOTNULL = 1299
const SQLITE_CONSTRAINT_CHECK = 275
const CONSTRAINT_CODES = new Set([
  SQLITE_CONSTRAINT,
  SQLITE_CONSTRAINT_UNIQUE,
  SQLITE_CONSTRAINT_NOTNULL,
  SQLITE_CONSTRAINT_CHECK,
])
const SQLITE_BUSY = 5
const SQLITE_LOCKED = 6
const SQLITE_CORRUPT = 11
const SQLITE_NOTADB = 26
const SQLITE_CANTOPEN = 14
const SQLITE_READONLY = 8

/**
 * Turns a SQLite error into a tool value. A constraint violation is the
 * domain rejecting the patch, which the caller experiences as a bad argument;
 * anything unrecognized rethrows, because only plugin bugs should throw.
 * @param {unknown} error
 * @returns {ReturnType<typeof fail>}
 */
export function sqliteErrorToValue(error) {
  const errcode = /** @type {{errcode?: number, code?: string}} */ (error)?.errcode
  const code = /** @type {{code?: string}} */ (error)?.code

  if (typeof errcode === 'number' && CONSTRAINT_CODES.has(errcode)) {
    // The constraint text is the useful part: SQLite puts the failing CHECK
    // expression (or the named column constraint) right after the colon.
    const detail = String(/** @type {{message?: string}} */ (error)?.message ?? '').split('constraint failed: ')[1]
    return fail('INVALID_ARGUMENT', `资料库拒绝了这个值${detail ? `（${detail}）` : ''}。请检查字段范围后重试。`)
  }
  if (errcode === SQLITE_BUSY || errcode === SQLITE_LOCKED || code === 'ERR_SQLITE_BUSY') {
    return fail('DB_BUSY', '资料库正被其他进程占用，本次没有保存。稍后可以再试。')
  }
  if (errcode === SQLITE_CORRUPT || errcode === SQLITE_NOTADB) {
    return fail('LIBRARY_UNAVAILABLE', '资料库文件损坏或不是有效数据库。请从备份恢复。')
  }
  if (errcode === SQLITE_CANTOPEN || errcode === SQLITE_READONLY) {
    return fail('LIBRARY_UNAVAILABLE', '资料库打不开。请检查 databasePath 指向的文件与权限。')
  }
  throw error
}
