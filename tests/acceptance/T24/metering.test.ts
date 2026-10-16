// AC-T24-01..05 — UsageGuard (cota hard/soft, commit idempotente, erro sem débito, reconciliação Redis×Postgres) e meter(FakeLlm).
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  balanceOf,
  consume,
  debitEntries,
  type Env,
  hotKey,
  llmRequest,
  PROVIDER,
  rejection,
  seedCompany,
  setQuota,
  startEnv,
  USAGE,
  USAGE_COST_MICROS,
  USAGE_CREDITS,
  usageRows,
} from './setup'

let env: Env

beforeAll(async () => {
  env = await startEnv()
})
afterAll(async () => {
  await env?.close()
})

const fakeWith = (...steps: unknown[]) => new env.ai.FakeLlm({ script: steps })
const okStep = () => env.ai.text('resposta', { usage: { ...USAGE } })
const metered = (fake: unknown, feature: string, extra: Record<string, unknown> = {}) => env.core.meter(fake, { guard: env.guard, feature, ...extra })
const eventsOf = (companyId: string, type: string) => env.published.filter((p) => p.companyId === companyId && p.type === type)

describe('T24 — cota hard', () => {
  it('AC-T24-01 cota hard mensal estourada: reserve lança LlmQuotaExceededError e o FakeLlm não é chamado', async () => {
    const c = await seedCompany(env)
    await setQuota(env, c.companyId, 'month', 150, true)
    await consume(env, c) // 200 créditos ≥ 150
    const fake = fakeWith(okStep())
    const rowsBefore = (await usageRows(env, c.companyId)).length
    const balanceBefore = await balanceOf(env, c.companyId)

    const err = await rejection(metered(fake, 'agente').generate(llmRequest(c, randomUUID())))
    expect(err, 'chamada deveria ser barrada').toBeInstanceOf(env.core.LlmQuotaExceededError)
    expect(fake.calls).toHaveLength(0)
    expect((await usageRows(env, c.companyId)).length).toBe(rowsBefore)
    expect(await balanceOf(env, c.companyId)).toBe(balanceBefore)
  })

  it('AC-T24-01 reserve direto também lança antes de qualquer provedor (estimativa que passa do limite)', async () => {
    const c = await seedCompany(env)
    await setQuota(env, c.companyId, 'month', 300, true)
    await consume(env, c) // usado 200; 200 + 150 > 300
    const err = await rejection(env.guard.reserve(c.companyId, { credits: 150 }, 'agente'))
    expect(err).toBeInstanceOf(env.core.LlmQuotaExceededError)
    // dentro do limite passa
    const ok = await env.guard.reserve(c.companyId, { credits: 50 }, 'agente')
    expect(ok.companyId).toBe(c.companyId)
  })

  it('AC-T24-01 sem cota estourada a mesma chamada acontece (sanidade)', async () => {
    const c = await seedCompany(env)
    await setQuota(env, c.companyId, 'month', 10_000, true)
    const fake = fakeWith(okStep())
    const res = await metered(fake, 'agente').generate(llmRequest(c, randomUUID()))
    expect(res.text).toBe('resposta')
    expect(fake.calls).toHaveLength(1)
  })
})

describe('T24 — cota soft', () => {
  it('AC-T24-02 cota soft estourada permite a chamada e emite ai_wallet.low', async () => {
    const c = await seedCompany(env)
    await setQuota(env, c.companyId, 'month', 150, false)
    await consume(env, c)
    const fake = fakeWith(okStep())
    const res = await metered(fake, 'agente').generate(llmRequest(c, randomUUID()))
    expect(res.text).toBe('resposta')
    expect(fake.calls).toHaveLength(1)
    const low = eventsOf(c.companyId, 'ai_wallet.low')
    expect(low.length, JSON.stringify(env.published.filter((p) => p.companyId === c.companyId))).toBeGreaterThanOrEqual(1)
    expect(low.some((e) => e.data?.reason === 'quota')).toBe(true)
    // a chamada foi contabilizada normalmente
    expect((await usageRows(env, c.companyId)).filter((r: any) => r.status === 'charged')).toHaveLength(2)
  })

  it('AC-T24-02 cota soft não estourada não emite ai_wallet.low', async () => {
    const c = await seedCompany(env)
    await setQuota(env, c.companyId, 'month', 100_000, false)
    await metered(fakeWith(okStep()), 'agente').generate(llmRequest(c, randomUUID()))
    expect(eventsOf(c.companyId, 'ai_wallet.low').filter((e) => e.data?.reason === 'quota')).toHaveLength(0)
  })
})

