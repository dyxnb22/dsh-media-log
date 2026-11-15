// Tool-side validation and whitelist mapping for the subscription_* tools.
// Same contract as media.js: the DSH parameter root stays open, so every
// range, format and cross-field constraint is enforced HERE, before any
// database work, and only whitelisted fields cross into the session.
//
// The field semantics follow AssetMesh's subscription doc where they matter
// (integer minor units, renews_at vs expires_at, no calendar arithmetic for a
// future boundary) and stop there — no services, accounts or invoices.

import { dateBound } from './dates.js'
import {
  UUID_RE,
  NOTES_MAX,
  usableText,
  hasNoNul,
  clearFields,
  pageBounds,
  notesField,
} from './toolkit.js'

/** Two-decimal minor units are enough for both, so a monthly estimate is a
 *  plain division rather than a per-currency policy. */
const CURRENCIES = ['CNY', 'USD']
/** monthly | yearly have a stable per-month cost; usage does not, so it is
 *  estimated separately rather than guessed at. */
const CYCLES = ['monthly', 'yearly', 'usage']
const MARK_LIFECYCLES = ['active', 'archived']
const LIST_LIFECYCLES = ['active', 'archived', 'all']
const CLEARABLE = ['provider', 'amountMinor', 'nextRenewAt', 'expiresAt', 'notes']
const ROOT_KEYS = [
  'target',
  'provider',
  'amountMinor',
  'currency',
  'cycle',
  'nextRenewAt',
  'expiresAt',
  'autoRenew',
  'notes',
  'replaceNotes',
  'clear',
  'lifecycle',
]
const TARGET_KEYS = ['assetId', 'expectedRevision', 'name']

