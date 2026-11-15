// Tool-side validation, whitelist mapping and the three software_* tools.
//
// The point of this module is the user's own "why did I install this" — the
// purpose field, kept by hand. It is deliberately NOT a discovery system:
// nothing here scans the machine, installs, or uninstalls anything, and a row
// being in the list says nothing about what is currently installed or running.
//
// Same contract as the other modules: validation happens HERE before any
// database work, only whitelisted fields cross into the session, and every
// expected failure is a canonical VALUE rather than a throw.

import { defineTool } from '@deepseek-ai/dsh-tools'
import { randomUUID } from 'node:crypto'
import { inTransaction, statementCache, nowIso, likePattern, journalStatements } from './db.js'
import { ok, fail, attemptSqlite, isFail } from './errors.js'
import { resolveConfig, ensureReady } from './config.js'
import {
  toolOutput,
  unexpectedStructure,
  renderFailure,
  unchangedReceipt,
  changeSummary,
  textChange,
  recordChange,
  UUID_RE,
  NOTES_MAX,
  usableText,
  hasNoNul,
  pageBounds,
  clearFields,
  notesField,
  validateGetArgs,
} from './toolkit.js'

/** in_use | retired. Retiring keeps the purpose and the notes. */
const STATUSES = ['in_use', 'retired']
const LIST_STATUSES = ['in_use', 'retired', 'all']
const CLEARABLE = ['category', 'purpose', 'sourceUrl', 'version', 'platform', 'notes']
const ROOT_KEYS = [
  'target',
  'category',
  'purpose',
  'sourceUrl',
  'version',
  'platform',
  'status',
  'notes',
  'replaceNotes',
  'clear',
]
const TARGET_KEYS = ['assetId', 'expectedRevision', 'name']
const URL_MAX = 2000

/**
 * Validates the software_mark argument object. Only two ways to aim it: by id
 * to update, or by name to create. There is no update-by-name — a tool name is
 * not a unique key, and silently patching "the" ffmpeg row would be a guess.
 * @param {unknown} args
 * @returns {{ok: true, value: NormalizedMark} | {ok: false, message: string}}
 *
 * @typedef {Object} NormalizedMark
 * @property {'update'|'create'} mode
 * @property {string} [assetId]
 * @property {number} [expectedRevision]
 * @property {string} [name]
 * @property {string} [category]
 * @property {string} [purpose]
 * @property {string} [sourceUrl]
 * @property {string} [version]
 * @property {string} [platform]
 * @property {'in_use'|'retired'} [status]
 * @property {string} [notes]
 * @property {boolean} replaceNotes
 * @property {Array<'category'|'purpose'|'sourceUrl'|'version'|'platform'|'notes'>} [clear]
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

  for (const [field, label, max] of [
    ['category', 'category', 100],
    ['purpose', 'purpose', 2000],
    ['version', 'version', 100],
    ['platform', 'platform', 100],
  ]) {
    if (a[field] === undefined) continue
    const text = usableText(a[field], max)
    if (text === null) return { ok: false, message: `${label} 需要 1 到 ${max} 个字符。` }
    if (!hasNoNul(text)) return { ok: false, message: `${label} 不能包含 NUL 字符。` }
    value[/** @type {keyof NormalizedMark} */ (field)] = text
  }
  if (a.sourceUrl !== undefined) {
    const url = usableText(a.sourceUrl, URL_MAX)
    if (url === null) return { ok: false, message: `sourceUrl 需要 1 到 ${URL_MAX} 个字符。` }
    if (!hasNoNul(url)) return { ok: false, message: 'sourceUrl 不能包含 NUL 字符。' }
    value.sourceUrl = url
  }
  if (a.status !== undefined) {
    if (typeof a.status !== 'string' || !STATUSES.includes(a.status)) {
      return { ok: false, message: 'status 只接受 in_use、retired。' }
    }
    value.status = /** @type {'in_use'|'retired'} */ (a.status)
  }
  if (a.notes !== undefined) {
    const notes = usableText(a.notes, NOTES_MAX)
    if (notes === null) return { ok: false, message: `notes 需要 1 到 ${NOTES_MAX} 个字符。` }
    if (!hasNoNul(notes)) return { ok: false, message: 'notes 不能包含 NUL 字符。' }
    value.notes = notes
  }

  const hasPatch =
    value.category !== undefined ||
    value.purpose !== undefined ||
    value.sourceUrl !== undefined ||
    value.version !== undefined ||
    value.platform !== undefined ||
    value.status !== undefined ||
    value.notes !== undefined ||
    a.clear !== undefined

  const clear = a.clear
  if (clear !== undefined) {
    const cleared = clearFields(a.clear, CLEARABLE)
    if (!cleared.ok) return cleared
    const fields = /** @type {Array<'category'|'purpose'|'sourceUrl'|'version'|'platform'|'notes'>} */ (cleared.fields)
    value.clear = fields
    // Setting and emptying the same field in one call is a contradiction.
    for (const field of fields) {
      if (value[/** @type {keyof NormalizedMark} */ (field)] !== undefined) {
        return { ok: false, message: `clear 里有 ${field} 时不能再传 ${field} 的新值。` }
      }
    }
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
        message: '更新至少要提供 category、purpose、sourceUrl、version、platform、status、notes、clear 之一。',
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
  // The purpose is the whole point of this module, so it is asked for rather
  // than left empty — "装过什么" is trivia, "为什么装" is the record.
  if (value.purpose === undefined) {
    return { ok: false, message: '新建需要 purpose——这条记录的价值就在于你为什么装它。' }
  }
  if (value.replaceNotes === true) {
    return { ok: false, message: 'replaceNotes 只用于更新已有条目。' }
  }
  if (a.clear !== undefined) {
    return { ok: false, message: 'clear 只用于更新已有条目；新建的记录没有可清空的内容。' }
  }
  value.mode = 'create'
  value.name = name
  return { ok: true, value: /** @type {NormalizedMark} */ (value) }
}

