// Build: the sources are already plain host ESM (no transpilation needed),
// so the build copies src/**.js into dist/ preserving layout. dist/index.js
// is the package main (package.json "files" ships dist only).
// 用法：node scripts/build.mjs
import { cpSync, mkdirSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const src = join(root, 'src')
const dist = join(root, 'dist')

rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })

// Only .js files travel to dist; nothing from test/ or scripts/ does.
function copyDir(from, to) {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.isDirectory()) copyDir(join(from, entry.name), join(to, entry.name))
    else if (entry.isFile() && entry.name.endsWith('.js')) {
      cpSync(join(from, entry.name), join(to, entry.name))
    }
  }
}
copyDir(src, dist)

console.log(`[dsh-media-log] built dist/ from src/`)
