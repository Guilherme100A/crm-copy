// AC-T103-01..04: edição de status, nome e orçamento na Meta pela API (FakeMetaGraph, nunca a Meta real).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bundleUrl, callsTo, connect, memberOf, mutationsOf, owner, patchEntity, seedAccount, startEnv, type Account, type Env, type User } from './setup'

let env: Env

beforeAll(async () => {
  env = await startEnv()
}, 120_000)

afterAll(async () => {
  await env?.close()
})

async function scenario(): Promise<{ o: User; acc: Account; ids: { campaign: string; adset: string; ad: string } }> {
  const o = await owner(env)
  const [acc] = await connect(env, o, [{ suffix: `m${Math.random().toString(36).slice(2, 6)}` }])
  const ids = seedAccount(env, acc!)
  return { o, acc: acc!, ids }
}

const expectFields = (r: any, path: string) => {
  expect(r.status, r.text).toBe(422)
  expect(r.body.error.code).toBe('VALIDATION_ERROR')
  const paths = (r.body.error.details?.fields ?? []).map((f: any) => (Array.isArray(f.path) ? f.path.join('.') : String(f.path)))
  expect(paths, JSON.stringify(r.body.error)).toContain(path)
}

describe('T103 — status (AC-T103-01)', () => {
  it('AC-T103-01 alternar status envia status=PAUSED e depois ACTIVE ao fake', async () => {
    const { o, acc, ids } = await scenario()
    const p = await patchEntity(o, ids.campaign, { level: 'campaign', fb_ad_account_id: acc.fb, status: 'PAUSED' })
    expect(p.status, p.text).toBe(200)
    expect(p.body.success).toBe(true)
    const a = await patchEntity(o, ids.campaign, { level: 'campaign', fb_ad_account_id: acc.fb, status: 'active' })
    expect(a.status, a.text).toBe(200)
    const sent = mutationsOf(env, ids.campaign).map((m: any) => m.fields.status)
    expect(sent).toEqual(['PAUSED', 'ACTIVE'])
    // no fio: POST /<id> com status e appsecret_proof
    const posts = env.fake.requests.filter((r: any) => r.method === 'POST' && String(r.endpoint) === `/${ids.campaign}`)
    expect(posts.map((r: any) => r.body?.status)).toEqual(['PAUSED', 'ACTIVE'])
    for (const r of posts) expect(r.query?.appsecret_proof ?? r.body?.appsecret_proof).toBeTruthy()
  })

  it('AC-T103-01 a edição invalida o cache do bundle da empresa (próxima leitura vai à Meta e mostra o valor novo)', async () => {
    const { o, acc, ids } = await scenario()
    const url = bundleUrl([acc])
    await o.c.get(url)
    const cached = await o.c.get(url)
    expect(cached.body.cached).toBe(true)
    const before = callsTo(env, acc)
    expect((await patchEntity(o, ids.campaign, { level: 'campaign', fb_ad_account_id: acc.fb, status: 'PAUSED' })).status).toBe(200)
    const after = await o.c.get(url)
    expect(after.status).toBe(200)
    expect(after.body.cached).not.toBe(true)
    expect(callsTo(env, acc), 'a leitura depois da edição não foi à Meta').toBeGreaterThan(before + 1)
    expect(after.body.campaign.find((c: any) => c.id === ids.campaign).status).toBe('PAUSED')
  })

  it('AC-T103-01 a invalidação vale para outros filtros da mesma empresa, e não para outra empresa', async () => {
    const { o, acc, ids } = await scenario()
    const other = await scenario()
    const url7 = bundleUrl([acc], { date_preset: '7d' })
    const url30 = bundleUrl([acc], { date_preset: '30d' })
    const otherUrl = bundleUrl([other.acc])
    await o.c.get(url7)
    await o.c.get(url30)
    await other.o.c.get(otherUrl)
    expect((await patchEntity(o, ids.adset, { level: 'adset', fb_ad_account_id: acc.fb, status: 'PAUSED' })).status).toBe(200)
    expect((await o.c.get(url30)).body.cached).not.toBe(true)
    expect((await other.o.c.get(otherUrl)).body.cached).toBe(true)
  })

  it('AC-T103-01 edição que falha não invalida o cache', async () => {
    const { o, acc, ids } = await scenario()
    const url = bundleUrl([acc])
    await o.c.get(url)
    env.fake.failNext(400, { message: 'Invalid parameter', type: 'OAuthException', code: 100 })
    expect((await patchEntity(o, ids.campaign, { level: 'campaign', fb_ad_account_id: acc.fb, status: 'PAUSED' })).status).toBe(502)
    expect((await o.c.get(url)).body.cached).toBe(true)
  })
})

