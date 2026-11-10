// Tool-side validation and whitelist mapping. The DSH 0.2.2-rc.1 parameter
// root stays open, so range, format, root whitelist, and cross-field
// constraints are enforced HERE before any database work. Only whitelisted
// fields cross into the session.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MEDIA_TYPES = ['movie', 'tv', 'anime', 'game']
/** What media_log_mark accepts. The schema keeps 5 so imported records with
 *  planned/paused/dropped still read back faithfully (proposal §4 note). */
const MARK_STATUSES = ['in_progress', 'completed']
const NOTES_MAX = 2000
const ROOT_KEYS = ['target', 'status', 'rating', 'progress', 'notes', 'replaceNotes']

/**
 * @param {string} text
 * @returns {boolean} false when the text contains NUL.
 */
export function hasNoNul(text) {
  return !text.includes('\u0000')
}

/**
 * Validates the media_log_mark argument object. Returns the normalized
 * command pieces, or an error message.
 * @param {unknown} args
 * @returns {{ok: true, value: NormalizedMark} | {ok: false, message: string}}
 *
 * @typedef {Object} NormalizedMark
 * @property {'update'|'create'} mode
 * @property {string} [assetId]
 * @property {number} [expectedRevision]
 * @property {string} [title]
 * @property {string} [mediaType]
 * @property {number} [year]
 * @property {string} [status]
 * @property {number} [rating]
 * @property {{current?: number, total?: number, unit?: string}} [progress]
 * @property {string} [notes]
 * @property {boolean} replaceNotes
 */