/**
 * Validates the software_list arguments. Every filter is optional; the one
 * whose absence must mean something specific — status — is defaulted.
 * @param {unknown} args
 * @returns {{ok: true, value: NormalizedList} | {ok: false, message: string}}
 *
 * @typedef {Object} NormalizedList
 * @property {string|null} name substring of the name
 * @property {string|null} text substring of name, category, purpose and notes
 * @property {string|null} category
 * @property {'in_use'|'retired'|'all'} status
 * @property {number} limit
 * @property {number} offset
 */
export function validateListArgs(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, message: '参数必须是一个对象。' }
  }
  const a = /** @type {Record<string, unknown>} */ (args)
  const LIST_KEYS = ['name', 'text', 'category', 'status', 'limit', 'offset']
  for (const key of Object.keys(a)) {
    if (!LIST_KEYS.includes(key)) {
      return { ok: false, message: `未知参数字段 ${key}。` }
    }
  }

  /** @type {NormalizedList} */
  const value = {
    name: null,
    text: null,
    category: null,
    status: 'in_use',
    limit: 10,
    offset: 0,
  }

  if (a.name !== undefined) {
    const name = usableText(a.name, 200)
    if (name === null) return { ok: false, message: 'name 需要 1 到 200 个字符。' }
    value.name = name
  }
  if (a.text !== undefined) {
    const text = usableText(a.text, 200)
    if (text === null) return { ok: false, message: 'text 需要 1 到 200 个字符。' }
    value.text = text
  }
  if (a.category !== undefined) {
    const category = usableText(a.category, 100)
    if (category === null) return { ok: false, message: 'category 需要 1 到 100 个字符。' }
    value.category = category
  }
  if (a.status !== undefined) {
    if (typeof a.status !== 'string' || !LIST_STATUSES.includes(a.status)) {
      return { ok: false, message: 'status 只接受 in_use、retired、all。' }
    }
    value.status = /** @type {'in_use'|'retired'|'all'} */ (a.status)
  }
  const page = pageBounds(a)
  if (!page.ok) return page
  value.limit = page.limit
  value.offset = page.offset
  return { ok: true, value }
}

