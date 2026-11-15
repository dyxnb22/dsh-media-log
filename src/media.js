// Tool-side validation and whitelist mapping. The DSH 0.2.2-rc.1 parameter
// root stays open, so range, format, root whitelist, and cross-field
// constraints are enforced HERE before any database work. Only whitelisted
// fields cross into the session.

import { dateBound } from './dates.js'
import {
  UUID_RE,
  NOTES_MAX,
  usableText,
  hasNoNul,
  pageBounds,
  clearFields,
  notesField,
} from './toolkit.js'

const MEDIA_TYPES = ['movie', 'tv', 'anime', 'game']
/** All five stored statuses, accepted by both mark and list. */
const MEDIA_STATUSES = ['planned', 'in_progress', 'completed', 'paused', 'dropped']
/** media_log_list lifecycle filter. The default hides archived rows; 'all' is
 *  the only way to see an archived and an active record in one page. */
const LIFECYCLE_FILTERS = ['active', 'archived', 'all']
const LIST_KEYS = [
  'mediaType',
  'status',
  'lifecycle',
  'completedFrom',
  'completedBefore',
  'limit',
  'offset',
]
/** Omitted on create, status defaults to planned — "记一下《沙丘2》"
 *  means "想看", and the model should not have to invent a state. */
const DEFAULT_STATUS = 'planned'
const ROOT_KEYS = [
  'target',
  'status',
  'rating',
  'progress',
  'notes',
  'replaceNotes',
  'metadata',
  'clear',
  'lifecycle',
]
/** Correctable identity fields. Update only — create keeps taking them in target. */
const METADATA_KEYS = ['title', 'mediaType', 'year']
/** Emptyable fields. title and mediaType are NOT NULL, so they are absent here
 *  by construction rather than by a runtime check. */
const CLEARABLE = ['rating', 'year', 'notes', 'progress']
/** media_log_mark lifecycle values. Deliberately narrower than the list's
 *  LIFECYCLE_FILTERS: 'all' is a query window, not a state a record can hold. */
const MARK_LIFECYCLES = ['active', 'archived']
/** Every key target accepts, across all three modes. */
const TARGET_KEYS = ['assetId', 'expectedRevision', 'title', 'mediaType', 'year']
/** @returns {boolean} */
function usableYear(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1850 && value <= 2100
}