export function validateMarkArgs(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, message: '参数必须是一个对象。' }
  }
  const a = /** @type {Record<string, unknown>} */ (args)
  for (const key of Object.keys(a)) {
    if (!ROOT_KEYS.includes(key)) {
      return { ok: false, message: `未知参数字段 ${key}。` }
    }
  }

  const target = a.target
  if (target === null || typeof target !== 'object' || Array.isArray(target)) {
    return { ok: false, message: '缺少 target：更新需 {assetId, expectedRevision}，新建需 {title, mediaType}。' }
  }
  const t = /** @type {Record<string, unknown>} */ (target)
  const targetKeys = Object.keys(t)
  const updateKeys = ['assetId', 'expectedRevision']
  const createKeys = ['title', 'mediaType', 'year']
  const hasUpdateKey = targetKeys.some((k) => updateKeys.includes(k))
  const hasCreateKey = targetKeys.some((k) => createKeys.includes(k))
  if (hasUpdateKey && hasCreateKey) {
    return { ok: false, message: 'target 不能同时携带更新字段（assetId/expectedRevision）与新建字段（title/mediaType）。' }
  }
  for (const key of targetKeys) {
    if (!updateKeys.includes(key) && !createKeys.includes(key)) {
      return { ok: false, message: `target 含未知字段 ${key}。` }
    }
  }

  /** @type {Partial<NormalizedMark>} */
  const value = { replaceNotes: a.replaceNotes === true }
  if (a.replaceNotes !== undefined && typeof a.replaceNotes !== 'boolean') {
    return { ok: false, message: 'replaceNotes 必须是布尔值。' }
  }

  const status = a.status
  if (status !== undefined) {
    if (typeof status !== 'string' || !MARK_STATUSES.includes(status)) {
      return { ok: false, message: 'status 只接受 in_progress 或 completed。' }
    }
    value.status = status
  }

  const rating = a.rating
  if (rating !== undefined) {
    if (typeof rating !== 'number' || !Number.isFinite(rating) || rating < 0 || rating > 10) {
      return { ok: false, message: 'rating 必须是 0 到 10 的有限数值（5 星制乘以 2）。' }
    }
    value.rating = rating
  }

  const progress = a.progress
  if (progress !== undefined) {
    if (progress === null || typeof progress !== 'object' || Array.isArray(progress)) {
      return { ok: false, message: 'progress 必须是对象。' }
    }
    const p = /** @type {Record<string, unknown>} */ (progress)
    const allowed = ['current', 'total', 'unit']
    for (const key of Object.keys(p)) {
      if (!allowed.includes(key)) return { ok: false, message: `progress 含未知字段 ${key}。` }
    }
    if (Object.keys(p).length === 0) {
      return { ok: false, message: 'progress 不能是空对象。' }
    }
    /** @type {{current?: number, total?: number, unit?: string}} */
    const patch = {}
    if (p.current !== undefined) {
      if (typeof p.current !== 'number' || !Number.isFinite(p.current) || p.current < 0) {
        return { ok: false, message: 'progress.current 必须是 ≥ 0 的有限数值。' }
      }
      patch.current = p.current
    }
    if (p.total !== undefined) {
      if (typeof p.total !== 'number' || !Number.isFinite(p.total) || p.total <= 0) {
        return { ok: false, message: 'progress.total 必须是 > 0 的有限数值。' }
      }
      patch.total = p.total
    }
    if (p.unit !== undefined) {
      if (typeof p.unit !== 'string' || p.unit.length < 1 || p.unit.length > 32) {
        return { ok: false, message: 'progress.unit 必须是 1 到 32 个字符。' }
      }
      patch.unit = p.unit
    }
    value.progress = patch
  }

  const notes = a.notes
  if (notes !== undefined) {
    if (typeof notes !== 'string') return { ok: false, message: 'notes 必须是字符串。' }
    const trimmed = notes.trim()
    if (trimmed.length < 1 || trimmed.length > NOTES_MAX) {
      return { ok: false, message: `notes 需要 1 到 ${NOTES_MAX} 个字符。` }
    }
    if (!hasNoNul(trimmed)) return { ok: false, message: 'notes 不能包含 NUL 字符。' }
    value.notes = trimmed
  }

  if (hasUpdateKey) {
    if (typeof t.assetId !== 'string' || !UUID_RE.test(t.assetId)) {
      return { ok: false, message: 'target.assetId 必须是完整 UUID。' }
    }
    if (
      typeof t.expectedRevision !== 'number' ||
      !Number.isInteger(t.expectedRevision) ||
      t.expectedRevision < 1
    ) {
      return { ok: false, message: 'target.expectedRevision 必须是 ≥ 1 的整数。' }
    }
    value.mode = 'update'
    value.assetId = t.assetId
    value.expectedRevision = t.expectedRevision
    if (
      value.status === undefined &&
      value.rating === undefined &&
      value.progress === undefined &&
      value.notes === undefined
    ) {
      return { ok: false, message: '更新至少要提供 status、rating、progress、notes 之一。' }
    }
  } else {
    if (typeof t.title !== 'string' || t.title.trim().length < 1 || t.title.trim().length > 300) {
      return { ok: false, message: 'target.title 需要 1 到 300 个字符。' }
    }
    if (typeof t.mediaType !== 'string' || !MEDIA_TYPES.includes(t.mediaType)) {
      return { ok: false, message: 'target.mediaType 只接受 movie、tv、anime、game。' }
    }
    if (t.year !== undefined) {
      if (
        typeof t.year !== 'number' ||
        !Number.isInteger(t.year) ||
        t.year < 1850 ||
        t.year > 2100
      ) {
        return { ok: false, message: 'target.year 必须是 1850 到 2100 的整数。' }
      }
      value.year = t.year
    }
    value.mode = 'create'
    value.title = t.title.trim()
    value.mediaType = t.mediaType
    // 新建要求 status。
    if (value.status === undefined) {
      return { ok: false, message: '新建需要 status（in_progress 或 completed）。' }
    }
    if (value.replaceNotes === true) {
      return { ok: false, message: 'replaceNotes 只用于更新已有条目。' }
    }
  }
  return { ok: true, value: /** @type {NormalizedMark} */ (value) }
}

/**
 * Validates the media_log_search arguments.
 * @param {unknown} args
 * @returns {{ok: true, value: {query: string, limit: number, offset: number}} | {ok: false, message: string}}
 */
export function validateSearchArgs(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, message: '参数必须是一个对象。' }
  }
  const a = /** @type {Record<string, unknown>} */ (args)
  for (const key of Object.keys(a)) {
    if (!['query', 'limit', 'offset'].includes(key)) {
      return { ok: false, message: `未知参数字段 ${key}。` }
    }
  }
  if (typeof a.query !== 'string' || a.query.trim().length < 1 || a.query.trim().length > 300) {
    return { ok: false, message: 'query 需要 1 到 300 个字符。' }
  }
  let limit = 10
  if (a.limit !== undefined) {
    if (typeof a.limit !== 'number' || !Number.isInteger(a.limit) || a.limit < 1 || a.limit > 20) {
      return { ok: false, message: 'limit 必须是 1 到 20 的整数。' }
    }
    limit = a.limit
  }
  let offset = 0
  if (a.offset !== undefined) {
    if (typeof a.offset !== 'number' || !Number.isInteger(a.offset) || a.offset < 0 || a.offset > 1000) {
      return { ok: false, message: 'offset 必须是 0 到 1000 的整数。' }
    }
    offset = a.offset
  }
  return { ok: true, value: { query: a.query.trim(), limit, offset } }
}

