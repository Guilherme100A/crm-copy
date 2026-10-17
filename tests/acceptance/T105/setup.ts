// Ambiente da suíte T105 (adaptado da suíte T101):
// - FakeMetaGraph (@crm/core/meta-testing): addUser, issueCode, setStructure, setInsights, failAccount, setUsage, requests[].
// - createApp com metaConfig apontando ao fake e META_FX_RATES (cotação fixa USD:BRL = 5).
// - GET /api/meta/structure-bundle (síncrono ou async=1); perfil conectado pelo OAuth da T99 e contas marcadas no dashboard.
// - Modo assíncrono: worker REAL (registerMetaAdsJob + configureMetaAds + startWorker), fila `meta-sync` isolada pelo
//   CRM_QUEUE_PREFIX da execução (T121); progresso observado pelo SSE meta.bundle.progress.
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { FsBlobStore, MemoryMailer, redisConnection } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { fakeEmail, uniqueId } from '../helpers/factories'
import { createClient } from '../helpers/http'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export const APP_SECRET = `secret-t105-${randomBytes(6).toString('hex')}`
export const VERSION = 'v26.0'
const WEB_URL = 'http://web.t105.test'

export interface Env {
  tmp: TempDatabase
  db: Any
  redis: Any
  app: Any
  fake: Any
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  close: () => Promise<void>
}

export async function startEnv(): Promise<Env> {
  process.env.META_FX_RATES = JSON.stringify({ 'USD:BRL': 5 })
  const api: Any = await import('@crm/api')
  const kit: Any = await import('@crm/node-kit')
  const { FakeMetaGraph }: Any = await import('@crm/core/meta-testing')
  const key = kit.generateCredentialsKey ? kit.generateCredentialsKey() : randomBytes(32).toString('base64')
  process.env.CREDENTIALS_KEY = typeof key === 'string' ? key : Buffer.from(key).toString('base64')
  kit.resetCredentialsCrypto?.()
  kit.initCredentialsCrypto?.({ key })

  const fake = new FakeMetaGraph({ appId: 'app-t105', appSecret: APP_SECRET, pageSize: 50 })
  const started = await fake.start()
  const graphUrl: string = started?.url ?? fake.url
  process.env.META_GRAPH_URL = graphUrl
  process.env.META_APP_ID = 'app-t105'
  process.env.META_APP_SECRET = APP_SECRET

  const tmp = await createTempDatabase({ migrate: true })
  const storageDir = mkdtempSync(join(tmpdir(), 'crm-t105-'))
  const db = createDb(tmp.url)
  const redis = redisConnection()
  redis.on?.('error', () => {})
  const app = api.createApp({
    db,
    redis,
    mailer: new MemoryMailer(),
    blobStore: new FsBlobStore(storageDir),
    waGateway: new FakeWaGateway(),
    appName: 'ProdutoTesteT105',
    webPublicUrl: WEB_URL,
    trustProxy: true,
    metaConfig: {
      appId: 'app-t105',
      appSecret: APP_SECRET,
      graphUrl,
      version: VERSION,
      redirectUri: 'http://api.t105.test/api/meta/oauth/callback',
      webUrl: WEB_URL,
      dialogUrl: 'http://facebook.t105.test/dialog/oauth',
    },
  })
  const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
  return {
    tmp,
    db,
    redis,
    app,
    fake,
    q,
    close: async () => {
      await (started?.close ?? fake.close)?.call(started ?? fake)
      await Promise.resolve(redis.quit?.()).catch(() => redis.disconnect?.())
      await db.$client.end().catch(() => {})
      await tmp.drop()
      rmSync(storageDir, { recursive: true, force: true })
    },
  }
}

export interface User {
  c: ReturnType<typeof createClient>
  userId: string
  companyId: string
  token: string
}

