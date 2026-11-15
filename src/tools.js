// The four media tools over the plugin's own SQLite library. Thin host layer:
// validation lives in media.js, storage in db.js, and the outcome
// envelope in errors.js. Domain outcomes — including every expected
// failure — are canonical VALUES; only plugin bugs throw.
//
// There is no subprocess here, so none of the machinery that used to surround
// these tools survives: no CLI probe, no argv building, no output caps, no
// kill escalation, no cross-process write queue, no read gate, and no
// tool-wide deadline — synchronous SQLite calls can block on locks or I/O,
// and `exec.signal` is honored once at entry instead.

import { defineTool } from '@deepseek-ai/dsh-tools'
import { randomUUID } from 'node:crypto'
import {
  inTransaction,
  statementCache,
  nowIso,
  likePattern,
  CHANGE_CAP,
} from './db.js'
import { ok, fail, attemptSqlite, isFail } from './errors.js'
import { resolveConfig, ensureReady } from './config.js'
import { toolOutput, unexpectedStructure, renderFailure, unchangedReceipt, changeSummary, textChange, recordChange, validateGetArgs } from './toolkit.js'
import {
  validateMarkArgs,
  validateSearchArgs,
  validateListArgs,
  validatePickArgs,
  pickCandidates,
  mapCandidate,
  mapListItem,
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

/**
 * Progress → '进度 3/50小时' / '总进度 50小时' / ''. Shared by the detail and
 * the list render so the two never drift apart.
 * @param {any} p
 */
function progressText(p) {
  if (!p) return ''
  if (p.current !== null && p.current !== undefined) {
    const total = p.total !== null && p.total !== undefined ? `/${p.total}` : ''
    return `进度 ${p.current}${total}${p.unit ?? ''}`
  }
  if (p.total !== null && p.total !== undefined) return `总进度 ${p.total}${p.unit ?? ''}`
  return ''
}

/**
 * Status label for a known media type, so a game reads "在玩的游戏" rather
 * than the type-agnostic "在看/在玩的游戏".
 * @param {string} status
 * @param {string|null} mediaType
 */
function statusLabel(status, mediaType) {
  if (status === 'in_progress') return mediaType === 'game' ? '在玩' : '在看'
  if (status === 'completed') return mediaType === 'game' ? '玩完' : '看完'
  if (status === 'planned') return mediaType === 'game' ? '想玩' : '想看'
  return STATUS_ZH[status] ?? status
}

/**
 * One-line summary of what a list was asked for. Deliberately answers the
 * question ("在玩的游戏有 2 个") instead of reporting a retrieval ("找到 2 条
 * 候选"), because the list exists to be read as an answer.
 * @param {{mediaType?: string|null, status?: string|null, lifecycle?: string}} f
 * @param {number} n
 */
function listSummary(f, n) {
  const type = f.mediaType ? (MEDIA_TYPE_ZH[f.mediaType] ?? f.mediaType) : null
  if (f.status) {
    const label = type ? statusLabel(f.status, f.mediaType ?? null) : (STATUS_ZH[f.status] ?? f.status)
    return `${label}的${type ?? '记录'}有 ${n} 个：`
  }
  return `资料库里${type ? `的${type}` : ''}有 ${n} 个：`
}

/** Says which lifecycle window produced the page — the default is invisible. */
function listScope(lifecycle) {
  if (lifecycle === 'archived') return '（只看已归档）'
  if (lifecycle === 'all') return '（含已归档）'
  return ''
}

/** One list row: enough to recognize it and to act on it. */
function listItemLine(item) {
  const year = item.year ? `${item.year}年` : ''
  const type = MEDIA_TYPE_ZH[item.mediaType] ?? item.mediaType
  const status = item.status ? `，${statusLabel(item.status, item.mediaType)}` : ''
  const rating = typeof item.rating === 'number' ? `，${stars(item.rating)}` : ''
  const progress = progressText(item.progress)
  const archived = item.lifecycle === 'archived' ? '，已归档' : ''
  return `- 《${item.title}》（${year}${type}${status}${rating}${progress ? `，${progress}` : ''}${archived}）assetId=${item.assetId}`
}

/**
 * Resolves the next state of every writable column of an update: the patch
 * applied on top of the stored row, with `clear` emptying what it names.
 *
 * Resolving first and comparing afterwards is what makes "the same patch
 * changes nothing" a property of the RESULT rather than of the argument shape —
 * so `rating: 8` on a row already rated 8, and `clear: ['rating']` on a row
 * with no rating, are both no-ops.
 * @param {Record<string, any>} row
 * @param {ReturnType<typeof validateMarkArgs> extends {ok: true, value: infer V} ? V : never} cmd
 * @returns {Record<string, any>} every column the update statement writes
 */
function resolveUpdate(row, cmd) {
  const clearing = new Set(cmd.clear ?? [])
  const now = nowIso()
  const statusChanged = cmd.status !== undefined && cmd.status !== row.status
  return {
    title: cmd.metadata?.title ?? row.title,
    mediaType: cmd.metadata?.mediaType ?? row.media_type,
    year: clearing.has('year') ? null : (cmd.metadata?.year ?? row.year),
    status: cmd.status ?? row.status,
    rating: clearing.has('rating') ? null : (cmd.rating ?? row.rating),
    progressCurrent: clearing.has('progress') ? null : (cmd.progress?.current ?? row.progress_current),
    progressTotal: clearing.has('progress') ? null : (cmd.progress?.total ?? row.progress_total),
    progressUnit: clearing.has('progress') ? null : (cmd.progress?.unit ?? row.progress_unit),
    notes: clearing.has('notes') ? null : (cmd.notes ?? row.notes),
    // Archiving stamps the moment it happened; restoring clears it, so a
    // restored record does not carry a stale archive date into backups.
    lifecycle: cmd.lifecycle ?? row.lifecycle,
    archivedAt:
      cmd.lifecycle === undefined || cmd.lifecycle === row.lifecycle
        ? row.archived_at
        : cmd.lifecycle === 'archived'
          ? now
          : null,
    // Record the first known start/completion when the status changes.
    // Imported dates survive rewatching, and unrelated patches never invent
    // historical dates for imported records.
    startedAt:
      statusChanged && cmd.status === 'in_progress' ? (row.started_at ?? now) : row.started_at,
    completedAt:
      statusChanged && cmd.status === 'completed' ? (row.completed_at ?? now) : row.completed_at,
  }
}

/** True when a resolved update would leave every stored column exactly as is. */
function updateIsNoop(row, next) {
  return (
    next.title === row.title &&
    next.mediaType === row.media_type &&
    next.year === row.year &&
    next.status === row.status &&
    next.rating === row.rating &&
    next.progressCurrent === row.progress_current &&
    next.progressTotal === row.progress_total &&
    next.progressUnit === row.progress_unit &&
    next.notes === row.notes &&
    next.lifecycle === row.lifecycle &&
    next.archivedAt === row.archived_at &&
    next.startedAt === row.started_at &&
    next.completedAt === row.completed_at
  )
}

/** This module's own statement cache — see statementCache() for why it is not shared. */
const statements = statementCache()

/**
 * Prepared statements for one open library. Keyed to the handle by a WeakMap,
 * so a reopened library gets a fresh set and a closed one is collected.
 * @param {import('node:sqlite').DatabaseSync} db
 */
function buildStatements(db) {
  // One WHERE shared by the page and its count, written with named parameters:
  // `:mediaType IS NULL OR media_type = :mediaType` lets an absent filter pass
  // through, and `lifecycle = :lifecycle OR :lifecycle = 'all'` turns 'all'
  // into "no filter". The date bounds go through julianday() — never text —
  // because imported rows spell the same instant `...+00:00` while new rows
  // spell it `...Z`. julianday(NULL) is NULL, so a record without completed_at
  // simply fails both comparisons and drops out of the range, which is the
  // intent.
  const LIST_WHERE = `
    WHERE (lifecycle = :lifecycle OR :lifecycle = 'all')
      AND (:mediaType IS NULL OR media_type = :mediaType)
      AND (:status IS NULL OR status = :status)
      AND (:from IS NULL OR julianday(completed_at) >= julianday(:from))
      AND (:to IS NULL OR julianday(completed_at) < julianday(:to))`
  // The id tiebreak is load-bearing, not cosmetic: imported libraries share
  // one updated_at across hundreds of rows, so without it page order — and
  // therefore which rows a later page contains — is not stable.
  const LIST_ORDER = ' ORDER BY updated_at DESC, id DESC LIMIT :limit OFFSET :offset'
  const LIST_COLUMNS = `id, title, media_type, year, status, lifecycle, rating,
       progress_current, progress_total, progress_unit`
  return {
    search: db.prepare(
      `SELECT id, title, media_type, year, status, lifecycle FROM media
       WHERE title LIKE ? ESCAPE '\\'
       ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
    ),
    count: db.prepare(`SELECT count(*) AS n FROM media WHERE title LIKE ? ESCAPE '\\'`),
    // A small personal library can check every summary using the same JS title
    // normalization as classifyCandidates (including Unicode). Search's page
    // limit must never decide whether an exact title already exists.
    candidates: db.prepare(`SELECT id, title, media_type, year, status, lifecycle FROM media ORDER BY updated_at DESC`),
    byId: db.prepare(`SELECT * FROM media WHERE id = ?`),
    // node:sqlite rejects unknown named parameters, so the page and the count
    // each get exactly the keys their own SQL mentions.
    list: db.prepare(`SELECT ${LIST_COLUMNS} FROM media${LIST_WHERE}${LIST_ORDER}`),
    listCount: db.prepare(`SELECT count(*) AS n FROM media${LIST_WHERE}`),
    journal: db.prepare(
      `INSERT INTO changes (at, module, asset_id, name, action, summary)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    journalTrim: db.prepare(
      `DELETE FROM changes WHERE id <= (SELECT max(id) FROM changes) - ${CHANGE_CAP}`,
    ),
    insert: db.prepare(
      `INSERT INTO media (id, title, media_type, year, status, rating,
         progress_current, progress_total, progress_unit, notes,
         revision, started_at, completed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    ),
    update: db.prepare(
      `UPDATE media SET title = ?, media_type = ?, year = ?, status = ?, rating = ?,
         progress_current = ?, progress_total = ?, progress_unit = ?, notes = ?,
         lifecycle = ?, archived_at = ?, started_at = ?, completed_at = ?,
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
/** One offered media record, in the fields a media candidate has. */
function mediaCandidateLine(item) {
  const year = item.year ? `${item.year}年` : ''
  const lifecycle = item.lifecycle === 'archived' ? '，已归档' : ''
  return `- 《${item.title}》（${year}${MEDIA_TYPE_ZH[item.mediaType] ?? item.mediaType}${lifecycle}）assetId=${item.assetId}`
}

function renderValue(args, value) {
  const v = /** @type {any} */ (value)
  if (!v || typeof v !== 'object' || !('ok' in v)) return unexpectedStructure('media_log')
  if (v.ok !== true) return renderFailure(v, mediaCandidateLine)

  const data = v.data ?? {}
  if (data.receipt) {
    const receipt = data.receipt
    const argsTarget = /** @type {any} */ (args)?.target ?? {}
    const title = data.media?.title ?? argsTarget.title ?? ''
    if (receipt.outcome === 'unchanged') return unchangedReceipt(receipt)
    const verb = receipt.outcome === 'created' ? '已记下' : '已更新'
    const detail = data.media ?? {}
    const parts = [`${verb}《${detail.title ?? title}》`]
    if (detail.status) parts.push(STATUS_ZH[detail.status] ?? detail.status)
    // Echo an archived state: the write that produced it is usually "归档这条",
    // and a later patch on an archived record should not look like it vanished.
    if (detail.lifecycle === 'archived') parts.push('已归档')
    if (typeof detail.rating === 'number') parts.push(stars(detail.rating))
    if (detail.hasNotes) parts.push('短评已保存')
    return [
      {
        type: 'text',
        text: `${parts.join('，')}。（assetId=${receipt.assetId}，revision=${receipt.revision}）`,
      },
    ]
  }
  // A pick page announces its source — that is the discriminator against the
  // search page (which has items but no `from`).
  if (data.from !== undefined) {
    if (!Array.isArray(data.items) || data.items.length === 0) {
      const label =
        data.from === 'paused'
          ? '没有搁置中的记录。'
          : data.from === 'both'
            ? '想看和搁置的清单都空着。'
            : '想看清单还空着。'
      return [{ type: 'text', text: `${label}先记几部，再来挑。` }]
    }
    const source = data.from === 'paused' ? '搁置' : data.from === 'both' ? '想看和搁置' : '想看'
    const lines = [`从${source}清单的 ${data.total} 部里挑了 ${data.items.length} 部：`]
    for (const item of data.items) {
      const year = item.year ? `${item.year}年` : ''
      lines.push(`- 《${item.title}》（${year}${MEDIA_TYPE_ZH[item.mediaType] ?? item.mediaType}）assetId=${item.assetId}`)
    }
    lines.push('挑好了说一声，我帮你标成在看；都不合胃口就再挑一次。')
    return [{ type: 'text', text: lines.join('\n') }]
  }
  // A list page carries the filters it answered with; a search page does not.
  // That is the discriminator, and it doubles as an echo so the model can see
  // which window (especially the invisible default 'active') it asked for.
  if (data.filters) {
    const scope = listScope(data.filters.lifecycle)
    const offset = typeof data.offset === 'number' ? data.offset : 0
    const lines = []
    if (data.items.length === 0) {
      lines.push(
        offset > 0 ? '这一页是空的——offset 已经越过末页。' : `没有符合条件的记录${scope}。`,
      )
    } else {
      lines.push(`${listSummary(data.filters, data.items.length)}${scope}`)
      for (const item of data.items) lines.push(listItemLine(item))
    }
    if (data.total === null) {
      lines.push('结果未穷尽，可继续翻页（把 offset 加上一页的 limit）。')
    }
    return [{ type: 'text', text: lines.join('\n') }]
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
    if (data.mediaType) parts.push(MEDIA_TYPE_ZH[data.mediaType] ?? data.mediaType)
    if (data.year !== null && data.year !== undefined) parts.push(`${data.year}年`)
    if (data.status) parts.push(STATUS_ZH[data.status] ?? data.status)
    if (typeof data.rating === 'number') parts.push(stars(data.rating))
    const progress = progressText(data.progress)
    if (progress) parts.push(progress)
    const lines = [`${parts.join('，')}（assetId=${data.assetId}，revision=${data.revision}，${data.lifecycle === 'archived' ? '已归档' : '活跃'}）。`]
    if (data.startedAt) lines.push(`开始时间：${data.startedAt}`)
    if (data.completedAt) lines.push(`完成时间：${data.completedAt}`)
    // Only the detail mapper can opt notes in; do not reveal them by default.
    if ('notes' in data) {
      lines.push(`短评${data.notesTruncated ? '（已截断）' : ''}：${data.notes || '暂无'}`)
    }
    return [{ type: 'text', text: lines.join('\n') }]
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
  // The canonical value is genuinely polymorphic ({ok,data}|{ok,error}), so the
  // output schema stays an open object; the envelope contract itself is
  // enforced by errors.js. See toolkit.js for the shared parts.
  const toolCommon = { output: toolOutput((args, value) => renderValue(args, value)) }

  const markTool = defineTool({
    name: 'media_log_mark',
    description:
      'Record or update one media entry in your local library: status (planned/in_progress/completed/paused/dropped), rating (0-10 = five stars x2), absolute progress, a short review, and identity corrections. Aim it BY TITLE: pass target {title} plus the fields to change, and the tool resolves the record itself — in the same transaction that writes it, so there is no stale-read window. Do NOT call media_log_search or media_log_get first to look up an assetId: that is unnecessary, and a title that matches nothing returns the close records instead of guessing. To create something new pass target {title, mediaType}; an existing exact title blocks creation. Omitted fields keep their stored values; a create with no status is recorded as planned. Requires writes to be enabled in the plugin settings.',
    parameters: {
      target: {
        type: 'object',
        required: true,
        additionalProperties: false,
        description:
          'Update by title: {title} — add the fields to change at the root. Update by id: {assetId (UUID), expectedRevision} — only when you already hold the id from an earlier read. Create: {title, mediaType, year?}.',
        properties: {
          assetId: { type: 'string', description: 'Full UUID of the record to update.' },
          expectedRevision: { type: 'integer', description: 'Revision observed before this patch.' },
          title: { type: 'string', description: 'Create mode: exact work title, 1-300 chars. Update-by-title mode: the title to find, matched exactly.' },
          mediaType: { type: 'string', description: 'Create mode: movie | tv | anime | game.' },
          year: { type: 'integer', description: 'Create mode: release year 1850-2100.' },
        },
      },
      status: {
        type: 'string',
        description:
          'planned (想看/想玩) | in_progress (在看/在玩) | completed (已看完/玩完) | paused (搁置) | dropped (弃了). On create, omit it for planned.',
      },
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
      metadata: {
        type: 'object',
        additionalProperties: false,
        description:
          'Update only: correct the record\'s identity — title, mediaType, year. Omitted fields keep their stored values; title and mediaType cannot be emptied.',
        properties: {
          title: { type: 'string', description: 'Corrected title, 1-300 chars.' },
          mediaType: { type: 'string', description: 'movie | tv | anime | game.' },
          year: { type: 'integer', description: 'Release year 1850-2100.' },
        },
      },
      clear: {
        type: 'array',
        description:
          'Update only: fields to empty. Any of rating, year, notes, progress. Emptying progress clears it whole; title and mediaType are required and cannot be cleared.',
        items: { type: 'string', description: 'rating | year | notes | progress.' },
      },
      lifecycle: {
        type: 'string',
        description:
          'Update only: active | archived. Archiving hides the record from media_log_list (search still finds it, marked) and stamps archived_at; restoring clears that date and keeps the id, rating, progress and review.',
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

      // Read-compare-write in ONE transaction, so a concurrent writer cannot
      // slip between the comparison and the update. Everything inside returns
      // a tool value; only a thrown SQLite error becomes a failure here.
      return attemptSqlite(() =>
        inTransaction(db, () => {
          if (cmd.mode === 'create') {
            // Check all candidates under the write lock, so another writer
            // cannot create the same title between this read and the insert.
            const verdict = classifyCandidates(st.candidates.all().map(mapCandidate), cmd.title)
            if (verdict.kind !== 'none') {
              return fail(
                'TARGET_CONFLICT',
                verdict.kind === 'unique'
                  ? `资料库里已有《${verdict.candidate.title}》（${MEDIA_TYPE_ZH[verdict.candidate.mediaType] ?? ''}）。当前不支持同名新建。`
                  : '资料库里有多条同名条目，请选择要更新的记录；当前不支持同名新建。',
                {
                  candidates: verdict.candidates,
                  hint: '要改它就换成 target {title} 加上要改的字段（工具会自己定位并读取 revision），或用 assetId 更新。',
                },
              )
            }
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
            // The journal never carries note text — just the fact it was set.
            recordChange(st.journal, st.journalTrim, {
              at: now,
              module: 'media',
              assetId,
              name: cmd.title,
              action: 'create',
              summary: changeSummary([
                ['状态', undefined, STATUS_ZH[cmd.status] ?? cmd.status],
                ...(cmd.rating !== undefined ? [['评分', undefined, cmd.rating]] : []),
                ...(cmd.progress
                  ? [[
                      '进度',
                      undefined,
                      progressText({ current: cmd.progress.current ?? null, total: cmd.progress.total ?? null, unit: cmd.progress.unit ?? null }) || null,
                    ]]
                  : []),
                ...(cmd.notes ? [['短评', undefined, '已填写']] : []),
                ...(cmd.year !== undefined ? [['年份', undefined, cmd.year]] : []),
              ]),
            })
            return ok({
              receipt: { assetId, outcome: 'created', revision: 1 },
              media: mapDetail(/** @type {any} */ (row), false),
            })
          }

          if (cmd.mode === 'updateByTitle') {
            // Resolve the row from the title inside the SAME transaction that
            // will write it — the read that picks the row and the write that
            // patches it cannot be separated, so this path can never report a
            // stale revision. Only an exact title counts as a match: a fuzzy
            // hit would silently patch the wrong work.
            const needle = cmd.title.trim().toLowerCase()
            const pool = st.candidates
              .all()
              .filter((r) => String(r.title).trim().toLowerCase() === needle)
            if (pool.length !== 1) {
              // Nothing exact: offer what is close, so the model can either
              // retry with the stored title or fall back to a create.
              const near =
                pool.length > 0
                  ? pool.map(mapCandidate)
                  : st.search.all(likePattern(cmd.title), 10, 0).map(mapCandidate)
              const hint =
                near.length > 0
                  ? '确认后用上面的确切标题重试这条指令，或改用 assetId 更新。'
                  : '资料库里没有这条记录。要新建就在 target 里补上 mediaType 再发一次。'
              return fail(
                'TARGET_CONFLICT',
                pool.length > 1
                  ? `资料库里有多条《${cmd.title}》，请说明是哪一条。`
                  : `资料库里没有《${cmd.title}》这条记录。`,
                { candidates: near, hint },
              )
            }
            return applyUpdate(String(pool[0].id), null)
          }

          return applyUpdate(cmd.assetId, cmd.expectedRevision)

          /**
           * Patches one row, guarded by the revision this call observed.
           * `expectedRevision` is null when the row was read inside THIS
           * transaction — there is no window for it to go stale, so the guard
           * has nothing to check.
           * @param {string} assetId
           * @param {number | null} expectedRevision
           */
          function applyUpdate(assetId, expectedRevision) {
            const row = st.byId.get(assetId)
            if (row === undefined) {
              return fail('NOT_FOUND', '没有找到这个 assetId 对应的记录。它可能已被删除，请先搜索确认。')
            }
            if (expectedRevision !== null && row.revision !== expectedRevision) {
              return fail(
                'STALE_REVISION',
                '这个记录在你读取之后被改过了。请重新读取当前 revision 再提交。',
                { currentRevision: row.revision },
              )
            }
            // A different review never replaces an existing one silently — and
            // emptying one is just as irreversible, so it goes through the same
            // confirmation rather than a side door.
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
                  ? '这条记录已有短评，清空会让原文消失。请确认要清空（设 replaceNotes: true）还是保留。'
                  : '这条记录已有短评，新短评和它不一样。请确认要替换（设 replaceNotes: true）还是保留原文。',
              )
            }
            const next = resolveUpdate(row, cmd)
            if (updateIsNoop(row, next)) {
              return ok({
                receipt: { assetId: row.id, outcome: 'unchanged', revision: row.revision },
                media: mapDetail(row, false),
              })
            }
            // Renaming onto another record's exact title would leave two rows
            // that every later create then trips over, so it is refused here the
            // same way a same-title create is — including against archived rows,
            // which already block a create.
            if (next.title !== row.title) {
              const needle = next.title.trim().toLowerCase()
              const clash = st.candidates
                .all()
                .map(mapCandidate)
                .filter((c) => c.assetId !== row.id && c.title.trim().toLowerCase() === needle)
              if (clash.length > 0) {
                return fail(
                  'TARGET_CONFLICT',
                  `资料库里已有《${clash[0].title}》。要改成这个名字，请先处理那条记录。`,
                  { candidates: clash },
                )
              }
            }
            st.update.run(
              next.title,
              next.mediaType,
              next.year,
              next.status,
              next.rating,
              next.progressCurrent,
              next.progressTotal,
              next.progressUnit,
              next.notes,
              next.lifecycle,
              next.archivedAt,
              next.startedAt,
              next.completedAt,
              nowIso(),
              row.id,
              row.revision,
            )
            const updated = st.byId.get(row.id)
            const at = nowIso()
            // Long text travels as sentinels, never as content: the journal is
            // a pointer to the record, not a copy of it.
            const progressBrief = (r) =>
              progressText({ current: r.progress_current, total: r.progress_total, unit: r.progress_unit }) || null
            recordChange(st.journal, st.journalTrim, {
              at,
              module: 'media',
              assetId: row.id,
              name: next.title,
              action: 'update',
              summary: changeSummary([
                ['状态', STATUS_ZH[row.status] ?? row.status, STATUS_ZH[next.status] ?? next.status],
                ['评分', row.rating, next.rating],
                ['进度', progressBrief(row), progressBrief(next)],
                textChange('短评', row.notes, next.notes),
                ['标题', row.title, next.title],
                ['类型', row.media_type, next.mediaType],
                ['年份', row.year, next.year],
                ['归档', row.lifecycle, next.lifecycle],
              ]),
            })
            return ok({
              receipt: { assetId: row.id, outcome: 'updated', revision: /** @type {any} */ (updated).revision },
              media: mapDetail(/** @type {any} */ (updated), false),
            })
          }
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
      const notReady = ensureReady(cfg, { isWrite: false })
      if (notReady) return notReady
      const validation = validateSearchArgs(args)
      if (!validation.ok) return fail('INVALID_ARGUMENT', validation.message)
      const db = await getLibrary(cfg.databasePath)
      const st = statements(db, buildStatements)
      const pattern = likePattern(validation.value.query)
      const page = attemptSqlite(() => {
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
      'Read one media record from your local library by full UUID: revision, status, rating, progress, timestamps, lifecycle. Use it to read back after a mark, or when you already hold an id and need its current revision for an update — media_log_mark with target {title} needs neither. Archived records are readable and marked lifecycle=archived.',
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
      const notReady = ensureReady(cfg, { isWrite: false })
      if (notReady) return notReady
      const validation = validateGetArgs(args)
      if (!validation.ok) return fail('INVALID_ARGUMENT', validation.message)
      const db = await getLibrary(cfg.databasePath)
      const st = statements(db, buildStatements)
      const result = attemptSqlite(() => {
        const row = st.byId.get(validation.value.assetId)
        if (row === undefined) {
          return fail('NOT_FOUND', '没有找到这个 assetId 对应的记录。它可能已被删除，请先搜索确认。')
        }
        return ok(mapDetail(row, validation.value.includeNotes))
      })
      return result
    },
  })

  const listTool = defineTool({
    name: 'media_log_list',
    description:
      'List your media records without knowing a title: what you are watching/playing now, what you want to watch, what you finished this month. Filters narrow the page (mediaType, status, lifecycle, completedAt range); omitting one widens it. lifecycle defaults to active, so archived rows stay hidden unless you ask for archived or all. Returns whitelisted summaries with rating, progress and assetId for follow-up marks; short reviews still come from media_log_get. An empty page is a success; total is null when the window was not exhausted.',
    parameters: {
      mediaType: { type: 'string', description: 'movie | tv | anime | game. Omit for all types.' },
      status: {
        type: 'string',
        description:
          'planned (想看/想玩) | in_progress (在看/在玩) | completed (已看完/玩完) | paused (搁置) | dropped (弃了). Omit for all statuses.',
      },
      lifecycle: { type: 'string', description: 'active (default, hides archived) | archived | all.' },
      completedFrom: {
        type: 'string',
        description:
          'Earliest completion date, inclusive. ISO-8601: a whole day as 2025-11-01 (UTC), or an instant with an explicit offset such as 2025-11-01T00:00:00+08:00. Records without completed_at never match a range.',
      },
      completedBefore: {
        type: 'string',
        description:
          'Latest completion date, exclusive — pass the first day of the next month to cover a whole month. Same format as completedFrom.',
      },
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
        lifecycle: q.lifecycle,
        mediaType: q.mediaType ?? null,
        status: q.status ?? null,
        from: q.completedFrom,
        to: q.completedBefore,
      }
      const page = attemptSqlite(() => {
        const items = st.list.all({ ...filters, limit: q.limit, offset: q.offset }).map(mapListItem)
        const matched = st.listCount.get(filters).n
        // Same convention as search: total is only claimed once the window is
        // known to be exhausted.
        const exhausted = q.offset + items.length >= matched
        return {
          items,
          offset: q.offset,
          limit: q.limit,
          total: exhausted ? matched : null,
          filters: {
            mediaType: q.mediaType ?? null,
            status: q.status ?? null,
            lifecycle: q.lifecycle,
          },
        }
      })
      if (isFail(page)) return page
      return ok(page)
    },
  })

  const pickTool = defineTool({
    name: 'media_log_pick',
    description:
      "Pick something to watch or play tonight FROM YOUR OWN recorded backlog: '今晚看什么', '随便挑一部', '搁置的里有没有能捡回来的'. Draws uniformly at random from planned (default), paused, or both — it NEVER invents titles and never looks anything up. mediaType narrows the pool; count (1-5, default 3) sets how many options come back. Read-only; the pool size is reported so '从 218 部里挑' stays honest.",
    parameters: {
      from: { type: 'string', description: 'planned (default) | paused | both — which list to draw from.' },
      mediaType: { type: 'string', description: 'movie | tv | anime | game. Omit for all types.' },
      count: { type: 'integer', description: 'How many to pick, 1-5, default 3.' },
    },
    ...toolCommon,
    async execute(args, exec) {
      if (exec.signal?.aborted) {
        return fail('CANCELLED', '这次查询在开始前就被取消了。')
      }
      const cfg = resolveConfig(getConfig())
      const notReady = ensureReady(cfg, { isWrite: false })
      if (notReady) return notReady
      const validation = validatePickArgs(args)
      if (!validation.ok) return fail('INVALID_ARGUMENT', validation.message)
      const q = validation.value
      const db = await getLibrary(cfg.databasePath)
      const st = statements(db, buildStatements)
      return attemptSqlite(() => {
        const wanted = q.from === 'both' ? ['planned', 'paused'] : [q.from]
        const pool = st.candidates
          .all()
          .filter(
            (r) =>
              r.lifecycle === 'active' &&
              wanted.includes(r.status) &&
              (q.mediaType === null || r.media_type === q.mediaType),
          )
        return ok({
          items: pickCandidates(pool, q.count).map(mapCandidate),
          from: q.from,
          mediaType: q.mediaType,
          total: pool.length,
        })
      })
    },
  })

  return [markTool, pickTool, searchTool, getTool, listTool]
}
