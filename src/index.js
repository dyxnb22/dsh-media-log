// dsh-media-log — host entry. Registers the three media_log_* tools over the
// plugin's own SQLite library. Pure ESM; @deepseek-ai/dsh-tools and
// @deepseek-ai/schemastery are host-provided peers.

import z from '@deepseek-ai/schemastery'
import { createTools, createLibraryHolder } from './tools.js'
import { resolveConfig } from './config.js'

/** Plugin display name, shown in loader diagnostics. */
export const name = 'dsh-media-log'

/** The tools service this plugin consumes. */
export const inject = ['tools']

/**
 * The plugin's own Config — where the library lives and the write gate. All
 * fields are read live per tool call, so a settings write takes effect
 * without remounting.
 */
export const Config = z.object({
  /** Absolute path to the library file; empty uses ~/.dsh/media-log/media.db. */
  databasePath: z
    .string()
    .default('')
    .description('资料库文件的绝对路径；留空则用 ~/.dsh/media-log/media.db（首次使用自动创建）'),
  /** Writes stay OFF until the user turns this on explicitly. */
  writeEnabled: z.boolean().default(false).description('允许记录/更新（默认关闭）'),
})

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx host context
 * @param {Record<string, unknown>} config activation config
 */
export function apply(ctx, config = {}) {
  const getLibrary = createLibraryHolder()
  const tools = createTools(() => resolveConfig(config), getLibrary)
  for (const tool of tools) {
    ctx.tools.register(tool)
  }
  const listed = tools.map((tool) => `${tool.name}=${ctx.tools.get(tool.name) !== undefined}`).join(', ')
  const cfg = resolveConfig(config)
  console.log(
    `[dsh-media-log] host ready — ${tools.length} tools registered (${listed}); writeEnabled=${cfg.writeEnabled}`,
  )
}