let ipSeq = 0
export async function owner(env: Env): Promise<User> {
  const ip = `10.105.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`
  const c = createClient({
    fetcher: (path, init) => {
      const headers = new Headers(init.headers)
      headers.set('x-forwarded-for', ip)
      return env.app.request(path, { ...init, headers })
    },
  })
  const password = `Senha-${randomBytes(5).toString('hex')}`
  const email = fakeEmail('t105')
  const reg = await c.post('/api/auth/register', { name: `Dona ${uniqueId('t105')}`, email, password, password_confirmation: password })
  if (reg.status >= 300) throw new Error(`cadastro: ${reg.status} ${reg.text}`)
  const login = await c.post('/api/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login: ${login.status} ${login.text}`)
  const companyId = login.body.companies[0].id
  c.setCompany(companyId)
  const [u] = await env.q(`SELECT id FROM crm.users WHERE lower(email) = lower($1)`, [email])
  return { c, userId: u.id, companyId, token: c.cookies.get('crm_session')! }
}

export interface Account {
  fb: string
  localId: string
  currency: string
}

/** Conecta um perfil Meta (OAuth da T99) com as contas dadas e marca todas no dashboard. */
export async function connect(env: Env, u: User, accounts: Array<{ suffix: string; currency?: string }>): Promise<Account[]> {
  const uid = `fbu-${randomBytes(4).toString('hex')}`
  const adAccounts = accounts.map((a) => ({ id: `act_${uid}_${a.suffix}`, name: `Conta ${a.suffix}`, currency: a.currency ?? 'BRL', account_status: 1 }))
  env.fake.addUser({ id: uid, name: `Pessoa ${uid}`, adAccounts })
  const start = await u.c.post('/api/meta/oauth/start', {})
  const state = new URL(start.body.oauth_url).searchParams.get('state')!
  const code = env.fake.issueCode(uid)
  const cb = await u.c.get(`/api/meta/oauth/callback?${new URLSearchParams({ code, state })}`)
  if (!String(cb.headers.get('location')).includes('meta_oauth=success')) throw new Error(`oauth: ${cb.status} ${cb.headers.get('location')}`)
  const list = await u.c.get('/api/meta/profiles')
  const profile = list.body.items.find((p: Any) => p.fb_user_id === uid)
  const out: Account[] = []
  for (const a of profile.ad_accounts) {
    const put = await u.c.put(`/api/meta/ad-accounts/${a.id}`, { included_in_dashboard: true })
    if (put.status !== 200) throw new Error(`incluir conta: ${put.status} ${put.text}`)
    out.push({ fb: a.fb_account_id, localId: a.id, currency: a.currency })
  }
  return out.sort((x, y) => x.fb.localeCompare(y.fb))
}

/** Estrutura conhecida de uma conta: 1 campanha → 1 conjunto → 1 anúncio, com insights nos 3 níveis. */
export function seedAccount(env: Env, acc: Account, opts: { spend?: string; actions?: Array<{ action_type: string; value: string }>; values?: Array<{ action_type: string; value: string }>; budgetCents?: string } = {}) {
  const tag = acc.fb.slice(-6)
  const ids = { campaign: `cmp_${tag}`, adset: `set_${tag}`, ad: `ad_${tag}` }
  env.fake.setStructure(acc.fb, {
    campaigns: [{ id: ids.campaign, name: `Campanha ${tag}`, effective_status: 'ACTIVE', objective: 'OUTCOME_SALES', daily_budget: opts.budgetCents ?? '5000' }],
    adsets: [{ id: ids.adset, name: `Conjunto ${tag}`, effective_status: 'ACTIVE', campaign_id: ids.campaign, daily_budget: opts.budgetCents ?? '5000' }],
    ads: [{ id: ids.ad, name: `Anúncio ${tag}`, effective_status: 'ACTIVE', campaign_id: ids.campaign, adset_id: ids.adset }],
  })
  const row = {
    campaign_id: ids.campaign,
    adset_id: ids.adset,
    ad_id: ids.ad,
    spend: opts.spend ?? '100.00',
    impressions: '1000',
    inline_link_clicks: '25',
    actions: opts.actions ?? [],
    action_values: opts.values ?? [],
  }
  for (const level of ['campaign', 'adset', 'ad', 'account']) env.fake.setInsights(acc.fb, level, [row])
  return ids
}

export const callsTo = (env: Env, acc: Account) => env.fake.requests.filter((r: Any) => String(r.endpoint ?? r.path).includes(`/${acc.fb}/`)).length

export function bundleUrl(accounts: Account[], extra: Record<string, string> = {}) {
  const p = new URLSearchParams({ level: 'campaign', status_filter: 'all', date_preset: '7d', ad_account_ids: accounts.map((a) => a.localId).join(','), ...extra })
  return `/api/meta/structure-bundle?${p}`
}

/** Worker real do CRM com o job meta-sync (fila isolada pelo CRM_QUEUE_PREFIX desta execução). */
export async function startMetaWorker(env: Env) {
  const wk: Any = await import('@crm/worker')
  for (const n of ['createRegistry', 'registerMetaAdsJob', 'configureMetaAds', 'startWorker'])
    if (typeof wk[n] !== 'function') throw new Error(`@crm/worker não exporta ${n}`)
  const reg = wk.createRegistry()
  wk.registerMetaAdsJob(reg)
  wk.configureMetaAds({ db: env.db, redis: env.redis })
  const handle = await wk.startWorker({ registry: reg, db: env.db, redis: env.redis, handleSignals: false, exitProcess: false, forceConsumer: false })
  return { stop: async () => handle?.stop?.().catch(() => {}) }
}
