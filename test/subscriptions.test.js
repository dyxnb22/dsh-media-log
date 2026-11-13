// Tests for the subscription_* tools against a REAL SQLite library in a temp
// directory: no mocks, no fixtures, no subprocess. Each test builds its own
// library through the same openLibrary() the plugin uses.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSubscriptionTools } from '../src/subscription-tools.js'
import { openLibrary, createLibraryHolder } from '../src/db.js'

const UUID = '11111111-2222-3333-4444-555555555555'
const UUID2 = 'bbbbbbbb-2222-3333-4444-555555555555'

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'subscription-test-'))
  return {
    dir,
    dbPath: join(dir, 'media.db'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/** Config + a fresh library, wired exactly like src/index.js does. */
async function harness({ databasePath = '', writeEnabled = true } = {}) {
  const getLibrary = createLibraryHolder()
  const tools = createSubscriptionTools(() => ({ databasePath, writeEnabled }), getLibrary)
  const [mark, list, get] = tools
  return { mark, list, get, getLibrary }
}

const exec = (signal) => ({ signal: signal ?? new AbortController().signal })
const render = (tool, args, value) => tool.output.render(args, value).map((b) => b.text).join('\n')
const names = (page) => page.data.items.map((i) => i.name).sort()

/** Inserts rows straight through SQL — via the REAL openLibrary, so the tests
 *  exercise the production schema rather than a copy that could drift. */
async function seed(dbPath, rows) {
  const db = await openLibrary(dbPath)
  const st = db.prepare(
    `INSERT INTO subscriptions (id, name, provider, amount_minor, currency, cycle,
       next_renew_at, expires_at, auto_renew, notes, lifecycle, revision,
       archived_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const now = new Date().toISOString()
  for (const r of rows) {
    st.run(
      r.id,
      r.name,
      r.provider ?? null,
      r.amount_minor ?? null,
      r.currency ?? 'CNY',
      r.cycle,
      r.next_renew_at ?? null,
      r.expires_at ?? null,
      r.auto_renew ?? 1,
      r.notes ?? null,
      r.lifecycle ?? 'active',
      r.revision ?? 1,
      r.archived_at ?? null,
      r.created_at ?? now,
      r.updated_at ?? now,
    )
  }
  db.close()
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

test('create: records the price in minor units with its currency and cycle', async () => {
  const s = scratch()
  try {
    const { mark, get } = await harness({ databasePath: s.dbPath })
    const value = await mark.execute(
      {
        target: { name: 'Netflix' },
        cycle: 'monthly',
        amountMinor: 2000,
        currency: 'USD',
        nextRenewAt: '2026-12-10',
      },
      exec(),
    )
    assert.equal(value.ok, true)
    assert.equal(value.data.receipt.outcome, 'created')
    assert.equal(value.data.receipt.revision, 1)
    const detail = await get.execute({ assetId: value.data.receipt.assetId }, exec())
    assert.equal(detail.data.name, 'Netflix')
    assert.equal(detail.data.amountMinor, 2000)
    assert.equal(detail.data.currency, 'USD')
    assert.equal(detail.data.cycle, 'monthly')
    assert.equal(detail.data.nextRenewAt, '2026-12-10T00:00:00.000Z')
    assert.equal(detail.data.autoRenew, true)
    const text = render(mark, {}, value)
    assert.match(text, /已记下《Netflix》，月付，\$20\.00，下次续费 2026-12-10/)
  } finally {
    s.cleanup()
  }
})

test('create: an unknown price stays empty instead of becoming zero', async () => {
  const s = scratch()
  try {
    const { mark, get, list } = await harness({ databasePath: s.dbPath })
    const value = await mark.execute(
      { target: { name: '某 API' }, cycle: 'usage' }, exec(),
    )
    assert.equal(value.ok, true)
    const detail = await get.execute({ assetId: value.data.receipt.assetId }, exec())
    assert.equal(detail.data.amountMinor, null, 'null means unknown')
    assert.equal(detail.data.monthlyMinor, null, 'and it is not estimated')
    assert.match(render(mark, {}, value), /金额未记/)

    // A free tier IS a price, and is kept distinct from "unknown".
    const free = await mark.execute(
      { target: { name: '免费档' }, cycle: 'monthly', amountMinor: 0 }, exec(),
    )
    assert.equal(free.ok, true)
    const freeDetail = await get.execute({ assetId: free.data.receipt.assetId }, exec())
    assert.equal(freeDetail.data.amountMinor, 0)
    assert.equal(freeDetail.data.monthlyMinor, 0)

    const page = await list.execute({}, exec())
    assert.equal(page.data.estimateExcluded, 1, 'only the unrecorded one is excluded')
    assert.deepEqual(page.data.monthlyTotals, { CNY: 0 })
  } finally {
    s.cleanup()
  }
})

test('create: an existing name stops the write and names the record to update', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, [
      { id: UUID, name: 'Netflix', cycle: 'monthly', amount_minor: 2000, currency: 'USD' },
    ])
    const { mark, get } = await harness({ databasePath: s.dbPath })
    const value = await mark.execute(
      { target: { name: 'Netflix' }, cycle: 'monthly' }, exec(),
    )
    assert.equal(value.error.code, 'TARGET_CONFLICT')
    assert.equal(value.error.candidates.length, 1)
    assert.equal(value.error.candidates[0].assetId, UUID)
    const text = render(mark, { target: { name: 'Netflix' } }, value)
    assert.match(text, /改用它的 assetId 更新/)
    assert.equal((await get.execute({ assetId: UUID }, exec())).data.revision, 1)
  } finally {
    s.cleanup()
  }
})

test('create: the cycle is asked for rather than guessed', async () => {
  const s = scratch()
  try {
    const { mark } = await harness({ databasePath: s.dbPath })
    const value = await mark.execute({ target: { name: 'Netflix' } }, exec())
    assert.equal(value.error.code, 'INVALID_ARGUMENT')
    assert.match(value.error.message, /cycle/)
  } finally {
    s.cleanup()
  }
})

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

test('update: the whole loop — correct the price, cancel auto-renew, archive', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, [
      {
        id: UUID,
        name: 'Claude Pro',
        cycle: 'monthly',
        amount_minor: 14500,
        currency: 'CNY',
        next_renew_at: '2026-12-01T00:00:00.000Z',
        revision: 1,
      },
    ])
    const { mark, get } = await harness({ databasePath: s.dbPath })

    const priced = await mark.execute(
      { target: { assetId: UUID, expectedRevision: 1 }, amountMinor: 15000 }, exec(),
    )
    assert.equal(priced.ok, true)
    assert.equal(priced.data.receipt.revision, 2)

    const dated = await mark.execute(
      { target: { assetId: UUID, expectedRevision: 2 }, nextRenewAt: '2026-12-15' }, exec(),
    )
    assert.equal(dated.ok, true)
    // No confirmation dance for money or dates — they are facts, not prose.
    assert.equal(dated.data.receipt.revision, 3)

    const cancelled = await mark.execute(
      { target: { assetId: UUID, expectedRevision: 3 }, autoRenew: false, expiresAt: '2027-01-15' },
      exec(),
    )
    assert.equal(cancelled.ok, true)
    const afterCancel = await get.execute({ assetId: UUID }, exec())
    assert.equal(afterCancel.data.autoRenew, false)
    assert.equal(afterCancel.data.expiresAt, '2027-01-15T00:00:00.000Z')
    assert.equal(afterCancel.data.nextRenewAt, '2026-12-15T00:00:00.000Z',
      'cancelling auto-renew does not move the renewal date')

    const archived = await mark.execute(
      { target: { assetId: UUID, expectedRevision: 4 }, lifecycle: 'archived' }, exec(),
    )
    assert.equal(archived.ok, true)
    const afterArchive = await get.execute({ assetId: UUID }, exec())
    assert.equal(afterArchive.data.lifecycle, 'archived')
    assert.ok(Number.isFinite(Date.parse(afterArchive.data.archivedAt ?? '')))
    assert.equal(afterArchive.data.name, 'Claude Pro', 'archiving keeps the record')

    const restored = await mark.execute(
      { target: { assetId: UUID, expectedRevision: 5 }, lifecycle: 'active' }, exec(),
    )
    assert.equal(restored.ok, true)
    const afterRestore = await get.execute({ assetId: UUID }, exec())
    assert.equal(afterRestore.data.lifecycle, 'active')
    assert.equal(afterRestore.data.archivedAt, null, 'restoring clears the archive date')
    assert.equal(afterRestore.data.amountMinor, 15000)
    assert.equal(afterRestore.data.expiresAt, '2027-01-15T00:00:00.000Z')
  } finally {
    s.cleanup()
  }
})

test('update: a renewal records the supplied fact and the named next date, never a derivation', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, [
      { id: UUID, name: 'Netflix', cycle: 'monthly', amount_minor: 2000, currency: 'USD', next_renew_at: '2026-11-10T00:00:00.000Z', revision: 1 },
    ])
    const { mark, get, list } = await harness({ databasePath: s.dbPath })
    // The user says it renewed on the 20th with the next one on 2027-01-20.
    const renewed = await mark.execute(
      { target: { assetId: UUID, expectedRevision: 1 }, nextRenewAt: '2027-01-20' }, exec(),
    )
    assert.equal(renewed.ok, true)
    const detail = await get.execute({ assetId: UUID }, exec())
    assert.equal(detail.data.nextRenewAt, '2027-01-20T00:00:00.000Z')
    // Nothing invented a date of its own, and the list agrees.
    const page = await list.execute({}, exec())
    assert.deepEqual(page.data.items.map((i) => i.nextRenewAt), ['2027-01-20T00:00:00.000Z'])
  } finally {
    s.cleanup()
  }
})

test('update: an identical patch is unchanged, and clear empties what it names', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, [
      {
        id: UUID,
        name: 'Claude Pro',
        provider: 'Anthropic',
        cycle: 'yearly',
        amount_minor: 144000,
        currency: 'CNY',
        next_renew_at: '2027-06-01T00:00:00.000Z',
        expires_at: '2027-06-01T00:00:00.000Z',
        notes: '主力',
        revision: 3,
      },
    ])
    const { mark, get } = await harness({ databasePath: s.dbPath })

    const again = await mark.execute(
      { target: { assetId: UUID, expectedRevision: 3 }, amountMinor: 144000 }, exec(),
    )
    assert.equal(again.data.receipt.outcome, 'unchanged')
    assert.equal(again.data.receipt.revision, 3)

    const cleared = await mark.execute(
      { target: { assetId: UUID, expectedRevision: 3 }, clear: ['amountMinor', 'expiresAt', 'provider'] },
      exec(),
    )
    assert.equal(cleared.ok, true)
    const detail = await get.execute({ assetId: UUID, includeNotes: true }, exec())
    assert.equal(detail.data.amountMinor, null)
    assert.equal(detail.data.expiresAt, null)
    assert.equal(detail.data.provider, null)
    assert.equal(detail.data.hasNotes, true, 'notes were not in clear')
    assert.equal(detail.data.monthlyMinor, null, 'an unknown amount is not estimated')

    // Emptying an already-empty field changes nothing at all.
    const twice = await mark.execute(
      { target: { assetId: UUID, expectedRevision: 4 }, clear: ['amountMinor'] }, exec(),
    )
    assert.equal(twice.data.receipt.outcome, 'unchanged')
  } finally {
    s.cleanup()
  }
})

test('update: clearing a note needs the same confirmation as replacing one', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, [
      { id: UUID, name: 'Claude Pro', cycle: 'monthly', notes: '主力', revision: 1 },
    ])
    const { mark, get } = await harness({ databasePath: s.dbPath })
    const stopped = await mark.execute(
      { target: { assetId: UUID, expectedRevision: 1 }, clear: ['notes'] }, exec(),
    )
    assert.equal(stopped.error.code, 'CONFIRMATION_REQUIRED')
    assert.equal((await get.execute({ assetId: UUID }, exec())).data.revision, 1)
    const confirmed = await mark.execute(
      { target: { assetId: UUID, expectedRevision: 1 }, clear: ['notes'], replaceNotes: true }, exec(),
    )
    assert.equal(confirmed.ok, true)
    assert.equal((await get.execute({ assetId: UUID }, exec())).data.hasNotes, false)
  } finally {
    s.cleanup()
  }
})

test('update: a stale revision is refused and names the current one', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, [
      { id: UUID, name: 'Claude Pro', cycle: 'monthly', revision: 4 },
    ])
    const { mark } = await harness({ databasePath: s.dbPath })
    const stale = await mark.execute(
      { target: { assetId: UUID, expectedRevision: 3 }, amountMinor: 1 }, exec(),
    )
    assert.equal(stale.error.code, 'STALE_REVISION')
    assert.equal(stale.error.currentRevision, 4)
  } finally {
    s.cleanup()
  }
})

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

test('list: a renewal window includes its start and excludes its end, across both date spellings', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, [
      { id: UUID, name: 'imported-spelling', cycle: 'monthly', next_renew_at: '2026-12-01T00:00:00+00:00' },
      { id: UUID2, name: 'written-here', cycle: 'monthly', next_renew_at: '2026-12-01T00:00:00.000Z' },
      { id: 'cccccccc-2222-3333-4444-555555555555', name: 'no-date', cycle: 'monthly' },
      { id: 'dddddddd-2222-3333-4444-555555555555', name: 'earlier', cycle: 'monthly', next_renew_at: '2026-11-20T00:00:00.000Z' },
      { id: 'eeeeeeee-2222-3333-4444-555555555555', name: 'later', cycle: 'monthly', next_renew_at: '2027-01-05T00:00:00.000Z' },
    ])
    const { list } = await harness({ databasePath: s.dbPath })
    const ask = async (extra) => names(await list.execute(extra, exec()))

    assert.deepEqual(
      await ask({ renewFrom: '2026-12-01' }),
      ['imported-spelling', 'later', 'written-here'],
      'the start is inclusive, and a record without the date never enters a range',
    )
    assert.deepEqual(
      await ask({ renewBefore: '2026-12-01' }),
      ['earlier'],
      'the end is exclusive — text comparison would have kept both boundary rows',
    )
    // 2026-12-01T08:00:00+08:00 IS 2026-12-01T00:00:00Z; read as a bare UTC
    // datetime the bound would sit eight hours later and both would slip in.
    assert.deepEqual(await ask({ renewBefore: '2026-12-01T08:00:00+08:00' }), ['earlier'])
  } finally {
    s.cleanup()
  }
})

test('list: what renews in the next 30 days, ordered by the soonest date', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, [
      { id: UUID, name: '远的', cycle: 'monthly', next_renew_at: '2027-06-01T00:00:00.000Z' },
      { id: UUID2, name: '近的', cycle: 'monthly', next_renew_at: '2026-11-25T00:00:00.000Z' },
      { id: 'cccccccc-2222-3333-4444-555555555555', name: '没日期', cycle: 'monthly' },
    ])
    const { list } = await harness({ databasePath: s.dbPath })
    const page = await list.execute(
      { renewFrom: '2026-11-10', renewBefore: '2026-12-10' }, exec(),
    )
    assert.deepEqual(page.data.items.map((i) => i.name), ['近的'])
    const text = render(list, { renewFrom: '2026-11-10', renewBefore: '2026-12-10' }, page)
    assert.match(text, /下次续费在 2026-11-10 到 2026-12-10 之间/, 'the window is echoed back')

    // Rows without a date sort last rather than pretending to be soonest.
    const all = await list.execute({}, exec())
    assert.deepEqual(all.data.items.map((i) => i.name), ['近的', '远的', '没日期'])
  } finally {
    s.cleanup()
  }
})

test('list: the monthly estimate is computed over every match, not just the page', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, [
      { id: UUID, name: '月付 CNY', cycle: 'monthly', amount_minor: 10000, currency: 'CNY' },
      { id: UUID2, name: '年付 CNY', cycle: 'yearly', amount_minor: 120000, currency: 'CNY' },
      { id: 'cccccccc-2222-3333-4444-555555555555', name: '月付 USD', cycle: 'monthly', amount_minor: 500, currency: 'USD' },
      { id: 'dddddddd-2222-3333-4444-555555555555', name: '按量', cycle: 'usage', amount_minor: 300, currency: 'CNY' },
      { id: 'eeeeeeee-2222-3333-4444-555555555555', name: '未知', cycle: 'monthly' },
    ])
    const { list } = await harness({ databasePath: s.dbPath })
    const page = await list.execute({ limit: 2 }, exec())
    assert.equal(page.data.items.length, 2)
    assert.equal(page.data.total, null, 'a window that is not exhausted proves nothing')
    // The totals cover all five matches even though only two are on screen.
    assert.deepEqual(page.data.monthlyTotals, { CNY: 20000, USD: 500 })
    assert.equal(page.data.estimateExcluded, 2, 'usage-based and unrecorded are both excluded')
    const text = render(list, { limit: 2 }, page)
    assert.match(text, /按月均估算合计：¥200\.00\/月，\$5\.00\/月/)
    assert.match(text, /按量付费和未记金额的 2 条不计入/)

    // A yearly row's estimate is the spread, and its own price is still shown.
    const yearly = await list.execute({ name: '年付' }, exec())
    const item = yearly.data.items[0]
    assert.equal(item.amountMinor, 120000)
    assert.equal(item.monthlyMinor, 10000)
    assert.match(render(list, { name: '年付' }, yearly), /《年付 CNY》（年付，¥1200\.00，月均约 ¥100\.00/)
  } finally {
    s.cleanup()
  }
})

test('list: lifecycle defaults to active; archived and all are explicit', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, [
      { id: UUID, name: '在用的', cycle: 'monthly' },
      { id: UUID2, name: '停了的', cycle: 'monthly', lifecycle: 'archived' },
    ])
    const { list } = await harness({ databasePath: s.dbPath })
    assert.deepEqual(names(await list.execute({}, exec())), ['在用的'])
    assert.deepEqual(names(await list.execute({ lifecycle: 'archived' }, exec())), ['停了的'])
    const all = await list.execute({ lifecycle: 'all' }, exec())
    // The tool's own order is by id; names() would re-sort by codepoint.
    assert.deepEqual(all.data.items.map((i) => i.name), ['在用的', '停了的'])
    assert.match(render(list, { lifecycle: 'all' }, all), /含已归档/)
  } finally {
    s.cleanup()
  }
})

test('list: an empty page is a success, and an over-run page says so', async () => {
  const s = scratch()
  try {
    const { list } = await harness({ databasePath: s.dbPath })
    const empty = await list.execute({}, exec())
    assert.equal(empty.ok, true)
    assert.deepEqual(empty.data.items, [])
    assert.equal(empty.data.total, 0)
    assert.match(render(list, {}, empty), /没有符合条件的订阅/)

    await seed(s.dbPath, [{ id: UUID, name: '在用的', cycle: 'monthly' }])
    const past = await list.execute({ limit: 2, offset: 5 }, exec())
    assert.equal(past.ok, true)
    assert.deepEqual(past.data.items, [])
    const text = render(list, { limit: 2, offset: 5 }, past)
    assert.match(text, /这一页是空的/)
    assert.doesNotMatch(text, /没有符合条件的订阅/, 'an over-run page is not an empty library')
  } finally {
    s.cleanup()
  }
})

test('list: filters narrow by cycle, currency, autoRenew and a name substring', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, [
      { id: UUID, name: 'Netflix', cycle: 'monthly', currency: 'USD', auto_renew: 1 },
      { id: UUID2, name: 'iCloud+', cycle: 'yearly', currency: 'CNY', auto_renew: 0 },
      { id: 'cccccccc-2222-3333-4444-555555555555', name: 'Netflix 旧套餐', cycle: 'monthly', currency: 'USD', auto_renew: 0 },
    ])
    const { list } = await harness({ databasePath: s.dbPath })
    assert.deepEqual(names(await list.execute({ cycle: 'yearly' }, exec())), ['iCloud+'])
    assert.deepEqual(names(await list.execute({ currency: 'USD' }, exec())), ['Netflix', 'Netflix 旧套餐'])
    assert.deepEqual(names(await list.execute({ autoRenew: false }, exec())), ['Netflix 旧套餐', 'iCloud+'])
    assert.deepEqual(names(await list.execute({ autoRenew: true }, exec())), ['Netflix'])
    assert.deepEqual(names(await list.execute({ name: 'Netflix' }, exec())), ['Netflix', 'Netflix 旧套餐'])
    // % and _ in the name match literally.
    assert.deepEqual(names(await list.execute({ name: 'iCloud+' }, exec())), ['iCloud+'])
    assert.deepEqual(names(await list.execute({ name: '%' }, exec())), [])
  } finally {
    s.cleanup()
  }
})

// ---------------------------------------------------------------------------
// get / argument validation
// ---------------------------------------------------------------------------

test('get: notes excluded by default, and a past renewal date is not a claim', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, [
      {
        id: UUID,
        name: 'Claude Pro',
        cycle: 'monthly',
        amount_minor: 14500,
        currency: 'CNY',
        next_renew_at: '2020-01-01T00:00:00.000Z',
        notes: 'x'.repeat(2500),
        revision: 2,
      },
    ])
    const { get } = await harness({ databasePath: s.dbPath })
    const bare = await get.execute({ assetId: UUID }, exec())
    assert.equal('notes' in bare.data, false)
    assert.equal(bare.data.hasNotes, true)
    const full = await get.execute({ assetId: UUID, includeNotes: true }, exec())
    assert.equal(full.data.notes.length, 2000)
    assert.equal(full.data.notesTruncated, true)

    const text = render(get, { assetId: UUID }, full)
    assert.match(text, /登记的下次续费日期已过/)
    assert.match(text, /是否真的扣款或失效请以服务方为准/)
    assert.doesNotMatch(text, /已失效|已扣款/)

    // The schema gate only checks the type, so a malformed UUID reaches the
    // plugin's own validator and comes back as a clean value.
    const malformed = await get.execute({ assetId: 'nope' }, exec())
    assert.equal(malformed.error.code, 'INVALID_ARGUMENT')
    const unknown = await get.execute(
      { assetId: '99999999-2222-3333-4444-555555555555' }, exec(),
    )
    assert.equal(unknown.error.code, 'NOT_FOUND')
  } finally {
    s.cleanup()
  }
})

test('argument validation runs before the library is even opened', async () => {
  const s = scratch()
  try {
    const { mark, list } = await harness({ databasePath: s.dbPath })
    for (const [tool, bad] of [
      [mark, { target: { name: 'Netflix' } }],
      [mark, { target: { name: 'Netflix' }, cycle: 'weekly' }],
      [mark, { target: { name: 'Netflix' }, cycle: 'monthly', currency: 'EUR' }],
      [mark, { target: { name: 'Netflix' }, cycle: 'monthly', amountMinor: -1 }],
      [mark, { target: { name: 'Netflix' }, cycle: 'monthly', nextRenewAt: '下个月' }],
      [mark, { target: { name: 'Netflix' }, cycle: 'monthly', nextRenewAt: '2026-12-10T00:00:00' }],
      [mark, { target: { name: 'Netflix' }, cycle: 'monthly', clear: [] }],
      [mark, { target: { name: 'Netflix' }, cycle: 'monthly', clear: ['cycle'] }],
      [mark, { target: { name: 'Netflix' }, cycle: 'monthly', lifecycle: 'archived' }],
      [mark, { target: { assetId: UUID, expectedRevision: 1 } }],
      [mark, { target: { assetId: UUID, expectedRevision: 1 }, amountMinor: 1, clear: ['amountMinor'] }],
      [mark, { target: { assetId: UUID, name: 'Netflix' }, cycle: 'monthly' }],
      [mark, { target: { name: 'Netflix', expectedRevision: 1 }, cycle: 'monthly' }],
      [list, { renewFrom: '2026-13-01' }],
      [list, { renewFrom: '2026-12-10', renewBefore: '2026-11-10' }],
      [list, { lifecycle: 'deleted' }],
      [list, { limit: 0 }],
    ]) {
      const value = await tool.execute(bad, exec())
      assert.equal(value.ok, false, JSON.stringify(bad))
      assert.equal(value.error.code, 'INVALID_ARGUMENT', JSON.stringify(bad))
    }
    // Wrong SHAPES are caught by defineTool's schema gate, which throws.
    await assert.rejects(
      mark.execute({ target: { name: 'Netflix' }, cycle: 'monthly', clear: 'notes' }, exec()),
      /must be an array/,
    )
    await assert.rejects(
      mark.execute({ target: { name: 'Netflix' }, cycle: 'monthly', amountMinor: 20.5 }, exec()),
      /must be an integer/,
    )
    await assert.rejects(
      mark.execute({ target: { name: 'Netflix' }, cycle: 'monthly', autoRenew: 'yes' }, exec()),
      /must be a boolean/,
    )
    await assert.rejects(
      mark.execute({ target: { name: 'Netflix', nope: 1 }, cycle: 'monthly' }, exec()),
      /not a declared property/,
    )
    assert.throws(() => statSync(s.dbPath), 'a rejected call must not create the library')
  } finally {
    s.cleanup()
  }
})

test('writes stay off until writeEnabled is on', async () => {
  const s = scratch()
  try {
    const { mark } = await harness({ databasePath: s.dbPath, writeEnabled: false })
    const value = await mark.execute(
      { target: { name: 'Netflix' }, cycle: 'monthly' }, exec(),
    )
    assert.equal(value.error.code, 'WRITE_DISABLED')
    // Reads are not gated.
    const { list } = await harness({ databasePath: s.dbPath, writeEnabled: false })
    assert.equal((await list.execute({}, exec())).ok, true)
  } finally {
    s.cleanup()
  }
})

test('the three subscription tools are registered with the expected names', () => {
  const tools = createSubscriptionTools(() => ({ databasePath: '', writeEnabled: false }), async () => {
    throw new Error('unused')
  })
  assert.deepEqual(tools.map((t) => t.name), [
    'subscription_mark',
    'subscription_list',
    'subscription_get',
  ])
})
