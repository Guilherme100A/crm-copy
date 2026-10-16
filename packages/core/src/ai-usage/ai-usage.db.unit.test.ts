import { randomBytes } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { aiPricingSettings, aiUsage, aiWalletEntries, companies, createDb, llmPrices, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { PriceNotFoundError, UsageNotFoundError } from './errors'
import { DEFAULT_PRICING_SETTINGS, PricingService } from './pricing'
import { AiUsageService } from './usage'
import { WalletService } from './wallet'

let temp: TempDatabase
let db: Database
let pricing: PricingService
let wallet: WalletService
let usage: AiUsageService
const rnd = () => randomBytes(4).toString('hex')

async function company(): Promise<string> {
  const [c] = await db.insert(companies).values({ name: 'C', slug: `c-${rnd()}` }).returning({ id: companies.id })
  return c!.id
}

const ledgerSum = async (companyId: string) => {
  const [r] = await db
    .select({ s: sql<string>`coalesce(sum(${aiWalletEntries.amountCredits}), 0)` })
    .from(aiWalletEntries)
    .where(eq(aiWalletEntries.companyId, companyId))
  return Number(r!.s)
}

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 12 })
  pricing = new PricingService({ db })
  wallet = new WalletService({ db })
  usage = new AiUsageService({ db, pricing })
  await db.insert(llmPrices).values([
    { provider: 'anthropic', model: 'm1', effectiveFrom: new Date('2026-01-01T00:00:00Z'), inputPerMtokMicros: 3_000_000, outputPerMtokMicros: 15_000_000, cacheReadPerMtokMicros: 300_000, cacheWritePerMtokMicros: 3_750_000, reasoningPerMtokMicros: 20_000_000 },
    // preço dobra a partir de 2026-12-01
    { provider: 'anthropic', model: 'm1', effectiveFrom: new Date('2026-12-01T00:00:00Z'), inputPerMtokMicros: 6_000_000, outputPerMtokMicros: 30_000_000 },
    { provider: 'openai', model: 'cheap', effectiveFrom: new Date('2026-01-01T00:00:00Z'), inputPerMtokMicros: 1_000_000, outputPerMtokMicros: 1_000_000 },
  ])
}, 60_000)

afterAll(async () => {
  await db?.$client.end()
  await temp?.drop()
})

describe('AC-T18-01 costOf', () => {
  const tokens = { provider: 'anthropic', model: 'm1', inputTokens: 1_000_000, outputTokens: 1_000_000 }

  it('usa o preço vigente antes e depois de effective_from', async () => {
    const before = await pricing.costOf(tokens, new Date('2026-11-30T23:59:59Z'))
    const after = await pricing.costOf(tokens, new Date('2026-12-01T00:00:00Z'))
    expect(before.costMicros).toBe(18_000_000)
    expect(after.costMicros).toBe(36_000_000)
    expect(after.priceId).not.toBe(before.priceId)
  })

  it('cache read/write e reasoning têm preço próprio', async () => {
    const c = await pricing.costOf(
      { provider: 'anthropic', model: 'm1', inputTokens: 1_000_000, cacheReadTokens: 400_000, cacheWriteTokens: 100_000, outputTokens: 1_000_000, reasoningTokens: 250_000 },
      new Date('2026-06-01T00:00:00Z'),
    )
    // 500k input × 3 + 400k × 0,3 + 100k × 3,75 + 750k output × 15 + 250k × 20 (US$/1M)
    expect(c.costMicros).toBe(1_500_000 + 120_000 + 375_000 + 11_250_000 + 5_000_000)
  })

  it('aplica markup e arredondamento: padrão, global e por empresa', async () => {
    const at = new Date('2026-06-01T00:00:00Z')
    const small = { provider: 'openai', model: 'cheap', inputTokens: 1, outputTokens: 0 } // 1 micro-USD
    const def = await pricing.costOf(small, at)
    expect(def).toMatchObject({ ...DEFAULT_PRICING_SETTINGS, costMicros: 1, billedMicros: 3, credits: 1 }) // 3 µUSD × 5400/1e6 = 0,0162 → ceil 1

    await db.insert(aiPricingSettings).values({ markupBps: 20_000, creditsPerUsd: 1000, roundingMode: 'floor' })
    const glob = await pricing.costOf({ ...small, inputTokens: 1_000_000 }, at) // US$ 1
    expect(glob).toMatchObject({ costMicros: 1_000_000, billedMicros: 2_000_000, credits: 2000, roundingMode: 'floor' })
    expect((await pricing.costOf(small, at)).credits).toBe(0) // floor de 0,002

    const co = await company()
    await db.insert(aiPricingSettings).values({ companyId: co, markupBps: 10_000, creditsPerUsd: 1000, roundingMode: 'round' })
    expect((await pricing.costOf({ ...small, inputTokens: 1_500 }, at, { companyId: co })).credits).toBe(2) // 1,5 → round 2
    expect((await pricing.costOf({ ...small, inputTokens: 1_400 }, at, { companyId: co })).credits).toBe(1)
    await db.delete(aiPricingSettings)
  })

  it('modelo sem preço (ou antes do primeiro preço) → PriceNotFoundError', async () => {
    await expect(pricing.costOf({ provider: 'anthropic', model: 'nada', inputTokens: 1, outputTokens: 1 }, new Date())).rejects.toBeInstanceOf(PriceNotFoundError)
    await expect(pricing.costOf(tokens, new Date('2025-12-31T00:00:00Z'))).rejects.toBeInstanceOf(PriceNotFoundError)
  })
})

