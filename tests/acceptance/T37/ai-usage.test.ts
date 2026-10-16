// AC-T37-01..04 pela API (empresa e plataforma).
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectSse, envelopeOf } from '../helpers/sse'
import { MODEL_A, MODEL_B, member, owner, platformAdmin, postPrice, recordUsage, startEnv, type Env, type User } from './setup'

let env: Env
let admin: User

beforeAll(async () => {
  env = await startEnv()
  admin = await platformAdmin(env)
  // preços conhecidos e já vigentes para os modelos da fixture
  expect((await postPrice(admin, MODEL_A, '2026-01-01T00:00:00.000Z', 1_000_000, 2_000_000)).status).toBe(201)
  expect((await postPrice(admin, MODEL_B, '2026-01-01T00:00:00.000Z', 3_000_000, 4_000_000)).status).toBe(201)
}, 120_000)

afterAll(async () => {
  await env?.close()
})

const topup = (companyId: string, body: Record<string, unknown>) => admin.c.post(`/api/platform/companies/${companyId}/ai/topups`, body)

describe('T37 — recarga pela plataforma (AC-T37-01)', () => {
  it('AC-T37-01 recarga sem nota → 422 e nada é creditado', async () => {
    const o = await owner(env)
    for (const body of [{ credits: 1000 }, { credits: 1000, note: '' }, { credits: 1000, note: '   ' }]) {
      const r = await topup(o.companyId, body)
      expect(r.status, JSON.stringify(body)).toBe(422)
      expect(r.body.error.code).toBe('VALIDATION_ERROR')
    }
    const w = await o.c.get('/api/ai/wallet')
    expect(Number(w.body.wallet.balance_credits)).toBe(0)
  })

  it('AC-T37-01 recarga com nota gera entrada topup com actor_user_id e publica ai_wallet.updated na empresa', async () => {
    const o = await owner(env)
    const sse = await connectSse((p, i) => env.app.request(p, i), `/api/events?company_id=${o.companyId}`, { cookie: `crm_session=${o.token}` })
    try {
      const r = await topup(o.companyId, { credits: 5000, note: 'Recarga de teste T37' })
      expect(r.status, r.text).toBe(201)
      expect(r.body.entry).toMatchObject({ kind: 'topup', company_id: o.companyId, actor_user_id: admin.userId, note: 'Recarga de teste T37' })
      expect(Number(r.body.entry.amount_credits)).toBe(5000)
      expect(Number(r.body.wallet.balance_credits)).toBe(5000)

      const rows = await env.q(`SELECT actor_user_id, note FROM crm.ai_wallet_entries WHERE company_id = $1 AND id = $2`, [o.companyId, r.body.entry.id])
      expect(rows).toEqual([{ actor_user_id: admin.userId, note: 'Recarga de teste T37' }])

      const ev = await sse.waitFor((m) => m.event === 'ai_wallet.updated', 10_000)
      const env0 = envelopeOf(ev)
      expect(env0.company_id).toBe(o.companyId)
      expect(JSON.stringify(env0.data)).toContain('5000')

      expect(Number((await o.c.get('/api/ai/wallet')).body.wallet.balance_credits)).toBe(5000)
    } finally {
      await sse.close()
    }
  })

  it('AC-T37-01 o evento não vaza para outra empresa', async () => {
    const a = await owner(env)
    const b = await owner(env)
    const sse = await connectSse((p, i) => env.app.request(p, i), `/api/events?company_id=${b.companyId}`, { cookie: `crm_session=${b.token}` })
    try {
      expect((await topup(a.companyId, { credits: 10, note: 'só A' })).status).toBe(201)
      await new Promise((r) => setTimeout(r, 800))
      expect(sse.events('ai_wallet.updated')).toEqual([])
    } finally {
      await sse.close()
    }
  })
})

