// Unit tests for the media_log_* tools against a REAL SQLite library in a
// temp directory: no mocks, no fixtures, no subprocess. Each test builds its
// own library through the same openLibrary() the plugin uses.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { createTools } from '../src/tools.js'
import { pickCandidates } from '../src/media.js'
import { openLibrary, resolveDatabasePath, inTransaction, createLibraryHolder } from '../src/db.js'
import { scratch, exec, render, byName } from './helpers.js'

const UUID = '11111111-2222-3333-4444-555555555555'

/** Config + a fresh library, wired exactly like src/index.js does. */
async function harness({ databasePath = '', writeEnabled = true } = {}) {
  const getLibrary = createLibraryHolder()
  const tools = createTools(() => ({ databasePath, writeEnabled }), getLibrary)
  const [mark, pick, search, get, list] = tools
  return { mark, pick, search, get, list, getLibrary }
}

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
    assert.equal(again.prepare('PRAGMA user_version').get().user_version, 7)
    assert.deepEqual(
      again.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name),
      ['changes', 'media', 'software', 'subscriptions'],
      'a fresh library creates only the four supported tables',
    )
    again.close()
  } finally {
    s.cleanup()
  }
})

test('a v1 library gains the subscriptions table on its next open', async () => {
  const s = scratch()
  try {
    // Build a library the way version 1 did: media only, user_version 1.
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(s.dbPath)
    db.exec(`CREATE TABLE media (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, media_type TEXT NOT NULL,
      year INTEGER, status TEXT NOT NULL, rating REAL,
      progress_current REAL, progress_total REAL, progress_unit TEXT, notes TEXT,
      lifecycle TEXT NOT NULL DEFAULT 'active', revision INTEGER NOT NULL DEFAULT 1,
      started_at TEXT, completed_at TEXT, archived_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`)
    db.exec(`INSERT INTO media (id, title, media_type, status, created_at, updated_at)
             VALUES ('11111111-2222-3333-4444-555555555555', '老记录', 'movie', 'completed',
                     '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`)
    db.exec('PRAGMA user_version = 1')
    db.close()

    const upgraded = await openLibrary(s.dbPath)
    try {
      assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, 7)
      // The new table is there, and the old rows survived untouched.
      assert.equal(
        upgraded.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='subscriptions'").get().n,
        1,
      )
      assert.equal(upgraded.prepare('SELECT count(*) AS n FROM media').get().n, 1)
      assert.equal(upgraded.prepare('SELECT title FROM media').get().title, '老记录')
      // Only new tables are needed; the existing media rows keep their shape.
      for (const table of ['subscriptions', 'software', 'changes']) {
        assert.equal(
          upgraded.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name=?`).get(table).n,
          1,
          table,
        )
      }
    } finally {
      upgraded.close()
    }
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
  const tools = createTools(
    () => ({ databasePath: 'relative/media.db', writeEnabled: true }),
    async () => assert.fail('an invalid config must not open a database'),
  )
  const args = [
    { target: { assetId: UUID, expectedRevision: 1 }, rating: 8 },
    { from: 'planned' },
    { query: '片名' },
    { assetId: UUID },
    { status: 'planned' },
  ]
  for (let i = 0; i < tools.length; i += 1) {
    assert.equal((await tools[i].execute(args[i], exec())).error.code, 'CONFIG_REQUIRED')
  }
})

test('inTransaction preserves SQLITE_FULL after SQLite automatically rolls back', async () => {
  const s = scratch()
  const db = await openLibrary(s.dbPath)
  try {
    const insert = db.prepare(
      'INSERT INTO media (id, title, media_type, status, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    insert.run(UUID, '原有记录', 'movie', 'completed', '原有短评', '2026', '2026')
    const before = db.prepare('SELECT * FROM media').all()
    const pages = db.prepare('PRAGMA page_count').get().page_count
    db.exec(`PRAGMA max_page_count = ${pages}`)
    assert.throws(
      () => inTransaction(db, () => {
        for (let i = 0; i < 20; i += 1) {
          insert.run(`filler-${i}`, `填充 ${i}`, 'movie', 'completed', 'x'.repeat(2000), '2026', '2026')
        }
      }),
      (error) => error.errcode === 13,
    )
    assert.equal(db.isTransaction, false)
    assert.deepEqual(db.prepare('SELECT * FROM media').all(), before)
  } finally {
    db.close()
    s.cleanup()
  }
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

test('create: every stored status can be created, not just the two mark used to allow', async () => {
  const s = scratch()
  try {
    const { mark, get } = await harness({ databasePath: s.dbPath })
    for (const [i, status] of ['planned', 'in_progress', 'completed', 'paused', 'dropped'].entries()) {
      const value = await mark.execute(
        { target: { title: `作品-${status}`, mediaType: 'movie', year: 2000 + i }, status },
        exec(),
      )
      assert.equal(value.ok, true, status)
      const detail = await get.execute({ assetId: value.data.receipt.assetId }, exec())
      assert.equal(detail.data.status, status, status)
      // Only the status that speaks to a date sets one; paused/dropped set neither.
      assert.equal(detail.data.startedAt !== null, status === 'in_progress', `startedAt for ${status}`)
      assert.equal(detail.data.completedAt !== null, status === 'completed', `completedAt for ${status}`)
    }
  } finally {
    s.cleanup()
  }
})

test('create: no status means planned, with no dates invented', async () => {
  const s = scratch()
  try {
    const { mark, get } = await harness({ databasePath: s.dbPath })
    const value = await mark.execute({ target: { title: '沙丘2', mediaType: 'movie' } }, exec())
    assert.equal(value.ok, true)
    assert.equal(value.data.receipt.outcome, 'created')
    const detail = await get.execute({ assetId: value.data.receipt.assetId }, exec())
    assert.equal(detail.data.status, 'planned')
    assert.equal(detail.data.startedAt, null)
    assert.equal(detail.data.completedAt, null)
    const text = render(mark, { target: { title: '沙丘2', mediaType: 'movie' } }, value)
    assert.match(text, /想看/)
  } finally {
    s.cleanup()
  }
})

test('update: any status can be corrected directly, without routing through in_progress', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, [
      { id: UUID, title: '搁置中的一部', media_type: 'movie', status: 'planned', revision: 1 },
    ])
    const { mark, get } = await harness({ databasePath: s.dbPath })
    // planned -> dropped straight away: no in_progress stop on the way.
    const dropped = await mark.execute(
      { target: { assetId: UUID, expectedRevision: 1 }, status: 'dropped' }, exec(),
    )
    assert.equal(dropped.ok, true)
    const detail = await get.execute({ assetId: UUID }, exec())
    assert.equal(detail.data.status, 'dropped')
    assert.equal(detail.data.startedAt, null, 'a status that says nothing about dates invents none')
    assert.equal(detail.data.completedAt, null)

    // Re-stating the same status is a no-op: no revision, no date churn.
    const again = await mark.execute(
      { target: { assetId: UUID, expectedRevision: 2 }, status: 'dropped' }, exec(),
    )
    assert.equal(again.data.receipt.outcome, 'unchanged', 're-stating the same status is a no-op')
    assert.equal(again.data.receipt.revision, 2)
    const still = await get.execute({ assetId: UUID }, exec())
    assert.equal(still.data.revision, 2)
    assert.equal(still.data.startedAt, null)
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

test('create: an older exact title cannot hide behind ten newer partial matches', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, [
      { id: UUID, title: '完美', media_type: 'movie', status: 'completed', updated_at: '2020' },
      ...Array.from({ length: 10 }, (_, i) => ({
        id: `${i.toString(16).padStart(8, '0')}-2222-3333-4444-555555555555`,
        title: `完美的续篇 ${i}`, media_type: 'movie', status: 'completed', updated_at: '2026',
      })),
    ])
    const { mark, getLibrary } = await harness({ databasePath: s.dbPath })
    const value = await mark.execute(
      { target: { title: '完美', mediaType: 'movie' }, status: 'completed' }, exec(),
    )
    assert.equal(value.error?.code, 'TARGET_CONFLICT')
    assert.equal(value.error.candidates[0].assetId, UUID)
    const db = await getLibrary(s.dbPath)
    assert.equal(db.prepare('SELECT count(*) n FROM media').get().n, 11)
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

test('update: status transitions fill missing dates and preserve existing dates and no-ops', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, [{ id: UUID, title: '计划中的一部', media_type: 'tv', status: 'planned' }])
    const { mark, get } = await harness({ databasePath: s.dbPath })
    const started = await mark.execute(
      { target: { assetId: UUID, expectedRevision: 1 }, status: 'in_progress' }, exec(),
    )
    assert.equal(started.ok, true)
    assert.ok(Number.isFinite(Date.parse(started.data.media.startedAt)))
    assert.equal(started.data.media.completedAt, null)
    const completed = await mark.execute(
      { target: { assetId: UUID, expectedRevision: 2 }, status: 'completed' }, exec(),
    )
    assert.equal(completed.ok, true)
    assert.equal(completed.data.media.startedAt, started.data.media.startedAt)
    assert.ok(Number.isFinite(Date.parse(completed.data.media.completedAt)))
    for (const [expectedRevision, status] of [[3, 'in_progress'], [4, 'completed']]) {
      const result = await mark.execute({ target: { assetId: UUID, expectedRevision }, status }, exec())
      assert.equal(result.ok, true)
      assert.equal(result.data.media.startedAt, started.data.media.startedAt)
      assert.equal(result.data.media.completedAt, completed.data.media.completedAt)
    }
    const unchanged = await mark.execute(
      { target: { assetId: UUID, expectedRevision: 5 }, status: 'completed' }, exec(),
    )
    assert.equal(unchanged.data.receipt.outcome, 'unchanged')
    const back = await get.execute({ assetId: UUID }, exec())
    assert.equal(back.data.revision, 5)
    assert.equal(back.data.startedAt, started.data.media.startedAt)
    assert.equal(back.data.completedAt, completed.data.media.completedAt)
  } finally {
    s.cleanup()
  }
})

test('update: metadata corrects title, mediaType and year, and omits nothing else', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, [
      {
        id: UUID,
        title: '沙丘2',
        media_type: 'movie',
        year: 2021,
        status: 'completed',
        rating: 8,
        progress_current: 2,
        progress_total: 3,
        progress_unit: '小时',
        notes: '原短评',
        revision: 1,
      },
    ])
    const { mark, get } = await harness({ databasePath: s.dbPath })
    const value = await mark.execute(
      {
        target: { assetId: UUID, expectedRevision: 1 },
        metadata: { title: '沙丘：第二部', mediaType: 'tv', year: 2024 },
      },
      exec(),
    )
    assert.equal(value.ok, true)
    const detail = await get.execute({ assetId: UUID }, exec())
    assert.equal(detail.data.title, '沙丘：第二部')
    assert.equal(detail.data.mediaType, 'tv')
    assert.equal(detail.data.year, 2024)
    // Everything not named in metadata survives untouched.
    assert.equal(detail.data.status, 'completed')
    assert.equal(detail.data.rating, 8)
    assert.deepEqual(detail.data.progress, { current: 2, total: 3, unit: '小时' })
    assert.equal(detail.data.hasNotes, true)

    const again = await mark.execute(
      { target: { assetId: UUID, expectedRevision: 2 }, metadata: { year: 2024 } }, exec(),
    )
    assert.equal(again.data.receipt.outcome, 'unchanged', 'the same correction is a no-op')
    assert.equal(again.data.receipt.revision, 2)
  } finally {
    s.cleanup()
  }
})

test('update: renaming onto another record\'s title is refused, archived ones included', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, [
      { id: UUID, title: '沙丘', media_type: 'movie', status: 'completed' },
      { id: 'bbbbbbbb-2222-3333-4444-555555555555', title: '沙丘：第二部', media_type: 'movie', status: 'completed' },
      { id: 'cccccccc-2222-3333-4444-555555555555', title: '旧版沙丘', media_type: 'movie', status: 'completed', lifecycle: 'archived' },
    ])
    const { mark } = await harness({ databasePath: s.dbPath })
    const clash = await mark.execute(
      { target: { assetId: UUID, expectedRevision: 1 }, metadata: { title: '沙丘：第二部' } }, exec(),
    )
    assert.equal(clash.error.code, 'TARGET_CONFLICT')
    assert.equal(clash.error.candidates.length, 1)
    assert.equal(clash.error.candidates[0].assetId, 'bbbbbbbb-2222-3333-4444-555555555555')

    // An archived row with that title blocks it too, exactly as it blocks a create.
    const archivedClash = await mark.execute(
      { target: { assetId: UUID, expectedRevision: 1 }, metadata: { title: '旧版沙丘' } }, exec(),
    )
    assert.equal(archivedClash.error.code, 'TARGET_CONFLICT')
    assert.equal(archivedClash.error.candidates[0].assetId, 'cccccccc-2222-3333-4444-555555555555')

    // A free title is fine.
    const free = await mark.execute(
      { target: { assetId: UUID, expectedRevision: 1 }, metadata: { title: '沙丘：第一部' } }, exec(),
    )
    assert.equal(free.ok, true)
    assert.equal(free.data.media.title, '沙丘：第一部')
  } finally {
    s.cleanup()
  }
})

test('update: clear empties rating, year, notes and progress', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, [
      {
        id: UUID,
        title: '完美的日子',
        media_type: 'movie',
        year: 2023,
        status: 'completed',
        rating: 9,
        progress_current: 3,
        progress_total: 10,
        progress_unit: '小时',
        notes: '值得重看',
        revision: 1,
      },
    ])
    const { mark, get } = await harness({ databasePath: s.dbPath })
    const read = async () => (await get.execute({ assetId: UUID, includeNotes: true }, exec())).data

    const cleared = await mark.execute(
      { target: { assetId: UUID, expectedRevision: 1 }, clear: ['rating', 'year', 'progress'], replaceNotes: true },
      exec(),
    )
    assert.equal(cleared.ok, true)
    let d = await read()
    assert.equal(d.rating, null)
    assert.equal(d.year, null)
    assert.equal(d.progress, null)
    assert.equal(d.hasNotes, true, 'notes were not in clear')

    const emptiedNotes = await mark.execute(
      { target: { assetId: UUID, expectedRevision: 2 }, clear: ['notes'], replaceNotes: true }, exec(),
    )
    assert.equal(emptiedNotes.ok, true)
    d = await read()
    assert.equal(d.hasNotes, false)
    assert.equal(d.notes, null)

    // Emptying what is already empty changes nothing at all.
    const again = await mark.execute(
      { target: { assetId: UUID, expectedRevision: 3 }, clear: ['rating'] }, exec(),
    )
    assert.equal(again.data.receipt.outcome, 'unchanged')
    assert.equal(again.data.receipt.revision, 3)
    assert.equal((await read()).revision, 3)
  } finally {
    s.cleanup()
  }
})

test('update: clearing a review needs the same confirmation as replacing one', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, [
      { id: UUID, title: '完美的日子', media_type: 'movie', status: 'completed', notes: '值得重看', revision: 1 },
    ])
    const { mark, get } = await harness({ databasePath: s.dbPath })
    const stopped = await mark.execute(
      { target: { assetId: UUID, expectedRevision: 1 }, clear: ['notes'] }, exec(),
    )
    assert.equal(stopped.error.code, 'CONFIRMATION_REQUIRED')
    assert.match(stopped.error.message, /清空/)
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

test('update: metadata and clear are rejected on create, and contradictions are caught', async () => {
  const s = scratch()
  try {
    const { mark } = await harness({ databasePath: s.dbPath })
    const bad = [
      { target: { title: '新片', mediaType: 'movie' }, metadata: { year: 2024 } },
      { target: { title: '新片', mediaType: 'movie' }, clear: ['rating'] },
      { target: { assetId: UUID, expectedRevision: 1 }, metadata: {} },
      { target: { assetId: UUID, expectedRevision: 1 }, metadata: { title: '  ' } },
      { target: { assetId: UUID, expectedRevision: 1 }, metadata: { mediaType: 'music' } },
      { target: { assetId: UUID, expectedRevision: 1 }, metadata: { year: 12 } },
      { target: { assetId: UUID, expectedRevision: 1 }, clear: [] },
      { target: { assetId: UUID, expectedRevision: 1 }, clear: ['title'] },
      { target: { assetId: UUID, expectedRevision: 1 }, clear: ['nope'] },
      { target: { assetId: UUID, expectedRevision: 1 }, clear: ['rating'], rating: 8 },
      { target: { assetId: UUID, expectedRevision: 1 }, clear: ['year'], metadata: { year: 2024 } },
      { target: { assetId: UUID, expectedRevision: 1 }, clear: ['progress'], progress: { current: 1 } },
      { target: { assetId: UUID, expectedRevision: 1 }, clear: ['notes'], notes: '新的' },
    ]
    for (const args of bad) {
      const value = await mark.execute(args, exec())
      assert.equal(value.ok, false, JSON.stringify(args))
      assert.equal(value.error.code, 'INVALID_ARGUMENT', JSON.stringify(args))
    }
    // Wrong SHAPES are caught by defineTool's schema gate, which throws rather
    // than returning a value — the same layering as everywhere else.
    await assert.rejects(
      mark.execute({ target: { assetId: UUID, expectedRevision: 1 }, clear: 'rating' }, exec()),
      /must be an array/,
    )
    await assert.rejects(
      mark.execute({ target: { assetId: UUID, expectedRevision: 1 }, metadata: { nope: 1 } }, exec()),
      /not a declared property/,
    )
    assert.throws(() => statSync(s.dbPath), 'a rejected call must not create the library')
  } finally {
    s.cleanup()
  }
})

// ---------------------------------------------------------------------------
// archive / restore
// ---------------------------------------------------------------------------

test('update: archiving stamps archived_at, hides from the list, and keeps search finding it', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, [
      {
        id: UUID,
        title: '重复录入的一条',
        media_type: 'movie',
        year: 2020,
        status: 'in_progress',
        rating: 7,
        progress_current: 2,
        progress_total: 5,
        progress_unit: '小时',
        notes: '有点印象',
        revision: 3,
      },
    ])
    const { mark, get, list, search } = await harness({ databasePath: s.dbPath })
    const before = await get.execute({ assetId: UUID }, exec())

    const archived = await mark.execute(
      { target: { assetId: UUID, expectedRevision: 3 }, lifecycle: 'archived' }, exec(),
    )
    assert.equal(archived.ok, true)
    assert.equal(archived.data.receipt.revision, 4)
    assert.equal(archived.data.media.lifecycle, 'archived')

    const after = await get.execute({ assetId: UUID }, exec())
    assert.equal(after.data.lifecycle, 'archived')
    assert.ok(Number.isFinite(Date.parse(after.data.archivedAt ?? '')), 'archived_at is stamped')
    // Nothing else moved.
    for (const key of ['status', 'rating', 'startedAt', 'completedAt', 'title', 'year']) {
      assert.equal(after.data[key], before.data[key], key)
    }
    assert.equal((await get.execute({ assetId: UUID, includeNotes: true }, exec())).data.hasNotes, true)

    // Hidden from the default list, still findable by search.
    const page = await list.execute({}, exec())
    assert.deepEqual(page.data.items.map((i) => i.assetId), [])
    const found = await search.execute({ query: '重复录入' }, exec())
    assert.equal(found.data.items.length, 1)
    assert.equal(found.data.items[0].lifecycle, 'archived')
    assert.match(render(search, { query: '重复录入' }, found), /已归档/)

    const text = render(mark, { target: { assetId: UUID, expectedRevision: 3 }, lifecycle: 'archived' }, archived)
    assert.match(text, /^已更新《重复录入的一条》，在看\/在玩，已归档/)
  } finally {
    s.cleanup()
  }
})

test('update: restoring clears archived_at and brings back id, rating, progress and review', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, [
      {
        id: UUID,
        title: '归档过的一条',
        media_type: 'game',
        year: 2019,
        status: 'paused',
        rating: 6,
        progress_current: 4,
        progress_total: 20,
        progress_unit: '章',
        notes: '以后可能重玩',
        lifecycle: 'archived',
        revision: 2,
        archived_at: '2025-03-01T00:00:00.000Z',
      },
    ])
    const { mark, get, list } = await harness({ databasePath: s.dbPath })
    const restored = await mark.execute(
      { target: { assetId: UUID, expectedRevision: 2 }, lifecycle: 'active' }, exec(),
    )
    assert.equal(restored.ok, true)
    const after = await get.execute({ assetId: UUID, includeNotes: true }, exec())
    assert.equal(after.data.lifecycle, 'active')
    assert.equal(after.data.archivedAt, null, 'restoring clears the archive date')
    assert.equal(after.data.assetId, UUID)
    assert.equal(after.data.rating, 6)
    assert.deepEqual(after.data.progress, { current: 4, total: 20, unit: '章' })
    assert.equal(after.data.hasNotes, true)
    assert.equal(after.data.status, 'paused', 'restoring does not touch the watch state')

    const page = await list.execute({}, exec())
    assert.deepEqual(page.data.items.map((i) => i.assetId), [UUID])

    // Re-archiving stamps a fresh date rather than resurrecting the old one.
    const again = await mark.execute(
      { target: { assetId: UUID, expectedRevision: 3 }, lifecycle: 'archived' }, exec(),
    )
    assert.equal(again.ok, true)
    const rearchived = await get.execute({ assetId: UUID }, exec())
    assert.notEqual(rearchived.data.archivedAt, '2025-03-01T00:00:00.000Z')
  } finally {
    s.cleanup()
  }
})

test('update: archiving twice does not bump the revision, and does not touch the status', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, [
      { id: UUID, title: '完美的日子', media_type: 'movie', status: 'in_progress', revision: 1 },
    ])
    const { mark, get } = await harness({ databasePath: s.dbPath })
    await mark.execute({ target: { assetId: UUID, expectedRevision: 1 }, lifecycle: 'archived' }, exec())
    const twice = await mark.execute(
      { target: { assetId: UUID, expectedRevision: 2 }, lifecycle: 'archived' }, exec(),
    )
    assert.equal(twice.data.receipt.outcome, 'unchanged')
    assert.equal(twice.data.receipt.revision, 2)
    const after = await get.execute({ assetId: UUID }, exec())
    assert.equal(after.data.revision, 2)
    assert.equal(after.data.status, 'in_progress', 'archiving is not a watch state')
  } finally {
    s.cleanup()
  }
})

test('update: an archived record with this exact title still blocks a create', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, [
      { id: UUID, title: '完美的日子', media_type: 'movie', status: 'completed', lifecycle: 'archived' },
    ])
    const { mark, list } = await harness({ databasePath: s.dbPath })
    // The known boundary: archiving a duplicate does NOT free up the title.
    const blocked = await mark.execute(
      { target: { title: '完美的日子', mediaType: 'movie' }, status: 'completed' }, exec(),
    )
    assert.equal(blocked.error.code, 'TARGET_CONFLICT')
    assert.equal(blocked.error.candidates[0].lifecycle, 'archived')
    const visible = await list.execute({ lifecycle: 'all' }, exec())
    assert.equal(visible.data.items.length, 1)
  } finally {
    s.cleanup()
  }
})

test('update: lifecycle is rejected on create', async () => {
  const s = scratch()
  try {
    const { mark } = await harness({ databasePath: s.dbPath })
    for (const bad of [
      { target: { title: '新片', mediaType: 'movie' }, lifecycle: 'archived' },
      { target: { title: '新片', mediaType: 'movie' }, lifecycle: 'all' },
      { target: { assetId: UUID, expectedRevision: 1 }, lifecycle: 'deleted' },
    ]) {
      const value = await mark.execute(bad, exec())
      assert.equal(value.ok, false, JSON.stringify(bad))
      assert.equal(value.error.code, 'INVALID_ARGUMENT', JSON.stringify(bad))
    }
  } finally {
    s.cleanup()
  }
})

// ---------------------------------------------------------------------------
// update by title
// ---------------------------------------------------------------------------

test('updateByTitle: one call finishes the most common operations', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, [
      { id: UUID, title: '艾尔登法环', media_type: 'game', status: 'planned', revision: 1 },
      { id: 'bbbbbbbb-2222-3333-4444-555555555555', title: '塞尔达传说', media_type: 'game', status: 'in_progress', progress_current: 12, progress_total: 50, progress_unit: '小时', revision: 4 },
    ])
    const { mark, get } = await harness({ databasePath: s.dbPath })

    const started = await mark.execute({ target: { title: '艾尔登法环' }, status: 'in_progress' }, exec())
    assert.equal(started.ok, true)
    assert.equal(started.data.receipt.assetId, UUID)
    assert.equal(started.data.receipt.revision, 2)
    assert.equal((await get.execute({ assetId: UUID }, exec())).data.status, 'in_progress')

    const rated = await mark.execute({ target: { title: '塞尔达传说' }, rating: 9 }, exec())
    assert.equal(rated.ok, true)
    assert.equal(rated.data.receipt.assetId, 'bbbbbbbb-2222-3333-4444-555555555555')
    assert.equal(rated.data.receipt.revision, 5)

    const archived = await mark.execute({ target: { title: '塞尔达传说' }, lifecycle: 'archived' }, exec())
    assert.equal(archived.ok, true)
    assert.equal(archived.data.media.lifecycle, 'archived')

    // Correcting identity works through the same door.
    const renamed = await mark.execute(
      { target: { title: '艾尔登法环' }, metadata: { title: '艾尔登法环：黄金树' } }, exec(),
    )
    assert.equal(renamed.ok, true)
    assert.equal((await get.execute({ assetId: UUID }, exec())).data.title, '艾尔登法环：黄金树')
  } finally {
    s.cleanup()
  }
})

test('updateByTitle: a near-miss title offers the close records instead of guessing', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, [
      { id: UUID, title: '沙丘：第二部', media_type: 'movie', status: 'completed', revision: 2 },
      { id: 'bbbbbbbb-2222-3333-4444-555555555555', title: '沙丘', media_type: 'movie', status: 'completed', revision: 1 },
    ])
    const { mark, get } = await harness({ databasePath: s.dbPath })

    // "沙丘2" shares no substring with either stored title, so nothing is
    // offered rather than something wrong. Matching is exact on purpose.
    const nothing = await mark.execute({ target: { title: '沙丘2' }, status: 'in_progress' }, exec())
    assert.equal(nothing.error.code, 'TARGET_CONFLICT')
    assert.deepEqual(nothing.error.candidates, [])
    assert.match(render(mark, { target: { title: '沙丘2' } }, nothing), /补上 mediaType/)

    // An unknown title says how to create instead, and following that hint
    // lands on the first try.
    const unknown = await mark.execute({ target: { title: '不存在的片子' }, status: 'completed' }, exec())
    assert.equal(unknown.error.code, 'TARGET_CONFLICT')
    assert.deepEqual(unknown.error.candidates, [])
    const unknownText = render(mark, { target: { title: '不存在的片子' } }, unknown)
    assert.match(unknownText, /没有这条记录/)
    assert.match(unknownText, /补上 mediaType/)
    const created = await mark.execute(
      { target: { title: '不存在的片子', mediaType: 'movie' }, status: 'completed' }, exec(),
    )
    assert.equal(created.ok, true)

    // A title that IS a prefix of a stored one gets that record offered.
    const near = await mark.execute({ target: { title: '沙丘：第' }, status: 'in_progress' }, exec())
    assert.equal(near.error.code, 'TARGET_CONFLICT')
    assert.equal(near.error.candidates.length, 1)
    assert.equal(near.error.candidates[0].title, '沙丘：第二部')
    const text = render(mark, { target: { title: '沙丘：第' } }, near)
    assert.match(text, /确切标题重试/)
    // Nothing was written.
    assert.equal((await get.execute({ assetId: UUID }, exec())).data.revision, 2)
    assert.equal((await get.execute({ assetId: UUID }, exec())).data.status, 'completed')

    // Retrying with the stored title lands.
    const retried = await mark.execute({ target: { title: '沙丘：第二部' }, status: 'in_progress' }, exec())
    assert.equal(retried.ok, true)
    assert.equal(retried.data.receipt.assetId, UUID)
  } finally {
    s.cleanup()
  }
})

test('updateByTitle: several exact matches stop and ask, and a patch is required', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, [
      { id: UUID, title: '完美的日子', media_type: 'movie', status: 'completed' },
      { id: 'bbbbbbbb-2222-3333-4444-555555555555', title: '完美的日子', media_type: 'anime', status: 'completed' },
    ])
    const { mark, get } = await harness({ databasePath: s.dbPath })
    const ambiguous = await mark.execute({ target: { title: '完美的日子' }, rating: 8 }, exec())
    assert.equal(ambiguous.error.code, 'TARGET_CONFLICT')
    assert.equal(ambiguous.error.candidates.length, 2)
    assert.match(ambiguous.error.message, /多条/)
    assert.equal((await get.execute({ assetId: UUID }, exec())).data.rating, null)

    for (const bad of [
      { target: { title: '完美的日子' } },
      { target: { title: '完美的日子', year: 2024 }, rating: 8 },
      { target: { title: '完美的日子', expectedRevision: 1 }, rating: 8 },
      { target: { assetId: UUID, expectedRevision: 1, title: '完美的日子' }, rating: 8 },
      { target: { assetId: UUID, expectedRevision: 1, mediaType: 'movie' }, rating: 8 },
    ]) {
      const value = await mark.execute(bad, exec())
      assert.equal(value.ok, false, JSON.stringify(bad))
      assert.equal(value.error.code, 'INVALID_ARGUMENT', JSON.stringify(bad))
    }
    // mediaType in target is the create signal, so this is a create that hits
    // the existing title — and the failure tells the model to retry by title.
    const asCreate = await mark.execute(
      { target: { title: '完美的日子', mediaType: 'movie' }, rating: 8 }, exec(),
    )
    assert.equal(asCreate.error.code, 'TARGET_CONFLICT')
    assert.match(render(mark, { target: { title: '完美的日子' } }, asCreate), /换成 target \{title\}/)
  } finally {
    s.cleanup()
  }
})

test('updateByTitle: the notes guard and the rename guard still apply', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, [
      { id: UUID, title: '繁花', media_type: 'tv', status: 'completed', notes: '王家卫还是稳', revision: 1 },
      { id: 'bbbbbbbb-2222-3333-4444-555555555555', title: '漫长的季节', media_type: 'tv', status: 'completed', revision: 1 },
    ])
    const { mark, get } = await harness({ databasePath: s.dbPath })
    const stopped = await mark.execute(
      { target: { title: '繁花' }, notes: '不太行' }, exec(),
    )
    assert.equal(stopped.error.code, 'CONFIRMATION_REQUIRED')
    const replaced = await mark.execute(
      { target: { title: '繁花' }, notes: '不太行', replaceNotes: true }, exec(),
    )
    assert.equal(replaced.ok, true)

    // Renaming onto an existing title is refused on this path too.
    const clash = await mark.execute(
      { target: { title: '繁花' }, metadata: { title: '漫长的季节' } }, exec(),
    )
    assert.equal(clash.error.code, 'TARGET_CONFLICT')
    assert.equal((await get.execute({ assetId: 'bbbbbbbb-2222-3333-4444-555555555555' }, exec())).data.title, '漫长的季节')
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

test('update: setting notes where none existed needs no replaceNotes, for NULL and imported-empty alike', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, [
      { id: UUID, title: '完美的日子', media_type: 'movie', status: 'completed', revision: 1 },
      { id: 'bbbbbbbb-2222-3333-4444-555555555555', title: '空短评', media_type: 'movie', status: 'completed', notes: '' },
    ])
    const { mark, get } = await harness({ databasePath: s.dbPath })
    assert.equal(
      (await get.execute({ assetId: 'bbbbbbbb-2222-3333-4444-555555555555' }, exec())).data.hasNotes,
      false,
      'an imported empty review reads as no review',
    )

    for (const assetId of [UUID, 'bbbbbbbb-2222-3333-4444-555555555555']) {
      const value = await mark.execute(
        { target: { assetId, expectedRevision: 1 }, notes: '第一条短评' },
        exec(),
      )
      assert.equal(value.ok, true)
      const back = await get.execute({ assetId, includeNotes: true }, exec())
      assert.equal(back.data.notes, '第一条短评')
    }
    assert.equal(
      (await get.execute({ assetId: 'bbbbbbbb-2222-3333-4444-555555555555' }, exec())).data.completedAt,
      null,
      'a notes-only patch must not invent a completion date',
    )
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

    const missed = await search.execute({ query: '不存在的' }, exec())
    assert.equal(missed.ok, true, 'an empty page is a success, not a failure')
    assert.deepEqual(missed.data.items, [])
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

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

/** Deterministic ids, so a page's contents are stable across runs. */
const rowId = (n) => `0000000${n}-2222-3333-4444-555555555555`

/** seed() stamps every row with the same updated_at — which is exactly what an
 *  imported library looks like, and what makes the id tiebreak load-bearing. */
const MIXED_LIBRARY = [
  { id: rowId(1), title: '艾尔登法环', media_type: 'game', year: 2022, status: 'in_progress', rating: 9, progress_current: 3, progress_total: 50, progress_unit: '小时' },
  { id: rowId(2), title: '塞尔达传说', media_type: 'game', year: 2023, status: 'in_progress', progress_current: 12, progress_total: 50, progress_unit: '小时' },
  { id: rowId(3), title: '存档里的老游戏', media_type: 'game', year: 2019, status: 'in_progress', progress_current: 1, progress_total: 10, progress_unit: '章', lifecycle: 'archived' },
  { id: rowId(4), title: '沙丘', media_type: 'movie', year: 2021, status: 'completed', rating: 8, completed_at: '2025-07-09T00:00:00+00:00' },
  { id: rowId(5), title: '想看的一部', media_type: 'movie', year: 2020, status: 'planned' },
  { id: rowId(6), title: '搁置的剧', media_type: 'tv', year: 2018, status: 'paused' },
]

const titles = (page) => page.data.items.map((i) => i.title).sort()

test('list: "在玩什么" answers with active games only, rating and progress included', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, MIXED_LIBRARY)
    const { list } = await harness({ databasePath: s.dbPath })
    const page = await list.execute({ mediaType: 'game', status: 'in_progress' }, exec())
    assert.equal(page.ok, true)
    assert.deepEqual(titles(page), ['塞尔达传说', '艾尔登法环'])
    assert.equal(page.data.total, 2)
    assert.equal(page.data.filters.lifecycle, 'active', 'the invisible default must be echoed back')
    for (const item of page.data.items) {
      assert.deepEqual(
        Object.keys(item).sort(),
        ['assetId', 'lifecycle', 'mediaType', 'progress', 'rating', 'status', 'title', 'year'],
        'only whitelisted fields cross into the session',
      )
    }
    const ring = page.data.items.find((i) => i.title === '艾尔登法环')
    assert.equal(ring.rating, 9)
    assert.deepEqual(ring.progress, { current: 3, total: 50, unit: '小时' })
    assert.equal(page.data.items.find((i) => i.title === '塞尔达传说').rating, null)
  } finally {
    s.cleanup()
  }
})

test('list: the real page output renders as an answer, not a retrieval report', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, MIXED_LIBRARY)
    const { list } = await harness({ databasePath: s.dbPath })
    const args = { mediaType: 'game', status: 'in_progress' }
    const text = render(list, args, await list.execute(args, exec()))
    assert.match(text, /^在玩的游戏有 2 个：/)
    assert.match(text, /《艾尔登法环》（2022年游戏，在玩，4\.5 星，进度 3\/50小时）assetId=/)
    assert.match(text, /《塞尔达传说》（2023年游戏，在玩，进度 12\/50小时）assetId=/)
    assert.doesNotMatch(text, /候选/, 'a list is an answer, not a set of candidates')
  } finally {
    s.cleanup()
  }
})

test('list: paging is stable across a shared updated_at, and an over-run page says so', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, MIXED_LIBRARY)
    const { list } = await harness({ databasePath: s.dbPath })
    /** @type {string[]} */
    const seen = []
    for (const offset of [0, 2, 4]) {
      const page = await list.execute({ lifecycle: 'all', limit: 2, offset }, exec())
      assert.equal(page.ok, true)
      assert.equal(page.data.items.length, 2)
      for (const item of page.data.items) {
        assert.ok(!seen.includes(item.assetId), 'a record must not appear on two pages')
        seen.push(item.assetId)
      }
    }
    assert.equal(seen.length, MIXED_LIBRARY.length, 'every record shows up exactly once')
    const first = await list.execute({ lifecycle: 'all', limit: 2, offset: 0 }, exec())
    assert.equal(first.data.total, null, 'a window that is not exhausted proves nothing')
    assert.match(render(list, { lifecycle: 'all', limit: 2 }, first), /结果未穷尽/)

    const past = await list.execute({ lifecycle: 'all', limit: 2, offset: 6 }, exec())
    assert.equal(past.ok, true)
    assert.deepEqual(past.data.items, [])
    assert.equal(past.data.total, MIXED_LIBRARY.length)
    const text = render(list, { lifecycle: 'all', limit: 2, offset: 6 }, past)
    assert.match(text, /这一页是空的/)
    assert.doesNotMatch(text, /没有符合条件的记录/, 'an over-run page is not an empty library')
  } finally {
    s.cleanup()
  }
})

test('list: a completion range includes its start and excludes its end, across both date spellings', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, [
      { id: rowId(1), title: 'imported-spelling', media_type: 'movie', status: 'completed', completed_at: '2025-07-09T00:00:00+00:00' },
      { id: rowId(2), title: 'written-here', media_type: 'movie', status: 'completed', completed_at: '2025-07-09T00:00:00.000Z' },
      { id: rowId(3), title: 'no-date', media_type: 'movie', status: 'completed' },
      { id: rowId(4), title: 'earlier', media_type: 'movie', status: 'completed', completed_at: '2025-07-08T20:00:00.000Z' },
      { id: rowId(5), title: 'other-month', media_type: 'movie', status: 'completed', completed_at: '2025-08-15T00:00:00.000Z' },
    ])
    const { list } = await harness({ databasePath: s.dbPath })
    const ask = async (extra) => titles(await list.execute(extra, exec()))

    assert.deepEqual(
      await ask({ completedFrom: '2025-07-09' }),
      ['imported-spelling', 'other-month', 'written-here'],
      'the start is inclusive, and a record without completed_at never enters a range',
    )
    assert.deepEqual(
      await ask({ completedBefore: '2025-07-09' }),
      ['earlier'],
      'the end is exclusive — text comparison would have kept both boundary rows',
    )
    assert.deepEqual(
      await ask({ completedFrom: '2025-07-01', completedBefore: '2025-08-01' }),
      ['earlier', 'imported-spelling', 'written-here'],
    )
    // 2025-07-09T08:00:00+08:00 IS 2025-07-09T00:00:00Z. Read as a bare UTC
    // datetime instead, the bound would sit eight hours later and both
    // boundary rows would slip in — so this assertion is what proves the
    // offset is honored rather than discarded.
    assert.deepEqual(await ask({ completedBefore: '2025-07-09T08:00:00+08:00' }), ['earlier'])
  } finally {
    s.cleanup()
  }
})

test('list: lifecycle defaults to active; archived and all are explicit', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, MIXED_LIBRARY)
    const { list } = await harness({ databasePath: s.dbPath })
    assert.deepEqual(titles(await list.execute({ mediaType: 'game' }, exec())), ['塞尔达传说', '艾尔登法环'])
    assert.deepEqual(titles(await list.execute({ lifecycle: 'archived' }, exec())), ['存档里的老游戏'])

    const all = await list.execute({ lifecycle: 'all' }, exec())
    assert.equal(all.data.items.length, MIXED_LIBRARY.length)
    const text = render(list, { lifecycle: 'all' }, all)
    assert.match(text, /含已归档/)
    assert.match(text, /《存档里的老游戏》（2019年游戏，在玩，进度 1\/10章，已归档）assetId=/)
    assert.match(text, /《想看的一部》（2020年电影，想看）assetId=/)
    const archivedOnly = await list.execute({ lifecycle: 'archived' }, exec())
    assert.match(render(list, { lifecycle: 'archived' }, archivedOnly), /只看已归档/)
  } finally {
    s.cleanup()
  }
})

test('list: every stored status is filterable, including the ones mark cannot write yet', async () => {
  const s = scratch()
  try {
    await seed(
      s.dbPath,
      ['planned', 'in_progress', 'completed', 'paused', 'dropped'].map((status, i) => ({
        id: rowId(i + 1),
        title: `记录-${status}`,
        media_type: 'movie',
        status,
      })),
    )
    const { list } = await harness({ databasePath: s.dbPath })
    for (const status of ['planned', 'in_progress', 'completed', 'paused', 'dropped']) {
      const page = await list.execute({ status }, exec())
      assert.deepEqual(titles(page), [`记录-${status}`], status)
    }
  } finally {
    s.cleanup()
  }
})

test('list: an empty library is an honest answer, not a failure', async () => {
  const s = scratch()
  try {
    const { list } = await harness({ databasePath: s.dbPath })
    const page = await list.execute({}, exec())
    assert.equal(page.ok, true)
    assert.deepEqual(page.data.items, [])
    assert.equal(page.data.total, 0)
    assert.match(render(list, {}, page), /没有符合条件的记录/)
  } finally {
    s.cleanup()
  }
})

test('list: a query leaves the records and their revisions untouched', async () => {
  const s = scratch()
  try {
    await seed(s.dbPath, [
      { id: UUID, title: '完美的日子', media_type: 'movie', status: 'completed', revision: 4, rating: 7 },
    ])
    const { list, get } = await harness({ databasePath: s.dbPath })
    const before = await get.execute({ assetId: UUID }, exec())
    await list.execute({ status: 'completed' }, exec())
    await list.execute({ lifecycle: 'all', limit: 1 }, exec())
    await list.execute({ completedFrom: '2025-01-01', completedBefore: '2026-01-01' }, exec())
    const after = await get.execute({ assetId: UUID }, exec())
    assert.deepEqual(after.data, before.data)
    assert.equal(after.data.revision, 4)
  } finally {
    s.cleanup()
  }
})

test('list: argument validation runs before the library is even opened', async () => {
  const s = scratch()
  try {
    const { list } = await harness({ databasePath: s.dbPath })
    for (const bad of [
      { mediaType: 'music' },
      { status: 'watching' },
      { lifecycle: 'deleted' },
      { completedFrom: '上个月' },
      { completedFrom: '2025-13-01' },
      { completedFrom: '2025-11-01T00:00:00' },
      { limit: 0 },
      { offset: -1 },
      { sortBy: 'title' },
      { completedFrom: '2025-12-01', completedBefore: '2025-11-01' },
    ]) {
      const value = await list.execute(bad, exec())
      assert.equal(value.ok, false, JSON.stringify(bad))
      assert.equal(value.error.code, 'INVALID_ARGUMENT', JSON.stringify(bad))
    }
    // A wrong TYPE is caught by defineTool's own schema gate, which throws
    // rather than returning a value — the layering the other tools share.
    await assert.rejects(list.execute({ completedFrom: 20251101 }, exec()), /must be a string/)
    await assert.rejects(list.execute({ limit: 2.5 }, exec()), /must be an integer/)
    assert.throws(() => statSync(s.dbPath), 'a rejected call must not create the library')
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
    assert.doesNotMatch(render(get, { assetId: UUID }, bare), /x{20}/)
    const full = await get.execute({ assetId: UUID, includeNotes: true }, exec())
    assert.equal(full.data.notes.length, 2000)
    assert.equal(full.data.notesTruncated, true)
    const text = render(get, { assetId: UUID, includeNotes: true }, full)
    assert.ok(text.includes('x'.repeat(2000)), 'the model must receive the actual review')
    assert.ok(!text.includes('x'.repeat(2001)), 'the model must not receive text beyond the limit')
    assert.match(text, /截断/)
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
      {
        id: UUID, title: '寻梦环游记', media_type: 'movie', year: 2017, status: 'completed', rating: 8,
        progress_total: 105, progress_unit: '分钟',
        started_at: '2025-07-09T00:00:00Z', completed_at: '2025-07-09T02:00:00Z',
      },
    ])
    const { get } = await harness({ databasePath: s.dbPath })
    const value = await get.execute({ assetId: UUID }, exec())
    assert.equal(value.data.assetId, UUID)
    const text = render(get, { assetId: UUID }, value)
    assert.match(text, /《寻梦环游记》/)
    assert.match(text, /已看完\/玩完/)
    assert.match(text, /4 星/)
    assert.match(text, /2017年/)
    assert.match(text, /电影/)
    assert.match(text, /105分钟/)
    assert.ok(text.includes(value.data.startedAt))
    assert.ok(text.includes(value.data.completedAt))
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
    const [, , search, get] = createTools(() => ({ databasePath, writeEnabled: true }), holder)

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
    const [, , search] = createTools(() => ({ databasePath, writeEnabled: true }), holder)

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
    assert.equal(firstTracker.n, 0, 'the previous handle is left alone')
    first.close()
    second.close()
  } finally {
    s.cleanup()
  }
})

test('overlapping marks for different configured paths write to their intended libraries', async () => {
  const s = scratch()
  try {
    const otherPath = join(s.dir, 'other.db')
    let databasePath = s.dbPath
    const holder = createLibraryHolder()
    const [mark] = createTools(() => ({ databasePath, writeEnabled: true }), holder)
    const first = mark.execute({ target: { title: '第一库', mediaType: 'movie' }, status: 'completed' }, exec())
    databasePath = otherPath
    const second = mark.execute({ target: { title: '第二库', mediaType: 'movie' }, status: 'completed' }, exec())
    const values = await Promise.all([first, second])
    assert.ok(values.every((v) => v.ok))
    const a = await holder(s.dbPath)
    const b = await holder(otherPath)
    try {
      assert.deepEqual(a.prepare('SELECT title FROM media').all().map((r) => r.title), ['第一库'])
      assert.deepEqual(b.prepare('SELECT title FROM media').all().map((r) => r.title), ['第二库'])
    } finally {
      a.close()
      b.close()
    }
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
    assert.match(text, /换成 target \{title\}/, 'the next step is named, not left to guesswork')
    assert.doesNotMatch(text, /确认.*新建/)

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

test('pick: draws only from the active planned pool, reports its size, excludes paused/completed/archived', async () => {
  const { dbPath, cleanup } = scratch()
  try {
    const h = await harness({ databasePath: dbPath })
    await seed(dbPath, [
      { id: UUID, title: '想看A', media_type: 'movie', status: 'planned' },
      { id: '22222222-2222-3333-4444-555555555555', title: '想看B', media_type: 'anime', status: 'planned' },
      { id: '33333333-2222-3333-4444-555555555555', title: '搁置C', media_type: 'game', status: 'paused' },
      { id: '44444444-2222-3333-4444-555555555555', title: '看完D', media_type: 'movie', status: 'completed' },
      { id: '55555555-2222-3333-4444-555555555555', title: '归档E', media_type: 'movie', status: 'planned', lifecycle: 'archived' },
    ])
    const value = await h.pick.execute({}, exec())
    assert.equal(value.ok, true)
    assert.equal(value.data.from, 'planned')
    assert.equal(value.data.total, 2) // 想看A + 想看B only
    assert.equal(value.data.items.length, 2) // pool smaller than count=3 → whole pool
    assert.deepEqual(
      value.data.items.map((i) => i.title).sort(),
      ['想看A', '想看B'],
    )
    assert.ok(value.data.items.every((i) => i.assetId))
  } finally {
    cleanup()
  }
})

test('pick: from=paused and from=both switch the pool; mediaType narrows it', async () => {
  const { dbPath, cleanup } = scratch()
  try {
    const h = await harness({ databasePath: dbPath })
    await seed(dbPath, [
      { id: UUID, title: '想看A', media_type: 'movie', status: 'planned' },
      { id: '33333333-2222-3333-4444-555555555555', title: '搁置C', media_type: 'game', status: 'paused' },
      { id: '66666666-2222-3333-4444-555555555555', title: '搁置D', media_type: 'movie', status: 'paused' },
    ])
    const paused = await h.pick.execute({ from: 'paused' }, exec())
    assert.equal(paused.data.total, 2)
    assert.deepEqual(paused.data.items.map((i) => i.title).sort(), ['搁置C', '搁置D'])

    const both = await h.pick.execute({ from: 'both' }, exec())
    assert.equal(both.data.total, 3)

    const movies = await h.pick.execute({ from: 'both', mediaType: 'movie' }, exec())
    assert.equal(movies.data.total, 2)
    assert.ok(movies.data.items.every((i) => i.mediaType === 'movie'))
  } finally {
    cleanup()
  }
})

test('pick: an empty pool is an honest ok with a hint, not an error', async () => {
  const { dbPath, cleanup } = scratch()
  try {
    const h = await harness({ databasePath: dbPath })
    const value = await h.pick.execute({}, exec())
    assert.equal(value.ok, true)
    assert.deepEqual(value.data.items, [])
    assert.equal(value.data.total, 0)
    const text = render(h.pick, {}, value)
    assert.match(text, /想看清单还空着/)
    const pausedValue = await h.pick.execute({ from: 'paused' }, exec())
    assert.match(render(h.pick, {}, pausedValue), /没有搁置中的记录/)
  } finally {
    cleanup()
  }
})

test('pick: argument validation runs before the library is opened', async () => {
  const { dbPath, cleanup } = scratch() // NEVER '' — that is the real library
  try {
    const h = await harness({ databasePath: dbPath })
    for (const args of [{ from: 'completed' }, { count: 0 }, { count: 6 }, { nope: 1 }]) {
      const value = await h.pick.execute(args, exec())
      assert.equal(value.ok, false, JSON.stringify(args))
      assert.equal(value.error.code, 'INVALID_ARGUMENT')
    }
    const ok1 = await h.pick.execute({ count: 1 }, exec())
    assert.equal(ok1.ok, true)
    assert.equal(ok1.data.items.length, 0) // empty temp library → empty pick
  } finally {
    cleanup()
  }
})

test('pick: render names the source and the next step', async () => {
  const { dbPath, cleanup } = scratch()
  try {
    const h = await harness({ databasePath: dbPath })
    await seed(dbPath, [
      { id: UUID, title: '沙丘2', media_type: 'movie', year: 2024, status: 'planned' },
      { id: '22222222-2222-3333-4444-555555555555', title: '艾尔登法环', media_type: 'game', status: 'planned' },
    ])
    const value = await h.pick.execute({ count: 1 }, exec())
    const text = render(h.pick, {}, value)
    assert.match(text, /从想看清单的 2 部里挑了 1 部/)
    assert.match(text, /《沙丘2》|《艾尔登法环》/)
    assert.match(text, /标成在看/)
  } finally {
    cleanup()
  }
})

test('pickCandidates: injectable rng picks deterministically, never repeats, never exceeds the pool', () => {
  let calls = 0
  const seq = [0.9, 0.0, 0.5, 0.99, 0.1]
  const rng = () => seq[calls++ % seq.length]
  const pool = ['a', 'b', 'c', 'd']
  const picked = pickCandidates(pool, 3, rng)
  assert.equal(picked.length, 3)
  assert.equal(new Set(picked).size, 3)
  assert.deepEqual(picked, ['d', 'a', 'c']) // 0.9*4→3='d'; 0*3→0='a'; 0.5*2→1='c'
  assert.deepEqual(pool, ['a', 'b', 'c', 'd']) // input untouched
  assert.equal(pickCandidates(['x'], 5, rng).length, 1) // pool < count → whole pool
})
