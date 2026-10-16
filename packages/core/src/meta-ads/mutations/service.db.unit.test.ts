// Edição na Meta contra o FakeMetaGraph (AC-T103-01..04): status/nome/orçamento com appsecret_proof, invalidação do
// cache dos bundles da empresa, validação, erro da Meta e limite de uso. Postgres e Redis reais.
import { randomBytes } from 'node:crypto'
import { companies, createDb, metaAdAccounts, users, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { generateCredentialsKey, initCredentialsCrypto, redisConnection } from '@crm/node-kit'
import { eq } from 'drizzle-orm'
import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { appsecretProof } from '../client/graph'
import { FakeMetaGraph } from '../client/testing'
import { MetaProfilesService } from '../profiles/service'
import { fixedFxRates } from '../structure/metrics'
import { MetaBundleService } from '../structure/service'
import { budgetToCents, MetaMutationsService, META_UPDATE_FAILED_MESSAGE } from './service'

let tmp: TempDatabase
let db: Database
let redis: Redis
const fake = new FakeMetaGraph({ appId: 'app-103', appSecret: 'secret-103' })
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
})

const config = () => ({ appId: fake.appId, appSecret: fake.appSecret, graphUrl: fake.url, version: 'v26.0', dialogUrl: 'https://www.facebook.com', redirectUri: 'http://api.test/cb', webUrl: 'http://web.test', scopes: ['ads_read'] })

async function world() {
  const tag = randomBytes(4).toString('hex')
  const act = `act_103${parseInt(tag, 16) % 1_000_000}`
  fake.setStructure(act, {
    campaigns: [{ id: `${act}-c1`, name: 'Campanha 1', effective_status: 'ACTIVE', daily_budget: '5000' }],
    adsets: [{ id: `${act}-s1`, name: 'Conjunto 1', campaign_id: `${act}-c1`, effective_status: 'ACTIVE', daily_budget: '2500' }],
    ads: [{ id: `${act}-a1`, name: 'Anúncio 1', campaign_id: `${act}-c1`, adset_id: `${act}-s1`, effective_status: 'ACTIVE' }],
  })
  const [c] = await db.insert(companies).values({ name: `M${tag}`, slug: `m-t103-${tag}` }).returning()
  const companyId = c!.id
  const fbUser = `fb-${tag}`
  fake.addUser({ id: fbUser, name: 'Ana', adAccounts: [{ id: act, name: 'Conta', currency: 'BRL' }] })
  const profiles = new MetaProfilesService({ db, config: config(), stateKey })
  const [u] = await db.insert(users).values({ email: `u-${tag}@x.com`, passwordHash: 'x', name: 'U', lastCompanyId: companyId }).returning()
  const started = await profiles.startOAuth({ companyId, userId: u!.id })
  await profiles.completeOAuth({ companyId, userId: u!.id, code: fake.issueCode(fbUser, 'http://api.test/cb'), state: started.state })
  await db.update(metaAdAccounts).set({ includedInDashboard: true }).where(eq(metaAdAccounts.companyId, companyId))
  const prefix = `crm:meta:test103:${tag}`
  const bundles = new MetaBundleService({ db, redis, profiles, prefix, fx: fixedFxRates({}) })
  const svc = new MetaMutationsService({ db, redis, profiles, bundles, prefix })
  return { act, companyId, bundles, svc }
}

describe('budgetToCents (AC-T103-02)', () => {
  it('converte texto e número; vazio não envia; inválido é NaN', () => {
    expect(budgetToCents('12,50')).toBe(1250)
    expect(budgetToCents('12.5')).toBe(1250)
    expect(budgetToCents(12.5)).toBe(1250)
    expect(budgetToCents('1.234,56')).toBe(123456)
    expect(budgetToCents('1,234.56')).toBe(123456)
    expect(budgetToCents('1.000')).toBe(100000)
    expect(budgetToCents('0')).toBe(0)
    expect(budgetToCents('')).toBeNull()
    expect(budgetToCents('  ')).toBeNull()
    expect(budgetToCents(null)).toBeNull()
    expect(budgetToCents('-5')).toBeNaN()
    expect(budgetToCents('abc')).toBeNaN()
    expect(budgetToCents(-1)).toBeNaN()
  })
})