describe('T37 — permissões (AC-T37-02)', () => {
  const PLATFORM: Array<[string, string, unknown?]> = [
    ['get', '/api/platform/ai/prices'],
    ['post', '/api/platform/ai/prices', { provider: 'openai', model: 'x', kind: 'llm', input_per_mtok_micros: 1, output_per_mtok_micros: 1 }],
    ['get', '/api/platform/ai/pricing-settings'],
    ['get', '/api/platform/ai/usage'],
    ['get', '/api/platform/ai/wallets?negative=1'],
    ['post', '/api/platform/companies/COMPANY/ai/topups', { credits: 10, note: 'x' }],
    ['post', '/api/platform/companies/COMPANY/ai/adjustments', { credits: -1, note: 'x' }],
    ['get', '/api/platform/companies/COMPANY/ai/quotas'],
    ['patch', '/api/platform/companies/COMPANY/ai/wallet', { max_overrun_credits: 10 }],
  ]

  it('AC-T37-02 dono de empresa (sem platform_admin) recebe 403 em qualquer /api/platform/*', async () => {
    const o = await owner(env)
    for (const [method, path, body] of PLATFORM) {
      const r = await (o.c as any)[method](path.replace('COMPANY', o.companyId), body)
      expect(r.status, `${method} ${path}`).toBe(403)
    }
    // e nada foi creditado pela tentativa
    expect(Number((await o.c.get('/api/ai/wallet')).body.wallet.balance_credits)).toBe(0)
  })

  it('AC-T37-02 sem sessão → 401 em /api/platform/*; o admin da plataforma acessa', async () => {
    const anon = await env.app.request('/api/platform/ai/prices')
    expect(anon.status).toBe(401)
    expect((await admin.c.get('/api/platform/ai/prices')).status).toBe(200)
    expect((await admin.c.get('/api/platform/ai/wallets?negative=1')).status).toBe(200)
  })

  it('AC-T37-02 membro sem ai_usage.view → 403 em /api/ai/*; com a permissão → 200', async () => {
    const o = await owner(env)
    const without = await member(env, o.companyId, ['contacts.view'])
    for (const path of ['/api/ai/wallet', '/api/ai/usage', '/api/ai/usage/summary?group_by=day', '/api/ai/quotas']) {
      const r = await without.c.get(path)
      expect(r.status, path).toBe(403)
      expect(r.body.error.code).toBe('FORBIDDEN')
    }
    const withPerm = await member(env, o.companyId, ['ai_usage.view'])
    for (const path of ['/api/ai/wallet', '/api/ai/usage', '/api/ai/usage/summary?group_by=day', '/api/ai/quotas']) {
      expect((await withPerm.c.get(path)).status, path).toBe(200)
    }
  })
})

