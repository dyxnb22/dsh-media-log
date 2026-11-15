// Pieces every module's tools share.
//
// The output contract, failure branch and unchanged receipt are shared so
// fixes to them reach all three modules. Per-module parts (which fields a row
// has, how a candidate reads) stay in the modules; only identical behaviour
// lives here.

/**
 * The output half of a defineTool: an open schema — the canonical value really
 * is polymorphic — plus this module's render.
 * @param {(args: unknown, value: unknown) => Array<{type: string, text: string}>} render
 */
export function toolOutput(render) {
  return {
    schema: {
      type: 'object',
      additionalProperties: true,
      description:
        '{ok:true, data} on success; {ok:false, error:{code, message, currentRevision?, candidates?, hint?}} on an expected failure.',
    },
    render,
  }
}

/**
 * The "this is a plugin bug" text. Every module words it the same way, with its
 * own name in front.
 * @param {string} moduleName
 */
export function unexpectedStructure(moduleName) {
  return [{ type: 'text', text: `${moduleName} 工具返回了意外结构。` }]
}

/**
 * The whole failure branch, shared so a change to the error vocabulary lands
 * once across the modules.
 *
 * `candidateLine` is the only per-module part: how one offered record reads
 * depends on which fields the module has.
 * @param {any} v the failure envelope
 * @param {(item: any) => string} candidateLine
 */
export function renderFailure(v, candidateLine) {
  const lines = [`未完成 [${v.error?.code}]：${v.error?.message ?? '未知错误'}`]
  if (v.error?.currentRevision !== undefined) {
    lines.push(`这个条目现在已经是 revision ${v.error.currentRevision}，请重新读取后再改。`)
  }
  if (Array.isArray(v.error?.candidates) && v.error.candidates.length > 0) {
    lines.push('可能匹配的条目：')
    for (const item of v.error.candidates) {
      lines.push(candidateLine(item))
    }
    // The next step differs by path, so the failure names it rather than
    // leaving the render to guess.
    lines.push(v.error.hint ?? '回复想用哪一个，再读取该条目的 revision 后更新。')
  } else if (v.error.hint) {
    // A hint with no candidates is the "nothing matched, here is how to
    // proceed" case — which is exactly when the model needs it most.
    lines.push(v.error.hint)
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

/** The unchanged receipt — identical wording across the three modules. */
export function unchangedReceipt(receipt) {
  return [
    {
      type: 'text',
      text: `没有变化：记录已是所描述的状态（assetId=${receipt.assetId}，revision=${receipt.revision}）。`,
    },
  ]
}

/**
 * Renders one journal value. Long text never reaches the journal — the module
 * passes the sentinel '原文'/'新文' instead — so this only shapes short ones.
 * @param {unknown} value
 */
function describeValue(value) {
  if (value === null || value === '') return '空'
  if (value === true) return '是'
  if (value === false) return '否'
  return String(value)
}

/**
 * Builds the one-line summary a journal row keeps, from
 * [label, before, after] triples. A triple only appears when the value moved;
 * `before === undefined` marks an initial value on a create.
 *
 * Returns '' when nothing moved — callers use that to skip journaling.
 * @param {Array<[string, unknown, unknown]>} parts
 */
export function changeSummary(parts) {
  const bits = []
  for (const [label, before, after] of parts) {
    if (before === after) continue
    if (before === undefined) bits.push(`${label}=${describeValue(after)}`)
    else bits.push(`${label}：${describeValue(before)}→${describeValue(after)}`)
  }
  return bits.join('；')
}

/**
 * A journal triple for a long-text field (notes, purpose, content). The text
 * itself never travels: equal values collapse to a skipped triple, a replace
 * reads 原文→新文, a first write 空→新文, a clear 原文→空.
 * @param {string} label
 * @param {unknown} before
 * @param {unknown} after
 * @returns {[string, unknown, unknown]}
 */
export function textChange(label, before, after) {
  if ((before ?? null) === (after ?? null)) return [label, null, null]
  return [label, before ? '原文' : null, after ? '新文' : null]
}

/**
 * Records one journal row and trims the log to its cap. Must run inside the
 * same transaction as the write it describes, so a rolled-back write leaves no
 * journal trace.
 * @param {import('node:sqlite').StatementSync} journal
 * @param {import('node:sqlite').StatementSync} journalTrim
 * @param {{at: string, module: string, assetId: string, name: string, action: 'create'|'update', summary: string}} entry
 */
export function recordChange(journal, journalTrim, entry) {
  journal.run(entry.at, entry.module, entry.assetId, entry.name, entry.action, entry.summary)
  journalTrim.run()
}

// ---------------------------------------------------------------------------
// Shared validator pieces. Byte-identical parts of the three modules'
// validators live here, under the same charter as above: identical behaviour
// only — each module keeps its own root keys, enums and wording where it
// differs.

/** One UUID check, shared by every module's id fields. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The cap a notes/review field travels with, shared by all three modules. */
export const NOTES_MAX = 2000

/** @returns {boolean} false when the text contains NUL. */
export function hasNoNul(text) {
  return !text.includes('\u0000')
}

/** @returns {string | null} the trimmed text, or null outside 1..max chars */
export function usableText(value, max) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length >= 1 && trimmed.length <= max ? trimmed : null
}

/**
 * Validates the *_get arguments — the same contract in all three modules: a
 * full UUID plus an opt-in notes flag.
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
 * Validates the limit/offset pair every list-shaped tool shares: 1-20 and
 * 0-1000, defaults 10 and 0.
 * @param {Record<string, unknown>} a raw arguments already shape-checked
 * @returns {{ok: true, limit: number, offset: number} | {ok: false, message: string}}
 */
export function pageBounds(a) {
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
  return { ok: true, limit, offset }
}

/**
 * Validates a `clear` array: non-empty, every entry whitelisted, duplicates
 * collapsed. `hint` extends the refusal with module-specific guidance (media
 * notes that title and mediaType are NOT NULL and cannot be emptied).
 * @param {unknown} raw
 * @param {string[]} clearable
 * @param {string} [hint]
 * @returns {{ok: true, fields: string[]} | {ok: false, message: string}}
 */
export function clearFields(raw, clearable, hint = '') {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, message: 'clear 必须是非空数组。' }
  }
  const fields = []
  for (const entry of raw) {
    if (typeof entry !== 'string' || !clearable.includes(entry)) {
      return { ok: false, message: `clear 只接受 ${clearable.join('、')}${hint}。` }
    }
    if (!fields.includes(entry)) fields.push(entry)
  }
  return { ok: true, fields }
}

/**
 * The notes half of every module's mapDetail: the text (capped at NOTES_MAX,
 * flagged with notesTruncated) only when the caller asked for it. Returns {}
 * when not included, so spreading it leaves the `notes` key absent — "notes
 * stay out unless asked for" is a key-presence contract, not a null one.
 * @param {Record<string, unknown>} row
 * @param {boolean} includeNotes
 */
export function notesField(row, includeNotes) {
  if (!includeNotes) return {}
  const notes = typeof row.notes === 'string' ? row.notes : null
  if (notes !== null && notes.length > NOTES_MAX) {
    return { notes: notes.slice(0, NOTES_MAX), notesTruncated: true }
  }
  return { notes }
}
