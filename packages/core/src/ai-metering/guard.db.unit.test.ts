import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LlmQuotaExceededError, type LlmRequest } from '@crm/ai'
import { FakeLlm, fail, text } from '@crm/ai/testing'
import { aiQuotas, aiUsage, aiWalletEntries, companies, createDb, llmPrices, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { WalletService } from '../ai-usage/wallet'
import { UsageGuard, type WalletEventPublisher } from './guard'
import { meter } from './meter'
import { periodBucket } from './period'

let temp: TempDatabase
let db: Database
let redis: Redis
let wallet: WalletService
const prefix = `crm:ai:used:t24-${randomBytes(4).toString('hex')}`
const rnd = () => randomBytes(4).toString('hex')

type Published = { companyId: string; type: string; data: Record<string, unknown> }
function spy(): WalletEventPublisher & { events: Published[] } {
  const events: Published[] = []
  return { events, publish: async (companyId, type, data) => void events.push({ companyId, type, data }) }
}

async function company(credits = 1_000_000): Promise<string> {
  const [c] = await db.insert(companies).values({ name: 'C', slug: `c-${rnd()}` }).returning({ id: companies.id })
  if (credits) await wallet.credit(c!.id, credits)
  return c!.id
}

const req = (companyId: string): LlmRequest => ({
  model: { provider: 'anthropic', model: 'm' },
  instructions: 'Você é um assistente.',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'oi' }] }],
  maxOutputTokens: 100,
  tenantId: companyId,
  agentId: '00000000-0000-4000-8000-0000000000aa',
})

const usageRows = (companyId: string) => db.select().from(aiUsage).where(eq(aiUsage.companyId, companyId))

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
  redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1')
  wallet = new WalletService({ db })
  // US$ 1 por 1M tokens de entrada e de saída; com os padrões (3×, 5400/USD): 1000 tokens = 17 créditos (ceil de 16,2)
  await db.insert(llmPrices).values({ provider: 'anthropic', model: 'm', effectiveFrom: new Date('2020-01-01'), inputPerMtokMicros: 1_000_000, outputPerMtokMicros: 1_000_000 })
}, 60_000)

afterAll(async () => {
  const keys = await redis.keys(`${prefix}:*`)
  if (keys.length) await redis.del(...keys)
  redis.disconnect()
  await db?.$client.end()
  await temp?.drop()
})

describe('AC-T24-01 cota hard', () => {
  it('cota mensal hard estourada → LlmQuotaExceededError antes do provedor', async () => {
    const co = await company()
    const guard = new UsageGuard({ db, redis, prefix })
    await db.insert(aiQuotas).values({ companyId: co, period: 'month', maxCredits: 10, hard: true })
    await guard.commit({ requestId: `r-${rnd()}`, companyId: co, provider: 'anthropic', model: 'm', feature: 'test', usage: { inputTokens: 1000, outputTokens: 0 } })
    const llm = new FakeLlm([text('não deveria')])
    const metered = meter(llm, { guard, feature: 'ai_agent' })
    await expect(metered.generate(req(co))).rejects.toBeInstanceOf(LlmQuotaExceededError)
    expect(llm.callCount).toBe(0)
  })

  it('saldo − estimativa < −overrun também bloqueia; carteira sem crédito bloqueia', async () => {
    const guard = new UsageGuard({ db, redis, prefix })
    const empty = await company(0)
    await expect(guard.reserve(empty, { credits: 1 }, 'x')).rejects.toBeInstanceOf(LlmQuotaExceededError)
    const co = await company(100)
    await wallet.configure(co, { maxOverrunCredits: 50 })
    await expect(guard.reserve(co, { credits: 150 }, 'x')).resolves.toMatchObject({ estimatedCredits: 150 })
    await expect(guard.reserve(co, { credits: 151 }, 'x')).rejects.toBeInstanceOf(LlmQuotaExceededError)
  })
})

describe('AC-T24-02 cota soft', () => {
  it('estourada permite a chamada e emite ai_wallet.low', async () => {
    const co = await company()
    const realtime = spy()
    const guard = new UsageGuard({ db, redis, prefix, realtime })
    await db.insert(aiQuotas).values({ companyId: co, period: 'day', maxCredits: 5, hard: false })
    await guard.commit({ requestId: `r-${rnd()}`, companyId: co, provider: 'anthropic', model: 'm', feature: 'test', usage: { inputTokens: 1000, outputTokens: 0 } })
    realtime.events.length = 0
    const llm = new FakeLlm([text('ok', { usage: { inputTokens: 100, outputTokens: 20 } })])
    const res = await meter(llm, { guard, feature: 'ai_agent' }).generate(req(co))
    expect(res.text).toBe('ok')
    expect(llm.callCount).toBe(1)
    expect(realtime.events).toContainEqual({ companyId: co, type: 'ai_wallet.low', data: expect.objectContaining({ reason: 'quota', period: 'day', metric: 'credits', limit: 5 }) })
    expect(realtime.events.some((e) => e.type === 'ai_wallet.updated')).toBe(true)
  })

  it('saldo que cruza o limiar emite ai_wallet.low com reason balance', async () => {
    const co = await company(20)
    await wallet.configure(co, { lowThresholdCredits: 10, maxOverrunCredits: 100 })
    const realtime = spy()
    const guard = new UsageGuard({ db, redis, prefix, realtime })
    await guard.commit({ requestId: `r-${rnd()}`, companyId: co, provider: 'anthropic', model: 'm', feature: 'x', usage: { inputTokens: 1000, outputTokens: 0 } })
    expect(realtime.events).toContainEqual(expect.objectContaining({ type: 'ai_wallet.low', data: expect.objectContaining({ reason: 'balance', status: 'low', balance_credits: 3 }) }))
  })
})

