// Sistema MONTADO como produção (padrão T120/T125) para a T127. Contrato combinado com o Cinzel:
// - worker do CRM pela MESMA função do main.ts: startProductionWorker({ env, db, migrate: false, handleSignals: false })
//   (WA_GATEWAY=rpc com o wa-worker REAL em processo filho, WA_TRANSPORT=fake; AI_MODE=fake → production.fakeLlm);
// - API pela composição REAL do servidor: createProductionApiDeps({ env }) + createApp(deps); só o mailer (memória) e o
//   aiKeyProbe (cadastrar chave BYOK sem rede) são sobrepostos. As rotas públicas enfileiram nas filas BullMQ reais
//   (inbound-webhooks, inbound-sales, payment-webhooks, ai-knowledge, ai-agent-lab, exports) e o worker processa;
// - fakes da SPEC 3.10: FakeMetaGraph (CAPI), FakeXPag (gateway de pagamento), FakeLlm (AI_MODE=fake);
// - filas isoladas pelo CRM_QUEUE_PREFIX da execução (T121).
// Tudo observado por HTTP (API e /internal/fake/*), pelos fakes e pelas linhas crm.* de resultado.
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeEmail, uniqueId } from '../helpers/factories'
import { createClient } from '../helpers/http'
import { fake, newWorkerEnv, startWorker, waitFor, type Worker, type WorkerEnv } from '../helpers/wa-worker'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export const META_APP_ID = 'app-t127'
export const META_APP_SECRET = `secret-t127-${randomBytes(6).toString('hex')}`
export const XPAG_CLIENT_ID = 'cli-t127'
export const XPAG_CLIENT_SECRET = `sk_xpag_${randomBytes(12).toString('hex')}`
export const API_PUBLIC_URL = 'http://api.t127.test'
/** Modelo de teste com preço vigente (o UsageGuard recusa modelo sem preço). */
export const MODEL = 'modelo-t127'

export interface System {
  fakeMeta: Any
  xpag: Any
  wenv: WorkerEnv
  wa: Worker
  tmp: Any
  db: Any
  app: Any
  prod: Any
  /** FakeLlm do processo do worker (AI_MODE=fake). */
  llm: Any
  storageDir: string
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  close: () => Promise<void>
}

