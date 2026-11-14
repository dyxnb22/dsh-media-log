// The overview endpoint: one read-only JSON route behind the sidebar tab.
//
// computeOverview() is the whole feature — a pure function from the three
// tables to the one screen of numbers and todos the tab shows. It is a
// GLANCE, not a report: every number must be actionable or it does not
// belong here. The route itself is thin glue — connection fence, method
// dispatch, envelope — following the admission pattern of dsh-better-sidebar's
// own API routes (requestRejection fence, prefix registration, 403/404/405).
//
// Registration is scoped: `ctx.inject(['webServer', 'connection'], …)` fires
// only where those services exist (the desktop with a web server). In a
// headless profile the callback never runs, and the 11 tools are unaffected —
// the overview is an ADD-ON to the tools, never a dependency of them.
//
// Route plumbing codes (FORBIDDEN / INTERNAL) are route-only and sit outside
// the shared tool vocabulary; every domain outcome uses that vocabulary.

import { statementCache, nowIso } from './db.js'
import { ok, fail, attemptSqlite } from './errors.js'
import { resolveConfig, ensureReady } from './config.js'
import { monthlyMinor } from './subscriptions.js'

const DAY_MS = 24 * 60 * 60 * 1000

/** A paused record resurfaces as a todo after this many untouched days. The
 *  clock is updated_at — the record's last write — so touching a record in
 *  any way resets it; "32 天没动过" is a fact, never a guess about intent. */
const PAUSED_STALL_DAYS = 30

/** This module's own statement cache — see statementCache() for why it is not shared. */
const statements = statementCache()

/**
 * @param {import('node:sqlite').DatabaseSync} db
 */
function buildStatements(db) {
  return {
    mediaAll: db.prepare(
      `SELECT id, title, media_type, year, status, lifecycle, completed_at, updated_at FROM media`,
    ),
    subsAll: db.prepare(
      `SELECT id, name, currency, cycle, amount_minor, next_renew_at, lifecycle FROM subscriptions`,
    ),
    softAll: db.prepare(`SELECT status FROM software`),
    lastChange: db.prepare(`SELECT at FROM changes ORDER BY id DESC LIMIT 1`),
  }
}

/**
 * Parses a stored date into epoch ms, or null when absent/unparseable — the
 * same honest silence as julianday() in the list tools: a record without a
 * usable date never enters a window.
 * @param {unknown} value
 * @returns {number | null}
 */
function parseMs(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/**
 * Computes the whole overview payload. `now` is injectable so tests pin the
 * windows; production passes one Date per request.
 *
 * Window conventions, deliberately the same as the tools':
 * - renewal windows compare against UTC midnight of `now`'s day, because a
 *   whole-day bound canonicalizes to UTC midnight (dates.js);
 * - "本月看完" uses the LOCAL calendar month (the reader's month, like the
 *   journal's whenText) and counts by completed_at regardless of the current
 *   status — the same 口径 as media_log_list's completed-date window.
 * @param {{media: Array<Record<string, unknown>>, subscriptions: Array<Record<string, unknown>>, software: Array<Record<string, unknown>>, lastChangeAt: string | null}} rows
 * @param {Date} now
 */
export function computeOverview(rows, now = new Date()) {
  const today0 = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime()

  const activeMedia = rows.media.filter((r) => r.lifecycle === 'active')
  const byStatus = (s) => activeMedia.filter((r) => r.status === s).length
  const completedThisMonth = rows.media.filter((r) => {
    const t = parseMs(r.completed_at)
    return t !== null && t >= monthStart && t < monthEnd
  }).length

  const inProgressRows = activeMedia
    .filter((r) => r.status === 'in_progress')
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))

  const stalledPaused = activeMedia
    .filter((r) => {
      if (r.status !== 'paused') return false
      const t = parseMs(r.updated_at)
      return t !== null && t < today0 - PAUSED_STALL_DAYS * DAY_MS
    })
    .sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)))
    .map((r) => ({
      assetId: r.id,
      title: r.title,
      stalledDays: Math.max(1, Math.floor((today0 - /** @type {number} */ (parseMs(r.updated_at))) / DAY_MS)),
    }))

  const activeSubs = rows.subscriptions.filter((r) => r.lifecycle === 'active')
  /** @type {Record<string, number>} */
  const monthlyTotals = {}
  let unestimated = 0
  for (const row of activeSubs) {
    const monthly = monthlyMinor(row)
    if (monthly === null) {
      unestimated += 1
      continue
    }
    const currency = String(row.currency)
    monthlyTotals[currency] = (monthlyTotals[currency] ?? 0) + monthly
  }

  const renewalsBetween = (fromMs, toMs) =>
    activeSubs
      .filter((r) => {
        const t = parseMs(r.next_renew_at)
        return t !== null && t >= fromMs && t < toMs
      })
      .sort((a, b) => String(a.next_renew_at).localeCompare(String(b.next_renew_at)))
      .map((r) => ({ assetId: r.id, name: r.name, nextRenewAt: r.next_renew_at }))

  const overdue = renewalsBetween(0, today0)
  const next7 = renewalsBetween(today0, today0 + 7 * DAY_MS)
  const next30Count = renewalsBetween(today0 + 7 * DAY_MS, today0 + 30 * DAY_MS).length

  let inUse = 0
  let retired = 0
  for (const row of rows.software) {
    if (row.status === 'in_use') inUse += 1
    else if (row.status === 'retired') retired += 1
  }

  return {
    generatedAt: nowIso(),
    overview: {
      media: {
        total: rows.media.length,
        archived: rows.media.length - activeMedia.length,
        inProgress: byStatus('in_progress'),
        planned: byStatus('planned'),
        completedThisMonth,
      },
      subscriptions: { active: activeSubs.length, monthlyTotals, unestimated },
      software: { inUse, retired },
    },
    todos: {
      // A past next_renew_at is a QUESTION ("did it renew?"), never a claim
      // that money moved — the same honesty the tools render with.
      overdue,
      next7,
      next30Count,
      pausedStalledTotal: stalledPaused.length,
      pausedStalled: stalledPaused.slice(0, 5),
      inProgressTotal: inProgressRows.length,
      inProgressRecent: inProgressRows.slice(0, 5).map((r) => ({
        assetId: r.id,
        title: r.title,
        mediaType: r.media_type,
        year: r.year ?? null,
      })),
    },
    journal: { lastAt: rows.lastChangeAt ?? null },
  }
}