describe('AC-T18-02 débitos concorrentes', () => {
  it('após 100 débitos concorrentes o saldo = soma do ledger', async () => {
    const co = await company()
    await wallet.credit(co, 10_000)
    await Promise.all(Array.from({ length: 100 }, (_, i) => wallet.debit(co, (i % 7) + 1, { requestId: `r-${i}` })))
    const w = await wallet.getWallet(co)
    const expectedSpent = Array.from({ length: 100 }, (_, i) => (i % 7) + 1).reduce((a, b) => a + b, 0)
    expect(w.balanceCredits).toBe(10_000 - expectedSpent)
    expect(w.balanceCredits).toBe(await ledgerSum(co))
    expect(w.lifetimeSpentCredits).toBe(expectedSpent)
  })
})

describe('AC-T18-03 status', () => {
  it('cruzar o limiar → low; saldo <= -max_overrun → exhausted; recarga → ok', async () => {
    const co = await company()
    await wallet.configure(co, { lowThresholdCredits: 100, maxOverrunCredits: 50 })
    expect((await wallet.credit(co, 150)).wallet.status).toBe('ok')
    expect((await wallet.debit(co, 49)).wallet.status).toBe('ok') // 101
    expect((await wallet.debit(co, 1)).wallet.status).toBe('low') // 100
    expect((await wallet.debit(co, 149)).wallet.status).toBe('low') // -49
    expect((await wallet.debit(co, 1)).wallet).toMatchObject({ status: 'exhausted', balanceCredits: -50 })
    expect((await wallet.credit(co, 1000)).wallet.status).toBe('ok')
    expect((await wallet.configure(co, { lowThresholdCredits: 5000 })).status).toBe('low')
  })
})

describe('AC-T18-04 refund', () => {
  it('idempotente e marca ai_usage.status = refunded', async () => {
    const co = await company()
    await wallet.credit(co, 1_000_000)
    const rec = await usage.record({ companyId: co, requestId: `req-${rnd()}`, provider: 'anthropic', model: 'm1', usage: { inputTokens: 10_000, outputTokens: 5_000 }, at: new Date('2026-06-01T00:00:00Z') })
    expect(rec.created).toBe(true)
    expect(rec.usage.credits).toBeGreaterThan(0)
    const afterDebit = (await wallet.getWallet(co)).balanceCredits
    expect(afterDebit).toBe(1_000_000 - rec.usage.credits)

    const first = await wallet.refund(rec.usage.id)
    expect(first.refunded).toBe(true)
    expect(first.wallet.balanceCredits).toBe(1_000_000)
    const second = await wallet.refund(rec.usage.id)
    expect(second).toMatchObject({ refunded: false, entryId: null })
    expect(second.wallet.balanceCredits).toBe(1_000_000)
    const [u] = await db.select({ status: aiUsage.status }).from(aiUsage).where(eq(aiUsage.id, rec.usage.id))
    expect(u!.status).toBe('refunded')
    expect(await ledgerSum(co)).toBe(1_000_000)
  })

  it('refunds concorrentes creditam uma vez; uso inexistente → UsageNotFoundError', async () => {
    const co = await company()
    const rec = await usage.record({ companyId: co, requestId: `req-${rnd()}`, provider: 'openai', model: 'cheap', usage: { inputTokens: 5_000_000, outputTokens: 0 } })
    const results = await Promise.all(Array.from({ length: 5 }, () => wallet.refund(rec.usage.id)))
    expect(results.filter((r) => r.refunded)).toHaveLength(1)
    expect((await wallet.getWallet(co)).balanceCredits).toBe(0)
    await expect(wallet.refund('00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(UsageNotFoundError)
  })

  it('record é idempotente por request_id', async () => {
    const co = await company()
    const requestId = `req-${rnd()}`
    const input = { companyId: co, requestId, provider: 'openai', model: 'cheap', usage: { inputTokens: 1_000_000, outputTokens: 0 } }
    const [a, b] = await Promise.all([usage.record(input), usage.record(input)])
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1)
    expect(a.usage.id).toBe(b.usage.id)
    expect((await wallet.getWallet(co)).balanceCredits).toBe(-a.usage.credits)
  })
})
