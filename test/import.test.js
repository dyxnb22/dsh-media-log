// Round-trip test for the importer: builds a minimal AssetMesh-shaped source
// library, imports it, and checks that every field the tools expose survives.
// The real 787-row library is never touched here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, linkSync, symlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { importAssetmesh } from '../scripts/import-assetmesh.mjs'
import { createTools } from '../src/tools.js'
import { createLibraryHolder } from '../src/db.js'

const UUID = '11111111-2222-3333-4444-555555555555'
const OTHER = 'aaaaaaaa-2222-3333-4444-555555555555'

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'media-log-import-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** A source library shaped like AssetMesh's, with only the tables we read. */
function makeAssetmeshShaped(path) {
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE assets (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, summary TEXT,
      lifecycle_state TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      archived_at TEXT, merged_into_asset_id TEXT);
    CREATE TABLE media_records (
      asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
      media_type TEXT NOT NULL, status TEXT NOT NULL, rating REAL, year INTEGER,
      platform TEXT, progress_current REAL, progress_total REAL, progress_unit TEXT,
      notes TEXT, started_at TEXT, completed_at TEXT);
    CREATE TABLE activity_events (id INTEGER PRIMARY KEY, kind TEXT);
    CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT);
  `)
  const asset = db.prepare(
    `INSERT INTO assets (id, kind, name, summary, lifecycle_state, revision, created_at, updated_at, archived_at, merged_into_asset_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const media = db.prepare(
    `INSERT INTO media_records (asset_id, media_type, status, rating, year, platform,
       progress_current, progress_total, progress_unit, notes, started_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const now = '2026-09-24T12:59:54.163384+00:00'
  asset.run(UUID, 'media.movie', '完美的日子', 'Movie · 2023', 'active', 2, now, now, null, null)
  media.run(UUID, 'movie', 'completed', 8, 2023, null, null, null, null, '日常拍得很温柔', null, '2025-07-09T00:00:00+00:00')

  asset.run(OTHER, 'media.game', '塞尔达', null, 'archived', 5, now, now, '2026-01-01T00:00:00+00:00', null)
  media.run(OTHER, 'game', 'in_progress', 10, 2023, 'Switch', 12, 30, '小时', null, '2026-02-02T00:00:00+00:00', null)

  // A non-media asset must be ignored.
  asset.run('cccccccc-2222-3333-4444-555555555555', 'software', '某个软件', null, 'active', 1, now, now, null, null)
  // A merged asset maps to archived rather than being dropped.
  asset.run('dddddddd-2222-3333-4444-555555555555', 'media.tv', '被合并的一部', null, 'merged', 3, now, now, null, UUID)
  media.run('dddddddd-2222-3333-4444-555555555555', 'tv', 'planned', null, null, null, null, null, null, null, null, null)
  db.close()
}

test('importer carries every exposed field across and ignores other modules', async () => {
  const s = scratch()
  try {
    const from = join(s.dir, 'assetmesh.db')
    makeAssetmeshShaped(from)
    const result = await importAssetmesh({ from, to: join(s.dir, 'media.db') })
    assert.equal(result.read, 3, 'the software asset is not a media record')
    assert.equal(result.inserted, 3)
    assert.equal(result.skipped, 0)

    const { get } = await harnessAt(join(s.dir, 'media.db'))
    const day = await get.execute({ assetId: UUID, includeNotes: true }, exec())
    assert.equal(day.data.title, '完美的日子')
    assert.equal(day.data.mediaType, 'movie')
    assert.equal(day.data.status, 'completed')
    assert.equal(day.data.rating, 8)
    assert.equal(day.data.year, 2023)
    assert.equal(day.data.notes, '日常拍得很温柔')
    assert.equal(day.data.revision, 2)
    assert.equal(day.data.completedAt, '2025-07-09T00:00:00+00:00')
    assert.equal(day.data.lifecycle, 'active')

    const game = await get.execute({ assetId: OTHER }, exec())
    assert.equal(game.data.status, 'in_progress')
    assert.deepEqual(game.data.progress, { current: 12, total: 30, unit: '小时' })
    assert.equal(game.data.lifecycle, 'archived')
    assert.equal(game.data.revision, 5)

    const merged = await get.execute({ assetId: 'dddddddd-2222-3333-4444-555555555555' }, exec())
    assert.equal(merged.data.status, 'planned', 'planned is readable even though mark will not write it')
    assert.equal(merged.data.lifecycle, 'archived')
  } finally {
    s.cleanup()
  }
})

test('importer is idempotent', async () => {
  const s = scratch()
  try {
    const from = join(s.dir, 'assetmesh.db')
    makeAssetmeshShaped(from)
    const to = join(s.dir, 'media.db')
    const first = await importAssetmesh({ from, to })
    const second = await importAssetmesh({ from, to })
    assert.equal(first.inserted, 3)
    assert.equal(second.inserted, 0)
    assert.equal(second.skipped, 3)
    assert.equal(second.after, 3)
  } finally {
    s.cleanup()
  }
})

test('importer refuses a file that is not an AssetMesh library', async () => {
  const s = scratch()
  try {
    const bogus = join(s.dir, 'bogus.db')
    const db = new DatabaseSync(bogus)
    db.exec('CREATE TABLE unrelated (x)')
    db.close()
    const to = join(s.dir, 'out.db')
    await assert.rejects(() => importAssetmesh({ from: bogus, to }), /不像一个 AssetMesh/)
    assert.equal(existsSync(to), false, 'a rejected source must not create the destination')
  } finally {
    s.cleanup()
  }
})

test('importer rolls back invalid new rows instead of counting them as duplicates', async () => {
  for (const status of ['rewatching', null]) {
    const s = scratch()
    try {
      const from = join(s.dir, 'source.db')
      const to = join(s.dir, 'target.db')
      makeAssetmeshShaped(from)
      const source = new DatabaseSync(from)
      // Simulate a source schema that now permits this value; keep its row last
      // so earlier successful inserts must also be rolled back.
      if (status === null) source.exec('ALTER TABLE media_records RENAME TO old_media_records; CREATE TABLE media_records AS SELECT * FROM old_media_records')
      source.prepare('UPDATE media_records SET status = ? WHERE asset_id = ?').run(status, OTHER)
      source.prepare('UPDATE assets SET created_at = ? WHERE id = ?').run('2099', OTHER)
      source.close()
      const { mark, getLibrary } = await harnessAt(to)
      const existing = await mark.execute({
        target: { title: '目标库自己的记录', mediaType: 'movie' }, status: 'completed', notes: '保留这条',
      }, exec())
      const target = await getLibrary(to)
      try {
        const before = target.prepare('SELECT * FROM media').all()
        assert.equal(existing.ok, true)
        await assert.rejects(() => importAssetmesh({ from, to }), /constraint failed/i)
        assert.deepEqual(target.prepare('SELECT * FROM media').all(), before)
      } finally {
        target.close()
      }
    } finally {
      s.cleanup()
    }
  }
})

test('importer rejects the source itself, including filesystem aliases, without modifying it', async () => {
  const s = scratch()
  try {
    const from = join(s.dir, 'source.db')
    makeAssetmeshShaped(from)
    const hardlink = join(s.dir, 'hardlink.db')
    const symlink = join(s.dir, 'symlink.db')
    linkSync(from, hardlink)
    symlinkSync(from, symlink)
    const before = readFileSync(from)
    for (const to of [from, hardlink, symlink]) {
      await assert.rejects(() => importAssetmesh({ from, to }), /源库.*目标库.*同一/)
      assert.deepEqual(readFileSync(from), before)
      assert.equal(existsSync(`${from}-wal`), false)
    }
  } finally {
    s.cleanup()
  }
})

test('importer CLI rejects a missing --to value without writing the default destination', () => {
  const s = scratch()
  try {
    const from = join(s.dir, 'source.db')
    makeAssetmeshShaped(from)
    const dshHome = join(s.dir, 'isolated-dsh-home')
    const script = fileURLToPath(new URL('../scripts/import-assetmesh.mjs', import.meta.url))
    const result = spawnSync(process.execPath, [script, '--from', from, '--to'], {
      env: { ...process.env, DSH_HOME: dshHome }, encoding: 'utf8', timeout: 5000,
    })
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /--to.*路径/)
    assert.equal(existsSync(join(dshHome, 'media-log', 'media.db')), false)
  } finally {
    s.cleanup()
  }
})

/** Tools wired to a specific library path. */
async function harnessAt(dbPath) {
  const holder = createLibraryHolder()
  const tools = createTools(() => ({ databasePath: dbPath, writeEnabled: true }), holder)
  const [mark, , search, get] = tools
  return { mark, search, get, getLibrary: holder }
}

const exec = () => ({ signal: new AbortController().signal })