/** @param {import('node:http').ServerResponse} res */
function sendJson(res, status, value) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(value))
}

/**
 * Registers the overview route where a web server exists. Scoped inject on
 * purpose: `inject` as a plugin-level hard requirement would keep the whole
 * plugin from activating in headless profiles, and the tools must not pay
 * for an add-on.
 * @param {import('@deepseek-ai/cordis').Context} ctx host context
 * @param {() => Record<string, unknown>} getConfig raw activation config
 * @param {(databasePath?: string) => Promise<import('node:sqlite').DatabaseSync>} getLibrary
 */
export function registerOverviewRoute(ctx, getConfig, getLibrary) {
  // The overview is an add-on: a host context without the scoped-inject
  // surface (test harnesses mount a bare { tools }) simply gets no route —
  // apply() must never fail because of it.
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['webServer', 'connection'], (sctx) => {
    sctx.effect(
      () =>
        sctx.webServer.register({
          kind: 'prefix',
          path: '/media-log/api',
          handler: async (req, res) => {
            try {
              // Same admission gate as the /api gateway: Host/Origin and
              // browser auth, checked per request.
              if (sctx.connection.requestRejection(req) !== undefined) {
                return sendJson(res, 403, fail('FORBIDDEN', '请求未通过桌面端连接校验。'))
              }
              const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
              if (req.method !== 'GET') {
                return sendJson(res, 405, fail('INVALID_ARGUMENT', '总览只接受 GET。'))
              }
              const method = pathname.startsWith('/media-log/api/')
                ? pathname.slice('/media-log/api/'.length)
                : ''
              if (method !== 'overview') {
                return sendJson(res, 404, fail('NOT_FOUND', `未知的方法「${method || '（空）'}」。`))
              }

              const cfg = resolveConfig(getConfig())
              const notReady = ensureReady(cfg, { isWrite: false })
              if (notReady) return sendJson(res, 200, notReady)
              const db = await getLibrary(cfg.databasePath)
              const st = statements(db, buildStatements)
              const value = attemptSqlite(() =>
                computeOverview(
                  {
                    media: st.mediaAll.all(),
                    subscriptions: st.subsAll.all(),
                    software: st.softAll.all(),
                    lastChangeAt: st.lastChange.get()?.at ?? null,
                  },
                  new Date(),
                ),
              )
              // Success rides the same {ok, data} envelope as the tools — the
              // client unwraps .data, so a bare payload would read as a bug.
              return sendJson(res, 200, ok(value))
            } catch (error) {
              // Only a plugin bug lands here (domain failures are values).
              // Stay loud in the host log, answer the client in its envelope.
              console.error('[dsh-media-log] overview route failed:', error)
              return sendJson(res, 500, fail('INTERNAL', '总览生成失败，详见宿主日志。'))
            }
          },
        }),
      'dsh-media-log: overview api route',
    )
  })
}
