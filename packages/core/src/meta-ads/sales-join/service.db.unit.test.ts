// Vendas internas × anúncios (T105) com Postgres real: período no fuso da empresa, status, source_id exato e a ligação
// no bundle do Gerenciador (FakeMetaGraph + Redis real; nunca a Graph real).
import { randomBytes } from 'node:crypto'
import { companies, createDb, metaAdAccounts, sales, users, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { generateCredentialsKey, initCredentialsCrypto, redisConnection } from '@crm/node-kit'
import { eq } from 'drizzle-orm'
import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeMetaGraph } from '../client/testing'
import { MetaProfilesService } from '../profiles/service'
import { fixedFxRates } from '../structure/metrics'
import { MetaBundleService } from '../structure/service'
import { InternalSalesError, InternalSalesService } from './service'

let tmp: TempDatabase
let db: Database
let redis: Redis
const fake = new FakeMetaGraph({ appId: 'app-105', appSecret: 'secret-105', pageSize: 2 })
const stateKey = randomBytes(32)

beforeAll(async () => {
  initCredentialsCrypto({ key: generateCredentialsKey() })
  await fake.start()
  tmp = await createTempDatabase({ migrate: true })
  db = createDb(tmp.url, { max: 4 })
  redis = redisConnection()
}, 120_000)

afterAll(async () => {
  await fake.close()
  await db?.$client.end()
  await redis?.quit()
  await tmp?.drop()
}, 60_000)

async function company(timeZone = 'America/Sao_Paulo'): Promise<string> {
  const tag = randomBytes(4).toString('hex')
  const [c] = await db
    .insert(companies)
    .values({ name: `S${tag}`, slug: `s-t105-${tag}`, timeZone })
    .returning()
  return c!.id
}

type SaleIn = Partial<typeof sales.$inferInsert> & { amountCents: number; soldAt: Date }
const insertSales = (companyId: string, list: SaleIn[]) =>
  db.insert(sales).values(list.map((s) => ({ companyId, ...s })))

