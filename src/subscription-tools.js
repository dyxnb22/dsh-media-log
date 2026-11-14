// The three subscription_* tools over the plugin's own SQLite library. Same
// shape as the media tools: thin host layer, validation in subscriptions.js,
// storage in db.js, the outcome envelope in errors.js. Domain outcomes —
// including every expected failure — are canonical VALUES; only plugin bugs
// throw.
//
// The money fields deliberately stop short of a ledger: amounts are integer
// minor units, a monthly figure is an estimate the plugin computes for
// convenience, and nothing here ever advances a date on its own. Recording a
// renewal means recording the fact the user supplied plus the next boundary
// they named.

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
import { toolOutput, unexpectedStructure, renderFailure, unchangedReceipt, changeSummary, textChange, recordChange } from './toolkit.js'
import {
  validateMarkArgs,
  validateListArgs,
  validateGetArgs,
  mapListItem,
  mapDetail,
  monthlyMinor,
} from './subscriptions.js'

const CYCLE_ZH = { monthly: '月付', yearly: '年付', usage: '按量付费' }
const CURRENCY_SYMBOL = { CNY: '¥', USD: '$' }
const LIST_LIFECYCLE_ZH = { active: '', archived: '（只看已归档）', all: '（含已归档）' }

/** This module's own statement cache — see statementCache() for why it is not shared. */
const statements = statementCache()

/**
 * Prepared statements for one open library, keyed to the handle by a WeakMap.
 *
 * The list WHERE is one clause shared by the page and its count, written with
 * named parameters so an absent filter passes through. node:sqlite rejects
 * unknown named parameters, so each statement gets exactly the keys its own SQL
 * mentions — a mismatch fails loudly instead of binding nothing.
 * @param {import('node:sqlite').DatabaseSync} db
 */