/**
 * Validates the media_log_mark argument object. Returns the normalized
 * command pieces, or an error message.
 * @param {unknown} args
 * @returns {{ok: true, value: NormalizedMark} | {ok: false, message: string}}
 *
 * @typedef {Object} NormalizedMark
 * @property {'update'|'updateByTitle'|'create'} mode
 * @property {string} [assetId]
 * @property {number} [expectedRevision]
 * @property {string} [title] the title to act on (create and updateByTitle)
 * @property {string} [mediaType] create only: its presence is what marks a create
 * @property {number} [year] create only
 * @property {string} [status]
 * @property {number} [rating]
 * @property {{current?: number, total?: number, unit?: string}} [progress]
 * @property {string} [notes]
 * @property {boolean} replaceNotes
 * @property {{title?: string, mediaType?: string, year?: number}} [metadata] update only
 * @property {Array<'rating'|'year'|'notes'|'progress'>} [clear] update only
 * @property {'active'|'archived'} [lifecycle] update only
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
    return {
      ok: false,
      message:
        '缺少 target：更新需 {assetId, expectedRevision}，按标题更新需 {title}，新建需 {title, mediaType}。',
    }
  }
  const t = /** @type {Record<string, unknown>} */ (target)
  for (const key of Object.keys(t)) {
    if (!TARGET_KEYS.includes(key)) {
      return { ok: false, message: `target 含未知字段 ${key}。` }
    }
  }
  const hasAssetId = t.assetId !== undefined
  const hasTitle = t.title !== undefined
  const hasMediaType = t.mediaType !== undefined
  if (hasAssetId && (hasTitle || hasMediaType)) {
    return {
      ok: false,
      message: 'target 不能同时带 assetId 和 title/mediaType：要么按 UUID 改，要么按标题改，要么新建。',
    }
  }
  if (hasTitle && t.expectedRevision !== undefined) {
    return {
      ok: false,
      message: '按标题更新不需要 expectedRevision——工具自己读当前 revision，读和写在同一个事务里。',
    }
  }

  /** @type {Partial<NormalizedMark>} */
  const value = { replaceNotes: a.replaceNotes === true }
  if (a.replaceNotes !== undefined && typeof a.replaceNotes !== 'boolean') {
    return { ok: false, message: 'replaceNotes 必须是布尔值。' }
  }

  const status = a.status
  if (status !== undefined) {
    if (typeof status !== 'string' || !MEDIA_STATUSES.includes(status)) {
      return { ok: false, message: 'status 只接受 planned、in_progress、completed、paused、dropped。' }
    }
    value.status = status
  }

  const lifecycle = a.lifecycle
  if (lifecycle !== undefined) {
    if (typeof lifecycle !== 'string' || !MARK_LIFECYCLES.includes(lifecycle)) {
      return { ok: false, message: 'lifecycle 只接受 active、archived。' }
    }
    value.lifecycle = /** @type {'active'|'archived'} */ (lifecycle)
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


  // metadata and clear only make sense against an existing row: a create has
  // nothing to correct and nothing to empty. Both update paths accept them, so
  // they are parsed before the mode is decided.
  const metadata = a.metadata
  if (metadata !== undefined) {
    if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return { ok: false, message: 'metadata 必须是对象。' }
    }
    const m = /** @type {Record<string, unknown>} */ (metadata)
    for (const key of Object.keys(m)) {
      if (!METADATA_KEYS.includes(key)) {
        return { ok: false, message: `metadata 含未知字段 ${key}。` }
      }
    }
    if (Object.keys(m).length === 0) {
      return { ok: false, message: 'metadata 不能是空对象。' }
    }
    if (m.title !== undefined) {
      if (typeof m.title !== 'string' || m.title.trim().length < 1 || m.title.trim().length > 300) {
        return { ok: false, message: 'metadata.title 需要 1 到 300 个字符。' }
      }
      value.metadata = { ...value.metadata, title: m.title.trim() }
    }
    if (m.mediaType !== undefined) {
      if (typeof m.mediaType !== 'string' || !MEDIA_TYPES.includes(m.mediaType)) {
        return { ok: false, message: 'metadata.mediaType 只接受 movie、tv、anime、game。' }
      }
      value.metadata = { ...value.metadata, mediaType: m.mediaType }
    }
    if (m.year !== undefined) {
      if (
        typeof m.year !== 'number' ||
        !Number.isInteger(m.year) ||
        m.year < 1850 ||
        m.year > 2100
      ) {
        return { ok: false, message: 'metadata.year 必须是 1850 到 2100 的整数。' }
      }
      value.metadata = { ...value.metadata, year: m.year }
    }
  }

  const clear = a.clear
  if (clear !== undefined) {
    const cleared = clearFields(a.clear, CLEARABLE, '；标题和类型是必填项，不能清空')
    if (!cleared.ok) return cleared
    const fields = /** @type {Array<'rating'|'year'|'notes'|'progress'>} */ (cleared.fields)
    value.clear = fields
    // Setting and emptying the same field in one call is a contradiction, and
    // a partial progress patch plus "empty the progress" is worse: it would
    // leave the schema's unit-without-a-value CHECK to reject the write.
    for (const [field, given] of [
      ['rating', value.rating],
      ['year', value.metadata?.year],
      ['progress', value.progress],
    ]) {
      if (fields.includes(/** @type {any} */ (field)) && given !== undefined) {
        return { ok: false, message: `clear 里有 ${field} 时不能再传 ${field} 的新值。` }
      }
    }
    if (fields.includes('notes') && value.notes !== undefined) {
      return { ok: false, message: 'clear 里有 notes 时不能再传新的 notes。' }
    }
  }

  /** True when the call carries anything that can only patch an existing row. */
  const hasPatch =
    value.status !== undefined ||
    value.rating !== undefined ||
    value.progress !== undefined ||
    value.notes !== undefined ||
    value.metadata !== undefined ||
    value.clear !== undefined ||
    value.lifecycle !== undefined

  if (hasAssetId) {
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
    if (!hasPatch) {
      return {
        ok: false,
        message: '更新至少要提供 status、rating、progress、notes、metadata、clear、lifecycle 之一。',
      }
    }
    return { ok: true, value: /** @type {NormalizedMark} */ (value) }

  } else if (hasTitle && hasMediaType) {
    const title = usableText(t.title, 300)
    if (title === null) {
      return { ok: false, message: 'target.title 需要 1 到 300 个字符。' }
    }
    if (typeof t.mediaType !== 'string' || !MEDIA_TYPES.includes(t.mediaType)) {
      return { ok: false, message: 'target.mediaType 只接受 movie、tv、anime、game。' }
    }
    if (t.year !== undefined && !usableYear(t.year)) {
      return { ok: false, message: 'target.year 必须是 1850 到 2100 的整数。' }
    }
    value.mode = 'create'
    value.title = title
    value.mediaType = t.mediaType
    value.year = usableYear(t.year) ? /** @type {number} */ (t.year) : undefined
    // "记一下《沙丘2》" carries no state, and the honest reading of that is
    // "想看" — so the state is optional here rather than something the model
    // has to make up.
    value.status = value.status ?? DEFAULT_STATUS
    if (value.replaceNotes === true) {
      return { ok: false, message: 'replaceNotes 只用于更新已有条目。' }
    }
    if (a.metadata !== undefined) {
      return { ok: false, message: 'metadata 只用于更新已有条目；新建的身份字段写在 target 里。' }
    }
    if (a.clear !== undefined) {
      return { ok: false, message: 'clear 只用于更新已有条目；新建的记录没有可清空的内容。' }
    }
    if (a.lifecycle !== undefined) {
      return { ok: false, message: 'lifecycle 只用于更新已有条目；新建的记录永远是 active。' }
    }
    return { ok: true, value: /** @type {NormalizedMark} */ (value) }
  } else if (hasTitle) {
    // A title WITHOUT mediaType is an update by title: mediaType is the field
    // that says "this work is new", so its absence is what separates
    // "把《沙丘2》标成看完" from "记一下《繁花》，看完了".
    if (!hasPatch) {
      return {
        ok: false,
        message: '按标题更新需要至少一个要改的字段（status/rating/progress/notes/metadata/clear/lifecycle）；要新建请在 target 里补上 mediaType。',
      }
    }
    const title = usableText(t.title, 300)
    if (title === null) {
      return { ok: false, message: 'target.title 需要 1 到 300 个字符。' }
    }
    if (t.mediaType !== undefined || t.year !== undefined) {
      return {
        ok: false,
        message: '按标题更新只接受 target {title}；类型和年份的纠正请用 metadata。',
      }
    }
    value.mode = 'updateByTitle'
    value.title = title
    return { ok: true, value: /** @type {NormalizedMark} */ (value) }
  } else {
    return {
      ok: false,
      message: '缺少 target：更新需 {assetId, expectedRevision}，按标题更新需 {title}，新建需 {title, mediaType}。',
    }
  }
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
  const page = pageBounds(a)
  if (!page.ok) return page
  return { ok: true, value: { query: a.query.trim(), limit: page.limit, offset: page.offset } }
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
 * Validates the media_log_list arguments. Every filter is optional; an absent
 * filter means "do not narrow", which is why `lifecycle` — the one filter whose
 * absence must mean something specific — is defaulted rather than left null.
 * @param {unknown} args
 * @returns {{ok: true, value: NormalizedList} | {ok: false, message: string}}
 *
 * @typedef {Object} NormalizedList
 * @property {string} [mediaType]
 * @property {string} [status]
 * @property {'active'|'archived'|'all'} lifecycle
 * @property {string|null} completedFrom inclusive lower bound, canonical UTC
 * @property {string|null} completedBefore exclusive upper bound, canonical UTC
 * @property {number} limit
 * @property {number} offset
 */