/**
 * Whitelist-maps one stored row into a list item. The purpose travels with the
 * name, because a name alone answers nothing this module exists to answer.
 * @param {Record<string, unknown>} row
 */
export function mapListItem(row) {
  return {
    assetId: typeof row.id === 'string' ? row.id : '',
    name: typeof row.name === 'string' ? row.name : '',
    category: typeof row.category === 'string' ? row.category : null,
    purpose: typeof row.purpose === 'string' ? row.purpose : null,
    version: typeof row.version === 'string' ? row.version : null,
    platform: typeof row.platform === 'string' ? row.platform : null,
    status: typeof row.status === 'string' ? row.status : '',
    // Carried so a list page is enough to update: the caller can mark straight
    // from the row it just read, without a separate get to learn the revision.
    revision: typeof row.revision === 'number' ? row.revision : null,
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
    name: row.name ?? null,
    category: row.category ?? null,
    purpose: row.purpose ?? null,
    sourceUrl: row.source_url ?? null,
    version: row.version ?? null,
    platform: row.platform ?? null,
    status: row.status ?? null,
    hasNotes: typeof row.notes === 'string' && row.notes.length > 0,
    ...notesField(row, includeNotes),
  }
}

/**
 * Resolves the next state of every writable column of an update, with `clear`
 * emptying what it names. Resolving first and comparing afterwards makes "the
 * same patch changes nothing" a property of the RESULT.
 * @param {Record<string, any>} row
 * @param {ReturnType<typeof validateMarkArgs> extends {ok: true, value: infer V} ? V : never} cmd
 */
function resolveUpdate(row, cmd) {
  const clearing = new Set(cmd.clear ?? [])
  return {
    name: row.name,
    category: clearing.has('category') ? null : (cmd.category ?? row.category),
    purpose: clearing.has('purpose') ? null : (cmd.purpose ?? row.purpose),
    sourceUrl: clearing.has('sourceUrl') ? null : (cmd.sourceUrl ?? row.source_url),
    version: clearing.has('version') ? null : (cmd.version ?? row.version),
    platform: clearing.has('platform') ? null : (cmd.platform ?? row.platform),
    status: cmd.status ?? row.status,
    notes: clearing.has('notes') ? null : (cmd.notes ?? row.notes),
  }
}

/** True when a resolved update would leave every stored column exactly as is. */
function updateIsNoop(row, next) {
  return (
    next.name === row.name &&
    next.category === row.category &&
    next.purpose === row.purpose &&
    next.sourceUrl === row.source_url &&
    next.version === row.version &&
    next.platform === row.platform &&
    next.status === row.status &&
    next.notes === row.notes
  )
}

/** This module's own statement cache — see statementCache() for why it is not shared. */
const statements = statementCache()

/**
 * Prepared statements for one open library, keyed to the handle by a WeakMap.
 *
 * `text` is a search across the name, the category, the purpose and the notes,
 * because the question this module answers is "what did I use for X" and X
 * lives in the purpose far more often than in the name.
 * @param {import('node:sqlite').DatabaseSync} db
 */