describe('T24 — registro de uso', () => {
  it('AC-T24-03 cada chamada medida grava exatamente uma linha em ai_usage com tokens, cost_micros, credits e feature', async () => {
    const c = await seedCompany(env, 10_000)
    const agentId = randomUUID()
    const fake = fakeWith(okStep())
    await metered(fake, 'agente-atendimento').generate(llmRequest(c, agentId))
    const rows = await usageRows(env, c.companyId)
    expect(rows).toHaveLength(1)
    const r = rows[0]
    expect(r.feature).toBe('agente-atendimento')
    expect(r.agent_id).toBe(agentId)
    expect(r.provider).toBe(PROVIDER)
    expect(r.model).toBe(c.model)
    expect(Number(r.input_tokens)).toBe(USAGE.inputTokens)
    expect(Number(r.output_tokens)).toBe(USAGE.outputTokens)
    expect(Number(r.cost_micros)).toBe(USAGE_COST_MICROS)
    expect(Number(r.credits)).toBe(USAGE_CREDITS)
    expect(r.status).toBe('charged')
    expect(await balanceOf(env, c.companyId)).toBe(10_000 - USAGE_CREDITS)
  })

  it('AC-T24-03 duas chamadas medidas → duas linhas e dois débitos', async () => {
    const c = await seedCompany(env, 10_000)
    const m = metered(fakeWith(okStep(), okStep()), 'agente')
    await m.generate(llmRequest(c, randomUUID()))
    await m.generate(llmRequest(c, randomUUID()))
    expect(await usageRows(env, c.companyId)).toHaveLength(2)
    expect(await debitEntries(env, c.companyId)).toBe(2)
    expect(await balanceOf(env, c.companyId)).toBe(10_000 - 2 * USAGE_CREDITS)
  })

  it('AC-T24-03 commit repetido com o mesmo request_id debita uma vez', async () => {
    const c = await seedCompany(env, 10_000)
    const input = { requestId: randomUUID(), companyId: c.companyId, provider: PROVIDER, model: c.model, feature: 'resumo', usage: USAGE }
    const first = await env.guard.commit(input)
    const second = await env.guard.commit(input)
    const concurrent = await Promise.all([env.guard.commit(input), env.guard.commit(input)])
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(concurrent.every((r: any) => r.created === false)).toBe(true)
    expect(await usageRows(env, c.companyId)).toHaveLength(1)
    expect(await debitEntries(env, c.companyId)).toBe(1)
    expect(await balanceOf(env, c.companyId)).toBe(10_000 - USAGE_CREDITS)
  })
})

describe('T24 — erro do provedor', () => {
  it("AC-T24-04 erro do provedor grava ai_usage.status = 'error' sem débito", async () => {
    const c = await seedCompany(env, 10_000)
    const boom = new Error('provedor fora do ar')
    const fake = fakeWith(env.ai.fail(boom))
    const err = await rejection(metered(fake, 'agente').generate(llmRequest(c, randomUUID())))
    expect(err, 'o erro do provedor deve seguir para quem chamou').toBeTruthy()
    expect(fake.calls).toHaveLength(1)
    const rows = await usageRows(env, c.companyId)
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('error')
    expect(rows[0].feature).toBe('agente')
    expect(Number(rows[0].credits)).toBe(0)
    expect(await debitEntries(env, c.companyId)).toBe(0)
    expect(await balanceOf(env, c.companyId)).toBe(10_000)
  })

  it('AC-T24-04 erro não conta no consumo da cota (chamada seguinte não é barrada por ele)', async () => {
    const c = await seedCompany(env, 10_000)
    await setQuota(env, c.companyId, 'month', 250, true)
    await rejection(metered(fakeWith(env.ai.fail(new Error('x'))), 'agente').generate(llmRequest(c, randomUUID())))
    const fake = fakeWith(okStep())
    const res = await metered(fake, 'agente').generate(llmRequest(c, randomUUID()))
    expect(res.text).toBe('resposta')
    expect(fake.calls).toHaveLength(1)
  })
})

describe('T24 — reconciliação Redis × Postgres', () => {
  it('AC-T24-05 contador adulterado no Redis é corrigido pela reconciliação a partir do Postgres', async () => {
    const c = await seedCompany(env, 10_000)
    await consume(env, c)
    const key = hotKey(c.companyId, 'month')
    expect(Number(await env.redis.hget(key, 'credits')), `contador quente ${key}`).toBe(USAGE_CREDITS)

    await env.redis.hset(key, 'credits', '999999')
    const r = await env.guard.reconcile(c.companyId)
    expect(Number(r.month.before.credits)).toBe(999_999)
    expect(Number(r.month.after.credits)).toBe(USAGE_CREDITS)
    expect(Number(await env.redis.hget(key, 'credits'))).toBe(USAGE_CREDITS)
  })

  it('AC-T24-05 contador adulterado para cima barra a cota; após reconciliar a chamada volta a passar', async () => {
    const c = await seedCompany(env, 10_000)
    await setQuota(env, c.companyId, 'month', 1_000, true)
    await consume(env, c)
    const key = hotKey(c.companyId, 'month')
    await env.redis.hset(key, 'credits', '5000')
    expect(await rejection(env.guard.reserve(c.companyId, { credits: 10 }, 'agente'))).toBeInstanceOf(env.core.LlmQuotaExceededError)

    await env.guard.reconcile(c.companyId)
    const ok = await env.guard.reserve(c.companyId, { credits: 10 }, 'agente')
    expect(ok.companyId).toBe(c.companyId)
  })

  it('AC-T24-05 contador adulterado para baixo é corrigido e a cota volta a barrar', async () => {
    const c = await seedCompany(env, 10_000)
    await setQuota(env, c.companyId, 'month', 300, true)
    await consume(env, c)
    await consume(env, c) // 400 ≥ 300
    const key = hotKey(c.companyId, 'month')
    await env.redis.hset(key, 'credits', '0')
    const r = await env.guard.reconcile(c.companyId)
    expect(Number(r.month.after.credits)).toBe(2 * USAGE_CREDITS)
    expect(await rejection(env.guard.reserve(c.companyId, { credits: 1 }, 'agente'))).toBeInstanceOf(env.core.LlmQuotaExceededError)
  })
})
