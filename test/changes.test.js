// Tests for the changes journal and the media_log_changes tool: the journal is
// written by the three business modules inside their own transactions, so these
// tests drive the REAL tools and read the REAL table.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.js'
import { exportLibrary } from '../scripts/export-library.mjs'
import { openLibrary, CHANGE_CAP } from '../src/db.js'

const UUID = '11111111-2222-3333-4444-555555555555'
const UUID2 = 'bbbbbbbb-2222-3333-4444-555555555555'

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'changes-test-'))
  return {
    dir,
    dbPath: join(dir, 'media.db'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

const exec = (signal) => ({ signal: signal ?? new AbortController().signal })
const render = (tool, args, value) => tool.output.render(args, value).map((b) => b.text).join('\n')

async function harness({ databasePath = '', writeEnabled = true } = {}) {
  const registered = new Map()
  apply({ tools: {
    register(tool) { registered.set(tool.name, tool) },
    get(name) { return registered.get(name) },
  } }, { databasePath, writeEnabled })
  const by = (name) => registered.get(name)
  return {
    tools: [...registered.values()],
    mark: by('media_log_mark'),
    changes: by('media_log_changes'),
    subMark: by('subscription_mark'),
    swMark: by('software_mark'),
  }
}

/** Reads the journal straight, for assertions the tool view would blur. */
async function journal(dbPath) {
  const db = await openLibrary(dbPath)
  try {
    return db.prepare('SELECT * FROM changes ORDER BY id').all()
  } finally {
    db.close()
  }
}

test('the host exposes 11 tools and exports only the supported tables', async () => {
  const s = scratch()
  try {
    const { tools, mark, changes } = await harness({ databasePath: s.dbPath })
    assert.deepEqual(tools.map((tool) => tool.name), [
      'media_log_mark', 'media_log_pick', 'media_log_search', 'media_log_get', 'media_log_list',
      'subscription_mark', 'subscription_list', 'subscription_get',
      'software_mark', 'software_list', 'software_get', 'media_log_changes',
    ])
    const written = await mark.execute({ target: { title: '新电影', mediaType: 'movie' } }, exec())
    assert.equal(written.ok, true)

    const history = await changes.execute({}, exec())
    assert.equal(history.ok, true)
    assert.deepEqual(history.data.items.map((row) => row.module), ['media'])

    const exported = await exportLibrary({ from: s.dbPath })
    const doc = JSON.parse(exported.json)
    assert.deepEqual(doc.counts, { media: 1, subscriptions: 0, software: 0, changes: 1 })
    assert.deepEqual(Object.keys(doc.tables), ['media', 'subscriptions', 'software', 'changes'])
    assert.equal(doc.library.userVersion, 7)
  } finally {
    s.cleanup()
  }
})

test('creates and updates are journaled across modules; unchanged writes are not', async () => {
  const s = scratch()
  try {
    const { mark, subMark, swMark } = await harness({ databasePath: s.dbPath })

    const media = await mark.execute(
      { target: { title: '沙丘2', mediaType: 'movie' }, status: 'completed', rating: 8, notes: '视听盛宴' },
      exec(),
    )
    assert.equal(media.ok, true)
    const id = media.data.receipt.assetId
    await mark.execute(
      { target: { assetId: id, expectedRevision: 1 }, status: 'in_progress' }, exec(),
    )
    // Re-submitting the same patch records nothing — nothing moved.
    await mark.execute(
      { target: { assetId: id, expectedRevision: 2 }, status: 'in_progress' }, exec(),
    )

    await subMark.execute(
      { target: { name: 'Netflix' }, cycle: 'monthly', amountMinor: 2000, currency: 'USD' }, exec(),
    )
    await swMark.execute(
      { target: { name: 'SubtitleEdit' }, purpose: '校准字幕' }, exec(),
    )
    const rows = await journal(s.dbPath)
    assert.equal(rows.length, 4, '3 creates + 1 update; the no-op is absent')
    assert.deepEqual(rows.map((r) => r.module), ['media', 'media', 'subscription', 'software'])
    assert.deepEqual(rows.map((r) => r.action), ['create', 'update', 'create', 'create'])

    const [mediaCreate, mediaUpdate] = rows
    assert.equal(mediaCreate.name, '沙丘2')
    assert.match(mediaCreate.summary, /状态=已看完\/玩完/)
    assert.match(mediaCreate.summary, /评分=8/)
    assert.match(mediaCreate.summary, /短评=已填写/)
    assert.doesNotMatch(mediaCreate.summary, /视听盛宴/, 'note text never enters the journal')
    assert.match(mediaUpdate.summary, /状态：已看完\/玩完→在看\/在玩/)

    const sub = rows[2]
    assert.match(sub.summary, /周期=月付/)
    assert.match(sub.summary, /金额=\$20\.00/)
    const sw = rows[3]
    assert.match(sw.summary, /用途=已填写/)
    assert.doesNotMatch(sw.summary, /校准字幕/, 'purpose text never enters the journal')
  } finally {
    s.cleanup()
  }
})

test('archives, retires and clears show up as moves; long text stays out', async () => {
  const s = scratch()
  try {
    const { mark, swMark } = await harness({ databasePath: s.dbPath })
    const media = await mark.execute(
      { target: { title: '沙丘2', mediaType: 'movie' }, status: 'completed', notes: '第一条' },
      exec(),
    )
    const id = media.data.receipt.assetId
    await mark.execute({ target: { assetId: id, expectedRevision: 1 }, lifecycle: 'archived' }, exec())
    await mark.execute(
      { target: { assetId: id, expectedRevision: 2 }, notes: '第二条', replaceNotes: true }, exec(),
    )
    await mark.execute(
      { target: { assetId: id, expectedRevision: 3 }, clear: ['notes'], replaceNotes: true }, exec(),
    )

    const software = await swMark.execute(
      { target: { name: '旧工具' }, purpose: '校准字幕' }, exec(),
    )
    await swMark.execute(
      { target: { assetId: software.data.receipt.assetId, expectedRevision: 1 }, status: 'retired' }, exec(),
    )
    await swMark.execute(
      { target: { assetId: software.data.receipt.assetId, expectedRevision: 2 }, purpose: '压缩扫描件' },
      exec(),
    )

    const rows = await journal(s.dbPath)
    const summaries = rows.map((r) => r.summary)
    assert.match(summaries[1], /归档：active→archived/)
    assert.match(summaries[2], /短评：原文→新文/, 'a replaced note is a move between sentinels')
    assert.match(summaries[3], /短评：原文→空/, 'a cleared note lands in the journal too')
    assert.match(summaries[5], /状态：在用→已停用/)
    assert.match(summaries[6], /用途：原文→新文/)
    for (const text of summaries) {
      assert.doesNotMatch(text, /校准字幕|压缩扫描件|第一条|第二条/)
    }
  } finally {
    s.cleanup()
  }
})

test('the journal is capped at CHANGE_CAP rows, oldest falling off', async () => {
  const s = scratch()
  try {
    // Seed the cap plus change directly, then let one real write push the
    // oldest row out.
    const db = await openLibrary(s.dbPath)
    const ins = db.prepare(
      `INSERT INTO changes (at, module, asset_id, name, action, summary)
       VALUES (?, 'media', 'x', '旧记录', 'update', '填充')`,
    )
    for (let i = 0; i < CHANGE_CAP + 20; i += 1) ins.run(`2020-01-01T00:00:${String(i % 60).padStart(2, '0')}.${String(i).padStart(6, '0')}Z`)
    db.close()

    const { mark, changes } = await harness({ databasePath: s.dbPath })
    const value = await mark.execute(
      { target: { title: '新的', mediaType: 'movie' }, status: 'planned' }, exec(),
    )
    assert.equal(value.ok, true)

    const rows = await journal(s.dbPath)
    assert.equal(rows.length, CHANGE_CAP, 'the cap holds')
    assert.equal(rows[rows.length - 1].name, '新的', 'the newest row survived')
    assert.equal(rows[0].name, '旧记录', 'and it is the first of the seeded ones that survived')

    const page = await changes.execute({ limit: 20, offset: CHANGE_CAP - 20 }, exec())
    assert.equal(page.data.total, CHANGE_CAP, 'an exhausted window names the cap as the total')
    assert.match(render(changes, { limit: 20, offset: CHANGE_CAP - 20 }, page), /只保留最近 500 条/)
  } finally {
    s.cleanup()
  }
})

test('media_log_changes: newest first, module filter, empty-library honesty', async () => {
  const s = scratch()
  try {
    const { changes } = await harness({ databasePath: s.dbPath })
    const empty = await changes.execute({}, exec())
    assert.equal(empty.ok, true)
    assert.deepEqual(empty.data.items, [])
    assert.match(render(changes, {}, empty), /从装上这一版才开始记/)

    const h = await harness({ databasePath: s.dbPath })
    await h.mark.execute({ target: { title: '第一部', mediaType: 'movie' }, status: 'planned' }, exec())
    await h.subMark.execute({ target: { name: 'Netflix' }, cycle: 'monthly' }, exec())
    await h.mark.execute({ target: { title: '第二部', mediaType: 'movie' }, status: 'planned' }, exec())

    const page = await changes.execute({ limit: 2 }, exec())
    assert.equal(page.data.items.length, 2)
    assert.equal(page.data.total, null, 'a window that is not exhausted proves nothing')
    assert.deepEqual(page.data.items.map((r) => r.name), ['第二部', 'Netflix'], 'newest first')
    assert.match(render(changes, { limit: 2 }, page), /结果未穷尽/)

    const onlyMedia = await changes.execute({ module: 'media', limit: 20 }, exec())
    assert.deepEqual(onlyMedia.data.items.map((r) => r.name), ['第二部', '第一部'])
    assert.match(render(changes, { module: 'media' }, onlyMedia), /只看媒体/)

    const overrun = await changes.execute({ limit: 2, offset: 9 }, exec())
    assert.match(render(changes, { offset: 9 }, overrun), /越过末页/)

    // A create line carries its initial values, not just the word 新建.
    const text = render(changes, { limit: 1 }, await changes.execute({ limit: 1 }, exec()))
    assert.match(text, /新建（状态=想看\/想玩/, 'the initial values ride along')
    assert.match(text, /《第二部》/)
  } finally {
    s.cleanup()
  }
})

test('media_log_changes: argument validation runs before the library is even opened', async () => {
  const s = scratch()
  try {
    const { changes } = await harness({ databasePath: s.dbPath })
    for (const bad of [
      { module: 'everything' },
      { module: 'info' },
      { limit: 0 },
      { offset: -1 },
      { nope: 1 },
    ]) {
      const value = await changes.execute(bad, exec())
      assert.equal(value.ok, false, JSON.stringify(bad))
      assert.equal(value.error.code, 'INVALID_ARGUMENT', JSON.stringify(bad))
    }
  } finally {
    s.cleanup()
  }
})

test('a rolled-back write leaves no journal trace', async () => {
  const s = scratch()
  try {
    const { mark } = await harness({ databasePath: s.dbPath })
    // A progress patch the schema CHECK rejects mid-transaction.
    const value = await mark.execute(
      {
        target: { title: '沙丘2', mediaType: 'movie' },
        status: 'in_progress',
        progress: { current: 10, total: 5 },
      },
      exec(),
    )
    assert.equal(value.ok, false)
    const rows = await journal(s.dbPath)
    assert.deepEqual(rows, [], 'the journal row rolled back with the write')
  } finally {
    s.cleanup()
  }
})
