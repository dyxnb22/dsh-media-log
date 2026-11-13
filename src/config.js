// Plugin configuration resolution. Config values may arrive as plain values
// or, on some dsh versions, as live boxes ({ get() }) — unwrap before use.
// Every field is re-resolved per tool call so a settings write takes effect
// without remounting.

import { isAbsolute } from 'node:path'
import { fail } from './errors.js'

/**
 * Unwraps one config value as it stands right now (paste-dock pattern).
 * @param {unknown} raw
 * @returns {unknown}
 */
export function readLiveValue(raw) {
  if (
    raw !== null &&
    typeof raw === 'object' &&
    typeof /** @type {{get?: unknown}} */ (raw).get === 'function'
  ) {
    return /** @type {{get: () => unknown}} */ (raw).get()
  }
  return raw
}

/**
 * @typedef {Object} ResolvedConfig
 * @property {string} databasePath absolute library path ('' = conventional default)
 * @property {boolean} writeEnabled
 */

/**
 * Resolves the activation config into plain values. Validation that needs the
 * session-visible error vocabulary happens in the tools, not here: this only
 * normalizes types and defaults.
 * @param {Record<string, unknown>} raw
 * @returns {ResolvedConfig}
 */
export function resolveConfig(raw) {
  const str = (key) => {
    const value = readLiveValue(raw?.[key])
    return typeof value === 'string' ? value.trim() : ''
  }
  return {
    databasePath: str('databasePath'),
    writeEnabled: readLiveValue(raw?.writeEnabled) === true,
  }
}

/**
 * Config readiness for one tool call. Returns the failure to report, or null
 * when the call may proceed. Shared by every module's tools, so a relative
 * path or a closed write gate reads the same way whichever tool hit it.
 * @param {ResolvedConfig} cfg
 * @param {{isWrite: boolean}} options
 * @returns {ReturnType<typeof fail> | null}
 */
export function ensureReady(cfg, { isWrite }) {
  // A relative path would silently resolve against the Host process cwd.
  if (cfg.databasePath !== '' && !isAbsolute(cfg.databasePath)) {
    return fail(
      'CONFIG_REQUIRED',
      'databasePath 需要是绝对路径；留空则用默认位置 ~/.dsh/media-log/media.db。',
    )
  }
  if (isWrite && !cfg.writeEnabled) {
    return fail('WRITE_DISABLED', '写入未开启。需要在 Mac 上打开插件的 writeEnabled 设置后才能记录。')
  }
  return null
}