function buildStatements(db) {
  const LIST_WHERE = `
    WHERE (status = :status OR :status = 'all')
      AND (:name IS NULL OR name LIKE :name ESCAPE '\\')
      AND (:category IS NULL OR category LIKE :category ESCAPE '\\')
      AND (:text IS NULL OR name LIKE :text ESCAPE '\\'
           OR category LIKE :text ESCAPE '\\'
           OR purpose LIKE :text ESCAPE '\\'
           OR notes LIKE :text ESCAPE '\\')`
  const LIST_COLUMNS = `id, name, category, purpose, version, platform, status, revision`
  return {
    byName: db.prepare(`SELECT * FROM software WHERE name = ?`),
    byId: db.prepare(`SELECT * FROM software WHERE id = ?`),
    countByName: db.prepare(`SELECT count(*) AS n FROM software WHERE name = ?`),
    insert: db.prepare(
      `INSERT INTO software (id, name, category, purpose, source_url, version, platform,
         notes, status, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ),
    update: db.prepare(
      `UPDATE software SET name = ?, category = ?, purpose = ?, source_url = ?, version = ?,
         platform = ?, status = ?, notes = ?, revision = revision + 1, updated_at = ?
       WHERE id = ? AND revision = ?`,
    ),
    ...journalStatements(db),
    list: db.prepare(
      `SELECT ${LIST_COLUMNS} FROM software${LIST_WHERE}
       ORDER BY name ASC LIMIT :limit OFFSET :offset`,
    ),
    listCount: db.prepare(`SELECT count(*) AS n FROM software${LIST_WHERE}`),
  }
}

const STATUS_ZH = { in_use: '在用', retired: '已停用' }

/**
 * Model-facing render text (pure: a function of args + canonical value).
 * @param {unknown} args original tool arguments
 * @param {unknown} value canonical tool value
 * @returns {string[]}
 */
/** One offered software record, in the fields a software candidate has. */
function softwareCandidateLine(item) {
  return `- 《${item.name}》assetId=${item.assetId}`
}

function renderValue(args, value) {
  const v = /** @type {any} */ (value)
  if (!v || typeof v !== 'object' || !('ok' in v)) return unexpectedStructure('software')
  if (v.ok !== true) return renderFailure(v, softwareCandidateLine)

  const data = v.data ?? {}
  if (data.receipt) {
    const receipt = data.receipt
    const detail = data.software ?? {}
    if (receipt.outcome === 'unchanged') return unchangedReceipt(receipt)
    const verb = receipt.outcome === 'created' ? '已记下' : '已更新'
    const parts = [`${verb}《${detail.name ?? ''}》`]
    if (detail.purpose) parts.push(`用途：${detail.purpose}`)
    if (detail.category) parts.push(detail.category)
    if (detail.version) parts.push(detail.version)
    parts.push(STATUS_ZH[detail.status] ?? detail.status ?? '')
    return [
      {
        type: 'text',
        text: `${parts.join('，')}。（assetId=${receipt.assetId}，revision=${receipt.revision}）`,
      },
    ]
  }

  if (data.filters) {
    const scope = data.filters.status === 'retired' ? '（只看已停用）' : data.filters.status === 'all' ? '（含已停用）' : ''
    const offset = typeof data.offset === 'number' ? data.offset : 0
    const lines = []
    if (data.items.length === 0) {
      lines.push(offset > 0 ? '这一页是空的——offset 已经越过末页。' : `清单里没有符合条件的软件${scope}。`)
    } else {
      lines.push(`${listSummary(data.filters, data.items.length)}${scope}`)
      for (const item of data.items) lines.push(softwareLine(item))
    }
    if (data.total === null) {
      lines.push('结果未穷尽，可继续翻页（把 offset 加上一页的 limit）。')
    }
    // A list entry is a record of what the user wrote down, never a claim
    // about the machine.
    if (data.items.length > 0) lines.push('（清单只反映你记下来的内容，不代表本机装了什么）')
    return [{ type: 'text', text: lines.join('\n') }]
  }

  if (data.assetId) {
    const parts = [`《${data.name}》`]
    if (data.purpose) parts.push(`用途：${data.purpose}`)
    if (data.category) parts.push(data.category)
    if (data.version) parts.push(data.version)
    if (data.platform) parts.push(data.platform)
    parts.push(STATUS_ZH[data.status] ?? data.status ?? '')
    const lines = [
      `${parts.join('，')}（assetId=${data.assetId}，revision=${data.revision}）。`,
    ]
    if (data.sourceUrl) lines.push(`来源：${data.sourceUrl}`)
    if ('notes' in data) {
      lines.push(`备注${data.notesTruncated ? '（已截断）' : ''}：${data.notes || '暂无'}`)
    }
    return [{ type: 'text', text: lines.join('\n') }]
  }
  return unexpectedStructure('software')
}

/** Natural-language header for a list page. */
function listSummary(f, n) {
  const bits = []
  if (f.category) bits.push(f.category)
  if (f.text) bits.push(`和「${f.text}」有关`)
  if (f.status === 'retired') bits.push('已停用')
  const what = bits.length > 0 ? `${bits.join('、')}的` : ''
  return `${what}软件有 ${n} 个：`
}

/** One list row: the name, why it is there, and enough to act on it. */
function softwareLine(item) {
  const bits = []
  if (item.purpose) bits.push(`用途：${item.purpose}`)
  if (item.category) bits.push(item.category)
  if (item.version) bits.push(item.version)
  if (item.platform) bits.push(item.platform)
  if (item.status === 'retired') bits.push('已停用')
  return `- 《${item.name}》${bits.length > 0 ? `（${bits.join('，')}）` : ''}assetId=${item.assetId}`
}

/**
 * Creates the three tools. `getConfig` re-resolves the activation config per
 * call so settings writes take effect live.
 * @param {() => Record<string, unknown>} getConfig
 * @param {(databasePath?: string) => Promise<import('node:sqlite').DatabaseSync>} getLibrary
 */
export function createSoftwareTools(getConfig, getLibrary) {
  // The canonical value is genuinely polymorphic, so the output schema stays an
  // open object; the envelope contract is enforced by errors.js.
  const toolCommon = { output: toolOutput((args, value) => renderValue(args, value)) }

  const markTool = defineTool({
    name: 'software_mark',
    description:
      'Record or update one piece of software in your own hand-kept list: what it is for (purpose), its category, where it came from, and the version you noted. The purpose is the point — "装过什么" is trivia, "为什么装" is the record. Pass target {name} plus purpose to create. To update, target {assetId, expectedRevision} — there is no update-by-title here, because a tool name is not a unique key; find the id with software_list, which returns the revision too, so no separate get is needed. status in_use|retired keeps the purpose and notes when you stop using something. This list is only what you wrote down: it never scans the machine, installs, or uninstalls anything. Requires writes to be enabled in the plugin settings.',
    parameters: {
      target: {
        type: 'object',
        required: true,
        additionalProperties: false,
        description: 'Create: {name, purpose at the root}. Update: {assetId (UUID), expectedRevision}.',
        properties: {
          assetId: { type: 'string', description: 'Full UUID of the record to update.' },
          expectedRevision: { type: 'integer', description: 'Revision observed before this patch.' },
          name: { type: 'string', description: 'Create mode: the tool name, 1-200 chars.' },
        },
      },
      purpose: { type: 'string', description: 'Why you installed it, 1-2000 chars. Required on create.' },
      category: { type: 'string', description: 'Free-form category, 1-100 chars.' },
      sourceUrl: { type: 'string', description: 'Where it came from, 1-2000 chars.' },
      version: { type: 'string', description: 'The version you noted, 1-100 chars.' },
      platform: { type: 'string', description: 'Platform you used it on, 1-100 chars.' },
      status: { type: 'string', description: 'in_use (在用) | retired (已停用). Retiring keeps the purpose and notes.' },
      notes: { type: 'string', description: 'Short note, 1-2000 chars, no NUL. Replacing existing notes needs replaceNotes.' },
      replaceNotes: { type: 'boolean', description: 'Replace the existing note (only after the user confirmed).' },
      clear: {
        type: 'array',
        description: 'Update only: fields to empty. Any of category, purpose, sourceUrl, version, platform, notes.',
        items: { type: 'string', description: 'category | purpose | sourceUrl | version | platform | notes.' },
      },
    },
    ...toolCommon,
    async execute(args, exec) {
      if (exec.signal?.aborted) {
        return fail('CANCELLED', '这次记录在开始前就被取消了，资料库没有改动。')
      }
      const cfg = resolveConfig(getConfig())
      const notReady = ensureReady(cfg, { isWrite: true })
      if (notReady) return notReady
      const validation = validateMarkArgs(args)
      if (!validation.ok) return fail('INVALID_ARGUMENT', validation.message)
      const cmd = validation.value

      const db = await getLibrary(cfg.databasePath)
      const st = statements(db, buildStatements)

      return attemptSqlite(() =>
        inTransaction(db, () => {
          if (cmd.mode === 'create') {
            if (st.countByName.get(cmd.name).n > 0) {
              return fail(
                'TARGET_CONFLICT',
                `清单里已有《${cmd.name}》。当前不支持同名新建，请改用它的 assetId 更新。`,
                { candidates: [mapListItem(st.byName.get(cmd.name))] },
              )
            }
            const now = nowIso()
            const assetId = randomUUID()
            st.insert.run(
              assetId,
              cmd.name,
              cmd.category ?? null,
              cmd.purpose,
              cmd.sourceUrl ?? null,
              cmd.version ?? null,
              cmd.platform ?? null,
              cmd.notes ?? null,
              cmd.status ?? 'in_use',
              now,
              now,
            )
            const row = st.byId.get(assetId)
            recordChange(st.journal, st.journalTrim, {
              at: now,
              module: 'software',
              assetId,
              name: cmd.name,
              action: 'create',
              summary: changeSummary([
                ['用途', undefined, '已填写'],
                ...(cmd.category !== undefined ? [['类别', undefined, cmd.category]] : []),
                ...(cmd.version !== undefined ? [['版本', undefined, cmd.version]] : []),
                ...(cmd.platform !== undefined ? [['平台', undefined, cmd.platform]] : []),
                ['状态', undefined, STATUS_ZH[cmd.status ?? 'in_use'] ?? '在用'],
                ...(cmd.notes ? [['备注', undefined, '已填写']] : []),
              ]),
            })
            return ok({
              receipt: { assetId, outcome: 'created', revision: 1 },
              software: mapDetail(/** @type {any} */ (row), false),
            })
          }

          const row = st.byId.get(cmd.assetId)
          if (row === undefined) {
            return fail('NOT_FOUND', '没有找到这个 assetId 对应的记录。它可能已被删除，请先列表确认。')
          }
          if (row.revision !== cmd.expectedRevision) {
            return fail(
              'STALE_REVISION',
              '这个记录在你读取之后被改过了。请重新读取当前 revision 再提交。',
              { currentRevision: row.revision },
            )
          }
          const emptiesNotes = cmd.clear?.includes('notes') === true
          const hasNotes = typeof row.notes === 'string' && row.notes.length > 0
          if (
            hasNotes &&
            cmd.replaceNotes !== true &&
            ((cmd.notes !== undefined && cmd.notes !== row.notes) || emptiesNotes)
          ) {
            return fail(
              'CONFIRMATION_REQUIRED',
              emptiesNotes
                ? '这条记录已有备注，清空会让原文消失。请确认要清空（设 replaceNotes: true）还是保留。'
                : '这条记录已有备注，新备注和它不一样。请确认要替换（设 replaceNotes: true）还是保留原文。',
            )
          }
          const next = resolveUpdate(row, cmd)
          if (updateIsNoop(row, next)) {
            return ok({
              receipt: { assetId: row.id, outcome: 'unchanged', revision: row.revision },
              software: mapDetail(row, false),
            })
          }
          st.update.run(
            next.name,
            next.category,
            next.purpose,
            next.sourceUrl,
            next.version,
            next.platform,
            next.status,
            next.notes,
            nowIso(),
            row.id,
            row.revision,
          )
          const updated = st.byId.get(row.id)
          const at = nowIso()
          // The purpose is the module's whole point, but the journal keeps only
          // the fact it moved — the text lives in the record.
          recordChange(st.journal, st.journalTrim, {
            at,
            module: 'software',
            assetId: row.id,
            name: next.name,
            action: 'update',
            summary: changeSummary([
              textChange('用途', row.purpose, next.purpose),
              ['类别', row.category, next.category],
              textChange('来源', row.source_url, next.sourceUrl),
              ['版本', row.version, next.version],
              ['平台', row.platform, next.platform],
              ['状态', STATUS_ZH[row.status] ?? row.status, STATUS_ZH[next.status] ?? next.status],
              textChange('备注', row.notes, next.notes),
            ]),
          })
          return ok({
            receipt: { assetId: row.id, outcome: 'updated', revision: /** @type {any} */ (updated).revision },
            software: mapDetail(/** @type {any} */ (updated), false),
          })
        }),
      )
    },
  })

  const listTool = defineTool({
    name: 'software_list',
    description:
      'List your hand-kept software records without knowing a name: what you installed a PDF tool for, what you used to handle subtitles, what you have retired. `text` searches the name, category, purpose and notes together — the purpose is where the answer usually lives. status defaults to in_use, so retired records stay hidden unless you ask for retired or all. Returns whitelisted summaries with assetId for follow-up marks. An empty page is a success; total is null when the window was not exhausted.',
    parameters: {
      name: { type: 'string', description: 'Substring of the tool name, 1-200 chars.' },
      text: { type: 'string', description: 'Substring searched across name, category, purpose and notes, 1-200 chars.' },
      category: { type: 'string', description: 'Substring of the category, 1-100 chars.' },
      status: { type: 'string', description: 'in_use (default, hides retired) | retired | all.' },
      limit: { type: 'integer', description: 'Page size, 1-20, default 10.' },
      offset: { type: 'integer', description: 'Page offset, 0-1000, default 0.' },
    },
    ...toolCommon,
    async execute(args, exec) {
      if (exec.signal?.aborted) {
        return fail('CANCELLED', '这次查询在开始前就被取消了。')
      }
      const cfg = resolveConfig(getConfig())
      const notReady = ensureReady(cfg, { isWrite: false })
      if (notReady) return notReady
      const validation = validateListArgs(args)
      if (!validation.ok) return fail('INVALID_ARGUMENT', validation.message)
      const q = validation.value
      const db = await getLibrary(cfg.databasePath)
      const st = statements(db, buildStatements)
      const filters = {
        status: q.status,
        name: q.name === null ? null : likePattern(q.name),
        category: q.category === null ? null : likePattern(q.category),
        text: q.text === null ? null : likePattern(q.text),
      }
      const page = attemptSqlite(() => {
        const items = st.list.all({ ...filters, limit: q.limit, offset: q.offset }).map(mapListItem)
        const matched = st.listCount.get(filters).n
        const exhausted = q.offset + items.length >= matched
        return {
          items,
          offset: q.offset,
          limit: q.limit,
          total: exhausted ? matched : null,
          filters: { name: q.name, text: q.text, category: q.category, status: q.status },
        }
      })
      if (isFail(page)) return page
      return ok(page)
    },
  })

  const getTool = defineTool({
    name: 'software_get',
    description:
      'Read one software record from your own list by full UUID: revision, purpose, category, source URL, the version you noted, the platform, and status. Use it to read back after a mark, or when you need a field a list row does not carry — software_list already returns the revision, so an update needs no separate read. A record being in this list says nothing about what is installed on any machine.',
    parameters: {
      assetId: { type: 'string', required: true, description: 'Full UUID of the record.' },
      includeNotes: { type: 'boolean', description: 'Include the note (max 2000 chars, truncated with notesTruncated). Default false.' },
    },
    ...toolCommon,
    async execute(args, exec) {
      if (exec.signal?.aborted) {
        return fail('CANCELLED', '这次查询在开始前就被取消了。')
      }
      const cfg = resolveConfig(getConfig())
      const notReady = ensureReady(cfg, { isWrite: false })
      if (notReady) return notReady
      const validation = validateGetArgs(args)
      if (!validation.ok) return fail('INVALID_ARGUMENT', validation.message)
      const db = await getLibrary(cfg.databasePath)
      const st = statements(db, buildStatements)
      const result = attemptSqlite(() => {
        const row = st.byId.get(validation.value.assetId)
        if (row === undefined) {
          return fail('NOT_FOUND', '没有找到这个 assetId 对应的记录。它可能已被删除，请先列表确认。')
        }
        return ok(mapDetail(row, validation.value.includeNotes))
      })
      return result
    },
  })

  return [markTool, listTool, getTool]
}
