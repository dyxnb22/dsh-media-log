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