export async function startSystem(): Promise<System> {
  const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1'
  const wenv = newWorkerEnv()
  wenv.vars.REDIS_URL = REDIS_URL

  const core: Any = await import('@crm/core')
  const { FakeMetaGraph }: Any = await import('@crm/core/meta-testing')
  const fakeMeta = new FakeMetaGraph({ appId: META_APP_ID, appSecret: META_APP_SECRET, pageSize: 50 })
  const metaStarted = await fakeMeta.start()
  const metaUrl: string = metaStarted?.url ?? fakeMeta.url
  const xpag = new core.FakeXPag({ clientId: XPAG_CLIENT_ID, clientSecret: XPAG_CLIENT_SECRET })
  await xpag.start()

  // mesmas variáveis que o server.ts e o worker leem do ambiente
  const shared = {
    META_GRAPH_URL: metaUrl,
    META_APP_ID,
    META_APP_SECRET,
    META_OAUTH_REDIRECT_URI: 'http://api.t127.test/api/meta/oauth/callback',
    META_OAUTH_DIALOG_URL: 'http://facebook.t127.test/dialog/oauth',
    WEB_PUBLIC_URL: 'http://web.t127.test',
    META_FX_RATES: JSON.stringify({ 'USD:BRL': 5 }),
    XPAG_API_URL: xpag.url,
    API_PUBLIC_URL,
    AI_AGENT_CREATE_MODEL: `openai:${MODEL}`,
  }
  Object.assign(process.env, shared)
  const wa = await startWorker(wenv)
  const credentialsKey = randomBytes(32).toString('base64')
  process.env.CREDENTIALS_KEY = credentialsKey
  const storageDir = mkdtempSync(join(tmpdir(), 'crm-t127-storage-'))

  const { createDb }: Any = await import('@crm/db')
  const { createTempDatabase }: Any = await import('@crm/db/testing')
  const kit: Any = await import('@crm/node-kit')
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
    ...shared,
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
    ANTIBAN_MODE: 'passthrough',
    LOG_LEVEL: 'warn',
  }
  // Como no main.ts (env = process.env): módulos que montam dependências do ambiente na 1ª entrega (ex.: consumidor
  // de conexões da T47, sem configure no boot) precisam ver o MESMO banco/Redis no process.env.
  Object.assign(process.env, { DATABASE_URL: tmp.url, REDIS_URL })
  const prod = await wk.startProductionWorker({ env, db, migrate: false, handleSignals: false })
  const llm = prod?.production?.fakeLlm ?? prod?.fakeLlm

  if (typeof api.createProductionApiDeps !== 'function') throw new Error('@crm/api não exporta createProductionApiDeps')
  const production = await api.createProductionApiDeps({ env: { ...env, TRUST_PROXY: 'true' }, db, migrate: false })
  const app = api.createApp({ ...production.deps, mailer: new kit.MemoryMailer(), aiKeyProbe: async () => ({ ok: true }) })

  // preços vigentes do modelo de teste em todos os provedores usados
  for (const provider of ['openai', 'google', 'anthropic'])
    await q(
      `INSERT INTO crm.llm_prices (provider, model, kind, effective_from, input_per_mtok_micros, output_per_mtok_micros)
       SELECT $1, $2, 'llm', '2020-01-01T00:00:00Z', 1000000, 2000000
        WHERE NOT EXISTS (SELECT 1 FROM crm.llm_prices WHERE provider = $1 AND model = $2)`,
      [provider, MODEL],
    )

  return {
    fakeMeta,
    xpag,
    wenv,
    wa,
    tmp,
    db,
    app,
    prod,
    llm,
    storageDir,
    q,
    close: async () => {
      await prod?.stop?.().catch(() => {})
      await (metaStarted?.close ?? fakeMeta.close)?.call(metaStarted ?? fakeMeta)
      await xpag.stop?.().catch(() => {})
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

let ipSeq = 0
/** Dono + conexão criada pela API (sessão nasce no wa-worker) e aberta pelo controle fake. */
export async function tenant(sys: System): Promise<Tenant> {
  const ip = `10.127.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`
  const c = createClient({
    fetcher: (path, init) => {
      const headers = new Headers(init.headers)
      headers.set('x-forwarded-for', ip)
      return sys.app.request(path, { ...init, headers })
    },
  })
  const password = `Senha-${randomBytes(5).toString('hex')}`
  const email = fakeEmail('t127')
  const reg = await c.post('/api/auth/register', { name: `Dona ${uniqueId('t127')}`, email, password, password_confirmation: password })
  if (reg.status >= 300) throw new Error(`cadastro: ${reg.status} ${reg.text}`)
  const login = await c.post('/api/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login: ${login.status} ${login.text}`)
  const companyId = login.body.companies[0].id
  c.setCompany(companyId)
  const created = await c.post('/api/connections', { name: 'Conexão T127' })
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

export const tag = () => randomBytes(3).toString('hex')
let phoneSeq = 0
/** Celular BR local único (DDD 11, 11 dígitos, sem +55). */
export const localPhone = () => `119${String(Date.now() % 1e6).padStart(6, '0')}${String(++phoneSeq % 100).padStart(2, '0')}`
export const phone = () => `+55${localPhone()}`
export const jidOf = (e164: string) => `${e164.slice(1)}@s.whatsapp.net`

/** Mensagem chegando do WhatsApp (wa-worker fake). */
export async function receive(sys: System, t: Tenant, from: string, text: string) {
  const r = await fake(sys.wa, sys.wenv, `sessions/${t.sessionId}/receive`, { from: jidOf(from), text })
  if (r.status !== 200) throw new Error(`receive: ${r.status} ${JSON.stringify(r.body)}`)
}

/** Textos enviados pelo transporte do wa-worker na sessão. */
export async function sentTexts(sys: System, t: Tenant): Promise<string[]> {
  const st = (await fake(sys.wa, sys.wenv, `sessions/${t.sessionId}/state`, undefined, 'GET')).body
  return (st.sent ?? []).map((s: Any) => s.content?.text ?? JSON.stringify(s.content))
}

/** Chat do contato (criado pela ingestão no worker montado). */
export async function chatOf(sys: System, t: Tenant, e164: string): Promise<string> {
  return waitFor(
    async () => {
      const rows = await sys.q(`SELECT ch.id FROM crm.chats ch JOIN crm.contacts ct ON ct.id = ch.contact_id WHERE ch.company_id = $1 AND ct.phone_e164 = $2`, [t.companyId, e164])
      return rows[0]?.id as string | undefined
    },
    30_000,
    `chat de ${e164}`,
  )
}

// ---------- fluxos pela API ----------

export const action = (id: string, type: string, config: Any) => ({ id, type, order: 0, config })
export const node = (id: string, type: string, actions: Any[] = []) => ({ id, type, name: `Nó ${id}`, position: { x: 0, y: 0 }, actions })
export const say = (id: string, text: string) => node(id, 'message', [action(`${id}-a`, 'send_message', { message_text: text })])
export const edge = (from: string, handle: string, to: string) => ({ id: `e-${from}-${handle}-${to}`.replace(/[^a-zA-Z0-9-]/g, '_'), from, handle, to })

/** Cria, define e ativa um fluxo pela API (start → nodes). */
export async function activeFlow(t: Tenant, nodes: Any[], edges: Any[]): Promise<string> {
  const f = await t.c.post('/api/flows', { name: uniqueId('Fluxo T127') })
  if (f.status !== 201) throw new Error(`fluxo: ${f.status} ${f.text}`)
  const id = (f.body.flow ?? f.body).id
  const def = { schema: 'crm.flow/v1', entry: 'start', nodes: [node('start', 'start'), ...nodes], edges, variables: [], refs: {} }
  const put = await t.c.put(`/api/flows/${id}/definition`, def)
  if (put.status >= 300) throw new Error(`definição: ${put.status} ${put.text}`)
  const act = await t.c.post(`/api/flows/${id}/activate`, {})
  if (act.status >= 300) throw new Error(`ativar: ${act.status} ${act.text}`)
  return id
}

/** Gatilho por palavra-chave (igual) na conexão do tenant. */
export async function keyword(t: Tenant, flowId: string, word: string) {
  const cfg = await t.c.put(`/api/connection-flow-configs/${t.connectionId}`, { keyword_triggers: [{ flow_id: flowId, conditions: [{ keyword: word, match_type: 'equals' }] }] })
  if (cfg.status !== 200) throw new Error(`gatilho: ${cfg.status} ${cfg.text}`)
}

// ---------- IA ----------

/** Chave BYOK pela API (probe falso, sem rede). */
export async function aiKey(t: Tenant, provider: string): Promise<string> {
  const k = await t.c.post('/api/ai-keys', { provider, name: `Chave ${provider} ${tag()}`, secret: `sk-test-${randomBytes(12).toString('hex')}` })
  if (k.status !== 201) throw new Error(`chave de IA: ${k.status} ${k.text}`)
  return (k.body.key ?? k.body.ai_key ?? k.body).id
}

/** Carteira de créditos de IA (saldo > 0 = ok; 0 = esgotada). */
export async function wallet(sys: System, companyId: string, credits: number) {
  await sys.q(
    `INSERT INTO crm.ai_wallets (company_id, balance_credits, status) VALUES ($1, $2, $3)
     ON CONFLICT (company_id) DO UPDATE SET balance_credits = EXCLUDED.balance_credits, max_overrun_credits = 0, status = EXCLUDED.status`,
    [companyId, credits, credits > 0 ? 'ok' : 'exhausted'],
  )
}

/** Chamadas do FakeLlm do worker para a empresa. */
export const llmCallsOf = (sys: System, companyId: string): Any[] => (sys.llm?.calls ?? []).filter((c: Any) => c.tenantId === companyId)

export const textOf = (m: Any): string => (typeof m?.content === 'string' ? m.content : (m?.content ?? []).map((p: Any) => p?.text ?? '').join('\n'))
export const requestText = (req: Any) => [req?.instructions ?? '', ...(req?.messages ?? []).map(textOf)].join('\n')

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export { waitFor }

// ---------- Meta (T125) ----------

/** Pixel com envio automático de vendas, criado pela API e cadastrado no fake. */
export async function salesPixel(sys: System, t: Tenant) {
  const pixelId = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(-15)
  const token = `EAAB${randomBytes(16).toString('hex')}xyz9`
  const r = await t.c.post('/api/meta/pixels', { name: `Pixel ${uniqueId('px')}`, pixel_id: pixelId, access_token: token, auto_send_sales: true })
  if (r.status !== 201) throw new Error(`pixel: ${r.status} ${r.text}`)
  sys.fakeMeta.addPixel(pixelId, token)
  return { id: r.body.pixel.id as string, pixelId }
}

/** POST público cru (sem sessão). */
export async function postPublic(sys: System, path: string, body: string, headers: Record<string, string> = {}) {
  const res: Response = await sys.app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.200.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`, ...headers },
    body,
  })
  const text = await res.text()
  let parsed: Any = text
  try {
    parsed = JSON.parse(text)
  } catch {
    /* não-JSON */
  }
  return { status: res.status, body: parsed, text }
}
