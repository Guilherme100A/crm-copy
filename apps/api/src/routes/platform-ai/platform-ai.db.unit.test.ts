/* eslint-disable @typescript-eslint/no-explicit-any -- respostas JSON lidas como dados soltos */
// Consumo de IA pela API (T37): permissões, recarga/ajuste/reembolso, cotas e limites, preços com vigência e o
// extrato/resumo da empresa (AC-T37-01..04).
import { randomBytes } from 'node:crypto'
import { AiUsageService } from '@crm/core'
import { aiUsage, aiWalletEntries, companies, companyMembers, createDb, llmPrices, users, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createLogger, MemoryMailer, redisConnection } from '@crm/node-kit'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type RedisClient } from '../../app'

let temp: TempDatabase
let db: Database
let redis: RedisClient
let app: ReturnType<typeof createApp>
const published: { companyId: string; type: string; data: any }[] = []
const H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }
const rnd = () => randomBytes(4).toString('hex')

interface Session {
  cookie: string
  companyId: string
  userId: string
}

async function signUp(): Promise<Session> {
  const email = `t37-${rnd()}@x.com`
  const ip = { 'x-forwarded-for': `10.37.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }
  const reg = await app.request('/api/auth/register', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ name: 'T', email, password: '12345678', password_confirmation: '12345678' }) })
  const { user } = (await reg.json()) as any
  const login = await app.request('/api/auth/login', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ email, password: '12345678' }) })
  return { cookie: /crm_session=[^;]+/.exec(login.headers.get('set-cookie') ?? '')![0], companyId: user.last_company_id, userId: user.id }
}
async function platformAdmin(): Promise<Session> {
  const s = await signUp()
  await db.update(users).set({ systemRole: 'platform_admin' }).where(eq(users.id, s.userId))
  return s
}
const call = async (s: Session | null, method: string, path: string, body?: unknown) => {
  const res = await app.request(path, { method, headers: { ...H, ...(s ? { cookie: s.cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  return { status: res.status, body: (await res.json()) as any }
}

async function record(companyId: string, opts: { model?: string; at: Date; input?: number; output?: number; feature?: string; agentId?: string }) {
  const svc = new AiUsageService({ db })
  const r = await svc.record({
    companyId,
    requestId: `req-${rnd()}`,
    provider: 'testprov',
    model: opts.model ?? 'm1',
    usage: { inputTokens: opts.input ?? 1_000_000, outputTokens: opts.output ?? 0 },
    at: opts.at,
  })
  if (opts.feature || opts.agentId)
    await db.update(aiUsage).set({ feature: opts.feature ?? null, agentId: opts.agentId ?? null }).where(eq(aiUsage.id, r.usage.id))
  return r.usage
}

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
  redis = redisConnection({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1' })
  app = createApp({
    db,
    redis,
    mailer: new MemoryMailer(),
    trustProxy: true,
    logger: createLogger({ level: 'silent' }),
    realtimePublisher: { publish: async (companyId: string, type: string, data: unknown) => void published.push({ companyId, type, data }) } as never,
  })
  // Preços de teste com vigência no passado (US$ 1 / MTok de entrada; m2: US$ 2).
  await db.insert(llmPrices).values([
    { provider: 'testprov', model: 'm1', kind: 'llm', effectiveFrom: new Date('2020-01-01T00:00:00Z'), inputPerMtokMicros: 1_000_000, outputPerMtokMicros: 0 },
    { provider: 'testprov', model: 'm2', kind: 'llm', effectiveFrom: new Date('2020-01-01T00:00:00Z'), inputPerMtokMicros: 2_000_000, outputPerMtokMicros: 0 },
  ])
}, 120_000)

afterAll(async () => {
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
})

describe('AC-T37-02 permissões', () => {
  it('sem platform_admin → 403 em /api/platform/*; sem sessão → 401; sem ai_usage.view → 403 em /api/ai/*', async () => {
    const owner = await signUp()
    for (const [method, path] of [
      ['GET', '/api/platform/ai/prices'],
      ['GET', '/api/platform/ai/wallets'],
      ['POST', `/api/platform/companies/${owner.companyId}/ai/topups`],
      ['GET', '/api/platform/ai/pricing-settings'],
    ] as const)
      expect((await call(owner, method, path, method === 'POST' ? { credits: 1, note: 'x' } : undefined)).status).toBe(403)
    expect((await call(null, 'GET', '/api/platform/ai/prices')).status).toBe(401)
    expect((await call(owner, 'GET', '/api/ai/wallet')).status).toBe(200)

    const m = await signUp()
    await db.insert(companyMembers).values({ companyId: owner.companyId, userId: m.userId, role: 'member' })
    await db.update(users).set({ lastCompanyId: owner.companyId }).where(eq(users.id, m.userId))
    const member = { ...m, companyId: owner.companyId }
    for (const path of ['/api/ai/wallet', '/api/ai/usage', '/api/ai/usage/summary', '/api/ai/quotas']) expect((await call(member, 'GET', path)).status).toBe(403)
  })
})

describe('AC-T37-01 recarga e carteira', () => {
  it('recarga exige nota, gera entrada topup com actor_user_id e publica ai_wallet.updated na empresa', async () => {
    const admin = await platformAdmin()
    const owner = await signUp()
    const path = `/api/platform/companies/${owner.companyId}/ai/topups`
    for (const body of [{ credits: 100 }, { credits: 100, note: '   ' }]) {
      const r = await call(admin, 'POST', path, body)
      expect(r.status).toBe(422)
      expect(r.body.error.details.fields.map((f: any) => f.path)).toContain('note')
    }
    expect((await call(admin, 'POST', path, { credits: 0, note: 'x' })).status).toBe(422)
    published.length = 0
    const r = await call(admin, 'POST', path, { credits: 5000, note: 'Recarga PIX #1' })
    expect(r.status).toBe(201)
    expect(r.body.entry).toMatchObject({ kind: 'topup', amount_credits: 5000, balance_after_credits: 5000, note: 'Recarga PIX #1', actor_user_id: admin.userId })
    expect(r.body.wallet).toMatchObject({ balance_credits: 5000, status: 'ok' })
    const [row] = await db.select().from(aiWalletEntries).where(eq(aiWalletEntries.id, r.body.entry.id))
    expect(row).toMatchObject({ kind: 'credit', companyId: owner.companyId, actorUserId: admin.userId, note: 'Recarga PIX #1' })
    expect(published).toEqual([{ companyId: owner.companyId, type: 'ai_wallet.updated', data: expect.objectContaining({ balance_credits: 5000, status: 'ok' }) }])
    expect((await call(owner, 'GET', '/api/ai/wallet')).body.wallet).toMatchObject({ balance_credits: 5000, lifetime_credited_credits: 5000 })
    expect((await call(admin, 'POST', `/api/platform/companies/00000000-0000-4000-8000-000000000000/ai/topups`, { credits: 1, note: 'x' })).status).toBe(404)
  })

  it('ajuste com sinal, limites da carteira, reembolso idempotente e carteiras negativas', async () => {
    const admin = await platformAdmin()
    const owner = await signUp()
    const base = `/api/platform/companies/${owner.companyId}/ai`
    expect((await call(admin, 'POST', `${base}/adjustments`, { credits: 0, note: 'x' })).status).toBe(422)
    const adj = await call(admin, 'POST', `${base}/adjustments`, { credits: -300, note: 'Correção' })
    expect(adj.status).toBe(201)
    expect(adj.body.entry).toMatchObject({ kind: 'adjust', amount_credits: -300, actor_user_id: admin.userId })
    const patched = await call(admin, 'PATCH', `${base}/wallet`, { low_threshold_credits: 50, max_overrun_credits: 500 })
    expect(patched.body.wallet).toMatchObject({ balance_credits: -300, low_threshold_credits: 50, max_overrun_credits: 500, status: 'low' })
    const negatives = (await call(admin, 'GET', '/api/platform/ai/wallets?negative=1')).body.items
    expect(negatives.map((w: any) => w.company_id)).toContain(owner.companyId)
    expect(negatives.every((w: any) => w.balance_credits < 0)).toBe(true)

    const used = await record(owner.companyId, { at: new Date() })
    const refund = await call(admin, 'POST', `/api/platform/ai/usage/${used.id}/refund`, { note: 'Falha do provedor' })
    expect(refund.body).toMatchObject({ refunded: true, entry: { kind: 'refund', usage_id: used.id, amount_credits: used.credits } })
    expect((await call(admin, 'POST', `/api/platform/ai/usage/${used.id}/refund`, {})).body).toMatchObject({ refunded: false, entry: null })
    expect((await call(admin, 'POST', `/api/platform/ai/usage/00000000-0000-4000-8000-000000000000/refund`, {})).status).toBe(404)
  })

  it('cotas por período: PUT substitui, GET da plataforma e da empresa', async () => {
    const admin = await platformAdmin()
    const owner = await signUp()
    const path = `/api/platform/companies/${owner.companyId}/ai/quotas`
    const put = await call(admin, 'PUT', path, { quotas: [{ period: 'day', max_credits: 1000, hard: false }, { period: 'month', max_tokens: 5_000_000 }] })
    expect(put.body.quotas).toEqual([
      expect.objectContaining({ period: 'day', max_credits: 1000, max_tokens: null, hard: false }),
      expect.objectContaining({ period: 'month', max_tokens: 5_000_000, hard: true }),
    ])
    expect((await call(owner, 'GET', '/api/ai/quotas')).body.quotas).toHaveLength(2)
    expect((await call(admin, 'PUT', path, { quotas: [{ period: 'day' }, { period: 'day' }] })).status).toBe(422)
    expect((await call(admin, 'PUT', path, { quotas: [] })).body.quotas).toEqual([])
  })
})

describe('AC-T37-03 preços com vigência', () => {
  it('preço futuro não altera usos anteriores; a listagem mostra o histórico; só preço agendado pode ser editado', async () => {
    const admin = await platformAdmin()
    const owner = await signUp()
    const before = await record(owner.companyId, { model: 'm1', at: new Date('2026-01-10T12:00:00Z') })
    const future = new Date(Date.now() + 2 * 86_400_000).toISOString()
    const created = await call(admin, 'POST', '/api/platform/ai/prices', { provider: 'testprov', model: 'm1', kind: 'llm', effective_from: future, input_per_mtok_micros: 10_000_000 })
    expect(created.status).toBe(201)
    expect(created.body.price).toMatchObject({ scheduled: true, input_per_mtok_micros: 10_000_000 })
    // O uso anterior mantém o custo.
    const [row] = await db.select().from(aiUsage).where(eq(aiUsage.id, before.id))
    expect(row).toMatchObject({ costMicros: before.costMicros, credits: before.credits })
    // Um uso registrado agora ainda usa o preço vigente (o novo só vale a partir da vigência).
    const now = await record(owner.companyId, { model: 'm1', at: new Date() })
    expect(now.costMicros).toBe(before.costMicros)
    const after = await record(owner.companyId, { model: 'm1', at: new Date(Date.now() + 3 * 86_400_000) })
    expect(after.costMicros).toBe(before.costMicros * 10)

    const history = (await call(admin, 'GET', '/api/platform/ai/prices?provider=testprov&model=m1')).body.items
    expect(history.map((p: any) => [p.input_per_mtok_micros, p.scheduled, p.current])).toEqual([
      [10_000_000, true, false],
      [1_000_000, false, true],
    ])
    const current = history.find((p: any) => p.current)
    const patchCurrent = await call(admin, 'PATCH', `/api/platform/ai/prices/${current.id}`, { input_per_mtok_micros: 5 })
    expect([patchCurrent.status, patchCurrent.body.error.details.error_code]).toEqual([409, 'price_in_effect'])
    const patched = await call(admin, 'PATCH', `/api/platform/ai/prices/${created.body.price.id}`, { input_per_mtok_micros: 9_000_000 })
    expect(patched.body.price).toMatchObject({ input_per_mtok_micros: 9_000_000, scheduled: true })
    expect((await call(admin, 'POST', '/api/platform/ai/prices', { provider: 'testprov', model: 'm1', effective_from: future })).status).toBe(409)
  })

  it('pricing-settings: global com padrões, sobreposição por empresa', async () => {
    const admin = await platformAdmin()
    const owner = await signUp()
    const global = (await call(admin, 'GET', '/api/platform/ai/pricing-settings')).body
    expect(global.settings).toMatchObject({ scope: 'global', markup_bps: expect.any(Number), credits_per_usd: expect.any(Number) })
    const own = await call(admin, 'PATCH', '/api/platform/ai/pricing-settings', { company_id: owner.companyId, markup_bps: 20_000 })
    expect(own.body.settings).toMatchObject({ scope: 'company', company_id: owner.companyId, configured: true, markup_bps: 20_000 })
    const view = (await call(admin, 'GET', `/api/platform/ai/pricing-settings?company_id=${owner.companyId}`)).body
    expect(view.effective).toMatchObject({ scope: 'company', markup_bps: 20_000 })
  })
})

describe('AC-T37-04 extrato e resumo', () => {
  it('o extrato pagina de forma estável (mesmo instante, cursor) e a plataforma vê o uso de todas as empresas', async () => {
    const owner = await signUp()
    const admin = await platformAdmin()
    const at = new Date('2026-09-01T10:00:00Z')
    const ids = new Set<string>()
    for (let i = 0; i < 5; i++) ids.add((await record(owner.companyId, { at })).id)
    const seen: string[] = []
    let cursor: string | null = null
    do {
      const page: any = (await call(owner, 'GET', `/api/ai/usage?limit=2${cursor ? `&cursor=${cursor}` : ''}`)).body
      expect(page.items.length).toBeLessThanOrEqual(2)
      seen.push(...page.items.map((i: any) => i.id))
      cursor = page.next_cursor
    } while (cursor)
    expect(seen).toHaveLength(5)
    expect(new Set(seen)).toEqual(ids)
    expect((await call(owner, 'GET', '/api/ai/usage?cursor=lixo')).status).toBe(422)
    const platform = (await call(admin, 'GET', `/api/platform/ai/usage?company_id=${owner.companyId}&limit=200`)).body.items
    expect(platform.map((i: any) => i.id).sort()).toEqual([...ids].sort())
  })

  it('summary agrupa por dia no fuso da empresa, por feature, modelo e agente (fixture conhecida)', async () => {
    const owner = await signUp()
    await db.update(companies).set({ timeZone: 'America/Sao_Paulo' }).where(eq(companies.id, owner.companyId))
    const agent = '00000000-0000-4000-8000-00000000a9e1'
    // 02:00Z de 10/10 = 23:00 de 09/10 em São Paulo; 04:00Z e 15:00Z = dia 10/10.
    const u1 = await record(owner.companyId, { model: 'm1', at: new Date('2026-10-10T02:00:00Z'), feature: 'ai_agent', agentId: agent })
    const u2 = await record(owner.companyId, { model: 'm2', at: new Date('2026-10-10T04:00:00Z'), feature: 'ai_agent', agentId: agent })
    const u3 = await record(owner.companyId, { model: 'm1', at: new Date('2026-10-10T15:00:00Z'), feature: 'flow' })
    const sum = async (q: string) => (await call(owner, 'GET', `/api/ai/usage/summary?${q}`)).body
    const byDay = await sum('group_by=day')
    expect(byDay.time_zone).toBe('America/Sao_Paulo')
    expect(byDay.items).toEqual([
      { key: '2026-10-09', count: 1, input_tokens: 1_000_000, output_tokens: 0, cost_micros: u1.costMicros, credits: u1.credits },
      { key: '2026-10-10', count: 2, input_tokens: 2_000_000, output_tokens: 0, cost_micros: u2.costMicros + u3.costMicros, credits: u2.credits + u3.credits },
    ])
    expect((await sum('group_by=feature')).items.map((i: any) => [i.key, i.count])).toEqual([
      ['ai_agent', 2],
      ['flow', 1],
    ])
    expect((await sum('group_by=model')).items.map((i: any) => [i.key, i.count, i.cost_micros])).toEqual([
      ['testprov/m1', 2, u1.costMicros + u3.costMicros],
      ['testprov/m2', 1, u2.costMicros],
    ])
    expect((await sum('group_by=agent')).items.map((i: any) => [i.key, i.count])).toEqual([
      [agent, 2],
      [null, 1],
    ])
    // Janela [from, to): só o dia 10/10 em São Paulo.
    expect((await sum('group_by=day&from=2026-10-10T03:00:00Z&to=2026-10-11T03:00:00Z')).items.map((i: any) => i.key)).toEqual(['2026-10-10'])
    expect((await call(owner, 'GET', '/api/ai/usage/summary?group_by=hora')).status).toBe(422)
  })
})
