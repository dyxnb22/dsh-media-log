// Tests for the software_* tools and cross-module use against a REAL SQLite library in a
// temp directory: no mocks, no fixtures, no subprocess.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { statSync } from 'node:fs'
import { createSoftwareTools } from '../src/software.js'
import { createSubscriptionTools } from '../src/subscription-tools.js'
import { openLibrary, createLibraryHolder } from '../src/db.js'
import { scratch, exec, render, byName } from './helpers.js'

const UUID = '11111111-2222-3333-4444-555555555555'
const UUID2 = 'bbbbbbbb-2222-3333-4444-555555555555'

async function harness(dbPath = '', writeEnabled = true) {
  const getLibrary = createLibraryHolder()
  const software = createSoftwareTools(() => ({ databasePath: dbPath, writeEnabled }), getLibrary)
  const subscriptions = createSubscriptionTools(() => ({ databasePath: dbPath, writeEnabled }), getLibrary)
  return {
    software,
    mark: byName(software, 'software_mark'),
    list: byName(software, 'software_list'),
    get: byName(software, 'software_get'),
    subMark: byName(subscriptions, 'subscription_mark'),
    subList: byName(subscriptions, 'subscription_list'),
  }
}

/** Inserts rows straight through SQL — via the REAL openLibrary, so the tests
 *  exercise the production schema rather than a copy that could drift. */
