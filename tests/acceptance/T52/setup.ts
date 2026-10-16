// Ambiente da suíte T52 (contrato combinado com o Cinzel):
// - API: createApp com aiKnowledgeEnqueue capturado (o teste processa o job) e aiKnowledgeHttp { lookup, allowHosts }.
//   Rotas: /api/ai-agents/:id/knowledge-sources[/:sid[/reindex]] (flows.view / flows.edit).
// - Job: new AiKnowledgeService({ db, publisher, http }).process(sourceId) de @crm/core (mesmo que o processor do worker).
// - Site sem rede: servidor HTTP local; `site.test`/`down.test` resolvem para 127.0.0.1 SÓ por estarem em allowHosts;
//   qualquer outro IP privado continua bloqueado (SSRF). PDFs gerados por buildPdf (fixture do próprio pacote).
import { randomBytes } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createDb } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { FsBlobStore, MemoryMailer, redisConnection } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { ROOT } from '../helpers/exec'
import { fakeEmail, uniqueId } from '../helpers/factories'
import { createClient } from '../helpers/http'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

process.env.CREDENTIALS_KEY ??= randomBytes(32).toString('base64')

const FAKE_HOSTS = ['site.test', 'down.test']

/** lookup no formato da porta (SafeHttpOptions.lookup): host → Promise<[{ address, family }]>.
 *  Hosts de teste resolvem para 127.0.0.1; o resto usa o DNS do sistema (o SSRF do produto continua valendo). */
export function testLookup(hostname: string): Promise<Array<{ address: string; family: number }>> {
  if (FAKE_HOSTS.includes(hostname)) return Promise.resolve([{ address: '127.0.0.1', family: 4 }])
  return new Promise((ok, fail) => dnsLookup(hostname, { all: true }, (err, addrs) => (err ? fail(err) : ok(addrs as Any))))
}

export const HTTP = { lookup: testLookup, allowHosts: FAKE_HOSTS }

export interface Env {
  tmp: TempDatabase
  db: Any
  redis: Any
  app: Any
  core: Any
  enqueued: Array<{ companyId: string; sourceId: string }>
  service: Any
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  close: () => Promise<void>
}

