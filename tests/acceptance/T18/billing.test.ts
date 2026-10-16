// AC-T18-05 — NoopBillingProvider só interface (sem cobrança) e nenhuma rota HTTP importa billing/.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT, rootPath, toPosix } from '../helpers/exec'

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(name)) out.push(full)
  }
  return out
}

const BILLING_SYMBOLS = /\b(NoopBillingProvider|BillingProvider|BillingNotConfiguredError)\b/
const BILLING_PATH = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]*\/billing(?:\/[^'"]*)?|@crm\/core\/billing[^'"]*)['"]/

describe('T18 — porta de cobrança', () => {
  it('AC-T18-05 NoopBillingProvider.createCheckout lança BillingNotConfiguredError', async () => {
    const core: any = await import('@crm/core')
    expect(typeof core.NoopBillingProvider).toBe('function')
    const provider = new core.NoopBillingProvider()
    expect(typeof provider.createCheckout).toBe('function')
    const err = await Promise.resolve()
      .then(() => provider.createCheckout({ companyId: '00000000-0000-0000-0000-000000000000', amountCents: 1000, currency: 'BRL' }))
      .then(
        () => null,
        (e: unknown) => e,
      )
    expect(err, 'createCheckout deveria falhar').toBeInstanceOf(core.BillingNotConfiguredError)
  })

  it('AC-T18-05 nenhuma rota HTTP (apps/**) importa billing/', () => {
    const offenders: string[] = []
    for (const app of readdirSync(rootPath('apps'))) {
      const src = rootPath('apps', app, 'src')
      try {
        statSync(src)
      } catch {
        continue
      }
      for (const file of sourceFiles(src)) {
        const text = readFileSync(file, 'utf8')
        const rel = toPosix(relative(ROOT, file))
        if (BILLING_PATH.test(text)) offenders.push(`${rel}: importa caminho billing`)
        if (/\/routes\//.test(rel) && BILLING_SYMBOLS.test(text)) offenders.push(`${rel}: usa símbolo de billing`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('AC-T18-05 a API não expõe rota de checkout/cobrança', async () => {
    const files = sourceFiles(rootPath('apps', 'api', 'src')).map((f) => readFileSync(f, 'utf8'))
    const routes = files.join('\n').match(/['"`]\/api\/[^'"`]*['"`]/g) ?? []
    expect(routes.filter((r) => /billing|checkout/i.test(r))).toEqual([])
  })
})