export function validateListArgs(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, message: '参数必须是一个对象。' }
  }
  const a = /** @type {Record<string, unknown>} */ (args)
  for (const key of Object.keys(a)) {
    if (!LIST_KEYS.includes(key)) {
      return { ok: false, message: `未知参数字段 ${key}。` }
    }
  }

  /** @type {NormalizedList} */
  const value = { lifecycle: 'active', completedFrom: null, completedBefore: null, limit: 10, offset: 0 }

  if (a.mediaType !== undefined) {
    if (typeof a.mediaType !== 'string' || !MEDIA_TYPES.includes(a.mediaType)) {
      return { ok: false, message: 'mediaType 只接受 movie、tv、anime、game。' }
    }
    value.mediaType = a.mediaType
  }
  if (a.status !== undefined) {
    if (typeof a.status !== 'string' || !MEDIA_STATUSES.includes(a.status)) {
      return {
        ok: false,
        message: 'status 只接受 planned、in_progress、completed、paused、dropped。',
      }
    }
    value.status = a.status
  }
  if (a.lifecycle !== undefined) {
    if (typeof a.lifecycle !== 'string' || !LIFECYCLE_FILTERS.includes(a.lifecycle)) {
      return { ok: false, message: 'lifecycle 只接受 active、archived、all。' }
    }
    value.lifecycle = /** @type {'active'|'archived'|'all'} */ (a.lifecycle)
  }

  const from = dateBound(a.completedFrom, 'completedFrom')
  if (!from.ok) return { ok: false, message: from.message }
  value.completedFrom = from.iso
  const before = dateBound(a.completedBefore, 'completedBefore')
  if (!before.ok) return { ok: false, message: before.message }
  value.completedBefore = before.iso
  // Both bounds are canonical UTC, so text order is chronological order here.
  if (value.completedFrom !== null && value.completedBefore !== null) {
    if (value.completedFrom >= value.completedBefore) {
      return { ok: false, message: 'completedFrom 必须早于 completedBefore。' }
    }
  }

  const page = pageBounds(a)
  if (!page.ok) return page
  value.limit = page.limit
  value.offset = page.offset
  return { ok: true, value }
}

