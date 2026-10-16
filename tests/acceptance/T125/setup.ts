// Sistema MONTADO como produção da T120 + Meta (T125), contrato combinado com o Cinzel. Diferenças para a T120:
// - FakeMetaGraph (@crm/core/meta-testing) e META_* no process.env ANTES do createApp/startProductionWorker (o server.ts lê do env);
// - API pela composição REAL do servidor: createProductionApiDeps({ env }) + createApp(deps) (apps/api/src/production.ts);
// - filas isoladas pelo CRM_QUEUE_PREFIX da execução (T121), sem db Redis separado.
// Base (T120):
// - wa-worker REAL em processo filho (helpers/wa-worker.ts, WA_TRANSPORT=fake);
// - worker do CRM pela MESMA função do main.ts: startProductionWorker({ env, handleSignals: false }) de '@crm/worker'
//   (WA_GATEWAY=rpc, AI_MODE=fake → FakeLlm em production.fakeLlm, exigindo a chave BYOK da empresa);
// - API: createApp com o WaGateway de createWaGatewayFromEnv(WA_GATEWAY=rpc), BlobStore/exportFiles no MESMO STORAGE_DIR
//   e o mesmo CREDENTIALS_KEY; aiKeyProbe falso (cadastrar chave sem rede).
// Tudo observado por HTTP (API e /internal/fake/*), SSE e linhas crm.* de resultado (ai_usage).
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeEmail, uniqueId } from '../helpers/factories'
import { createClient } from '../helpers/http'
import { fake, newWorkerEnv, startWorker, waitFor, type Worker, type WorkerEnv } from '../helpers/wa-worker'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export const META_APP_ID = 'app-t125'
export const META_APP_SECRET = `secret-t125-${randomBytes(6).toString('hex')}`

export interface System {
  fakeMeta: Any
  wenv: WorkerEnv
  wa: Worker
  tmp: Any
  db: Any
  app: Any
  prod: Any
  storageDir: string
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  close: () => Promise<void>
}

export async function startSystem(): Promise<System> {
  // Filas isoladas pelo CRM_QUEUE_PREFIX desta execução (definido na config da aceitação, T121).
  const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1'
  const wenv = newWorkerEnv()
  wenv.vars.REDIS_URL = REDIS_URL

  // Meta: servidor fake local e as mesmas variáveis que o server.ts e o worker leem do ambiente.
  const { FakeMetaGraph }: Any = await import('@crm/core/meta-testing')
  const fakeMeta = new FakeMetaGraph({ appId: META_APP_ID, appSecret: META_APP_SECRET, pageSize: 50 })
  const metaStarted = await fakeMeta.start()
  const metaUrl: string = metaStarted?.url ?? fakeMeta.url
  Object.assign(process.env, {
    META_GRAPH_URL: metaUrl,
    META_APP_ID,
    META_APP_SECRET,
    META_OAUTH_REDIRECT_URI: 'http://api.t125.test/api/meta/oauth/callback',
    META_OAUTH_DIALOG_URL: 'http://facebook.t125.test/dialog/oauth',
    WEB_PUBLIC_URL: 'http://web.t125.test',
    META_FX_RATES: JSON.stringify({ 'USD:BRL': 5 }),
  })
  const wa = await startWorker(wenv)
  const credentialsKey = randomBytes(32).toString('base64')
  process.env.CREDENTIALS_KEY = credentialsKey
  const storageDir = mkdtempSync(join(tmpdir(), 'crm-t125-storage-'))

  const { createDb }: Any = await import('@crm/db')
  const { createTempDatabase }: Any = await import('@crm/db/testing')
  const kit: Any = await import('@crm/node-kit')
  const core: Any = await import('@crm/core')
  const rpc: Any = await import('@crm/wa-gateway-rpc')
  const wk: Any = await import('@crm/worker')
  const api: Any = await import('@crm/api')
  kit.resetCredentialsCrypto?.()
  kit.initCredentialsCrypto?.()

  const tmp = await createTempDatabase({ migrate: true })
  const db = createDb(tmp.url)
  db.$client.on?.('error', () => {})
  const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows

  const env = {
    ...process.env,
    DATABASE_URL: tmp.url,
    REDIS_URL,
    CREDENTIALS_KEY: credentialsKey,
    STORAGE_DIR: storageDir,
    WA_GATEWAY: 'rpc',
    WA_RPC_URL: wa.url,
    WA_RPC_PROFILE: 'crm',
    INTERNAL_TOKEN: wenv.token,
    WA_EVENTS_STREAM: wenv.stream,
    AI_MODE: 'fake',
    META_GRAPH_URL: metaUrl,
    META_APP_ID,
    META_APP_SECRET,
    META_FX_RATES: JSON.stringify({ 'USD:BRL': 5 }),
    ANTIBAN_MODE: 'passthrough',
    LOG_LEVEL: 'warn',
  }
  const prod = await wk.startProductionWorker({ env, db, migrate: false, handleSignals: false })

  // API pela MESMA composição do server.ts (T125): createProductionApiDeps({ env }) + createApp(deps).
  // Só o mailer é sobreposto (memória). O salesPublisher → fila meta-capi vem do código de produção.
  if (typeof api.createProductionApiDeps !== 'function') throw new Error('@crm/api não exporta createProductionApiDeps')
  const production = await api.createProductionApiDeps({ env: { ...env, TRUST_PROXY: 'true', WEB_PUBLIC_URL: 'http://web.t125.test' }, db, migrate: false })
  const app = api.createApp({ ...production.deps, mailer: new kit.MemoryMailer() })

  return {
    fakeMeta,
    wenv,
    wa,
    tmp,
    db,
    app,
    prod,
    storageDir,
    q,
    close: async () => {
      await prod?.stop?.().catch(() => {})
      await (metaStarted?.close ?? fakeMeta.close)?.call(metaStarted ?? fakeMeta)
      production.dispose?.()
      await production.close?.().catch(() => {})
      await wa.shutdown().catch(() => wa.kill())
      await db.$client.end().catch(() => {})
      await tmp.drop().catch(() => {})
      rmSync(storageDir, { recursive: true, force: true })
      wenv.cleanup()
    },
  }
}