describe('InternalSalesService.aggregates', () => {
  it('AC-T105-01: período no fuso da empresa (23:30 de São Paulo = UTC do dia seguinte), só approved', async () => {
    const co = await company()
    await insertSales(co, [
      // 2026-10-10 23:30 em São Paulo (-03) = 2026-10-11 02:30Z → entra no dia 10.
      { amountCents: 10_000, soldAt: new Date('2026-10-11T02:30:00Z'), sourceId: '120001' },
      // 2026-10-10 00:00 local (03:00Z) → entra; 02:59Z = dia 9 local → fora.
      { amountCents: 2_000, soldAt: new Date('2026-10-10T03:00:00Z'), sourceId: '120001' },
      { amountCents: 9_900, soldAt: new Date('2026-10-10T02:59:00Z'), sourceId: '120001' },
      // 2026-10-11 00:00 local (03:00Z) → fora de 10..10.
      { amountCents: 9_900, soldAt: new Date('2026-10-11T03:00:00Z'), sourceId: '120001' },
      // Status fora.
      { amountCents: 9_900, soldAt: new Date('2026-10-10T15:00:00Z'), sourceId: '120001', status: 'refunded' },
      { amountCents: 9_900, soldAt: new Date('2026-10-10T15:00:00Z'), sourceId: '120001', status: 'chargeback' },
      { amountCents: 9_900, soldAt: new Date('2026-10-10T15:00:00Z'), sourceId: '120001', status: 'pending' },
      // Outro anúncio, em USD.
      { amountCents: 1_500, soldAt: new Date('2026-10-10T15:00:00Z'), sourceId: '120002', currency: 'USD' },
      // Anúncio não pedido.
      { amountCents: 9_900, soldAt: new Date('2026-10-10T15:00:00Z'), sourceId: '999' },
    ])
    const other = await company()
    await insertSales(other, [{ amountCents: 9_900, soldAt: new Date('2026-10-10T15:00:00Z'), sourceId: '120001' }])

    const svc = new InternalSalesService({ db, fx: fixedFxRates({ 'USD:BRL': 5 }) })
    const rows = await svc.aggregates({
      companyId: co,
      since: '2026-10-10',
      until: '2026-10-10',
      adIds: ['120001', '120002', '120003'],
    })
    expect(rows.sort((a, b) => a.sourceId.localeCompare(b.sourceId))).toEqual([
      { sourceId: '120001', currency: 'BRL', count: 2, amountCents: 12_000 },
      { sourceId: '120002', currency: 'USD', count: 1, amountCents: 1_500 },
    ])
    // Mesmo instante em UTC: no fuso UTC a venda das 02:30Z cai no dia 11.
    const utc = await company('UTC')
    await insertSales(utc, [{ amountCents: 10_000, soldAt: new Date('2026-10-11T02:30:00Z'), sourceId: '120001' }])
    expect(
      await svc.aggregates({ companyId: utc, since: '2026-10-10', until: '2026-10-10', adIds: ['120001'] }),
    ).toEqual([])
    expect(
      await svc.aggregates({ companyId: utc, since: '2026-10-11', until: '2026-10-11', adIds: ['120001'] }),
    ).toHaveLength(1)
  })

  it('AC-T105-04: vendas sem source_id (null, vazio, espaços) não entram em nenhum anúncio', async () => {
    const co = await company()
    const at = new Date('2026-10-10T15:00:00Z')
    await insertSales(co, [
      { amountCents: 1_000, soldAt: at, sourceId: null },
      { amountCents: 1_000, soldAt: at, sourceId: '' },
      { amountCents: 1_000, soldAt: at, sourceId: '   ' },
      { amountCents: 1_000, soldAt: at, sourceId: ' 130001' },
      { amountCents: 4_000, soldAt: at, sourceId: '130001' },
    ])
    const svc = new InternalSalesService({ db, fx: fixedFxRates() })
    expect(
      await svc.aggregates({ companyId: co, since: '2026-10-10', until: '2026-10-10', adIds: ['130001', '', '   '] }),
    ).toEqual([{ sourceId: '130001', currency: 'BRL', count: 1, amountCents: 4_000 }])
    expect(
      await svc.aggregates({ companyId: co, since: '2026-10-10', until: '2026-10-10', adIds: ['', '  '] }),
    ).toEqual([])
  })

  it('data, período ou fuso inválido → erro claro (sem default silencioso)', async () => {
    const co = await company()
    const svc = new InternalSalesService({ db, fx: fixedFxRates() })
    await expect(
      svc.aggregates({ companyId: co, since: '2026-13-01', until: '2026-10-10', adIds: ['1'] }),
    ).rejects.toMatchObject({ field: 'since' })
    await expect(
      svc.aggregates({ companyId: co, since: '2026-10-10', until: '2026-02-30', adIds: ['1'] }),
    ).rejects.toMatchObject({ field: 'until' })
    await expect(
      svc.aggregates({ companyId: co, since: '2026-10-11', until: '2026-10-10', adIds: ['1'] }),
    ).rejects.toMatchObject({ field: 'until' })
    await expect(
      svc.aggregates({ companyId: co, since: '2026-10-10', until: '2026-10-10', adIds: ['1'], timeZone: 'Marte/Base' }),
    ).rejects.toBeInstanceOf(InternalSalesError)
    await expect(
      svc.aggregates({
        companyId: '00000000-0000-0000-0000-000000000000',
        since: '2026-10-10',
        until: '2026-10-10',
        adIds: ['1'],
      }),
    ).rejects.toMatchObject({ field: 'company' })
  })
})

// ---------------------------------------------------------------- ligação no bundle

const config = () => ({
  appId: fake.appId,
  appSecret: fake.appSecret,
  graphUrl: fake.url,
  version: 'v26.0',
  dialogUrl: 'https://www.facebook.com',
  redirectUri: 'http://api.test/cb',
  webUrl: 'http://web.test',
  scopes: ['ads_read'],
})

async function world(act: string, currency: string, withSales: boolean) {
  const co = await company()
  const tag = randomBytes(4).toString('hex')
  const fbUser = `fb-${tag}`
  fake.addUser({ id: fbUser, name: 'Ana', adAccounts: [{ id: act, name: 'Loja', currency }] })
  const profiles = new MetaProfilesService({ db, config: config(), stateKey })
  const [u] = await db
    .insert(users)
    .values({ email: `u-${tag}@x.com`, passwordHash: 'x', name: 'U', lastCompanyId: co })
    .returning()
  const started = await profiles.startOAuth({ companyId: co, userId: u!.id })
  await profiles.completeOAuth({
    companyId: co,
    userId: u!.id,
    code: fake.issueCode(fbUser, 'http://api.test/cb'),
    state: started.state,
  })
  await db.update(metaAdAccounts).set({ includedInDashboard: true }).where(eq(metaAdAccounts.companyId, co))
  const fx = fixedFxRates({ 'USD:BRL': 5 })
  fake.setStructure(act, {
    campaigns: [{ id: `${act}1`, name: 'C1', effective_status: 'ACTIVE' }],
    adsets: [{ id: `${act}2`, name: 'S1', campaign_id: `${act}1`, effective_status: 'ACTIVE' }],
    ads: [
      { id: `${act}3`, name: 'A1', campaign_id: `${act}1`, adset_id: `${act}2`, effective_status: 'ACTIVE' },
      { id: `${act}4`, name: 'A2', campaign_id: `${act}1`, adset_id: `${act}2`, effective_status: 'ACTIVE' },
    ],
  })
  fake.setInsights(act, 'campaign', [{ campaign_id: `${act}1`, spend: '40' }])
  fake.setInsights(act, 'adset', [{ adset_id: `${act}2`, spend: '40' }])
  fake.setInsights(act, 'ad', [
    { ad_id: `${act}3`, spend: '40' },
    { ad_id: `${act}4`, spend: '0' },
  ])
  const make = (extra: Partial<ConstructorParameters<typeof MetaBundleService>[0]> = {}) =>
    new MetaBundleService({
      db,
      redis,
      profiles,
      prefix: `crm:meta:test105:${tag}`,
      fx,
      ...(withSales ? { internalSales: new InternalSalesService({ db, fx }) } : {}),
      ...extra,
    })
  return { co, service: make(), make }
}

