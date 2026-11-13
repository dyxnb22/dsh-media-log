// One definition of what a date bound looks like, shared by every list tool.
//
// The stored values mix two ISO spellings — imported `2025-07-09T00:00:00+00:00`
// with microseconds, plugin-written `2025-07-09T00:00:00.000Z` with milliseconds
// — so a bound must be normalized before it is compared against them. SQLite's
// julianday() reads both spellings and returns NULL for NULL, which is what
// makes "a record without this date never enters the range" fall out for free.

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/
const ZONED_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/

/**
 * Normalizes one date bound to a canonical UTC instant, or reports why it
 * cannot be used.
 *
 * A bare datetime (`2025-11-01T00:00:00`) is refused on purpose: SQLite's date
 * functions read it as UTC while Date.parse reads it as local, so letting it
 * through would shift the bound by the machine's zone. A whole day is
 * unambiguous — both read it as UTC midnight.
 * @param {unknown} value
 * @param {string} field parameter name, for the error message
 * @returns {{ok: true, iso: string | null} | {ok: false, message: string}}
 */
export function dateBound(value, field) {
  if (value === undefined) return { ok: true, iso: null }
  if (typeof value !== 'string') {
    return { ok: false, message: `${field} 必须是 ISO-8601 字符串。` }
  }
  const text = value.trim()
  if (!DATE_ONLY_RE.test(text) && !ZONED_RE.test(text)) {
    return {
      ok: false,
      message: `${field} 需要 ISO-8601：整天写 2025-11-01，带时刻必须带时区，例如 2025-11-01T00:00:00+08:00。`,
    }
  }
  const parsed = Date.parse(text)
  if (!Number.isFinite(parsed)) {
    return { ok: false, message: `${field} 不是有效日期：${text}` }
  }
  return { ok: true, iso: new Date(parsed).toISOString() }
}
