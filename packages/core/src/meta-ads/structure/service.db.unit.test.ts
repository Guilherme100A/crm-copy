// Bundle do Gerenciador contra o FakeMetaGraph (AC-T101-01..05): Postgres e Redis reais, perfil conectado pelo
// OAuth da T99, contas incluídas no dashboard.
import { randomBytes } from 'node:crypto'
import { companies, createDb, metaAdAccounts, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { generateCredentialsKey, initCredentialsCrypto, redisConnection } from '@crm/node-kit'
import { eq } from 'drizzle-orm'
import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeMetaGraph } from '../client/testing'
import { MetaProfilesService } from '../profiles/service'
import { MetaRateLimitedError } from './account'
import { fixedFxRates } from './metrics'
import { MetaBundleService, type MetaSyncJobData } from './service'

let tmp: TempDatabase
let db: Database
let redis: Redis
const fake = new FakeMetaGraph({ appId: 'app-101', appSecret: 'secret-101', pageSize: 2 })
const stateKey = randomBytes(32)

beforeAll(async () => {
  initCredentialsCrypto({ key: generateCredentialsKey() })
  await fake.start()
  tmp = await createTempDatabase({ migrate: true })
  db = createDb(tmp.url, { max: 6 })
  redis = redisConnection()
}, 120_000)

afterAll(async () => {
  await fake.close()
  await db?.$client.end()
  await redis?.quit()
  await tmp?.drop()
})

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

/** Empresa com um perfil conectado (OAuth da T99) e as contas dadas incluídas no dashboard. */
async function world(accounts: { id: string; currency: string; name: string }[], opts: { fx?: Record<string, number>; enqueue?: boolean } = {}) {
  const tag = randomBytes(4).toString('hex')
  const [c] = await db.insert(companies).values({ name: `M${tag}`, slug: `m-t101-${tag}`, timeZone: 'America/Sao_Paulo' }).returning()
  const companyId = c!.id
  const fbUser = `fb-${tag}`
  fake.addUser({ id: fbUser, name: 'Ana', adAccounts: accounts.map((a) => ({ id: a.id, name: a.name, currency: a.currency })) })
  const profiles = new MetaProfilesService({ db, config: config(), stateKey })
  // Perfil gravado pelo fluxo de callback da T99 (usuário real em crm.users).
  const userId = await realUser(companyId)
  const started = await profiles.startOAuth({ companyId, userId })
  await profiles.completeOAuth({ companyId, userId, code: fake.issueCode(fbUser, 'http://api.test/cb'), state: started.state })
  await db.update(metaAdAccounts).set({ includedInDashboard: true }).where(eq(metaAdAccounts.companyId, companyId))
  const events: { type: string; data: Record<string, unknown> }[] = []
  const jobs: MetaSyncJobData[] = []
  const service = new MetaBundleService({
    db,
    redis,
    profiles,
    prefix: `crm:meta:test:${tag}`,
    publisher: { publish: async (_c, type, data) => void events.push({ type, data }) },
    fx: fixedFxRates(opts.fx ?? {}),
    ...(opts.enqueue ? { enqueue: async (d: MetaSyncJobData) => void jobs.push(d) } : {}),
  })
  const local = Object.fromEntries((await db.select().from(metaAdAccounts).where(eq(metaAdAccounts.companyId, companyId))).map((a) => [a.fbAccountId, a.id]))
  return { companyId, service, events, jobs, local }
}

async function realUser(companyId: string): Promise<string> {
  const { users } = await import('@crm/db')
  const [u] = await db.insert(users).values({ email: `u-${randomBytes(4).toString('hex')}@x.com`, passwordHash: 'x', name: 'U', lastCompanyId: companyId }).returning()
  return u!.id
}

/** Estrutura padrão: 1 campanha → 1 conjunto → 2 anúncios, com insights nos três níveis. */
function seed(act: string, opts: { spend?: number } = {}) {
  const spend = opts.spend ?? 100
  fake.setStructure(act, {
    campaigns: [{ id: `${act}-c1`, name: 'Campanha 1', effective_status: 'ACTIVE', objective: 'OUTCOME_SALES', daily_budget: '5000' }],
    adsets: [{ id: `${act}-s1`, name: 'Conjunto 1', campaign_id: `${act}-c1`, effective_status: 'ACTIVE', daily_budget: '2500' }],
    ads: [
      { id: `${act}-a1`, name: 'Anúncio 1', campaign_id: `${act}-c1`, adset_id: `${act}-s1`, effective_status: 'ACTIVE' },
      { id: `${act}-a2`, name: 'Anúncio 2', campaign_id: `${act}-c1`, adset_id: `${act}-s1`, effective_status: 'PAUSED' },
    ],
  })
  const actions = [
    { action_type: 'link_click', value: '50' },
    { action_type: 'offsite_conversion.fb_pixel_purchase', value: '2' },
    { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '5' },
  ]
  fake.setInsights(act, 'campaign', [{ campaign_id: `${act}-c1`, spend: String(spend), impressions: '1000', actions: [...actions].reverse(), action_values: [{ action_type: 'offsite_conversion.fb_pixel_purchase', value: '300' }] }])
  fake.setInsights(act, 'adset', [{ adset_id: `${act}-s1`, spend: String(spend), impressions: '1000', actions }])
  fake.setInsights(act, 'ad', [
    { ad_id: `${act}-a1`, spend: String(spend / 2), impressions: '600', actions },
    { ad_id: `${act}-a2`, spend: String(spend / 2), impressions: '400', actions: [] },
  ])
  fake.setInsights(act, 'account', [{ spend: String(spend) }])
}

