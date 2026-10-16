// AC-T101-01..05: bundle de estrutura + insights pela API, com o FakeMetaGraph.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectSse } from '../helpers/sse'
import { bundleUrl, callsTo, connect, owner, seedAccount, startEnv, startMetaWorker, type Env } from './setup'

let env: Env

beforeAll(async () => {
  env = await startEnv()
}, 120_000)

afterAll(async () => {
  await env?.close()
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('T101 — estrutura + insights (AC-T101-01)', () => {
  it('AC-T101-01 o bundle junta estrutura e insights e mapeia actions[] por action_type (array embaralhado)', async () => {
    const o = await owner(env)
    const [acc] = await connect(env, o, [{ suffix: 'a', currency: 'BRL' }])
    const ids = seedAccount(env, acc!, {
      spend: '100.00',
      // embaralhado e com vários tipos de compra: vale o primeiro presente na precedência omni_purchase > purchase > pixel
      actions: [
        { action_type: 'link_click', value: '30' },
        { action_type: 'offsite_conversion.fb_pixel_purchase', value: '3' },
        { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '4' },
        { action_type: 'purchase', value: '2' },
        { action_type: 'omni_purchase', value: '5' },
        { action_type: 'video_view', value: '999' },
      ],
      values: [
        { action_type: 'purchase', value: '200.00' },
        { action_type: 'omni_purchase', value: '500.00' },
      ],
    })
    const r = await o.c.get(bundleUrl([acc!]))
    expect(r.status, r.text).toBe(200)
    expect(r.body.status).toBe('ready')
    for (const k of ['campaign', 'adset', 'ad']) expect(Array.isArray(r.body[k]), k).toBe(true)

    const cmp = r.body.campaign.find((x: any) => x.id === ids.campaign)
    expect(cmp, JSON.stringify(r.body.campaign)).toBeDefined()
    expect(cmp.name).toBe(`Campanha ${acc!.fb.slice(-6)}`)
    expect(cmp.status).toBe('ACTIVE')
    expect(cmp.fb_ad_account_id).toBe(acc!.fb)
    const m = cmp.metrics
    expect(Number(m.meta_spend)).toBe(100)
    expect(Number(m.purchases_pixel)).toBe(5)
    expect(Number(m.purchase_value_meta)).toBe(500)
    expect(Number(m.conversations_meta)).toBe(4)
    expect(Number(m.meta_link_clicks)).toBe(30)
    expect(Number(m.meta_impressions)).toBe(1000)
    expect(Number(m.cost_per_purchase_meta)).toBe(20)
    expect(Number(m.cost_per_lead_meta)).toBe(25)

    const set = r.body.adset.find((x: any) => x.id === ids.adset)
    const ad = r.body.ad.find((x: any) => x.id === ids.ad)
    expect(set?.campaign_name).toBe(`Campanha ${acc!.fb.slice(-6)}`)
    expect(ad?.adset_name).toBe(`Conjunto ${acc!.fb.slice(-6)}`)
    expect(Number(ad.metrics.purchases_pixel)).toBe(5)
  })
})

describe('T101 — conta com falha (AC-T101-02)', () => {
  it('AC-T101-02 com 2 contas e 1 falhando, o status final é ready com errors[] e a outra conta preenchida', async () => {
    const o = await owner(env)
    const [ok, bad] = await connect(env, o, [{ suffix: 'ok' }, { suffix: 'zz' }])
    const okIds = seedAccount(env, ok!)
    seedAccount(env, bad!)
    env.fake.failAccount(bad!.fb, 500, { message: 'Erro interno da conta', type: 'OAuthException', code: 2 })
    try {
      const r = await o.c.get(bundleUrl([ok!, bad!]))
      expect(r.status, r.text).toBe(200)
      expect(r.body.status).toBe('ready')
      expect(r.body.errors).toHaveLength(1)
      expect(r.body.errors[0].ad_account_id).toBe(bad!.localId)
      expect(String(r.body.errors[0].error).length).toBeGreaterThan(0)
      expect(r.body.campaign.map((x: any) => x.id)).toContain(okIds.campaign)
      expect(r.body.campaign.every((x: any) => x.fb_ad_account_id === ok!.fb)).toBe(true)
    } finally {
      env.fake.clearAccountFailure?.(bad!.fb)
    }
  })
})

describe('T101 — limite da Meta (AC-T101-03)', () => {
  it('AC-T101-03 uso BUC acima de 75% devolve o último bundle em cache com aviso (não é falha)', async () => {
    const o = await owner(env)
    const [acc] = await connect(env, o, [{ suffix: 'buc' }])
    const ids = seedAccount(env, acc!)
    const first = await o.c.get(bundleUrl([acc!]))
    expect(first.body.status).toBe('ready')
    env.fake.setUsage(acc!.fb, 90, 10)
    try {
      const r = await o.c.get(bundleUrl([acc!], { force_refresh: '1' }))
      expect(r.status, r.text).toBeLessThan(300)
      expect(r.body.cached).toBe(true)
      expect(r.body.warnings).toContain('rate_limited')
      expect(r.body.campaign.map((x: any) => x.id)).toContain(ids.campaign)
      expect(r.body.errors ?? []).toEqual([])
    } finally {
      env.fake.setUsage(acc!.fb, null)
    }
  })

  it('AC-T101-03 erro 17 (limite) da Meta também devolve o cache com aviso', async () => {
    const o = await owner(env)
    const [acc] = await connect(env, o, [{ suffix: 'e17' }])
    const ids = seedAccount(env, acc!)
    expect((await o.c.get(bundleUrl([acc!]))).body.status).toBe('ready')
    env.fake.failAccount(acc!.fb, 400, { message: 'User request limit reached', type: 'OAuthException', code: 17 })
    try {
      const r = await o.c.get(bundleUrl([acc!], { force_refresh: '1' }))
      expect(r.body.cached, JSON.stringify({ status: r.body.status, cached: r.body.cached, warnings: r.body.warnings, errors: r.body.errors })).toBe(true)
      expect(r.body.warnings).toContain('rate_limited')
      expect(r.body.campaign.map((x: any) => x.id)).toContain(ids.campaign)
    } finally {
      env.fake.clearAccountFailure?.(acc!.fb)
    }
  })

  it('AC-T101-03 no job assíncrono, o limite ADIA o job (fica delayed, não failed)', async () => {
    const o = await owner(env)
    const [acc] = await connect(env, o, [{ suffix: 'job' }])
    seedAccount(env, acc!)
    const worker = await startMetaWorker(env)
    const core: any = await import('@crm/core')
    const { bullConnection }: any = await import('@crm/node-kit')
    const queue = core.defineQueue('meta-sync', { connection: bullConnection() })
    env.fake.failAccount(acc!.fb, 400, { message: 'Application request limit reached', type: 'OAuthException', code: 80004 })
    try {
      const r = await o.c.get(bundleUrl([acc!], { async: '1' }))
      expect(r.status, r.text).toBe(202)
      let counts: any = {}
      for (let i = 0; i < 100; i++) {
        counts = await queue.getJobCounts('delayed', 'failed', 'completed', 'active', 'waiting')
        if (counts.delayed > 0 || counts.failed > 0) break
        await sleep(100)
      }
      expect(counts.failed, JSON.stringify(counts)).toBe(0)
      expect(counts.delayed, JSON.stringify(counts)).toBeGreaterThan(0)
    } finally {
      env.fake.clearAccountFailure?.(acc!.fb)
      await queue.obliterate?.({ force: true }).catch(() => {})
      await queue.close().catch(() => {})
      await worker.stop()
    }
  })
})

describe('T101 — cache de 5 minutos (AC-T101-04)', () => {
  it('AC-T101-04 a segunda chamada idêntica não chama o fake; force_refresh=1 chama', async () => {
    const o = await owner(env)
    const [acc] = await connect(env, o, [{ suffix: 'cache' }])
    seedAccount(env, acc!)
    const c0 = callsTo(env, acc!)
    const first = await o.c.get(bundleUrl([acc!]))
    expect(first.body.status).toBe('ready')
    const c1 = callsTo(env, acc!)
    expect(c1).toBeGreaterThan(c0)

    const second = await o.c.get(bundleUrl([acc!]))
    expect(second.status).toBe(200)
    expect(callsTo(env, acc!), 'segunda chamada idêntica foi à Meta').toBe(c1)
    expect(second.body.cached).toBe(true)
    expect(second.body.campaign).toEqual(first.body.campaign)

    const forced = await o.c.get(bundleUrl([acc!], { force_refresh: '1' }))
    expect(forced.status).toBe(200)
    expect(callsTo(env, acc!)).toBeGreaterThan(c1)
  })

  it('AC-T101-04 parâmetros diferentes (período) não reaproveitam o cache', async () => {
    const o = await owner(env)
    const [acc] = await connect(env, o, [{ suffix: 'per' }])
    seedAccount(env, acc!)
    await o.c.get(bundleUrl([acc!], { date_preset: '7d' }))
    const c1 = callsTo(env, acc!)
    await o.c.get(bundleUrl([acc!], { date_preset: '30d' }))
    expect(callsTo(env, acc!)).toBeGreaterThan(c1)
  })
})

describe('T101 — progresso por SSE e moeda de exibição (AC-T101-05)', () => {
  it('AC-T101-05 o SSE publica loading → partial (targets_done crescente) → ready, na ordem', async () => {
    const o = await owner(env)
    const accs = await connect(env, o, [{ suffix: 's1' }, { suffix: 's2' }, { suffix: 's3' }])
    for (const a of accs) seedAccount(env, a)
    const worker = await startMetaWorker(env)
    const sse = await connectSse((p, i) => env.app.request(p, i), `/api/events?company_id=${o.companyId}`, { cookie: `crm_session=${o.token}` })
    try {
      const r = await o.c.get(bundleUrl(accs, { async: '1' }))
      expect(r.status, r.text).toBe(202)
      const key = r.body.bundle_key
      await sse.waitFor((m) => m.event === 'meta.bundle.progress' && JSON.parse(m.data).data?.status === 'ready' && JSON.parse(m.data).data?.bundle_key === key, 30_000)
      const evs = sse
        .events('meta.bundle.progress')
        .map((m) => JSON.parse(m.data).data)
        .filter((d: any) => d.bundle_key === key)
      const statuses = evs.map((d: any) => d.status)
      expect(statuses[0]).toBe('loading')
      expect(statuses.at(-1)).toBe('ready')
      const partial = evs.filter((d: any) => d.status === 'partial')
      expect(partial.length, JSON.stringify(statuses)).toBeGreaterThanOrEqual(1)
      const done = evs.map((d: any) => Number(d.targets_done))
      for (let i = 1; i < done.length; i++) expect(done[i]).toBeGreaterThanOrEqual(done[i - 1]!)
      for (let i = 1; i < partial.length; i++) expect(Number(partial[i].targets_done)).toBeGreaterThan(Number(partial[i - 1].targets_done))
      expect(Number(evs.at(-1).targets_done)).toBe(3)
      // a ordem nunca volta: nada de loading depois de partial, nem partial depois de ready
      const firstPartial = statuses.indexOf('partial')
      expect(statuses.lastIndexOf('loading')).toBeLessThan(firstPartial)
      expect(statuses.indexOf('ready')).toBe(statuses.length - 1)
      // relendo a mesma URL, vem pronto do cache
      const after = await o.c.get(bundleUrl(accs, { async: '1' }))
      expect(after.status).toBe(200)
      expect(after.body.status).toBe('ready')
      expect(after.body.campaign).toHaveLength(3)
    } finally {
      await sse.close()
      await worker.stop()
    }
  })

  it('AC-T101-05 moeda de exibição diferente da conta gera campos _display convertidos', async () => {
    const o = await owner(env)
    const [acc] = await connect(env, o, [{ suffix: 'usd', currency: 'USD' }])
    const ids = seedAccount(env, acc!, { spend: '100.00', budgetCents: '5000', actions: [{ action_type: 'purchase', value: '4' }], values: [{ action_type: 'purchase', value: '300.00' }] })
    const r = await o.c.get(bundleUrl([acc!], { display_currency: 'BRL' }))
    expect(r.status, r.text).toBe(200)
    expect(r.body.display_currency).toBe('BRL')
    const cmp = r.body.campaign.find((x: any) => x.id === ids.campaign)
    expect(cmp.currency).toBe('USD')
    expect(Number(cmp.daily_budget)).toBe(50)
    expect(Number(cmp.daily_budget_display)).toBe(250)
    expect(Number(cmp.metrics.meta_spend)).toBe(100)
    expect(Number(cmp.metrics.meta_spend_display)).toBe(500)
    expect(Number(cmp.metrics.purchase_value_meta_display)).toBe(1500)
    expect(Number(cmp.metrics.cost_per_purchase_meta_display)).toBe(125)

    // mesma moeda da conta: _display igual ao valor original
    const same = await o.c.get(bundleUrl([acc!], { display_currency: 'USD' }))
    const c2 = same.body.campaign.find((x: any) => x.id === ids.campaign)
    expect(Number(c2.metrics.meta_spend_display)).toBe(100)
  })
})
