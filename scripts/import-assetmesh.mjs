// One-time importer: copies the media records from an AssetMesh library into
// this plugin's own library. The source is opened READ-ONLY and is never
// written to. Re-runnable (INSERT OR IGNORE), so a partial run can simply be
// repeated.
//
// 用法：
//   node scripts/import-assetmesh.mjs --from <assetmesh.db 绝对路径> [--to <新库路径>]
//
// Only the fields the three tools expose are carried over. AssetMesh's other
// tables (activity_events, search_documents FTS, tags, relations, info_records,
// external_refs, software/service records) are the domain layer this plugin
// deliberately does not have, so they are not imported.

import { DatabaseSync } from 'node:sqlite'
import { openLibrary, resolveDatabasePath } from '../src/db.js'

function parseArgs(argv) {
  /** @type {{from?: string, to?: string}} */
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--from') out.from = argv[++i]
    else if (argv[i] === '--to') out.to = argv[++i]
    else throw new Error(`未知参数 ${argv[i]}（只接受 --from / --to）`)
  }
  if (!out.from) throw new Error('缺少 --from <assetmesh.db 的绝对路径>')
  return { from: out.from, to: out.to ?? '' }
}

/**
 * AssetMesh's lifecycle_state has three values; this library has two. A merged
 * record is superseded by another one, which is closest to "archived".
 */
function mapLifecycle(state) {
  return state === 'active' ? 'active' : 'archived'
}

/**
 * Copies every media record across. Returns the counts so a run can be
 * verified by eye: read should equal inserted + skipped on a fresh target.
 * @param {{from: string, to?: string}} options
 */
export async function importAssetmesh({ from, to = '' }) {
  const source = new DatabaseSync(from, { readOnly: true })
  // The target goes through the plugin's own openLibrary, so the schema,
  // permissions and user_version are exactly what the tools expect.
  const target = await openLibrary(to)

  // Sanity-check the source before touching anything: a wrong file should fail
  // loudly here rather than silently importing zero rows.
  const tables = source
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .all()
    .map((r) => r.name)
  for (const required of ['assets', 'media_records']) {
    if (!tables.includes(required)) {
      throw new Error(`${from} 里没有 ${required} 表——这不像一个 AssetMesh 资料库。`)
    }
  }

  const rows = source
    .prepare(
      `SELECT a.id, a.name, a.lifecycle_state, a.revision, a.created_at, a.updated_at,
              a.archived_at, m.media_type, m.status, m.rating, m.year,
              m.progress_current, m.progress_total, m.progress_unit, m.notes,
              m.started_at, m.completed_at
         FROM media_records m
         JOIN assets a ON a.id = m.asset_id
        WHERE a.kind LIKE 'media.%'
        ORDER BY a.created_at`,
    )
    .all()

  const insert = target.prepare(
    `INSERT OR IGNORE INTO media (id, title, media_type, year, status, rating,
       progress_current, progress_total, progress_unit, notes, lifecycle, revision,
       started_at, completed_at, archived_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  let inserted = 0
  let skipped = 0
  target.exec('BEGIN IMMEDIATE')
  try {
    for (const r of rows) {
      const info = insert.run(
        r.id,
        r.name,
        r.media_type,
        r.year ?? null,
        r.status,
        r.rating ?? null,
        r.progress_current ?? null,
        r.progress_total ?? null,
        r.progress_unit ?? null,
        r.notes ?? null,
        mapLifecycle(r.lifecycle_state),
        r.revision,
        r.started_at ?? null,
        r.completed_at ?? null,
        r.archived_at ?? null,
        r.created_at,
        r.updated_at,
      )
      if (info.changes > 0) inserted += 1
      else skipped += 1
    }
    target.exec('COMMIT')
  } catch (error) {
    target.exec('ROLLBACK')
    throw error
  }

  const after = target.prepare(`SELECT count(*) AS n FROM media`).get().n
  source.close()
  target.close()
  return { source: from, target: resolveDatabasePath(to), read: rows.length, inserted, skipped, after }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const { from, to } = parseArgs(process.argv.slice(2))
    const result = await importAssetmesh({ from, to })
    console.log(
      `[import] 源库 ${result.source}\n` +
        `[import] 目标库 ${result.target}\n` +
        `[import] 读到 ${result.read} 条媒体记录，插入 ${result.inserted}，跳过 ${result.skipped}，目标库现有 ${result.after} 条`,
    )
    if (result.read === 0) {
      console.log('[import] 警告：源库里没有媒体记录，请确认 --from 指对了文件。')
      process.exitCode = 1
    }
  } catch (error) {
    console.error(`[import] 失败：${error.message}`)
    process.exitCode = 1
  }
}
