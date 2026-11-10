// Plugin configuration resolution. Config values may arrive as plain values
// or, on some dsh versions, as live boxes ({ get() }) — unwrap before use.
// Every field is re-resolved per tool call so a settings write takes effect
// without remounting.

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
