// One-time importer: copies the media records from an AssetMesh library into
// this plugin's own library. The source is opened READ-ONLY and is never
// written to. Re-runnable: duplicate IDs are skipped, other invalid rows roll
// back the batch so they cannot be mistaken for already imported records.
//
// 用法：
//   node scripts/import-assetmesh.mjs --from <assetmesh.db 绝对路径> [--to <新库路径>]
//
// Only the fields the three tools expose are carried over. AssetMesh's other
// tables (activity_events, search_documents FTS, tags, relations, info_records,
// external_refs, software/service records) are the domain layer this plugin
// deliberately does not have, so they are not imported.

import { DatabaseSync } from 'node:sqlite'
import { statSync } from 'node:fs'
import { openLibrary, resolveDatabasePath, inTransaction } from '../src/db.js'

function parseArgs(argv) {
  /** @type {{from?: string, to?: string}} */
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag !== '--from' && flag !== '--to') throw new Error(`未知参数 ${flag}（只接受 --from / --to）`)
    const value = argv[++i]
    if (!value || value.startsWith('--')) throw new Error(`${flag} 后需要提供路径。`)
    out[flag.slice(2)] = value
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
  const targetPath = resolveDatabasePath(to)
  const sourceFile = statSync(from)
  let targetFile
  try {
    targetFile = statSync(targetPath)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (targetFile && sourceFile.dev === targetFile.dev && sourceFile.ino === targetFile.ino) {
    throw new Error('源库和目标库不能是同一个文件。')
  }

  const source = new DatabaseSync(from, { readOnly: true })
  let target
  try {
    // Validate/read the source before opening a writable destination.
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

    // Use the same schema and permissions as the tools. Only an ID conflict
    // counts as skipped; CHECK/NOT NULL failures must abort the whole import.
    target = await openLibrary(targetPath)
    const insert = target.prepare(
      `INSERT INTO media (id, title, media_type, year, status, rating,
         progress_current, progress_total, progress_unit, notes, lifecycle, revision,
         started_at, completed_at, archived_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )

    let inserted = 0
    let skipped = 0
    inTransaction(target, () => {
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
    })

    const after = target.prepare(`SELECT count(*) AS n FROM media`).get().n
    return { source: from, target: targetPath, read: rows.length, inserted, skipped, after }
  } finally {
    source.close()
    if (target?.isOpen) target.close()
  }
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