export interface Tenant {
  c: ReturnType<typeof createClient>
  token: string
  companyId: string
  connectionId: string
  sessionId: string
}

/** Dono + conexão criada pela API (sessão nasce no wa-worker) e aberta pelo controle fake. */
export async function tenant(sys: System): Promise<Tenant> {
  const c = createClient({ fetcher: (path, init) => sys.app.request(path, init) })
  const password = `Senha-${randomBytes(5).toString('hex')}`
  const email = fakeEmail('t125')
  const reg = await c.post('/api/auth/register', { name: `Dona ${uniqueId('t125')}`, email, password, password_confirmation: password })
  if (reg.status >= 300) throw new Error(`cadastro: ${reg.status} ${reg.text}`)
  const login = await c.post('/api/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login: ${login.status} ${login.text}`)
  const companyId = login.body.companies[0].id
  c.setCompany(companyId)
  const created = await c.post('/api/connections', { name: 'Conexão T125' })
  if (created.status !== 201) throw new Error(`conexão: ${created.status} ${created.text}`)
  const { id: connectionId, session_id: sessionId } = created.body.connection
  const connect = await c.post(`/api/connections/${connectionId}/connect`)
  if (connect.status !== 200) throw new Error(`connect: ${connect.status} ${connect.text}`)
  await waitFor(async () => (await fake(sys.wa, sys.wenv, `sessions/${sessionId}/qr`, {})).status === 200, 20_000, 'transporte fake')
  const open = await fake(sys.wa, sys.wenv, `sessions/${sessionId}/open`)
  if (open.status !== 200) throw new Error(`open: ${open.status} ${JSON.stringify(open.body)}`)
  await waitFor(async () => ['WARMING', 'STABLE'].includes((await c.get(`/api/connections/${connectionId}`)).body?.connection?.session_state), 20_000, 'sessão conectada')
  return { c, token: c.cookies.get('crm_session')!, companyId, connectionId, sessionId }
}

export const phone = () => `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`
export const jidOf = (e164: string) => `${e164.slice(1)}@s.whatsapp.net`

/** Mensagem chegando do WhatsApp (wa-worker fake). */
export async function receive(sys: System, t: Tenant, from: string, text: string) {
  const r = await fake(sys.wa, sys.wenv, `sessions/${t.sessionId}/receive`, { from: jidOf(from), text })
  if (r.status !== 200) throw new Error(`receive: ${r.status} ${JSON.stringify(r.body)}`)
}

/** Chat do contato (criado pela ingestão no worker montado). */
export async function chatOf(sys: System, t: Tenant, e164: string): Promise<string> {
  return waitFor(
    async () => {
      const rows = await sys.q(
        `SELECT ch.id FROM crm.chats ch JOIN crm.contacts ct ON ct.id = ch.contact_id WHERE ch.company_id = $1 AND ct.phone_e164 = $2`,
        [t.companyId, e164],
      )
      return rows[0]?.id as string | undefined
    },
    30_000,
    `chat de ${e164}`,
  )
}

/** Textos enviados pelo transporte do wa-worker na sessão. */
export async function sentTexts(sys: System, t: Tenant): Promise<string[]> {
  const st = (await fake(sys.wa, sys.wenv, `sessions/${t.sessionId}/state`, undefined, 'GET')).body
  return (st.sent ?? []).map((s: Any) => s.content?.text ?? JSON.stringify(s.content))
}

export async function history(t: Tenant, chatId: string): Promise<Any[]> {
  const r = await t.c.get(`/api/chats/${chatId}/messages`)
  if (r.status !== 200) throw new Error(`histórico: ${r.status} ${r.text}`)
  return r.body.items ?? r.body.messages ?? []
}

/** Fluxo start → mensagem, publicado e ativo, criado pela API. */
export async function messageFlow(t: Tenant, text: string): Promise<string> {
  const f = await t.c.post('/api/flows', { name: uniqueId('Fluxo T125') })
  if (f.status !== 201) throw new Error(`fluxo: ${f.status} ${f.text}`)
  const id = (f.body.flow ?? f.body).id
  const def = {
    schema: 'crm.flow/v1',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'start', name: 'start', position: { x: 0, y: 0 }, actions: [] },
      { id: 'm', type: 'message', name: 'm', position: { x: 200, y: 0 }, actions: [{ id: 'a1', type: 'send_message', order: 0, config: { message_text: text } }] },
    ],
    edges: [{ id: 'e1', from: 'start', handle: 'source', to: 'm' }],
    variables: [],
    refs: {},
  }
  const put = await t.c.put(`/api/flows/${id}/definition`, def)
  if (put.status >= 300) throw new Error(`definição: ${put.status} ${put.text}`)
  const act = await t.c.post(`/api/flows/${id}/activate`, {})
  if (act.status >= 300) throw new Error(`ativar: ${act.status} ${act.text}`)
  return id
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export { waitFor }

