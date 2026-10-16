import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BillingNotConfiguredError, NoopBillingProvider } from './index'

describe('NoopBillingProvider (AC-T18-05)', () => {
  it('createCheckout e parseWebhook rejeitam com BillingNotConfiguredError', async () => {
    const p = new NoopBillingProvider()
    await expect(
      p.createCheckout({ companyId: 'c', credits: 1000, amountCents: 100, currency: 'BRL', successUrl: 'x', cancelUrl: 'y' }),
    ).rejects.toBeInstanceOf(BillingNotConfiguredError)
    await expect(p.parseWebhook({ headers: {}, rawBody: '' })).rejects.toBeInstanceOf(BillingNotConfiguredError)
  })

  it('nenhuma rota HTTP importa billing/', () => {
    const routes = fileURLToPath(new URL('../../../../apps/api/src/routes', import.meta.url))
    const files: string[] = []
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.tsx?$/.test(f)) files.push(p)
      }
    }
    walk(routes)
    expect(files.length).toBeGreaterThan(0)
    const offenders = files.filter((f) => /from\s+['"][^'"]*\/billing(\/|['"])|NoopBillingProvider|BillingProvider/.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })
})