/**
 * Validates the subscription_mark argument object.
 *
 * Only two ways to aim it: by id (assetId + expectedRevision) to update, or by
 * name to create. There is deliberately no update-by-name — a name is not a
 * unique key here, and silently patching "the" Netflix row would be a guess.
 * Find the id with subscription_list instead.
 * @param {unknown} args
 * @returns {{ok: true, value: NormalizedMark} | {ok: false, message: string}}
 *
 * @typedef {Object} NormalizedMark
 * @property {'update'|'create'} mode
 * @property {string} [assetId]
 * @property {number} [expectedRevision]
 * @property {string} [name]
 * @property {string} [provider]
 * @property {number|null} [amountMinor] null = unknown, which is not 0
 * @property {string} [currency]
 * @property {string} [cycle]
 * @property {string|null} [nextRenewAt]
 * @property {string|null} [expiresAt]
 * @property {boolean} [autoRenew]
 * @property {string} [notes]
 * @property {boolean} replaceNotes
 * @property {Array<'provider'|'amountMinor'|'nextRenewAt'|'expiresAt'|'notes'>} [clear]
 * @property {'active'|'archived'} [lifecycle]
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
    return { ok: false, message: '缺少 target：更新需 {assetId, expectedRevision}，新建需 {name}。' }
  }
  const t = /** @type {Record<string, unknown>} */ (target)
  for (const key of Object.keys(t)) {
    if (!TARGET_KEYS.includes(key)) {
      return { ok: false, message: `target 含未知字段 ${key}。` }
    }
  }
  const hasAssetId = t.assetId !== undefined
  const hasName = t.name !== undefined
  if (hasAssetId && hasName) {
    return { ok: false, message: 'target 不能同时带 assetId 和 name：要么按 UUID 改，要么新建。' }
  }
  if (hasName && t.expectedRevision !== undefined) {
    return { ok: false, message: '新建不需要 expectedRevision。' }
  }

  /** @type {Partial<NormalizedMark>} */
  const value = { replaceNotes: a.replaceNotes === true }
  if (a.replaceNotes !== undefined && typeof a.replaceNotes !== 'boolean') {
    return { ok: false, message: 'replaceNotes 必须是布尔值。' }
  }

  if (a.provider !== undefined) {
    const provider = usableText(a.provider, 200)
    if (provider === null) return { ok: false, message: 'provider 需要 1 到 200 个字符。' }
    value.provider = provider
  }
  if (a.amountMinor !== undefined) {
    if (
      typeof a.amountMinor !== 'number' ||
      !Number.isInteger(a.amountMinor) ||
      a.amountMinor < 0
    ) {
      return { ok: false, message: 'amountMinor 必须是非负整数（分/美分；20 美元 = 2000）。' }
    }
    value.amountMinor = a.amountMinor
  }
  if (a.currency !== undefined) {
    if (typeof a.currency !== 'string' || !CURRENCIES.includes(a.currency)) {
      return { ok: false, message: 'currency 只接受 CNY、USD。' }
    }
    value.currency = a.currency
  }
  if (a.cycle !== undefined) {
    if (typeof a.cycle !== 'string' || !CYCLES.includes(a.cycle)) {
      return { ok: false, message: 'cycle 只接受 monthly、yearly、usage。' }
    }
    value.cycle = a.cycle
  }
  const nextRenewAt = dateBound(a.nextRenewAt, 'nextRenewAt')
  if (!nextRenewAt.ok) return { ok: false, message: nextRenewAt.message }
  const expiresAt = dateBound(a.expiresAt, 'expiresAt')
  if (!expiresAt.ok) return { ok: false, message: expiresAt.message }
  // Assigned only when supplied, so "absent" stays distinguishable from
  // "explicitly empty" — hasPatch and the clear conflict check both depend on
  // that difference.
  if (a.nextRenewAt !== undefined) value.nextRenewAt = nextRenewAt.iso
  if (a.expiresAt !== undefined) value.expiresAt = expiresAt.iso
  if (a.autoRenew !== undefined) {
    if (typeof a.autoRenew !== 'boolean') {
      return { ok: false, message: 'autoRenew 必须是布尔值。' }
    }
    value.autoRenew = a.autoRenew
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

  // Parsed before the mode is decided, because both the update path and the
  // create path have to know whether a patch was supplied at all.
  const hasPatch =
    value.provider !== undefined ||
    value.amountMinor !== undefined ||
    value.currency !== undefined ||
    value.cycle !== undefined ||
    value.nextRenewAt !== undefined ||
    value.expiresAt !== undefined ||
    value.autoRenew !== undefined ||
    value.notes !== undefined ||
    a.clear !== undefined ||
    a.lifecycle !== undefined

  const clear = a.clear
  if (clear !== undefined) {
    const cleared = clearFields(a.clear, CLEARABLE)
    if (!cleared.ok) return cleared
    const fields = /** @type {Array<'provider'|'amountMinor'|'nextRenewAt'|'expiresAt'|'notes'>} */ (cleared.fields)
    value.clear = fields
    // Setting and emptying the same field in one call is a contradiction.
    for (const [field, given] of [
      ['provider', value.provider],
      ['amountMinor', value.amountMinor],
      ['nextRenewAt', value.nextRenewAt],
      ['expiresAt', value.expiresAt],
      ['notes', value.notes],
    ]) {
      if (fields.includes(/** @type {any} */ (field)) && given !== undefined) {
        return { ok: false, message: `clear 里有 ${field} 时不能再传 ${field} 的新值。` }
      }
    }
  }

  if (a.lifecycle !== undefined) {
    if (typeof a.lifecycle !== 'string' || !MARK_LIFECYCLES.includes(a.lifecycle)) {
      return { ok: false, message: 'lifecycle 只接受 active、archived。' }
    }
    value.lifecycle = /** @type {'active'|'archived'} */ (a.lifecycle)
  }

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
        message: '更新至少要提供 provider、amountMinor、currency、cycle、nextRenewAt、expiresAt、autoRenew、notes、clear、lifecycle 之一。',
      }
    }
    return { ok: true, value: /** @type {NormalizedMark} */ (value) }
  }

  if (!hasName) {
    return { ok: false, message: '缺少 target：更新需 {assetId, expectedRevision}，新建需 {name}。' }
  }
  const name = usableText(t.name, 200)
  if (name === null) {
    return { ok: false, message: 'target.name 需要 1 到 200 个字符。' }
  }
  // The billing cycle is the one field that makes this a subscription rather
  // than a note, so it is asked for instead of guessed.
  if (value.cycle === undefined) {
    return { ok: false, message: '新建需要 cycle（monthly、yearly 或 usage）。' }
  }
  if (value.replaceNotes === true) {
    return { ok: false, message: 'replaceNotes 只用于更新已有条目。' }
  }
  if (a.clear !== undefined) {
    return { ok: false, message: 'clear 只用于更新已有条目；新建的记录没有可清空的内容。' }
  }
  if (a.lifecycle !== undefined) {
    return { ok: false, message: 'lifecycle 只用于更新已有条目；新建的记录永远是 active。' }
  }
  value.mode = 'create'
  value.name = name
  return { ok: true, value: /** @type {NormalizedMark} */ (value) }
}

