// Tests for computeOverview — the sidebar overview's aggregation — against a
// REAL SQLite library in a temp directory: the rows are seeded through the
// production schema and read back through the route's own SELECTs, so the
// numbers are pinned to reality. The route glue (fence, dispatch) has no
// webServer in unit tests; what is pinned here is the degradation contract
// and every window boundary the tab shows.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openLibrary } from '../src/db.js'
import { computeOverview, registerOverviewRoute } from '../src/overview.js'

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'overview-test-'))
  return {
    dir,
    dbPath: join(dir, 'media.db'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/** UTC-anchored "now" for the renewal windows (they compare UTC midnight). */
const NOW = new Date('2026-11-14T12:00:00Z')

async function seed(dbPath, { media = [], subscriptions = [], software = [], changes = [] } = {}) {
  const db = await openLibrary(dbPath)
  const now = new Date().toISOString()
  const insMedia = db.prepare(
    `INSERT INTO media (id, title, media_type, year, status, lifecycle, completed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const r of media) {
    insMedia.run(
      r.id, r.title, r.mediaType ?? 'movie', r.year ?? null, r.status ?? 'planned',
      r.lifecycle ?? 'active', r.completedAt ?? null, r.updatedAt ?? now, r.updatedAt ?? now,
    )
  }
  const insSub = db.prepare(
    `INSERT INTO subscriptions (id, name, provider, amount_minor, currency, cycle, next_renew_at,
       expires_at, auto_renew, notes, lifecycle, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, 1, NULL, ?, ?, ?)`,
  )
  for (const r of subscriptions) {
    insSub.run(
      r.id, r.name, r.amountMinor ?? null, r.currency ?? 'CNY', r.cycle ?? 'monthly',
      r.nextRenewAt ?? null, r.lifecycle ?? 'active', now, now,
    )
  }
  const insSoft = db.prepare(
    `INSERT INTO software (id, name, category, purpose, source_url, version, platform,
       notes, status, revision, created_at, updated_at)
     VALUES (?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, 1, ?, ?)`,
  )
  for (const r of software) {
    insSoft.run(r.id, r.name, r.status ?? 'in_use', now, now)
  }
  const insChange = db.prepare(
    `INSERT INTO changes (at, module, asset_id, name, action, summary) VALUES (?, ?, ?, ?, ?, ?)`,
  )
  for (const r of changes) {
    insChange.run(r.at, r.module, r.assetId, r.name, r.action, r.summary)
  }
  // Read back through the SAME SELECTs the route feeds computeOverview, so a
  // column drift between route and assertion cannot hide.
  const rows = {
    media: db.prepare(`SELECT id, title, media_type, year, status, lifecycle, completed_at, updated_at FROM media`).all(),
    subscriptions: db.prepare(`SELECT id, name, currency, cycle, amount_minor, next_renew_at, lifecycle FROM subscriptions`).all(),
    software: db.prepare(`SELECT status FROM software`).all(),
    lastChangeAt: db.prepare(`SELECT at FROM changes ORDER BY id DESC LIMIT 1`).get()?.at ?? null,
  }
  db.close()
  return rows
}

test('empty library: zeros everywhere, no todos, no estimate', () => {
  const v = computeOverview({ media: [], subscriptions: [], software: [], lastChangeAt: null }, NOW)
  assert.deepEqual(v.overview.media, { total: 0, archived: 0, inProgress: 0, planned: 0, completedThisMonth: 0 })
  assert.deepEqual(v.overview.subscriptions, { active: 0, monthlyTotals: {}, unestimated: 0 })
  assert.deepEqual(v.overview.software, { inUse: 0, retired: 0 })
  assert.deepEqual(v.todos, {
    overdue: [], next7: [], next30Count: 0,
    pausedStalledTotal: 0, pausedStalled: [],
    inProgressTotal: 0, inProgressRecent: [],
  })
  assert.equal(v.journal.lastAt, null)
  assert.equal(typeof v.generatedAt, 'string')
})

test('paused records stall into todos after 30 untouched days; the bound and the clock are exact', async () => {
  const s = scratch()
  try {
    const rows = await seed(s.dbPath, {
      media: [
        // 今天0点往回数整 30 天 = 2026-10-15T00:00:00Z：恰好压线不算搁置
        { id: 'a', title: '压线的', media_type: 'movie', status: 'paused', updatedAt: '2026-10-15T00:00:00.000Z' },
        { id: 'b', title: '多一天', media_type: 'movie', status: 'paused', updatedAt: '2026-10-14T23:59:59.999Z' },
        { id: 'c', title: '老得多', media_type: 'game', status: 'paused', updatedAt: '2026-09-01T00:00:00.000Z' },
        { id: 'd', title: '最近摸过', media_type: 'movie', status: 'paused', updatedAt: '2026-11-10T00:00:00.000Z' },
        { id: 'e', title: '归档搁置', media_type: 'movie', status: 'paused', lifecycle: 'archived', updatedAt: '2026-09-01T00:00:00.000Z' },
        { id: 'f', title: '在看不算', media_type: 'movie', status: 'in_progress', updatedAt: '2026-09-01T00:00:00.000Z' },
      ],
    })
    const v = computeOverview(rows, NOW)
    assert.equal(v.todos.pausedStalledTotal, 2)
    assert.deepEqual(v.todos.pausedStalled, [
      { assetId: 'c', title: '老得多', stalledDays: 74 },
      { assetId: 'b', title: '多一天', stalledDays: 30 },
    ]) // 最久的排前面；压线的、最近摸过的、归档的、在看的都不进
  } finally {
    s.cleanup()
  }
})

test('renewal windows: today opens the 7-day window; +7d and +30d bounds are exact; archived, missing and unparseable dates stay out', async () => {
  const s = scratch()
  try {
    const rows = await seed(s.dbPath, {
      subscriptions: [
        { id: 'a', name: '逾期旧的', nextRenewAt: '2026-11-01T00:00:00.000Z' },
        { id: 'b', name: '逾期近的', nextRenewAt: '2026-11-13T00:00:00.000Z' },
        { id: 'c', name: '今天到期', nextRenewAt: '2026-11-14T00:00:00.000Z' },
        { id: 'd', name: '窗口末尾', nextRenewAt: '2026-11-20T23:59:59.999Z' },
        { id: 'e', name: '恰逢+7天', nextRenewAt: '2026-11-21T00:00:00.000Z' },
        { id: 'f', name: '三十天内', nextRenewAt: '2026-12-13T00:00:00.000Z' },
        { id: 'g', name: '恰逢+30天', nextRenewAt: '2026-12-14T00:00:00.000Z' },
        { id: 'h', name: '已归档不算', nextRenewAt: '2026-11-10T00:00:00.000Z', lifecycle: 'archived' },
        { id: 'i', name: '没记日期', nextRenewAt: null },
        { id: 'j', name: '日期坏了', nextRenewAt: 'not-a-date' },
      ],
    })
    const v = computeOverview(rows, NOW)
    assert.deepEqual(v.todos.overdue.map((r) => r.name), ['逾期旧的', '逾期近的']) // sorted by date asc
    assert.deepEqual(v.todos.next7.map((r) => r.name), ['今天到期', '窗口末尾'])
    assert.equal(v.todos.next30Count, 2) // 恰逢+7天 and 三十天内; 恰逢+30天 is out
    assert.deepEqual(v.todos.overdue[0], { assetId: 'a', name: '逾期旧的', nextRenewAt: '2026-11-01T00:00:00.000Z' })
  } finally {
    s.cleanup()
  }
})

test('monthly estimate: yearly spreads by 12, currencies split, usage and unrecorded amounts count as unestimated', async () => {
  const s = scratch()
  try {
    const rows = await seed(s.dbPath, {
      subscriptions: [
        { id: 'a', name: '月付', cycle: 'monthly', amountMinor: 2000, currency: 'CNY' },
        { id: 'b', name: '年付', cycle: 'yearly', amountMinor: 12000, currency: 'CNY' },
        { id: 'c', name: '美元月付', cycle: 'monthly', amountMinor: 1000, currency: 'USD' },
        { id: 'd', name: '按量', cycle: 'usage', amountMinor: 500, currency: 'CNY' },
        { id: 'e', name: '没记钱', cycle: 'monthly', amountMinor: null, currency: 'CNY' },
        { id: 'f', name: '归档的不估', cycle: 'monthly', amountMinor: 9900, currency: 'CNY', lifecycle: 'archived' },
      ],
    })
    const v = computeOverview(rows, NOW)
    assert.deepEqual(v.overview.subscriptions.monthlyTotals, { CNY: 3000, USD: 1000 })
    assert.equal(v.overview.subscriptions.unestimated, 2)
    assert.equal(v.overview.subscriptions.active, 5)
  } finally {
    s.cleanup()
  }
})

test('completedThisMonth: local calendar month, counted by completed_at regardless of current status; bad dates stay silent', () => {
  // Built from LOCAL date parts so the expectation survives any machine zone.
  const now = new Date(2026, 10, 15, 12, 0) // 11 月 15 日中午
  const rows = {
    media: [
      { id: '1', completed_at: new Date(2026, 10, 10, 8, 0).toISOString(), status: 'dropped', lifecycle: 'active', updated_at: '' },
      { id: '2', completed_at: new Date(2026, 9, 30, 23, 0).toISOString(), status: 'completed', lifecycle: 'active', updated_at: '' },
      { id: '3', completed_at: new Date(2026, 11, 1, 0, 0).toISOString(), status: 'completed', lifecycle: 'active', updated_at: '' },
      { id: '4', completed_at: 'garbage', status: 'completed', lifecycle: 'active', updated_at: '' },
      { id: '5', completed_at: null, status: 'completed', lifecycle: 'active', updated_at: '' },
    ],
    subscriptions: [],
    software: [],
    lastChangeAt: null,
  }
  const v = computeOverview(rows, now)
  assert.equal(v.overview.media.completedThisMonth, 1) // 只算本月的那个，哪怕状态已是 dropped
})

test('media status counts exclude archived; in-progress recents sort by updated_at and map whitelisted fields', async () => {
  const s = scratch()
  try {
    const rows = await seed(s.dbPath, {
      media: [
        { id: 'ip1', title: '新看的', status: 'in_progress', updatedAt: '2026-11-10T00:00:00.000Z' },
        { id: 'ip2', title: '旧看的', status: 'in_progress', updatedAt: '2026-11-01T00:00:00.000Z' },
        { id: 'ip3', title: '归档的', status: 'in_progress', lifecycle: 'archived', updatedAt: '2026-11-12T00:00:00.000Z' },
        { id: 'p1', title: '想看的', status: 'planned', updatedAt: '2026-11-09T00:00:00.000Z' },
        { id: 'd1', title: '搁置的', status: 'paused', updatedAt: '2026-11-08T00:00:00.000Z' },
      ],
    })
    const v = computeOverview(rows, NOW)
    assert.deepEqual(v.overview.media, { total: 5, archived: 1, inProgress: 2, planned: 1, completedThisMonth: 0 })
    assert.equal(v.todos.inProgressTotal, 2)
    assert.deepEqual(v.todos.inProgressRecent, [
      { assetId: 'ip1', title: '新看的', mediaType: 'movie', year: null },
      { assetId: 'ip2', title: '旧看的', mediaType: 'movie', year: null },
    ])
  } finally {
    s.cleanup()
  }
})

test('software counts both statuses; journal lastAt passes through', async () => {
  const s = scratch()
  try {
    const rows = await seed(s.dbPath, {
      software: [
        { id: 's1', name: '在用' },
        { id: 's2', name: '也在用' },
        { id: 's3', name: '停了', status: 'retired' },
      ],
      changes: [{ at: '2026-11-14T10:00:00.000Z', module: 'software', assetId: 's1', name: '在用', action: 'create', summary: '新建' }],
    })
    const v = computeOverview(rows, NOW)
    assert.deepEqual(v.overview.software, { inUse: 2, retired: 1 })
    assert.equal(v.journal.lastAt, '2026-11-14T10:00:00.000Z')
  } finally {
    s.cleanup()
  }
})

test('registerOverviewRoute uses scoped inject: no web server means no callback and no library access', () => {
  let injectCalls = 0
  const ctx = {
    inject(_services, cb) {
      injectCalls += 1
      // Services absent — the cordis scoped inject simply never calls cb.
    },
  }
  registerOverviewRoute(
    ctx,
    () => {
      throw new Error('config must not even be read without a web server')
    },
    async () => {
      throw new Error('library must never open without a web server')
    },
  )
  assert.equal(injectCalls, 1)
})