describe('T37 — preços com vigência (AC-T37-03)', () => {
  it('AC-T37-03 preço novo com vigência futura não altera o custo de usos anteriores; a lista mostra o histórico', async () => {
    const o = await owner(env)
    await topup(o.companyId, { credits: 1_000_000, note: 'saldo para a fixture' })
    const m = { provider: 'openai', model: `gpt-t37-hist-${randomUUID().slice(0, 6)}` }
    expect((await postPrice(admin, m, '2026-01-01T00:00:00.000Z', 1_000_000, 1_000_000)).status).toBe(201)
    const before = await recordUsage(env, o.companyId, m, new Date('2026-09-01T12:00:00Z'), { input: 1_000_000, output: 0 })

    const getItem = async () => (await o.c.get(`/api/ai/usage?limit=200`)).body.items.find((i: any) => i.id === before.id)
    const original = await getItem()
    expect(Number(original.cost_micros)).toBe(1_000_000)

    const future = new Date(Date.now() + 30 * 86_400_000).toISOString()
    const created = await postPrice(admin, m, future, 9_000_000, 9_000_000)
    expect(created.status, created.text).toBe(201)

    const after = await getItem()
    expect(Number(after.cost_micros)).toBe(Number(original.cost_micros))
    expect(Number(after.credits)).toBe(Number(original.credits))

    const list = await admin.c.get(`/api/platform/ai/prices?provider=${m.provider}&model=${m.model}`)
    expect(list.status).toBe(200)
    const mine = list.body.items.filter((p: any) => p.model === m.model)
    expect(mine).toHaveLength(2)
    expect(mine.map((p: any) => Number(p.input_per_mtok_micros)).sort((a: number, b: number) => a - b)).toEqual([1_000_000, 9_000_000])
    expect(mine.find((p: any) => Number(p.input_per_mtok_micros) === 9_000_000).scheduled).toBe(true)
    expect(mine.find((p: any) => Number(p.input_per_mtok_micros) === 1_000_000).current).toBe(true)
  })

  it('AC-T37-03 cada uso é precificado pela vigência na sua data', async () => {
    const o = await owner(env)
    await topup(o.companyId, { credits: 1_000_000, note: 'saldo' })
    const m = { provider: 'openai', model: `gpt-t37-vig-${randomUUID().slice(0, 6)}` }
    await postPrice(admin, m, '2026-01-01T00:00:00.000Z', 1_000_000, 0)
    await postPrice(admin, m, '2026-06-01T00:00:00.000Z', 3_000_000, 0)
    const jan = await recordUsage(env, o.companyId, m, new Date('2026-03-01T12:00:00Z'), { input: 1_000_000, output: 0 })
    const jul = await recordUsage(env, o.companyId, m, new Date('2026-07-01T12:00:00Z'), { input: 1_000_000, output: 0 })
    const items = (await o.c.get('/api/ai/usage?limit=200')).body.items
    expect(Number(items.find((i: any) => i.id === jan.id).cost_micros)).toBe(1_000_000)
    expect(Number(items.find((i: any) => i.id === jul.id).cost_micros)).toBe(3_000_000)
  })

  it('AC-T37-03 preço já vigente não pode ser editado (409); o agendado pode', async () => {
    const m = { provider: 'openai', model: `gpt-t37-edit-${randomUUID().slice(0, 6)}` }
    const cur = await postPrice(admin, m, '2026-01-01T00:00:00.000Z', 1, 1)
    const sch = await postPrice(admin, m, new Date(Date.now() + 10 * 86_400_000).toISOString(), 2, 2)
    expect((await admin.c.patch(`/api/platform/ai/prices/${cur.body.price.id}`, { input_per_mtok_micros: 5 })).status).toBe(409)
    expect((await admin.c.patch(`/api/platform/ai/prices/${sch.body.price.id}`, { input_per_mtok_micros: 5 })).status).toBe(200)
  })
})