/**
 * Validates the media_log_get arguments.
 * @param {unknown} args
 * @returns {{ok: true, value: {assetId: string, includeNotes: boolean}} | {ok: false, message: string}}
 */
export function validateGetArgs(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, message: '参数必须是一个对象。' }
  }
  const a = /** @type {Record<string, unknown>} */ (args)
  for (const key of Object.keys(a)) {
    if (!['assetId', 'includeNotes'].includes(key)) {
      return { ok: false, message: `未知参数字段 ${key}。` }
    }
  }
  if (typeof a.assetId !== 'string' || !UUID_RE.test(a.assetId)) {
    return { ok: false, message: 'assetId 必须是完整 UUID。' }
  }
  if (a.includeNotes !== undefined && typeof a.includeNotes !== 'boolean') {
    return { ok: false, message: 'includeNotes 必须是布尔值。' }
  }
  return { ok: true, value: { assetId: a.assetId, includeNotes: a.includeNotes === true } }
}

/**
 * Whitelist-maps one stored row into the candidate summary. Only these fields
 * cross into the session.
 * @param {Record<string, unknown>} row
 */
export function mapCandidate(row) {
  return {
    assetId: typeof row.id === 'string' ? row.id : '',
    title: typeof row.title === 'string' ? row.title : '',
    mediaType: typeof row.media_type === 'string' ? row.media_type : '',
    year: typeof row.year === 'number' ? row.year : null,
    status: typeof row.status === 'string' ? row.status : null,
    lifecycle: typeof row.lifecycle === 'string' ? row.lifecycle : '',
  }
}

/**
 * Whitelist-maps the detail of one record, truncating notes when included.
 * @param {Record<string, unknown>} row
 * @param {boolean} includeNotes
 */
export function mapDetail(row, includeNotes) {
  /** @type {Record<string, unknown>} */
  const out = {
    assetId: row.id ?? null,
    revision: row.revision ?? null,
    title: row.title ?? null,
    mediaType: row.media_type ?? null,
    year: row.year ?? null,
    lifecycle: row.lifecycle ?? null,
    status: row.status ?? null,
    rating: row.rating ?? null,
    progress:
      row.progress_current === null && row.progress_total === null && row.progress_unit === null
        ? null
        : {
            current: row.progress_current ?? null,
            total: row.progress_total ?? null,
            unit: row.progress_unit ?? null,
          },
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at ?? null,
    hasNotes: typeof row.notes === 'string' && row.notes.length > 0,
  }
  if (includeNotes) {
    const notes = typeof row.notes === 'string' ? row.notes : null
    if (notes !== null && notes.length > NOTES_MAX) {
      out.notes = notes.slice(0, NOTES_MAX)
      out.notesTruncated = true
    } else {
      out.notes = notes
    }
  }
  return out
}

/**
 * @typedef {Object} Candidate
 * @property {string} id
 * @property {string} title
 * @property {string} mediaType
 * @property {number|null} year
 * @property {string|null} status
 * @property {string} lifecycle
 */

/**
 * @typedef {Object} CandidateVerdict
 * @property {'none'|'unique'|'ambiguous'} kind
 * @property {Candidate} [candidate] the single active match, when unique
 * @property {Candidate[]} candidates the matches to offer the user (always
 *         present for unique/ambiguous; the full page for none)
 */

/**
 * Determines the disambiguation outcome for a candidate list: exactly one
 * ACTIVE candidate with a clear title match is selectable; archived-only
 * matches need reconfirmation; multiple candidates list out. `candidates` is
 * always populated for a non-none verdict so the tool can hand the model the
 * ids it needs to act on.
 * @param {Candidate[]} items
 * @param {string} title
 * @returns {CandidateVerdict}
 */
export function classifyCandidates(items, title) {
  const needle = title.trim().toLowerCase()
  const matches = items.filter((item) => item.title.trim().toLowerCase() === needle)
  const active = matches.filter((item) => item.lifecycle === 'active')
  if (matches.length === 0) return { kind: 'none', candidates: items }
  if (active.length === 1) return { kind: 'unique', candidate: active[0], candidates: active }
  return { kind: 'ambiguous', candidates: matches }
}