/**
 * Validates the subscription_list arguments. Every filter is optional; the one
 * whose absence must mean something specific — lifecycle — is defaulted.
 * @param {unknown} args
 * @returns {{ok: true, value: NormalizedList} | {ok: false, message: string}}
 *
 * @typedef {Object} NormalizedList
 * @property {string|null} name substring filter
 * @property {string|null} cycle
 * @property {string|null} currency
 * @property {boolean|null} autoRenew
 * @property {'active'|'archived'|'all'} lifecycle
 * @property {string|null} renewFrom inclusive lower bound on next_renew_at
 * @property {string|null} renewBefore exclusive upper bound on next_renew_at
 * @property {number} limit
 * @property {number} offset
 */
export function validateListArgs(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, message: '参数必须是一个对象。' }
  }
  const a = /** @type {Record<string, unknown>} */ (args)
  const LIST_KEYS = [
    'name',
    'cycle',
    'currency',
    'autoRenew',
    'lifecycle',
    'renewFrom',
    'renewBefore',
    'limit',
    'offset',
  ]
  for (const key of Object.keys(a)) {
    if (!LIST_KEYS.includes(key)) {
      return { ok: false, message: `未知参数字段 ${key}。` }
    }
  }

  /** @type {NormalizedList} */
  const value = {
    name: null,
    cycle: null,
    currency: null,
    autoRenew: null,
    lifecycle: 'active',
    renewFrom: null,
    renewBefore: null,
    limit: 10,
    offset: 0,
  }

  if (a.name !== undefined) {
    const name = usableText(a.name, 200)
    if (name === null) return { ok: false, message: 'name 需要 1 到 200 个字符。' }
    value.name = name
  }
  if (a.cycle !== undefined) {
    if (typeof a.cycle !== 'string' || !CYCLES.includes(a.cycle)) {
      return { ok: false, message: 'cycle 只接受 monthly、yearly、usage。' }
    }
    value.cycle = a.cycle
  }
  if (a.currency !== undefined) {
    if (typeof a.currency !== 'string' || !CURRENCIES.includes(a.currency)) {
      return { ok: false, message: 'currency 只接受 CNY、USD。' }
    }
    value.currency = a.currency
  }
  if (a.autoRenew !== undefined) {
    if (typeof a.autoRenew !== 'boolean') {
      return { ok: false, message: 'autoRenew 必须是布尔值。' }
    }
    value.autoRenew = a.autoRenew
  }
  if (a.lifecycle !== undefined) {
    if (typeof a.lifecycle !== 'string' || !LIST_LIFECYCLES.includes(a.lifecycle)) {
      return { ok: false, message: 'lifecycle 只接受 active、archived、all。' }
    }
    value.lifecycle = /** @type {'active'|'archived'|'all'} */ (a.lifecycle)
  }
  const from = dateBound(a.renewFrom, 'renewFrom')
  if (!from.ok) return { ok: false, message: from.message }
  value.renewFrom = from.iso
  const before = dateBound(a.renewBefore, 'renewBefore')
  if (!before.ok) return { ok: false, message: before.message }
  value.renewBefore = before.iso
  if (value.renewFrom !== null && value.renewBefore !== null && value.renewFrom >= value.renewBefore) {
    return { ok: false, message: 'renewFrom 必须早于 renewBefore。' }
  }

  const page = pageBounds(a)
  if (!page.ok) return page
  value.limit = page.limit
  value.offset = page.offset
  return { ok: true, value }
}

