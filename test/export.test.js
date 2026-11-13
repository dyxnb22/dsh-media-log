// Tests for the export script: full fidelity, read-only source, honest
// refusal when the file is not a library.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, symlinkSync, linkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportLibrary } from '../scripts/export-library.mjs'
import { openLibrary } from '../src/db.js'

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'export-test-'))
  return {
    dir,
    dbPath: join(dir, 'media.db'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/** Seeds one row per supported table through the REAL openLibrary. */
async function seedLibrary(dbPath) {
  const db = await openLibrary(dbPath)
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO media (id, title, media_type, year, status, rating, notes, lifecycle, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('11111111-2222-3333-4444-555555555555', '沙丘2', 'movie', 2024, 'completed', 8, '视听盛宴', 'active', 3, now, now)
  db.prepare(
    `INSERT INTO subscriptions (id, name, amount_minor, currency, cycle, auto_renew, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('22222222-2222-3333-4444-555555555555', 'Netflix', 2000, 'USD', 'monthly', 1, 2, now, now)
  db.prepare(
    `INSERT INTO software (id, name, purpose, status, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('33333333-2222-3333-4444-555555555555', 'SubtitleEdit', '校准字幕', 'in_use', 1, now, now)
  db.prepare(
    `INSERT INTO changes (at, module, asset_id, name, action, summary) VALUES (?, 'media', 'x', '沙丘2', 'create', '状态=completed')`,
  ).run(now)
  db.close()
}

test('export: every table comes across in full, and the source is untouched', async () => {
  const s = scratch()
  try {
    await seedLibrary(s.dbPath)
    const dbHash = createHash('sha256').update(readFileSync(s.dbPath)).digest('hex')
    const out = join(s.dir, 'export.json')
    const result = await exportLibrary({ from: s.dbPath, out })

    assert.equal(result.counts.media, 1)
    assert.equal(result.counts.subscriptions, 1)
    assert.equal(result.counts.software, 1)
    assert.equal(result.counts.changes, 1)
    assert.deepEqual(result.missingTables, [])
    assert.equal(result.libraryVersion, 7)

    const doc = JSON.parse(readFileSync(out, 'utf8'))
    assert.equal(doc.format, 'dsh-media-log-export')
    assert.equal(doc.library.userVersion, 7)
    assert.deepEqual(Object.keys(doc.tables), ['media', 'subscriptions', 'software', 'changes'])
    assert.equal(doc.tables.media[0].title, '沙丘2')
    assert.equal(doc.tables.media[0].notes, '视听盛宴', 'long fields are not truncated')
    assert.equal(doc.tables.subscriptions[0].amount_minor, 2000)
    assert.equal(doc.tables.software[0].purpose, '校准字幕')
    assert.equal(doc.tables.changes[0].action, 'create')

    // The export must not have changed the library file itself. (A read-only
    // WAL connection may leave a -shm beside it; that is SQLite's business,
    // not a write to the data.)
    const afterHash = createHash('sha256').update(readFileSync(s.dbPath)).digest('hex')
    assert.equal(afterHash, dbHash, 'the library bytes are identical after the export')

    // The export file is written owner-only, like the library itself.
    const mode = statSync(out).mode & 0o777
    assert.equal(mode, 0o600, `expected 0o600, got ${mode.toString(8)}`)
  } finally {
    s.cleanup()
  }
})

test('export: an older library exports what it has and names what it lacks', async () => {
  const s = scratch()
  try {
    // A v1-era library: media only.
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(s.dbPath)
    db.exec(`CREATE TABLE media (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, media_type TEXT NOT NULL, year INTEGER,
      status TEXT NOT NULL, rating REAL, progress_current REAL, progress_total REAL,
      progress_unit TEXT, notes TEXT, lifecycle TEXT NOT NULL DEFAULT 'active',
      revision INTEGER NOT NULL DEFAULT 1, started_at TEXT, completed_at TEXT,
      archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`)
    db.exec(`INSERT INTO media (id, title, media_type, status, created_at, updated_at)
             VALUES ('11111111-2222-3333-4444-555555555555', '老记录', 'movie', 'completed',
                     '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`)
    db.exec('PRAGMA user_version = 1')
    db.close()

    const result = await exportLibrary({ from: s.dbPath })
    assert.deepEqual(result.counts, { media: 1 })
    assert.deepEqual(result.missingTables, ['subscriptions', 'software', 'changes'])
    assert.equal(result.libraryVersion, 1)

    const doc = JSON.parse(result.json)
    assert.deepEqual(doc.tables.media.length, 1)
    assert.equal(doc.tables.media[0].title, '老记录')
  } finally {
    s.cleanup()
  }
})

for (const alias of ['source path', 'symlink', 'hard link']) {
  test(`export: refuses to overwrite the library through ${alias}`, async () => {
    const s = scratch()
    try {
      await seedLibrary(s.dbPath)
      const before = readFileSync(s.dbPath)
      const out = alias === 'source path' ? s.dbPath : join(s.dir, 'alias.json')
      if (alias === 'symlink') symlinkSync(s.dbPath, out)
      if (alias === 'hard link') linkSync(s.dbPath, out)

      await assert.rejects(exportLibrary({ from: s.dbPath, out }), /输出文件已存在.*拒绝覆盖/)
      assert.deepEqual(readFileSync(s.dbPath), before, 'refusal must leave every library byte intact')
      const db = new DatabaseSync(s.dbPath, { readOnly: true })
      try {
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM media').get().n, 1)
      } finally {
        db.close()
      }
    } finally {
      s.cleanup()
    }
  })
}

test('export: refuses to overwrite an existing export file', async () => {
  const s = scratch()
  try {
    await seedLibrary(s.dbPath)
    const out = join(s.dir, 'export.json')
    const previousExport = '{"previousBackup":true}'
    writeFileSync(out, previousExport)

    await assert.rejects(exportLibrary({ from: s.dbPath, out }), /输出文件已存在.*拒绝覆盖/)
    assert.equal(readFileSync(out, 'utf8'), previousExport)
  } finally {
    s.cleanup()
  }
})

for (const destination of ['stdout', 'file']) {
  test(`export: the successful CLI writes JSON to ${destination} and diagnostics to stderr`, async () => {
    const s = scratch()
    try {
      await seedLibrary(s.dbPath)
      const script = new URL('../scripts/export-library.mjs', import.meta.url).pathname
      const out = join(s.dir, 'export.json')
      const args = [script, '--from', s.dbPath]
      if (destination === 'file') args.push('--out', out)
      const result = spawnSync(process.execPath, args, { encoding: 'utf8' })

      assert.equal(result.status, 0, result.stderr)
      const json = destination === 'stdout' ? result.stdout : readFileSync(out, 'utf8')
      const doc = JSON.parse(json)
      assert.equal(doc.format, 'dsh-media-log-export')
      assert.equal(doc.tables.media[0].title, '沙丘2')
      assert.deepEqual(doc.counts, { media: 1, subscriptions: 1, software: 1, changes: 1 })
      assert.match(result.stderr, /已写出/)
      if (destination === 'file') assert.equal(result.stdout, '')
    } finally {
      s.cleanup()
    }
  })
}

test('export: refuses a file that is not a library, and a missing one', async () => {
  const s = scratch()
  try {
    // Not even SQLite.
    const notALibrary = join(s.dir, 'random.db')
    writeFileSync(notALibrary, 'definitely not sqlite')
    await assert.rejects(exportLibrary({ from: notALibrary }), /不是 SQLite 资料库文件/)

    // Valid SQLite, but not OUR library: no media table.
    const { DatabaseSync } = await import('node:sqlite')
    const foreign = join(s.dir, 'foreign.db')
    const other = new DatabaseSync(foreign)
    other.exec('CREATE TABLE something_else (id TEXT)')
    other.close()
    await assert.rejects(exportLibrary({ from: foreign }), /media 表/)

    await assert.rejects(exportLibrary({ from: join(s.dir, 'missing.db') }), /资料库不存在/)
  } finally {
    s.cleanup()
  }
})

test('export: the CLI refuses bad arguments instead of guessing', async () => {
  const { execFileSync } = await import('node:child_process')
  const script = new URL('../scripts/export-library.mjs', import.meta.url).pathname
  assert.throws(
    () => execFileSync(process.execPath, [script, '--bogus', 'x'], { encoding: 'utf8' }),
    /未知参数/,
  )
  // A valid run against a missing library fails with a clean message and code 1.
  const s = scratch()
  try {
    assert.throws(
      () => execFileSync(process.execPath, [script, '--from', join(s.dir, 'missing.db')], { encoding: 'utf8' }),
      /资料库不存在/,
    )
  } finally {
    s.cleanup()
  }
})
