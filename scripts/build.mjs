import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
const root = new URL('../', import.meta.url)
const host = await build({
  absWorkingDir: fileURLToPath(root), entryPoints: ['login-entry.js'], bundle: true, write: false,
  platform: 'node', format: 'esm', target: 'node22', packages: 'external', legalComments: 'inline',
})
const text = host.outputFiles[0].text
const revision = createHash('sha256').update(text).digest('hex').slice(0, 12)
const directory = new URL(`dist/login/${revision}/`, root)
await mkdir(directory, { recursive: true })
const path = new URL('index.js', directory)
let previous
try { previous = await readFile(path, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
if (previous !== undefined && previous !== text) throw new Error(`Immutable login release collision: ${revision}`)
if (previous === undefined) await writeFile(path, text, { flag: 'wx' })
await build({
  absWorkingDir: fileURLToPath(root), entryPoints: ['client-entry.js'], outfile: 'lib/client.js', bundle: true,
  platform: 'browser', format: 'iife', target: 'es2022', legalComments: 'inline',
})
// The existing fetch wrapper remains a separate, unchanged entry. Adding or
// updating the login UI never requires unloading the active request wrapper.
const patch = `- insert:\n    - id: anthropic-auth\n      name: dsh-anthropic-auth\n    - id: anthropic-login-${revision}\n      name: ./dist/login/${revision}/index.js\n`
const patchPath = new URL('cordis.patch.yml', root)
if (await readFile(patchPath, 'utf8') !== patch) await writeFile(patchPath, patch)
console.log(`Anthropic native login ${revision}`)