// ---------- Meta (T125) ----------

export interface MetaAccount {
  fb: string
  localId: string
}

/** Conecta um perfil Meta pelo OAuth da API (com o fake) e marca as contas no dashboard. */
export async function connectMeta(sys: System, t: Tenant, n = 1): Promise<MetaAccount[]> {
  const uid = `fbu-${randomBytes(4).toString('hex')}`
  const adAccounts = Array.from({ length: n }, (_, i) => ({ id: `act_${uid}_${i + 1}`, name: `Conta ${i + 1}`, currency: 'BRL', account_status: 1 }))
  sys.fakeMeta.addUser({ id: uid, name: `Pessoa ${uid}`, adAccounts })
  const start = await t.c.post('/api/meta/oauth/start', {})
  if (start.status >= 300) throw new Error(`oauth/start: ${start.status} ${start.text}`)
  const state = new URL(start.body.oauth_url).searchParams.get('state')!
  const cb = await t.c.get(`/api/meta/oauth/callback?${new URLSearchParams({ code: sys.fakeMeta.issueCode(uid), state })}`)
  if (!String(cb.headers.get('location')).includes('meta_oauth=success')) throw new Error(`oauth: ${cb.status} ${cb.headers.get('location')}`)
  const profile = (await t.c.get('/api/meta/profiles')).body.items.find((p: Any) => p.fb_user_id === uid)
  const out: MetaAccount[] = []
  for (const a of profile.ad_accounts) {
    const put = await t.c.put(`/api/meta/ad-accounts/${a.id}`, { included_in_dashboard: true })
    if (put.status !== 200) throw new Error(`incluir conta: ${put.status} ${put.text}`)
    out.push({ fb: a.fb_account_id, localId: a.id })
  }
  return out
}

/** 1 campanha → 1 conjunto → 1 anúncio com insights, numa conta do fake. */
export function seedMetaAccount(sys: System, acc: MetaAccount) {
  const tag = acc.fb.slice(-6)
  const ids = { campaign: `cmp_${tag}`, adset: `set_${tag}`, ad: `ad_${tag}` }
  sys.fakeMeta.setStructure(acc.fb, {
    campaigns: [{ id: ids.campaign, name: `Campanha ${tag}`, effective_status: 'ACTIVE', objective: 'OUTCOME_SALES', daily_budget: '5000' }],
    adsets: [{ id: ids.adset, name: `Conjunto ${tag}`, effective_status: 'ACTIVE', campaign_id: ids.campaign, daily_budget: '5000' }],
    ads: [{ id: ids.ad, name: `Anúncio ${tag}`, effective_status: 'ACTIVE', campaign_id: ids.campaign, adset_id: ids.adset }],
  })
  const row = { campaign_id: ids.campaign, adset_id: ids.adset, ad_id: ids.ad, spend: '80.00', impressions: '900', inline_link_clicks: '12', actions: [], action_values: [] }
  for (const level of ['campaign', 'adset', 'ad', 'account']) sys.fakeMeta.setInsights(acc.fb, level, [row])
  return ids
}

/** Pixel com envio automático de vendas, criado pela API e cadastrado no fake. */
export async function salesPixel(sys: System, t: Tenant) {
  const pixelId = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(-15)
  const token = `EAAB${randomBytes(16).toString('hex')}xyz9`
  const r = await t.c.post('/api/meta/pixels', { name: `Pixel ${uniqueId('px')}`, pixel_id: pixelId, access_token: token, auto_send_sales: true })
  if (r.status !== 201) throw new Error(`pixel: ${r.status} ${r.text}`)
  sys.fakeMeta.addPixel(pixelId, token)
  return { id: r.body.pixel.id as string, pixelId }
}
