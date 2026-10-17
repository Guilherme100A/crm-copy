// Sistema MONTADO como produção para a T102 (padrão T120/T127), com cada processo reiniciável (AC-T102-07):
// - wa-worker REAL em processo filho (helpers/wa-worker.ts, WA_TRANSPORT=fake), mesmo banco/stream/prefixo entre boots;
// - worker do CRM pela MESMA função do main.ts: startProductionWorker({ env, db, migrate: false, handleSignals: false })
//   (WA_GATEWAY=rpc, AI_MODE=fake → production.fakeLlm);
// - API pela composição REAL do servidor: createProductionApiDeps({ env }) + createApp(deps); só o mailer (memória) e o
//   aiKeyProbe (chave BYOK sem rede) são sobrepostos;
// - e-mail de alerta do worker observado por um MemoryMailer entregue ao consumidor de conexões
//   (`configureConnectionsConsumer({ mailer })`, o mesmo ponto em que o boot injeta as dependências);
// - filas isoladas pelo CRM_QUEUE_PREFIX da execução (T121).
// Tudo observado por HTTP (API e /internal/fake/*), SSE, e-mail em memória e linhas crm.* de resultado.
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeEmail, uniqueId } from '../helpers/factories'
import { createClient } from '../helpers/http'
import { fake, newWorkerEnv, startWorker, waitFor, type Worker, type WorkerEnv } from '../helpers/wa-worker'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** Modelo de teste com preço vigente (o UsageGuard recusa modelo sem preço). */
export const MODEL = 'modelo-t102'

export interface System {
  wenv: WorkerEnv
  wa: Worker
  db: Any
  tmp: Any
  /** App Hono da API atual (troca a cada `restartApi`). */
  app: Any
  prod: Any
  /** FakeLlm do worker atual (AI_MODE=fake). */
  llm: Any
  /** E-mails enviados pelo worker (alertas de conexão). */
  workerMail: Any
  /** E-mails enviados pela API. */
  apiMail: Any
  storageDir: string
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  restartWaWorker: () => Promise<void>
  stopWorker: () => Promise<void>
  startWorker: () => Promise<void>
  restartApi: () => Promise<void>
  close: () => Promise<void>
}

export async function startSystem(): Promise<System> {
  const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1'
  // Prefixo das filas único por arquivo (licoes): o da config vale para a execução inteira e, com VITEST_MAX_WORKERS=2,
  // dois arquivos da T102 montam sistemas ao mesmo tempo; os workers de um pegariam os jobs do outro (banco errado).
  process.env.CRM_QUEUE_PREFIX = `${process.env.CRM_QUEUE_PREFIX ?? 'crm-t'}-${randomBytes(3).toString('hex')}`
  const wenv = newWorkerEnv()
  wenv.vars.REDIS_URL = REDIS_URL
  let wa = await startWorker(wenv)
  const credentialsKey = randomBytes(32).toString('base64')
  process.env.CREDENTIALS_KEY = credentialsKey
  const storageDir = mkdtempSync(join(tmpdir(), 'crm-t102-storage-'))

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

  const env = (): Record<string, string | undefined> => ({
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
    ANTIBAN_MODE: 'passthrough',
    MAIL_TRANSPORT: 'memory',
    WEB_PUBLIC_URL: 'http://web.t102.test',
    API_PUBLIC_URL: 'http://api.t102.test',
    LOG_LEVEL: 'warn',
  })
  // Como no main.ts (env = process.env): módulos que montam dependências do ambiente na 1ª entrega veem o MESMO banco/Redis.
  Object.assign(process.env, { DATABASE_URL: tmp.url, REDIS_URL })

  const workerMail = new kit.MemoryMailer()
  const apiMail = new kit.MemoryMailer()

  const sys = { wenv, db, tmp, storageDir, q, workerMail, apiMail } as unknown as System
  Object.defineProperty(sys, 'wa', { get: () => wa, enumerable: true })

  let prod: Any
  sys.startWorker = async () => {
    prod = await wk.startProductionWorker({ env: env(), db, migrate: false, handleSignals: false })
    wk.configureConnectionsConsumer({ mailer: workerMail })
    sys.prod = prod
    sys.llm = prod?.production?.fakeLlm ?? prod?.fakeLlm
  }
  sys.stopWorker = async () => {
    await prod?.stop?.()
    prod = undefined
  }

  let production: Any
  const startApi = async () => {
    production = await api.createProductionApiDeps({ env: { ...env(), TRUST_PROXY: 'true' }, db, migrate: false })
    sys.app = api.createApp({ ...production.deps, mailer: apiMail, aiKeyProbe: async () => ({ ok: true }) })
  }
  const stopApi = async () => {
    production?.dispose?.()
    await production?.close?.().catch(() => {})
    production = undefined
  }
  sys.restartApi = async () => {
    await stopApi()
    await startApi()
  }
  sys.restartWaWorker = async () => {
    await wa.shutdown()
    wa = await startWorker(wenv)
    // a URL do RPC muda (porta livre nova): worker e API precisam apontar para o novo processo
  }

  await sys.startWorker()
  await startApi()

  for (const provider of ['openai', 'google', 'anthropic'])
    await q(
      `INSERT INTO crm.llm_prices (provider, model, kind, effective_from, input_per_mtok_micros, output_per_mtok_micros)
       SELECT $1, $2, 'llm', '2020-01-01T00:00:00Z', 1000000, 2000000
        WHERE NOT EXISTS (SELECT 1 FROM crm.llm_prices WHERE provider = $1 AND model = $2)`,
      [provider, MODEL],
    )

  sys.close = async () => {
    await sys.stopWorker().catch(() => {})
    await stopApi()
    await wa.shutdown().catch(() => wa.kill())
    await db.$client.end().catch(() => {})
    await tmp.drop().catch(() => {})
    rmSync(storageDir, { recursive: true, force: true })
    wenv.cleanup()
  }
  return sys
}