describe('MetaBundleService', () => {
  it('AC-T101-01/05: junta estrutura e insights, mapeia actions[] e calcula _display na moeda de exibição', async () => {
    seed('act_101')
    const w = await world([{ id: 'act_101', currency: 'USD', name: 'Loja US' }], { fx: { 'USD:BRL': 5 } })
    const b = await w.service.getBundle(w.companyId, { status_filter: 'all', display_currency: 'BRL' })
    expect(b).toMatchObject({ status: 'ready', targets_done: 1, targets_total: 1, errors: [], display_currency: 'BRL', cached: false })
    expect(b.campaign).toHaveLength(1)
    expect(b.adset).toHaveLength(1)
    expect(b.ad.map((a) => [a.id, a.status])).toEqual([
      ['act_101-a1', 'ACTIVE'],
      ['act_101-a2', 'PAUSED'],
    ])
    expect(b.campaign[0]).toMatchObject({
      id: 'act_101-c1',
      fb_ad_account_id: 'act_101',
      ad_account_id: w.local.act_101,
      ad_account_label: 'Loja US',
      currency: 'USD',
      objective: 'OUTCOME_SALES',
      daily_budget: 50,
      daily_budget_display: 250,
      metrics: {
        meta_spend: 100,
        meta_spend_display: 500,
        purchases_pixel: 2,
        purchase_value_meta: 300,
        purchase_value_meta_display: 1500,
        conversations_meta: 5,
        meta_link_clicks: 50,
        cost_per_purchase_meta: 50,
        cost_per_lead_meta: 20,
      },
    })
    expect(b.ad[0]).toMatchObject({ campaign_name: 'Campanha 1', adset_name: 'Conjunto 1' })
    // Escopo active: o anúncio pausado sai.
    const active = await w.service.getBundle(w.companyId, { status_filter: 'active', display_currency: 'BRL', force_refresh: true })
    expect(active.ad.map((a) => a.id)).toEqual(['act_101-a1'])
    // Sem cotação: _display nulo e aviso.
    const eur = await w.service.getBundle(w.companyId, { status_filter: 'all', display_currency: 'EUR' })
    expect(eur.campaign[0]!.metrics.meta_spend_display).toBeNull()
    expect(eur.warnings).toContain('fx_rate_missing:USD->EUR')
  })

  it('AC-T101-02: com 2 contas e 1 falhando, o bundle fica ready com errors[] e a outra conta preenchida', async () => {
    seed('act_201')
    seed('act_202')
    fake.failAccount('act_202', 400, { message: 'Permissions error', type: 'OAuthException', code: 200 })
    const w = await world([
      { id: 'act_201', currency: 'BRL', name: 'Boa' },
      { id: 'act_202', currency: 'BRL', name: 'Ruim' },
    ])
    const b = await w.service.getBundle(w.companyId, { status_filter: 'all' })
    expect(b.status).toBe('ready')
    expect(b.targets_done).toBe(2)
    expect(b.errors).toEqual([expect.objectContaining({ ad_account_id: w.local.act_202, fb_ad_account_id: 'act_202', error: 'Permissions error' })])
    expect(b.campaign.map((c) => c.fb_ad_account_id)).toEqual(['act_201'])
    fake.clearAccountFailure('act_202')
  })

  it('AC-T101-04: a 2ª chamada idêntica em 5 min não chama a Meta; force_refresh chama', async () => {
    seed('act_401')
    const w = await world([{ id: 'act_401', currency: 'BRL', name: 'Cache' }])
    const calls = () => fake.requests.filter((r) => r.endpoint.startsWith('/act_401/')).length
    await w.service.getBundle(w.companyId, { status_filter: 'all' })
    const after1 = calls()
    expect(after1).toBeGreaterThan(0)
    const again = await w.service.getBundle(w.companyId, { status_filter: 'all', level: 'ad' })
    expect(again.cached).toBe(true)
    expect(calls()).toBe(after1)
    await w.service.getBundle(w.companyId, { status_filter: 'all', force_refresh: true })
    expect(calls()).toBeGreaterThan(after1)
  })

  it('AC-T101-03: uso > 75% ou erro 17/80004 adia o job (MetaRateLimitedError) e devolve o último bundle com aviso', async () => {
    seed('act_301')
    const w = await world([{ id: 'act_301', currency: 'BRL', name: 'Limite' }], { enqueue: true })
    const first = await w.service.getBundle(w.companyId, { status_filter: 'all' })
    expect(first.status).toBe('ready')

    // Uso de 90%: o job lança MetaRateLimitedError (o worker adia) e a conta fica em espera.
    fake.setUsage('act_301', 90, 2)
    const job = { companyId: w.companyId, bundleKey: first.bundle_key, params: (await paramsOf(w, first)) as never, accountIds: [w.local.act_301!], force: true }
    const err = await w.service.runJob(job).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MetaRateLimitedError)
    expect((err as MetaRateLimitedError).retryAt).toBeGreaterThan(Date.now() + 60_000)
    fake.setUsage('act_301', null)

    // Com a conta em espera, o GET devolve o último pronto (do cache) com aviso, sem chamar a Meta.
    const before = fake.requests.length
    const fallback = await w.service.getBundle(w.companyId, { status_filter: 'all', force_refresh: true, async: true })
    expect(fallback).toMatchObject({ status: 'ready', cached: true, warnings: expect.arrayContaining(['rate_limited']) })
    expect(fallback.campaign).toHaveLength(1)
    expect(fake.requests.length).toBe(before)
    expect(w.jobs).toHaveLength(1)

    // Erro 80004 numa conta sem espera: o mesmo adiamento.
    seed('act_302')
    const w2 = await world([{ id: 'act_302', currency: 'BRL', name: 'Erro' }])
    fake.failAccount('act_302', 400, { message: 'There have been too many calls', type: 'OAuthException', code: 80004 })
    const r = await w2.service.getBundle(w2.companyId, { status_filter: 'all' })
    expect(r.warnings).toContain('rate_limited')
    fake.clearAccountFailure('act_302')
  })

  it('AC-T101-05: async publica loading → partial (targets_done crescente) → ready, na ordem', async () => {
    seed('act_501')
    seed('act_502')
    seed('act_503')
    const w = await world(
      [
        { id: 'act_501', currency: 'BRL', name: 'A' },
        { id: 'act_502', currency: 'BRL', name: 'B' },
        { id: 'act_503', currency: 'BRL', name: 'C' },
      ],
      { enqueue: true },
    )
    const queued = await w.service.getBundle(w.companyId, { status_filter: 'all', async: true })
    expect(queued).toMatchObject({ status: 'loading', targets_done: 0, targets_total: 3 })
    expect(w.jobs).toHaveLength(1)
    // Lendo de novo enquanto o job não rodou: o estado em andamento (sem novo job).
    expect((await w.service.getBundle(w.companyId, { status_filter: 'all', async: true })).status).toBe('loading')
    expect(w.jobs).toHaveLength(1)
    const done = await w.service.runJob(w.jobs[0]!)
    expect(done.status).toBe('ready')
    const progress = w.events.filter((e) => e.type === 'meta.bundle.progress').map((e) => [e.data.status, e.data.targets_done])
    expect(progress).toEqual([
      ['loading', 0],
      ['partial', 1],
      ['partial', 2],
      ['ready', 3],
    ])
    const cached = await w.service.getBundle(w.companyId, { status_filter: 'all', async: true })
    expect(cached).toMatchObject({ status: 'ready', cached: true })
    // force_refresh com async: estado `refreshing`.
    expect((await w.service.getBundle(w.companyId, { status_filter: 'all', async: true, force_refresh: true })).status).toBe('refreshing')
  })

  it('metaSpend: soma o gasto das contas incluídas na moeda de exibição (cache 5 min)', async () => {
    seed('act_601', { spend: 40 })
    seed('act_602', { spend: 10 })
    const w = await world(
      [
        { id: 'act_601', currency: 'BRL', name: 'BR' },
        { id: 'act_602', currency: 'USD', name: 'US' },
      ],
      { fx: { 'USD:BRL': 5 } },
    )
    const spend = await w.service.metaSpend(w.companyId, { since: '2026-10-01', until: '2026-10-15' })
    expect(spend).toMatchObject({ total: 90, display_currency: 'BRL', errors: [] })
    expect(spend.by_account.map((a) => [a.fb_ad_account_id, a.spend, a.spend_display]).sort()).toEqual([
      ['act_601', 40, 40],
      ['act_602', 10, 50],
    ])
  })
})

async function paramsOf(w: { companyId: string }, b: { since: string; until: string; status_filter: string; display_currency: string }) {
  void w
  return { level: 'campaign', statusFilter: b.status_filter, datePreset: 'custom', since: b.since, until: b.until, adAccountIds: [], displayCurrency: b.display_currency }
}
