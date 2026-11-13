// One-way export: dumps every table of this plugin's library into one JSON
// file. The source is opened READ-ONLY and is never written to — an export
// must not migrate, create tables, or otherwise touch the file it reads, so it
// does NOT go through openLibrary(). An older library simply exports the
// tables it has; missing ones are reported rather than invented.
//
// 用法：
//   node scripts/export-library.mjs [--from <media.db 绝对路径>] [--out <export.json>]
//
// 不带 --out 时打到 stdout，方便接管道。JSON 保留原始列名和库的 user_version，
// 让未来的导入（或任何别的工具）看到的就是库里存的原样——长字段不截断：这个
// 文件是档案，不是渲染结果。输出文件只新建、不覆盖，按 0o600 落盘。

import { DatabaseSync } from 'node:sqlite'
import { statSync, writeFileSync } from 'node:fs'
import { resolveDatabasePath } from '../src/db.js'

/** The library's tables, in dump order. */
const KNOWN_TABLES = ['media', 'subscriptions', 'software', 'changes']

function parseArgs(argv) {
  /** @type {{from?: string, out?: string}} */
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag !== '--from' && flag !== '--out') throw new Error(`未知参数 ${flag}（只接受 --from / --out）`)
    const value = argv[++i]
    if (!value || value.startsWith('--')) throw new Error(`${flag} 后需要提供路径。`)
    out[flag.slice(2)] = value
  }
  return { from: out.from ?? '', out: out.out ?? '' }
}

/**
 * Dumps the library at `from` (default: the conventional location) to a JSON
 * document. Returns the document and the counts so a run can be verified by
 * eye: counts should match what the tools report.
 * @param {{from?: string, out?: string}} options
 * @returns {{json: string, counts: Record<string, number>, libraryVersion: number, missingTables: string[], writtenTo: string}}
 */
export async function exportLibrary({ from = '', out = '' } = {}) {
  const sourcePath = resolveDatabasePath(from)
  try {
    statSync(sourcePath)
  } catch {
    throw new Error(`资料库不存在：${sourcePath}（它会在插件第一次写入时自动创建）`)
  }

  // readOnly: an export must not create tables, run migrations, or otherwise
  // touch the file it reads. If the file is not a library at all, say so
  // instead of exporting an empty document that looks like a successful
  // backup. node:sqlite opens lazily, so the "not a database" error can come
  // from the constructor OR the first prepare — both are translated here.
  /**
   * @param {() => unknown} fn
   */
  const notADatabase = (fn) => {
    try {
      return fn()
    } catch (error) {
      if (/file is not a database|unable to open database file/i.test(String(/** @type {any} */ (error).message))) {
        throw new Error(`${sourcePath} 不是 SQLite 资料库文件——本插件的资料库是 media.db。`)
      }
      throw error
    }
  }
  const db = notADatabase(() => new DatabaseSync(sourcePath, { readOnly: true }))
  try {
    const tables = notADatabase(() =>
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => String(r.name)),
    )
    if (!tables.includes('media')) {
      throw new Error(`${sourcePath} 里没有 media 表——这不像本插件的资料库。`)
    }
    const present = KNOWN_TABLES.filter((t) => tables.includes(t))
    const missingTables = KNOWN_TABLES.filter((t) => !tables.includes(t))

    /** @type {Record<string, unknown[]>} */
    const dumped = {}
    /** @type {Record<string, number>} */
    const counts = {}
    for (const table of present) {
      dumped[table] = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
      counts[table] = dumped[table].length
    }
    const libraryVersion = db.prepare('PRAGMA user_version').get().user_version

    const document = {
      format: 'dsh-media-log-export',
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      library: { path: sourcePath, userVersion: libraryVersion },
      counts,
      ...(missingTables.length > 0 ? { missingTables } : {}),
      tables: dumped,
    }
    const json = JSON.stringify(document, null, 2)

    if (out !== '') {
      // Exclusive creation also refuses aliases (symlinks / hard links) of
      // the source library, without a separate path check that can race.
      try {
        writeFileSync(out, json, { mode: 0o600, flag: 'wx' })
      } catch (error) {
        if (error.code === 'EEXIST') {
          throw new Error(`输出文件已存在，拒绝覆盖：${out}。请换一个新的 JSON 文件路径。`)
        }
        throw error
      }
    }
    return { json, counts, libraryVersion, missingTables, writtenTo: out, sourcePath }
  } finally {
    db.close()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const { from, out } = parseArgs(process.argv.slice(2))
    const result = await exportLibrary({ from, out })
    if (result.writtenTo === '') process.stdout.write(`${result.json}\n`)
    const where = result.writtenTo !== '' ? result.writtenTo : 'stdout'
    const parts = Object.entries(result.counts).map(([t, n]) => `${t} ${n}`)
    console.error(`[export] 源库 ${result.sourcePath}（user_version ${result.libraryVersion}）`)
    console.error(`[export] ${parts.join('，')}`)
    if (result.missingTables.length > 0) {
      console.error(`[export] 这些表不存在（旧版本资料库），未导出：${result.missingTables.join('、')}`)
    }
    console.error(`[export] 已写出 ${where}`)
  } catch (error) {
    console.error(`[export] 失败：${error.message}`)
    process.exitCode = 1
  }
}
