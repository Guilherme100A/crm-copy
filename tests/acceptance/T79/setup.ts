// Ambiente da suíte T79 (lab de agentes: teste ao vivo, generate-prompt e criação assistida). Contrato combinado com
// o Operário (Bigorna):
//  - POST/DELETE /api/ai-agents/:id/test-messages, POST /api/ai-agents/:id/generate-prompt (flows.edit)
//  - POST /api/ai-agents/runs (202 { run }), GET /api/ai-agents/runs/:id, POST /api/ai-agents/runs/estimate
//  - createApp deps: aiLabLlm (FakeLlm), aiLabEvalCap, aiLabSiteHttp (SafeHttpOptions), aiLabPublisher (espião),
//    aiAgentLabInline (run no próprio processo) ou aiLabEnqueue (captura o run sem processar), aiLabStt,
//    aiLabComposeModel (modelo do compose quando a empresa não tem preset 'balanced').
//  - cobrança pelo UsageGuard padrão (carteira crm.ai_wallets, crm.ai_usage com feature 'ai_agent_test'/'ai_agent_create').
import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createDb } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { MemoryMailer, redisConnection } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { createClient, type ApiClient } from '../helpers/http'
import { fakeEmail, uniqueId } from '../helpers/factories'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export const MODEL = { provider: 'openai', model: 'gpt-teste-t79' }

export interface Env {
  tmp: TempDatabase
  db: Any
  redis: Any
  core: Any
  ai: Any
  api: Any
  gateway: Any
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  close: () => Promise<void>
}

export async function startEnv(): Promise<Env> {
  const api: Any = await import('@crm/api')
  const core: Any = await import('@crm/core')
  const ai: Any = await import('@crm/ai/testing')
  const tmp = await createTempDatabase({ migrate: true })
  const db = createDb(tmp.url)
  db.$client.on?.('error', () => {})
  const redis = redisConnection()
  redis.on?.('error', () => {})
  const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
  // preço vigente do modelo de teste (o UsageGuard recusa modelo sem preço)
  await q(
    `INSERT INTO crm.llm_prices (provider, model, kind, effective_from, input_per_mtok_micros, output_per_mtok_micros)
     SELECT $1, $2, 'llm', '2020-01-01T00:00:00Z', 1000000, 2000000
      WHERE NOT EXISTS (SELECT 1 FROM crm.llm_prices WHERE provider = $1 AND model = $2)`,
    [MODEL.provider, MODEL.model],
  )
  return {
    tmp,
    db,
    redis,
    core,
    ai,
    api,
    gateway: new FakeWaGateway(),
    q,
    close: async () => {
      await Promise.resolve(api.stopRealtimeHub?.(redis)).catch(() => {})
      await Promise.resolve(redis.quit?.()).catch(() => redis.disconnect?.())
      await db.$client.end().catch(() => {})
      await tmp.drop()
    },
  }
}

export interface Published {
  companyId: string
  type: string
  data: Any
}

export interface Lab {
  app: Any
  llm: Any
  published: Published[]
  enqueued: Array<{ runId: string; companyId: string }>
}

export interface LabOptions {
  evalCap?: number
  /** 'inline' (padrão): o run roda logo após o 202; 'capture': o run fica na fila capturada, sem processar. */
  runMode?: 'inline' | 'capture'
  stt?: Any
}

/** App novo sobre o mesmo banco, com FakeLlm próprio e publisher espião. */
export function lab(env: Env, opts: LabOptions = {}): Lab {
  const llm = new env.ai.FakeLlm()
  const published: Published[] = []
  const enqueued: Lab['enqueued'] = []
  const app = env.api.createApp({
    db: env.db,
    redis: env.redis,
    mailer: new MemoryMailer(),
    waGateway: env.gateway,
    aiProviderKeys: { isConfigured: () => true },
    trustProxy: true,
    aiLabLlm: llm,
    // modelo da etapa compose (o agente ainda não existe): preset da empresa/plataforma ou esta dep
    aiLabComposeModel: MODEL,
    aiLabSiteHttp: { allowHosts: ['127.0.0.1', 'localhost'] },
    aiLabPublisher: { publish: async (companyId: string, type: string, data: Any) => void published.push({ companyId, type, data }) },
    ...(opts.evalCap !== undefined ? { aiLabEvalCap: opts.evalCap } : {}),
    ...(opts.stt ? { aiLabStt: opts.stt } : {}),
    ...((opts.runMode ?? 'inline') === 'inline'
      ? { aiAgentLabInline: true }
      : { aiLabEnqueue: async (data: { runId: string; companyId: string }) => void enqueued.push(data) }),
  })
  return { app, llm, published, enqueued }
}

const randomIp = () => `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${1 + (randomBytes(1)[0]! % 250)}`

export interface User {
  c: ApiClient
  userId: string
  companyId: string
}

function client(l: Lab): ApiClient {
  const ip = randomIp()
  return createClient({
    fetcher: (path, init) => {
      const headers = new Headers(init.headers)
      headers.set('x-forwarded-for', ip)
      return l.app.request(path, { ...init, headers })
    },
  })
}