describe('T37 — extrato e resumo (AC-T37-04)', () => {
  it('AC-T37-04 o extrato pagina de forma estável (sem repetir nem pular), mesmo com usos novos entre as páginas', async () => {
    const o = await owner(env)
    await topup(o.companyId, { credits: 10_000_000, note: 'saldo' })
    const ids: string[] = []
    for (let i = 0; i < 25; i++) ids.push((await recordUsage(env, o.companyId, MODEL_A, new Date(Date.UTC(2026, 8, 1, 10, 0, i)), { input: 1000, output: 1000 })).id)
    // dois usos no MESMO instante: o desempate por id mantém a ordem estável
    ids.push((await recordUsage(env, o.companyId, MODEL_A, new Date(Date.UTC(2026, 8, 1, 10, 0, 30)), { input: 1, output: 1 })).id)
    ids.push((await recordUsage(env, o.companyId, MODEL_A, new Date(Date.UTC(2026, 8, 1, 10, 0, 30)), { input: 1, output: 1 })).id)

    const seen: string[] = []
    let cursor: string | null = null
    let page = 0
    do {
      const r: any = await o.c.get(`/api/ai/usage?limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      expect(r.status, r.text).toBe(200)
      expect(r.body.items.length).toBeLessThanOrEqual(10)
      seen.push(...r.body.items.map((i: any) => i.id))
      cursor = r.body.next_cursor ?? null
      if (page++ === 0) {
        // uso novo (mais recente) chegando entre as páginas não desloca as seguintes
        await recordUsage(env, o.companyId, MODEL_A, new Date(), { input: 1, output: 1 })
      }
    } while (cursor && page < 10)
    expect(seen.length).toBe(new Set(seen).size)
    expect(new Set(seen)).toEqual(new Set(ids))
    // ordem decrescente por data
    const all = (await o.c.get('/api/ai/usage?limit=200')).body.items.filter((i: any) => ids.includes(i.id))
    const times = all.map((i: any) => Date.parse(i.created_at))
    expect([...times].sort((a, b) => b - a)).toEqual(times)
  })

  it('AC-T37-04 summary agrupa por dia no fuso da empresa, por feature e por modelo (fixture conhecida)', async () => {
    const o = await owner(env)
    await topup(o.companyId, { credits: 100_000_000, note: 'saldo' })
    // America/Sao_Paulo (UTC−3): 02:00Z do dia 10 ainda é dia 09 local; 04:00Z já é dia 10.
    await recordUsage(env, o.companyId, MODEL_A, new Date('2026-09-10T02:00:00Z'), { input: 1_000_000, output: 0 }, { feature: 'agent' })
    await recordUsage(env, o.companyId, MODEL_A, new Date('2026-09-10T04:00:00Z'), { input: 1_000_000, output: 0 }, { feature: 'agent' })
    await recordUsage(env, o.companyId, MODEL_B, new Date('2026-09-10T15:00:00Z'), { input: 1_000_000, output: 0 }, { feature: 'copilot' })
    await recordUsage(env, o.companyId, MODEL_B, new Date('2026-09-11T15:00:00Z'), { input: 0, output: 1_000_000 }, { feature: 'copilot' })

    const range = 'from=2026-09-09T00:00:00Z&to=2026-09-12T00:00:00Z'
    const byDay = await o.c.get(`/api/ai/usage/summary?group_by=day&${range}`)
    expect(byDay.status, byDay.text).toBe(200)
    expect(byDay.body.time_zone).toBe('America/Sao_Paulo')
    const day = Object.fromEntries(byDay.body.items.map((i: any) => [i.key, i]))
    expect(Object.keys(day).sort()).toEqual(['2026-09-09', '2026-09-10', '2026-09-11'])
    expect([day['2026-09-09'].count, day['2026-09-10'].count, day['2026-09-11'].count]).toEqual([1, 2, 1])
    // custo (preços da fixture): A = 1 USD/Mtok de entrada; B = 3 USD entrada, 4 USD saída
    expect(Number(day['2026-09-09'].cost_micros)).toBe(1_000_000)
    expect(Number(day['2026-09-10'].cost_micros)).toBe(1_000_000 + 3_000_000)
    expect(Number(day['2026-09-11'].cost_micros)).toBe(4_000_000)

    const byFeature = Object.fromEntries((await o.c.get(`/api/ai/usage/summary?group_by=feature&${range}`)).body.items.map((i: any) => [i.key, i]))
    expect(byFeature.agent.count).toBe(2)
    expect(byFeature.copilot.count).toBe(2)
    expect(Number(byFeature.agent.cost_micros)).toBe(2_000_000)
    expect(Number(byFeature.copilot.cost_micros)).toBe(7_000_000)

    const byModel = Object.fromEntries((await o.c.get(`/api/ai/usage/summary?group_by=model&${range}`)).body.items.map((i: any) => [i.key, i]))
    expect(byModel[`${MODEL_A.provider}/${MODEL_A.model}`].count).toBe(2)
    expect(byModel[`${MODEL_B.provider}/${MODEL_B.model}`].count).toBe(2)
    expect(Number(byModel[`${MODEL_B.provider}/${MODEL_B.model}`].input_tokens)).toBe(1_000_000)
    expect(Number(byModel[`${MODEL_B.provider}/${MODEL_B.model}`].output_tokens)).toBe(1_000_000)

    // os créditos somados batem com o extrato
    const items = (await o.c.get(`/api/ai/usage?limit=200&${range}`)).body.items
    const total = items.reduce((s: number, i: any) => s + Number(i.credits), 0)
    const sumDay = byDay.body.items.reduce((s: number, i: any) => s + Number(i.credits), 0)
    expect(sumDay).toBe(total)
  })

  it('AC-T37-04 o summary é isolado por empresa', async () => {
    const a = await owner(env)
    const b = await owner(env)
    await topup(a.companyId, { credits: 1_000_000, note: 'saldo' })
    await recordUsage(env, a.companyId, MODEL_A, new Date('2026-09-20T15:00:00Z'), { input: 1000, output: 0 })
    const r = await b.c.get('/api/ai/usage/summary?group_by=day&from=2026-09-20T00:00:00Z&to=2026-09-21T00:00:00Z')
    expect(r.status).toBe(200)
    expect(r.body.items).toEqual([])
    expect((await b.c.get('/api/ai/usage')).body.items).toEqual([])
  })
})