export interface Tenant {
  c: ReturnType<typeof createClient>
  token: string
  email: string
  password: string
  userId: string
  companyId: string
  connectionId: string
  sessionId: string
}

let ipSeq = 0
/** Cliente HTTP da API ATUAL do sistema (sobrevive ao `restartApi`), com IP próprio (limite de taxa). */
export function client(sys: System) {
  const ip = `10.102.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`
  return createClient({
    fetcher: (path, init) => {
      const headers = new Headers(init.headers)
      headers.set('x-forwarded-for', ip)
      return sys.app.request(path, { ...init, headers })
    },
  })
}

/** Dono (cadastro) + conexão criada pela API (sessão nasce no wa-worker) e aberta pelo controle fake. */
export async function tenant(sys: System, opts: { connection?: boolean } = {}): Promise<Tenant> {
  const c = client(sys)
  const password = `Senha-${randomBytes(5).toString('hex')}`
  const email = fakeEmail('t102')
  const reg = await c.post('/api/auth/register', { name: `Dona ${uniqueId('t102')}`, email, password, password_confirmation: password })
  if (reg.status >= 300) throw new Error(`cadastro: ${reg.status} ${reg.text}`)
  const login = await c.post('/api/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login: ${login.status} ${login.text}`)
  const companyId = login.body.companies[0].id
  c.setCompany(companyId)
  const t: Tenant = { c, token: c.cookies.get('crm_session')!, email, password, userId: login.body.user.id, companyId, connectionId: '', sessionId: '' }
  if (opts.connection === false) return t
  const conn = await connection(sys, t, 'Conexão T102')
  return { ...t, ...conn }
}

/** Conexão nova na empresa do tenant, levada a conectada pelo wa-worker fake. */
export async function connection(sys: System, t: Pick<Tenant, 'c'>, name: string) {
  const created = await t.c.post('/api/connections', { name })
  if (created.status !== 201) throw new Error(`conexão: ${created.status} ${created.text}`)
  const { id: connectionId, session_id: sessionId } = created.body.connection
  const connect = await t.c.post(`/api/connections/${connectionId}/connect`)
  if (connect.status !== 200) throw new Error(`connect: ${connect.status} ${connect.text}`)
  await waitFor(async () => (await fake(sys.wa, sys.wenv, `sessions/${sessionId}/qr`, {})).status === 200, 20_000, 'transporte fake')
  const open = await fake(sys.wa, sys.wenv, `sessions/${sessionId}/open`)
  if (open.status !== 200) throw new Error(`open: ${open.status} ${JSON.stringify(open.body)}`)
  await waitFor(async () => ['WARMING', 'STABLE'].includes((await t.c.get(`/api/connections/${connectionId}`)).body?.connection?.session_state), 20_000, 'sessão conectada')
  return { connectionId: connectionId as string, sessionId: sessionId as string }
}

export const tag = () => randomBytes(3).toString('hex')
let phoneSeq = 0
/** Celular BR único (DDD 11) em E.164. */
export const phone = () => `+55119${String(Date.now() % 1e6).padStart(6, '0')}${String(++phoneSeq % 100).padStart(2, '0')}`
export const jidOf = (e164: string) => `${e164.slice(1)}@s.whatsapp.net`

/** Mensagem chegando do WhatsApp (wa-worker fake) na sessão. */
export async function receive(sys: System, sessionId: string, from: string, text: string) {
  const r = await fake(sys.wa, sys.wenv, `sessions/${sessionId}/receive`, { from: jidOf(from), text })
  if (r.status !== 200) throw new Error(`receive: ${r.status} ${JSON.stringify(r.body)}`)
}

/** Envios do transporte fake da sessão (boot atual). */
export async function sent(sys: System, sessionId: string): Promise<Array<{ to: string; text: string; content: Any }>> {
  const st = (await fake(sys.wa, sys.wenv, `sessions/${sessionId}/state`, undefined, 'GET')).body
  return (st.sent ?? []).map((s: Any) => ({ to: s.to, content: s.content, text: s.content?.text ?? s.content?.caption ?? '' }))
}
export const sentTexts = async (sys: System, sessionId: string) => (await sent(sys, sessionId)).map((s) => s.text)

/** Histórico de envios da sessão em TODOS os boots do wa-worker (Redis). */
export async function sentHistory(sys: System, sessionId: string): Promise<Array<{ messageId: string; to: string; content: Any; bootId: string }>> {
  const r = await fake(sys.wa, sys.wenv, `sessions/${sessionId}/sent-history`, undefined, 'GET')
  if (r.status !== 200) throw new Error(`sent-history: ${r.status} ${JSON.stringify(r.body)}`)
  return r.body.items ?? []
}

/** Chat do contato (criado pela ingestão no worker montado). */
export async function chatOf(sys: System, companyId: string, e164: string): Promise<string> {
  return waitFor(
    async () => {
      const rows = await sys.q(`SELECT ch.id FROM crm.chats ch JOIN crm.contacts ct ON ct.id = ch.contact_id WHERE ch.company_id = $1 AND ct.phone_e164 = $2`, [companyId, e164])
      return rows[0]?.id as string | undefined
    },
    30_000,
    `chat de ${e164}`,
  )
}

export async function history(t: Pick<Tenant, 'c'>, chatId: string): Promise<Any[]> {
  const r = await t.c.get(`/api/chats/${chatId}/messages?limit=100`)
  if (r.status !== 200) throw new Error(`histórico: ${r.status} ${r.text}`)
  return r.body.items ?? r.body.messages ?? []
}
export const bodyOf = (m: Any): string => m?.body ?? m?.text ?? ''

// ---------- fluxos pela API ----------

export const action = (id: string, type: string, config: Any) => ({ id, type, order: 0, config })
export const node = (id: string, type: string, actions: Any[] = [], extra: Any = {}) => ({ id, type, name: `Nó ${id}`, position: { x: 0, y: 0 }, actions, ...extra })
export const say = (id: string, text: string) => node(id, 'message', [action(`${id}-a`, 'send_message', { message_text: text })])
export const edge = (from: string, handle: string, to: string) => ({ id: `e-${from}-${handle}-${to}`.replace(/[^a-zA-Z0-9-]/g, '_'), from, handle, to })

/** Cria, define e ativa um fluxo pela API (start → nodes). */
export async function activeFlow(t: Pick<Tenant, 'c'>, nodes: Any[], edges: Any[]): Promise<string> {
  const f = await t.c.post('/api/flows', { name: uniqueId('Fluxo T102') })
  if (f.status !== 201) throw new Error(`fluxo: ${f.status} ${f.text}`)
  const id = (f.body.flow ?? f.body).id
  const def = { schema: 'crm.flow/v1', entry: 'start', nodes: [node('start', 'start'), ...nodes], edges, variables: [], refs: {} }
  const put = await t.c.put(`/api/flows/${id}/definition`, def)
  if (put.status >= 300) throw new Error(`definição: ${put.status} ${put.text}`)
  const act = await t.c.post(`/api/flows/${id}/activate`, {})
  if (act.status >= 300) throw new Error(`ativar: ${act.status} ${act.text}`)
  return id
}

/** Gatilho por palavra-chave (igual) na conexão. */
export async function keyword(t: Pick<Tenant, 'c'>, connectionId: string, flowId: string, word: string) {
  const cfg = await t.c.put(`/api/connection-flow-configs/${connectionId}`, { keyword_triggers: [{ flow_id: flowId, conditions: [{ keyword: word, match_type: 'equals' }] }] })
  if (cfg.status !== 200) throw new Error(`gatilho: ${cfg.status} ${cfg.text}`)
}

/** Runs de fluxo do chat (banco: resultado observável do motor). */
export const runsOf = (sys: System, chatId: string) => sys.q(`SELECT id, flow_id, status FROM crm.flow_runs WHERE chat_id = $1 ORDER BY started_at`, [chatId])

// ---------- IA ----------

export async function aiKey(t: Pick<Tenant, 'c'>, provider: string): Promise<string> {
  const k = await t.c.post('/api/ai-keys', { provider, name: `Chave ${provider} ${tag()}`, secret: `sk-test-${randomBytes(12).toString('hex')}` })
  if (k.status !== 201) throw new Error(`chave de IA: ${k.status} ${k.text}`)
  return (k.body.key ?? k.body.ai_key ?? k.body).id
}

/** Chamadas do FakeLlm do worker para a empresa. */
export const llmCallsOf = (sys: System, companyId: string): Any[] => (sys.llm?.calls ?? []).filter((c: Any) => c.tenantId === companyId)

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export { fake, waitFor }