describe('AC-T24-03 uma linha por chamada', () => {
  it('grava tokens, cost_micros, credits, feature e agent_id; commit repetido debita uma vez', async () => {
    const co = await company()
    const guard = new UsageGuard({ db, redis, prefix })
    const llm = new FakeLlm([text('a', { usage: { inputTokens: 600, outputTokens: 400 } })])
    await meter(llm, { guard, feature: 'ai_agent' }).generate(req(co))
    const rows = await usageRows(co)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ inputTokens: 600, outputTokens: 400, costMicros: 1000, credits: 17, feature: 'ai_agent', agentId: '00000000-0000-4000-8000-0000000000aa', status: 'charged' })

    const input = { requestId: `r-${rnd()}`, companyId: co, provider: 'anthropic', model: 'm', feature: 'x', usage: { inputTokens: 1000, outputTokens: 0 } }
    const [a, b] = await Promise.all([guard.commit(input), guard.commit(input)])
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1)
    expect(await guard.commit(input)).toMatchObject({ created: false, usageId: a.usageId })
    const debits = await db.select().from(aiWalletEntries).where(eq(aiWalletEntries.companyId, co))
    expect(debits.filter((d) => d.kind === 'debit')).toHaveLength(2)
    expect((await wallet.getWallet(co)).balanceCredits).toBe(1_000_000 - 34)
  })
})

describe('AC-T24-04 erro do provedor', () => {
  it('grava status error sem débito e repropaga o erro', async () => {
    const co = await company()
    const guard = new UsageGuard({ db, redis, prefix })
    const boom = Object.assign(new Error('caiu'), { code: 'UPSTREAM_ERROR' })
    const metered = meter(new FakeLlm([fail(boom)]), { guard, feature: 'ai_agent' })
    await expect(metered.generate(req(co))).rejects.toBe(boom)
    const rows = await usageRows(co)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'error', credits: 0, costMicros: 0, errorCode: 'UPSTREAM_ERROR', feature: 'ai_agent' })
    expect((await wallet.getWallet(co)).balanceCredits).toBe(1_000_000)
  })
})

describe('AC-T24-05 reconciliação', () => {
  it('corrige o contador Redis adulterado com o valor do Postgres', async () => {
    const co = await company()
    const guard = new UsageGuard({ db, redis, prefix })
    for (let i = 0; i < 3; i++)
      await guard.commit({ requestId: `r-${rnd()}`, companyId: co, provider: 'anthropic', model: 'm', feature: 'x', usage: { inputTokens: 1000, outputTokens: 0 } })
    const key = guard.counterKey(co, 'month', periodBucket('month', new Date(), 'America/Sao_Paulo'))
    expect(await redis.hget(key, 'credits')).toBe('51')
    await redis.hset(key, 'credits', '999999')
    const r = await guard.reconcile(co)
    expect(r.month.before.credits).toBe(999_999)
    expect(r.month.after).toEqual({ credits: 51, cost_micros: 3000, tokens: 3000 })
    expect(await redis.hget(key, 'credits')).toBe('51')
  })

  it('contador ausente é recarregado do Postgres no reserve', async () => {
    const co = await company()
    const guard = new UsageGuard({ db, redis, prefix })
    await db.insert(aiQuotas).values({ companyId: co, period: 'month', maxCredits: 20, hard: true })
    await guard.commit({ requestId: `r-${rnd()}`, companyId: co, provider: 'anthropic', model: 'm', feature: 'x', usage: { inputTokens: 1000, outputTokens: 0 } })
    await redis.del(guard.counterKey(co, 'month', periodBucket('month', new Date(), 'America/Sao_Paulo')))
    await expect(guard.reserve(co, { credits: 5 }, 'x')).rejects.toBeInstanceOf(LlmQuotaExceededError) // 17 + 5 > 20
    await expect(guard.reserve(co, { credits: 3 }, 'x')).resolves.toBeTruthy()
  })
})
