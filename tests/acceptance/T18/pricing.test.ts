// AC-T18-01 — PricingService.costOf: preço vigente por data, cache/reasoning à parte, markup e arredondamento.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { uniqueId } from '../helpers/factories'
import { type Env, insertPrice, num, seedCompany, setPricing, startEnv } from './setup'

let env: Env
let pricing: any
const PROVIDER = 'openai'
let MODEL: string

// Preços (micro-USD por 1M tokens).
const OLD = { input: 1_000_000, output: 2_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, reasoning: 2_000_000 }
const NEW = { input: 3_000_000, output: 6_000_000, cacheRead: 300_000, cacheWrite: 3_750_000, reasoning: 10_000_000 }
const OLD_FROM = '2026-01-01T00:00:00Z'
const NEW_FROM = '2026-06-01T00:00:00Z'

// inputTokens inclui cache read/write; outputTokens inclui reasoning (semântica do LlmUsage).
const USAGE = { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 200_000, cacheWriteTokens: 100_000, reasoningTokens: 100_000 }
// novo: 700k×3 + 200k×0,3 + 100k×3,75 + 400k×6 + 100k×10 = 2.100.000 + 60.000 + 375.000 + 2.400.000 + 1.000.000
const NEW_COST = 5_935_000
// antigo: 700k×1 + 200k×1 + 100k×1 + 400k×2 + 100k×2
const OLD_COST = 2_000_000

beforeAll(async () => {
  env = await startEnv()
  pricing = new env.core.PricingService({ db: env.db })
  MODEL = uniqueId('modelo-t18')
  await insertPrice(env, { provider: PROVIDER, model: MODEL, effectiveFrom: OLD_FROM, ...OLD })
  await insertPrice(env, { provider: PROVIDER, model: MODEL, effectiveFrom: NEW_FROM, ...NEW })
})
afterAll(async () => {
  await env?.close()
})

const usage = (over: Record<string, unknown> = {}) => ({ provider: PROVIDER, model: MODEL, ...USAGE, ...over })

describe('T18 — PricingService.costOf', () => {
  it('AC-T18-01 usa o preço vigente antes e depois de effective_from', async () => {
    const company = await seedCompany(env)
    await setPricing(env, company, 10_000, 1_000_000, 'ceil')
    const before = await pricing.costOf(usage(), new Date('2026-05-31T23:59:59Z'), { companyId: company })
    const atSwitch = await pricing.costOf(usage(), new Date(NEW_FROM), { companyId: company })
    const after = await pricing.costOf(usage(), new Date('2026-09-01T00:00:00Z'), { companyId: company })
    expect(num(before.costMicros)).toBe(OLD_COST)
    expect(num(atSwitch.costMicros)).toBe(NEW_COST)
    expect(num(after.costMicros)).toBe(NEW_COST)
  })

  it('AC-T18-01 cache read, cache write e reasoning são cobrados à parte, cada um pelo seu preço', async () => {
    const company = await seedCompany(env)
    await setPricing(env, company, 10_000, 1_000_000, 'ceil')
    const at = new Date('2026-09-01T00:00:00Z')
    const plain = await pricing.costOf(usage({ cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }), at, { companyId: company })
    // sem cache/reasoning: 1M×3 + 500k×6 = 6.000.000
    expect(num(plain.costMicros)).toBe(6_000_000)
    const onlyCacheRead = await pricing.costOf(usage({ cacheReadTokens: 1_000_000, cacheWriteTokens: 0, reasoningTokens: 0, outputTokens: 0 }), at, { companyId: company })
    expect(num(onlyCacheRead.costMicros)).toBe(300_000)
    const onlyCacheWrite = await pricing.costOf(usage({ cacheReadTokens: 0, cacheWriteTokens: 1_000_000, reasoningTokens: 0, outputTokens: 0 }), at, { companyId: company })
    expect(num(onlyCacheWrite.costMicros)).toBe(3_750_000)
    const onlyReasoning = await pricing.costOf(usage({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1_000_000, reasoningTokens: 1_000_000 }), at, { companyId: company })
    expect(num(onlyReasoning.costMicros)).toBe(10_000_000)
    const mixed = await pricing.costOf(usage(), at, { companyId: company })
    expect(num(mixed.costMicros)).toBe(NEW_COST)
  })

  it('AC-T18-01 aplica o markup configurado (billedMicros = custo × markup)', async () => {
    const company = await seedCompany(env)
    await setPricing(env, company, 20_000, 1_000, 'ceil') // 2x; 1000 créditos por USD
    const r = await pricing.costOf(usage(), new Date('2026-09-01T00:00:00Z'), { companyId: company })
    expect(num(r.costMicros)).toBe(NEW_COST)
    expect(num(r.billedMicros)).toBe(NEW_COST * 2)
    // 11,87 USD × 1000 créditos/USD
    expect(num(r.credits)).toBe(11_870)
  })

  it.each([
    ['ceil', 84],
    ['floor', 83],
    ['round', 83],
  ] as const)('AC-T18-01 arredondamento %s dos créditos', async (mode, expected) => {
    const company = await seedCompany(env)
    // 11,87 USD × 7 créditos/USD = 83,09 créditos
    await setPricing(env, company, 20_000, 7, mode)
    const r = await pricing.costOf(usage(), new Date('2026-09-01T00:00:00Z'), { companyId: company })
    expect(num(r.billedMicros)).toBe(11_870_000)
    expect(num(r.credits)).toBe(expected)
  })

  it('AC-T18-01 round arredonda para cima quando a fração é ≥ 0,5', async () => {
    const company = await seedCompany(env)
    // 11,87 USD × 333 = 3952,71
    await setPricing(env, company, 20_000, 333, 'round')
    const r = await pricing.costOf(usage(), new Date('2026-09-01T00:00:00Z'), { companyId: company })
    expect(num(r.credits)).toBe(3_953)
  })

  it('AC-T18-01 modelo sem preço → PriceNotFoundError', async () => {
    const err = await pricing.costOf({ ...usage(), model: uniqueId('sem-preco') }, new Date()).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err, 'costOf deveria rejeitar').toBeInstanceOf(env.core.PriceNotFoundError)
  })

  it('AC-T18-01 data anterior a qualquer vigência → PriceNotFoundError', async () => {
    const err = await pricing.costOf(usage(), new Date('2025-12-31T23:59:59Z')).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err, 'costOf deveria rejeitar').toBeInstanceOf(env.core.PriceNotFoundError)
  })
})