describe('T103 — orçamento (AC-T103-02)', () => {
  it('AC-T103-02 orçamento "12,50" vira 1250 centavos', async () => {
    const { o, acc, ids } = await scenario()
    const r = await patchEntity(o, ids.campaign, { level: 'campaign', fb_ad_account_id: acc.fb, daily_budget: '12,50' })
    expect(r.status, r.text).toBe(200)
    const [m] = mutationsOf(env, ids.campaign)
    expect(m.fields.daily_budget).toBe('1250')
    expect(Number(r.body.entity.daily_budget)).toBe(12.5)
  })

  it('AC-T103-02 também aceita número e ponto decimal (12.5 → 1250, "1.234,56" → 123456)', async () => {
    const { o, acc, ids } = await scenario()
    expect((await patchEntity(o, ids.adset, { level: 'adset', fb_ad_account_id: acc.fb, lifetime_budget: 12.5 })).status).toBe(200)
    expect((await patchEntity(o, ids.adset, { level: 'adset', fb_ad_account_id: acc.fb, lifetime_budget: '1.234,56' })).status).toBe(200)
    expect(mutationsOf(env, ids.adset).map((m: any) => m.fields.lifetime_budget)).toEqual(['1250', '123456'])
  })

  it('AC-T103-02 campo vazio não é enviado (só o preenchido vai à Meta)', async () => {
    const { o, acc, ids } = await scenario()
    const r = await patchEntity(o, ids.campaign, { level: 'campaign', fb_ad_account_id: acc.fb, daily_budget: '20,00', lifetime_budget: '' })
    expect(r.status, r.text).toBe(200)
    const [m] = mutationsOf(env, ids.campaign)
    expect(m.fields).toEqual({ daily_budget: '2000' })
    const post = env.fake.requests.filter((x: any) => x.method === 'POST' && String(x.endpoint) === `/${ids.campaign}`).at(-1)
    expect(post.body).not.toHaveProperty('lifetime_budget')
  })

  it('AC-T103-02 nada para enviar (orçamento vazio e nome em branco) → 422, sem chamar a Meta', async () => {
    const { o, acc, ids } = await scenario()
    const before = mutationsOf(env, ids.campaign).length
    const r = await patchEntity(o, ids.campaign, { level: 'campaign', fb_ad_account_id: acc.fb, daily_budget: '', name: '   ' })
    expect(r.status).toBe(422)
    expect(mutationsOf(env, ids.campaign)).toHaveLength(before)
  })

  it('AC-T103-02 orçamento negativo ou inválido → 422 no próprio campo', async () => {
    const { o, acc, ids } = await scenario()
    expectFields(await patchEntity(o, ids.campaign, { level: 'campaign', fb_ad_account_id: acc.fb, daily_budget: '-1' }), 'daily_budget')
    expectFields(await patchEntity(o, ids.campaign, { level: 'campaign', fb_ad_account_id: acc.fb, lifetime_budget: 'abc' }), 'lifetime_budget')
  })
})

describe('T103 — validação (AC-T103-03)', () => {
  it('AC-T103-03 name com level=ad → 422 (path name), sem chamar a Meta', async () => {
    const { o, acc, ids } = await scenario()
    const before = env.fake.requests.length
    expectFields(await patchEntity(o, ids.ad, { level: 'ad', fb_ad_account_id: acc.fb, name: 'Novo nome' }), 'name')
    expect(env.fake.requests.slice(before).filter((r: any) => r.method === 'POST')).toHaveLength(0)
  })

  it('AC-T103-03 sem fb_ad_account_id → 422 (path fb_ad_account_id)', async () => {
    const { o, ids } = await scenario()
    expectFields(await patchEntity(o, ids.campaign, { level: 'campaign', status: 'PAUSED' }), 'fb_ad_account_id')
  })

  it('AC-T103-03 nome em campanha e conjunto vai com trim', async () => {
    const { o, acc, ids } = await scenario()
    expect((await patchEntity(o, ids.campaign, { level: 'campaign', fb_ad_account_id: acc.fb, name: '  Campanha nova  ' })).status).toBe(200)
    expect(mutationsOf(env, ids.campaign)[0].fields.name).toBe('Campanha nova')
  })

  it('AC-T103-03 conta de anúncio de outra empresa → 404', async () => {
    const { o } = await scenario()
    const other = await scenario()
    const r = await patchEntity(o, other.ids.campaign, { level: 'campaign', fb_ad_account_id: other.acc.fb, status: 'PAUSED' })
    expect(r.status).toBe(404)
    expect(mutationsOf(env, other.ids.campaign)).toHaveLength(0)
  })
})

describe('T103 — erros da Meta e permissão (AC-T103-04)', () => {
  it('AC-T103-04 erro da Meta → 502 UPSTREAM_ERROR "Não foi possível atualizar na Meta"', async () => {
    const { o, acc, ids } = await scenario()
    env.fake.failNext(400, { message: 'Invalid parameter', type: 'OAuthException', code: 100 })
    const r = await patchEntity(o, ids.campaign, { level: 'campaign', fb_ad_account_id: acc.fb, status: 'PAUSED' })
    expect(r.status, r.text).toBe(502)
    expect(r.body.error.code).toBe('UPSTREAM_ERROR')
    expect(r.body.error.message).toContain('Não foi possível atualizar na Meta')
    expect(r.text).not.toMatch(/EAAB|access_token/)
  })

  it('AC-T103-04 entidade desconhecida da Meta também vira 502 UPSTREAM_ERROR', async () => {
    const { o, acc } = await scenario()
    const r = await patchEntity(o, 'cmp_que_nao_existe', { level: 'campaign', fb_ad_account_id: acc.fb, status: 'PAUSED' })
    expect(r.status).toBe(502)
    expect(r.body.error.code).toBe('UPSTREAM_ERROR')
  })

  it('AC-T103-04 sem facebook.campaigns → 403 e nada é enviado', async () => {
    const { o, acc, ids } = await scenario()
    const m = await memberOf(env, o.companyId, ['facebook.profiles'])
    const r = await patchEntity(m, ids.campaign, { level: 'campaign', fb_ad_account_id: acc.fb, status: 'PAUSED' })
    expect(r.status).toBe(403)
    expect(r.body.error.code).toBe('FORBIDDEN')
    expect(mutationsOf(env, ids.campaign)).toHaveLength(0)
    const ok = await memberOf(env, o.companyId, ['facebook.campaigns'])
    expect((await patchEntity(ok, ids.campaign, { level: 'campaign', fb_ad_account_id: acc.fb, status: 'PAUSED' })).status).toBe(200)
  })
})