/**
 * Months a fixed cycle covers, or null when the cost is not a stable per-month
 * figure (usage-based). Only used for the estimate, never to advance a date.
 * @param {string} cycle
 * @returns {number|null}
 */
export function cycleMonths(cycle) {
  if (cycle === 'monthly') return 1
  if (cycle === 'yearly') return 12
  return null
}

/**
 * The per-month equivalent of one row in minor units, or null when there is
 * none: usage-based, or an amount nobody recorded. This plugin's own
 * convenience figure — AssetMesh never claimed a cost report.
 * @param {Record<string, unknown>} row
 * @returns {number|null}
 */
export function monthlyMinor(row) {
  if (typeof row.amount_minor !== 'number') return null
  const months = cycleMonths(String(row.cycle))
  if (months === null) return null
  return Math.round(row.amount_minor / months)
}

/**
 * Whitelist-maps one stored row into a list item. Carries the monthly
 * equivalent so a page can be read as an answer about money.
 * @param {Record<string, unknown>} row
 */
export function mapListItem(row) {
  return {
    assetId: typeof row.id === 'string' ? row.id : '',
    name: typeof row.name === 'string' ? row.name : '',
    provider: typeof row.provider === 'string' ? row.provider : null,
    cycle: typeof row.cycle === 'string' ? row.cycle : '',
    currency: typeof row.currency === 'string' ? row.currency : '',
    amountMinor: typeof row.amount_minor === 'number' ? row.amount_minor : null,
    autoRenew: row.auto_renew === 1,
    nextRenewAt: typeof row.next_renew_at === 'string' ? row.next_renew_at : null,
    expiresAt: typeof row.expires_at === 'string' ? row.expires_at : null,
    lifecycle: typeof row.lifecycle === 'string' ? row.lifecycle : '',
    monthlyMinor: monthlyMinor(row),
    // Carried so a list page is enough to update: the caller can mark straight
    // from the row it just read, without a separate get to learn the revision.
    revision: typeof row.revision === 'number' ? row.revision : null,
  }
}

/**
 * Whitelist-maps the detail of one record, truncating notes when included.
 * `renewsAt`/`expiresAt` are reported as recorded — a past date means the
 * recorded date has passed, nothing more.
 * @param {Record<string, unknown>} row
 * @param {boolean} includeNotes
 */
export function mapDetail(row, includeNotes) {
  return {
    assetId: row.id ?? null,
    revision: row.revision ?? null,
    name: row.name ?? null,
    provider: row.provider ?? null,
    amountMinor: row.amount_minor ?? null,
    currency: row.currency ?? null,
    cycle: row.cycle ?? null,
    nextRenewAt: row.next_renew_at ?? null,
    expiresAt: row.expires_at ?? null,
    autoRenew: row.auto_renew === 1,
    lifecycle: row.lifecycle ?? null,
    monthlyMinor: monthlyMinor(row),
    archivedAt: row.archived_at ?? null,
    hasNotes: typeof row.notes === 'string' && row.notes.length > 0,
    ...notesField(row, includeNotes),
  }
}
