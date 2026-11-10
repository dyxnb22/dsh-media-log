// The three tools over the plugin's own SQLite library. Thin host layer:
// validation lives in lib/media.js, storage in lib/db.js, and the outcome
// envelope in lib/errors.js. Domain outcomes — including every expected
// failure — are canonical VALUES; only plugin bugs throw.
//
// There is no subprocess here, so none of the machinery that used to surround
// these tools survives: no CLI probe, no argv building, no output caps, no
// kill escalation, no cross-process write queue, no read gate, and no
// tool-wide deadline — a synchronous statement cannot overrun a budget, and
// `exec.signal` is honored once at entry instead.

import { defineTool } from '@deepseek-ai/dsh-tools'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { openLibrary, resolveDatabasePath, inTransaction } from './db.js'
import { ok, fail, sqliteErrorToValue } from './errors.js'
import { resolveConfig } from './config.js'
import {
  validateMarkArgs,
  validateSearchArgs,
  validateGetArgs,
  mapCandidate,
  mapDetail,
  classifyCandidates,
} from './media.js'

/** mediaType → 中文 label for render text. */
const MEDIA_TYPE_ZH = { movie: '电影', tv: '剧集', anime: '动画', game: '游戏' }
const STATUS_ZH = {
  in_progress: '在看/在玩',
  completed: '已看完/玩完',
  planned: '想看/想玩',
  paused: '搁置',
  dropped: '弃了',
}

/** star rating (0..10 → 0..5 for render text). */
function stars(rating) {
  return `${rating / 2} 星`
}

/** ISO-8601 with offset, so imported and new timestamps sort alike. */
function nowIso() {
  return new Date().toISOString()
}

/** @returns {boolean} true when a value is a tool failure envelope */
function isFail(value) {
  return typeof value === 'object' && value !== null && /** @type {any} */ (value).ok === false
}

/**
 * Opens the library once per Host and reuses the connection. The config is
 * re-resolved per tool call, so a settings write takes effect live — but a
 * changed databasePath must reopen, which is why the path is the cache key.
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
    if (current !== null && current.path === path) return current.db
    if (opening !== null) {
      const db = await opening
      if (resolveDatabasePath(databasePath) === path) return db
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
 * Runs one storage operation, mapping a domain rejection onto a tool value.
 * @template T
 * @param {() => T} fn
 * @returns {T | ReturnType<typeof fail>}
 */
function attempt(fn) {
  try {
    return fn()
  } catch (error) {
    return sqliteErrorToValue(error)
  }
}

/** Escapes LIKE wildcards so a query containing % or _ matches literally. */
function likePattern(query) {
  return `%${query.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`
}

/**
 * True when the patch would leave every stored field exactly as it is — an
 * identical patch must not bump the revision.
 */
function patchIsNoop(row, patch) {
  return (
    (patch.status === undefined || patch.status === row.status) &&
    (patch.rating === undefined || patch.rating === row.rating) &&
    (patch.current === undefined || patch.current === row.progress_current) &&
    (patch.total === undefined || patch.total === row.progress_total) &&
    (patch.unit === undefined || patch.unit === row.progress_unit) &&
    (patch.notes === undefined || patch.notes === row.notes)
  )
}