function buildStatements(db) {
  const LIST_WHERE = `
    WHERE (lifecycle = :lifecycle OR :lifecycle = 'all')
      AND (:name IS NULL OR name LIKE :name ESCAPE '\\')
      AND (:cycle IS NULL OR cycle = :cycle)
      AND (:currency IS NULL OR currency = :currency)
      AND (:autoRenew IS NULL OR auto_renew = :autoRenew)
      AND (:renewFrom IS NULL OR julianday(next_renew_at) >= julianday(:renewFrom))
      AND (:renewBefore IS NULL OR julianday(next_renew_at) < julianday(:renewBefore))`
  const LIST_COLUMNS = `id, name, provider, cycle, currency, amount_minor, auto_renew,
       next_renew_at, expires_at, lifecycle, revision`
  return {
    byName: db.prepare(`SELECT * FROM subscriptions WHERE name = ?`),
    byId: db.prepare(`SELECT * FROM subscriptions WHERE id = ?`),
    countByName: db.prepare(`SELECT count(*) AS n FROM subscriptions WHERE name = ?`),
    insert: db.prepare(
      `INSERT INTO subscriptions (id, name, provider, amount_minor, currency, cycle,
         next_renew_at, expires_at, auto_renew, notes, revision, archived_at,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    ),
    update: db.prepare(
      `UPDATE subscriptions SET name = ?, provider = ?, amount_minor = ?, currency = ?,
         cycle = ?, next_renew_at = ?, expires_at = ?, auto_renew = ?, notes = ?,
         lifecycle = ?, archived_at = ?, revision = revision + 1, updated_at = ?
       WHERE id = ? AND revision = ?`,
    ),
    list: db.prepare(
      `SELECT ${LIST_COLUMNS} FROM subscriptions${LIST_WHERE}
       ORDER BY next_renew_at IS NULL, next_renew_at ASC, id ASC LIMIT :limit OFFSET :offset`,
    ),
    listCount: db.prepare(`SELECT count(*) AS n FROM subscriptions${LIST_WHERE}`),
    journal: db.prepare(
      `INSERT INTO changes (at, module, asset_id, name, action, summary)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    journalTrim: db.prepare(
      `DELETE FROM changes WHERE id <= (SELECT max(id) FROM changes) - ${CHANGE_CAP}`,
    ),
    // The monthly estimate is computed over EVERY matching row, not just the
    // page on screen, so paging cannot make the total shrink. Only the three
    // columns the estimate needs are projected.
    monthlyTotals: db.prepare(
      `SELECT currency, amount_minor, cycle FROM subscriptions${LIST_WHERE}`,
    ),
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
    provider: clearing.has('provider') ? null : (cmd.provider ?? row.provider),
    amountMinor: clearing.has('amountMinor') ? null : (cmd.amountMinor ?? row.amount_minor),
    currency: cmd.currency ?? row.currency,
    cycle: cmd.cycle ?? row.cycle,
    nextRenewAt: clearing.has('nextRenewAt') ? null : (cmd.nextRenewAt ?? row.next_renew_at),
    expiresAt: clearing.has('expiresAt') ? null : (cmd.expiresAt ?? row.expires_at),
    autoRenew: cmd.autoRenew ?? row.auto_renew === 1,
    notes: clearing.has('notes') ? null : (cmd.notes ?? row.notes),
    // Archiving stamps the moment it happened; restoring clears it.
    lifecycle: cmd.lifecycle ?? row.lifecycle,
    archivedAt:
      cmd.lifecycle === undefined || cmd.lifecycle === row.lifecycle
        ? row.archived_at
        : cmd.lifecycle === 'archived'
          ? nowIso()
          : null,
  }
}

/** True when a resolved update would leave every stored column exactly as is. */
function updateIsNoop(row, next) {
  return (
    next.name === row.name &&
    next.provider === row.provider &&
    next.amountMinor === row.amount_minor &&
    next.currency === row.currency &&
    next.cycle === row.cycle &&
    next.nextRenewAt === row.next_renew_at &&
    next.expiresAt === row.expires_at &&
    (next.autoRenew ? 1 : 0) === row.auto_renew &&
    next.notes === row.notes &&
    next.lifecycle === row.lifecycle &&
    next.archivedAt === row.archived_at
  )
}

/** '¥20.00' / '$20.00'. Minor units are always two decimals for both codes. */
function money(minor, currency) {
  const symbol = CURRENCY_SYMBOL[currency] ?? currency
  return `${symbol}${(minor / 100).toFixed(2)}`
}

/**
 * A recorded date as a person would say it. A whole-day bound lands on UTC
 * midnight in either spelling (`.000Z` from this plugin, `+00:00` from an
 * import), and showing the day instead of the machinery is what the user asked
 * for. Anything carrying a real time is shown in full.
 * @param {unknown} iso
 * @returns {string|null}
 */
function dateText(iso) {
  if (typeof iso !== 'string' || iso.length === 0) return null
  const day = /^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(iso)
  return day ? day[1] : iso
}

/**
 * Per-currency monthly totals over the rows that matched, plus how many of
 * them the estimate could not use (usage-based, or an amount nobody recorded).
 * Reuses monthlyMinor so there is exactly one definition of the arithmetic.
 * @param {Array<Record<string, unknown>>} rows
 */
function monthlyTotals(rows) {
  /** @type {Record<string, number>} */
  const totals = {}
  let excluded = 0
  for (const row of rows) {
    const monthly = monthlyMinor(row)
    if (monthly === null) {
      excluded += 1
      continue
    }
    const currency = String(row.currency)
    totals[currency] = (totals[currency] ?? 0) + monthly
  }
  return { totals, excluded }
}

/**
 * Model-facing render text (pure: a function of args + canonical value).
 * @param {unknown} args original tool arguments
 * @param {unknown} value canonical tool value
 * @returns {string[]}
 */
/** One offered subscription, in the fields a subscription candidate has. */
function subscriptionCandidateLine(item) {
  const amount =
    typeof item.amountMinor === 'number' ? money(item.amountMinor, item.currency) : '金额未记'
  return `- 《${item.name}》（${CYCLE_ZH[item.cycle] ?? item.cycle}，${amount}）assetId=${item.assetId}`
}

function renderValue(args, value) {
  const v = /** @type {any} */ (value)
  if (!v || typeof v !== 'object' || !('ok' in v)) return unexpectedStructure('subscription')
  if (v.ok !== true) return renderFailure(v, subscriptionCandidateLine)

  const data = v.data ?? {}
  if (data.receipt) {
    const receipt = data.receipt
    const detail = data.subscription ?? {}
    const name = detail.name ?? ''
    if (receipt.outcome === 'unchanged') return unchangedReceipt(receipt)
    const verb = receipt.outcome === 'created' ? '已记下' : '已更新'
    const parts = [`${verb}《${name}》`]
    parts.push(CYCLE_ZH[detail.cycle] ?? detail.cycle ?? '')
    if (typeof detail.amountMinor === 'number') {
      parts.push(money(detail.amountMinor, detail.currency))
    } else {
      parts.push('金额未记')
    }
    if (detail.nextRenewAt) parts.push(`下次续费 ${dateText(detail.nextRenewAt)}`)
    if (detail.autoRenew === false) parts.push('不自动续费')
    if (detail.lifecycle === 'archived') parts.push('已归档')
    if (detail.hasNotes) parts.push('备注已保存')
    return [
      {
        type: 'text',
        text: `${parts.join('，')}。（assetId=${receipt.assetId}，revision=${receipt.revision}）`,
      },
    ]
  }

  if (data.filters) {
    const scope = LIST_LIFECYCLE_ZH[data.filters.lifecycle] ?? ''
    const offset = typeof data.offset === 'number' ? data.offset : 0
    const lines = []
    if (data.items.length === 0) {
      lines.push(
        offset > 0 ? '这一页是空的——offset 已经越过末页。' : `没有符合条件的订阅${scope}。`,
      )
    } else {
      lines.push(`${listSummary(data.filters, data.items.length)}${scope}`)
      for (const item of data.items) lines.push(subscriptionLine(item))
      const summary = Object.entries(data.monthlyTotals ?? {})
        .map(([currency, minor]) => `${money(minor, currency)}/月`)
        .join('，')
      if (summary) {
        // Labelled as this plugin's own estimate, not a fact about the services.
        const skipped = data.estimateExcluded ?? 0
        const caveat =
          skipped > 0 ? `；按量付费和未记金额的 ${skipped} 条不计入` : ''
        lines.push(`按月均估算合计：${summary}（年付按 12 个月摊${caveat}）`)
      }
    }
    if (data.total === null) {
      lines.push('结果未穷尽，可继续翻页（把 offset 加上一页的 limit）。')
    }
    return [{ type: 'text', text: lines.join('\n') }]
  }

  if (data.assetId) {
    const parts = [`《${data.name}》`]
    parts.push(CYCLE_ZH[data.cycle] ?? data.cycle ?? '')
    if (typeof data.amountMinor === 'number') {
      parts.push(money(data.amountMinor, data.currency))
    } else {
      parts.push('金额未记')
    }
    if (typeof data.monthlyMinor === 'number' && data.monthlyMinor !== data.amountMinor) {
      parts.push(`月均约 ${money(data.monthlyMinor, data.currency)}`)
    }
    // The yearly cost of a monthly subscription — the same arithmetic the
    // monthly estimate makes, read in the other direction. A yearly row is
    // its own annual figure, so saying it twice is noise; usage has no figure.
    if (data.cycle === 'monthly' && typeof data.amountMinor === 'number' && data.amountMinor > 0) {
      parts.push(`年化约 ${money(data.amountMinor * 12, data.currency)}`)
    }
    const lines = [
      `${parts.join('，')}（assetId=${data.assetId}，revision=${data.revision}，${data.lifecycle === 'archived' ? '已归档' : '活跃'}）。`,
    ]
    if (data.provider) lines.push(`提供方/套餐：${data.provider}`)
    if (data.nextRenewAt) lines.push(`下次续费：${dateText(data.nextRenewAt)}`)
    if (data.expiresAt) lines.push(`到期：${dateText(data.expiresAt)}`)
    lines.push(`自动续费：${data.autoRenew ? '是' : '否'}`)
    // A past date only says the recorded date has passed. It does not mean the
    // money moved or the service died.
    if (data.nextRenewAt && Date.parse(data.nextRenewAt) < Date.now()) {
      lines.push('（登记的下次续费日期已过；是否真的扣款或失效请以服务方为准）')
    }
    if ('notes' in data) {
      lines.push(`备注${data.notesTruncated ? '（已截断）' : ''}：${data.notes || '暂无'}`)
    }
    return [{ type: 'text', text: lines.join('\n') }]
  }
  return unexpectedStructure('subscription')
}

/** Natural-language header for a list page. */
function listSummary(f, n) {
  const bits = []
  if (f.cycle) bits.push(CYCLE_ZH[f.cycle] ?? f.cycle)
  if (f.currency) bits.push(f.currency)
  if (f.autoRenew === true) bits.push('自动续费')
  if (f.autoRenew === false) bits.push('不自动续费')
  const what = bits.length > 0 ? `${bits.join('、')}的` : ''
  if (f.renewFrom || f.renewBefore) {
    // The window is echoed, because the default is not "everything" — it is
    // whatever the caller asked for, and a date range is easy to misremember.
    const from = f.renewFrom ? dateText(f.renewFrom) : '现在起'
    const to = f.renewBefore ? dateText(f.renewBefore) : '以后'
    return `下次续费在 ${from} 到 ${to} 之间的${what}订阅有 ${n} 个：`
  }
  return `${what}订阅有 ${n} 个：`
}

/** One list row: enough to recognize it and to act on it. */
function subscriptionLine(item) {
  const amount =
    typeof item.amountMinor === 'number' ? money(item.amountMinor, item.currency) : '金额未记'
  // A monthly subscription's "monthly equivalent" is just its price, so saying
  // it again is noise; only a spread-out yearly cost gains from the figure.
  const monthly =
    typeof item.monthlyMinor === 'number' && item.monthlyMinor !== item.amountMinor
      ? `，月均约 ${money(item.monthlyMinor, item.currency)}`
      : ''
  const renew = item.nextRenewAt ? `，下次续费 ${dateText(item.nextRenewAt)}` : '，下次续费未记'
  const auto = item.autoRenew ? '' : '，不自动续费'
  const archived = item.lifecycle === 'archived' ? '，已归档' : ''
  return `- 《${item.name}》（${CYCLE_ZH[item.cycle] ?? item.cycle}，${amount}${monthly}${renew}${auto}${archived}）assetId=${item.assetId}`
}

/**
 * Creates the three tools. `getConfig` re-resolves the activation config per
 * call so settings writes take effect live.
 * @param {() => Record<string, unknown>} getConfig
 * @param {(databasePath?: string) => Promise<import('node:sqlite').DatabaseSync>} getLibrary
 */
export function createSubscriptionTools(getConfig, getLibrary) {
  // The canonical value is polymorphic; share the open output contract while
  // keeping this module's rendering.
  const toolCommon = { output: toolOutput((args, value) => renderValue(args, value)) }

  const markTool = defineTool({
    name: 'subscription_mark',
    description:
      'Record or update one subscription in your local library: what it costs (amountMinor in 分/cents, currency CNY|USD), how it bills (monthly|yearly|usage), the next renewal date, the expiry date, and whether it auto-renews. Pass target {name} plus cycle to create. To update, target {assetId, expectedRevision} — there is no update-by-title here, because a service name is not a unique key; find the id with subscription_list, which returns the revision too, so no separate get is needed. Omitted fields keep their stored values; clear empties provider/amountMinor/nextRenewAt/expiresAt/notes. A renewal is recorded as the fact you supply plus the next date you name — nothing is advanced automatically. Requires writes to be enabled in the plugin settings.',
    parameters: {
      target: {
        type: 'object',
        required: true,
        additionalProperties: false,
        description: 'Create: {name}. Update: {assetId (UUID), expectedRevision}.',
        properties: {
          assetId: { type: 'string', description: 'Full UUID of the record to update.' },
          expectedRevision: { type: 'integer', description: 'Revision observed before this patch.' },
          name: { type: 'string', description: 'Create mode: the service name, 1-200 chars.' },
        },
      },
      provider: { type: 'string', description: 'Provider or plan, optional, 1-200 chars.' },
      amountMinor: {
        type: 'integer',
        description:
          'Price in minor units — 分 for CNY, cents for USD. 20 USD = 2000. Omit or clear it when the price is unknown; unknown is not the same as 0.',
      },
      currency: { type: 'string', description: 'CNY | USD. Defaults to CNY.' },
      cycle: { type: 'string', description: 'monthly | yearly | usage. Required on create.' },
      nextRenewAt: {
        type: 'string',
        description:
          'Next expected renewal/charge date. ISO-8601: a whole day as 2026-12-10, or an instant with an explicit offset such as 2026-12-10T00:00:00+08:00.',
      },
      expiresAt: {
        type: 'string',
        description:
          'Known end of the entitlement if nothing extends it. Kept even when auto-renew is off. Same format as nextRenewAt.',
      },
      autoRenew: {
        type: 'boolean',
        description:
          'Whether it renews by itself. Turning this off keeps the paid-through expiry date; it does not cancel anything by itself.',
      },
      notes: { type: 'string', description: 'Short note, 1-2000 chars, no NUL. Replacing existing notes needs replaceNotes.' },
      replaceNotes: { type: 'boolean', description: 'Replace the existing note (only after the user confirmed).' },
      clear: {
        type: 'array',
        description: 'Update only: fields to empty. Any of provider, amountMinor, nextRenewAt, expiresAt, notes.',
        items: { type: 'string', description: 'provider | amountMinor | nextRenewAt | expiresAt | notes.' },
      },
      lifecycle: { type: 'string', description: 'Update only: active | archived.' },
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
      // slip between the comparison and the update.
      return attemptSqlite(() =>
        inTransaction(db, () => {
          if (cmd.mode === 'create') {
            // Check the name under the write lock, so another writer cannot
            // create the same subscription between this read and the insert.
            if (st.countByName.get(cmd.name).n > 0) {
              const existing = st.byName.get(cmd.name)
              return fail(
                'TARGET_CONFLICT',
                `资料库里已有《${cmd.name}》。当前不支持同名新建，请改用它的 assetId 更新。`,
                { candidates: [mapListItem(existing)] },
              )
            }
            const now = nowIso()
            const assetId = randomUUID()
            st.insert.run(
              assetId,
              cmd.name,
              cmd.provider ?? null,
              cmd.amountMinor ?? null,
              cmd.currency ?? 'CNY',
              cmd.cycle,
              cmd.nextRenewAt ?? null,
              cmd.expiresAt ?? null,
              cmd.autoRenew === false ? 0 : 1,
              cmd.notes ?? null,
              null,
              now,
              now,
            )
            const row = st.byId.get(assetId)
            recordChange(st.journal, st.journalTrim, {
              at: now,
              module: 'subscription',
              assetId,
              name: cmd.name,
              action: 'create',
              summary: changeSummary([
                ['周期', undefined, CYCLE_ZH[cmd.cycle] ?? cmd.cycle],
                ...(typeof cmd.amountMinor === 'number'
                  ? [['金额', undefined, money(cmd.amountMinor, cmd.currency ?? 'CNY')]]
                  : []),
                ...(cmd.nextRenewAt !== undefined ? [['下次续费', undefined, cmd.nextRenewAt]] : []),
                ...(cmd.expiresAt !== undefined ? [['到期', undefined, cmd.expiresAt]] : []),
                ...(cmd.autoRenew === false ? [['自动续费', undefined, false]] : []),
                ...(cmd.notes ? [['备注', undefined, '已填写']] : []),
              ]),
            })
            return ok({
              receipt: { assetId, outcome: 'created', revision: 1 },
              subscription: mapDetail(/** @type {any} */ (row), false),
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
          // A different note never replaces an existing one silently — and
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
                ? '这条记录已有备注，清空会让原文消失。请确认要清空（设 replaceNotes: true）还是保留。'
                : '这条记录已有备注，新备注和它不一样。请确认要替换（设 replaceNotes: true）还是保留原文。',
            )
          }
          const next = resolveUpdate(row, cmd)
          if (updateIsNoop(row, next)) {
            return ok({
              receipt: { assetId: row.id, outcome: 'unchanged', revision: row.revision },
              subscription: mapDetail(row, false),
            })
          }
          st.update.run(
            next.name,
            next.provider,
            next.amountMinor,
            next.currency,
            next.cycle,
            next.nextRenewAt,
            next.expiresAt,
            next.autoRenew ? 1 : 0,
            next.notes,
            next.lifecycle,
            next.archivedAt,
            nowIso(),
            row.id,
            row.revision,
          )
          const updated = st.byId.get(row.id)
          const at = nowIso()
          const moneyBrief = (amount, currency) =>
            typeof amount === 'number' ? money(amount, currency) : null
          recordChange(st.journal, st.journalTrim, {
            at,
            module: 'subscription',
            assetId: row.id,
            name: next.name,
            action: 'update',
            summary: changeSummary([
              ['套餐', row.provider, next.provider],
              ['金额', moneyBrief(row.amount_minor, row.currency), moneyBrief(next.amountMinor, next.currency)],
              ['周期', CYCLE_ZH[row.cycle] ?? row.cycle, CYCLE_ZH[next.cycle] ?? next.cycle],
              ['下次续费', row.next_renew_at, next.nextRenewAt],
              ['到期', row.expires_at, next.expiresAt],
              ['自动续费', row.auto_renew === 1, next.autoRenew],
              textChange('备注', row.notes, next.notes),
              ['归档', row.lifecycle, next.lifecycle],
            ]),
          })
          return ok({
            receipt: { assetId: row.id, outcome: 'updated', revision: /** @type {any} */ (updated).revision },
            subscription: mapDetail(/** @type {any} */ (updated), false),
          })
        }),
      )
    },
  })

  const listTool = defineTool({
    name: 'subscription_list',
    description:
      'List your subscriptions without knowing a name: what renews in the next 30 days, what is monthly vs yearly, what no longer auto-renews. Filters narrow the page (name substring, cycle, currency, autoRenew, lifecycle, next-renewal date range); omitting one widens it. lifecycle defaults to active, so archived rows stay hidden unless you ask for archived or all. Returns whitelisted summaries with assetId for follow-up marks, plus a per-currency monthly estimate this plugin computes (yearly spread over 12 months; usage-based and unrecorded amounts excluded). An empty page is a success; total is null when the window was not exhausted.',
    parameters: {
      name: { type: 'string', description: 'Substring of the service name, 1-200 chars.' },
      cycle: { type: 'string', description: 'monthly | yearly | usage. Omit for all.' },
      currency: { type: 'string', description: 'CNY | USD. Omit for both.' },
      autoRenew: { type: 'boolean', description: 'true = still renews itself, false = turned off. Omit for both.' },
      lifecycle: { type: 'string', description: 'active (default, hides archived) | archived | all.' },
      renewFrom: {
        type: 'string',
        description:
          'Earliest next-renewal date, inclusive. ISO-8601: a whole day as 2026-11-10, or an instant with an explicit offset. Records with no next-renewal date never match a range.',
      },
      renewBefore: {
        type: 'string',
        description:
          'Latest next-renewal date, exclusive — pass the day after the window to cover it whole. Same format as renewFrom.',
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
        name: q.name === null ? null : likePattern(q.name),
        cycle: q.cycle,
        currency: q.currency,
        autoRenew: q.autoRenew === null ? null : (q.autoRenew ? 1 : 0),
        renewFrom: q.renewFrom,
        renewBefore: q.renewBefore,
      }
      const page = attemptSqlite(() => {
        const items = st.list.all({ ...filters, limit: q.limit, offset: q.offset }).map(mapListItem)
        const matched = st.listCount.get(filters).n
        const exhausted = q.offset + items.length >= matched
        const { totals, excluded } = monthlyTotals(st.monthlyTotals.all(filters))
        return {
          items,
          offset: q.offset,
          limit: q.limit,
          total: exhausted ? matched : null,
          monthlyTotals: totals,
          estimateExcluded: excluded,
          filters: {
            name: q.name,
            cycle: q.cycle,
            currency: q.currency,
            autoRenew: q.autoRenew,
            lifecycle: q.lifecycle,
            renewFrom: q.renewFrom,
            renewBefore: q.renewBefore,
          },
        }
      })
      if (isFail(page)) return page
      return ok(page)
    },
  })

  const getTool = defineTool({
    name: 'subscription_get',
    description:
      'Read one subscription from your local library by full UUID: revision, provider, amount in minor units, currency, cycle, next renewal and expiry dates, auto-renew, lifecycle, and the monthly estimate. Use it to read back after a mark, or when you need a field a list row does not carry — subscription_list already returns the revision, so an update needs no separate read. A past next-renewal date only means the recorded date has passed — it does not mean the money moved.',
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
