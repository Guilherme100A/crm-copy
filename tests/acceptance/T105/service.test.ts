// AC-T105-01/04 pela porta pública `InternalSalesService` (@crm/core) com Postgres real (banco temporário):
// período em datas locais do fuso da empresa, só vendas approved, source_id comparado exatamente, isolamento por empresa.
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { fixedFxRates, InternalSalesError, InternalSalesService } from '@crm/core'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

let tmp: TempDatabase
let db: Any
const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true })
  db = createDb(tmp.url, { max: 3 })
}, 120_000)

afterAll(async () => {
  await db?.$client.end().catch(() => {})
  await tmp?.drop()
}, 60_000)

async function company(timeZone: string): Promise<string> {
  const tag = randomBytes(4).toString('hex')
  const [c] = await q(`INSERT INTO crm.companies (name, slug, time_zone) VALUES ($1, $2, $3) RETURNING id`, [`T105 ${tag}`, `t105-acc-${tag}`, timeZone])
  return c.id
}

async function sale(companyId: string, s: { cents: number; at: string; source: string | null; status?: string; currency?: string }) {
  await q(`INSERT INTO crm.sales (company_id, amount_cents, sold_at, source_id, status, currency) VALUES ($1, $2, $3, $4, $5, $6)`, [
    companyId,
    s.cents,
    s.at,
    s.source,
    s.status ?? 'approved',
    s.currency ?? 'BRL',
  ])
}

const svc = () => new InternalSalesService({ db, fx: fixedFxRates({ 'USD:BRL': 5 }) })
const byId = (list: Any[]) => Object.fromEntries(list.map((a) => [`${a.sourceId}|${a.currency}`, { count: a.count, amountCents: a.amountCents }]))

describe('T105 — consulta por anúncio e período no fuso (AC-T105-01)', () => {
  it('AC-T105-01 23:30 de São Paulo (02:30Z do dia seguinte) entra no dia local; bordas 00:00 local entram/saem certo', async () => {
    const co = await company('America/Sao_Paulo')
    await sale(co, { cents: 10_000, at: '2026-10-11T02:30:00Z', source: '777001' }) // 10/10 23:30 local → entra
    await sale(co, { cents: 1_000, at: '2026-10-10T03:00:00Z', source: '777001' }) // 10/10 00:00 local → entra
    await sale(co, { cents: 50_000, at: '2026-10-10T02:59:59Z', source: '777001' }) // 09/10 23:59 local → fora
    await sale(co, { cents: 70_000, at: '2026-10-11T03:00:00Z', source: '777001' }) // 11/10 00:00 local → fora
    const r = await svc().aggregates({ companyId: co, since: '2026-10-10', until: '2026-10-10', adIds: ['777001'] })
    expect(byId(r)).toEqual({ '777001|BRL': { count: 2, amountCents: 11_000 } })
  })

  it('AC-T105-01 o fuso é o da empresa: o mesmo instante cai em dias diferentes em Manaus (-04) e em Tóquio (+09)', async () => {
    const at = '2026-10-10T20:30:00Z' // Manaus: 10/10 16:30; Tóquio: 11/10 05:30
    const manaus = await company('America/Manaus')
    const tokyo = await company('Asia/Tokyo')
    await sale(manaus, { cents: 3_000, at, source: '777002' })
    await sale(tokyo, { cents: 3_000, at, source: '777002' })
    const one = (co: string, d: string) => svc().aggregates({ companyId: co, since: d, until: d, adIds: ['777002'] })
    expect(await one(manaus, '2026-10-10')).toHaveLength(1)
    expect(await one(manaus, '2026-10-11')).toHaveLength(0)
    expect(await one(tokyo, '2026-10-10')).toHaveLength(0)
    expect(await one(tokyo, '2026-10-11')).toHaveLength(1)
  })

  it('AC-T105-01 período de vários dias é inclusivo nas duas pontas; vendas de outra empresa não entram', async () => {
    const co = await company('America/Sao_Paulo')
    const other = await company('America/Sao_Paulo')
    await sale(co, { cents: 100, at: '2026-10-01T03:00:00Z', source: '777003' }) // 01/10 00:00 local
    await sale(co, { cents: 200, at: '2026-10-06T02:59:00Z', source: '777003' }) // 05/10 23:59 local
    await sale(co, { cents: 400, at: '2026-10-06T03:00:00Z', source: '777003' }) // 06/10 → fora
    await sale(other, { cents: 999_999, at: '2026-10-03T12:00:00Z', source: '777003' })
    const r = await svc().aggregates({ companyId: co, since: '2026-10-01', until: '2026-10-05', adIds: ['777003'] })
    expect(byId(r)).toEqual({ '777003|BRL': { count: 2, amountCents: 300 } })
  })

  it('AC-T105-01 só vendas approved entram (refunded, chargeback e pending ficam fora); agrupa por moeda', async () => {
    const co = await company('America/Sao_Paulo')
    const at = '2026-10-10T15:00:00Z'
    await sale(co, { cents: 1_000, at, source: '777004' })
    await sale(co, { cents: 2_000, at, source: '777004', status: 'refunded' })
    await sale(co, { cents: 4_000, at, source: '777004', status: 'chargeback' })
    await sale(co, { cents: 8_000, at, source: '777004', status: 'pending' })
    await sale(co, { cents: 500, at, source: '777004', currency: 'USD' })
    const r = await svc().aggregates({ companyId: co, since: '2026-10-10', until: '2026-10-10', adIds: ['777004'] })
    expect(byId(r)).toEqual({ '777004|BRL': { count: 1, amountCents: 1_000 }, '777004|USD': { count: 1, amountCents: 500 } })
  })

  it('AC-T105-01 join() devolve purchases_internal/purchase_value_internal por anúncio no fuso da empresa (valores convertidos)', async () => {
    const co = await company('America/Sao_Paulo')
    await sale(co, { cents: 10_000, at: '2026-10-11T02:30:00Z', source: '777005' })
    await sale(co, { cents: 1_000, at: '2026-10-10T15:00:00Z', source: '777005', currency: 'USD' })
    await sale(co, { cents: 1_000, at: '2026-10-10T15:00:00Z', source: '777005', status: 'refunded' })
    const ad = { id: '777005', currency: 'BRL', metrics: { meta_spend: 75, meta_spend_display: 75 } }
    const r = await svc().join(co, { since: '2026-10-10', until: '2026-10-10', displayCurrency: 'BRL' }, { campaign: [], adset: [], ad: [ad as Any] })
    expect(r.ad.get('777005')).toMatchObject({ purchases_internal: 2, purchase_value_internal: 150, roas_internal: 2 })
  })

  it('AC-T105-01 data ou fuso inválido dá InternalSalesError (sem default silencioso)', async () => {
    const co = await company('America/Sao_Paulo')
    const s = svc()
    await expect(s.aggregates({ companyId: co, since: '2026-02-30', until: '2026-03-01', adIds: ['1'] })).rejects.toBeInstanceOf(InternalSalesError)
    await expect(s.aggregates({ companyId: co, since: '2026-10-12', until: '2026-10-10', adIds: ['1'] })).rejects.toMatchObject({ field: 'until' })
    await expect(s.aggregates({ companyId: co, since: '2026-10-10', until: '2026-10-10', adIds: ['1'], timeZone: 'Nada/Aqui' })).rejects.toMatchObject({ field: 'time_zone' })
  })
})

