// AC-T02-06 — empacota `@crm/shared` com o Vite (alvo browser, sem polyfills de Node) e executa
// o bundle num contexto `vm` sem `process`/`require`/`Buffer`. Imprime um JSON com o resultado.
// Uso: node tests/acceptance/T02/browser-build.mjs   (a partir da raiz do worktree)
import { builtinModules, createRequire } from 'node:module'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const result = { ok: false, nodeImports: [], warnings: [], exports: [], checks: {}, error: null }

// O Vite chega pelo vitest (dependência da raiz); a raiz não declara `vite` diretamente.
const vitestPkg = realpathSync(join(ROOT, 'node_modules', 'vitest', 'package.json'))
const vitePkgPath = createRequire(vitestPkg).resolve('vite/package.json')
const vitePkg = JSON.parse((await import('node:fs')).readFileSync(vitePkgPath, 'utf8'))
const viteEntry = join(vitePkgPath, '..', typeof vitePkg.exports['.'] === 'string' ? vitePkg.exports['.'] : vitePkg.exports['.'].import?.default ?? vitePkg.exports['.'].import ?? vitePkg.exports['.'].default)
const { build } = await import(pathToFileURL(viteEntry).href)
result.vite = vitePkg.version

const tmp = mkdtempSync(join(tmpdir(), 'crm-t02-browser-'))
const entry = join(tmp, 'entry.js')
writeFileSync(entry, "export * from '@crm/shared'\n")

const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]))
const isBuiltin = (id) => id.startsWith('node:') || BUILTINS.has(id) || BUILTINS.has(id.split('/')[0])

try {
  const out = await build({
    configFile: false,
    logLevel: 'silent',
    root: tmp,
    resolve: {
      // Mesma resolução da condição `development` (SPEC 3.1): fonte do pacote.
      alias: [{ find: /^@crm\/shared$/, replacement: join(ROOT, 'packages', 'shared', 'src', 'index.ts') }],
    },
    // Equivalente ao build de app do Vite (lib mode não substitui process.env.NODE_ENV).
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    plugins: [
      {
        name: 'no-node-builtins',
        enforce: 'pre',
        resolveId(id, importer) {
          if (isBuiltin(id)) result.nodeImports.push(`${id} ← ${importer ?? '?'}`)
          return null
        },
      },
    ],
    build: {
      write: false,
      minify: false,
      emptyOutDir: false,
      lib: { entry, formats: ['iife'], name: 'CrmShared', fileName: () => 'crm-shared.js' },
      rolldownOptions: {
        onwarn(w) {
          result.warnings.push(String(w.message ?? w))
        },
      },
    },
  })
  const outputs = (Array.isArray(out) ? out : [out]).flatMap((o) => o.output ?? [])
  const chunk = outputs.find((o) => o.type === 'chunk')
  if (!chunk) throw new Error('build sem chunk de saída')
  const code = chunk.code
  result.checks.browserExternal = code.includes('__vite-browser-external')
  result.checks.bytes = code.length

  // Contexto "browser": só os builtins do JS + console/globalThis. Sem process/require/Buffer.
  const sandbox = { console }
  sandbox.globalThis = sandbox
  sandbox.window = sandbox
  sandbox.self = sandbox
  const ctx = vm.createContext(sandbox)
  vm.runInContext(code, ctx, { filename: 'crm-shared.js' })
  const lib = ctx.CrmShared
  if (!lib || typeof lib !== 'object') throw new Error('bundle não expôs CrmShared')
  result.exports = Object.keys(lib).sort()
  result.checks.noProcess = vm.runInContext('typeof process === "undefined" && typeof require === "undefined" && typeof Buffer === "undefined"', ctx)
  if (typeof lib.httpStatusOf === 'function') result.checks.httpStatusOf = lib.httpStatusOf('NOT_FOUND')
  if (typeof lib.parsePhone === 'function') {
    try {
      const v = lib.parsePhone('+55 (11) 99999-8888')
      result.checks.parsePhone = typeof v === 'string' ? v : v && (v.e164 ?? v.value ?? v.phone ?? JSON.stringify(v))
    } catch (e) {
      result.checks.parsePhone = `throw: ${e?.message ?? e}`
    }
  }
  if (typeof lib.can === 'function') {
    result.checks.canOwner = lib.can({ role: 'owner', permission_keys: null, permissionKeys: null, permissions: null }, 'chat.view')
  }
  result.ok = result.nodeImports.length === 0 && !result.checks.browserExternal
} catch (e) {
  result.error = String(e?.stack ?? e)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

process.stdout.write(`${JSON.stringify(result)}\n`)