/** Dono de uma empresa nova, com carteira de IA abastecida e câmbio 1 USD = 1000 créditos. */
export async function newOwner(env: Env, l: Lab, balance = 1_000_000_000): Promise<User> {
  const password = `Senha-${randomBytes(6).toString('hex')}`
  const email = fakeEmail('t79')
  const c = client(l)
  const reg = await c.post('/api/auth/register', { name: `Pessoa ${uniqueId('t79')}`, email, password, password_confirmation: password })
  if (reg.status >= 300) throw new Error(`cadastro falhou: ${reg.status} ${reg.text}`)
  const login = await c.post('/api/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login falhou: ${login.status} ${login.text}`)
  const companyId = login.body.companies[0].id
  c.setCompany(companyId)
  await env.q(
    `INSERT INTO crm.ai_pricing_settings (company_id, markup_bps, credits_per_usd, rounding_mode) VALUES ($1, 10000, 1000, 'ceil')
     ON CONFLICT DO NOTHING`,
    [companyId],
  )
  await setBalance(env, companyId, balance)
  return { c, userId: login.body.user.id, companyId }
}

export async function setBalance(env: Env, companyId: string, balance: number) {
  const status = balance > 0 ? 'ok' : 'exhausted'
  await env.q(
    `INSERT INTO crm.ai_wallets (company_id, balance_credits, max_overrun_credits, status) VALUES ($1, $2, 0, $3)
     ON CONFLICT (company_id) DO UPDATE SET balance_credits = $2, max_overrun_credits = 0, status = $3`,
    [companyId, balance, status],
  )
}

export async function balanceOf(env: Env, companyId: string): Promise<number> {
  const [w] = await env.q(`SELECT balance_credits FROM crm.ai_wallets WHERE company_id = $1`, [companyId])
  return Number(w?.balance_credits ?? 0)
}

/** Usuário de outra pessoa como membro da empresa com permissões explícitas. */
export async function newMember(env: Env, l: Lab, companyId: string, keys: string[]): Promise<User> {
  const u = await newOwner(env, l)
  await env.q(`INSERT INTO crm.company_members (company_id, user_id, role, permission_keys) VALUES ($1, $2, 'member', $3)`, [companyId, u.userId, keys])
  u.c.setCompany(companyId)
  return { ...u, companyId }
}

export const FIELDS = [
  { key: 'nome', label: 'Nome', variable: '{nome}', enabled: true, position: 0 },
  { key: 'email', label: 'E-mail', variable: '{email}', enabled: true, position: 1 },
]

export const SKILL_HUMAN = {
  enabled: true,
  when_text: 'quando o cliente pedir para falar com um humano',
  action_type: 'transfer_human',
  action_params: {},
  schedule_mode: 'now',
  silence_amount: 1,
  silence_unit: 'days',
}

export async function newAgent(u: User, body: Record<string, unknown> = {}): Promise<Any> {
  const res = await u.c.post('/api/ai-agents', {
    name: uniqueId('Agente'),
    generated_prompt: 'Você é um atendente cordial de uma escola de cursos.',
    model: MODEL,
    settings: { buffer_seconds: 5, split_messages: false },
    skills: [],
    ...body,
  })
  if (res.status !== 201) throw new Error(`agente: ${res.status} ${res.text}`)
  return res.body.agent
}

export async function getAgent(u: User, id: string): Promise<Any> {
  const res = await u.c.get(`/api/ai-agents/${id}`)
  if (res.status !== 200) throw new Error(`GET agente: ${res.status} ${res.text}`)
  return res.body.agent
}

/** Espera o run chegar a completed/failed (polling do GET). */
export async function waitRun(u: User, runId: string, timeoutMs = 20_000): Promise<Any> {
  const t0 = Date.now()
  for (;;) {
    const res = await u.c.get(`/api/ai-agents/runs/${runId}`)
    if (res.status !== 200) throw new Error(`GET run: ${res.status} ${res.text}`)
    if (['completed', 'failed'].includes(res.body.run.status)) return res.body.run
    if (Date.now() - t0 > timeoutMs) throw new Error(`run ${runId} não terminou: ${JSON.stringify(res.body.run)}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

/** Site fake local (HTTP em 127.0.0.1) com uma página HTML. */
export async function startSite(html: string): Promise<{ url: string; hits: string[]; close: () => Promise<void> }> {
  const hits: string[] = []
  const server: Server = createServer((req, res) => {
    hits.push(req.url ?? '/')
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as AddressInfo).port
  return { url: `http://127.0.0.1:${port}/`, hits, close: () => new Promise<void>((r) => server.close(() => r())) }
}

/** Porta local fechada (para "site não lido"). */
export async function closedPortUrl(): Promise<string> {
  const server = createServer()
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((r) => server.close(() => r()))
  return `http://127.0.0.1:${port}/`
}

/** Saída estruturada que o compose espera do LLM. */
export const COMPOSED = {
  name: 'Clara da Doceria',
  role: 'Atendente de vendas',
  purpose: 'Vender bolos e doces por encomenda',
  audience: 'Pessoas que querem bolo para festas',
  personality: 'seller',
  primary_goal: 'sell',
  example_messages: 'Oi! Quer ver o cardápio de bolos?',
  business_rules: 'Encomendas com 48 h de antecedência.',
  never_talk_about: 'Concorrentes.',
}