describe('T105 — vendas sem source_id (AC-T105-04)', () => {
  it('AC-T105-04 source_id null, vazio ou só espaços não entra em nenhum anúncio; id com espaço/prefixo não casa', async () => {
    const co = await company('America/Sao_Paulo')
    const at = '2026-10-10T15:00:00Z'
    await sale(co, { cents: 1_000, at, source: null })
    await sale(co, { cents: 1_000, at, source: '' })
    await sale(co, { cents: 1_000, at, source: '   ' })
    await sale(co, { cents: 1_000, at, source: ' 888001' })
    await sale(co, { cents: 1_000, at, source: '0888001' })
    await sale(co, { cents: 4_000, at, source: '888001' })
    const r = await svc().aggregates({ companyId: co, since: '2026-10-10', until: '2026-10-10', adIds: ['888001', '', '   '] })
    expect(byId(r)).toEqual({ '888001|BRL': { count: 1, amountCents: 4_000 } })
    expect(await svc().aggregates({ companyId: co, since: '2026-10-10', until: '2026-10-10', adIds: ['', '   '] })).toEqual([])
  })

  it('AC-T105-04 no join, anúncios com id vazio não recebem as vendas sem source_id', async () => {
    const co = await company('America/Sao_Paulo')
    const at = '2026-10-10T15:00:00Z'
    await sale(co, { cents: 5_000, at, source: null })
    await sale(co, { cents: 5_000, at, source: '' })
    await sale(co, { cents: 5_000, at, source: '  ' })
    const mk = (id: string) => ({ id, currency: 'BRL', campaign_id: 'c', metrics: { meta_spend: 10, meta_spend_display: 10 } }) as Any
    const camp = { id: 'c', currency: 'BRL', metrics: { meta_spend: 10, meta_spend_display: 10 } } as Any
    const r = await svc().join(co, { since: '2026-10-10', until: '2026-10-10', displayCurrency: 'BRL' }, { campaign: [camp], adset: [], ad: [mk('888002'), mk(''), mk('  ')] })
    for (const [id, m] of r.ad) expect(m.purchases_internal, `anúncio "${id}"`).toBe(0)
    expect(r.campaign.get('c')!.purchases_internal).toBe(0)
  })
})