async function seedSoftware(dbPath, rows) {
  const db = await openLibrary(dbPath)
  const st = db.prepare(
    `INSERT INTO software (id, name, category, purpose, source_url, version, platform,
       notes, status, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const now = new Date().toISOString()
  for (const r of rows) {
    st.run(
      r.id, r.name, r.category ?? null, r.purpose ?? null, r.source_url ?? null,
      r.version ?? null, r.platform ?? null, r.notes ?? null,
      r.status ?? 'in_use', r.revision ?? 1, r.created_at ?? now, r.updated_at ?? now,
    )
  }
  db.close()
}

// ---------------------------------------------------------------------------
// software: the purpose is the point
// ---------------------------------------------------------------------------

test('software: the purpose is required, and the list answers by purpose', async () => {
  const s = scratch()
  try {
    const { mark, list, get } = await harness(s.dbPath)
    const noPurpose = await mark.execute({ target: { name: '某个工具' } }, exec())
    assert.equal(noPurpose.error.code, 'INVALID_ARGUMENT')
    assert.match(noPurpose.error.message, /purpose/)

    const value = await mark.execute(
      {
        target: { name: 'PDF 压缩工具' },
        purpose: '把扫描件压到能发邮件的大小',
        category: '工具',
        sourceUrl: 'https://example.com/pdf',
        version: '3.2',
        platform: 'macOS',
      },
      exec(),
    )
    assert.equal(value.ok, true)
    const detail = await get.execute({ assetId: value.data.receipt.assetId }, exec())
    assert.equal(detail.data.purpose, '把扫描件压到能发邮件的大小')
    assert.equal(detail.data.sourceUrl, 'https://example.com/pdf')
    assert.equal(detail.data.status, 'in_use')

    // "以前处理字幕用的是什么？" is a question about the purpose.
    const byText = await list.execute({ text: '字幕' }, exec())
    assert.deepEqual(byText.data.items.map((i) => i.name), [])
    await seedSoftware(s.dbPath, [
      { id: UUID, name: 'SubtitleEdit', purpose: '处理和校准字幕时间轴', category: '工具' },
      { id: UUID2, name: 'Mkvtoolnix', purpose: '把字幕封进 MKV', category: '工具' },
    ])
    const found = await list.execute({ text: '字幕' }, exec())
    assert.deepEqual(found.data.items.map((i) => i.name).sort(), ['Mkvtoolnix', 'SubtitleEdit'])
    const text = render(list, { text: '字幕' }, found)
    assert.match(text, /和「字幕」有关/)
    assert.match(text, /用途：处理和校准字幕时间轴/)
    // The list never claims anything about the machine.
    assert.match(text, /不代表本机装了什么/)
  } finally {
    s.cleanup()
  }
})

test('software: retiring keeps the purpose and the notes', async () => {
  const s = scratch()
  try {
    await seedSoftware(s.dbPath, [
      {
        id: UUID,
        name: '旧转换器',
        purpose: '以前用来转格式',
        notes: '对新格式无效',
        revision: 1,
      },
    ])
    const { mark, get, list } = await harness(s.dbPath)
    const retired = await mark.execute(
      { target: { assetId: UUID, expectedRevision: 1 }, status: 'retired' }, exec(),
    )
    assert.equal(retired.ok, true)
    const detail = await get.execute({ assetId: UUID, includeNotes: true }, exec())
    assert.equal(detail.data.status, 'retired')
    assert.equal(detail.data.purpose, '以前用来转格式', 'retiring keeps the purpose')
    assert.equal(detail.data.hasNotes, true, 'and the notes')

    assert.deepEqual((await list.execute({}, exec())).data.items, [], 'hidden by default')
    const shown = await list.execute({ status: 'retired' }, exec())
    assert.equal(shown.data.items.length, 1)
    assert.match(render(list, { status: 'retired' }, shown), /只看已停用/)

    const back = await mark.execute(
      { target: { assetId: UUID, expectedRevision: 2 }, status: 'in_use' }, exec(),
    )
    assert.equal(back.ok, true)
    assert.equal((await list.execute({}, exec())).data.items.length, 1)
  } finally {
    s.cleanup()
  }
})

test('software: a version change does not lose the purpose, and clear empties', async () => {
  const s = scratch()
  try {
    await seedSoftware(s.dbPath, [
      {
        id: UUID,
        name: 'PDF 压缩工具',
        category: '工具',
        purpose: '压扫描件',
        source_url: 'https://example.com',
        version: '3.2',
        platform: 'macOS',
        revision: 1,
      },
    ])
    const { mark, get } = await harness(s.dbPath)
    const bumped = await mark.execute(
      { target: { assetId: UUID, expectedRevision: 1 }, version: '4.0' }, exec(),
    )
    assert.equal(bumped.ok, true)
    let detail = await get.execute({ assetId: UUID }, exec())
    assert.equal(detail.data.version, '4.0')
    assert.equal(detail.data.purpose, '压扫描件', 'the purpose survives a version bump')

    const cleared = await mark.execute(
      { target: { assetId: UUID, expectedRevision: 2 }, clear: ['sourceUrl', 'platform'] }, exec(),
    )
    assert.equal(cleared.ok, true)
    detail = await get.execute({ assetId: UUID }, exec())
    assert.equal(detail.data.sourceUrl, null)
    assert.equal(detail.data.platform, null)
    assert.equal(detail.data.purpose, '压扫描件')

    const again = await mark.execute(
      { target: { assetId: UUID, expectedRevision: 3 }, version: '4.0' }, exec(),
    )
    assert.equal(again.data.receipt.outcome, 'unchanged')
  } finally {
    s.cleanup()
  }
})

test('software: an existing name stops the write, and a note needs confirmation', async () => {
  const s = scratch()
  try {
    await seedSoftware(s.dbPath, [
      { id: UUID, name: 'SubtitleEdit', purpose: '校准字幕', notes: '老备注', revision: 1 },
    ])
    const { mark, get } = await harness(s.dbPath)
    const clash = await mark.execute(
      { target: { name: 'SubtitleEdit' }, purpose: '别的用途' }, exec(),
    )
    assert.equal(clash.error.code, 'TARGET_CONFLICT')
    assert.equal(clash.error.candidates[0].assetId, UUID)

    const stopped = await mark.execute(
      { target: { assetId: UUID, expectedRevision: 1 }, notes: '新的' }, exec(),
    )
    assert.equal(stopped.error.code, 'CONFIRMATION_REQUIRED')
    const replaced = await mark.execute(
      { target: { assetId: UUID, expectedRevision: 1 }, notes: '新的', replaceNotes: true }, exec(),
    )
    assert.equal(replaced.ok, true)
    assert.equal((await get.execute({ assetId: UUID }, exec())).data.revision, 2)
  } finally {
    s.cleanup()
  }
})

test('software: argument validation runs before the library is even opened', async () => {
  const s = scratch()
  try {
    const { mark, list } = await harness(s.dbPath)
    for (const [tool, bad] of [
      [mark, { target: { name: '某个工具' } }],
      [mark, { target: { name: '某个工具' }, purpose: 'x', status: 'installed' }],
      [mark, { target: { name: '某个工具' }, purpose: '  ' }],
      [mark, { target: { name: '某个工具' }, purpose: 'x'.repeat(2001) }],
      [mark, { target: { assetId: UUID, expectedRevision: 1 } }],
      [mark, { target: { assetId: UUID, expectedRevision: 1 }, clear: [] }],
      [mark, { target: { assetId: UUID, expectedRevision: 1 }, clear: ['name'] }],
      [mark, { target: { assetId: UUID, expectedRevision: 1 }, purpose: 'x', clear: ['purpose'] }],
      [mark, { target: { assetId: UUID, name: '某个工具' }, purpose: 'x' }],
      [list, { status: 'deleted' }],
      [list, { limit: 0 }],
      [list, { offset: -1 }],
    ]) {
      const value = await tool.execute(bad, exec())
      assert.equal(value.ok, false, JSON.stringify(bad))
      assert.equal(value.error.code, 'INVALID_ARGUMENT', JSON.stringify(bad))
    }
    await assert.rejects(
      mark.execute({ target: { name: 'x' }, purpose: 'y', clear: 'notes' }, exec()),
      /must be an array/,
    )
    assert.throws(() => statSync(s.dbPath), 'a rejected call must not create the library')
  } finally {
    s.cleanup()
  }
})

test('software and subscriptions share a library without borrowing statements', async () => {
  const s = scratch()
  try {
    // A cache keyed only on the db handle can hand one module another's SQL.
    // Exercise both construction orders on the same real SQLite connection.
    const { mark, subMark, list, subList } = await harness(s.dbPath)
    const software = await mark.execute(
      { target: { name: 'PDF 压缩工具' }, purpose: '压扫描件' }, exec(),
    )
    assert.equal(software.ok, true)
    const subscription = await subMark.execute(
      { target: { name: 'Netflix' }, cycle: 'monthly' }, exec(),
    )
    assert.equal(subscription.ok, true, 'a subscription write after software must work')

    const s2 = scratch()
    try {
      const fresh = await harness(s2.dbPath)
      const subFirst = await fresh.subMark.execute(
        { target: { name: 'Netflix' }, cycle: 'monthly' }, exec(),
      )
      assert.equal(subFirst.ok, true)
      const softwareSecond = await fresh.mark.execute(
        { target: { name: 'PDF 压缩工具' }, purpose: '压扫描件' }, exec(),
      )
      assert.equal(softwareSecond.ok, true, 'a software write after a subscription must work')
      assert.equal((await fresh.subList.execute({}, exec())).data.items.length, 1)
      assert.equal((await fresh.list.execute({}, exec())).data.items.length, 1)
    } finally {
      s2.cleanup()
    }
    assert.equal((await list.execute({}, exec())).data.items.length, 1)
    assert.equal((await subList.execute({}, exec())).data.items.length, 1)
  } finally {
    s.cleanup()
  }
})

test('software: the write gate', async () => {
  const s = scratch()
  try {
    const closed = await harness(s.dbPath, false)
    const blocked = await closed.mark.execute(
      { target: { name: '某个工具' }, purpose: 'x' }, exec(),
    )
    assert.equal(blocked.error.code, 'WRITE_DISABLED')
    assert.equal((await closed.list.execute({}, exec())).ok, true, 'reads are not gated')
  } finally {
    s.cleanup()
  }
})

test('a software list row carries the revision, so an update needs no separate get', async () => {
  const s = scratch()
  try {
    const { mark, list } = await harness(s.dbPath)
    await seedSoftware(s.dbPath, [
      { id: UUID, name: 'PDF 压缩工具', purpose: '压扫描件', revision: 4 },
    ])
    const row = (await list.execute({}, exec())).data.items[0]
    assert.equal(row.revision, 4, 'the list row carries the revision')
    assert.deepEqual(Object.keys(row).sort(), ['assetId', 'category', 'name', 'platform', 'purpose', 'revision', 'status', 'version'])

    const updated = await mark.execute(
      { target: { assetId: row.assetId, expectedRevision: row.revision }, version: '4.1' }, exec(),
    )
    assert.equal(updated.ok, true, 'the revision straight from the list is accepted')
    assert.equal(updated.data.receipt.revision, 5)
  } finally {
    s.cleanup()
  }
})
