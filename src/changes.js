// The one cross-module tool: media_log_changes reads the journal the other
// three modules write. It has no writes of its own, so it needs no revision
// guard and no confirmation — it is a read over derived data.
//
// What it deliberately is NOT: an event log. Rows start when the feature
// landed, the oldest fall off the CHANGE_CAP, and each row is one line —
// enough to answer "我上次改了什么", not enough to replay anything.

import { defineTool } from '@deepseek-ai/dsh-tools'
import { statementCache, CHANGE_CAP } from './db.js'
import { ok, fail, attemptSqlite, isFail } from './errors.js'
import { resolveConfig, ensureReady } from './config.js'
import { toolOutput, unexpectedStructure, pageBounds } from './toolkit.js'

const MODULES = ['media', 'subscription', 'software']
const MODULE_ZH = { media: '媒体', subscription: '订阅', software: '软件' }

/** This module's own statement cache — see statementCache() for why it is not shared. */
const statements = statementCache()

/**
 * @param {import('node:sqlite').DatabaseSync} db
 */
function buildStatements(db) {
  const WHERE = ` WHERE (:module IS NULL OR module = :module)`
  const COLUMNS = `id, at, module, asset_id, name, action, summary`
  return {
    list: db.prepare(`SELECT ${COLUMNS} FROM changes${WHERE} ORDER BY id DESC LIMIT :limit OFFSET :offset`),
    count: db.prepare(`SELECT count(*) AS n FROM changes${WHERE}`),
  }
}

/**
 * '2026-11-12T12:31:05.123Z' → '11-12 20:31', in the machine's zone. The
 * journal is for the user looking at a phone, so it shows local wall time.
 * @param {unknown} at
 */
function whenText(at) {
  const d = new Date(String(at))
  if (Number.isNaN(d.getTime())) return String(at)
  const two = (n) => String(n).padStart(2, '0')
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}

/**
 * @param {unknown} args
 * @returns {{ok: true, value: {module: string|null, limit: number, offset: number}} | {ok: false, message: string}}
 */
function validateArgs(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, message: '参数必须是一个对象。' }
  }
  const a = /** @type {Record<string, unknown>} */ (args)
  for (const key of Object.keys(a)) {
    if (!['module', 'limit', 'offset'].includes(key)) {
      return { ok: false, message: `未知参数字段 ${key}。` }
    }
  }
  /** @type {{module: string|null, limit: number, offset: number}} */
  const value = { module: null, limit: 10, offset: 0 }
  if (a.module !== undefined) {
    if (typeof a.module !== 'string' || !MODULES.includes(a.module)) {
      return { ok: false, message: 'module 只接受 media、subscription、software。' }
    }
    value.module = a.module
  }
  const page = pageBounds(a)
  if (!page.ok) return page
  value.limit = page.limit
  value.offset = page.offset
  return { ok: true, value }
}

/** One journal line. Creates keep their initial values, updates show moves. */
function changeLine(row) {
  const module = MODULE_ZH[String(row.module)] ?? String(row.module)
  const what =
    row.action === 'create'
      ? String(row.summary ? `新建（${row.summary}）` : '新建')
      : String(row.summary || '更新')
  return `- ${whenText(row.at)} 《${row.name}》（${module}）${what}`
}

/**
 * @param {unknown} args
 * @param {unknown} value
 * @returns {Array<{type: string, text: string}>}
 */
function renderValue(args, value) {
  const v = /** @type {any} */ (value)
  if (!v || typeof v !== 'object' || !('ok' in v)) return unexpectedStructure('media_log_changes')
  if (v.ok !== true) {
    return [{ type: 'text', text: `未完成 [${v.error?.code}]：${v.error?.message ?? '未知错误'}` }]
  }
  const data = v.data
  if (data.items.length === 0) {
    const overrun = typeof data.offset === 'number' && data.offset > 0
    return [
      {
        type: 'text',
        text: overrun
          ? '这一页是空的——offset 已经越过末页。'
          : '改动日志还是空的。它从装上这一版才开始记，之前的改动不回填。',
      },
    ]
  }
  const lines = [`最近的改动有 ${data.items.length} 条${data.filters.module ? `（只看${MODULE_ZH[data.filters.module] ?? data.filters.module}）` : ''}：`]
  for (const row of data.items) lines.push(changeLine(row))
  if (data.total === null) {
    lines.push('结果未穷尽，可继续翻页（把 offset 加上一页的 limit）。')
  }
  lines.push(`日志只保留最近 ${CHANGE_CAP} 条，更早的已滚动清除；媒体、订阅和软件的当前状态用对应模块的 _get 查看。`)
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * @param {() => Record<string, unknown>} getConfig
 * @param {(databasePath?: string) => Promise<import('node:sqlite').DatabaseSync>} getLibrary
 */
export function createChangesTool(getConfig, getLibrary) {
  const changesTool = defineTool({
    name: 'media_log_changes',
    description:
      'List what this plugin actually wrote recently, across its three modules (media, subscriptions, software): creates, updates, archives and retires, one line each with the fields that moved. The journal starts when this feature landed — earlier changes are NOT backfilled — and only the most recent 500 writes are kept, so it answers "what did I change lately", not "full history". Re-submitting an identical patch records nothing. Long text is represented only by the fact that it changed.',
    parameters: {
      module: { type: 'string', description: 'media | subscription | software. Omit for all.' },
      limit: { type: 'integer', description: 'Page size, 1-20, default 10.' },
      offset: { type: 'integer', description: 'Page offset, 0-1000, default 0.' },
    },
    output: toolOutput(renderValue),
    async execute(args, exec) {
      if (exec.signal?.aborted) {
        return fail('CANCELLED', '这次查询在开始前就被取消了。')
      }
      const cfg = resolveConfig(getConfig())
      const notReady = ensureReady(cfg, { isWrite: false })
      if (notReady) return notReady
      const validation = validateArgs(args)
      if (!validation.ok) return fail('INVALID_ARGUMENT', validation.message)
      const q = validation.value
      const db = await getLibrary(cfg.databasePath)
      const st = statements(db, buildStatements)
      const filters = { module: q.module }
      const page = attemptSqlite(() => {
        const items = st.list.all({ ...filters, limit: q.limit, offset: q.offset })
        const matched = st.count.get(filters).n
        const exhausted = q.offset + items.length >= matched
        return {
          items,
          offset: q.offset,
          limit: q.limit,
          total: exhausted ? matched : null,
          filters: { module: q.module },
        }
      })
      if (isFail(page)) return page
      return ok(page)
    },
  })
  return [changesTool]
}
