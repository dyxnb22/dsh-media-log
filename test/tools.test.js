// Unit tests for the media_log_* tools against a REAL SQLite library in a
// temp directory: no mocks, no fixtures, no subprocess. Each test builds its
// own library through the same openLibrary() the plugin uses.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTools, createLibraryHolder } from '../src/tools.js'
import { openLibrary, resolveDatabasePath } from '../src/db.js'

const UUID = '11111111-2222-3333-4444-555555555555'

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'media-log-test-'))
  return {
    dir,
    dbPath: join(dir, 'media.db'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/** Config + a fresh library, wired exactly like src/index.js does. */
async function harness({ databasePath = '', writeEnabled = true } = {}) {
  const getLibrary = createLibraryHolder()
  const tools = createTools(() => ({ databasePath, writeEnabled }), getLibrary)
  const [mark, search, get] = tools
  return { mark, search, get, getLibrary }
}

const exec = (signal) => ({ signal: signal ?? new AbortController().signal })
const byName = (tools, name) => {
  const tool = tools.find((t) => t.name === name)
  assert.ok(tool, `missing tool ${name}`)
  return tool
}
const render = (tool, args, value) => tool.output.render(args, value).map((b) => b.text).join('\n')

/** Inserts rows straight through SQL — via the REAL openLibrary, so the tests
 *  exercise the production schema rather than a copy that could drift. */
async function seed(dbPath, rows) {
  const db = await openLibrary(dbPath)
  const st = db.prepare(
    `INSERT INTO media (id, title, media_type, year, status, rating,
       progress_current, progress_total, progress_unit, notes, lifecycle, revision,
       started_at, completed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const now = new Date().toISOString()
  for (const r of rows) {
    st.run(
      r.id, r.title, r.media_type, r.year ?? null, r.status, r.rating ?? null,
      r.progress_current ?? null, r.progress_total ?? null, r.progress_unit ?? null,
      r.notes ?? null, r.lifecycle ?? 'active', r.revision ?? 1,
      r.started_at ?? null, r.completed_at ?? null,
      r.created_at ?? now, r.updated_at ?? now,
    )
  }
  db.close()
}

// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------

test('openLibrary creates the library owner-only and is idempotent', async () => {
  const s = scratch()
  try {
    const db = await openLibrary(s.dbPath)
    db.close()
    const mode = statSync(s.dbPath).mode & 0o777
    assert.equal(mode, 0o600, `expected 0o600, got ${mode.toString(8)}`)
    const dirMode = statSync(s.dir).mode & 0o777
    assert.equal(dirMode, 0o700, `expected 0o700, got ${dirMode.toString(8)}`)
    // A second open must not fail or lose the schema.
    const again = await openLibrary(s.dbPath)
    assert.equal(again.prepare('PRAGMA user_version').get().user_version, 1)
    again.close()
  } finally {
    s.cleanup()
  }
})

test('the conventional default path lives under the DSH home', () => {
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = '/tmp/dsh-home-for-test'
  try {
    assert.equal(resolveDatabasePath(''), '/tmp/dsh-home-for-test/media-log/media.db')
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
  }
})

test('a relative databasePath is rejected before anything is opened', async () => {
  const { mark } = await harness({ databasePath: 'relative/media.db' })
  const value = await mark.execute(
    { target: { assetId: UUID, expectedRevision: 1 }, rating: 8 },
    exec(),
  )
  assert.equal(value.error.code, 'CONFIG_REQUIRED')
})

// ---------------------------------------------------------------------------
// write gate and validation ordering
// ---------------------------------------------------------------------------

test('writes stay off until writeEnabled is on', async () => {
  const { mark } = await harness({ writeEnabled: false })
  const value = await mark.execute(
    { target: { title: '降临', mediaType: 'movie' }, status: 'completed' },
    exec(),
  )
  assert.equal(value.error.code, 'WRITE_DISABLED')
})

test('argument validation runs before the library is even opened', async () => {
  const { mark } = await harness()
  const value = await mark.execute({ target: { assetId: UUID, expectedRevision: 1 } }, exec())
  assert.equal(value.error.code, 'INVALID_ARGUMENT')
  // No library file was created by a malformed call.
  const s = scratch()
  try {
    const { get } = await harness({ databasePath: s.dbPath })
    assert.equal((await get.execute({ assetId: 'nope' }, exec())).error.code, 'INVALID_ARGUMENT')
    assert.throws(() => statSync(s.dbPath), 'a rejected call must not create the library')
  } finally {
    s.cleanup()
  }
})

test('an already-aborted signal stops the tool before it starts', async () => {
  const s = scratch()
  try {
    const { mark } = await harness({ databasePath: s.dbPath })
    const controller = new AbortController()
    controller.abort()
    const value = await mark.execute(
      { target: { title: '降临', mediaType: 'movie' }, status: 'completed' },
      exec(controller.signal),
    )
    assert.equal(value.error.code, 'CANCELLED')
    assert.throws(() => statSync(s.dbPath), 'nothing may be written')
  } finally {
    s.cleanup()
  }
})

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

test('create: a clean insert returns a created receipt and reads back', async () => {
  const s = scratch()
  try {
    const { mark, get } = await harness({ databasePath: s.dbPath })
    const value = await mark.execute(
      { target: { title: '完美的日子', mediaType: 'movie', year: 2023 }, status: 'completed', rating: 8, notes: '日常拍得很温柔' },
      exec(),
    )
    assert.equal(value.ok, true)
    assert.equal(value.data.receipt.outcome, 'created')
    assert.equal(value.data.receipt.revision, 1)
    assert.match(value.data.receipt.assetId, /^[0-9a-f-]{36}$/)
    assert.equal(value.data.media.title, '完美的日子')

    const back = await get.execute({ assetId: value.data.receipt.assetId }, exec())
    assert.equal(back.ok, true)
    assert.equal(back.data.rating, 8)
    assert.equal(back.data.hasNotes, true)
    assert.equal('notes' in back.data, false, 'notes stay out unless asked for')
  } finally {
    s.cleanup()
  }
})

test('create: started_at/completed_at follow the status', async () => {
  const s = scratch()
  try {
    const { mark, get } = await harness({ databasePath: s.dbPath })
    const a = await mark.execute({ target: { title: '在看的一部', mediaType: 'tv' }, status: 'in_progress' }, exec())
    const b = await mark.execute({ target: { title: '看完的一部', mediaType: 'tv' }, status: 'completed' }, exec())
    const da = await get.execute({ assetId: a.data.receipt.assetId }, exec())
    const db2 = await get.execute({ assetId: b.data.receipt.assetId }, exec())
    assert.notEqual(da.data.startedAt, null)
    assert.equal(da.data.completedAt, null)
    assert.equal(db2.data.startedAt, null)
    assert.notEqual(db2.data.completedAt, null)
  } finally {
    s.cleanup()
  }
})

test('create: a unique active same-title candidate stops the write', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, [{ id: UUID, title: '完美的日子', media_type: 'movie', status: 'completed' }])
    const { mark } = await harness({ databasePath: s.dbPath })
    const value = await mark.execute(
      { target: { title: '完美的日子', mediaType: 'movie' }, status: 'completed' },
      exec(),
    )
    assert.equal(value.error.code, 'TARGET_CONFLICT')
    assert.equal(value.error.candidates.length, 1)
    assert.equal(value.error.candidates[0].assetId, UUID)
    // Nothing new was written.
    const { search } = await harness({ databasePath: s.dbPath })
    const page = await search.execute({ query: '完美的日子' }, exec())
    assert.equal(page.data.items.length, 1)
  } finally {
    s.cleanup()
  }
})

test('create: two active same-title candidates are ambiguous', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, [
      { id: UUID, title: '完美的日子', media_type: 'movie', status: 'completed' },
      { id: 'aaaaaaaa-2222-3333-4444-555555555555', title: '完美的日子', media_type: 'movie', status: 'completed' },
    ])
    const { mark } = await harness({ databasePath: s.dbPath })
    const value = await mark.execute(
      { target: { title: '完美的日子', mediaType: 'movie' }, status: 'in_progress' },
      exec(),
    )
    assert.equal(value.error.code, 'TARGET_CONFLICT')
    assert.equal(value.error.candidates.length, 2)
  } finally {
    s.cleanup()
  }
})

test('create: a partial title match does not block a new entry', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, [{ id: UUID, title: '完美的日子', media_type: 'movie', status: 'completed' }])
    const { mark } = await harness({ databasePath: s.dbPath })
    const value = await mark.execute(
      { target: { title: '完美的', mediaType: 'movie' }, status: 'in_progress' },
      exec(),
    )
    assert.equal(value.ok, true)
    assert.equal(value.data.receipt.outcome, 'created')
  } finally {
    s.cleanup()
  }
})

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

test('update: patches under the observed revision and bumps it', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, [{ id: UUID, title: '完美的日子', media_type: 'movie', status: 'in_progress', revision: 1 }])
    const { mark, get } = await harness({ databasePath: s.dbPath })
    const value = await mark.execute(
      { target: { assetId: UUID, expectedRevision: 1 }, status: 'completed', rating: 9 },
      exec(),
    )
    assert.equal(value.ok, true)
    assert.equal(value.data.receipt.outcome, 'updated')
    assert.equal(value.data.receipt.revision, 2)
    const back = await get.execute({ assetId: UUID }, exec())
    assert.equal(back.data.status, 'completed')
    assert.equal(back.data.rating, 9)
    assert.equal(back.data.revision, 2)
  } finally {
    s.cleanup()
  }
})

test('update: a stale revision is refused and names the current one', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, [{ id: UUID, title: '完美的日子', media_type: 'movie', status: 'completed', revision: 4 }])
    const { mark } = await harness({ databasePath: s.dbPath })
    const value = await mark.execute(
      { target: { assetId: UUID, expectedRevision: 1 }, rating: 3 },
      exec(),
    )
    assert.equal(value.error.code, 'STALE_REVISION')
    assert.equal(value.error.currentRevision, 4)
    const text = render(mark, {}, value)
    assert.match(text, /revision 4/)
  } finally {
    s.cleanup()
  }
})

test('update: an identical patch is unchanged and does not bump the revision', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, [{ id: UUID, title: '完美的日子', media_type: 'movie', status: 'completed', rating: 8, revision: 3 }])
    const { mark } = await harness({ databasePath: s.dbPath })
    const value = await mark.execute(
      { target: { assetId: UUID, expectedRevision: 3 }, rating: 8 },
      exec(),
    )
    assert.equal(value.ok, true)
    assert.equal(value.data.receipt.outcome, 'unchanged')
    assert.equal(value.data.receipt.revision, 3)
  } finally {
    s.cleanup()
  }
})

test('update: a different review needs replaceNotes, and then replaces', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, [{ id: UUID, title: '完美的日子', media_type: 'movie', status: 'completed', notes: '旧短评', revision: 1 }])
    const { mark } = await harness({ databasePath: s.dbPath })
    const blocked = await mark.execute(
      { target: { assetId: UUID, expectedRevision: 1 }, notes: '新短评' },
      exec(),
    )
    assert.equal(blocked.error.code, 'CONFIRMATION_REQUIRED')

    const allowed = await mark.execute(
      { target: { assetId: UUID, expectedRevision: 1 }, notes: '新短评', replaceNotes: true },
      exec(),
    )
    assert.equal(allowed.ok, true)
    assert.equal(allowed.data.media.hasNotes, true)
    const { get } = await harness({ databasePath: s.dbPath })
    const back = await get.execute({ assetId: UUID, includeNotes: true }, exec())
    assert.equal(back.data.notes, '新短评')
  } finally {
    s.cleanup()
  }
})

test('update: setting notes where none existed needs no replaceNotes', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, [{ id: UUID, title: '完美的日子', media_type: 'movie', status: 'completed', revision: 1 }])
    const { mark, get } = await harness({ databasePath: s.dbPath })
    const value = await mark.execute(
      { target: { assetId: UUID, expectedRevision: 1 }, notes: '第一条短评' },
      exec(),
    )
    assert.equal(value.ok, true)
    const back = await get.execute({ assetId: UUID, includeNotes: true }, exec())
    assert.equal(back.data.notes, '第一条短评')
  } finally {
    s.cleanup()
  }
})

test('update: an unknown id is NOT_FOUND', async () => {
  const s = scratch()
  try {
    const { mark } = await harness({ databasePath: s.dbPath })
    const value = await mark.execute(
      { target: { assetId: UUID, expectedRevision: 1 }, rating: 8 },
      exec(),
    )
    assert.equal(value.error.code, 'NOT_FOUND')
  } finally {
    s.cleanup()
  }
})

test('update: the schema CHECK rejects an out-of-range progress', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, [{ id: UUID, title: '塞尔达', media_type: 'game', status: 'in_progress', progress_total: 30, progress_unit: '小时', revision: 1 }])
    const { mark } = await harness({ databasePath: s.dbPath })
    const value = await mark.execute(
      { target: { assetId: UUID, expectedRevision: 1 }, progress: { current: 99, total: 30 } },
      exec(),
    )
    assert.equal(value.error.code, 'INVALID_ARGUMENT')
    // The failed transaction left the row untouched.
    const { get } = await harness({ databasePath: s.dbPath })
    const back = await get.execute({ assetId: UUID }, exec())
    assert.equal(back.data.progress.current, null)
    assert.equal(back.data.revision, 1)
  } finally {
    s.cleanup()
  }
})

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

test('search: whitelist candidates, paging and the exhausted flag', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, [
      { id: UUID, title: '完美的日子', media_type: 'movie', year: 2023, status: 'completed', lifecycle: 'active' },
      { id: 'bbbbbbbb-2222-3333-4444-555555555555', title: '完美的世界', media_type: 'anime', status: 'in_progress', lifecycle: 'archived' },
    ])
    const { search } = await harness({ databasePath: s.dbPath })
    const page = await search.execute({ query: '完美' }, exec())
    assert.equal(page.ok, true)
    assert.equal(page.data.items.length, 2)
    assert.equal(page.data.total, 2)
    assert.deepEqual(
      page.data.items.map((i) => Object.keys(i).sort()),
      [['assetId', 'lifecycle', 'mediaType', 'status', 'title', 'year'], ['assetId', 'lifecycle', 'mediaType', 'status', 'title', 'year']],
      'only whitelisted fields cross into the session',
    )
    const limited = await search.execute({ query: '完美', limit: 1 }, exec())
    assert.equal(limited.data.items.length, 1)
    assert.equal(limited.data.total, null, 'a window that is not exhausted proves nothing')
  } finally {
    s.cleanup()
  }
})

test('search: % and _ in the query match literally', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, [
      { id: UUID, title: '100% 狼', media_type: 'anime', status: 'completed' },
      { id: 'cccccccc-2222-3333-4444-555555555555', title: '一千匹狼', media_type: 'anime', status: 'completed' },
    ])
    const { search } = await harness({ databasePath: s.dbPath })
    const page = await search.execute({ query: '100%' }, exec())
    assert.equal(page.data.items.length, 1)
    assert.equal(page.data.items[0].title, '100% 狼')
  } finally {
    s.cleanup()
  }
})

test('search: an empty page is a success', async () => {
  const s = scratch()
  try {
    const { search } = await harness({ databasePath: s.dbPath })
    const page = await search.execute({ query: '不存在的东西' }, exec())
    assert.equal(page.ok, true)
    assert.deepEqual(page.data.items, [])
  } finally {
    s.cleanup()
  }
})

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

test('get: notes excluded by default, truncated when long', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, [{ id: UUID, title: '完美的日子', media_type: 'movie', status: 'completed', notes: 'x'.repeat(2500) }])
    const { get } = await harness({ databasePath: s.dbPath })
    const bare = await get.execute({ assetId: UUID }, exec())
    assert.equal('notes' in bare.data, false)
    const full = await get.execute({ assetId: UUID, includeNotes: true }, exec())
    assert.equal(full.data.notes.length, 2000)
    assert.equal(full.data.notesTruncated, true)
  } finally {
    s.cleanup()
  }
})

test('get: an unknown id is NOT_FOUND', async () => {
  const s = scratch()
  try {
    const { get } = await harness({ databasePath: s.dbPath })
    const value = await get.execute({ assetId: UUID }, exec())
    assert.equal(value.error.code, 'NOT_FOUND')
  } finally {
    s.cleanup()
  }
})

// Regression: the detail mapper emitted `id` while the renderer and the tool
// contract use `assetId`, so every real media_log_get rendered as
// "工具返回了意外结构". The unit tests only ever rendered hand-made objects,
// which is why the live model round is what caught it.
test('get: the real tool output renders instead of falling through', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, [
      { id: UUID, title: '寻梦环游记', media_type: 'movie', year: 2017, status: 'completed', rating: 8 },
    ])
    const { get } = await harness({ databasePath: s.dbPath })
    const value = await get.execute({ assetId: UUID }, exec())
    assert.equal(value.data.assetId, UUID)
    const text = render(get, { assetId: UUID }, value)
    assert.match(text, /《寻梦环游记》/)
    assert.match(text, /已看完\/玩完/)
    assert.match(text, /4 星/)
    assert.match(text, new RegExp(`assetId=${UUID}`))
    assert.match(text, /revision=1/)
    assert.doesNotMatch(text, /意外结构/)
  } finally {
    s.cleanup()
  }
})

test('mark: the real receipt output renders instead of falling through', async () => {
  const s = scratch()
  try {
    const { mark } = await harness({ databasePath: s.dbPath })
    const value = await mark.execute(
      { target: { title: '寻梦环游记', mediaType: 'movie', year: 2017 }, status: 'completed', rating: 8, notes: '亲情线很好哭' },
      exec(),
    )
    const text = render(mark, { target: { title: '寻梦环游记' } }, value)
    assert.match(text, /已记下《寻梦环游记》/)
    assert.match(text, /短评已保存/)
    assert.doesNotMatch(text, /意外结构/)
  } finally {
    s.cleanup()
  }
})

test('search: the real page output renders instead of falling through', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, [{ id: UUID, title: '寻梦环游记', media_type: 'movie', year: 2017, status: 'completed' }])
    const { search } = await harness({ databasePath: s.dbPath })
    const value = await search.execute({ query: '寻梦' }, exec())
    const text = render(search, { query: '寻梦' }, value)
    assert.match(text, /找到 1 条候选/)
    assert.match(text, /《寻梦环游记》/)
    assert.doesNotMatch(text, /意外结构/)
  } finally {
    s.cleanup()
  }
})

test('get: imported planned/paused/dropped records read back faithfully', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, [
      { id: UUID, title: '想看的一部', media_type: 'movie', status: 'planned' },
      { id: 'dddddddd-2222-3333-4444-555555555555', title: '搁置的一部', media_type: 'game', status: 'paused' },
      { id: 'eeeeeeee-2222-3333-4444-555555555555', title: '弃了的一部', media_type: 'tv', status: 'dropped' },
    ])
    const { get } = await harness({ databasePath: s.dbPath })
    for (const [id, status] of [
      [UUID, 'planned'],
      ['dddddddd-2222-3333-4444-555555555555', 'paused'],
      ['eeeeeeee-2222-3333-4444-555555555555', 'dropped'],
    ]) {
      const value = await get.execute({ assetId: id }, exec())
      assert.equal(value.data.status, status)
    }
  } finally {
    s.cleanup()
  }
})

// ---------------------------------------------------------------------------
// statement caching
// ---------------------------------------------------------------------------

/**
 * Counts db.prepare() calls from this point on. node:sqlite exposes neither
 * finalize() nor a statement count, so the observable property is "no new
 * prepares happen for a library that is already open".
 * @type {WeakMap<object, {n: number}>}
 */
const prepareTracker = new WeakMap()
function trackPrepares(db) {
  let entry = prepareTracker.get(db)
  if (entry === undefined) {
    entry = { n: 0 }
    prepareTracker.set(db, entry)
    const original = db.prepare.bind(db)
    db.prepare = (...args) => {
      entry.n += 1
      return original(...args)
    }
  }
  return entry
}

test('prepared statements are built once per library, not per call', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, [{ id: UUID, title: '完美的日子', media_type: 'movie', status: 'completed' }])
    let databasePath = s.dbPath
    const holder = createLibraryHolder()
    const [, search, get] = createTools(() => ({ databasePath, writeEnabled: true }), holder)

    await search.execute({ query: '完美' }, exec())
    const db = await holder(s.dbPath)
    const tracker = trackPrepares(db)
    for (let i = 0; i < 20; i += 1) {
      await search.execute({ query: '完美' }, exec())
      await get.execute({ assetId: UUID }, exec())
    }
    assert.equal(tracker.n, 0, '40 more tool calls must not re-prepare any statement')
  } finally {
    s.cleanup()
  }
})

test('a changed databasePath reopens and gets its own statement set', async () => {
  const s = scratch()
  try {
    let databasePath = s.dbPath
    const holder = createLibraryHolder()
    const [, search] = createTools(() => ({ databasePath, writeEnabled: true }), holder)

    await search.execute({ query: 'x' }, exec())
    const first = await holder(s.dbPath)
    const firstTracker = trackPrepares(first)

    databasePath = join(s.dir, 'other.db')
    await search.execute({ query: 'x' }, exec())
    const second = await holder(databasePath)
    assert.notEqual(second, first, 'a new path means a new handle')
    const secondTracker = trackPrepares(second)
    await search.execute({ query: 'x' }, exec())
    assert.equal(secondTracker.n, 0, 'the new handle caches too')
    assert.equal(firstTracker.n, 0, 'the closed handle is left alone')
    second.close()
  } finally {
    s.cleanup()
  }
})

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

/** Builds one tool just to reach its renderer (no library is opened). */
function renderer(name) {
  const getLibrary = async () => {
    throw new Error('render must not open the library')
  }
  return byName(createTools(() => ({ databasePath: '', writeEnabled: true }), getLibrary), name)
}

test('render: created / updated / unchanged receipts', () => {
  const mark = renderer('media_log_mark')
  const created = render(mark, { target: { title: '降临' } }, {
    ok: true,
    data: {
      receipt: { assetId: UUID, outcome: 'created', revision: 1 },
      media: { title: '降临', status: 'completed', rating: 10, hasNotes: true },
    },
  })
  assert.match(created, /已记下《降临》/)
  assert.match(created, /已看完\/玩完/)
  assert.match(created, /5 星/)
  assert.match(created, /短评已保存/)
  assert.match(created, new RegExp(`assetId=${UUID}`))

  assert.match(
    render(mark, {}, { ok: true, data: { receipt: { assetId: UUID, outcome: 'updated', revision: 3 } } }),
    /已更新.*revision=3/,
  )
  assert.match(
    render(mark, {}, { ok: true, data: { receipt: { assetId: UUID, outcome: 'unchanged', revision: 3 } } }),
    /没有变化/,
  )
})

test('render: a conflict lists the candidates the model can act on', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, [
      { id: UUID, title: '完美的日子', media_type: 'movie', year: 2023, status: 'completed' },
      { id: 'ffffffff-2222-3333-4444-555555555555', title: '完美的日子', media_type: 'movie', status: 'completed', lifecycle: 'archived' },
    ])
    const { mark, search } = await harness({ databasePath: s.dbPath })
    const value = await mark.execute(
      { target: { title: '完美的日子', mediaType: 'movie' }, status: 'in_progress' },
      exec(),
    )
    // The archived twin does not change the decision, so it is not offered.
    assert.equal(value.error.candidates.length, 1)
    const text = render(mark, { target: { title: '完美的日子' } }, value)
    assert.match(text, /TARGET_CONFLICT/)
    assert.match(text, /《完美的日子》/)
    assert.match(text, /2023年/)
    assert.match(text, new RegExp(`assetId=${UUID}`))
    assert.match(text, /回复想用哪一个/)

    const page = render(search, {}, {
      ok: true,
      data: {
        items: [{ assetId: UUID, title: '完美的日子', mediaType: 'movie', year: 2023, status: 'completed', lifecycle: 'active' }],
        total: null,
      },
    })
    assert.match(page, /结果未穷尽/)
  } finally {
    s.cleanup()
  }
})

test('render: an archived-only match is offered with its label', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, [
      { id: UUID, title: '旧片', media_type: 'movie', year: 1999, status: 'completed', lifecycle: 'archived' },
    ])
    const { mark } = await harness({ databasePath: s.dbPath })
    const value = await mark.execute(
      { target: { title: '旧片', mediaType: 'movie' }, status: 'in_progress' },
      exec(),
    )
    // Archived-only matches need reconfirmation rather than being dropped.
    assert.equal(value.error.code, 'TARGET_CONFLICT')
    const text = render(mark, {}, value)
    assert.match(text, /已归档/)
    assert.match(text, /1999年/)
  } finally {
    s.cleanup()
  }
})

test('render: a stale revision names the current one', () => {
  const mark = renderer('media_log_mark')
  const text = render(mark, {}, {
    ok: false,
    error: { code: 'STALE_REVISION', message: '被改过了', currentRevision: 7 },
  })
  assert.match(text, /STALE_REVISION/)
  assert.match(text, /revision 7/)
})

test('render: search pages, detail and unexpected values', () => {
  const search = renderer('media_log_search')
  const get = renderer('media_log_get')
  assert.match(render(search, {}, { ok: true, data: { items: [], total: 0 } }), /没有找到匹配的记录/)
  const detail = render(get, {}, {
    ok: true,
    data: {
      assetId: UUID, revision: 4, title: '完美的日子', status: 'in_progress', rating: 6,
      lifecycle: 'archived', progress: { current: 12, total: 30, unit: '小时' },
    },
  })
  assert.match(detail, /在看\/在玩/)
  assert.match(detail, /3 星/)
  assert.match(detail, /进度 12\/30小时/)
  assert.match(detail, /已归档/)
  assert.match(detail, /revision=4/)
  assert.match(render(get, {}, { nope: 1 }), /意外结构/)
  assert.match(render(get, {}, { ok: false, error: { code: 'DB_BUSY', message: '库被占用' } }), /未完成 \[DB_BUSY\]：库被占用/)
})

test('render: imported planned/paused/dropped statuses have labels', () => {
  const get = renderer('media_log_get')
  assert.match(render(get, {}, { ok: true, data: { assetId: UUID, title: 'x', status: 'planned' } }), /想看\/想玩/)
  assert.match(render(get, {}, { ok: true, data: { assetId: UUID, title: 'x', status: 'paused' } }), /搁置/)
  assert.match(render(get, {}, { ok: true, data: { assetId: UUID, title: 'x', status: 'dropped' } }), /弃了/)
})

test('the three tools are registered with the expected names', () => {
  const tools = createTools(() => ({ databasePath: '', writeEnabled: false }), async () => {
    throw new Error('unused')
  })
  assert.deepEqual(tools.map((t) => t.name), ['media_log_mark', 'media_log_search', 'media_log_get'])
})