/** Prepared statements, rebuilt per call (cheap, and the db may be reopened). */
function statements(db) {
  return {
    search: db.prepare(
      `SELECT id, title, media_type, year, status, lifecycle FROM media
       WHERE title LIKE ? ESCAPE '\\'
       ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
    ),
    count: db.prepare(`SELECT count(*) AS n FROM media WHERE title LIKE ? ESCAPE '\\'`),
    byId: db.prepare(`SELECT * FROM media WHERE id = ?`),
    insert: db.prepare(
      `INSERT INTO media (id, title, media_type, year, status, rating,
         progress_current, progress_total, progress_unit, notes,
         revision, started_at, completed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    ),
    update: db.prepare(
      `UPDATE media SET title = ?, media_type = ?, year = ?, status = ?, rating = ?,
         progress_current = ?, progress_total = ?, progress_unit = ?, notes = ?,
         revision = revision + 1, updated_at = ?
       WHERE id = ? AND revision = ?`,
    ),
  }
}

/**
 * Model-facing render text (pure: a function of args + canonical value).
 * @param {unknown} args original tool arguments
 * @param {unknown} value canonical tool value
 * @returns {string[]}
 */
function renderValue(args, value) {
  const v = /** @type {any} */ (value)
  if (!v || typeof v !== 'object' || !('ok' in v)) {
    return [{ type: 'text', text: 'media_log 工具返回了意外结构。' }]
  }
  if (v.ok !== true) {
    const lines = [`未完成 [${v.error?.code}]：${v.error?.message ?? '未知错误'}`]
    if (v.error?.currentRevision !== undefined) {
      lines.push(`这个条目现在已经是 revision ${v.error.currentRevision}，请重新读取后再改。`)
    }
    if (Array.isArray(v.error?.candidates) && v.error.candidates.length > 0) {
      lines.push('可能匹配的条目：')
      for (const item of v.error.candidates) {
        const year = item.year ? `${item.year}年` : ''
        const lifecycle = item.lifecycle === 'archived' ? '，已归档' : ''
        lines.push(`- 《${item.title}》（${year}${MEDIA_TYPE_ZH[item.mediaType] ?? item.mediaType}${lifecycle}）assetId=${item.assetId}`)
      }
      lines.push('回复想用哪一个，或确认要新建。')
    }
    return [{ type: 'text', text: lines.join('\n') }]
  }

  const data = v.data ?? {}
  if (data.receipt) {
    const receipt = data.receipt
    const argsTarget = /** @type {any} */ (args)?.target ?? {}
    const title = data.media?.title ?? argsTarget.title ?? ''
    if (receipt.outcome === 'unchanged') {
      return [{ type: 'text', text: `没有变化：记录已是所描述的状态（assetId=${receipt.assetId}，revision=${receipt.revision}）。` }]
    }
    const verb = receipt.outcome === 'created' ? '已记下' : '已更新'
    const detail = data.media ?? {}
    const parts = [`${verb}《${detail.title ?? title}》`]
    if (detail.status) parts.push(STATUS_ZH[detail.status] ?? detail.status)
    if (typeof detail.rating === 'number') parts.push(stars(detail.rating))
    if (detail.hasNotes) parts.push('短评已保存')
    const readBackNote = data.readBack === 'superseded' ? '；注意这之后还有别的修改。' : ''
    return [
      {
        type: 'text',
        text: `${parts.join('，')}。（assetId=${receipt.assetId}，revision=${receipt.revision}）${readBackNote}`,
      },
    ]
  }
  if (Array.isArray(data.items)) {
    if (data.items.length === 0) {
      return [{ type: 'text', text: '资料库里没有找到匹配的记录。' }]
    }
    const lines = [`找到 ${data.items.length} 条候选${data.total === null ? '（结果未穷尽）' : `，共 ${data.total} 条`}：`]
    for (const item of data.items) {
      const year = item.year ? `${item.year}年` : ''
      const status = item.status ? (STATUS_ZH[item.status] ?? item.status) : ''
      lines.push(`- 《${item.title}》（${year}${MEDIA_TYPE_ZH[item.mediaType] ?? item.mediaType}${status ? `，${status}` : ''}）assetId=${item.assetId}${item.lifecycle === 'archived' ? '，已归档' : ''}`)
    }
    return [{ type: 'text', text: lines.join('\n') }]
  }
  if (data.assetId) {
    const parts = [`《${data.title}》`]
    if (data.status) parts.push(STATUS_ZH[data.status] ?? data.status)
    if (typeof data.rating === 'number') parts.push(stars(data.rating))
    if (data.progress && data.progress.current !== null) {
      const total = data.progress.total !== null ? `/${data.progress.total}` : ''
      parts.push(`进度 ${data.progress.current}${total}${data.progress.unit ?? ''}`)
    }
    return [
      {
        type: 'text',
        text: `${parts.join('，')}（assetId=${data.assetId}，revision=${data.revision}，${data.lifecycle === 'archived' ? '已归档' : '活跃'}）。`,
      },
    ]
  }
  return [{ type: 'text', text: 'media_log 工具返回了意外结构。' }]
}

/**
 * Creates the three tools. `getConfig` re-resolves the activation config per
 * call so settings writes take effect live (paste-dock pattern).
 * @param {() => Record<string, unknown>} getConfig
 * @param {(databasePath?: string) => Promise<import('node:sqlite').DatabaseSync>} getLibrary
 */
export function createTools(getConfig, getLibrary) {
  const toolCommon = {
    // The canonical value is genuinely polymorphic ({ok,data}|{ok,error}),
    // so the output schema stays an open object (additionalProperties:true —
    // the value-schema compiler requires the key to be explicit); the
    // envelope contract itself is enforced by errors.js.
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        description: '{ok:true, data} on success; {ok:false, error:{code, message, currentRevision?, candidates?}} on an expected failure.',
      },
      render: (args, value) => renderValue(args, value),
    },
  }

  /** Config readiness: an explicit path must be absolute, writes need the gate. */
  function ensureReady(cfg, { isWrite }) {
    // A relative path would silently resolve against the Host process cwd.
    if (cfg.databasePath !== '' && !isAbsolute(cfg.databasePath)) {
      return fail(
        'CONFIG_REQUIRED',
        'databasePath 需要是绝对路径；留空则用默认位置 ~/.dsh/media-log/media.db。',
      )
    }
    if (isWrite && !cfg.writeEnabled) {
      return fail('WRITE_DISABLED', '写入未开启。需要在 Mac 上打开插件的 writeEnabled 设置后才能记录。')
    }
    return null
  }

  const markTool = defineTool({
    name: 'media_log_mark',
    description:
      'Record or update one media entry in your local library: watching/finished status, rating (0-10 = five stars x2), absolute progress, and a short review. Pass target {title, mediaType} to create, or target {assetId, expectedRevision} (revision observed via media_log_get) to update. Omitted fields keep their stored values. Requires writes to be enabled in the plugin settings.',
    parameters: {
      target: {
        type: 'object',
        required: true,
        additionalProperties: false,
        description: 'Update: {assetId (UUID), expectedRevision}. Create: {title, mediaType, year?}.',
        properties: {
          assetId: { type: 'string', description: 'Full UUID of the record to update.' },
          expectedRevision: { type: 'integer', description: 'Revision observed before this patch.' },
          title: { type: 'string', description: 'Create mode: exact work title, 1-300 chars.' },
          mediaType: { type: 'string', description: 'Create mode: movie | tv | anime | game.' },
          year: { type: 'integer', description: 'Create mode: release year 1850-2100.' },
        },
      },
      status: { type: 'string', description: 'in_progress (在看/在玩) or completed (看完/玩完).' },
      rating: { type: 'number', description: '0..10 scale (five stars multiplied by 2: 4 stars = 8).' },
      progress: {
        type: 'object',
        additionalProperties: false,
        description: 'Absolute progress patch; omitted fields keep stored values.',
        properties: {
          current: { type: 'number', description: 'Current absolute value, >= 0.' },
          total: { type: 'number', description: 'Total, > 0.' },
          unit: { type: 'string', description: 'Unit label, 1-32 chars.' },
        },
      },
      notes: { type: 'string', description: 'Short review, 1-2000 chars, no NUL. Replacing existing notes needs replaceNotes.' },
      replaceNotes: { type: 'boolean', description: 'Replace the existing short review (only after the user confirmed).' },
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
      const st = statements(db)

      // 新建前先搜一次：发现可能是同一作品的条目就停下，让用户选择，
      // 避免顺次新建重复作品。
      if (cmd.mode === 'create') {
        const page = attempt(() => st.search.all(likePattern(cmd.title), 10, 0).map(mapCandidate))
        if (isFail(page)) return page
        const verdict = classifyCandidates(/** @type {any} */ (page), cmd.title)
        if (verdict.kind !== 'none') {
          return fail(
            'TARGET_CONFLICT',
            verdict.kind === 'unique'
              ? `资料库里已有《${verdict.candidate.title}》（${MEDIA_TYPE_ZH[verdict.candidate.mediaType] ?? ''}），可能是同一作品。请确认要更新它还是新建。`
              : '资料库里有多条可能匹配的条目，请选择一个或确认新建。',
            { candidates: verdict.candidates },
          )
        }
      }

      const patch = {
        status: cmd.status,
        rating: cmd.rating,
        current: cmd.progress?.current,
        total: cmd.progress?.total,
        unit: cmd.progress?.unit,
        notes: cmd.notes,
      }

      // Read-compare-write in ONE transaction, so a concurrent writer cannot
      // slip between the comparison and the update. Everything inside returns
      // a tool value; only a thrown SQLite error becomes a failure here.
      return attempt(() =>
        inTransaction(db, () => {
          if (cmd.mode === 'create') {
            const now = nowIso()
            const assetId = randomUUID()
            st.insert.run(
              assetId,
              cmd.title,
              cmd.mediaType,
              cmd.year ?? null,
              cmd.status,
              cmd.rating ?? null,
              cmd.progress?.current ?? null,
              cmd.progress?.total ?? null,
              cmd.progress?.unit ?? null,
              cmd.notes ?? null,
              cmd.status === 'in_progress' ? now : null,
              cmd.status === 'completed' ? now : null,
              now,
              now,
            )
            const row = st.byId.get(assetId)
            return ok({
              receipt: { assetId, outcome: 'created', revision: 1 },
              media: mapDetail(/** @type {any} */ (row), false),
            })
          }

          const row = st.byId.get(cmd.assetId)
          if (row === undefined) {
            return fail('NOT_FOUND', '没有找到这个 assetId 对应的记录。它可能已被删除，请先搜索确认。')
          }
          if (row.revision !== cmd.expectedRevision) {
            return fail(
              'STALE_REVISION',
              '这个记录在你读取之后被改过了。请重新读取当前 revision 再提交。',
              { currentRevision: row.revision },
            )
          }
          // A different review never replaces an existing one silently.
          if (
            cmd.notes !== undefined &&
            cmd.replaceNotes !== true &&
            typeof row.notes === 'string' &&
            row.notes !== cmd.notes
          ) {
            return fail(
              'CONFIRMATION_REQUIRED',
              '这条记录已有短评，新短评和它不一样。请确认要替换（设 replaceNotes: true）还是保留原文。',
            )
          }
          if (patchIsNoop(row, patch)) {
            return ok({
              receipt: { assetId: row.id, outcome: 'unchanged', revision: row.revision },
              media: mapDetail(row, false),
            })
          }
          const now = nowIso()
          st.update.run(
            row.title,
            row.media_type,
            row.year,
            cmd.status ?? row.status,
            cmd.rating ?? row.rating,
            cmd.progress?.current ?? row.progress_current,
            cmd.progress?.total ?? row.progress_total,
            cmd.progress?.unit ?? row.progress_unit,
            cmd.notes ?? row.notes,
            now,
            row.id,
            row.revision,
          )
          const updated = st.byId.get(row.id)
          return ok({
            receipt: { assetId: row.id, outcome: 'updated', revision: /** @type {any} */ (updated).revision },
            media: mapDetail(/** @type {any} */ (updated), false),
          })
        }),
      )
    },
  })

  const searchTool = defineTool({
    name: 'media_log_search',
    description:
      'Search your media records (movies, TV, anime, games), including archived ones. Returns whitelisted candidate summaries with assetId — use the returned assetId for updates. An empty page is a success; total may be null when the search window was not exhausted.',
    parameters: {
      query: { type: 'string', required: true, description: 'Search text, 1-300 chars (CJK supported).' },
      limit: { type: 'integer', description: 'Page size, 1-20, default 10.' },
      offset: { type: 'integer', description: 'Page offset, 0-1000, default 0.' },
    },
    ...toolCommon,
    async execute(args, exec) {
      if (exec.signal?.aborted) {
        return fail('CANCELLED', '这次查询在开始前就被取消了。')
      }
      const cfg = resolveConfig(getConfig())
      const validation = validateSearchArgs(args)
      if (!validation.ok) return fail('INVALID_ARGUMENT', validation.message)
      const db = await getLibrary(cfg.databasePath)
      const st = statements(db)
      const pattern = likePattern(validation.value.query)
      const page = attempt(() => {
        const items = st.search
          .all(pattern, validation.value.limit, validation.value.offset)
          .map(mapCandidate)
        const matched = st.count.get(pattern).n
        // total: null 表示搜索窗口未穷尽，不能充当唯一性证明。
        const exhausted = validation.value.offset + items.length >= matched
        return {
          items,
          offset: validation.value.offset,
          limit: validation.value.limit,
          total: exhausted ? matched : null,
        }
      })
      if (isFail(page)) return page
      return ok(page)
    },
  })

  const getTool = defineTool({
    name: 'media_log_get',
    description:
      'Read one media record from your local library by full UUID: revision, status, rating, progress, timestamps, lifecycle. Use it to observe the current revision before updating, and to read back after a mark. Archived records are readable and marked lifecycle=archived.',
    parameters: {
      assetId: { type: 'string', required: true, description: 'Full UUID of the record.' },
      includeNotes: { type: 'boolean', description: 'Include the short review (max 2000 chars, truncated with notesTruncated). Default false.' },
    },
    ...toolCommon,
    async execute(args, exec) {
      if (exec.signal?.aborted) {
        return fail('CANCELLED', '这次查询在开始前就被取消了。')
      }
      const cfg = resolveConfig(getConfig())
      const validation = validateGetArgs(args)
      if (!validation.ok) return fail('INVALID_ARGUMENT', validation.message)
      const db = await getLibrary(cfg.databasePath)
      const st = statements(db)
      const result = attempt(() => {
        const row = st.byId.get(validation.value.assetId)
        if (row === undefined) {
          return fail('NOT_FOUND', '没有找到这个 assetId 对应的记录。它可能已被删除，请先搜索确认。')
        }
        return ok(mapDetail(row, validation.value.includeNotes))
      })
      return result
    },
  })

  return [markTool, searchTool, getTool]
}