/**
 * Whitelist-maps one stored row into a list item. Unlike mapCandidate this
 * carries rating and progress, because a list is meant to be read as an answer
 * rather than as a set of update handles.
 * @param {Record<string, unknown>} row
 */
export function mapListItem(row) {
  return {
    assetId: typeof row.id === 'string' ? row.id : '',
    title: typeof row.title === 'string' ? row.title : '',
    mediaType: typeof row.media_type === 'string' ? row.media_type : '',
    year: typeof row.year === 'number' ? row.year : null,
    status: typeof row.status === 'string' ? row.status : null,
    lifecycle: typeof row.lifecycle === 'string' ? row.lifecycle : '',
    rating: typeof row.rating === 'number' ? row.rating : null,
    progress: mapProgress(row),
  }
}

/**
 * Progress columns → a single object, or null when nothing is set. A unit label
 * alone is impossible (the schema forbids it), so it never needs a case.
 * @param {Record<string, unknown>} row
 */
function mapProgress(row) {
  if (row.progress_current === null && row.progress_total === null && row.progress_unit === null) {
    return null
  }
  return {
    current: row.progress_current ?? null,
    total: row.progress_total ?? null,
    unit: row.progress_unit ?? null,
  }
}

/**
 * Whitelist-maps the detail of one record, truncating notes when included.
 * @param {Record<string, unknown>} row
 * @param {boolean} includeNotes
 */
export function mapDetail(row, includeNotes) {
  return {
    assetId: row.id ?? null,
    revision: row.revision ?? null,
    title: row.title ?? null,
    mediaType: row.media_type ?? null,
    year: row.year ?? null,
    lifecycle: row.lifecycle ?? null,
    status: row.status ?? null,
    rating: row.rating ?? null,
    progress: mapProgress(row),
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at ?? null,
    archivedAt: row.archived_at ?? null,
    hasNotes: typeof row.notes === 'string' && row.notes.length > 0,
    ...notesField(row, includeNotes),
  }
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

/** Where media_log_draws its "tonight" candidates from. 'planned' is the
 *  natural reading of "今晚看什么"; 'paused' is the recovery path. */
const PICK_SOURCES = ['planned', 'paused', 'both']
const PICK_MAX = 5

/**
 * Validates the media_log_pick arguments. All optional: "今晚看什么" arrives
 * as an empty call and still means something.
 * @param {unknown} args
 * @returns {{ok: true, value: {from: 'planned'|'paused'|'both', mediaType: string|null, count: number}} | {ok: false, message: string}}
 */
export function validatePickArgs(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, message: '参数必须是一个对象。' }
  }
  const a = /** @type {Record<string, unknown>} */ (args)
  for (const key of Object.keys(a)) {
    if (!['from', 'mediaType', 'count'].includes(key)) {
      return { ok: false, message: `未知参数字段 ${key}。` }
    }
  }
  /** @type {{from: 'planned'|'paused'|'both', mediaType: string|null, count: number}} */
  const value = { from: 'planned', mediaType: null, count: 3 }
  if (a.from !== undefined) {
    if (typeof a.from !== 'string' || !PICK_SOURCES.includes(a.from)) {
      return { ok: false, message: 'from 只接受 planned、paused、both。' }
    }
    value.from = /** @type {'planned'|'paused'|'both'} */ (a.from)
  }
  if (a.mediaType !== undefined) {
    if (typeof a.mediaType !== 'string' || !MEDIA_TYPES.includes(a.mediaType)) {
      return { ok: false, message: 'mediaType 只接受 movie、tv、anime、game。' }
    }
    value.mediaType = a.mediaType
  }
  if (a.count !== undefined) {
    if (typeof a.count !== 'number' || !Number.isInteger(a.count) || a.count < 1 || a.count > PICK_MAX) {
      return { ok: false, message: `count 必须是 1 到 ${PICK_MAX} 的整数。` }
    }
    value.count = a.count
  }
  return { ok: true, value }
}

/**
 * Picks up to `count` DISTINCT candidates by uniform random draw. Equal odds
 * on purpose: the record never claims to know what you feel like tonight, so
 * any weighting would be theater. `rng` is injectable so tests pin the draw.
 * @template T
 * @param {T[]} items
 * @param {number} count
 * @param {() => number} [rng]
 * @returns {T[]}
 */
export function pickCandidates(items, count, rng = Math.random) {
  const pool = items.slice()
  const picked = []
  while (picked.length < count && pool.length > 0) {
    const index = Math.floor(rng() * pool.length)
    picked.push(pool.splice(index, 1)[0])
  }
  return picked
}