describe('MetaMutationsService', () => {
  it('AC-T103-01: status vai como PAUSED com appsecret_proof e invalida o cache dos bundles da empresa (qualquer filtro)', async () => {
    const w = await world()
    const a = await w.bundles.getBundle(w.companyId, { status_filter: 'all' })
    const b = await w.bundles.getBundle(w.companyId, { status_filter: 'active' })
    expect(a.cached).toBe(false)
    expect((await w.bundles.getBundle(w.companyId, { status_filter: 'all' })).cached).toBe(true)

    const res = await w.svc.update(w.companyId, `${w.act}-c1`, { level: 'campaign', fb_ad_account_id: w.act, status: 'paused' })
    expect(res).toMatchObject({ success: true, entity: { id: `${w.act}-c1`, level: 'campaign', status: 'PAUSED', fb_ad_account_id: w.act } })
    const req = fake.requests.filter((r) => r.endpoint === `/${w.act}-c1` && r.method === 'POST').at(-1)!
    expect(req.version).toBe('v26.0')
    expect(req.body.status).toBe('PAUSED')
    expect(req.body.appsecret_proof).toBe(appsecretProof(req.body.access_token!, fake.appSecret))
    expect(fake.mutations.at(-1)).toEqual({ entityId: `${w.act}-c1`, account: w.act, level: 'campaign', fields: { status: 'PAUSED' } })

    const after = await w.bundles.getBundle(w.companyId, { status_filter: 'all' })
    expect(after.cached).toBe(false)
    expect(after.campaign[0]).toMatchObject({ status: 'PAUSED' })
    expect((await w.bundles.getBundle(w.companyId, { status_filter: 'active' })).cached).toBe(false)
    expect(b.cached).toBe(false)
  })

  it('AC-T103-02: orçamento "12,50" vai 1250; vazio não vai; nome com trim', async () => {
    const w = await world()
    const res = await w.svc.update(w.companyId, `${w.act}-s1`, { level: 'adset', fb_ad_account_id: w.act.replace('act_', ''), daily_budget: '12,50', lifetime_budget: '', name: '  Conjunto novo ' })
    expect(fake.mutations.at(-1)!.fields).toEqual({ daily_budget: '1250', name: 'Conjunto novo' })
    expect(res.entity).toMatchObject({ daily_budget: 12.5, name: 'Conjunto novo' })
    expect(res.entity).not.toHaveProperty('lifetime_budget')
  })

  it('AC-T103-03: name com level=ad, sem conta, nível inválido e nada a enviar → validation; conta de outra empresa → not_found', async () => {
    const w = await world()
    const before = fake.mutations.length
    const fieldsOf = async (input: Record<string, unknown>) => {
      const err = await w.svc.update(w.companyId, `${w.act}-a1`, input).catch((e: unknown) => e as { code: string; details?: { fields: { path: string }[] } })
      expect((err as { code: string }).code).toBe('validation')
      return (err as { details: { fields: { path: string }[] } }).details.fields.map((f) => f.path)
    }
    expect(await fieldsOf({ level: 'ad', fb_ad_account_id: w.act, name: 'x' })).toContain('name')
    expect(await fieldsOf({ level: 'ad', fb_ad_account_id: w.act, daily_budget: '10' })).toContain('daily_budget')
    expect(await fieldsOf({ level: 'campaign', status: 'PAUSED' })).toContain('fb_ad_account_id')
    expect(await fieldsOf({ level: 'x', fb_ad_account_id: w.act, status: 'PAUSED' })).toContain('level')
    expect(await fieldsOf({ level: 'campaign', fb_ad_account_id: w.act, status: 'DELETED' })).toContain('status')
    expect(await fieldsOf({ level: 'campaign', fb_ad_account_id: w.act, daily_budget: '-1' })).toContain('daily_budget')
    expect(await fieldsOf({ level: 'campaign', fb_ad_account_id: w.act, name: '  ' })).toContain('status')
    const other = await world()
    await expect(w.svc.update(w.companyId, `${other.act}-c1`, { level: 'campaign', fb_ad_account_id: other.act, status: 'PAUSED' })).rejects.toMatchObject({ code: 'not_found' })
    expect(fake.mutations.length).toBe(before)
    // Status de anúncio é permitido.
    await expect(w.svc.update(w.companyId, `${w.act}-a1`, { level: 'ad', fb_ad_account_id: w.act, status: 'PAUSED' })).resolves.toMatchObject({ success: true })
  })

  it('AC-T103-04: erro da Meta → upstream com a mensagem; não invalida o cache; entidade desconhecida idem', async () => {
    const w = await world()
    await w.bundles.getBundle(w.companyId, {})
    fake.failNext(400, { message: 'Invalid parameter', type: 'OAuthException', code: 100 })
    await expect(w.svc.update(w.companyId, `${w.act}-c1`, { level: 'campaign', fb_ad_account_id: w.act, status: 'PAUSED' })).rejects.toMatchObject({
      code: 'upstream',
      message: META_UPDATE_FAILED_MESSAGE,
      details: expect.objectContaining({ meta_message: 'Invalid parameter', meta_code: 100 }),
    })
    expect((await w.bundles.getBundle(w.companyId, {})).cached).toBe(true)
    await expect(w.svc.update(w.companyId, 'nao-existe', { level: 'campaign', fb_ad_account_id: w.act, status: 'PAUSED' })).rejects.toMatchObject({ code: 'upstream' })
  })

  it('limite de uso da Meta → rate_limited; a conta fica em espera sem nova chamada', async () => {
    const w = await world()
    fake.failNext(400, { message: 'User request limit reached', code: 17 })
    await expect(w.svc.update(w.companyId, `${w.act}-c1`, { level: 'campaign', fb_ad_account_id: w.act, status: 'PAUSED' })).rejects.toMatchObject({ code: 'rate_limited', details: { retry_at: expect.any(String) } })
    const before = fake.requests.length
    await expect(w.svc.update(w.companyId, `${w.act}-c1`, { level: 'campaign', fb_ad_account_id: w.act, status: 'PAUSED' })).rejects.toMatchObject({ code: 'rate_limited' })
    expect(fake.requests.length).toBe(before)
  })
})
