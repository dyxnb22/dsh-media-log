// The boilerplate every test file shares: a fresh temp directory per test,
// the exec envelope, the joined render text, and a loud tool lookup. Module
// harnesses and seeds stay in each file — their shapes are module-specific.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

/** A fresh temp directory with a library path inside; call cleanup() when done. */
export function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'media-log-test-'))
  return {
    dir,
    dbPath: join(dir, 'media.db'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/** The exec envelope the tools accept; pass a signal to test cancellation. */
export const exec = (signal) => ({ signal: signal ?? new AbortController().signal })

/** Joins the tool's render output into the text the model finally sees. */
export const render = (tool, args, value) =>
  tool.output.render(args, value).map((b) => b.text).join('\n')

/** Picks one tool by name, failing loudly when it is missing. */
export function byName(tools, name) {
  const tool = tools.find((t) => t.name === name)
  assert.ok(tool, `missing tool ${name}`)
  return tool
}