export async function startEnv(): Promise<Env> {
  const api: Any = await import('@crm/api')
  const core: Any = await import('@crm/core')
  if (typeof core.AiKnowledgeService !== 'function') throw new Error('@crm/core não exporta AiKnowledgeService')
  const tmp = await createTempDatabase({ migrate: true })
  const storageDir = mkdtempSync(join(tmpdir(), 'crm-t52-'))
  const db = createDb(tmp.url)
  const redis = redisConnection()
  redis.on?.('error', () => {})
  const enqueued: Env['enqueued'] = []
  const app = api.createApp({
    db,
    redis,
    mailer: new MemoryMailer(),
    blobStore: new FsBlobStore(storageDir),
    waGateway: new FakeWaGateway(),
    appName: 'ProdutoTesteT52',
    webPublicUrl: 'http://web.t52.test',
    trustProxy: true,
    aiKnowledgeEnqueue: async (data: Any) => void enqueued.push(data),
    aiKnowledgeHttp: HTTP,
    // cadastrar a chave BYOK de teste sem ir à rede (a criação do agente exige chave do provedor, T38/T39)
    aiKeyProbe: async () => undefined,
  })
  const service = new core.AiKnowledgeService({ db, publisher: new core.RealtimePublisher({ redis }), http: HTTP })
  const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
  return {
    tmp,
    db,
    redis,
    app,
    core,
    enqueued,
    service,
    q,
    close: async () => {
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
  const ip = `10.52.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`
  const c = createClient({
    fetcher: (path, init) => {
      const headers = new Headers(init.headers)
      headers.set('x-forwarded-for', ip)
      return env.app.request(path, { ...init, headers })
    },
  })
  const password = `Senha-${randomBytes(5).toString('hex')}`
  const email = fakeEmail('t52')
  const reg = await c.post('/api/auth/register', { name: `Dona ${uniqueId('t52')}`, email, password, password_confirmation: password })
  if (reg.status >= 300) throw new Error(`cadastro: ${reg.status} ${reg.text}`)
  const login = await c.post('/api/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login: ${login.status} ${login.text}`)
  const companyId = login.body.companies[0].id
  c.setCompany(companyId)
  const [u] = await env.q(`SELECT id FROM crm.users WHERE lower(email) = lower($1)`, [email])
  return { c, userId: u.id, companyId, token: c.cookies.get('crm_session')! }
}

const keyed = new Set<string>()

export async function newAgent(u: User): Promise<string> {
  // o modelo do agente exige chave do provedor configurada (empresa ou plataforma): chave BYOK falsa, 1x por empresa
  if (!keyed.has(u.companyId)) {
    const k = await u.c.post('/api/ai-keys', { provider: 'openai', name: 'Chave de teste T52', secret: `sk-test-${randomBytes(12).toString('hex')}` })
    if (k.status !== 201) throw new Error(`chave de IA: ${k.status} ${k.text}`)
    keyed.add(u.companyId)
  }
  const r = await u.c.post('/api/ai-agents', {
    name: uniqueId('Agente T52'),
    generated_prompt: 'Você é um atendente cordial.',
    model: { provider: 'openai', model: 'gpt-t52' },
    settings: {},
    skills: [],
  })
  if (r.status !== 201) throw new Error(`agente: ${r.status} ${r.text}`)
  return r.body.agent.id
}

export const sourcesPath = (agentId: string) => `/api/ai-agents/${agentId}/knowledge-sources`

/** POST multipart (kind + file [+ title]). */
export async function upload(env: Env, u: User, agentId: string, kind: string, bytes: Uint8Array, filename: string, extra: Record<string, string> = {}) {
  const form = new FormData()
  form.append('kind', kind)
  form.append('file', new Blob([bytes]), filename)
  for (const [k, v] of Object.entries(extra)) form.append(k, v)
  const res = await env.app.request(sourcesPath(agentId), {
    method: 'POST',
    headers: { cookie: `crm_session=${u.token}`, 'x-company-id': u.companyId, 'x-requested-with': 'crm' },
    body: form,
  })
  const text = await res.text()
  let body: Any = text
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    /* não-JSON */
  }
  return { status: res.status, body, text }
}

/** Processa (como o job) e devolve a fonte relida pela API. */
export async function ingest(env: Env, u: User, agentId: string, sourceId: string) {
  await env.service.process(sourceId)
  const r = await u.c.get(`${sourcesPath(agentId)}/${sourceId}`)
  if (r.status !== 200) throw new Error(`GET fonte: ${r.status} ${r.text}`)
  return r.body.source
}

export async function buildPdf(pages: string[], opts?: Record<string, unknown>): Promise<Uint8Array> {
  let mod: Any
  try {
    mod = await import('@crm/core/ai-knowledge-testing')
  } catch {
    mod = await import(pathToFileURL(resolve(ROOT, 'packages/core/src/ai-knowledge/testing/pdf.ts')).href)
  }
  return mod.buildPdf(pages, opts)
}

/** Site local: "/" com texto e links para /a e /b (mesmo host), "/vazio" sem texto. */
export async function startSite(): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    if (req.url === '/vazio') return res.end('<html><body></body></html>')
    if (req.url === '/a') return res.end('<html><body><p>Página A: horários de atendimento de segunda a sexta.</p></body></html>')
    if (req.url === '/b') return res.end('<html><body><p>Página B: política de trocas em até 7 dias.</p></body></html>')
    res.end('<html><head><title>Loja T52</title></head><body><h1>Loja T52</h1><p>Vendemos cursos de violão online.</p><a href="/a">A</a> <a href="/b">B</a></body></html>')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as Any).port
  return { port, close: () => new Promise<void>((r) => server.close(() => r())) }
}

/** Porta livre e FECHADA (ninguém escutando). */
export async function closedPort(): Promise<number> {
  const s = createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
  const port = (s.address() as Any).port
  await new Promise<void>((r) => s.close(() => r()))
  return port
}