describe('MetaBundleService com internalSales', () => {
  it('AC-T105-01/02/03: preenche purchases_leona/purchase_value_leona e ROAS por anúncio, conjunto e campanha', async () => {
    const act = 'act_1051'
    const w = await world(act, 'USD', true)
    await insertSales(w.co, [
      { amountCents: 50_000, soldAt: new Date('2026-10-11T02:30:00Z'), sourceId: `${act}3` },
      { amountCents: 10_000, soldAt: new Date('2026-10-10T15:00:00Z'), sourceId: `${act}4` },
      { amountCents: 2_000, soldAt: new Date('2026-10-10T15:00:00Z'), sourceId: `${act}4`, currency: 'EUR' },
      { amountCents: 99_000, soldAt: new Date('2026-10-10T15:00:00Z'), sourceId: null },
    ])
    const b = await w.service.getBundle(w.co, {
      status_filter: 'all',
      display_currency: 'BRL',
      since: '2026-10-10',
      until: '2026-10-10',
    })
    const ad = Object.fromEntries(b.ad.map((r) => [r.id, r.metrics]))
    expect(ad[`${act}3`]).toMatchObject({
      meta_spend: 40,
      meta_spend_display: 200,
      purchases_leona: 1,
      purchase_value_leona: 100,
      purchase_value_leona_display: 500,
      roas_internal: 2.5,
    })
    expect(ad[`${act}4`]).toMatchObject({
      purchases_leona: 2,
      purchase_value_leona: 20,
      purchase_value_leona_display: 100,
      roas_internal: null,
    })
    expect(b.adset[0]!.metrics).toMatchObject({
      purchases_leona: 3,
      purchase_value_leona: 120,
      purchase_value_leona_display: 600,
      roas_internal: 3,
    })
    expect(b.campaign[0]!.metrics).toMatchObject({
      purchases_leona: 3,
      purchase_value_leona_display: 600,
      roas_internal: 3,
    })
    // Sem cotação EUR: fora do valor de exibição e do valor na moeda da conta, com aviso dos dois pares.
    expect(b.warnings).toEqual(['fx_rate_missing:EUR->BRL', 'fx_rate_missing:EUR->USD'])
  })

  it('sem a opção internalSales, as métricas internas continuam null (comportamento da T101)', async () => {
    const act = 'act_1052'
    const w = await world(act, 'BRL', false)
    await insertSales(w.co, [{ amountCents: 50_000, soldAt: new Date('2026-10-10T15:00:00Z'), sourceId: `${act}3` }])
    const b = await w.service.getBundle(w.co, {
      status_filter: 'all',
      display_currency: 'BRL',
      since: '2026-10-10',
      until: '2026-10-10',
    })
    expect(b.ad[0]!.metrics).toMatchObject({ purchases_leona: null, purchase_value_leona: null })
    expect(b.ad[0]!.metrics.roas_internal).toBeUndefined()
    expect(b.warnings).toEqual([])
  })

  it('falha no cruzamento não derruba o bundle: aviso internal_sales_failed', async () => {
    const act = 'act_1053'
    const w = await world(act, 'BRL', false)
    const warn: unknown[] = []
    const svc = w.make({
      internalSales: { apply: async () => Promise.reject(new Error('db fora')) },
      logger: { warn: (o) => void warn.push(o) },
    })
    const b = await svc.getBundle(w.co, {
      status_filter: 'all',
      display_currency: 'BRL',
      since: '2026-10-10',
      until: '2026-10-10',
    })
    expect(b.status).toBe('ready')
    expect(b.warnings).toEqual(['internal_sales_failed'])
    expect(b.ad[0]!.metrics.purchases_leona).toBeNull()
    expect(warn).toHaveLength(1)
  })
})
